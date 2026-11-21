-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · F-43, second half · members read the audit trail and write nothing
--
-- After 20261121150000, `authenticated` (PostgREST's role, a signed-in member)
-- still held INSERT, UPDATE, DELETE and TRUNCATE on bob.audit_log from
-- Supabase's default grants. Its only policy is FOR SELECT, so RLS refused
-- every write; TRUNCATE does not go through RLS at all. Ruled by Henry on
-- 21 Nov: revoke. `authenticated` keeps SELECT, under org_audit_read.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON bob.audit_log FROM authenticated;

COMMIT;
