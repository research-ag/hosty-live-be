-- Create storage bucket for deployments (only if it doesn't exist)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'deployments',
  'deployments',
  false,
  104857600, -- 100MB in bytes
  ARRAY['application/zip', 'application/x-zip-compressed']
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can upload deployment files" ON storage.objects;
DROP POLICY IF EXISTS "Users can read their deployment files" ON storage.objects;
DROP POLICY IF EXISTS "Service role can manage all deployment files" ON storage.objects;
DROP POLICY IF EXISTS "Service role can manage deployments bucket" ON storage.buckets;

-- Create policy to allow authenticated users to upload to their own deployment folders
CREATE POLICY "Users can upload deployment files" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'deployments' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Create policy to allow authenticated users to read their own deployment files
CREATE POLICY "Users can read their deployment files" ON storage.objects
FOR SELECT USING (
  bucket_id = 'deployments' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Create policy to allow service role to manage all deployment files
CREATE POLICY "Service role can manage all deployment files" ON storage.objects
FOR ALL USING (
  bucket_id = 'deployments' AND
  auth.jwt() ->> 'role' = 'service_role'
);

-- Create policy to allow service role to manage the bucket
CREATE POLICY "Service role can manage deployments bucket" ON storage.buckets
FOR ALL USING (
  id = 'deployments' AND
  auth.jwt() ->> 'role' = 'service_role'
);