import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  getUserFromRequest,
  verifyCanisterOwnership,
  createDeployment,
  updateDeploymentStatus,
} from "../_shared/database.ts";
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
  if (req.method === "OPTIONS") {
    console.log("=== OPTIONS REQUEST ===");
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    console.log("=== METHOD NOT ALLOWED ===");
    return createErrorResponse(405, "Method not allowed");
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return createErrorResponse(401, "Unauthorized");
    }

    const formData = await req.formData();
    const zipFile = formData.get("zip") as File;
    const canisterId = formData.get("canisterId") as string;
    const buildCommand =
      (formData.get("buildCommand") as string) || "npm run build";
    const outputDir = (formData.get("outputDir") as string) || "dist";

    if (!zipFile || !canisterId) {
      return createErrorResponse(
        400,
        "Missing required fields: zip file and canisterId"
      );
    }

    if (!zipFile.name.endsWith(".zip")) {
      return createErrorResponse(400, "File must be a .zip archive");
    }

    if (zipFile.size > 100 * 1024 * 1024) {
      return createErrorResponse(400, "File size must be less than 100MB");
    }

    const ownsCanister = await verifyCanisterOwnership(canisterId, user.id);
    if (!ownsCanister) {
      return createErrorResponse(403, "Canister not found or access denied");
    }

    const deployment = await createDeployment(
      user.id,
      canisterId,
      buildCommand,
      outputDir
    );

    const zipFileName = `deployments/${deployment.id}/source.zip`;
    const { error: uploadError } = await supabase.storage
      .from("deployments")
      .upload(zipFileName, zipFile, {
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      await updateDeploymentStatus(
        deployment.id,
        "FAILED",
        `Upload failed: ${uploadError.message}`
      );
      return createErrorResponse(500, "Failed to upload file");
    }

    const { data: signedUrlData } = await supabase.storage
      .from("deployments")
      .createSignedUrl(zipFileName, 3600);

    if (!signedUrlData?.signedUrl) {
      await updateDeploymentStatus(
        deployment.id,
        "FAILED",
        "Failed to create signed URL for build service"
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

    console.log("External source URL:", externalSourceUrl);
    console.log("supabaseUrl", supabaseUrl);
    console.log("externalSupabaseUrl", externalSupabaseUrl);

    // Also fix webhook URL to be externally accessible
    const externalWebhookUrl = `${externalSupabaseUrl}/functions/v1/deployment-webhook`;

    await updateDeploymentStatus(deployment.id, "PENDING", undefined, {
      source_zip_url: externalSourceUrl,
    });
    const buildRequest: BuildServiceRequest = {
      deploymentId: deployment.id,
      sourceZipUrl: externalSourceUrl,
      buildCommand,
      outputDir,
      webhookUrl: externalWebhookUrl,
    };

    try {
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

      if (!buildResponse.ok) {
        throw new Error(
          `Build service responded with status ${buildResponse.status}`
        );
      }

      const buildResult = await buildResponse.json();

      if (buildResult.jobId) {
        await updateDeploymentStatus(
          deployment.id,
          "BUILDING",
          "Build started",
          {
            build_service_job_id: buildResult.jobId,
          }
        );
      } else {
        await updateDeploymentStatus(
          deployment.id,
          "BUILDING",
          "Build started"
        );
      }
    } catch (buildError) {
      console.error("Failed to trigger build service:", buildError);
      const errorMessage =
        buildError instanceof Error
          ? buildError.message
          : "Unknown build service error";
      await updateDeploymentStatus(
        deployment.id,
        "FAILED",
        `Build service error: ${errorMessage}`
      );
      return createErrorResponse(500, "Failed to start build process");
    }

    return createSuccessResponse({ deploymentId: deployment.id });
  } catch (error) {
    console.error("Upload deployment error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    return createErrorResponse(500, errorMessage);
  }
});
