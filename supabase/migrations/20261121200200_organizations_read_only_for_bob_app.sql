-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · F-46 · bob_app reads its own organization and writes none
--
-- Slice 3 gives bob_app a SELECT policy on bob.organizations keyed by id
-- (bob_app_reads_own_org). The Slice 1 grants (20260902100300) also gave it
-- INSERT, UPDATE and DELETE there. No policy lets any of them through for
-- bob_app, but nothing in the application creates or changes an organization:
-- that is the operator's, at provisioning. Review of PR #40 (M-5): revoke
-- them, so the grant says what the policies already mean. bob_app keeps SELECT.
-- TRUNCATE went with F-44 (20261121170000); revoking it again is a no-op.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON bob.organizations FROM bob_app;

COMMIT;
