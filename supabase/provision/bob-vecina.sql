-- What postgres does on a box once the install chain is applied (D77 §2.8,
-- Henry 2026-11-24: «postgres una vez, luego migrador»). The proposal for Bzzz
-- config/supabase/vecinas/bob.sql, measured by scripts/owner-chain-check.mjs
-- in CI (O-3). Idempotent: on lab-02 the chain and bob already exist.

-- The owner. LOGIN; its password comes from the box's secret, never from here.
-- No membership is granted to anyone: postgres does not need it, because the
-- hand-over of bob is done by supabase_admin (bob-vecina-supabase-admin.sql).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bob_migrador') THEN
    CREATE ROLE bob_migrador LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- bob.proj_ensure_partition is SECURITY DEFINER and, once bob is handed over,
-- runs as bob_migrador. It calls public.bob_grant_projection (PR-4), postgres's,
-- with EXECUTE revoked from PUBLIC. Without this the feeder fails with 42501 on
-- the first new month. It goes when the helper moves into bob.
GRANT EXECUTE ON FUNCTION public.bob_grant_projection(regclass) TO bob_migrador;
