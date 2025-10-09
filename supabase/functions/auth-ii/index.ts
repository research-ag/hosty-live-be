import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getOrCreateUserByPrincipal } from "../_shared/auth.ts";

console.log("Internet Identity Auth Function loaded");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AuthIIRequest {
  principal: string;
}

interface AuthIIResponse {
  success: boolean;
  profile?: {
    id: string;
    principal: string;
    cyclesBalance: string;
    faucetUsedAt: string | null;
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
    const { principal }: AuthIIRequest = await req.json();

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
        cyclesBalance: profile.cycles_balance,
        faucetUsedAt: profile.faucet_used_at,
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

/* To invoke:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/auth-ii' \
    --header 'Content-Type: application/json' \
    --data '{"principal":"xxxxx-xxxxx-xxxxx-xxxxx-xxx"}'

  Response:
  {
    "success": true,
    "profile": {
      "id": "uuid-...",
      "principal": "xxxxx-xxxxx-...",
      "cyclesBalance": "2000000000000",
      ...
    },
    "accessToken": "eyJ...",
    "refreshToken": "eyJ..."
  }

  Then use accessToken in Authorization header for all other API calls:
  Authorization: Bearer <accessToken>
*/

