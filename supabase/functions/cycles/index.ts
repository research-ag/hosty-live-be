import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  getUserFromRequest,
  getUserCyclesBalance,
} from "../_shared/database.ts";

console.log("Cycles Function loaded");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const CANISTER_CREATION_COST = 800_000_000_000n; // 0.8 TC

function createErrorResponse(status: number, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function createSuccessResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return createErrorResponse(405, "Method not allowed");
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return createErrorResponse(401, "Unauthorized");
    }

    const currentBalance = await getUserCyclesBalance(user.id);
    const canCreateCanister = currentBalance >= CANISTER_CREATION_COST;

    return createSuccessResponse({
      cyclesBalance: currentBalance.toString(),
      canisterCreationCost: CANISTER_CREATION_COST.toString(),
      canCreateCanister,
      balanceFormatted: formatCycles(currentBalance),
    });
  } catch (error) {
    console.error("Get cycles error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return createErrorResponse(500, message);
  }
});

function formatCycles(cycles: bigint): string {
  const trillion = 1_000_000_000_000n;
  const billion = 1_000_000_000n;
  const million = 1_000_000n;

  if (cycles >= trillion) {
    const tc = cycles / trillion;
    const remainder = (cycles % trillion) / (trillion / 100n);
    return remainder > 0n
      ? `${tc}.${remainder.toString().padStart(2, "0")} TC`
      : `${tc} TC`;
  } else if (cycles >= billion) {
    const gc = cycles / billion;
    const remainder = (cycles % billion) / (billion / 100n);
    return remainder > 0n
      ? `${gc}.${remainder.toString().padStart(2, "0")} GC`
      : `${gc} GC`;
  } else if (cycles >= million) {
    const mc = cycles / million;
    const remainder = (cycles % million) / (million / 100n);
    return remainder > 0n
      ? `${mc}.${remainder.toString().padStart(2, "0")} MC`
      : `${mc} MC`;
  } else {
    return `${cycles} cycles`;
  }
}
