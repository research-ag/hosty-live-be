import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  getUserFromRequest,
  getFaucetStatus,
  useFaucet,
} from "../_shared/database.ts";

console.log("Faucet Function loaded");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const FAUCET_AMOUNT = 2_000_000_000_000n; // 2 TC
const FAUCET_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

function createErrorResponse(status: number, error: string, extra?: object) {
  return new Response(JSON.stringify({ error, ...extra }), {
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

  try {
    console.log('=== log 0')
    const user = await getUserFromRequest(req);
    if (!user) {
      return createErrorResponse(401, "Unauthorized");
    }

    switch (req.method) {
      case "GET":
        console.log('=== log 1')
        return await handleGetFaucetStatus(user.id);

      case "POST":
        return await handleUseFaucet(user.id);

      default:
        return createErrorResponse(405, "Method not allowed");
    }
  } catch (error) {
    console.error("Unexpected error:", error);
    return createErrorResponse(500, "Internal server error");
  }
});

async function handleGetFaucetStatus(userId: string) {
  try {
    console.log('=== log 2')
    const { faucetUsedAt, cyclesBalance } = await getFaucetStatus(userId);
    console.log('=== log 3')
    const now = new Date();
    const lastUsed = faucetUsedAt ? new Date(faucetUsedAt) : null;
    const canUseFaucet =
      !lastUsed || now.getTime() - lastUsed.getTime() >= FAUCET_COOLDOWN_MS;

    let nextAvailableAt = null;
    if (lastUsed && !canUseFaucet) {
      nextAvailableAt = new Date(lastUsed.getTime() + FAUCET_COOLDOWN_MS);
    }

    return createSuccessResponse({
      canUseFaucet,
      cyclesBalance,
      faucetAmount: FAUCET_AMOUNT.toString(),
      lastUsedAt: faucetUsedAt,
      nextAvailableAt: nextAvailableAt?.toISOString() || null,
      cooldownMs: FAUCET_COOLDOWN_MS,
    });
  } catch (error) {
    console.error("Get faucet status error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch faucet status";
    return createErrorResponse(500, message);
  }
}

async function handleUseFaucet(userId: string) {
  try {
    // Check eligibility
    const { faucetUsedAt } = await getFaucetStatus(userId);

    const now = new Date();
    const lastUsed = faucetUsedAt ? new Date(faucetUsedAt) : null;
    const canUseFaucet =
      !lastUsed || now.getTime() - lastUsed.getTime() >= FAUCET_COOLDOWN_MS;

    if (!canUseFaucet) {
      const nextAvailableAt = new Date(lastUsed!.getTime() + FAUCET_COOLDOWN_MS);
      return createErrorResponse(
        429,
        "Faucet is on cooldown",
        {
          nextAvailableAt: nextAvailableAt.toISOString(),
          cooldownMs: FAUCET_COOLDOWN_MS,
        }
      );
    }

    // Use faucet
    const { newBalance, faucetUsedAt: updatedFaucetUsedAt } = await useFaucet(
      userId,
      FAUCET_AMOUNT
    );

    return createSuccessResponse({
      success: true,
      cyclesAdded: FAUCET_AMOUNT.toString(),
      newBalance,
      faucetUsedAt: updatedFaucetUsedAt,
      nextAvailableAt: new Date(now.getTime() + FAUCET_COOLDOWN_MS).toISOString(),
    });
  } catch (error) {
    console.error("Use faucet error:", error);
    const message = error instanceof Error ? error.message : "Failed to use faucet";
    return createErrorResponse(500, message);
  }
}
