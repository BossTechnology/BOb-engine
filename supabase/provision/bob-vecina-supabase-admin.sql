-- A stand-in, for CI only, for step 3 of Bzzz's alta (#450, 77.22): the one
-- grant postgres cannot make. It holds no grant option on schema auth (owner
-- supabase_admin). Every tenant policy calls auth.jwt(). On a box, #450 does
-- this, and sets bob_migrador's LOGIN and password as supabase_admin;
-- scripts/instalar-bob.sh does the latter here.
GRANT USAGE ON SCHEMA auth TO bob_migrador;
