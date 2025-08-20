-- Add domain request ID field to canisters table
ALTER TABLE public.canisters 
ADD COLUMN domain_request_id TEXT NULL;

-- Add index for better performance
CREATE INDEX idx_canisters_domain_request_id ON public.canisters(domain_request_id); 