-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · bob.claim_viewer_seat stores the email in lower case
--
-- Review of #59: GoTrue keeps an account's email trimmed and in lower case, and
-- bob.users.email is unique. 20261126100000 trimmed the email it was given and
-- kept its case, so an address that reached it in another case would make a
-- row that does not match the account's, and could take a seat beside a row
-- whose email differs only in case. This stores it as GoTrue does.
--
-- Same function, same signature, same body otherwise. CREATE OR REPLACE keeps
-- its owner, its SECURITY DEFINER, its pinned search_path and its ACL
-- (EXECUTE: bob_app alone); the grants are restated below all the same, so the
-- file says what holds after it.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION bob.claim_viewer_seat(p_user UUID, p_email TEXT)
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
  'email GoTrue answered to bob-web, the email trimmed and in lower case. Never '
  'a role or an organization from the caller; never touches a row that exists. '
  'True when it made the row. EXECUTE: bob_app alone.';

REVOKE ALL ON FUNCTION bob.claim_viewer_seat(UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;
GRANT EXECUTE ON FUNCTION bob.claim_viewer_seat(UUID, TEXT) TO bob_app;

COMMIT;
