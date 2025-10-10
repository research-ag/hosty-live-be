-- Remove cycles management and add free canister claim tracking
-- Users now manage their own cycles via II wallet

-- Step 1: Remove cycles-related columns
ALTER TABLE public.profiles 
  DROP COLUMN IF EXISTS cycles_balance,
  DROP COLUMN IF EXISTS faucet_used_at;

-- Step 2: Add free canister claim tracking
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS free_canister_claimed_at TIMESTAMPTZ;

-- Step 3: Add index for free canister queries
CREATE INDEX IF NOT EXISTS idx_profiles_free_canister_claimed 
  ON public.profiles(free_canister_claimed_at);

-- Step 4: Add comments
COMMENT ON COLUMN public.profiles.free_canister_claimed_at IS 
  'Timestamp when user claimed their one free canister. NULL if not claimed yet.';

