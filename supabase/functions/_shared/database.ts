import { createClient } from "jsr:@supabase/supabase-js@2";
import { DeploymentRecord, DeploymentStatus, CanisterRecord } from "./types.ts";
import { getUserFromRequest as getAuthUser } from "./auth.ts";

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

// Helper function to transform deployment data to replace internal canister_id with ic_canister_id
function transformDeploymentData(deployment: any): any {
  if (!deployment) return null;
  
  // If deployment has canister data from join, use it
  if (deployment.canister && deployment.canister.ic_canister_id) {
    return {
      ...deployment,
      canister_id: deployment.canister.ic_canister_id, // Replace internal ID with IC canister ID
      canister: undefined // Remove the nested canister object
    };
  }
  
  return deployment;
}

export async function getDeployment(
  deploymentId: string
): Promise<DeploymentRecord | null> {
  const { data, error } = await supabase
    .from("deployments")
    .select(`
      *,
      canister:canisters!inner(ic_canister_id)
    `)
    .eq("id", deploymentId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // Not found
    throw new Error(`Failed to get deployment: ${error.message}`);
  }

  return transformDeploymentData(data);
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
    deployment: transformDeploymentData(data),
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
    .select(`
      *,
      canister:canisters!inner(ic_canister_id)
    `)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to get user deployments: ${error.message}`);
  }

  // Transform all deployments to use IC canister IDs
  return (data || []).map(transformDeploymentData);
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

// Utility functions - re-export from auth.ts
export async function getUserFromRequest(
  request: Request
): Promise<{ id: string; principal?: string } | null> {
  return await getAuthUser(request);
}

// Profile operations
export async function getUserProfile(userId: string) {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, username, principal, free_canister_claimed_at, created_at, updated_at")
    .eq("id", userId)
    .single();

  if (error) {
    throw new Error(`Failed to fetch profile: ${error.message}`);
  }

  return profile;
}

export async function updateUserProfile(userId: string, updates: { username?: string }) {
  const { data: profile, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId)
    .select("id, username, principal, free_canister_claimed_at, created_at, updated_at")
    .single();

  if (error) {
    throw new Error(`Failed to update profile: ${error.message}`);
  }

  return profile;
}

// Free canister operations
export async function checkFreeCanisterEligibility(userId: string) {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("free_canister_claimed_at")
    .eq("id", userId)
    .single();

  if (error) {
    throw new Error(`Failed to fetch profile: ${error.message}`);
  }

  return {
    canClaim: !profile.free_canister_claimed_at,
    claimedAt: profile.free_canister_claimed_at,
  };
}
