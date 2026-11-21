-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · F-47 · the outbox drain is bob_app's alone
--
-- 20261121100200 revoked EXECUTE on public.bob_outbox_drain(integer) from
-- PUBLIC, anon and authenticated, and granted it to bob_app. Supabase's
-- default privileges in `public` also give EXECUTE to service_role, and that
-- grant stayed. The drain runs under the caller's claim and RLS, but
-- service_role bypasses RLS, so a holder of the service role could drain every
-- organization's queued intentions at once. No running component holds the
-- service role (P5 §3.4); this takes the grant away so the rule does not rest
-- on that alone.
--
-- Found by the P5 lab-02 rehearsal kit, run on main on 2026-11-21: its
-- fingerprint of `public` lists the function's ACL.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

REVOKE EXECUTE ON FUNCTION public.bob_outbox_drain(integer) FROM service_role;

COMMIT;
