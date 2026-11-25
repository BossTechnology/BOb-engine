-- What only supabase_admin can grant (measured, 532db30): postgres holds no
-- grant option on schema auth, on auth.users or on auth.jwt(), whose owners
-- are supabase_admin and supabase_auth_admin. Under measurement for O-3.

-- Every tenant policy calls auth.jwt(); creating one needs USAGE on auth.
GRANT USAGE ON SCHEMA auth TO bob_migrador;
-- probe: 20260606120000 puts a trigger on auth.users.
GRANT TRIGGER ON auth.users TO bob_migrador;
