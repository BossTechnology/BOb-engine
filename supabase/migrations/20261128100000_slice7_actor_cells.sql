-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 7 · Migration 1 of 3 · the actor level of the drill-down
--
-- Spec: docs/slice-7-drilldowns.md §2, §3, §4, §7 and §9 (F-56).
--
-- WHAT IS HERE
--   bob_actor_cell_state    recreated: the per-actor zero derived at read time
--                           (§2) and `liveness_source` (§3)
--   bob_actor_unattributed  the remainder between a channel cell and its
--                           actors (§4)
--   bob_cell_provenance     what the projection rows behind a cell say about
--                           themselves (sealed, computed_at, watermark,
--                           feeder_version), read by the bucket (§5), the
--                           alerts (§6) and the markers (§8)
--
-- Nothing here is written by the feeder and nothing here writes. Every function
-- is LANGUAGE sql, BEGIN ATOMIC, STABLE, SECURITY INVOKER, search_path
-- bob, public: tenancy is RLS on what they read plus the explicit org argument,
-- like bob_cell_state (§7). The three migrations of this slice live in `bob`
-- only, so the restore of `bob` alone still works (F-47).
--
-- F-56. bob_actor_cell_state gains a column, so its return type changes and
-- CREATE OR REPLACE cannot do it. It is dropped and recreated with its grants
-- in this one transaction. Nothing in the chain depends on it (checked in
-- pg_depend by the migration itself). A caller that selects * gets one more
-- column; bob-web is outside this repository.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1
               FROM pg_depend d
               JOIN pg_proc p ON p.oid = d.refobjid
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'bob' AND p.proname = 'bob_actor_cell_state'
                AND d.deptype = 'n') THEN
    RAISE EXCEPTION 'F-56: an object depends on bob.bob_actor_cell_state; drop and recreate it by hand';
  END IF;
END $$;

DROP FUNCTION bob.bob_actor_cell_state(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ);

-- ── §2, §3 · bob_actor_cell_state ───────────────────────────────────────────
-- The order inside the function (spec §2), first match wins:
--   not_applicable, not_configured   the channel cell's, unchanged
--   observed                         the actor has a row (liveness 'traffic')
--   observed 0 declared absent       the channel cell's zero (actor_not_present)
--   off_shift                        a human with no live shift at the bucket
--   pending                          the channel cell's
--   observed 0 derived               a human on shift under a channel cell that
--                                    is `observed` from a row (liveness
--                                    'shift'). Skilled on the channel is
--                                    already true of every actor here: `who`
--                                    is the skilled, plus whoever has a row.
--   not_observed                     everything else
-- A derived zero follows `off_shift` and `pending`, so it can only meet a
-- channel cell that is observed; declared-absent zeros have taken theirs
-- already. The shift rule is public.bob_shift_is_live, called, never restated.
CREATE FUNCTION bob.bob_actor_cell_state(
  p_org      UUID,
  p_channels UUID[],
  p_from     TIMESTAMPTZ,
  p_to       TIMESTAMPTZ
) RETURNS TABLE (
  org_id          UUID,
  actor_id        UUID,
  channel_id      UUID,
  metric          TEXT,
  actor_type      TEXT,
  bucket_start    TIMESTAMPTZ,
  state           TEXT,
  reasons         TEXT[],
  value           NUMERIC,
  provisional     BOOLEAN,
  liveness_source TEXT
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = bob, public
BEGIN ATOMIC
  WITH
  rows_ AS (
    SELECT am.actor_id, am.channel_id, am.metric_id AS metric, am.bucket_start,
           sum(am.event_count)::numeric AS value, bool_and(am.sealed) AS sealed
      FROM bob.proj_actor_metrics am
     WHERE am.org_id = p_org AND am.channel_id = ANY (p_channels)
       AND am.bucket_start >= p_from AND am.bucket_start < p_to
     GROUP BY am.actor_id, am.channel_id, am.metric_id, am.bucket_start
  ),
  who AS (
    SELECT s.actor_id, s.channel_id
      FROM bob.actor_channel_skills s
     WHERE s.org_id = p_org AND s.channel_id = ANY (p_channels)
    UNION
    SELECT r.actor_id, r.channel_id FROM rows_ r
  ),
  judged AS (
    SELECT c.org_id AS c_org, c.channel_id AS c_channel, c.metric AS c_metric,
           c.bucket_start AS c_bucket, c.state AS c_state, c.reasons AS c_reasons,
           c.provisional AS c_provisional, c.liveness_source AS c_liveness,
           a.id AS a_id, a.actor_type AS a_type,
           (r.actor_id IS NOT NULL) AS has_row, r.value AS row_value, r.sealed AS row_sealed,
           coalesce(sh.live, false) AS on_shift
      FROM who w
      JOIN bob.actors a ON a.id = w.actor_id AND a.org_id = p_org
      JOIN bob.bob_cell_state(p_org, p_channels, p_from, p_to) c
        ON c.channel_id = w.channel_id AND c.actor_type = a.actor_type
      JOIN bob.cell_catalog k
        ON k.metric = c.metric AND k.source = 'proj_metric_counts' AND NOT k.degenerate
      LEFT JOIN rows_ r
        ON r.actor_id = a.id AND r.channel_id = c.channel_id
       AND r.metric = c.metric AND r.bucket_start = c.bucket_start
      LEFT JOIN LATERAL (
             SELECT bool_or(public.bob_shift_is_live(s.starts_at, s.ends_at, s.status,
                                                     c.bucket_start)) AS live
               FROM bob.actor_shifts s
              WHERE s.org_id = p_org AND s.actor_id = a.id) sh ON true
  ),
  resolved AS (
    SELECT j.*,
           CASE
             WHEN j.c_state IN ('not_applicable', 'not_configured') THEN 'channel'
             WHEN j.has_row THEN 'row'
             WHEN j.c_state = 'observed' AND 'actor_not_present' = ANY (j.c_reasons) THEN 'absent'
             WHEN j.a_type = 'human' AND NOT j.on_shift THEN 'off_shift'
             WHEN j.c_state = 'pending' THEN 'pending'
             WHEN j.a_type = 'human' AND j.on_shift AND j.c_state = 'observed' THEN 'derived'
             ELSE 'not_observed'
           END AS step
      FROM judged j
  )
  SELECT r.c_org, r.a_id, r.c_channel, r.c_metric, r.a_type, r.c_bucket,
         CASE r.step
           WHEN 'channel'  THEN r.c_state
           WHEN 'row'      THEN 'observed'
           WHEN 'absent'   THEN 'observed'
           WHEN 'derived'  THEN 'observed'
           ELSE r.step
         END,
         CASE r.step
           WHEN 'channel'  THEN r.c_reasons
           WHEN 'row'      THEN CASE WHEN r.row_value = 0 THEN ARRAY['none_observed']
                                     ELSE ARRAY[]::text[] END
           WHEN 'absent'   THEN r.c_reasons
           WHEN 'off_shift' THEN ARRAY['not_on_shift']
           WHEN 'pending'  THEN r.c_reasons
           WHEN 'derived'  THEN ARRAY['none_observed']
           ELSE ARRAY['no_actor_row']
         END,
         CASE r.step
           WHEN 'row'      THEN r.row_value
           WHEN 'absent'   THEN 0::numeric
           WHEN 'derived'  THEN 0::numeric
         END,
         CASE r.step
           WHEN 'row'      THEN NOT r.row_sealed
           WHEN 'derived'  THEN r.c_provisional
           ELSE false
         END,
         CASE r.step
           WHEN 'row'      THEN 'traffic'
           WHEN 'absent'   THEN r.c_liveness
           WHEN 'derived'  THEN 'shift'
         END
    FROM resolved r;
END;

COMMENT ON FUNCTION bob.bob_actor_cell_state(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Slice 7 spec §2, §3 (F-56). The per-actor drill-down cells beside bob_cell_state. '
  'A human on shift, skilled on the channel, with no row under a channel cell that '
  'is observed from a row is observed 0, none_observed, liveness_source shift: '
  'derived at read time and never written. off_shift, pending, not_observed and '
  'the declared-absent zero are Slice 3''s. Invoker, under RLS.';

-- ── §4 · bob_actor_unattributed ─────────────────────────────────────────────
-- For each channel cell that is observed from a row and has per-actor metrics:
-- the cell's value minus the sum of its actors' values. No row at 0. Negative
-- (the actors add up to more than the channel) is a feeder defect, shown, never
-- clamped.
CREATE FUNCTION bob.bob_actor_unattributed(
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
  state        TEXT,
  reasons      TEXT[],
  value        NUMERIC,
  provisional  BOOLEAN
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = bob, public
BEGIN ATOMIC
  WITH
  cell AS (
    SELECT c.*
      FROM bob.bob_cell_state(p_org, p_channels, p_from, p_to) c
      JOIN bob.cell_catalog k
        ON k.metric = c.metric AND k.source = 'proj_metric_counts' AND NOT k.degenerate
     WHERE c.state = 'observed' AND c.actor_type IS NOT NULL
       AND NOT ('actor_not_present' = ANY (c.reasons))
  ),
  actors_ AS (
    SELECT am.channel_id, am.actor_type, am.metric_id AS metric, am.bucket_start,
           sum(am.event_count)::numeric AS value
      FROM bob.proj_actor_metrics am
     WHERE am.org_id = p_org AND am.channel_id = ANY (p_channels)
       AND am.bucket_start >= p_from AND am.bucket_start < p_to
     GROUP BY am.channel_id, am.actor_type, am.metric_id, am.bucket_start
  )
  SELECT c.org_id, c.channel_id, c.metric, c.actor_type, c.bucket_start,
         'observed',
         CASE WHEN c.value - coalesce(a.value, 0) > 0 THEN ARRAY['unattributed']
              ELSE ARRAY['actor_sum_exceeds_channel'] END,
         c.value - coalesce(a.value, 0),
         c.provisional
    FROM cell c
    LEFT JOIN actors_ a
      ON a.channel_id = c.channel_id AND a.actor_type = c.actor_type
     AND a.metric = c.metric AND a.bucket_start = c.bucket_start
   WHERE c.value - coalesce(a.value, 0) <> 0;
END;

COMMENT ON FUNCTION bob.bob_actor_unattributed(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Slice 7 spec §4 (T6). The channel cell''s value minus its actors'': '
  'unattributed when positive, actor_sum_exceeds_channel (negative, never '
  'clamped) when the actors add up to more. No row at 0.';

-- ── §5 · bob_cell_provenance ────────────────────────────────────────────────
-- What the projection rows behind a cell say about themselves, at
-- bob_cell_state's grain: sealed is bool_and, computed_at and source_watermark
-- the greatest, feeder_version the one of the latest write (as Slice 3 reads
-- `provisional`). Read from the same five sources as bob_cell_state; a cell
-- with no row has no row here.
CREATE FUNCTION bob.bob_cell_provenance(
  p_org      UUID,
  p_channels UUID[],
  p_from     TIMESTAMPTZ,
  p_to       TIMESTAMPTZ
) RETURNS TABLE (
  org_id           UUID,
  channel_id       UUID,
  metric           TEXT,
  actor_type       TEXT,
  bucket_start     TIMESTAMPTZ,
  sealed           BOOLEAN,
  computed_at      TIMESTAMPTZ,
  source_watermark TIMESTAMPTZ,
  feeder_version   TEXT
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = bob, public
BEGIN ATOMIC
  WITH facts AS (
    SELECT m.channel_id, m.metric_id AS metric, m.actor_type, m.bucket_start,
           m.sealed, m.computed_at, m.source_watermark, m.feeder_version
      FROM bob.proj_metric_counts m
     WHERE m.org_id = p_org AND m.channel_id = ANY (p_channels)
       AND m.bucket_start >= p_from AND m.bucket_start < p_to
    UNION ALL
    SELECT d.channel_id, d.measure, d.actor_type, d.bucket_start,
           d.sealed, d.computed_at, d.source_watermark, d.feeder_version
      FROM bob.proj_durations d
     WHERE d.org_id = p_org AND d.channel_id = ANY (p_channels)
       AND d.bucket_start >= p_from AND d.bucket_start < p_to
    UNION ALL
    SELECT s.channel_id, s.source, NULL::text, s.bucket_start,
           s.sealed, s.computed_at, s.source_watermark, s.feeder_version
      FROM bob.proj_sentiment s
     WHERE s.org_id = p_org AND s.channel_id = ANY (p_channels)
       AND s.bucket_start >= p_from AND s.bucket_start < p_to
    UNION ALL
    SELECT r.channel_id, 'meca', NULL::text, r.bucket_start,
           r.sealed, r.computed_at, r.source_watermark, r.feeder_version
      FROM bob.proj_rum_signals r
     WHERE r.org_id = p_org AND r.channel_id = ANY (p_channels)
       AND r.bucket_start >= p_from AND r.bucket_start < p_to
    UNION ALL
    SELECT h.channel_id, v.metric, NULL::text, h.bucket_start,
           h.sealed, h.computed_at, h.source_watermark, h.feeder_version
      FROM bob.proj_channel_health h
     CROSS JOIN LATERAL (VALUES
             ('health_latency',     h.latency_n),
             ('health_errors',      h.error_n),
             ('health_uptime',      h.uptime_seconds),
             ('health_disconnects', h.disconnects::bigint)) v(metric, value)
     WHERE h.org_id = p_org AND h.channel_id = ANY (p_channels)
       AND h.bucket_start >= p_from AND h.bucket_start < p_to
       AND v.value IS NOT NULL
  )
  SELECT p_org, f.channel_id, f.metric, f.actor_type, f.bucket_start,
         bool_and(f.sealed), max(f.computed_at), max(f.source_watermark),
         (array_agg(f.feeder_version ORDER BY f.computed_at DESC))[1]
    FROM facts f
   GROUP BY f.channel_id, f.metric, f.actor_type, f.bucket_start;
END;

COMMENT ON FUNCTION bob.bob_cell_provenance(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Slice 7 spec §5. Provenance of the cell''s projection rows (contract §4): '
  'sealed (bool_and), computed_at and source_watermark (greatest), feeder_version '
  '(of the latest write). No row for a cell with none.';

-- ── Who executes what (§7) ──────────────────────────────────────────────────
REVOKE ALL ON FUNCTION
  bob.bob_actor_cell_state(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ),
  bob.bob_actor_unattributed(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ),
  bob.bob_cell_provenance(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;

GRANT EXECUTE ON FUNCTION
  bob.bob_actor_cell_state(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ),
  bob.bob_actor_unattributed(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ),
  bob.bob_cell_provenance(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
TO bob_app, authenticated;

COMMIT;
