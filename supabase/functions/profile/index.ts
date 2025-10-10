import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  getUserFromRequest,
  getUserProfile,
  updateUserProfile,
} from "../_shared/database.ts";

console.log("Profile Function loaded");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
};

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

  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return createErrorResponse(401, "Unauthorized");
    }

    switch (req.method) {
      case "GET":
        return await handleGetProfile(user.id);

      case "PUT":
        return await handleUpdateProfile(user.id, req);

      default:
        return createErrorResponse(405, "Method not allowed");
    }
  } catch (error) {
    console.error("Unexpected error:", error);
    return createErrorResponse(500, "Internal server error");
  }
});

async function handleGetProfile(userId: string) {
  try {
    const profile = await getUserProfile(userId);

    return createSuccessResponse({
      id: profile.id,
      username: profile.username,
      principal: profile.principal,
      freeCanisterClaimedAt: profile.free_canister_claimed_at,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch profile";
    return createErrorResponse(500, message);
  }
}

async function handleUpdateProfile(userId: string, req: Request) {
  try {
    const { username } = await req.json();

    if (!username || typeof username !== "string") {
      return createErrorResponse(
        400,
        "Username is required and must be a string"
      );
    }

    const profile = await updateUserProfile(userId, {
      username: username.trim(),
    });

    return createSuccessResponse({
      id: profile.id,
      username: profile.username,
      principal: profile.principal,
      freeCanisterClaimedAt: profile.free_canister_claimed_at,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
    });
  } catch (error) {
    console.error("Update profile error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to update profile";
    return createErrorResponse(500, message);
  }
}
