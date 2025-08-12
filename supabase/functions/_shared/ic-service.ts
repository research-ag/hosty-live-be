// deno-lint-ignore-file no-sloppy-imports
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  HttpAgent,
  Actor,
  ActorSubclass,
  Certificate,
} from "npm:@dfinity/agent@2.4.1";
import { Principal } from "npm:@dfinity/principal@2.4.1";
import { Ed25519KeyIdentity } from "npm:@dfinity/identity@2.4.1";
import { Secp256k1KeyIdentity } from "npm:@dfinity/identity-secp256k1@2.4.1";
import { IDL } from "npm:@dfinity/candid@2.4.1";
import { AssetManager } from "npm:@dfinity/assets@2.4.1";
import * as pemfile from "npm:pem-file";
import { ZipReader, BlobWriter } from "https://deno.land/x/zipjs/index.js";

import { idlFactory as managementIdlFactory } from "./management.did.js";
import type { _SERVICE as MANAGEMENT_SERVICE } from "./management.did.d.ts";
import { idlFactory as walletIdlFactory } from "./wallet.did.js";
import type { _SERVICE as WALLET_SERVICE } from "./wallet.did.d.ts";
import {
  idlFactory as assetCanisterIdlFactory,
  init as assetCanisterInit,
} from "./assetstorage.did.js";
import type { _SERVICE as ASSET_CANISTER_SERVICE } from "./assetstorage.did.d.ts";
import { isAssetCanister } from "./constants/knownHashes.ts";

export interface CanisterInfo {
  id: string;
  userId: string;
  icCanisterId: string;
  deleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  cyclesBalance?: string;
  cyclesBalanceRaw?: bigint;
  wasmBinarySize?: string;
  moduleHash?: string;
  controllers?: string[];
  frontendUrl?: string;
  isAssetCanister?: boolean;
  isSystemController?: boolean;
}

export interface CreateCanisterResult {
  canister: {
    id: string;
    userId: string;
    icCanisterId: string;
    createdAt: Date;
    updatedAt: Date;
  };
  canisterNumber: number;
}

export class ICService {
  private agent: HttpAgent;
  private principal: Principal;
  private supabase: SupabaseClient;
  private wallet: ActorSubclass<WALLET_SERVICE>;
  private managementCanister: ActorSubclass<MANAGEMENT_SERVICE>;

  constructor() {
    const rawKey = Deno.env.get("IC_PRIVATE_KEY")!.replace(/\\n/g, "\n");
    console.log("rawKey", rawKey);
    const identity = this.loadLocalIdentity(rawKey);
    this.principal = identity.getPrincipal();

    const icNetwork = Deno.env.get("IC_NETWORK") || "IC";
    const isLocal = icNetwork !== "IC";

    this.agent = HttpAgent.createSync({
      identity,
      fetch: globalThis.fetch,
      host: isLocal
        ? `http://host.docker.internal:${
            Deno.env.get("IC_REPLICA_PORT") || "4943"
          }`
        : "https://ic0.app",
    });

    if (isLocal) {
      this.agent.fetchRootKey().catch((err) => {
        console.warn("Unable to fetch root key:", err);
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required"
      );
    }

    this.supabase = createClient(supabaseUrl, supabaseKey);

    const walletCanisterId = Deno.env.get("WALLET_CANISTER_ID");
    if (!walletCanisterId) {
      throw new Error("WALLET_CANISTER_ID environment variable is required");
    }

    this.wallet = Actor.createActor(walletIdlFactory, {
      canisterId: walletCanisterId,
      agent: this.agent,
    });

    this.managementCanister = Actor.createActor(managementIdlFactory, {
      canisterId: "aaaaa-aa",
      agent: this.agent,
    });
  }

  private loadLocalIdentity(rawKey: string) {
    const buf = pemfile.decode(rawKey);

    if (rawKey.includes("EC PRIVATE KEY")) {
      if (buf.length !== 118) {
        throw `expecting byte length 118 but got ${buf.length}`;
      }
      return Secp256k1KeyIdentity.fromSecretKey(buf.subarray(7, 39));
    }

    if (buf.length !== 85) {
      throw `expecting byte length 85 but got ${buf.length}`;
    }
    return Ed25519KeyIdentity.fromSecretKey(buf.subarray(16, 48));
  }

  private getAssetCanister(
    canisterId: Principal
  ): ActorSubclass<ASSET_CANISTER_SERVICE> {
    return Actor.createActor(assetCanisterIdlFactory, {
      canisterId,
      agent: this.agent,
    });
  }

  async deployAssetsToCanister(
    canisterId: string,
    builtAssetsUrl: string
  ): Promise<void> {
    console.log(
      `Deploying assets to canister ${canisterId} from ${builtAssetsUrl}`
    );

    // Download and extract files
    const files = await this.downloadBuiltAssets(builtAssetsUrl);
    console.log(`Extracted ${files.length} files for deployment`);

    // Use AssetManager for batch upload (following reference pattern)
    const assetManager = new AssetManager({
      canisterId: Principal.fromText(canisterId),
      agent: this.agent,
    });

    // Clear existing assets
    await assetManager.clear();
    console.log("Cleared existing assets from canister");

    // Upload all files in a single batch (optimized for production)
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

  private async downloadBuiltAssets(
    builtAssetsUrl: string
  ): Promise<
    Array<{ path: string; content: Uint8Array; contentType: string }>
  > {
    // Convert external URL back to internal URL when running in Edge Function
    const internalUrl = builtAssetsUrl.replace(
      /http:\/\/127\.0\.0\.1:54321/g,
      Deno.env.get("SUPABASE_URL") || "http://kong:8000"
    );

    console.log(`Downloading from: ${internalUrl}`);
    let response: Response;
    try {
      response = await fetch(internalUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to download built assets: ${response.status} ${response.statusText}`
        );
      }
      console.log(
        `Successfully downloaded built assets (${response.headers.get(
          "content-length"
        )} bytes)`
      );
    } catch (error) {
      console.error(`Failed to fetch built assets from ${internalUrl}:`, error);
      throw error;
    }

    const buffer = await response.arrayBuffer();
    const files: Array<{
      path: string;
      content: Uint8Array;
      contentType: string;
    }> = [];

    // Check if it's a ZIP file by looking at the magic bytes
    const uint8Array = new Uint8Array(buffer);
    const isZip = uint8Array[0] === 0x50 && uint8Array[1] === 0x4b; // "PK" magic bytes

    if (isZip) {
      console.log("Detected ZIP file, extracting contents...");
      try {
        // Create a blob from the buffer for ZipReader
        const blob = new Blob([buffer]);
        const zipReader = new ZipReader(blob.stream());
        const entries = await zipReader.getEntries();

        console.log(`Found ${entries.length} entries in ZIP file`);

        for (const entry of entries) {
          if (!entry.directory && entry.filename) {
            console.log(`Extracting: ${entry.filename}`);

            // Extract file content
            const blobWriter = new BlobWriter();
            const fileBlob = await entry.getData!(blobWriter);
            const fileBuffer = await fileBlob.arrayBuffer();

            files.push({
              path: entry.filename,
              content: new Uint8Array(fileBuffer),
              contentType: this.getContentType(entry.filename),
            });
          }
        }

        await zipReader.close();
        console.log(`Successfully extracted ${files.length} files from ZIP`);

        // Ensure we have an index.html file
        const hasIndexHtml = files.some(
          (f) => f.path === "index.html" || f.path.endsWith("/index.html")
        );
        if (!hasIndexHtml) {
          // Look for common entry points
          const entryFile = files.find(
            (f) =>
              f.path === "index.htm" ||
              f.path.endsWith("/index.htm") ||
              f.path === "main.html" ||
              f.path.endsWith("/main.html")
          );

          if (entryFile) {
            // Rename the entry file to index.html
            entryFile.path = "index.html";
          } else {
            // Create a simple index.html that lists available files
            const fileList = files
              .map((f) => `<li><a href="${f.path}">${f.path}</a></li>`)
              .join("\n");
            files.unshift({
              path: "index.html",
              content: new TextEncoder().encode(`<!DOCTYPE html>
<html>
<head>
    <title>Deployed App</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
    <h1>Successfully Deployed!</h1>
    <p>Your application has been deployed to the Internet Computer.</p>
    <p>Deployment completed at: ${new Date().toISOString()}</p>
    <h2>Available Files:</h2>
    <ul>
${fileList}
    </ul>
</body>
</html>`),
              contentType: "text/html",
            });
          }
        }

        return files;
      } catch (zipError) {
        console.error("Failed to extract ZIP file:", zipError);
        const errorMessage =
          zipError instanceof Error ? zipError.message : "Unknown error";
        // Fallback to placeholder
        files.push({
          path: "index.html",
          content: new TextEncoder().encode(`<!DOCTYPE html>
<html>
<head>
    <title>Deployment Error</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
    <h1>Deployment Error</h1>
    <p>Failed to extract ZIP file: ${errorMessage}</p>
    <p>Deployment completed at: ${new Date().toISOString()}</p>
</body>
</html>`),
          contentType: "text/html",
        });
        return files;
      }
    }

    // Try to parse as JSON manifest first
    try {
      const text = new TextDecoder().decode(buffer);
      const manifest = JSON.parse(text);

      if (manifest.files && Array.isArray(manifest.files)) {
        for (const file of manifest.files) {
          if (file.path && file.content) {
            files.push({
              path: file.path,
              content: new TextEncoder().encode(file.content),
              contentType: this.getContentType(file.path),
            });
          }
        }
        return files;
      }
    } catch {
      // Not JSON, treat as single file
    }

    // Fallback: treat as HTML content
    const content = new Uint8Array(buffer);
    const text = new TextDecoder().decode(content);

    if (text.includes("<html") || text.includes("<!DOCTYPE")) {
      files.push({
        path: "index.html",
        content: content,
        contentType: "text/html",
      });
    } else {
      // Create default index.html
      files.push({
        path: "index.html",
        content: new TextEncoder().encode(`<!DOCTYPE html>
<html>
<head>
    <title>Deployed App</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
    <h1>Successfully Deployed!</h1>
    <p>Your application has been deployed to the Internet Computer.</p>
    <p>Deployment completed at: ${new Date().toISOString()}</p>
</body>
</html>`),
        contentType: "text/html",
      });
    }

    return files;
  }

  private getContentType(fileName: string): string {
    const ext = fileName.split(".").pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      html: "text/html",
      htm: "text/html",
      css: "text/css",
      js: "application/javascript",
      mjs: "application/javascript",
      json: "application/json",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      ico: "image/x-icon",
      woff: "font/woff",
      woff2: "font/woff2",
      ttf: "font/ttf",
      txt: "text/plain",
      xml: "application/xml",
      pdf: "application/pdf",
    };
    return mimeTypes[ext || ""] || "application/octet-stream";
  }

  async createCanister(userId: string): Promise<CreateCanisterResult> {
    const CANISTER_CREATION_COST = 800_000_000_000n; // 0.8 TC

    // Check user's cycles balance first
    const { data: profile, error: profileError } = await this.supabase
      .from("profiles")
      .select("cycles_balance")
      .eq("id", userId)
      .single();

    if (profileError) {
      throw new Error(`Failed to fetch user profile: ${profileError.message}`);
    }

    if (!profile) {
      throw new Error("User profile not found");
    }

    const currentBalance = BigInt(profile.cycles_balance);
    if (currentBalance < CANISTER_CREATION_COST) {
      throw new Error(
        `Insufficient cycles. Required: ${CANISTER_CREATION_COST.toString()}, Available: ${currentBalance.toString()}`
      );
    }

    const { data: existingCanisters } = await this.supabase
      .from("canisters")
      .select("id")
      .eq("user_id", userId)
      .eq("deleted", false);

    const canisterNumber = (existingCanisters?.length || 0) + 1;

    // Deduct cycles from user balance
    const newBalance = currentBalance - CANISTER_CREATION_COST;
    const { error: balanceUpdateError } = await this.supabase
      .from("profiles")
      .update({ cycles_balance: newBalance.toString() })
      .eq("id", userId);

    if (balanceUpdateError) {
      throw new Error(`Failed to deduct cycles: ${balanceUpdateError.message}`);
    }

    let canisterId: string;
    try {
      canisterId = await this.createCanisterInIC();
    } catch (error) {
      // Rollback: refund the cycles if canister creation fails
      await this.supabase
        .from("profiles")
        .update({ cycles_balance: currentBalance.toString() })
        .eq("id", userId);

      throw error;
    }

    const { data: canister, error } = await this.supabase
      .from("canisters")
      .insert({
        user_id: userId,
        ic_canister_id: canisterId,
      })
      .select()
      .single();

    if (error) {
      // Rollback: refund the cycles if database insert fails
      await this.supabase
        .from("profiles")
        .update({ cycles_balance: currentBalance.toString() })
        .eq("id", userId);

      throw new Error(`Failed to save canister: ${error.message}`);
    }

    return {
      canister: {
        id: canister.id as string,
        userId: canister.user_id as string,
        icCanisterId: canister.ic_canister_id as string,
        createdAt: new Date(canister.created_at as string),
        updatedAt: new Date(canister.updated_at as string),
      },
      canisterNumber,
    };
  }

  async getUserCanisters(userId: string): Promise<CanisterInfo[]> {
    const { data: canisters, error } = await this.supabase
      .from("canisters")
      .select("*")
      .eq("user_id", userId)
      .eq("deleted", false)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Failed to fetch canisters: ${error.message}`);

    return Promise.all(
      (canisters || []).map(async (canister) => {
        try {
          const icInfo = await this.getCanisterInfoFromIC(
            canister.ic_canister_id as string
          );
          return this.mapToCanisterInfo(canister, icInfo);
        } catch (error) {
          console.log(
            `getCanisterInfoFromIC failed for ${
              canister.ic_canister_id as string
            }:`,
            error
          );
          return this.mapToCanisterInfo(canister, null);
        }
      })
    );
  }

  async getCanister(
    userId: string,
    canisterId: string
  ): Promise<CanisterInfo | null> {
    const { data: canister, error } = await this.supabase
      .from("canisters")
      .select("*")
      .eq("user_id", userId)
      .eq("ic_canister_id", canisterId)
      .eq("deleted", false)
      .single();

    if (error || !canister) return null;

    try {
      const icInfo = await this.getCanisterInfoFromIC(canisterId);
      return this.mapToCanisterInfo(canister, icInfo);
    } catch (error) {
      console.log(`getCanisterInfoFromIC failed for ${canisterId}:`, error);
      return this.mapToCanisterInfo(canister, null);
    }
  }

  async deleteCanister(userId: string, canisterId: string): Promise<void> {
    const { error } = await this.supabase
      .from("canisters")
      .update({
        deleted: true,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("ic_canister_id", canisterId);

    if (error) throw new Error(`Failed to delete canister: ${error.message}`);
  }

  async addController(
    userId: string,
    canisterId: string,
    userPrincipal: string
  ): Promise<void> {
    // Verify canister ownership
    const canister = await this.getCanister(userId, canisterId);
    if (!canister) {
      throw new Error("Canister not found or access denied");
    }

    // Get current canister status
    const status = await this.managementCanister.canister_status.withOptions({
      effectiveCanisterId: Principal.fromText(canisterId),
    })({
      canister_id: Principal.fromText(canisterId),
    });

    // Add new controller to existing controllers
    const currentControllers = status.settings.controllers;
    const newControllers = [
      ...currentControllers,
      Principal.fromText(userPrincipal),
    ];

    // Update canister settings
    await this.managementCanister.update_settings.withOptions({
      effectiveCanisterId: Principal.fromText(canisterId),
    })({
      canister_id: Principal.fromText(canisterId),
      settings: {
        freezing_threshold: [],
        controllers: [newControllers],
        reserved_cycles_limit: [],
        log_visibility: [],
        wasm_memory_limit: [],
        memory_allocation: [],
        compute_allocation: [],
        wasm_memory_threshold: [],
      },
      sender_canister_version: [],
    });

    // If asset canister, grant all permissions
    const moduleHash = status.module_hash[0]
      ? this.arrayBufferToHex(status.module_hash[0])
      : "";

    if (isAssetCanister(moduleHash)) {
      const assetCanister = this.getAssetCanister(
        Principal.fromText(canisterId)
      );

      // Grant all permissions: Prepare, ManagePermissions, Commit
      await assetCanister.grant_permission({
        permission: { Prepare: null },
        to_principal: Principal.fromText(userPrincipal),
      });

      await assetCanister.grant_permission({
        permission: { ManagePermissions: null },
        to_principal: Principal.fromText(userPrincipal),
      });

      await assetCanister.grant_permission({
        permission: { Commit: null },
        to_principal: Principal.fromText(userPrincipal),
      });
    }
  }

  private async createCanisterInIC(): Promise<string> {
    const result = await this.wallet.wallet_create_canister({
      settings: {
        compute_allocation: [],
        freezing_threshold: [],
        memory_allocation: [],
        controller: [],
        controllers: [[this.principal]],
      },
      cycles: 840_000_000_000n,
    });

    if ("Err" in result) {
      throw new Error(`wallet_create_canister failed: ${result.Err}`);
    }

    const canisterId = result.Ok.canister_id;
    await this.installAssetCanister(canisterId);
    await this.uploadDefaultPage(canisterId);

    return canisterId.toText();
  }

  private async installAssetCanister(canisterId: Principal): Promise<void> {
    try {
      // Load WASM from Supabase Storage or fallback to embedded base64
      let wasmModule: Uint8Array;

      try {
        // Try to download from Supabase Storage
        const { data, error } = await this.supabase.storage
          .from("wasm-files")
          .download("assetstorage.wasm.gz");

        if (error) throw error;
        wasmModule = new Uint8Array(await data.arrayBuffer());
      } catch {
        // Fallback: Use embedded base64 WASM (we'll need to add this)
        throw new Error(
          "WASM file not found in storage. Please upload assetstorage.wasm.gz to Supabase Storage bucket 'wasm-files'"
        );
      }

      await this.managementCanister.install_code.withOptions({
        effectiveCanisterId: canisterId,
      })({
        arg: new Uint8Array(IDL.encode(assetCanisterInit({ IDL }), [[]])),
        wasm_module: [...wasmModule],
        mode: { install: null },
        canister_id: canisterId,
        sender_canister_version: [],
      });
    } catch (error) {
      throw new Error(
        `Failed to install asset canister: ${
          (error as Error)?.message || "Unknown error"
        }`
      );
    }
  }

  private async uploadDefaultPage(canisterId: Principal): Promise<void> {
    const assetCanister = this.getAssetCanister(canisterId);

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hosted via hosty.live</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .container {
            text-align: center;
            padding: 2rem;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            backdrop-filter: blur(10px);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        }
        h1 {
            font-size: 3rem;
            margin-bottom: 1rem;
            font-weight: 300;
        }
        p {
            font-size: 1.2rem;
            opacity: 0.9;
            margin-bottom: 2rem;
        }
        .canister-id {
            font-family: 'Monaco', 'Menlo', monospace;
            background: rgba(0, 0, 0, 0.2);
            padding: 0.5rem 1rem;
            border-radius: 8px;
            font-size: 0.9rem;
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Hosted via hosty.live</h1>
        <p>Your canister is ready for deployment!</p>
        <div class="canister-id">${canisterId.toText()}</div>
    </div>
</body>
</html>`;

    await assetCanister.store({
      key: "/index.html",
      content: new TextEncoder().encode(htmlContent),
      sha256: [],
      content_type: "text/html",
      content_encoding: "identity",
    });
  }

  private async getCanisterInfoFromIC(canisterId: string) {
    try {
      // Try management canister first (for full info including cycles)
      const status = await this.managementCanister.canister_status.withOptions({
        effectiveCanisterId: Principal.fromText(canisterId),
      })({
        canister_id: Principal.fromText(canisterId),
      });

      const moduleHash = status.module_hash[0]
        ? this.arrayBufferToHex(status.module_hash[0])
        : "Absent";

      return {
        cycles: status.cycles,
        wasmBinarySize: status.memory_metrics.wasm_binary_size,
        moduleHash,
        controllers: status.settings.controllers.map((p: Principal) =>
          p.toText()
        ),
      };
    } catch (error) {
      console.log(
        `Management canister call failed, falling back to read state for ${canisterId}:`,
        error
      );

      // Fallback to read state (no cycles info, but has moduleHash/controllers)
      const state = await this.readCanisterState(canisterId);

      return {
        cycles: null,
        wasmBinarySize: null,
        moduleHash: state.moduleHash,
        controllers: state.controllers,
      };
    }
  }

  private formatCycles(cycles: bigint): string {
    const trillion = 1_000_000_000_000n;
    if (cycles >= trillion) {
      return `${(cycles / trillion).toString()}T`;
    }
    const billion = 1_000_000_000n;
    if (cycles >= billion) {
      return `${(cycles / billion).toString()}B`;
    }
    const million = 1_000_000n;
    if (cycles >= million) {
      return `${(cycles / million).toString()}M`;
    }
    return cycles.toString();
  }

  private formatBytes(bytes: bigint): string {
    const kb = 1024n;
    const mb = kb * 1024n;

    if (bytes >= mb) {
      return `${(bytes / mb).toString()} MB`;
    }
    if (bytes >= kb) {
      return `${(bytes / kb).toString()} KB`;
    }
    return `${bytes.toString()} bytes`;
  }

  private arrayBufferToHex(buffer: Uint8Array | number[]): string {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async readCanisterState(canisterId: string): Promise<{
    moduleHash: string;
    controllers: string[];
  }> {
    const canisterPrincipal = Principal.fromText(canisterId);

    const moduleHashPath: ArrayBuffer[] = [
      new TextEncoder().encode("canister").buffer as ArrayBuffer,
      canisterPrincipal.toUint8Array().buffer as ArrayBuffer,
      new TextEncoder().encode("module_hash").buffer as ArrayBuffer,
    ];

    const controllersPath: ArrayBuffer[] = [
      new TextEncoder().encode("canister").buffer as ArrayBuffer,
      canisterPrincipal.toUint8Array().buffer as ArrayBuffer,
      new TextEncoder().encode("controllers").buffer as ArrayBuffer,
    ];

    // Create anonymous agent for read state (no signature required)
    const readAgent = HttpAgent.createSync({
      fetch: globalThis.fetch,
      host: "https://ic0.app",
    });

    const res = await readAgent.readState(canisterId, {
      paths: [moduleHashPath, controllersPath],
    });

    const cert = await Certificate.create({
      certificate: res.certificate,
      rootKey: await readAgent.fetchRootKey(),
      canisterId: canisterPrincipal,
    });

    const data: { moduleHash: string; controllers: string[] } = {
      moduleHash: "",
      controllers: [],
    };

    // Dynamic import for cborg
    const { decodeFirst } = await import("npm:cborg");

    const moduleHash = cert.lookup(moduleHashPath);
    if (moduleHash.status === "found") {
      const hex = this.arrayBufferToHex(
        new Uint8Array(moduleHash.value as ArrayBuffer)
      );
      data.moduleHash = hex;
    } else if (moduleHash.status === "absent") {
      data.moduleHash = "Absent";
    } else {
      console.error(`module_hash LookupStatus: ${moduleHash.status}`, {
        canisterId,
      });
      throw new Error(`module_hash LookupStatus: ${moduleHash.status}`);
    }

    const controllers = cert.lookup(controllersPath);
    if (controllers.status === "found") {
      const tags = [];
      tags[55799] = (val: any) => val;

      const [decoded]: [Uint8Array[], Uint8Array] = decodeFirst(
        new Uint8Array(controllers.value as ArrayBuffer),
        { tags }
      );

      const controllersList = decoded.map((buf) =>
        Principal.fromUint8Array(buf).toText()
      );

      data.controllers = controllersList;
    } else {
      console.error(`controllers LookupStatus: ${controllers.status}`, {
        canisterId,
      });
      throw new Error(`controllers LookupStatus: ${controllers.status}`);
    }

    return data;
  }

  private mapToCanisterInfo(dbRecord: any, icInfo: any = null): CanisterInfo {
    const baseInfo: CanisterInfo = {
      id: dbRecord.id,
      userId: dbRecord.user_id,
      icCanisterId: dbRecord.ic_canister_id,
      deleted: dbRecord.deleted,
      deletedAt: dbRecord.deleted_at
        ? new Date(dbRecord.deleted_at)
        : undefined,
      createdAt: new Date(dbRecord.created_at),
      updatedAt: new Date(dbRecord.updated_at),
      frontendUrl: `https://${dbRecord.ic_canister_id}.icp0.io/`,
    };

    if (icInfo) {
      if (icInfo.cycles !== null) {
        baseInfo.cyclesBalance = this.formatCycles(icInfo.cycles);
        baseInfo.cyclesBalanceRaw = icInfo.cycles;
      }

      if (icInfo.wasmBinarySize !== null) {
        baseInfo.wasmBinarySize = this.formatBytes(icInfo.wasmBinarySize);
      }

      baseInfo.moduleHash = icInfo.moduleHash;
      baseInfo.controllers = icInfo.controllers;
      baseInfo.isAssetCanister = isAssetCanister(icInfo.moduleHash || "");
      baseInfo.isSystemController =
        icInfo.controllers?.includes(this.principal.toText()) || false;
    }

    return baseInfo;
  }
}
