import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getUserFromRequest } from "../_shared/auth.ts";
import { ICService } from "../_shared/ic-service.ts";

interface DeleteCanisterRequest {
  canisterId: string;
}

interface DeleteCanisterResponse {
  success: boolean;
  error?: string;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "DELETE, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    if (req.method !== "DELETE") {
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
        } as DeleteCanisterResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { canisterId }: DeleteCanisterRequest = await req.json();

    if (!canisterId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "canisterId is required",
        } as DeleteCanisterResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const icService = new ICService();
    await icService.deleteCanister(user.id, canisterId);

    console.log(`Deleted canister ${canisterId} for user ${user.id}`);

    const response: DeleteCanisterResponse = {
      success: true,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error deleting canister:", error);

    const response: DeleteCanisterResponse = {
      success: false,
      error: (error as Error)?.message || "Failed to delete canister",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
