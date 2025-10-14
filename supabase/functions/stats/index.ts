import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface StatsResponse {
  success: boolean;
  data?: {
    users: {
      total: number;
      last7Days: number;
      last24Hours: number;
    };
    canisters: {
      total: number;
      last7Days: number;
      last24Hours: number;
    };
    deployments: {
      total: number;
      last7Days: number;
      last24Hours: number;
    };
    freeCanistersClaimed: {
      total: number;
      last7Days: number;
      last24Hours: number;
    };
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

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method !== "GET") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Method not allowed",
        } as StatsResponse),
        {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get stats using efficient queries
    const now = new Date();
    const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Users stats
    const [{ count: totalUsers }, { count: users7d }, { count: users24h }] =
      await Promise.all([
        supabase.from("profiles").select("*", { count: "exact", head: true }),
        supabase
          .from("profiles")
          .select("*", { count: "exact", head: true })
          .gte("created_at", last7Days.toISOString()),
        supabase
          .from("profiles")
          .select("*", { count: "exact", head: true })
          .gte("created_at", last24Hours.toISOString()),
      ]);

    // Canisters stats (excluding deleted)
    const [
      { count: totalCanisters },
      { count: canisters7d },
      { count: canisters24h },
    ] = await Promise.all([
      supabase
        .from("canisters")
        .select("*", { count: "exact", head: true })
        .eq("deleted", false),
      supabase
        .from("canisters")
        .select("*", { count: "exact", head: true })
        .eq("deleted", false)
        .gte("created_at", last7Days.toISOString()),
      supabase
        .from("canisters")
        .select("*", { count: "exact", head: true })
        .eq("deleted", false)
        .gte("created_at", last24Hours.toISOString()),
    ]);

    // Deployments stats
    const [
      { count: totalDeployments },
      { count: deployments7d },
      { count: deployments24h },
    ] = await Promise.all([
      supabase.from("deployments").select("*", { count: "exact", head: true }),
      supabase
        .from("deployments")
        .select("*", { count: "exact", head: true })
        .gte("created_at", last7Days.toISOString()),
      supabase
        .from("deployments")
        .select("*", { count: "exact", head: true })
        .gte("created_at", last24Hours.toISOString()),
    ]);

    // Free canisters claimed stats
    const [
      { count: totalFreeCanisters },
      { count: freeCanisters7d },
      { count: freeCanisters24h },
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .not("free_canister_claimed_at", "is", null),
      supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .not("free_canister_claimed_at", "is", null)
        .gte("free_canister_claimed_at", last7Days.toISOString()),
      supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .not("free_canister_claimed_at", "is", null)
        .gte("free_canister_claimed_at", last24Hours.toISOString()),
    ]);

    const response: StatsResponse = {
      success: true,
      data: {
        users: {
          total: totalUsers || 0,
          last7Days: users7d || 0,
          last24Hours: users24h || 0,
        },
        canisters: {
          total: totalCanisters || 0,
          last7Days: canisters7d || 0,
          last24Hours: canisters24h || 0,
        },
        deployments: {
          total: totalDeployments || 0,
          last7Days: deployments7d || 0,
          last24Hours: deployments24h || 0,
        },
        freeCanistersClaimed: {
          total: totalFreeCanisters || 0,
          last7Days: freeCanisters7d || 0,
          last24Hours: freeCanisters24h || 0,
        },
      },
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching stats:", error);

    const response: StatsResponse = {
      success: false,
      error: (error as Error)?.message || "Failed to fetch stats",
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
