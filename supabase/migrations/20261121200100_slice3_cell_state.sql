-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 3 · Migration 2 of 2
-- The cell: one implementation of the absent-not-zero state, in the database.
--
-- Spec: docs/slice-3-absent-not-zero.md §2, §3, §6, §7 and §11 (R3 to R7).
-- Proposed for 0.6 as F-30, F-31 and F-32; not signed yet.
--
-- WHAT IS HERE
--   bob_cell_state(org, channels[], from, to)   §3, resolved in SQL (R4)
--   bob_cell_rollup(org, channels[], from, to)  §6, over bob_cell_state (F-30)
--   bob_available_state(org, channels[], …)     §4, Available's translation of
--                                               FR-23's reasons (G9, R7)
--   bob_actor_cell_state(org, channels[], …)    the per-actor drill-down cells,
--                                               where off_shift lives (§2)
--   bob_ai_cell_state()  + bob.v_ai_cell_state  BObee's face (R6)
--
-- SQL-STANDARD BODIES. Every function is LANGUAGE sql with BEGIN ATOMIC … END
-- (§7). Such a body is parsed when the function is created and its references
-- are recorded in pg_depend, the way a view's are. A quoted-string or plpgsql
-- body records none, and the single-implementation guards (§8) would have
-- nothing to read. CI runs Postgres 15 and the boxes 17.6 (F-37); both have it.
--
-- ONE ORDER. The resolution order of §3 is written once, in bob_cell_state.
-- The rollup, the per-actor cells and BObee's face read it; none restates it.
--
-- IN `bob`. Every function here reads `bob`, so it lives in `bob` (Henry, on
-- PR #40: "Both in bob"). The P5 restore drops `bob` with CASCADE and restores
-- `pg_dump -n bob` alone (docs/p5-failed-migration-procedure.md §4.3): a
-- function outside `bob` that reads `bob` would go with the CASCADE, be missing
-- from the dump, and leave bob.v_ai_cell_state impossible to restore (F-47).
-- They call three helpers in public that read nothing in `bob` at creation
-- (bob_source_key_unset, bob_shift_is_live, and bob_availability, a plpgsql
-- body), which survive the CASCADE. scripts/box-checks.mjs's
-- restoreCycleFindings guards it, read from pg_depend.
--
-- PRIVILEGES. bob_cell_state and the functions beside it run as their caller,
-- under RLS (R4), and also filter on the org they are given. bob_app and
-- authenticated execute them. bob_ai_ro executes none of them: it reads
-- bob.v_ai_cell_state, whose function is a definer, owned by the migration
-- owner, and filters on the caller's org_id claim itself (R6, the shape of
-- F-21). Functions in a view run as the view's reader, so the definer is the
-- function, and the view is the face.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── F-46 · bob_app reads its own organization ───────────────────────────────
-- bob_cell_state runs as its caller and reads organizations.telemetry_started_at
-- (D-14, D-18). bob_app has held SELECT on bob.organizations since Slice 1, but
-- the only tenant policy there is for `authenticated`, so bob_app read its own
-- organization as empty: every cell would have lost telemetry_not_started and
-- come back with no rows at all. The same policy as authenticated's, for
-- bob_app, read only. The tenancy guard did not see it because organizations
-- is keyed by `id`, not `org_id` (finding F-46).
CREATE POLICY "bob_app_reads_own_org" ON bob.organizations FOR SELECT TO bob_app
  USING (id = (auth.jwt() ->> 'org_id')::uuid);

-- ── §3 · bob_cell_state ─────────────────────────────────────────────────────
-- One row per (org_id, channel_id, metric, actor_type, bucket_start) inside the
-- frame [p_from, p_to), for every channel of p_channels the caller can see and
-- every metric of the catalog that has a bucketed source. Channel figures
-- (sentiment, health) carry actor_type NULL.
--
-- The order, first match wins:
--   1 not_applicable   the pair (metric, actor_type) is not in the catalog
--   2 not_configured   every missing declaration, in the order of §3 step 2
--   3 observed 0       the mix declares the actor absent (actor_not_present)
--   4 pending          no row, and the bucket is not sealed by the current lag
--   5 not_observed     no row (no_liveness)
--   6 observed         a row; provisional when its stored sealed is false
--
-- Sealing of a cell with no row (R3). Nothing is stored for it, so it is
-- computed from the channel's lag today and the tenant's watermark: the latest
-- source_watermark the feeder wrote for the tenant. With no watermark, nothing
-- is known to be sealed. A row's own `sealed` is never recomputed (§4).
--
-- Liveness of an observed row (F-28). 'probe' when the bucket has an observed
-- proj_channel_health row and no row shows traffic; otherwise 'traffic'. The
-- feeder writes a zero only with liveness, so a row with neither is traffic.
CREATE FUNCTION bob.bob_cell_state(
  p_org      UUID,
  p_channels UUID[],
  p_from     TIMESTAMPTZ,
  p_to       TIMESTAMPTZ
) RETURNS TABLE (
  org_id          UUID,
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
  org AS (
    SELECT o.id, o.telemetry_started_at
      FROM bob.organizations o
     WHERE o.id = p_org
  ),
  ch AS (
    SELECT c.id, c.org_id, c.lag_seconds, c.idle_bound_seconds,
           public.bob_source_key_unset(c.source_key) AS key_unset
      FROM bob.channels c
     WHERE c.org_id = p_org AND c.id = ANY (p_channels)
  ),
  -- The five-minute buckets that start inside [p_from, p_to).
  buckets AS (
    SELECT g AS bucket_start
      FROM generate_series(
             date_bin('5 minutes', p_from + interval '5 minutes' - interval '1 microsecond',
                      TIMESTAMPTZ '1970-01-01 00:00:00+00'),
             p_to - interval '1 microsecond',
             interval '5 minutes') g
  ),
  cat AS (
    SELECT k.*
      FROM bob.cell_catalog k
     WHERE k.source IN ('proj_metric_counts', 'proj_durations', 'proj_sentiment',
                        'proj_channel_health', 'none')
  ),
  -- What the feeder wrote, one line per (channel, metric, actor, bucket), from
  -- each source the catalog names. `traffic` is evidence of an interaction.
  facts AS (
    SELECT m.channel_id, m.metric_id AS metric, m.actor_type, m.bucket_start,
           m.event_count::numeric AS value, m.sealed,
           (m.event_count > 0 OR m.session_count > 0) AS traffic
      FROM bob.proj_metric_counts m
     WHERE m.org_id = p_org AND m.channel_id = ANY (p_channels)
       AND m.bucket_start >= p_from AND m.bucket_start < p_to
    UNION ALL
    SELECT d.channel_id, d.measure, d.actor_type, d.bucket_start,
           d.n::numeric, d.sealed, d.n > 0
      FROM bob.proj_durations d
     WHERE d.org_id = p_org AND d.channel_id = ANY (p_channels)
       AND d.bucket_start >= p_from AND d.bucket_start < p_to
    UNION ALL
    SELECT s.channel_id, s.source, NULL::text, s.bucket_start,
           s.reading_count::numeric, s.sealed,
           (s.reading_count > 0 OR s.closing_count > 0)
      FROM bob.proj_sentiment s
     WHERE s.org_id = p_org AND s.channel_id = ANY (p_channels)
       AND s.bucket_start >= p_from AND s.bucket_start < p_to
    UNION ALL
    -- MECA's inputs make the cell exist; its figure is the MECA readings.
    SELECT r.channel_id, 'meca', NULL::text, r.bucket_start,
           0::numeric, r.sealed, (r.session_count > 0 OR r.signal_count > 0)
      FROM bob.proj_rum_signals r
     WHERE r.org_id = p_org AND r.channel_id = ANY (p_channels)
       AND r.bucket_start >= p_from AND r.bucket_start < p_to
    UNION ALL
    -- Each health component is its own cell (§6.4); a NULL component was not
    -- measured.
    SELECT h.channel_id, v.metric, NULL::text, h.bucket_start,
           v.value::numeric, h.sealed, false
      FROM bob.proj_channel_health h
     CROSS JOIN LATERAL (VALUES
             ('health_latency',     h.latency_n),
             ('health_errors',      h.error_n),
             ('health_uptime',      h.uptime_seconds),
             ('health_disconnects', h.disconnects::bigint)) v(metric, value)
     WHERE h.org_id = p_org AND h.channel_id = ANY (p_channels)
       AND h.bucket_start >= p_from AND h.bucket_start < p_to
       AND v.value IS NOT NULL
  ),
  fact AS (
    SELECT f.channel_id, f.metric, coalesce(f.actor_type, '') AS actor_key,
           f.bucket_start, sum(f.value) AS value, bool_and(f.sealed) AS sealed
      FROM facts f
     GROUP BY f.channel_id, f.metric, coalesce(f.actor_type, ''), f.bucket_start
  ),
  traffic AS (
    SELECT f.channel_id, f.bucket_start
      FROM facts f
     WHERE f.traffic
     GROUP BY f.channel_id, f.bucket_start
  ),
  probe AS (
    SELECT h.channel_id, h.bucket_start
      FROM bob.proj_channel_health h
     WHERE h.org_id = p_org AND h.channel_id = ANY (p_channels)
       AND h.bucket_start >= p_from AND h.bucket_start < p_to
       AND h.observed
  ),
  -- R3: the tenant's watermark, for the cells that have no row.
  watermark AS (
    SELECT max(w.at) AS at
      FROM (SELECT max(x.source_watermark) AS at FROM bob.proj_metric_counts x  WHERE x.org_id = p_org
            UNION ALL
            SELECT max(x.source_watermark) FROM bob.proj_durations x      WHERE x.org_id = p_org
            UNION ALL
            SELECT max(x.source_watermark) FROM bob.proj_sentiment x      WHERE x.org_id = p_org
            UNION ALL
            SELECT max(x.source_watermark) FROM bob.proj_channel_health x WHERE x.org_id = p_org
            UNION ALL
            SELECT max(x.source_watermark) FROM bob.proj_rum_signals x    WHERE x.org_id = p_org) w
  ),
  -- The declarations of §3 steps 1 to 3 do not depend on the bucket: they are
  -- judged once per (channel, metric, actor_type), then crossed with buckets.
  -- MATERIALIZED: inlined, the planner evaluated the capability subquery once
  -- per cell, several times over (EXPLAIN on the fixture).
  declared AS MATERIALIZED (
    SELECT o.id AS org_id,
           c.id AS channel_id, c.lag_seconds,
           k.metric, t.actor_type,
           (t.actor_type IS NOT NULL
            AND NOT (t.actor_type = ANY (k.applicable_actor_types))) AS inapplicable,
           -- §3 step 2, in its order, every reason that applies
           array_remove(ARRAY[
             CASE WHEN o.telemetry_started_at IS NULL THEN 'telemetry_not_started' END,
             CASE WHEN c.key_unset THEN 'source_key_unset' END,
             CASE WHEN k.actor_grain AND NOT k.degenerate AND mix.present IS NULL
                  THEN 'mix_not_declared' END], NULL)
           || ARRAY(SELECT 'capability_not_declared:' || rc.cap
                      FROM unnest(k.required_capabilities) WITH ORDINALITY rc(cap, pos)
                     WHERE NOT EXISTS (
                             SELECT 1 FROM bob.channel_capabilities cc
                              WHERE cc.channel_id = c.id AND cc.capability = rc.cap)
                     ORDER BY rc.pos)
           || array_remove(ARRAY[
             CASE WHEN k.precondition = 'idle_bound' AND c.idle_bound_seconds IS NULL
                  THEN 'idle_bound_not_declared' END,
             -- D-29's knowledge notes ship empty in v1 and have no table yet:
             -- no ground truth exists for any channel.
             CASE WHEN k.precondition = 'ground_truth' THEN 'no_ground_truth' END,
             CASE WHEN k.undefined_by IS NOT NULL THEN 'no_definition:' || k.undefined_by END],
             NULL) AS missing,
           coalesce(k.actor_grain AND NOT k.degenerate AND mix.present = false, false)
             AS declared_absent
      FROM org o
      JOIN ch c ON c.org_id = o.id
     CROSS JOIN cat k
     CROSS JOIN LATERAL (
             SELECT u.actor_type FROM unnest(ARRAY['user', 'asa', 'human', 'arep']) u(actor_type)
              WHERE k.actor_grain
             UNION ALL
             SELECT NULL::text WHERE NOT k.actor_grain) t
      LEFT JOIN bob.channel_actor_mix mix
             ON mix.org_id = o.id AND mix.channel_id = c.id AND mix.actor_type = t.actor_type
  ),
  judged AS (
    SELECT x.*, b.bucket_start,
           f.value AS row_value,
           f.sealed AS row_sealed,
           (f.metric IS NOT NULL) AS has_row,
           (x.lag_seconds IS NOT NULL AND w.at IS NOT NULL
            AND b.bucket_start + interval '5 minutes' + x.lag_seconds * interval '1 second'
                <= w.at) AS sealed_now,
           (tr.channel_id IS NOT NULL) AS had_traffic,
           (pr.channel_id IS NOT NULL) AS had_probe
      FROM declared x
     CROSS JOIN buckets b
     CROSS JOIN watermark w
      LEFT JOIN fact f
             ON f.channel_id = x.channel_id AND f.metric = x.metric
            AND f.actor_key = coalesce(x.actor_type, '') AND f.bucket_start = b.bucket_start
      LEFT JOIN traffic tr ON tr.channel_id = x.channel_id AND tr.bucket_start = b.bucket_start
      LEFT JOIN probe pr   ON pr.channel_id = x.channel_id AND pr.bucket_start = b.bucket_start
  ),
  resolved AS (
    SELECT j.*,
           CASE
             WHEN j.inapplicable              THEN 'not_applicable'
             WHEN cardinality(j.missing) > 0  THEN 'not_configured'
             WHEN j.declared_absent           THEN 'absent'
             WHEN NOT j.has_row AND NOT j.sealed_now THEN 'pending'
             WHEN NOT j.has_row               THEN 'not_observed'
             ELSE 'row'
           END AS step
      FROM judged j
  )
  SELECT r.org_id, r.channel_id, r.metric, r.actor_type, r.bucket_start,
         CASE r.step WHEN 'absent' THEN 'observed' WHEN 'row' THEN 'observed'
                     ELSE r.step END AS state,
         CASE r.step
           WHEN 'not_applicable' THEN ARRAY[]::text[]
           WHEN 'not_configured' THEN r.missing
           WHEN 'absent'         THEN ARRAY['actor_not_present']
           WHEN 'pending'        THEN CASE WHEN r.lag_seconds IS NULL
                                           THEN ARRAY['lag_not_declared']
                                           ELSE ARRAY['not_sealed'] END
           WHEN 'not_observed'   THEN ARRAY['no_liveness']
           ELSE array_remove(ARRAY[
                  CASE WHEN r.row_value = 0 THEN 'none_observed' END,
                  CASE WHEN NOT r.row_sealed AND r.lag_seconds IS NULL THEN 'lag_not_declared'
                       WHEN NOT r.row_sealed THEN 'not_sealed' END], NULL)
         END AS reasons,
         CASE r.step WHEN 'absent' THEN 0::numeric WHEN 'row' THEN r.row_value END AS value,
         (r.step = 'row' AND NOT r.row_sealed) AS provisional,
         CASE WHEN r.step = 'row' THEN
                CASE WHEN r.had_probe AND NOT r.had_traffic THEN 'probe' ELSE 'traffic' END
         END AS liveness_source
    FROM resolved r;
END;

COMMENT ON FUNCTION bob.bob_cell_state(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Slice 3 spec §3 (F-31). The one implementation of the cell: state, reasons, '
  'value, provisional, liveness_source for every (channel, metric, actor_type, '
  'bucket) inside the frame. Invoker, under RLS (R4). SQL-standard body, so '
  'pg_depend records what it reads (§7).';

-- ── §6 · bob_cell_rollup (F-30) ─────────────────────────────────────────────
-- Over channels and time, per (metric, actor_type):
--   value        the sum of the observed cells only
--   state        observed if any cell is; otherwise the first state, in the
--                order of §2, among the cells
--   reasons      the distinct reasons of the cells in that state, in order
--   provisional  any observed cell is
--   coverage     {"n": channels with an observed cell, "m": channels selected,
--                 "excluded": [{channel_id, state, reasons}, …]}
-- An empty selection is not_applicable, with no_channels_selected (R7).
CREATE FUNCTION bob.bob_cell_rollup(
  p_org      UUID,
  p_channels UUID[],
  p_from     TIMESTAMPTZ,
  p_to       TIMESTAMPTZ
) RETURNS TABLE (
  org_id      UUID,
  metric      TEXT,
  actor_type  TEXT,
  state       TEXT,
  reasons     TEXT[],
  value       NUMERIC,
  provisional BOOLEAN,
  coverage    JSONB
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = bob, public
BEGIN ATOMIC
  WITH
  cell AS (
    SELECT s.*,
           CASE s.state WHEN 'not_applicable' THEN 1 WHEN 'not_configured' THEN 2
                        WHEN 'pending' THEN 3 WHEN 'not_observed' THEN 4
                        WHEN 'observed' THEN 5 END AS rank
      FROM bob.bob_cell_state(p_org, p_channels, p_from, p_to) s
  ),
  -- Each channel's own standing for the metric over the frame.
  per_channel AS (
    SELECT c.metric, coalesce(c.actor_type, '') AS actor_key, c.channel_id,
           CASE WHEN bool_or(c.state = 'observed') THEN 5 ELSE min(c.rank) END AS rank
      FROM cell c
     GROUP BY c.metric, coalesce(c.actor_type, ''), c.channel_id
  ),
  per_channel_reasons AS (
    SELECT pc.metric, pc.actor_key, pc.channel_id, pc.rank,
           ARRAY(SELECT q.reason
                   FROM (SELECT u.reason, min(c.bucket_start) AS first_at, min(u.pos) AS pos
                           FROM cell c
                          CROSS JOIN LATERAL unnest(c.reasons) WITH ORDINALITY u(reason, pos)
                          WHERE c.metric = pc.metric AND coalesce(c.actor_type, '') = pc.actor_key
                            AND c.channel_id = pc.channel_id AND c.rank = pc.rank
                          GROUP BY u.reason) q
                  ORDER BY q.pos, q.first_at, q.reason) AS reasons
      FROM per_channel pc
  ),
  per_metric AS (
    SELECT c.org_id, c.metric, c.actor_type,
           CASE WHEN bool_or(c.state = 'observed') THEN 5 ELSE min(c.rank) END AS rank,
           sum(c.value) FILTER (WHERE c.state = 'observed') AS value,
           coalesce(bool_or(c.provisional) FILTER (WHERE c.state = 'observed'), false) AS provisional
      FROM cell c
     GROUP BY c.org_id, c.metric, c.actor_type
  ),
  rolled AS (
    SELECT pm.org_id, pm.metric, pm.actor_type,
           (ARRAY['not_applicable', 'not_configured', 'pending', 'not_observed', 'observed'])[pm.rank] AS state,
           ARRAY(SELECT q.reason
                   FROM (SELECT u.reason, min(u.pos) AS pos, min(c.bucket_start) AS first_at
                           FROM cell c
                          CROSS JOIN LATERAL unnest(c.reasons) WITH ORDINALITY u(reason, pos)
                          WHERE c.metric = pm.metric
                            AND coalesce(c.actor_type, '') = coalesce(pm.actor_type, '')
                            AND c.rank = pm.rank
                          GROUP BY u.reason) q
                  ORDER BY q.pos, q.first_at, q.reason) AS reasons,
           pm.value, pm.provisional,
           jsonb_build_object(
             'n', (SELECT count(*) FROM per_channel pc
                    WHERE pc.metric = pm.metric AND pc.actor_key = coalesce(pm.actor_type, '')
                      AND pc.rank = 5),
             'm', (SELECT count(*) FROM per_channel pc
                    WHERE pc.metric = pm.metric AND pc.actor_key = coalesce(pm.actor_type, '')),
             'excluded', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'channel_id', pr.channel_id,
                        'state', (ARRAY['not_applicable', 'not_configured', 'pending',
                                        'not_observed', 'observed'])[pr.rank],
                        'reasons', to_jsonb(pr.reasons))
                        ORDER BY pr.channel_id)
                 FROM per_channel_reasons pr
                WHERE pr.metric = pm.metric AND pr.actor_key = coalesce(pm.actor_type, '')
                  AND pr.rank <> 5), '[]'::jsonb)) AS coverage
      FROM per_metric pm
  ),
  -- R7: nothing selected. One row per catalog cell, nothing to evaluate.
  nothing AS (
    SELECT p_org AS org_id, k.metric, t.actor_type
      FROM bob.cell_catalog k
     CROSS JOIN LATERAL (
             SELECT u.actor_type FROM unnest(ARRAY['user', 'asa', 'human', 'arep']) u(actor_type)
              WHERE k.actor_grain
             UNION ALL
             SELECT NULL::text WHERE NOT k.actor_grain) t
     WHERE k.source IN ('proj_metric_counts', 'proj_durations', 'proj_sentiment',
                        'proj_channel_health', 'none')
       AND cardinality(coalesce(p_channels, ARRAY[]::uuid[])) = 0
  )
  SELECT r.org_id, r.metric, r.actor_type, r.state, r.reasons, r.value,
         r.provisional, r.coverage
    FROM rolled r
  UNION ALL
  SELECT n.org_id, n.metric, n.actor_type, 'not_applicable',
         ARRAY['no_channels_selected'], NULL::numeric, false,
         jsonb_build_object('n', 0, 'm', 0, 'excluded', '[]'::jsonb)
    FROM nothing n;
END;

COMMENT ON FUNCTION bob.bob_cell_rollup(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Slice 3 spec §6 (F-30). The "All" total over channels and time, read from '
  'bob_cell_state: sums observed cells only, states the first state otherwise, '
  'and carries coverage "n of m channels" with each excluded channel.';

-- ── §4 · Available's translation (G9, R7) ───────────────────────────────────
-- bob_availability() and bob_availability_reason() are unchanged. Their FR-23
-- reasons become (state, reasons), in the database. Never pending or
-- provisional: availability has no bucket.
CREATE FUNCTION bob.bob_available_state(
  p_org                  UUID,
  p_channels             UUID[],
  p_user_volume          BIGINT      DEFAULT NULL,
  p_window_minutes       NUMERIC     DEFAULT NULL,
  p_avg_duration_minutes NUMERIC     DEFAULT NULL,
  p_at                   TIMESTAMPTZ DEFAULT now()
) RETURNS TABLE (
  actor_type TEXT,
  state      TEXT,
  reasons    TEXT[],
  value      NUMERIC
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = bob, public
BEGIN ATOMIC
  SELECT a.actor_type,
         CASE
           WHEN a.reason = 'no_channels_selected' THEN 'not_applicable'
           WHEN a.reason = 'mix_not_declared'     THEN 'not_configured'
           ELSE 'observed'
         END,
         CASE WHEN a.reason IS NULL THEN ARRAY[]::text[] ELSE ARRAY[a.reason] END,
         CASE
           WHEN a.reason IN ('no_channels_selected', 'mix_not_declared') THEN NULL
           ELSE coalesce(a.available, 0)::numeric
         END
    FROM public.bob_availability(p_org, p_channels, p_user_volume, p_window_minutes,
                                 p_avg_duration_minutes, p_at) a;
END;

COMMENT ON FUNCTION bob.bob_available_state(UUID, UUID[], BIGINT, NUMERIC, NUMERIC, TIMESTAMPTZ) IS
  'Slice 3 spec §4. Available in the cell''s shape: mix_not_declared is '
  'not_configured, no_channels_selected is not_applicable (R7), every other '
  'FR-23 reason is an observed 0 carrying that reason.';

-- ── §2 · the per-actor drill-down cells, and off_shift ──────────────────────
-- For each actor skilled on a selected channel, or with a row in
-- proj_actor_metrics there, and each per-actor metric (the catalog's
-- non-degenerate counts), read beside the channel cell of its actor type:
--   not_applicable, not_configured   the channel cell's, unchanged
--   observed                         the actor has a row (provisional by its seal)
--   observed 0                       the channel cell's declared-absent zero
--   off_shift                        a human not on shift at the bucket's start
--                                    (bob_shift_is_live false), with no row
--   pending                          the channel cell's
--   not_observed                     an actor on shift, with no row
-- Per-actor zeros are not written (spec §10, decided with Slice 7).
CREATE FUNCTION bob.bob_actor_cell_state(
  p_org      UUID,
  p_channels UUID[],
  p_from     TIMESTAMPTZ,
  p_to       TIMESTAMPTZ
) RETURNS TABLE (
  org_id       UUID,
  actor_id     UUID,
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
  )
  SELECT c.org_id, a.id, c.channel_id, c.metric, a.actor_type, c.bucket_start,
         CASE
           WHEN c.state IN ('not_applicable', 'not_configured') THEN c.state
           WHEN r.actor_id IS NOT NULL THEN 'observed'
           WHEN c.state = 'observed' AND 'actor_not_present' = ANY (c.reasons) THEN 'observed'
           WHEN a.actor_type = 'human' AND NOT EXISTS (
                  SELECT 1 FROM bob.actor_shifts sh
                   WHERE sh.org_id = p_org AND sh.actor_id = a.id
                     AND public.bob_shift_is_live(sh.starts_at, sh.ends_at, sh.status,
                                                  c.bucket_start)) THEN 'off_shift'
           WHEN c.state = 'pending' THEN 'pending'
           ELSE 'not_observed'
         END,
         CASE
           WHEN c.state IN ('not_applicable', 'not_configured') THEN c.reasons
           WHEN r.actor_id IS NOT NULL THEN
             CASE WHEN r.value = 0 THEN ARRAY['none_observed'] ELSE ARRAY[]::text[] END
           WHEN c.state = 'observed' AND 'actor_not_present' = ANY (c.reasons) THEN c.reasons
           WHEN a.actor_type = 'human' AND NOT EXISTS (
                  SELECT 1 FROM bob.actor_shifts sh
                   WHERE sh.org_id = p_org AND sh.actor_id = a.id
                     AND public.bob_shift_is_live(sh.starts_at, sh.ends_at, sh.status,
                                                  c.bucket_start)) THEN ARRAY['not_on_shift']
           WHEN c.state = 'pending' THEN c.reasons
           ELSE ARRAY['no_actor_row']
         END,
         CASE
           WHEN c.state IN ('not_applicable', 'not_configured') THEN NULL
           WHEN r.actor_id IS NOT NULL THEN r.value
           WHEN c.state = 'observed' AND 'actor_not_present' = ANY (c.reasons) THEN 0::numeric
         END,
         (c.state NOT IN ('not_applicable', 'not_configured') AND r.actor_id IS NOT NULL
          AND NOT r.sealed)
    FROM who w
    JOIN bob.actors a ON a.id = w.actor_id AND a.org_id = p_org
    JOIN bob.bob_cell_state(p_org, p_channels, p_from, p_to) c
      ON c.channel_id = w.channel_id AND c.actor_type = a.actor_type
    JOIN bob.cell_catalog k
      ON k.metric = c.metric AND k.source = 'proj_metric_counts' AND NOT k.degenerate
    LEFT JOIN rows_ r
      ON r.actor_id = a.id AND r.channel_id = c.channel_id
     AND r.metric = c.metric AND r.bucket_start = c.bucket_start;
END;

COMMENT ON FUNCTION bob.bob_actor_cell_state(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Slice 3 spec §2. The per-actor drill-down cells, read beside bob_cell_state: '
  'off_shift for a human not on shift with no row, apart from an actor on shift '
  'with no row (not_observed). The em dash is shared; state and reasons differ.';

-- ── R6 · BObee's face ───────────────────────────────────────────────────────
-- A definer function owned by the migration owner, over bob_cell_state for the
-- current day (UTC) and every channel of the caller's org_id claim. Tenancy is
-- the explicit filter on the claim, not RLS: the owner is not subject to it.
-- The claim is read once; with no claim, nothing is returned.
CREATE FUNCTION bob.bob_ai_cell_state()
RETURNS TABLE (
  org_id          UUID,
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
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = bob, public
BEGIN ATOMIC
  WITH claim AS (
    SELECT nullif(auth.jwt() ->> 'org_id', '')::uuid AS org_id
  )
  SELECT s.org_id, s.channel_id, s.metric, s.actor_type, s.bucket_start,
         s.state, s.reasons, s.value, s.provisional, s.liveness_source
    FROM claim
   CROSS JOIN LATERAL bob.bob_cell_state(
           claim.org_id,
           ARRAY(SELECT c.id FROM bob.channels c WHERE c.org_id = claim.org_id),
           date_trunc('day', now(), 'UTC'),
           date_bin('5 minutes', now(), TIMESTAMPTZ '1970-01-01 00:00:00+00')
             + interval '5 minutes') s
   WHERE claim.org_id IS NOT NULL
     AND s.org_id = claim.org_id;
END;

COMMENT ON FUNCTION bob.bob_ai_cell_state() IS
  'Slice 3 spec §7 (R6). Definer, owned by the migration owner: '
  'bob_cell_state for the caller''s org_id claim over the current day. '
  'Filters on the claim itself. EXECUTE: bob_ai_ro alone, through '
  'bob.v_ai_cell_state.';

CREATE VIEW bob.v_ai_cell_state
WITH (security_invoker = false) AS
  SELECT a.org_id, a.channel_id, a.metric, a.actor_type, a.bucket_start,
         a.state, a.reasons, a.value, a.provisional, a.liveness_source
    FROM bob.bob_ai_cell_state() a;

COMMENT ON VIEW bob.v_ai_cell_state IS
  'Slice 3 spec §7 (R6). BObee''s face on the cell: today''s cells of the '
  'caller''s org_id claim, unobserved channels included as values. No '
  'display_name. Granted to bob_ai_ro alone.';

-- ── Who executes what ───────────────────────────────────────────────────────
-- Postgres hands EXECUTE on a new function to PUBLIC. `bob` has no default
-- privileges of its own; the revoke still names every role, so a default added
-- later does not widen this. Taken back, then given.
REVOKE ALL ON FUNCTION
  bob.bob_cell_state(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ),
  bob.bob_cell_rollup(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ),
  bob.bob_available_state(UUID, UUID[], BIGINT, NUMERIC, NUMERIC, TIMESTAMPTZ),
  bob.bob_actor_cell_state(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ),
  bob.bob_ai_cell_state()
FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;

GRANT EXECUTE ON FUNCTION
  bob.bob_cell_state(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ),
  bob.bob_cell_rollup(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ),
  bob.bob_available_state(UUID, UUID[], BIGINT, NUMERIC, NUMERIC, TIMESTAMPTZ),
  bob.bob_actor_cell_state(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
TO bob_app, authenticated;

GRANT EXECUTE ON FUNCTION bob.bob_ai_cell_state() TO bob_ai_ro;

REVOKE ALL ON bob.v_ai_cell_state
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder;
GRANT SELECT ON bob.v_ai_cell_state TO bob_ai_ro;

COMMIT;
