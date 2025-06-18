-- Add deployment system fields to existing deployments table

-- Add new columns for deployment tracking
ALTER TABLE public.deployments ADD COLUMN source_zip_url TEXT;
ALTER TABLE public.deployments ADD COLUMN built_assets_url TEXT;
ALTER TABLE public.deployments ADD COLUMN build_service_job_id TEXT;
ALTER TABLE public.deployments ADD COLUMN build_logs TEXT;
ALTER TABLE public.deployments ADD COLUMN deployed_at TIMESTAMPTZ;

-- Add index for build service job tracking
CREATE INDEX idx_deployments_build_service_job_id ON public.deployments(build_service_job_id);

-- Add index for deployed_at for performance
CREATE INDEX idx_deployments_deployed_at ON public.deployments(deployed_at);

-- Update the trigger to handle the new updated_at field
-- (The trigger already exists, so this ensures it works with new columns) 