import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  getDeploymentWithCanister,
  updateDeploymentStatus,
} from "../_shared/database.ts";
import { WebhookPayload } from "../_shared/types.ts";
import { ICService } from "../_shared/ic-service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function createErrorResponse(status: number, error: string) {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function createSuccessResponse() {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return createErrorResponse(405, "Method not allowed");
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const expectedToken =
      Deno.env.get("BUILD_SERVICE_TOKEN") || "default-token";

    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ") ||
      authHeader.slice(7) !== expectedToken
    ) {
      return createErrorResponse(401, "Unauthorized");
    }

    const payload: WebhookPayload = await req.json();
    const {
      deploymentId,
      status,
      statusReason,
      builtAssetsUrl,
      buildLogs,
      duration,
    } = payload;

    if (!deploymentId) {
      return createErrorResponse(400, "Missing deploymentId");
    }

    const deploymentData = await getDeploymentWithCanister(deploymentId);
    if (!deploymentData) {
      return createErrorResponse(404, "Deployment not found");
    }

    const { canister } = deploymentData;

    if (status === "SUCCESS" && builtAssetsUrl) {
      // Build completed successfully, now deploy to IC
      await updateDeploymentStatus(
        deploymentId,
        "DEPLOYING",
        "Build completed, deploying to IC...",
        {
          built_assets_url: builtAssetsUrl,
          build_logs: buildLogs,
          duration_ms: duration,
        }
      );

      // Use background task for IC deployment to avoid CPU time limits
      EdgeRuntime.waitUntil(
        (async () => {
          try {
            const startTime = Date.now();
            const icService = new ICService();
            await icService.deployAssetsToCanister(
              canister.ic_canister_id,
              builtAssetsUrl
            );
            const deploymentDuration = Date.now() - startTime + (duration || 0);

            await updateDeploymentStatus(
              deploymentId,
              "SUCCESS",
              "Successfully deployed to IC",
              {
                deployed_at: new Date().toISOString(),
                duration_ms: deploymentDuration,
              }
            );
          } catch (icError) {
            console.error("Failed to deploy to IC:", icError);
            const errorMessage =
              icError instanceof Error
                ? icError.message
                : "Unknown IC deployment error";
            await updateDeploymentStatus(
              deploymentId,
              "FAILED",
              `IC deployment failed: ${errorMessage}`,
              {
                build_logs: buildLogs,
                duration_ms: duration,
              }
            );
          }
        })()
      );
    } else {
      await updateDeploymentStatus(
        deploymentId,
        "FAILED",
        statusReason || "Build failed",
        {
          build_logs: buildLogs,
          duration_ms: duration,
        }
      );
    }

    return createSuccessResponse();
  } catch (error) {
    console.error("Deployment webhook error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    return createErrorResponse(500, errorMessage);
  }
});
