-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · A BzzzBX session takes a viewer seat in the box
--
-- Henry, 26 Nov («Alta sola, como viewer»): whoever holds a live BzzzBX session
-- may enter BOb in the box. The first time, bob-web gives the account a row in
-- bob.users: the box's organization, the role viewer, active. Admin and analyst
-- are still given by hand (scripts/provision-user.mjs). This replaces «no row,
-- 403» for an account with no row; a row that exists keeps its answer.
--
-- bob_app still holds no INSERT on bob.users (20261121130000). This function is
-- the one narrow door, and only bob_app holds EXECUTE on it:
--
--   - the organization is the caller's org_id claim, which bob-web sets from
--     the box's configuration (BOB_ORG_ID), never an argument;
--   - the role is viewer and active is true, never an argument;
--   - the email is stored trimmed and in lower case, as GoTrue keeps it;
--   - the id and the email are the ones GoTrue answered for the session: bob-web
--     asks GoTrue for the user on every request and never reads an unverified
--     token or header;
--   - a row that already exists, by id or by email, in this organization or
--     another, inactive or not, is left exactly as it is (ON CONFLICT DO
--     NOTHING). An inactive account is not reactivated.
--
-- It reads nothing outside bob. Reading auth.users would need a grant on schema
-- auth that bob_migrador does not hold (its footprint is USAGE on auth only,
-- O-3), and the database cannot verify a session anyway: the claim it trusts
-- for the organization is bob_app's to set. So the GoTrue check stays where it
-- already is, in bob-web, on every request.
--
-- Definer, owned by the migration owner (postgres in a local stack,
-- bob_migrador in a box after the hand-over), which owns bob.users and is not
-- subject to its policies; the filter is the claim, read here.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE FUNCTION bob.claim_viewer_seat(p_user UUID, p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = bob, pg_temp
AS $$
DECLARE
  v_org UUID := nullif(auth.jwt() ->> 'org_id', '')::uuid;
  v_email TEXT := nullif(lower(btrim(p_email)), '');
  v_rows INTEGER;
BEGIN
  IF v_org IS NULL OR p_user IS NULL OR v_email IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bob.organizations o WHERE o.id = v_org) THEN
    RETURN false;
  END IF;
  INSERT INTO bob.users (id, org_id, email, role, active)
  VALUES (p_user, v_org, v_email, 'viewer', true)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

COMMENT ON FUNCTION bob.claim_viewer_seat(UUID, TEXT) IS
  'Henry, 26 Nov («Alta sola, como viewer»). A live BzzzBX session''s first '
  'visit: an active viewer row in the caller''s org_id claim, with the id and '
  'email GoTrue answered to bob-web. Never a role or an organization from the '
  'caller; never touches a row that exists. True when it made the row. '
  'EXECUTE: bob_app alone.';

-- Postgres hands EXECUTE on a new function to PUBLIC. Taken back from every
-- role by name, then given to bob_app alone.
REVOKE ALL ON FUNCTION bob.claim_viewer_seat(UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;
GRANT EXECUTE ON FUNCTION bob.claim_viewer_seat(UUID, TEXT) TO bob_app;

COMMENT ON TABLE bob.users IS
  'Who may sign in. A GoTrue account with no row gets one, as an active viewer, '
  'the first time it reaches bob-web in the box (bob.claim_viewer_seat, Henry '
  '26 Nov); a row with active = false gets 403. Admin and analyst rows are made '
  'by scripts/provision-user.mjs. bob_app reads its organization''s rows, stamps '
  'last_login_at, and writes nothing else.';

COMMIT;
