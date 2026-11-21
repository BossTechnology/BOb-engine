-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · F-43 · bob_app reads the audit trail and writes nothing to it
--
-- audit_log's only policy is org_audit_read, FOR SELECT: the initial schema
-- meant that no user writes or deletes the audit trail. bob_app still held
-- INSERT, UPDATE and DELETE on it from the §10 grants, and RLS refused all
-- three. Ruled by Henry on 21 Nov: revoke them. bob_app keeps SELECT.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON bob.audit_log FROM bob_app;

COMMIT;
