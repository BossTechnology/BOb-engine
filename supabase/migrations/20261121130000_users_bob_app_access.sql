-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Who may sign in to a box
--
-- bob-web answers 403 to a GoTrue account with no row in bob.users, or with
-- active = false (Henry, 21 Nov: "no row, 403"). Two things stood in the way.
--
-- 1. bob_app, the role bob-web runs as in a box, held table grants on
--    bob.users and no policy reached it, so every read came back empty and
--    nobody could sign in (Bob-New PR #30, P-1). It now reads its own
--    organization's users, by the claim, and stamps last_login_at. It does
--    not create a user, delete one, or change a role, `active`, an email or
--    an organization: those are the operator's (scripts/provision-user.mjs).
--
-- 2. on_auth_user_created copied org_id, role and full_name from a new GoTrue
--    account's raw_user_meta_data into bob.users. That metadata is the signer's
--    to write, so whoever could sign up could pick an organization and the role
--    `admin`, and "no row, 403" would never fire. Ruled by Henry on 21 Nov: the
--    trigger goes. A row is made only by the provisioning script, run with the
--    migration owner's credential. Accounts and rows that exist are untouched.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 2. Signing up no longer creates a row ───────────────────────────────────
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_auth_user();

-- ── 1. bob_app reads its organization's users and stamps a login ────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON bob.users FROM bob_app;
GRANT SELECT ON bob.users TO bob_app;
GRANT UPDATE (last_login_at) ON bob.users TO bob_app;

CREATE POLICY "app_reads_org_users" ON bob.users
  FOR SELECT TO bob_app
  USING (org_id = (auth.jwt() ->> 'org_id')::uuid);

CREATE POLICY "app_stamps_org_login" ON bob.users
  FOR UPDATE TO bob_app
  USING      (org_id = (auth.jwt() ->> 'org_id')::uuid)
  WITH CHECK (org_id = (auth.jwt() ->> 'org_id')::uuid);

COMMENT ON TABLE bob.users IS
  'Who may sign in. A GoTrue account with no row here, or with active = false, '
  'gets 403 from bob-web. Rows are made by scripts/provision-user.mjs, never by '
  'signing up. bob_app reads its organization''s rows and stamps last_login_at.';

COMMIT;
