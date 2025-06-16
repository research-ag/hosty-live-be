import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ICService } from "../_shared/ic-service.ts";

interface CanisterDetailInfo {
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
}

interface GetCanisterResponse {
  success: boolean;
  data?: CanisterDetailInfo;
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

    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing authorization header",
        } as GetCanisterResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const url = new URL(req.url);
    const canisterId = url.searchParams.get("canisterId");

    if (!canisterId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "canisterId is required",
        } as GetCanisterResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const jwt = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);

    if (authError || !user) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid or expired token",
        } as GetCanisterResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const icService = new ICService();
    const canister = await icService.getCanister(user.id, canisterId);

    if (!canister) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Canister not found",
        } as GetCanisterResponse),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const canisterInfo: CanisterDetailInfo = {
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
    };

    console.log(`Retrieved canister ${canisterId} for user ${user.id}`);

    const response: GetCanisterResponse = {
      success: true,
      data: canisterInfo,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching canister:", error);

    const response: GetCanisterResponse = {
      success: false,
      error: (error as Error)?.message || "Failed to fetch canister",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
