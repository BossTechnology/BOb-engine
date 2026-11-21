-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · P5 Q6 (a) · the member refs the feeder sees, staged in `bob`
--
-- Henry, 2026-11-21: the ghost reconciliation moves to the feeder container
-- («El feeder»), because it asks ClickHouse for member_refs_seen and P5 §5.2
-- keeps BOb off `bzzz-data`. Option (a) of P5 §7 Q6 (F-40): the feeder writes
-- what it sees here, and bob_app creates the ghosts from it, in the BOb
-- container. Q13 (the feeder never creates an actor) stands as written.
--
-- Contract §7.2 and §7.3a, amended (F-41): the reconciliation's window reads
-- this table, not the truth store.
--
-- WHO HOLDS WHAT. The table is a drop box, granted through one helper so the
-- rule is written once:
--   bob_feeder  INSERT only. It cannot read back, change or remove a row: an
--               INSERT grant gives no read, so "the feeder reads its two views
--               and nothing else" (F-21) stands.
--   bob_app     SELECT and DELETE. It consumes the rows and creates the ghosts.
--               No INSERT or UPDATE: a staged ref comes from the truth store
--               through the feeder, or not at all.
--   bob_ai_ro, anon, authenticated, service_role, PUBLIC: nothing.
-- The suite finds such tables by their grants (bob_feeder holds INSERT and no
-- SELECT), not by name, and holds each one to exactly this.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── The grant pattern for a feeder staging table, defined once ─────────────
CREATE FUNCTION public.bob_grant_feeder_staging(tbl regclass)
RETURNS VOID LANGUAGE plpgsql
SET search_path = bob, public AS $$
BEGIN
  EXECUTE format(
    'REVOKE ALL ON %s FROM PUBLIC, anon, authenticated, service_role, '
    'bob_app, bob_feeder, bob_ai_ro', tbl);
  -- The feeder writes, and nothing else.
  EXECUTE format('GRANT INSERT ON %s TO bob_feeder', tbl);
  -- The application reads what was staged, and removes what it consumed.
  EXECUTE format('GRANT SELECT, DELETE ON %s TO bob_app', tbl);
END $$;

COMMENT ON FUNCTION public.bob_grant_feeder_staging(regclass) IS
  'P5 Q6 (a). A table the feeder stages into: INSERT for bob_feeder, SELECT '
  'and DELETE for bob_app, nothing for anyone else. The suite asserts every '
  'table the feeder can insert into but not read holds exactly this.';

REVOKE EXECUTE ON FUNCTION public.bob_grant_feeder_staging(regclass)
  FROM PUBLIC, anon, authenticated;

-- ── The key the staged row uses to name a channel of its own tenant ─────────
-- A ref staged under tenant A's claim must not name tenant B's channel. RLS
-- holds org_id to the claim; this holds channel_id to org_id.
ALTER TABLE bob.channels ADD CONSTRAINT channels_id_org_id_key UNIQUE (id, org_id);

-- ── bob.member_refs_seen ────────────────────────────────────────────────────
-- One row per (channel, ref) per window the feeder asked about. first_seen and
-- last_seen are the ref's first and last event in that window (§7.3a). Only
-- pseudonyms: no correlation_id, no counts, no name.
CREATE TABLE bob.member_refs_seen (
  org_id       UUID        NOT NULL REFERENCES bob.organizations(id) ON DELETE CASCADE,
  channel_id   UUID        NOT NULL,
  ref          TEXT        NOT NULL CHECK (ref <> ''),
  first_seen   TIMESTAMPTZ NOT NULL,
  last_seen    TIMESTAMPTZ NOT NULL,
  window_from  TIMESTAMPTZ NOT NULL,
  window_to    TIMESTAMPTZ NOT NULL,
  staged_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, channel_id, ref, window_from, window_to),
  FOREIGN KEY (channel_id, org_id) REFERENCES bob.channels (id, org_id) ON DELETE CASCADE,
  CHECK (window_to > window_from),
  CHECK (first_seen <= last_seen),
  CHECK (first_seen >= window_from AND last_seen < window_to)
);

CREATE INDEX idx_member_refs_seen_last_seen ON bob.member_refs_seen (org_id, last_seen);

ALTER TABLE bob.member_refs_seen ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_member_refs_seen" ON bob.member_refs_seen FOR ALL
  USING      (org_id = (auth.jwt() ->> 'org_id')::uuid)
  WITH CHECK (org_id = (auth.jwt() ->> 'org_id')::uuid);

COMMENT ON TABLE bob.member_refs_seen IS
  'P5 Q6 (a), contract §7.3a as amended by F-41. The member refs the feeder '
  'saw in the truth store, staged one tenant per transaction under that '
  'tenant''s claim. bob_app reads them, creates the ghosts (§7.2) and deletes '
  'what it consumed. INSERT only for bob_feeder; SELECT and DELETE for bob_app.';

SELECT public.bob_grant_feeder_staging('bob.member_refs_seen');

COMMIT;
