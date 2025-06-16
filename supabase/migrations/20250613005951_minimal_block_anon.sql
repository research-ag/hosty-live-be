-- Minimal anon blocking: Block all schema access for anon role
-- This forces ALL access to go through Edge Functions with SERVICE_ROLE

-- Block access to public schema (our data)
REVOKE USAGE ON SCHEMA public FROM anon;

-- Block access to auth schema (since Edge Functions use SERVICE_ROLE for auth.getUser)
REVOKE USAGE ON SCHEMA auth FROM anon;
