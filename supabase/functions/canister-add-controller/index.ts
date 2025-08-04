import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ICService } from "../_shared/ic-service.ts";

interface AddControllerRequest {
  canisterId: string;
  userPrincipal: string;
}

interface AddControllerResponse {
  success: boolean;
  error?: string;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // Handle CORS preflight
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

    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing authorization header",
        } as AddControllerResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const jwt = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(jwt);

    if (authError || !user) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid or expired token",
        } as AddControllerResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const requestBody: AddControllerRequest = await req.json();
    const { canisterId, userPrincipal } = requestBody;

    if (!canisterId || !userPrincipal) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "canisterId and userPrincipal are required",
        } as AddControllerResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Validate principal format
    try {
      // Basic validation - IC principals are typically 63 characters with dashes
      if (!/^[a-z0-9-]{27,63}$/.test(userPrincipal)) {
        throw new Error("Invalid principal format");
      }
    } catch {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid principal format",
        } as AddControllerResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const icService = new ICService();
    await icService.addController(user.id, canisterId, userPrincipal);

    console.log(
      `Added controller ${userPrincipal} to canister ${canisterId} for user ${user.id}`
    );

    const response: AddControllerResponse = {
      success: true,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error adding controller:", error);

    const response: AddControllerResponse = {
      success: false,
      error: (error as Error)?.message || "Failed to add controller",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
