import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getUserFromRequest, getDeployment } from "../_shared/database.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function createErrorResponse(status: number, error: string) {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function createSuccessResponse(data: any) {
  return new Response(JSON.stringify({ success: true, ...data }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
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

    const url = new URL(req.url);
    const deploymentId = url.searchParams.get("id");

    if (!deploymentId) {
      return createErrorResponse(400, "Missing deployment ID");
    }

    const deployment = await getDeployment(deploymentId);

    if (!deployment) {
      return createErrorResponse(404, "Deployment not found");
    }

    if (deployment.user_id !== user.id) {
      return createErrorResponse(403, "Access denied");
    }

    return createSuccessResponse({ deployment });
  } catch (error) {
    console.error("Get deployment error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    return createErrorResponse(500, errorMessage);
  }
});
