import { createClient } from "jsr:@supabase/supabase-js@2";
import { DeploymentRecord, DeploymentStatus, CanisterRecord } from "./types.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Deployment operations
export async function createDeployment(
  userId: string,
  canisterId: string,
  buildCommand: string = "npm run build",
  outputDir: string = "dist"
): Promise<DeploymentRecord> {
  const { data, error } = await supabase
    .from("deployments")
    .insert({
      user_id: userId,
      canister_id: canisterId,
      status: "PENDING",
      build_command: buildCommand,
      output_dir: outputDir,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create deployment: ${error.message}`);
  }

  return data;
}

export async function updateDeploymentStatus(
  deploymentId: string,
  status: DeploymentStatus,
  statusReason?: string,
  additionalFields?: Partial<DeploymentRecord>
): Promise<DeploymentRecord> {
  const updateData: any = {
    status,
    status_reason: statusReason,
    ...additionalFields,
  };

  const { data, error } = await supabase
    .from("deployments")
    .update(updateData)
    .eq("id", deploymentId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update deployment status: ${error.message}`);
  }

  return data;
}

export async function getDeployment(
  deploymentId: string
): Promise<DeploymentRecord | null> {
  const { data, error } = await supabase
    .from("deployments")
    .select("*")
    .eq("id", deploymentId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // Not found
    throw new Error(`Failed to get deployment: ${error.message}`);
  }

  return data;
}

export async function getDeploymentWithCanister(deploymentId: string): Promise<{
  deployment: DeploymentRecord;
  canister: CanisterRecord;
} | null> {
  const { data, error } = await supabase
    .from("deployments")
    .select(
      `
      *,
      canister:canisters(*)
    `
    )
    .eq("id", deploymentId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // Not found
    throw new Error(`Failed to get deployment with canister: ${error.message}`);
  }

  return {
    deployment: data,
    canister: data.canister,
  };
}

export async function getUserDeployments(
  userId: string,
  limit: number = 50,
  offset: number = 0
): Promise<DeploymentRecord[]> {
  const { data, error } = await supabase
    .from("deployments")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to get user deployments: ${error.message}`);
  }

  return data || [];
}

// Canister operations
export async function getCanisterById(
  canisterId: string
): Promise<CanisterRecord | null> {
  const { data, error } = await supabase
    .from("canisters")
    .select("*")
    .eq("id", canisterId)
    .eq("deleted", false)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // Not found
    throw new Error(`Failed to get canister: ${error.message}`);
  }

  return data;
}

export async function verifyCanisterOwnership(
  canisterId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("canisters")
    .select("id")
    .eq("id", canisterId)
    .eq("user_id", userId)
    .eq("deleted", false)
    .single();

  if (error) {
    return false;
  }

  return !!data;
}

// Utility functions
export async function getUserFromRequest(
  request: Request
): Promise<{ id: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;

  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) return null;
  return { id: user.id };
}
