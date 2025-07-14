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
  const gitUrlRegex = /^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([\/\w .-]*)*\/?$/;
  return gitUrlRegex.test(url) && (url.includes('github.com') || url.includes('gitlab.com') || url.includes('bitbucket.org') || url.includes('.git'));
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return createErrorResponse(405, "Method not allowed");
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return createErrorResponse(401, "Unauthorized");
    }

    const body = await req.json();
    const { gitRepoUrl, canisterId, buildCommand = "npm run build", outputDir = "dist", branch = "main" } = body;

    if (!gitRepoUrl || !canisterId) {
      return createErrorResponse(
        400,
        "Missing required fields: gitRepoUrl and canisterId"
      );
    }

    if (!validateGitUrl(gitRepoUrl)) {
      return createErrorResponse(400, "Invalid git repository URL");
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

    const externalWebhookUrl = `${externalSupabaseUrl}/functions/v1/deployment-webhook`;

    await updateDeploymentStatus(deployment.id, "PENDING", undefined, {
      source_git_repo: gitRepoUrl,
      source_type: "git",
      git_branch: branch,
    });

    const buildRequest: GitBuildServiceRequest = {
      deploymentId: deployment.id,
      gitRepoUrl,
      buildCommand,
      outputDir,
      webhookUrl: externalWebhookUrl,
      branch,
    };

    try {
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
    console.error("Upload deployment git error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    return createErrorResponse(500, errorMessage);
  }
}); 