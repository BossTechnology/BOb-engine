-- F-46, second half · bob_app reads its organization and writes nothing to it.
--
-- 20260902100300 granted bob_app SELECT, INSERT, UPDATE and DELETE on
-- organizations. Row-level security is on and the only policy that reaches
-- bob_app is `bob_app_reads_own_org` (FOR SELECT, Slice 3), so every INSERT,
-- UPDATE and DELETE it was granted is refused by RLS every time: grants nobody
-- can use, the same shape as F-43 on audit_log. The tenancy guard now
-- discovers organizations (keyed by its own `id`, which every org_id points
-- to) and reports them.
--
-- Revoked rather than given policies: an organization is created and changed
-- by the operator through the service role, never by bob-web, and nothing in
-- this repository writes it as bob_app. Nothing changes in behaviour; the
-- writes were already refused.

REVOKE INSERT, UPDATE, DELETE ON bob.organizations FROM bob_app;
