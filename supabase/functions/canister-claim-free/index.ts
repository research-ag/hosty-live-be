import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getUserFromRequest } from "../_shared/auth.ts";
import { ICService } from "../_shared/ic-service.ts";

interface ClaimFreeCanisterResponse {
  success: boolean;
  data?: {
    canisterNumber: number;
    canisterId: string;
    frontendUrl: string;
  };
  error?: string;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    if (req.method !== "POST") {
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
        } as ClaimFreeCanisterResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const icService = new ICService();
    const result = await icService.createFreeCanister(user.id);

    console.log(
      `Created free canister ${result.canister.icCanisterId} for user ${user.id}`
    );

    const response: ClaimFreeCanisterResponse = {
      success: true,
      data: {
        canisterNumber: result.canisterNumber,
        canisterId: result.canister.icCanisterId,
        frontendUrl: `https://${result.canister.icCanisterId}.icp0.io/`,
      },
    };

    return new Response(JSON.stringify(response), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error claiming free canister:", error);

    const response: ClaimFreeCanisterResponse = {
      success: false,
      error: (error as Error)?.message || "Failed to claim free canister",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

