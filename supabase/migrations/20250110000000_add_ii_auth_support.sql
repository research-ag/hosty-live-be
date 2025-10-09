-- Add Internet Identity authentication support
-- This migration allows dual authentication: email/password (existing) + II principal (new)

-- Step 1: Remove FK constraint from profiles to auth.users (if exists)
-- This allows profiles to exist independently of Supabase Auth
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'profiles_id_fkey'
  ) THEN
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;
  END IF;
END $$;

-- Step 2: Add principal column for Internet Identity
-- Nullable to support existing email/password users
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS principal TEXT UNIQUE;

-- Step 3: Add index for fast principal lookups
CREATE INDEX IF NOT EXISTS idx_profiles_principal ON public.profiles(principal);

-- Step 4: Add comment explaining the dual auth model
COMMENT ON COLUMN public.profiles.principal IS 'Internet Identity principal. NULL for email/password users, populated for II users.';
COMMENT ON COLUMN public.profiles.id IS 'Primary key. For email/password users, this matches auth.users.id. For II users, this is auto-generated.';

