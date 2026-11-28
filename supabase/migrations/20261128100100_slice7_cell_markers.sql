-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 7 · Migration 2 of 3 · D-33, as Federico ruled it (Relevo task 19, 28 Nov)
--
-- Spec: docs/slice-7-drilldowns.md §8. THIS IS THE ONE FILE THAT CHANGES IF
-- D-33 IS EVER RULED AGAIN. The ruling:
--
--   Q1 (a)  rebuilt_at: a quiet marker on a cell whose sealed row was written
--           again after its deadline plus one feeder cycle (T7). The cell stays
--           `observed`; the six states of F-31 do not change. Federico's extra
--           reason, recorded: a channel with many rebuilt cells has its lag
--           declared too low, and the marker in the matrix is what makes that
--           pattern visible.
--   Q2 (a)  unvouched, with no new switch: "emits coverage records" is a
--           capability in channel_capabilities (`coverage_records`).
--             capability absent                    -> no marker
--             capability present, record present   -> nothing
--             capability present, record absent    -> unvouched
--           Only cells with counts (a projection row) can be unvouched. The
--           coverage record is D63 in BzzzBX and is not built, so no record
--           exists to be found: the rule is written, and until D63 lands every
--           cell of a channel that declares the capability is unvouched. No
--           channel declares it today, so no cell is.
--
-- One row per cell in the frame, at bob_cell_state's grain. Neither column
-- changes a cell's state.
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

-- Q2 (a): the capability. A fourteenth, beside Slice 3's thirteen.
ALTER TABLE bob.channel_capabilities
  DROP CONSTRAINT channel_capabilities_capability_check;
ALTER TABLE bob.channel_capabilities
  ADD CONSTRAINT channel_capabilities_capability_check CHECK (capability IN (
    'orga_conversation', 'meca_rum', 'response_time', 'resolution',
    'coherence', 'hallucination', 'health_latency', 'health_errors',
    'health_uptime', 'health_disconnects',
    'disambiguation', 'escalation', 'queue',
    'coverage_records'));

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
         -- Q2 (a): counts, a channel that emits coverage records, and no record.
         -- The record (D63) is not built, so none can exist: NOT EXISTS is the
         -- whole of that side until it is.
         (p.channel_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM bob.channel_capabilities cc
                       WHERE cc.org_id = p_org AND cc.channel_id = c.channel_id
                         AND cc.capability = 'coverage_records'))
    FROM bob.bob_cell_state(p_org, p_channels, p_from, p_to) c
    LEFT JOIN bob.bob_cell_provenance(p_org, p_channels, p_from, p_to) p
      ON p.channel_id = c.channel_id AND p.metric = c.metric
     AND p.actor_type IS NOT DISTINCT FROM c.actor_type AND p.bucket_start = c.bucket_start
    LEFT JOIN bob.channels ch ON ch.id = c.channel_id AND ch.org_id = p_org;
END;

COMMENT ON FUNCTION bob.bob_cell_markers(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Slice 7 spec §8, D-33 at option (a). rebuilt_at: the computed_at of a sealed '
  'row written past bucket + 5 min + lag + 5 min (F-57: reads today''s lag). '
  'unvouched: counts on a channel that declares coverage_records and no coverage record (D63 not built). '
  'Replaced whole by D-33''s ruling.';

REVOKE ALL ON FUNCTION bob.bob_cell_markers(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;
GRANT EXECUTE ON FUNCTION bob.bob_cell_markers(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
TO bob_app, authenticated;

COMMIT;
