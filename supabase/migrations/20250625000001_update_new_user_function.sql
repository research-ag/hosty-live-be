-- Update handle_new_user function to include cycles_balance for new users

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, username, cycles_balance)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'username',
    0
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER; 