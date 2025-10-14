import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getOrCreateUserByPrincipal, verifyChallenge } from "../_shared/auth.ts";

console.log("Internet Identity Auth Function loaded");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AuthIIRequest {
  principal: string;
  secret: string;
}

interface AuthIIResponse {
  success: boolean;
  profile?: {
    id: string;
    principal: string;
    freeCanisterClaimedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  accessToken?: string;
  refreshToken?: string;
  error?: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Method not allowed",
        } as AuthIIResponse),
        {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse request body
    const { principal, secret }: AuthIIRequest = await req.json();

    if (!principal || typeof principal !== "string") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid principal",
        } as AuthIIResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!secret || typeof secret !== "string") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid secret",
        } as AuthIIResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Validate principal format (basic validation)
    // IC principals are typically 27-63 characters with lowercase letters, numbers, and dashes
    if (!/^[a-z0-9-]{27,63}$/.test(principal)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid principal format",
        } as AuthIIResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Verify challenge from auth canister (SECURITY: This proves the frontend controls the principal)
    await verifyChallenge(principal, secret);

    // Get or create user profile
    const { profile, tokens } = await getOrCreateUserByPrincipal(principal);

    console.log(
      `II authentication successful for principal: ${principal}, user ID: ${profile.id}`
    );

    const response: AuthIIResponse = {
      success: true,
      profile: {
        id: profile.id,
        principal: profile.principal,
        freeCanisterClaimedAt: profile.free_canister_claimed_at,
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("II authentication error:", error);

    const response: AuthIIResponse = {
      success: false,
      error: (error as Error)?.message || "Authentication failed",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
