-- Add git deployment support to deployments table

ALTER TABLE public.deployments 
ADD COLUMN source_git_repo text,
ADD COLUMN source_type text DEFAULT 'zip' CHECK (source_type IN ('zip', 'git')),
ADD COLUMN git_branch text DEFAULT 'main';

-- Update existing deployments to have source_type = 'zip'
UPDATE public.deployments SET source_type = 'zip';

-- Create index for better performance on source_type queries
CREATE INDEX idx_deployments_source_type ON public.deployments(source_type); 