import "jsr:@supabase/functions-js/edge-runtime.d.ts";

interface DnsQuery {
  name: string;
  type: string;
  server?: string;
}

interface DnsResult {
  name: string;
  type: string;
  server?: string;
  answers: string[];
  error?: string;
}

interface DnsQueryRequest {
  queries: DnsQuery[];
}

interface DnsQueryResponse {
  results: DnsResult[];
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    // Only accept POST requests
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse request body
    const body: DnsQueryRequest = await req.json();

    if (!body.queries || !Array.isArray(body.queries)) {
      return new Response(
        JSON.stringify({ error: "Invalid request: queries array is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Validate each query
    for (const query of body.queries) {
      if (!query.name || typeof query.name !== "string") {
        return new Response(
          JSON.stringify({ error: "Invalid request: query.name is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      if (!query.type || typeof query.type !== "string") {
        return new Response(
          JSON.stringify({ error: "Invalid request: query.type is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    console.log(
      `[DNS-QUERY] Processing ${body.queries.length} DNS queries via build-service...`
    );

    // Get build-service URL and token from environment
    const buildServiceUrl = Deno.env.get("BUILD_SERVICE_URL");
    const buildServiceToken = Deno.env.get("BUILD_SERVICE_TOKEN");

    if (!buildServiceUrl) {
      console.error("[DNS-QUERY] BUILD_SERVICE_URL not configured");
      return new Response(
        JSON.stringify({ error: "DNS service not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Call build-service DNS query endpoint
    const buildServiceResponse = await fetch(`${buildServiceUrl}/dns-query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${buildServiceToken || "default-token"}`,
      },
      body: JSON.stringify({ queries: body.queries }),
    });

    if (!buildServiceResponse.ok) {
      const errorText = await buildServiceResponse.text();
      console.error(`[DNS-QUERY] Build service error:`, errorText);
      return new Response(
        JSON.stringify({
          error: `DNS service error: ${buildServiceResponse.status}`,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const buildServiceResult = await buildServiceResponse.json();

    // Return results from build-service
    const response: DnsQueryResponse = {
      results: buildServiceResult.results || [],
    };

    console.log(
      `[DNS-QUERY] Successfully processed ${response.results.length} queries`
    );

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[DNS-QUERY] Error processing DNS query request:", error);

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Internal server error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
