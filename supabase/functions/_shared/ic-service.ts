// deno-lint-ignore-file no-sloppy-imports
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { HttpAgent, Actor, ActorSubclass } from "npm:@dfinity/agent";
import { Principal } from "npm:@dfinity/principal";
import { Ed25519KeyIdentity } from "npm:@dfinity/identity";
import { Secp256k1KeyIdentity } from "npm:@dfinity/identity-secp256k1";
import { IDL } from "npm:@dfinity/candid";
import * as pemfile from "npm:pem-file";

import { idlFactory as managementIdlFactory } from "./management.did.js";
import type { _SERVICE as MANAGEMENT_SERVICE } from "./management.did.d.ts";
import { idlFactory as walletIdlFactory } from "./wallet.did.js";
import type { _SERVICE as WALLET_SERVICE } from "./wallet.did.d.ts";
import {
  idlFactory as assetCanisterIdlFactory,
  init as assetCanisterInit,
} from "./assetstorage.did.js";
import type { _SERVICE as ASSET_CANISTER_SERVICE } from "./assetstorage.did.d.ts";

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

  async createCanister(userId: string): Promise<CreateCanisterResult> {
    const { data: existingCanisters } = await this.supabase
      .from("canisters")
      .select("id")
      .eq("user_id", userId)
      .eq("deleted", false);

    const canisterNumber = (existingCanisters?.length || 0) + 1;
    const canisterId = await this.createCanisterInIC();

    const { data: canister, error } = await this.supabase
      .from("canisters")
      .insert({
        user_id: userId,
        ic_canister_id: canisterId,
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to save canister: ${error.message}`);

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
        } catch {
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
    } catch {
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
    const status = await this.managementCanister.canister_status({
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
      baseInfo.cyclesBalance = this.formatCycles(icInfo.cycles);
      baseInfo.cyclesBalanceRaw = icInfo.cycles;
      baseInfo.wasmBinarySize = icInfo.wasmBinarySize
        ? this.formatBytes(icInfo.wasmBinarySize)
        : undefined;
      baseInfo.moduleHash = icInfo.moduleHash;
      baseInfo.controllers = icInfo.controllers;
    }

    return baseInfo;
  }
}
