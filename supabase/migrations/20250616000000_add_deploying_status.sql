-- Add DEPLOYING status to deployment_status enum
ALTER TYPE deployment_status ADD VALUE 'DEPLOYING' AFTER 'BUILDING'; 