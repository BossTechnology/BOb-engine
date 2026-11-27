-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 5 · Migration 3 of 6 · The breach, one implementation
--
-- Spec: docs/slice-5-thresholds.md §4, §5. Federico's 10 Nov ruling 1: a
-- threshold colours the display whether or not a response is attached. So the
-- breach is read here, from thresholds and cells only, and never from
-- evaluation_state or response_rules; the evaluator calls this same function.
-- A guard reads pg_depend to hold it to that.
--
-- One row per subject (threshold, channel, actor_type) and bucket inside the
-- frame. Only a sealed, observed cell is evaluated (status breach, near or
-- ok); every other cell is not_evaluated, with the reason, because absent is
-- not zero (A-04, O1, D-14).
--
-- Readings of rulings carried over unchanged (D-05), stated in the spec §10:
--   severity  warning, or critical more than 20 % past the bound
--   near      within 20 % inside the bound (proximity 20) or 10 % (10);
--             display only, no alert
--   scope     company and metric reach every channel and actor type; entity
--             names a channel by id; actor names an actor_type
--   peak      'observed' is not evaluated in v1; 'manual' windows are
--             [{"start": "HH:MM", "end": "HH:MM"}] in UTC, and inside one the
--             state moves and nothing is written (the evaluator's part)
--
-- SQL-standard body, invoker, under RLS, in `bob` (Slice 3 §7, F-47).
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE FUNCTION bob.bob_threshold_status(
  p_org      uuid,
  p_channels uuid[],
  p_from     timestamptz,
  p_to       timestamptz
) RETURNS TABLE (
  org_id         uuid,
  threshold_id   uuid,
  subject_key    text,
  channel_id     uuid,
  metric         text,
  actor_type     text,
  bucket_start   timestamptz,
  status         text,
  side           text,
  bound          numeric,
  value          numeric,
  severity       text,
  proximity_pct  integer,
  sealed         boolean,
  in_peak_window boolean,
  reasons        text[]
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = bob, public
BEGIN ATOMIC
  WITH
  t AS (
    SELECT * FROM bob.threshold_configs x WHERE x.org_id = p_org
  ),
  c AS (
    SELECT * FROM bob.bob_cell_state(p_org, p_channels, p_from, p_to)
  ),
  j AS (
    SELECT t.id AS threshold_id, t.upper_bound, t.lower_bound, t.peak_mode, t.peak_windows,
           c.channel_id, c.metric, c.actor_type, c.bucket_start, c.state, c.reasons AS cell_reasons,
           c.value, c.provisional,
           (c.state = 'observed' AND NOT c.provisional) AS evaluable,
           NOT (c.state = 'pending' OR c.provisional) AS sealed,
           (t.peak_mode = 'manual' AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(t.peak_windows) w
               WHERE CASE WHEN (w ->> 'start')::time <= (w ->> 'end')::time
                          THEN (c.bucket_start AT TIME ZONE 'UTC')::time >= (w ->> 'start')::time
                           AND (c.bucket_start AT TIME ZONE 'UTC')::time <  (w ->> 'end')::time
                          ELSE (c.bucket_start AT TIME ZONE 'UTC')::time >= (w ->> 'start')::time
                            OR (c.bucket_start AT TIME ZONE 'UTC')::time <  (w ->> 'end')::time
                     END)) AS in_peak
      FROM t
      JOIN c ON c.metric = t.metric_id
     WHERE CASE t.scope_kind
             WHEN 'entity' THEN t.scope_ref = c.channel_id::text
             WHEN 'actor'  THEN t.scope_ref = c.actor_type
             ELSE true
           END
  ),
  v AS (
    SELECT j.*,
           CASE WHEN j.upper_bound IS NOT NULL AND j.value > j.upper_bound THEN 'upper'
                WHEN j.lower_bound IS NOT NULL AND j.value < j.lower_bound THEN 'lower'
           END AS breach_side,
           CASE WHEN j.upper_bound IS NOT NULL AND j.value <= j.upper_bound
                     AND j.value >= j.upper_bound - 0.2 * abs(j.upper_bound) THEN 'upper'
                WHEN j.lower_bound IS NOT NULL AND j.value >= j.lower_bound
                     AND j.value <= j.lower_bound + 0.2 * abs(j.lower_bound) THEN 'lower'
           END AS near_side
      FROM j
  )
  SELECT p_org, v.threshold_id,
         v.threshold_id::text || ':' || v.channel_id::text || ':' || coalesce(v.actor_type, ''),
         v.channel_id, v.metric, v.actor_type, v.bucket_start,
         CASE WHEN NOT v.evaluable OR v.peak_mode = 'observed' THEN 'not_evaluated'
              WHEN v.breach_side IS NOT NULL THEN 'breach'
              WHEN v.near_side IS NOT NULL THEN 'near'
              ELSE 'ok' END,
         coalesce(v.breach_side, v.near_side),
         CASE coalesce(v.breach_side, v.near_side)
              WHEN 'upper' THEN v.upper_bound WHEN 'lower' THEN v.lower_bound END,
         v.value,
         CASE WHEN NOT v.evaluable OR v.peak_mode = 'observed' OR v.breach_side IS NULL THEN NULL
              WHEN abs(v.value - CASE v.breach_side WHEN 'upper' THEN v.upper_bound
                                                    ELSE v.lower_bound END)
                   > 0.2 * abs(CASE v.breach_side WHEN 'upper' THEN v.upper_bound
                                                  ELSE v.lower_bound END) THEN 'critical'
              ELSE 'warning' END,
         CASE WHEN NOT v.evaluable OR v.peak_mode = 'observed'
                   OR v.breach_side IS NOT NULL OR v.near_side IS NULL THEN NULL
              WHEN abs(v.value - CASE v.near_side WHEN 'upper' THEN v.upper_bound
                                                  ELSE v.lower_bound END)
                   <= 0.1 * abs(CASE v.near_side WHEN 'upper' THEN v.upper_bound
                                                 ELSE v.lower_bound END) THEN 10
              ELSE 20 END,
         v.sealed,
         coalesce(v.in_peak, false),
         CASE WHEN v.peak_mode = 'observed' THEN ARRAY['peak_observed_unsupported']
              WHEN v.evaluable AND v.in_peak THEN ARRAY['suppressed_peak_window']
              WHEN v.evaluable THEN ARRAY[]::text[]
              WHEN v.state = 'pending' OR v.provisional
                THEN array_remove(v.cell_reasons, 'none_observed')
              ELSE ARRAY[v.state] || v.cell_reasons
         END
    FROM v;
END;

COMMENT ON FUNCTION bob.bob_threshold_status(uuid, uuid[], timestamptz, timestamptz) IS
  'Slice 5 spec §5. The one implementation of "is it breaching": thresholds over '
  'bob_cell_state, never evaluation_state or response_rules, so a threshold with '
  'no response still paints red. The evaluator reads it too.';

REVOKE ALL ON FUNCTION bob.bob_threshold_status(uuid, uuid[], timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;
GRANT EXECUTE ON FUNCTION bob.bob_threshold_status(uuid, uuid[], timestamptz, timestamptz)
  TO bob_app, authenticated;

COMMIT;
