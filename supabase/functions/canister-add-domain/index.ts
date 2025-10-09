import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getUserFromRequest } from "../_shared/auth.ts";
import { ICService } from "../_shared/ic-service.ts";

interface AddDomainRequest {
  canisterId: string;
  domain: string;
  skipUpload?: boolean;
}

interface AddDomainResponse {
  success: boolean;
  requestId?: string;
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
        } as AddDomainResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const requestBody: AddDomainRequest = await req.json();
    const { canisterId, domain, skipUpload } = requestBody;

    if (!canisterId || !domain) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "canisterId and domain are required",
        } as AddDomainResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Basic domain validation
    const domainRegex =
      /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
    if (!domainRegex.test(domain)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid domain format",
        } as AddDomainResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const icService = new ICService();
    const requestId = await icService.configureDomain(user.id, canisterId, domain, skipUpload);

    console.log(
      `Domain ${domain} configured for canister ${canisterId} by user ${user.id}`
    );

    const response: AddDomainResponse = {
      success: true,
      requestId,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error adding domain:", error);

    const response: AddDomainResponse = {
      success: false,
      error: (error as Error)?.message || "Failed to add domain",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
