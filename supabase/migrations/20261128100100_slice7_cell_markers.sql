-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 7 · Migration 2 of 3 · D-33, option (a): bob_cell_markers
--
-- Spec: docs/slice-7-drilldowns.md §8. THIS IS THE ONE FILE THAT CHANGES WITH
-- FEDERICO'S RULING on D-33 (Relevo task 19). It is built at option (a), the one
-- proposed on the task, as a default that this file replaces:
--
--   Q1 (a)  rebuilt_at: a quiet marker on a cell whose sealed row was written
--           again after its deadline plus one feeder cycle (T7).
--   Q2 (a)  unvouched: the column and its test exist, switched off for every
--           cell, because no source emits coverage records (D63 is not built).
--
-- If Federico picks (b) or (c), this file is rewritten (it has not shipped) and
-- the columns it no longer returns leave bob_cell_detail and bob_cell_alerts in
-- migration 3; spec §8 has the table.
--
-- One row per cell in the frame, at bob_cell_state's grain. Neither column
-- changes a cell's state: a rebuilt cell is still observed (Slice 3 §10).
--
-- rebuilt_at is the row's computed_at when the row is sealed and
-- computed_at > bucket_start + 5 min + lag_seconds + 5 min. The last 5 minutes
-- are one feeder cycle: the run that first seals a bucket writes it a little
-- after its deadline, and that is not a rebuild. A channel whose lag is NULL
-- never seals (O1), so it never shows the marker.
--
-- F-57. lag_seconds is read as declared now. Raising a channel's lag later
-- moves the deadline, and an old bucket rebuilt inside the new window loses its
-- marker. Storing the seal instant is a projection change for 0.6; it is not
-- proposed here.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE FUNCTION bob.bob_cell_markers(
  p_org      UUID,
  p_channels UUID[],
  p_from     TIMESTAMPTZ,
  p_to       TIMESTAMPTZ
) RETURNS TABLE (
  org_id       UUID,
  channel_id   UUID,
  metric       TEXT,
  actor_type   TEXT,
  bucket_start TIMESTAMPTZ,
  rebuilt_at   TIMESTAMPTZ,
  unvouched    BOOLEAN
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = bob, public
BEGIN ATOMIC
  SELECT c.org_id, c.channel_id, c.metric, c.actor_type, c.bucket_start,
         CASE WHEN p.sealed AND ch.lag_seconds IS NOT NULL
                   AND p.computed_at > c.bucket_start + interval '5 minutes'
                                       + ch.lag_seconds * interval '1 second'
                                       + interval '5 minutes'
              THEN p.computed_at END,
         -- Q2 (a): switched on per source once a source emits coverage records.
         -- None does, so no cell is unvouched.
         false
    FROM bob.bob_cell_state(p_org, p_channels, p_from, p_to) c
    LEFT JOIN bob.bob_cell_provenance(p_org, p_channels, p_from, p_to) p
      ON p.channel_id = c.channel_id AND p.metric = c.metric
     AND p.actor_type IS NOT DISTINCT FROM c.actor_type AND p.bucket_start = c.bucket_start
    LEFT JOIN bob.channels ch ON ch.id = c.channel_id AND ch.org_id = p_org;
END;

COMMENT ON FUNCTION bob.bob_cell_markers(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Slice 7 spec §8, D-33 at option (a). rebuilt_at: the computed_at of a sealed '
  'row written past bucket + 5 min + lag + 5 min (F-57: reads today''s lag). '
  'unvouched: false for every cell until a source emits coverage records. '
  'Replaced whole by D-33''s ruling.';

REVOKE ALL ON FUNCTION bob.bob_cell_markers(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;
GRANT EXECUTE ON FUNCTION bob.bob_cell_markers(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
TO bob_app, authenticated;

COMMIT;
