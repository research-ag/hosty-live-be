import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  verifyCanisterOwnership,
  createDeployment,
  updateDeploymentStatus,
} from "../_shared/database.ts";
import { getUserFromRequest } from "../_shared/auth.ts";
import { BuildServiceRequest } from "../_shared/types.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const buildServiceUrl = Deno.env.get("BUILD_SERVICE_URL")!;

// For local development, use external URL instead of internal Docker URL
const externalSupabaseUrl = supabaseUrl.includes("kong:8000")
  ? "http://127.0.0.1:54321"
  : supabaseUrl;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

function createSuccessResponse(data: any) {
  return new Response(JSON.stringify({ success: true, ...data }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  console.log(`[ZIP-DEPLOY] Received ${req.method} request`);

  if (req.method === "OPTIONS") {
    console.log("[ZIP-DEPLOY] Handling OPTIONS request");
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    console.log(`[ZIP-DEPLOY] Method ${req.method} not allowed`);
    return createErrorResponse(405, "Method not allowed");
  }

  try {
    console.log(`[ZIP-DEPLOY] Getting user from request`);
    const user = await getUserFromRequest(req);
    if (!user) {
      console.log(`[ZIP-DEPLOY] User not authenticated`);
      return createErrorResponse(401, "Unauthorized");
    }
    console.log(`[ZIP-DEPLOY] User authenticated: ${user.id}`);

    console.log(`[ZIP-DEPLOY] Parsing form data`);
    const formData = await req.formData();
    const zipFile = formData.get("zip") as File;
    const canisterId = formData.get("canisterId") as string;
    const buildCommand =
      (formData.get("buildCommand") as string) || "npm run build";
    const outputDir = (formData.get("outputDir") as string) || "dist";

    console.log(
      `[ZIP-DEPLOY] Form data parsed - zipFile: ${zipFile?.name}, canisterId: ${canisterId}, buildCommand: ${buildCommand}, outputDir: ${outputDir}`
    );

    console.log(`[ZIP-DEPLOY] Validating request fields`);
    if (!zipFile || !canisterId) {
      console.log(
        `[ZIP-DEPLOY] Missing required fields: zipFile=${zipFile?.name}, canisterId=${canisterId}`
      );
      return createErrorResponse(
        400,
        "Missing required fields: zip file and canisterId"
      );
    }

    console.log(`[ZIP-DEPLOY] Validating zip file: ${zipFile.name}`);
    if (!zipFile.name.endsWith(".zip")) {
      console.log(`[ZIP-DEPLOY] File is not a zip archive: ${zipFile.name}`);
      return createErrorResponse(400, "File must be a .zip archive");
    }

    console.log(`[ZIP-DEPLOY] Checking file size: ${zipFile.size} bytes`);
    if (zipFile.size > 100 * 1024 * 1024) {
      console.log(`[ZIP-DEPLOY] File size too large: ${zipFile.size} bytes`);
      return createErrorResponse(400, "File size must be less than 100MB");
    }

    console.log(`[ZIP-DEPLOY] Verifying canister ownership: ${canisterId}`);
    const ownsCanister = await verifyCanisterOwnership(canisterId, user.id);
    if (!ownsCanister) {
      console.log(
        `[ZIP-DEPLOY] Canister ownership verification failed for: ${canisterId}`
      );
      return createErrorResponse(403, "Canister not found or access denied");
    }

    console.log(`[ZIP-DEPLOY] Creating deployment record`);
    const deployment = await createDeployment(
      user.id,
      canisterId,
      buildCommand,
      outputDir
    );
    console.log(`[ZIP-DEPLOY] Deployment created: ${deployment.id}`);

    const zipFileName = `deployments/${deployment.id}/source.zip`;
    console.log(`[ZIP-DEPLOY] Uploading zip file to storage: ${zipFileName}`);

    const { error: uploadError } = await supabase.storage
      .from("deployments")
      .upload(zipFileName, zipFile, {
        cacheControl: "3600",
        upsert: false,
      });

    console.log(
      `[ZIP-DEPLOY] Upload result - error: ${uploadError?.message || "none"}`
    );

    if (uploadError) {
      console.log(`[ZIP-DEPLOY] Upload failed: ${uploadError.message}`);
      await updateDeploymentStatus(
        deployment.id,
        "FAILED",
        "File upload failed"
      );
      return createErrorResponse(500, "Failed to upload file");
    }

    console.log(`[ZIP-DEPLOY] Creating signed URL for build service`);
    const { data: signedUrlData } = await supabase.storage
      .from("deployments")
      .createSignedUrl(zipFileName, 3600);

    if (!signedUrlData?.signedUrl) {
      console.log(`[ZIP-DEPLOY] Failed to create signed URL`);
      await updateDeploymentStatus(
        deployment.id,
        "FAILED",
        "File preparation failed"
      );
      return createErrorResponse(
        500,
        "Failed to prepare file for build service"
      );
    }

    // Fix URL for external access (replace internal Docker hostname with external URL)
    const externalSourceUrl = signedUrlData.signedUrl.replace(
      /http:\/\/kong:8000/g,
      externalSupabaseUrl
    );

    console.log(`[ZIP-DEPLOY] External source URL: ${externalSourceUrl}`);
    console.log(`[ZIP-DEPLOY] supabaseUrl: ${supabaseUrl}`);
    console.log(`[ZIP-DEPLOY] externalSupabaseUrl: ${externalSupabaseUrl}`);

    // Also fix webhook URL to be externally accessible
    const externalWebhookUrl = `${externalSupabaseUrl}/functions/v1/deployment-webhook`;
    console.log(`[ZIP-DEPLOY] Webhook URL: ${externalWebhookUrl}`);

    console.log(`[ZIP-DEPLOY] Updating deployment status to PENDING`);
    await updateDeploymentStatus(deployment.id, "PENDING", undefined, {
      source_zip_url: externalSourceUrl,
    });

    console.log(`[ZIP-DEPLOY] Preparing build request`);
    const buildRequest: BuildServiceRequest = {
      deploymentId: deployment.id,
      sourceZipUrl: externalSourceUrl,
      buildCommand,
      outputDir,
      webhookUrl: externalWebhookUrl,
    };
    console.log(`[ZIP-DEPLOY] Build request:`, buildRequest);

    console.log(
      `[ZIP-DEPLOY] Environment variables - BUILD_SERVICE_URL: ${buildServiceUrl}`
    );
    console.log(
      `[ZIP-DEPLOY] Environment variables - BUILD_SERVICE_TOKEN: ${
        Deno.env.get("BUILD_SERVICE_TOKEN") ? "SET" : "NOT SET"
      }`
    );

    try {
      console.log(
        `[ZIP-DEPLOY] Calling build service: ${buildServiceUrl}/build`
      );
      console.log(`[ZIP-DEPLOY] About to fetch...`);
      const buildResponse = await fetch(`${buildServiceUrl}/build`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${
            Deno.env.get("BUILD_SERVICE_TOKEN") || "default-token"
          }`,
        },
        body: JSON.stringify(buildRequest),
      });
      console.log(
        `[ZIP-DEPLOY] Build service response status: ${buildResponse.status}`
      );

      if (!buildResponse.ok) {
        console.log(
          `[ZIP-DEPLOY] Build service responded with error status: ${buildResponse.status}`
        );
        const errorText = await buildResponse.text();
        console.log(`[ZIP-DEPLOY] Build service error response: ${errorText}`);
        throw new Error(
          `Build service responded with status ${buildResponse.status}: ${errorText}`
        );
      }

      console.log(`[ZIP-DEPLOY] Parsing build service response`);
      const buildResult = await buildResponse.json();
      console.log(`[ZIP-DEPLOY] Build result:`, buildResult);

      if (buildResult.jobId) {
        console.log(
          `[ZIP-DEPLOY] Updating deployment status to BUILDING with job ID: ${buildResult.jobId}`
        );
        await updateDeploymentStatus(
          deployment.id,
          "BUILDING",
          "Build started",
          {
            build_service_job_id: buildResult.jobId,
          }
        );
      } else {
        console.log(
          `[ZIP-DEPLOY] Updating deployment status to BUILDING without job ID`
        );
        await updateDeploymentStatus(
          deployment.id,
          "BUILDING",
          "Build started"
        );
      }
    } catch (buildError) {
      console.error(`[ZIP-DEPLOY] Build service error:`, buildError);
      console.error(
        `[ZIP-DEPLOY] Build service error stack:`,
        buildError instanceof Error ? buildError.stack : "No stack"
      );
      const errorMessage =
        buildError instanceof Error
          ? buildError.message
          : "Unknown build service error";

      console.log(
        `[ZIP-DEPLOY] Updating deployment status to FAILED due to build service error`
      );
      await updateDeploymentStatus(
        deployment.id,
        "FAILED",
        "Build service unavailable"
      );
      return createErrorResponse(500, "Failed to start build process");
    }

    console.log(`[ZIP-DEPLOY] Returning success response`);
    return createSuccessResponse({ deploymentId: deployment.id });
  } catch (error) {
    console.error(`[ZIP-DEPLOY] Upload deployment error:`, error);
    console.error(
      `[ZIP-DEPLOY] Error stack:`,
      error instanceof Error ? error.stack : "No stack"
    );
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    return createErrorResponse(500, errorMessage);
  }
});
