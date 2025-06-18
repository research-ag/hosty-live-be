// Shared types for the deployment system

export type DeploymentStatus =
  | "PENDING"
  | "BUILDING"
  | "DEPLOYING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED";

export interface DeploymentRecord {
  id: string;
  user_id: string;
  canister_id: string;
  status: DeploymentStatus;
  status_reason?: string;
  build_command?: string;
  output_dir?: string;
  source_zip_url?: string;
  built_assets_url?: string;
  build_service_job_id?: string;
  build_logs?: string;
  duration_ms?: number;
  deployed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CanisterRecord {
  id: string;
  user_id: string;
  ic_canister_id: string;
  deleted: boolean;
  deleted_at?: string;
  created_at: string;
  updated_at: string;
}

export interface BuildServiceRequest {
  deploymentId: string;
  sourceZipUrl: string;
  buildCommand: string;
  outputDir: string;
  webhookUrl: string;
}

export interface WebhookPayload {
  deploymentId: string;
  status: DeploymentStatus;
  statusReason?: string;
  builtAssetsUrl?: string;
  buildLogs?: string;
  duration?: number;
}

// Utility function to validate deployment status transitions
export function isValidStatusTransition(
  from: DeploymentStatus,
  to: DeploymentStatus
): boolean {
  const validTransitions: Record<DeploymentStatus, DeploymentStatus[]> = {
    PENDING: ["BUILDING", "CANCELLED", "FAILED"],
    BUILDING: ["DEPLOYING", "FAILED", "CANCELLED"],
    DEPLOYING: ["SUCCESS", "FAILED", "CANCELLED"],
    SUCCESS: [], // Terminal state
    FAILED: ["PENDING"], // Can retry
    CANCELLED: ["PENDING"], // Can restart
  };

  return validTransitions[from]?.includes(to) ?? false;
}
