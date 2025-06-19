import "dotenv/config";
import { promises as fs } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import fetch from "node-fetch";
import yauzl from "yauzl";
import yazl from "yazl";
import { createClient } from "@supabase/supabase-js";

const execAsync = promisify(exec);

export interface BuildRequest {
  deploymentId: string;
  sourceZipUrl: string;
  buildCommand: string;
  outputDir: string;
  webhookUrl: string;
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
  const {
    deploymentId,
    sourceZipUrl,
    buildCommand,
    outputDir,
    webhookUrl,
    jobId,
  } = request;
  const startTime = Date.now();
  let buildLogs = "";

  // For local development, use project root; for production, use /tmp
  const isLocal = process.env.NODE_ENV !== "production";

  console.log(`Starting build process for deployment ${deploymentId}`);

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

    // Create zip of built assets
    buildLogs += `Creating zip of built assets\n`;
    const builtZipPath = join(buildDir, "built-assets.zip");
    await createZip(outputPath, builtZipPath);

    // Upload to Supabase Storage
    buildLogs += `Uploading built assets to Supabase Storage\n`;
    const builtAssetsUrl = await uploadToSupabaseStorage(
      builtZipPath,
      deploymentId
    );
    buildLogs += `Built assets uploaded to: ${builtAssetsUrl}\n`;

    const duration = Date.now() - startTime;
    buildLogs += `Build completed in ${duration}ms\n`;

    // Send success webhook
    try {
      await sendWebhook(webhookUrl, {
        deploymentId,
        status: "SUCCESS",
        statusReason: "Build completed successfully",
        builtAssetsUrl,
        buildLogs,
        duration,
      });
    } catch (webhookError) {
      console.error(
        "Success webhook failed, updating database directly:",
        webhookError
      );
      // Fallback: Update database directly if webhook fails
      await updateDeploymentStatusDirect(
        deploymentId,
        "SUCCESS",
        "Build completed successfully",
        {
          built_assets_url: builtAssetsUrl,
          build_logs: buildLogs,
          duration_ms: duration,
        }
      );
    }

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

    console.error(`Build failed for deployment ${deploymentId}:`, error);

    // Send failure webhook
    try {
      await sendWebhook(webhookUrl, {
        deploymentId,
        status: "FAILED",
        statusReason: errorMessage,
        buildLogs,
        duration,
      });
    } catch (webhookError) {
      console.error(
        "Webhook failed, updating database directly:",
        webhookError
      );
      // Fallback: Update database directly if webhook fails
      await updateDeploymentStatusDirect(deploymentId, "FAILED", errorMessage, {
        build_logs: buildLogs,
        duration_ms: duration,
      });
    }
  }
}

async function extractZip(zipPath: string, extractDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      if (!zipfile) return reject(new Error("Failed to open zip file"));

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          // Directory entry
          zipfile.readEntry();
        } else {
          // File entry
          zipfile.openReadStream(entry, (err, readStream) => {
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

async function createZip(sourceDir: string, zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zipFile = new yazl.ZipFile();
    const output = require("fs").createWriteStream(zipPath);

    zipFile.outputStream.pipe(output);

    const addDirectory = async (dir: string, prefix = "") => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relativePath = join(prefix, entry.name);

        if (entry.isDirectory()) {
          await addDirectory(fullPath, relativePath);
        } else {
          zipFile.addFile(fullPath, relativePath);
        }
      }
    };

    addDirectory(sourceDir)
      .then(() => {
        zipFile.end();
      })
      .catch(reject);

    output.on("close", resolve);
    output.on("error", reject);
  });
}

async function sendWebhook(webhookUrl: string, payload: any): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${
        process.env.BUILD_SERVICE_TOKEN || "default-token"
      }`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Webhook failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  console.log("Webhook sent successfully");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function uploadToSupabaseStorage(
  zipPath: string,
  deploymentId: string
): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Supabase configuration missing. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables."
    );
  }

  // For local development, use external URL instead of internal Docker URL
  const externalSupabaseUrl = supabaseUrl.includes("kong:8000")
    ? "http://127.0.0.1:54321"
    : supabaseUrl;

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Read the built assets zip file
  const zipBuffer = await fs.readFile(zipPath);

  // Create storage path
  const storagePath = `deployments/${deploymentId}/built-assets.zip`;

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from("deployments")
    .upload(storagePath, zipBuffer, {
      cacheControl: "3600",
      upsert: true,
      contentType: "application/zip",
    });

  if (uploadError) {
    throw new Error(
      `Failed to upload to Supabase Storage: ${uploadError.message}`
    );
  }

  // Create a signed URL for the uploaded file
  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from("deployments")
    .createSignedUrl(storagePath, 24 * 60 * 60); // 24 hours

  if (signedUrlError || !signedUrlData?.signedUrl) {
    throw new Error(
      `Failed to create signed URL: ${
        signedUrlError?.message || "Unknown error"
      }`
    );
  }

  // Fix URL for external access (replace internal Docker hostname with external URL)
  const externalUrl = signedUrlData.signedUrl.replace(
    /http:\/\/kong:8000/g,
    externalSupabaseUrl
  );

  console.log("Built assets URL fixed:", externalUrl);
  return externalUrl;
}

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
      console.error("Failed to update deployment status directly:", error);
    } else {
      console.log(
        `Updated deployment ${deploymentId} status to ${status} directly`
      );
    }
  } catch (error) {
    console.error("Error in direct database update:", error);
  }
}
