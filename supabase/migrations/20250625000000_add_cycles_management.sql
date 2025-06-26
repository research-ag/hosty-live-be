-- Add cycles management to profiles table

-- Add cycles_balance column to profiles table
ALTER TABLE public.profiles 
ADD COLUMN cycles_balance BIGINT NOT NULL DEFAULT 0;

-- Add index for better performance on cycles balance queries
CREATE INDEX idx_profiles_cycles_balance ON public.profiles(cycles_balance); 