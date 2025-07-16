import "dotenv/config";
import { promises as fs } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import fetch from "node-fetch";
import yauzl from "yauzl";
import { createClient } from "@supabase/supabase-js";
import { deployToInternetComputer } from "./utils/ic-deployment";

const execAsync = promisify(exec);

export interface BuildRequest {
  deploymentId: string;
  sourceZipUrl: string;
  buildCommand: string;
  outputDir: string;
  jobId: string;
}

export interface GitBuildRequest {
  deploymentId: string;
  gitRepoUrl: string;
  buildCommand: string;
  outputDir: string;
  branch: string;
  jobId: string;
}

export interface BuildResult {
  success: boolean;
  builtAssetsUrl?: string;
  buildLogs?: string;
  error?: string;
  duration?: number;
}

export async function processDeployment(request: BuildRequest): Promise<void> {
  const { deploymentId, sourceZipUrl, buildCommand, outputDir, jobId } =
    request;
  const startTime = Date.now();
  let buildLogs = "";

  // For local development, use project root; for production, use /tmp
  const isLocal = process.env.NODE_ENV !== "production";

  console.log(`[ZIP-BUILD] Starting build process for deployment ${deploymentId}`);
  console.log(`[ZIP-BUILD] Request:`, JSON.stringify(request, null, 2));

  try {
    // Create temporary directories
    const tempDir = isLocal
      ? join(process.cwd(), "temp", `build_${jobId}`)
      : `/tmp/build_${jobId}`;
    const sourceDir = join(tempDir, "source");
    const buildDir = join(tempDir, "build");

    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(buildDir, { recursive: true });

    buildLogs += `Created temporary directories\n`;

    // Download source zip
    buildLogs += `Downloading source from ${sourceZipUrl}\n`;
    const zipResponse = await fetch(sourceZipUrl);
    if (!zipResponse.ok) {
      throw new Error(`Failed to download source: ${zipResponse.status}`);
    }

    const zipBuffer = await zipResponse.buffer();
    const zipPath = join(tempDir, "source.zip");
    await fs.writeFile(zipPath, zipBuffer);

    buildLogs += `Downloaded ${zipBuffer.length} bytes\n`;

    // Extract zip file
    buildLogs += `Extracting source files\n`;
    await extractZip(zipPath, sourceDir);

    // Check if project is in a subdirectory (common when zipping a folder)
    let actualSourceDir = sourceDir;
    const packageJsonPath = join(sourceDir, "package.json");

    try {
      await fs.access(packageJsonPath);
      buildLogs += `Found package.json at root level\n`;
    } catch {
      // package.json not at root, check subdirectories
      buildLogs += `package.json not found at root, checking subdirectories\n`;
      try {
        const entries = await fs.readdir(sourceDir, { withFileTypes: true });
        const dirs = entries.filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            entry.name !== "__MACOSX"
        );

        for (const dir of dirs) {
          const subDirPath = join(sourceDir, dir.name);
          const subPackageJsonPath = join(subDirPath, "package.json");
          try {
            await fs.access(subPackageJsonPath);
            actualSourceDir = subDirPath;
            buildLogs += `Found package.json in subdirectory: ${dir.name}\n`;
            break;
          } catch {
            // Continue checking other directories
          }
        }
      } catch (readError) {
        buildLogs += `Failed to read source directory: ${readError}\n`;
      }
    }

    // Find package.json and determine package manager
    const actualPackageJsonPath = join(actualSourceDir, "package.json");
    let packageManager = "npm";

    try {
      await fs.access(actualPackageJsonPath);

      // Check for lock files to determine package manager
      try {
        await fs.access(join(actualSourceDir, "yarn.lock"));
        packageManager = "yarn";
      } catch {
        try {
          await fs.access(join(actualSourceDir, "pnpm-lock.yaml"));
          packageManager = "pnpm";
        } catch {
          packageManager = "npm";
        }
      }

      buildLogs += `Detected package manager: ${packageManager}\n`;
    } catch {
      buildLogs += `No package.json found, skipping dependency installation\n`;
    }

    // Install dependencies
    if (await fileExists(actualPackageJsonPath)) {
      buildLogs += `Installing dependencies with ${packageManager}\n`;

      // Use proper CI/non-interactive flags for each package manager
      const installCommand =
        packageManager === "yarn"
          ? "yarn install --frozen-lockfile --non-interactive"
          : packageManager === "pnpm"
          ? "pnpm install --frozen-lockfile --reporter=summary"
          : "npm ci";

      const { stdout: installStdout, stderr: installStderr } = await execAsync(
        installCommand,
        {
          cwd: actualSourceDir,
          timeout: 300000, // 5 minutes timeout
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
          env: {
            ...process.env,
            // Force non-interactive mode and disable progress bars
            NODE_ENV: "development", // Ensure devDependencies are installed
            YARN_SILENT: "false",
            NPM_CONFIG_PROGRESS: "false",
            NPM_CONFIG_SPIN: "false",
          },
        }
      );

      // Only log essential install info, not verbose output
      if (installStdout.trim()) {
        const summarizedOutput =
          installStdout.length > 500
            ? installStdout.substring(0, 500) +
              `... (${installStdout.length} chars total)`
            : installStdout;
        buildLogs += `Install summary: ${summarizedOutput}\n`;
      }
      if (installStderr) buildLogs += `Install warnings: ${installStderr}\n`;

      // Verify installation succeeded by checking if node_modules exists
      const nodeModulesPath = join(actualSourceDir, "node_modules");
      try {
        await fs.access(nodeModulesPath);
        buildLogs += `Dependencies installed successfully - node_modules found\n`;
      } catch {
        buildLogs += `Warning: node_modules directory not found after installation\n`;
      }
    }

    // Run build command
    buildLogs += `Running build command: ${buildCommand}\n`;
    const { stdout: buildStdout, stderr: buildStderr } = await execAsync(
      buildCommand,
      {
        cwd: actualSourceDir,
        timeout: 600000, // 10 minutes timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
      }
    );

    buildLogs += `Build stdout: ${buildStdout}\n`;
    if (buildStderr) buildLogs += `Build stderr: ${buildStderr}\n`;

    // Check if output directory exists
    const outputPath = join(actualSourceDir, outputDir);
    try {
      await fs.access(outputPath);
      buildLogs += `Output directory found: ${outputPath}\n`;
    } catch {
      // List available directories to help debug
      buildLogs += `Output directory '${outputDir}' not found after build\n`;
      try {
        const files = await fs.readdir(actualSourceDir, {
          withFileTypes: true,
        });
        const dirs = files.filter((f) => f.isDirectory()).map((f) => f.name);
        buildLogs += `Available directories in source: ${dirs.join(", ")}\n`;

        // Check for common output directory names
        const commonOutputDirs = [
          "dist",
          "build",
          "out",
          "public",
          ".next",
          "_site",
        ];
        const foundOutputDirs = dirs.filter((dir) =>
          commonOutputDirs.includes(dir)
        );
        if (foundOutputDirs.length > 0) {
          buildLogs += `Possible output directories found: ${foundOutputDirs.join(
            ", "
          )}\n`;
        }
      } catch (listError) {
        buildLogs += `Failed to list source directories: ${listError}\n`;
      }
      throw new Error(
        `Output directory '${outputDir}' not found after build. Check build logs for available directories.`
      );
    }

    const duration = Date.now() - startTime;
    buildLogs += `Build completed in ${duration}ms\n`;

    // Deploy to IC directly from local files (no need for Supabase Storage!)
    await deployToInternetComputer(
      deploymentId,
      outputPath,
      buildLogs,
      duration
    );

    // Cleanup (skip in local development for debugging)
    if (!isLocal) {
      await fs.rm(tempDir, { recursive: true, force: true });
    } else {
      buildLogs += `Temp files preserved for debugging at: ${tempDir}\n`;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    buildLogs += `Build failed: ${errorMessage}\n`;

    // Add temp directory info for debugging
    const tempDir = isLocal
      ? join(process.cwd(), "temp", `build_${jobId}`)
      : `/tmp/build_${jobId}`;
    if (isLocal) {
      buildLogs += `Temp files preserved for debugging at: ${tempDir}\n`;
    }

    console.error(`[ZIP-BUILD] Build failed for deployment ${deploymentId}:`, error);
    console.error(`[ZIP-BUILD] Error stack:`, error instanceof Error ? error.stack : 'No stack');

    // Update database directly instead of using webhook
    try {
      await updateDeploymentStatusDirect(deploymentId, "FAILED", errorMessage, {
        build_logs: buildLogs,
        duration_ms: duration,
      });
    } catch (updateError) {
      console.error(`[ZIP-BUILD] Failed to update deployment status:`, updateError);
    }
  }
}

export async function processGitDeployment(
  request: GitBuildRequest
): Promise<void> {
  const { deploymentId, gitRepoUrl, buildCommand, outputDir, branch, jobId } =
    request;
  const startTime = Date.now();
  let buildLogs = "";

  const isLocal = process.env.NODE_ENV !== "production";

  console.log(`[GIT-BUILD] Starting git build process for deployment ${deploymentId}`);
  console.log(`[GIT-BUILD] Request:`, JSON.stringify(request, null, 2));

  try {
    const tempDir = isLocal
      ? join(process.cwd(), "temp", `build_${jobId}`)
      : `/tmp/build_${jobId}`;
    const sourceDir = join(tempDir, "source");
    const buildDir = join(tempDir, "build");

    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(buildDir, { recursive: true });

    buildLogs += `Created temporary directories: ${tempDir}\n`;
    buildLogs += `Cloning git repository: ${gitRepoUrl}\n`;
    buildLogs += `Branch: ${branch}\n`;

    await updateDeploymentStatusDirect(
      deploymentId,
      "BUILDING",
      "Cloning repository"
    );

    const cloneCommand = `git clone --depth 1 --branch ${branch} ${gitRepoUrl} ${sourceDir}`;
    const { stdout: cloneStdout, stderr: cloneStderr } = await execAsync(
      cloneCommand
    );

    buildLogs += `Clone stdout: ${cloneStdout}\n`;
    if (cloneStderr) {
      buildLogs += `Clone stderr: ${cloneStderr}\n`;
    }

    buildLogs += `Repository cloned successfully\n`;

    const actualSourceDir = sourceDir;
    const sourceFiles = await fs.readdir(actualSourceDir);
    buildLogs += `Source files found: ${sourceFiles.join(", ")}\n`;

    let packageManager = "npm";
    if (await fileExists(join(actualSourceDir, "yarn.lock"))) {
      packageManager = "yarn";
    } else if (await fileExists(join(actualSourceDir, "pnpm-lock.yaml"))) {
      packageManager = "pnpm";
    }

    buildLogs += `Detected package manager: ${packageManager}\n`;

    const installCommand =
      packageManager === "yarn"
        ? "yarn install"
        : packageManager === "pnpm"
        ? "pnpm install"
        : "npm install";

    buildLogs += `Running install command: ${installCommand}\n`;
    await updateDeploymentStatusDirect(
      deploymentId,
      "BUILDING",
      "Installing dependencies"
    );

    const { stdout: installStdout, stderr: installStderr } = await execAsync(
      installCommand,
      {
        cwd: actualSourceDir,
        timeout: 5 * 60 * 1000,
      }
    );

    buildLogs += `Install stdout: ${installStdout}\n`;
    if (installStderr) {
      buildLogs += `Install stderr: ${installStderr}\n`;
    }

    buildLogs += `Running build command: ${buildCommand}\n`;
    await updateDeploymentStatusDirect(
      deploymentId,
      "BUILDING",
      "Building project"
    );

    const { stdout: buildStdout, stderr: buildStderr } = await execAsync(
      buildCommand,
      {
        cwd: actualSourceDir,
        timeout: 10 * 60 * 1000,
      }
    );

    buildLogs += `Build stdout: ${buildStdout}\n`;
    if (buildStderr) {
      buildLogs += `Build stderr: ${buildStderr}\n`;
    }

    const outputPath = join(actualSourceDir, outputDir);
    try {
      await fs.access(outputPath);
      buildLogs += `Output directory found: ${outputPath}\n`;
    } catch {
      buildLogs += `Output directory '${outputDir}' not found after build\n`;
      try {
        const files = await fs.readdir(actualSourceDir, {
          withFileTypes: true,
        });
        const dirs = files.filter((f) => f.isDirectory()).map((f) => f.name);
        buildLogs += `Available directories in source: ${dirs.join(", ")}\n`;

        const commonOutputDirs = [
          "dist",
          "build",
          "out",
          "public",
          ".next",
          "_site",
        ];
        const foundOutputDirs = dirs.filter((dir) =>
          commonOutputDirs.includes(dir)
        );
        if (foundOutputDirs.length > 0) {
          buildLogs += `Possible output directories found: ${foundOutputDirs.join(
            ", "
          )}\n`;
        }
      } catch (listError) {
        buildLogs += `Failed to list source directories: ${listError}\n`;
      }
      throw new Error(
        `Output directory '${outputDir}' not found after build. Check build logs for available directories.`
      );
    }

    const duration = Date.now() - startTime;
    buildLogs += `Build completed in ${duration}ms\n`;

    await deployToInternetComputer(
      deploymentId,
      outputPath,
      buildLogs,
      duration
    );

    if (!isLocal) {
      await fs.rm(tempDir, { recursive: true, force: true });
    } else {
      buildLogs += `Temporary directory preserved for debugging: ${tempDir}\n`;
    }

    console.log(`[GIT-BUILD] Git build process completed for deployment ${deploymentId}`);
  } catch (error) {
    console.error(`[GIT-BUILD] Git build process error for deployment ${deploymentId}:`, error);
    console.error(`[GIT-BUILD] Error stack:`, error instanceof Error ? error.stack : 'No stack');
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    buildLogs += `Build failed: ${errorMessage}\n`;

    try {
      await updateDeploymentStatusDirect(deploymentId, "FAILED", errorMessage, {
        build_logs: buildLogs,
        duration_ms: Date.now() - startTime,
      });
    } catch (updateError) {
      console.error(`[GIT-BUILD] Failed to update deployment status:`, updateError);
    }
  }
}

async function extractZip(zipPath: string, extractDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err: any, zipfile: any) => {
      if (err) return reject(err);
      if (!zipfile) return reject(new Error("Failed to open zip file"));

      zipfile.readEntry();
      zipfile.on("entry", (entry: any) => {
        if (/\/$/.test(entry.fileName)) {
          // Directory entry
          zipfile.readEntry();
        } else {
          // File entry
          zipfile.openReadStream(entry, (err: any, readStream: any) => {
            if (err) return reject(err);
            if (!readStream)
              return reject(new Error("Failed to open read stream"));

            const filePath = join(extractDir, entry.fileName);
            fs.mkdir(join(filePath, ".."), { recursive: true })
              .then(() => {
                const writeStream = require("fs").createWriteStream(filePath);
                readStream.pipe(writeStream);
                writeStream.on("close", () => zipfile.readEntry());
                writeStream.on("error", reject);
              })
              .catch(reject);
          });
        }
      });

      zipfile.on("end", resolve);
      zipfile.on("error", reject);
    });
  });
}

// Removed sendWebhook function - no longer needed since we handle everything directly

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

// Removed uploadToSupabaseStorage - no longer needed since we deploy directly from local files

async function updateDeploymentStatusDirect(
  deploymentId: string,
  status: string,
  statusReason?: string,
  additionalFields?: any
): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Supabase configuration missing for direct database update");
    return;
  }

  // For local development, use external URL instead of internal Docker URL
  const externalSupabaseUrl = supabaseUrl.includes("kong:8000")
    ? "http://127.0.0.1:54321"
    : supabaseUrl;

  try {
    const supabase = createClient(externalSupabaseUrl, supabaseServiceKey);

    const updateData: any = {
      status,
      status_reason: statusReason,
      updated_at: new Date().toISOString(),
      ...additionalFields,
    };

    const { error } = await supabase
      .from("deployments")
      .update(updateData)
      .eq("id", deploymentId);

    if (error) {
      console.error(`[DB-UPDATE] Failed to update deployment ${deploymentId} status directly:`, error);
    } else {
      console.log(`[DB-UPDATE] Updated deployment ${deploymentId} status to ${status} directly`);
    }
  } catch (error) {
    console.error(`[DB-UPDATE] Error in direct database update for deployment ${deploymentId}:`, error);
    console.error(`[DB-UPDATE] Error stack:`, error instanceof Error ? error.stack : 'No stack');
  }
}
