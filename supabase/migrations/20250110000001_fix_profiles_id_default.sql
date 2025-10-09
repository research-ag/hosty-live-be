-- Fix profiles.id to have default UUID generation
-- This ensures II users can be created without specifying an id

-- Add default UUID generation to id column if not already set
ALTER TABLE public.profiles 
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Add comment explaining the change
COMMENT ON COLUMN public.profiles.id IS 'Primary key with auto-generated UUID. For email/password users, this can match auth.users.id. For II users, this is auto-generated.';

