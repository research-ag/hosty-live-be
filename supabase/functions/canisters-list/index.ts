import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getUserFromRequest } from "../_shared/auth.ts";
import { ICService } from "../_shared/ic-service.ts";

interface CanisterInfo {
  id: string;
  userId: string;
  icCanisterId: string;
  deleted: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
  frontendUrl: string;
  cyclesBalance?: string;
  cyclesBalanceRaw?: string;
  wasmBinarySize?: string;
  moduleHash?: string;
  controllers?: string[];
  isAssetCanister?: boolean;
  isSystemController?: boolean;
}

interface ListCanistersResponse {
  success: boolean;
  data?: {
    canisters: CanisterInfo[];
    totalCount: number;
  };
  error?: string;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    if (req.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders,
      });
    }

    const user = await getUserFromRequest(req);
    if (!user) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Unauthorized",
        } as ListCanistersResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const icService = new ICService();
    const canisters = await icService.getUserCanisters(user.id);

    const canisterInfos: CanisterInfo[] = canisters.map((canister) => ({
      id: canister.id,
      userId: canister.userId,
      icCanisterId: canister.icCanisterId,
      deleted: canister.deleted,
      deletedAt: canister.deletedAt?.toISOString(),
      createdAt: canister.createdAt.toISOString(),
      updatedAt: canister.updatedAt.toISOString(),
      frontendUrl:
        canister.frontendUrl || `https://${canister.icCanisterId}.icp0.io/`,
      cyclesBalance: canister.cyclesBalance,
      cyclesBalanceRaw: canister.cyclesBalanceRaw?.toString(),
      wasmBinarySize: canister.wasmBinarySize,
      moduleHash: canister.moduleHash,
      controllers: canister.controllers,
      isAssetCanister: canister.isAssetCanister,
      isSystemController: canister.isSystemController,
    }));

    console.log(
      `Retrieved ${canisterInfos.length} canisters for user ${user.id}`
    );

    const response: ListCanistersResponse = {
      success: true,
      data: {
        canisters: canisterInfos,
        totalCount: canisterInfos.length,
      },
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching canisters:", error);

    const response: ListCanistersResponse = {
      success: false,
      error: (error as Error)?.message || "Failed to fetch canisters",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
