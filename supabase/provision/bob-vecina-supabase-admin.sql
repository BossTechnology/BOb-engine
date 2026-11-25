-- What only supabase_admin can grant: postgres holds no grant option on schema
-- auth (owner supabase_admin), on auth.users (owner supabase_auth_admin) or on
-- auth.jwt() (measured, 532db30). So this part of bob.sql cannot be applied by
-- postgres, as D77 has it; see P5 §6.2.

-- Every tenant policy calls auth.jwt(); creating one needs USAGE on auth.
GRANT USAGE ON SCHEMA auth TO bob_migrador;
