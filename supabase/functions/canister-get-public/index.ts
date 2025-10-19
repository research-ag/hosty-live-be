import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ICService } from "../_shared/ic-service.ts";

interface PublicCanisterInfo {
  icCanisterId: string;
  createdAt: string;
  frontendUrl: string;
  cyclesBalance?: string;
  cyclesBalanceRaw?: string;
  controllers?: string[];
  isAssetCanister?: boolean;
  isSystemController?: boolean;
}

interface GetPublicCanisterResponse {
  success: boolean;
  data?: PublicCanisterInfo;
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

    const url = new URL(req.url);
    const canisterId = url.searchParams.get("canisterId");

    if (!canisterId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "canisterId is required",
        } as GetPublicCanisterResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const icService = new ICService();
    const canister = await icService.getCanisterByInternalId(canisterId);

    if (!canister) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Canister not found",
        } as GetPublicCanisterResponse),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const publicCanisterInfo: PublicCanisterInfo = {
      icCanisterId: canister.icCanisterId,
      createdAt: canister.createdAt.toISOString(),
      frontendUrl:
        canister.frontendUrl || `https://${canister.icCanisterId}.icp0.io/`,
      cyclesBalance: canister.cyclesBalance,
      cyclesBalanceRaw: canister.cyclesBalanceRaw?.toString(),
      controllers: canister.controllers,
      isAssetCanister: canister.isAssetCanister,
      isSystemController: canister.isSystemController,
    };

    console.log(`Retrieved public canister info for ${canisterId}`);

    const response: GetPublicCanisterResponse = {
      success: true,
      data: publicCanisterInfo,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching public canister info:", error);

    const response: GetPublicCanisterResponse = {
      success: false,
      error: (error as Error)?.message || "Failed to fetch canister",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

