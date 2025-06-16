-- Block anon role access to all tables and data
-- This forces all access to go through Edge Functions with SERVICE_ROLE

-- Revoke all permissions from anon role on our tables
REVOKE ALL ON public.profiles FROM anon;
REVOKE ALL ON public.canisters FROM anon;
REVOKE ALL ON public.deployments FROM anon;

-- Revoke all permissions on sequences (for auto-increment IDs)
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Revoke all permissions on functions
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- Revoke schema usage (prevents any access to public schema)
REVOKE USAGE ON SCHEMA public FROM anon;

-- Keep only auth schema access for anon (needed for auth functions)
-- This is already granted by default, but let's be explicit
GRANT USAGE ON SCHEMA auth TO anon;

-- Optional: Create a policy that explicitly denies anon access
-- (belt and suspenders approach)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canisters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;

-- Policies that deny all access to anon
CREATE POLICY "Deny anon access to profiles" ON public.profiles
FOR ALL TO anon
USING (false);

CREATE POLICY "Deny anon access to canisters" ON public.canisters
FOR ALL TO anon
USING (false);

CREATE POLICY "Deny anon access to deployments" ON public.deployments
FOR ALL TO anon
USING (false);
