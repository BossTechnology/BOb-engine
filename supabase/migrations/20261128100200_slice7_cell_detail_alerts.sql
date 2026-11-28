-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 7 · Migration 3 of 3 · the bucket and the alerts of a cell
--
-- Spec: docs/slice-7-drilldowns.md §5, §6, §7.
--
-- bob_cell_detail reads the cell as bob_cell_state does, its provenance from
-- bob_cell_provenance and the two D-33 columns from bob_cell_markers. It comes
-- after the markers in the chain (spec §12 put it first): a SQL-standard body
-- is bound when the function is created, so what it calls has to exist. The
-- D-33 columns are the last two of bob_cell_detail and the last of
-- bob_cell_alerts; spec §8 says what leaves under (b) or (c).
--
-- bob_cell_alerts depends on Slice 5: it reads the columns Slice 5 adds to
-- alert_log (channel_id, actor_type, bucket_start, threshold_id, subject_key,
-- escalates_alert_id). alert_log.value is never rewritten (D-12): the figure at
-- firing and the figure now differ exactly when the bucket was rebuilt.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE FUNCTION bob.bob_cell_detail(
  p_org        UUID,
  p_channel    UUID,
  p_metric     TEXT,
  p_actor_type TEXT,
  p_bucket     TIMESTAMPTZ
) RETURNS TABLE (
  org_id           UUID,
  channel_id       UUID,
  metric           TEXT,
  actor_type       TEXT,
  bucket_start     TIMESTAMPTZ,
  state            TEXT,
  reasons          TEXT[],
  value            NUMERIC,
  provisional      BOOLEAN,
  liveness_source  TEXT,
  sealed           BOOLEAN,
  computed_at      TIMESTAMPTZ,
  source_watermark TIMESTAMPTZ,
  feeder_version   TEXT,
  lag_seconds      INTEGER,
  affected_frame   JSONB,
  rebuilt_at       TIMESTAMPTZ,
  unvouched        BOOLEAN
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = bob, public
BEGIN ATOMIC
  SELECT c.org_id, c.channel_id, c.metric, c.actor_type, c.bucket_start,
         c.state, c.reasons, c.value, c.provisional, c.liveness_source,
         p.sealed, p.computed_at, p.source_watermark, p.feeder_version,
         ch.lag_seconds,
         -- The frame and filter affected_members (contract §7.3) takes, in the
         -- cell's language. It carries no event_name: one definition, two
         -- consumers. The database does not call it (3.7 is BzzzBX's).
         jsonb_build_object(
           'tenant_slug', o.slug,
           'source_key',  ch.source_key,
           'from',        c.bucket_start,
           'to',          c.bucket_start + interval '5 minutes',
           'metric_id',   c.metric,
           'actor_type',  c.actor_type),
         m.rebuilt_at, m.unvouched
    FROM bob.bob_cell_state(p_org, ARRAY[p_channel], p_bucket,
                            p_bucket + interval '5 minutes') c
    LEFT JOIN bob.bob_cell_provenance(p_org, ARRAY[p_channel], p_bucket,
                                      p_bucket + interval '5 minutes') p
      ON p.channel_id = c.channel_id AND p.metric = c.metric
     AND p.actor_type IS NOT DISTINCT FROM c.actor_type AND p.bucket_start = c.bucket_start
    LEFT JOIN bob.bob_cell_markers(p_org, ARRAY[p_channel], p_bucket,
                                   p_bucket + interval '5 minutes') m
      ON m.channel_id = c.channel_id AND m.metric = c.metric
     AND m.actor_type IS NOT DISTINCT FROM c.actor_type AND m.bucket_start = c.bucket_start
    LEFT JOIN bob.channels ch ON ch.id = c.channel_id AND ch.org_id = p_org
    LEFT JOIN bob.organizations o ON o.id = p_org
   WHERE c.metric = p_metric
     AND c.actor_type IS NOT DISTINCT FROM p_actor_type
     AND c.bucket_start = p_bucket;
END;

COMMENT ON FUNCTION bob.bob_cell_detail(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) IS
  'Slice 7 spec §5. One cell: bob_cell_state''s state, reasons, value, provisional '
  'and liveness_source; the projection row''s provenance (NULL with no row); the '
  'channel''s lag as declared now (NULL renders "lag not declared"); the frame '
  'and filter for affected_members, without an event_name; and the D-33 '
  'markers. Invoker, under RLS.';

CREATE FUNCTION bob.bob_cell_alerts(
  p_org        UUID,
  p_channels   UUID[],
  p_metric     TEXT,
  p_actor_type TEXT,
  p_from       TIMESTAMPTZ,
  p_to         TIMESTAMPTZ
) RETURNS TABLE (
  alert_id             UUID,
  alert_type           TEXT,
  severity             TEXT,
  created_at           TIMESTAMPTZ,
  escalates_alert_id   UUID,
  channel_id           UUID,
  actor_type           TEXT,
  bucket_start         TIMESTAMPTZ,
  threshold_id         UUID,
  subject_key          TEXT,
  value_at_firing      NUMERIC,
  value_now            NUMERIC,
  bound                NUMERIC,
  rebuilt_after_firing BOOLEAN
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = bob, public
BEGIN ATOMIC
  SELECT a.id, a.alert_type, a.severity, a.created_at, a.escalates_alert_id,
         a.channel_id, a.actor_type, a.bucket_start, a.threshold_id, a.subject_key,
         a.value, c.value, a.threshold,
         -- D-33 Q1 (a): exact, needs no grace and no lag.
         coalesce(p.computed_at > a.created_at, false)
    FROM bob.alert_log a
    LEFT JOIN bob.bob_cell_state(p_org, p_channels, p_from, p_to) c
      ON c.channel_id = a.channel_id AND c.metric = p_metric
     AND c.actor_type IS NOT DISTINCT FROM a.actor_type AND c.bucket_start = a.bucket_start
    LEFT JOIN bob.bob_cell_provenance(p_org, p_channels, p_from, p_to) p
      ON p.channel_id = a.channel_id AND p.metric = p_metric
     AND p.actor_type IS NOT DISTINCT FROM a.actor_type AND p.bucket_start = a.bucket_start
   WHERE a.org_id = p_org AND a.channel_id = ANY (p_channels)
     AND a.metric_id = p_metric
     AND a.actor_type IS NOT DISTINCT FROM p_actor_type
     AND a.bucket_start >= p_from AND a.bucket_start < p_to;
END;

COMMENT ON FUNCTION bob.bob_cell_alerts(UUID, UUID[], TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Slice 7 spec §6. One row per alert_log row of the cells in the frame: the '
  'figure at firing (alert_log.value, never rewritten) beside the figure the '
  'cell shows now, and whether the bucket was rebuilt after the alert fired. '
  'The cell''s colour is bob_threshold_status''s, never from here.';

REVOKE ALL ON FUNCTION
  bob.bob_cell_detail(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ),
  bob.bob_cell_alerts(UUID, UUID[], TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;
GRANT EXECUTE ON FUNCTION
  bob.bob_cell_detail(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ),
  bob.bob_cell_alerts(UUID, UUID[], TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
TO bob_app, authenticated;

COMMIT;
