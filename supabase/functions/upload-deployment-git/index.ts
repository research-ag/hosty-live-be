import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  getUserFromRequest,
  verifyCanisterOwnership,
  createDeployment,
  updateDeploymentStatus,
} from "../_shared/database.ts";
import { GitBuildServiceRequest } from "../_shared/types.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const buildServiceUrl = Deno.env.get("BUILD_SERVICE_URL")!;

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

function validateGitUrl(url: string): boolean {
  const gitUrlRegex =
    /^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([\/\w .-]*)*\/?$/;
  return (
    gitUrlRegex.test(url) &&
    (url.includes("github.com") ||
      url.includes("gitlab.com") ||
      url.includes("bitbucket.org") ||
      url.includes(".git"))
  );
}

Deno.serve(async (req: Request): Promise<Response> => {
  console.log(`[GIT-DEPLOY] Received ${req.method} request`);

  if (req.method === "OPTIONS") {
    console.log(`[GIT-DEPLOY] Handling OPTIONS request`);
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    console.log(`[GIT-DEPLOY] Method ${req.method} not allowed`);
    return createErrorResponse(405, "Method not allowed");
  }

  try {
    console.log(`[GIT-DEPLOY] Getting user from request`);
    const user = await getUserFromRequest(req);
    if (!user) {
      console.log(`[GIT-DEPLOY] User not authenticated`);
      return createErrorResponse(401, "Unauthorized");
    }
    console.log(`[GIT-DEPLOY] User authenticated: ${user.id}`);

    console.log(`[GIT-DEPLOY] Parsing request body`);
    const body = await req.json();
    console.log(`[GIT-DEPLOY] Request body:`, body);

    const {
      gitRepoUrl,
      canisterId,
      buildCommand = "npm run build",
      outputDir = "dist",
      branch = "main",
    } = body;

    console.log(`[GIT-DEPLOY] Validating request fields`);
    if (!gitRepoUrl || !canisterId) {
      console.log(
        `[GIT-DEPLOY] Missing required fields: gitRepoUrl=${gitRepoUrl}, canisterId=${canisterId}`
      );
      return createErrorResponse(
        400,
        "Missing required fields: gitRepoUrl and canisterId"
      );
    }

    console.log(`[GIT-DEPLOY] Validating git URL: ${gitRepoUrl}`);
    if (!validateGitUrl(gitRepoUrl)) {
      console.log(`[GIT-DEPLOY] Invalid git repository URL: ${gitRepoUrl}`);
      return createErrorResponse(400, "Invalid git repository URL");
    }

    console.log(`[GIT-DEPLOY] Verifying canister ownership: ${canisterId}`);
    const ownsCanister = await verifyCanisterOwnership(canisterId, user.id);
    if (!ownsCanister) {
      console.log(
        `[GIT-DEPLOY] Canister ownership verification failed for: ${canisterId}`
      );
      return createErrorResponse(403, "Canister not found or access denied");
    }

    console.log(`[GIT-DEPLOY] Creating deployment record`);
    const deployment = await createDeployment(
      user.id,
      canisterId,
      buildCommand,
      outputDir
    );
    console.log(`[GIT-DEPLOY] Deployment created: ${deployment.id}`);

    const externalWebhookUrl = `${externalSupabaseUrl}/functions/v1/deployment-webhook`;
    console.log(`[GIT-DEPLOY] Webhook URL: ${externalWebhookUrl}`);

    console.log(`[GIT-DEPLOY] Updating deployment status to PENDING`);
    await updateDeploymentStatus(deployment.id, "PENDING", undefined, {
      source_git_repo: gitRepoUrl,
      source_type: "git",
      git_branch: branch,
    });

    console.log(`[GIT-DEPLOY] Preparing build request`);
    const buildRequest: GitBuildServiceRequest = {
      deploymentId: deployment.id,
      gitRepoUrl,
      buildCommand,
      outputDir,
      webhookUrl: externalWebhookUrl,
      branch,
    };
    console.log(`[GIT-DEPLOY] Build request:`, buildRequest);

    console.log(
      `[GIT-DEPLOY] Environment variables - BUILD_SERVICE_URL: ${buildServiceUrl}`
    );
    console.log(
      `[GIT-DEPLOY] Environment variables - BUILD_SERVICE_TOKEN: ${
        Deno.env.get("BUILD_SERVICE_TOKEN") ? "SET" : "NOT SET"
      }`
    );

    try {
      console.log(
        `[GIT-DEPLOY] Calling build service: ${buildServiceUrl}/build-git`
      );
      console.log(`[GIT-DEPLOY] About to fetch...`);
      const buildResponse = await fetch(`${buildServiceUrl}/build-git`, {
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
        `[GIT-DEPLOY] Build service response status: ${buildResponse.status}`
      );

      if (!buildResponse.ok) {
        console.log(
          `[GIT-DEPLOY] Build service responded with error status: ${buildResponse.status}`
        );
        const errorText = await buildResponse.text();
        console.log(`[GIT-DEPLOY] Build service error response: ${errorText}`);
        throw new Error(
          `Build service responded with status ${buildResponse.status}: ${errorText}`
        );
      }

      console.log(`[GIT-DEPLOY] Parsing build service response`);
      const buildResult = await buildResponse.json();
      console.log(`[GIT-DEPLOY] Build result:`, buildResult);

      if (buildResult.jobId) {
        console.log(
          `[GIT-DEPLOY] Updating deployment status to BUILDING with job ID: ${buildResult.jobId}`
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
          `[GIT-DEPLOY] Updating deployment status to BUILDING without job ID`
        );
        await updateDeploymentStatus(
          deployment.id,
          "BUILDING",
          "Build started"
        );
      }
    } catch (buildError) {
      console.error(`[GIT-DEPLOY] Build service error:`, buildError);
      console.error(
        `[GIT-DEPLOY] Build service error stack:`,
        buildError instanceof Error ? buildError.stack : "No stack"
      );
      const errorMessage =
        buildError instanceof Error
          ? buildError.message
          : "Unknown build service error";

      console.log(
        `[GIT-DEPLOY] Updating deployment status to FAILED due to build service error`
      );
      await updateDeploymentStatus(
        deployment.id,
        "FAILED",
        "Build service unavailable"
      );
      return createErrorResponse(500, "Failed to start build process");
    }

    console.log(`[GIT-DEPLOY] Returning success response`);
    return createSuccessResponse({ deploymentId: deployment.id });
  } catch (error) {
    console.error(`[GIT-DEPLOY] Upload deployment git error:`, error);
    console.error(
      `[GIT-DEPLOY] Error stack:`,
      error instanceof Error ? error.stack : "No stack"
    );
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    return createErrorResponse(500, errorMessage);
  }
});
