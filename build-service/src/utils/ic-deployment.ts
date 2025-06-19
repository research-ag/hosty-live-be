import { createClient } from "@supabase/supabase-js";
import { HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1";
import { AssetManager } from "@dfinity/assets";
import * as pemfile from "pem-file";
import { promises as fs } from "fs";
import path from "path";

export async function deployToInternetComputer(
  deploymentId: string,
  outputPath: string,
  buildLogs: string,
  duration: number
): Promise<void> {
  console.log(`[${deploymentId}] Starting IC deployment from ${outputPath}...`);

  // Get deployment with canister info
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

  const supabase = createClient(externalSupabaseUrl, supabaseServiceKey);

  const { data: deploymentData, error: deploymentError } = await supabase
    .from("deployments")
    .select(
      `
      *,
      canister:canisters(*)
    `
    )
    .eq("id", deploymentId)
    .single();

  if (deploymentError || !deploymentData) {
    throw new Error(
      `Failed to get deployment with canister: ${deploymentError?.message}`
    );
  }

  const { canister } = deploymentData;
  if (!canister) {
    throw new Error("No canister found for deployment");
  }

  // Update status to DEPLOYING
  await updateDeploymentStatus(
    deploymentId,
    "DEPLOYING",
    "Build completed, deploying to IC...",
    {
      build_logs: buildLogs,
      duration_ms: duration,
    }
  );

  try {
    const startTime = Date.now();

    // Deploy to IC using local files directly
    await deployAssetsToCanister(canister.ic_canister_id, outputPath);

    const deploymentDuration = Date.now() - startTime + duration;

    await updateDeploymentStatus(
      deploymentId,
      "SUCCESS",
      "Successfully deployed to IC",
      {
        deployed_at: new Date().toISOString(),
        duration_ms: deploymentDuration,
      }
    );

    console.log(`[${deploymentId}] Successfully deployed to IC`);
  } catch (icError) {
    console.error(`[${deploymentId}] Failed to deploy to IC:`, icError);
    const errorMessage =
      icError instanceof Error
        ? icError.message
        : "Unknown IC deployment error";

    await updateDeploymentStatus(
      deploymentId,
      "FAILED",
      `IC deployment failed: ${errorMessage}`,
      {
        build_logs: buildLogs,
        duration_ms: duration,
      }
    );

    throw icError;
  }
}

async function updateDeploymentStatus(
  deploymentId: string,
  status: string,
  statusReason?: string,
  additionalFields?: any
): Promise<void> {
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

  const supabase = createClient(externalSupabaseUrl, supabaseServiceKey);

  const updateData: any = {
    status,
    status_reason: statusReason,
    ...additionalFields,
  };

  const { error } = await supabase
    .from("deployments")
    .update(updateData)
    .eq("id", deploymentId);

  if (error) {
    throw new Error(`Failed to update deployment status: ${error.message}`);
  }
}

async function deployAssetsToCanister(
  canisterId: string,
  outputPath: string
): Promise<void> {
  console.log(
    `Deploying assets to canister ${canisterId} from local path ${outputPath}`
  );

  // Setup IC agent
  const rawKey = process.env.IC_PRIVATE_KEY!.replace(/\\n/g, "\n");
  const identity = loadLocalIdentity(rawKey);

  const icNetwork = process.env.IC_NETWORK || "IC";
  const isLocal = icNetwork !== "IC";

  const agent = HttpAgent.createSync({
    identity,
    fetch: globalThis.fetch,
    host: isLocal
      ? `http://host.docker.internal:${process.env.IC_REPLICA_PORT || "4943"}`
      : "https://ic0.app",
  });

  if (isLocal) {
    await agent.fetchRootKey().catch((err: any) => {
      console.warn("Unable to fetch root key:", err);
    });
  }

  // Read files directly from local build output
  const files = await readBuiltFiles(outputPath);
  console.log(`Found ${files.length} files for deployment`);

  // Use AssetManager for batch upload
  const assetManager = new AssetManager({
    canisterId: Principal.fromText(canisterId),
    agent: agent,
  });

  // Clear existing assets
  await assetManager.clear();
  console.log("Cleared existing assets from canister");

  // Upload all files in a single batch
  const batch = assetManager.batch();

  console.log(`Adding ${files.length} files to batch...`);
  for (const file of files) {
    await batch.store(file.content, {
      fileName: file.path,
      contentType: file.contentType,
    });
  }

  console.log(`Committing batch with ${files.length} files...`);
  await batch.commit();
  console.log(`✅ Successfully uploaded all ${files.length} files`);

  console.log(
    `✅ Successfully deployed all ${files.length} files to canister ${canisterId}`
  );
}

function loadLocalIdentity(rawKey: string) {
  const buf = pemfile.decode(rawKey);

  if (rawKey.includes("EC PRIVATE KEY")) {
    if (buf.length !== 118) {
      throw new Error(`expecting byte length 118 but got ${buf.length}`);
    }
    return Secp256k1KeyIdentity.fromSecretKey(buf.subarray(7, 39));
  }

  if (buf.length !== 85) {
    throw new Error(`expecting byte length 85 but got ${buf.length}`);
  }
  return Ed25519KeyIdentity.fromSecretKey(buf.subarray(16, 48));
}

// New function to read files directly from local directory
async function readBuiltFiles(
  outputPath: string
): Promise<Array<{ path: string; content: Uint8Array; contentType: string }>> {
  const files: Array<{
    path: string;
    content: Uint8Array;
    contentType: string;
  }> = [];

  async function readDirectory(
    dirPath: string,
    relativePath: string = ""
  ): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const entryRelativePath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        // Skip hidden directories and common non-asset directories
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          await readDirectory(fullPath, entryRelativePath);
        }
      } else if (entry.isFile()) {
        // Skip hidden files and source maps
        if (!entry.name.startsWith(".") && !entry.name.endsWith(".map")) {
          console.log(`Reading file: ${entryRelativePath}`);
          const content = await fs.readFile(fullPath);
          files.push({
            path: entryRelativePath,
            content: new Uint8Array(content),
            contentType: getContentType(entry.name),
          });
        }
      }
    }
  }

  await readDirectory(outputPath);

  // Ensure we have an index.html file
  const hasIndexHtml = files.some(
    (f) => f.path === "index.html" || f.path.endsWith("/index.html")
  );

  if (!hasIndexHtml) {
    console.warn("No index.html found, adding default page");
    files.push({
      path: "index.html",
      content: new TextEncoder().encode(`
<!DOCTYPE html>
<html>
<head>
    <title>Deployed App</title>
</head>
<body>
    <h1>App Successfully Deployed!</h1>
    <p>Your application has been deployed to the Internet Computer.</p>
</body>
</html>
      `),
      contentType: "text/html",
    });
  }

  return files;
}

function getContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".xml": "application/xml",
    ".wasm": "application/wasm",
  };
  return mimeTypes[ext] || "application/octet-stream";
}
