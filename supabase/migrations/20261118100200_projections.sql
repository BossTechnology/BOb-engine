-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 2 · Migration 3 of 3
-- The eight projections, and the one function that creates their partitions.
--
-- Projection contract 0.5.1, signed by Henry on Relevo task 6 (18 Nov). The
-- DDL below is §6.1 to §6.8 as written, with the parts each section abbreviates
-- ("sealed + provenance") spelled out from §3 and §4:
--
--   provenance, all eight   computed_at, source_watermark, feeder_version (§4)
--   sealed, the six bucketed  BOOLEAN NOT NULL DEFAULT false            (§4)
--   grain, the six bucketed   bucket_start on a five-minute UTC boundary (§3)
--
-- One departure, recorded as F-23 in contract-amendments.md: §3 writes the
-- grain CHECK as `extract(epoch FROM bucket_start)::bigint % 300 = 0`. The cast
-- rounds, so 14:00:00.4 passes it and becomes a second bucket beside 14:00
-- under the same primary key. The CHECK here takes the remainder of the exact
-- epoch, which refuses it. Every value the contract's form accepts on a whole
-- second, this one accepts.
--
-- Every projection is created in `bob`, PARTITION BY RANGE, passed through
-- bob_grant_projection() (PR-4), and given RLS with the policy every tenant
-- table uses (§2). No partition is created here: the feeder creates the month
-- it is about to write, through bob.proj_ensure_partition() (§3, H1).
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── §6.1 · proj_metric_counts ───────────────────────────────────────────────
CREATE TABLE bob.proj_metric_counts (
  org_id        UUID        NOT NULL,
  channel_id    UUID        NOT NULL REFERENCES bob.channels(id),
  actor_type    TEXT        NOT NULL
                CHECK (actor_type IN ('user','asa','human','arep')),
  metric_id     TEXT        NOT NULL
                CHECK (metric_id IN ('resolved','abandoned','abandoned_in_queue',
                       'disambiguation','escalations','hallucinations',
                       'abstained','classifier_down','label_missing')),
  bucket_start  TIMESTAMPTZ NOT NULL,
  event_count   BIGINT      NOT NULL DEFAULT 0,
  session_count BIGINT      NOT NULL DEFAULT 0,   -- denominator
  -- these metrics have one possible actor, by definition (Q4, Q6, C2)
  CONSTRAINT proj_metric_counts_degenerate_actor
    CHECK (metric_id NOT IN ('abandoned_in_queue','abstained','classifier_down',
                             'label_missing')
           OR actor_type = 'user'),
  sealed           BOOLEAN     NOT NULL DEFAULT false,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_watermark TIMESTAMPTZ NOT NULL,
  feeder_version   TEXT        NOT NULL,
  CONSTRAINT proj_metric_counts_bucket_grain
    CHECK (extract(epoch FROM bucket_start) % 300 = 0),
  PRIMARY KEY (org_id, channel_id, actor_type, metric_id, bucket_start)
) PARTITION BY RANGE (bucket_start);

-- ── §6.2 · proj_sentiment ───────────────────────────────────────────────────
CREATE TABLE bob.proj_sentiment (
  org_id        UUID        NOT NULL,
  channel_id    UUID        NOT NULL REFERENCES bob.channels(id),
  source        TEXT        NOT NULL CHECK (source IN ('orga','meca')),
  state         TEXT        NOT NULL
                CHECK (state IN ('s0','s1','s2','s3','s4')),
  bucket_start  TIMESTAMPTZ NOT NULL,
  reading_count BIGINT      NOT NULL DEFAULT 0,
  closing_count BIGINT      NOT NULL DEFAULT 0,
  -- MECA has no conversation close (Q7)
  CONSTRAINT proj_sentiment_closing_is_orga
    CHECK (source = 'orga' OR closing_count = 0),
  sealed           BOOLEAN     NOT NULL DEFAULT false,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_watermark TIMESTAMPTZ NOT NULL,
  feeder_version   TEXT        NOT NULL,
  CONSTRAINT proj_sentiment_bucket_grain
    CHECK (extract(epoch FROM bucket_start) % 300 = 0),
  PRIMARY KEY (org_id, channel_id, source, state, bucket_start)
) PARTITION BY RANGE (bucket_start);

-- ── §6.3 · proj_durations ───────────────────────────────────────────────────
CREATE TABLE bob.proj_durations (
  org_id          UUID        NOT NULL,
  channel_id      UUID        NOT NULL REFERENCES bob.channels(id),
  actor_type      TEXT        NOT NULL
                  CHECK (actor_type IN ('user','asa','human','arep')),
  measure         TEXT        NOT NULL
                  CHECK (measure IN ('response_time','interaction_duration')),
  bucket_start    TIMESTAMPTZ NOT NULL,
  n               BIGINT      NOT NULL,           -- exact count
  sum_ms          BIGINT      NOT NULL,           -- exact mean on recombine
  min_ms          BIGINT,
  max_ms          BIGINT,
  hist_scale      SMALLINT    NOT NULL DEFAULT 4, -- per row, never pinned
  hist_offset     INTEGER     NOT NULL,           -- index of first populated bucket
  hist_counts     BIGINT[]    NOT NULL DEFAULT '{}',
  hist_zero_count BIGINT      NOT NULL DEFAULT 0,
  -- a conversation's length belongs to the conversation (O2)
  CONSTRAINT proj_durations_interaction_is_user
    CHECK (measure <> 'interaction_duration' OR actor_type = 'user'),
  sealed           BOOLEAN     NOT NULL DEFAULT false,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_watermark TIMESTAMPTZ NOT NULL,
  feeder_version   TEXT        NOT NULL,
  CONSTRAINT proj_durations_bucket_grain
    CHECK (extract(epoch FROM bucket_start) % 300 = 0),
  PRIMARY KEY (org_id, channel_id, actor_type, measure, bucket_start)
) PARTITION BY RANGE (bucket_start);

-- ── §6.4 · proj_channel_health ──────────────────────────────────────────────
CREATE TABLE bob.proj_channel_health (
  org_id                  UUID        NOT NULL,
  channel_id              UUID        NOT NULL REFERENCES bob.channels(id),
  bucket_start            TIMESTAMPTZ NOT NULL,
  -- latency: same shape as proj_durations; health_latency
  latency_n               BIGINT      NOT NULL DEFAULT 0,
  latency_sum_ms          BIGINT      NOT NULL DEFAULT 0,
  latency_min_ms          BIGINT,
  latency_max_ms          BIGINT,
  latency_hist_scale      SMALLINT    NOT NULL DEFAULT 4,
  latency_hist_offset     INTEGER     NOT NULL DEFAULT 0,
  latency_hist_counts     BIGINT[]    NOT NULL DEFAULT '{}',
  latency_hist_zero_count BIGINT      NOT NULL DEFAULT 0,
  -- errors: health_errors
  error_n                 BIGINT      NOT NULL DEFAULT 0,
  request_n               BIGINT      NOT NULL DEFAULT 0,
  -- uptime: health_uptime
  uptime_seconds          BIGINT      NOT NULL DEFAULT 0,
  observed_seconds        BIGINT      NOT NULL DEFAULT 0,
  -- disconnects: health_disconnects
  disconnects             INTEGER,
  observed                BOOLEAN     NOT NULL DEFAULT true,   -- PR-10
  sealed           BOOLEAN     NOT NULL DEFAULT false,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_watermark TIMESTAMPTZ NOT NULL,
  feeder_version   TEXT        NOT NULL,
  CONSTRAINT proj_channel_health_bucket_grain
    CHECK (extract(epoch FROM bucket_start) % 300 = 0),
  PRIMARY KEY (org_id, channel_id, bucket_start)
) PARTITION BY RANGE (bucket_start);

-- ── §6.5 · proj_rum_signals ─────────────────────────────────────────────────
CREATE TABLE bob.proj_rum_signals (
  org_id        UUID        NOT NULL,
  channel_id    UUID        NOT NULL REFERENCES bob.channels(id),
  signal        TEXT        NOT NULL CHECK (signal IN
                  ('rage_click','dead_click','error_click','thrash',
                   'rapid_exit','clean_session','fast_session')),
  bucket_start  TIMESTAMPTZ NOT NULL,
  signal_count  BIGINT      NOT NULL DEFAULT 0,
  session_count BIGINT      NOT NULL DEFAULT 0,
  sealed           BOOLEAN     NOT NULL DEFAULT false,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_watermark TIMESTAMPTZ NOT NULL,
  feeder_version   TEXT        NOT NULL,
  CONSTRAINT proj_rum_signals_bucket_grain
    CHECK (extract(epoch FROM bucket_start) % 300 = 0),
  PRIMARY KEY (org_id, channel_id, signal, bucket_start)
) PARTITION BY RANGE (bucket_start);

-- ── §6.6 · proj_actor_metrics ───────────────────────────────────────────────
CREATE TABLE bob.proj_actor_metrics (
  org_id        UUID        NOT NULL,
  actor_id      UUID        NOT NULL,
  actor_type    TEXT        NOT NULL                        -- denormalised
                CHECK (actor_type IN ('user','asa','human','arep')),
  channel_id    UUID        NOT NULL REFERENCES bob.channels(id),
  metric_id     TEXT        NOT NULL
                CHECK (metric_id IN ('resolved','abandoned','disambiguation',
                       'escalations','hallucinations','handled')),
  identity_rung_at_interaction TEXT NOT NULL
                CHECK (identity_rung_at_interaction IN
                       ('identified','ghost','guest','inferred',
                        'not_applicable')),
  bucket_start  TIMESTAMPTZ NOT NULL,
  event_count   BIGINT      NOT NULL DEFAULT 0,
  -- the rung is a member's; nobody else has one (Q8 (a))
  CONSTRAINT proj_actor_metrics_rung_pairs_with_type
    CHECK ((actor_type = 'user') = (identity_rung_at_interaction <> 'not_applicable')),
  -- the denormalised type must be the actor's own (Q8 (a), accepted 12 Nov)
  CONSTRAINT proj_actor_metrics_actor_type_fkey
    FOREIGN KEY (actor_id, actor_type) REFERENCES bob.actors (id, actor_type),
  sealed           BOOLEAN     NOT NULL DEFAULT false,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_watermark TIMESTAMPTZ NOT NULL,
  feeder_version   TEXT        NOT NULL,
  CONSTRAINT proj_actor_metrics_bucket_grain
    CHECK (extract(epoch FROM bucket_start) % 300 = 0),
  PRIMARY KEY (org_id, actor_id, channel_id, metric_id,
               identity_rung_at_interaction, bucket_start)
) PARTITION BY RANGE (bucket_start);

-- ── §6.7 · proj_detections (event grain) ────────────────────────────────────
CREATE TABLE bob.proj_detections (
  org_id            UUID        NOT NULL,
  detection_id      TEXT        NOT NULL,
  channel_id        UUID        REFERENCES bob.channels(id),   -- may be null
  detection         TEXT        NOT NULL,
  detected_at       TIMESTAMPTZ NOT NULL,
  confidence        NUMERIC,
  infra_evidence    JSONB,
  business_evidence JSONB,
  acted_upon        BOOLEAN     NOT NULL DEFAULT false,
  correlation_id    TEXT        NOT NULL,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_watermark TIMESTAMPTZ NOT NULL,
  feeder_version   TEXT        NOT NULL,
  -- The partition key must be in every unique key of a partitioned table.
  -- §6.7 keys on (org_id, detection_id); detected_at rides along, which keeps
  -- that pair unique within a month and changes nothing for a feeder that
  -- upserts by event time.
  PRIMARY KEY (org_id, detection_id, detected_at)
) PARTITION BY RANGE (detected_at);

-- ── §6.8 · proj_deliveries (event grain) ────────────────────────────────────
CREATE TABLE bob.proj_deliveries (
  org_id           UUID        NOT NULL,
  attempt_id       TEXT        NOT NULL,
  outbound_id      UUID        NOT NULL,   -- joins outbound_queue; no FK in Slice 2
  correlation_id   TEXT        NOT NULL,
  kind             TEXT        NOT NULL CHECK (kind IN ('autocomm','autobotz')),
  provider         TEXT        NOT NULL,
  attempted_at     TIMESTAMPTZ NOT NULL,
  outcome          TEXT        NOT NULL
                   CHECK (outcome IN ('delivered','failed',
                          'rejected','expired','suppressed')),
  attempt          INTEGER     NOT NULL DEFAULT 1,
  provider_ref     TEXT,
  provider_message TEXT,
  guardrail_bound  TEXT,        -- which limit applied, if any
  report           JSONB,       -- the typed return payload, Handoff §7.4
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_watermark TIMESTAMPTZ NOT NULL,
  feeder_version   TEXT        NOT NULL,
  -- As §6.7: the partition key joins the primary key.
  PRIMARY KEY (org_id, attempt_id, attempted_at)
) PARTITION BY RANGE (attempted_at);

-- ── PR-4 and §2, on each parent ─────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'proj_metric_counts', 'proj_sentiment', 'proj_durations',
    'proj_channel_health', 'proj_rum_signals', 'proj_actor_metrics',
    'proj_detections', 'proj_deliveries']
  LOOP
    PERFORM public.bob_grant_projection(format('bob.%I', t)::regclass);
    EXECUTE format('ALTER TABLE bob.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON bob.%I FOR ALL '
      'USING (org_id = (auth.jwt() ->> ''org_id'')::uuid) '
      'WITH CHECK (org_id = (auth.jwt() ->> ''org_id'')::uuid)',
      'org_' || t, t);
  END LOOP;
END $$;

-- ── §3 · the partition function (H1) ────────────────────────────────────────
-- The feeder creates the partition it is about to write into (0.2 Q7): create,
-- grant, RLS, in one call, idempotent. bob_feeder owns no parent and cannot run
-- bob_grant_projection(), so this is SECURITY DEFINER, owned by the migration
-- owner, and EXECUTE goes to bob_feeder alone.
--
-- H1: a definer function bob_feeder can call must not accept an arbitrary
-- table, or it would hang partitions with the definer's grants off any
-- partitioned table in the database. It takes a parent that is one of the
-- eight, compared by OID with the eight tables of schema `bob` (so a same-named
-- table elsewhere, or a name that merely looks right, is refused), and a date
-- that is the first day of a month. A `date` has no time zone; the bounds are
-- computed at midnight UTC. Anything else raises before anything is created.
CREATE FUNCTION bob.proj_ensure_partition(parent regclass, month date)
RETURNS regclass
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, bob, public
SET TimeZone = 'UTC'
AS $$
DECLARE
  eight CONSTANT oid[] := ARRAY[
    'bob.proj_metric_counts'::regclass, 'bob.proj_sentiment'::regclass,
    'bob.proj_durations'::regclass,     'bob.proj_channel_health'::regclass,
    'bob.proj_rum_signals'::regclass,   'bob.proj_actor_metrics'::regclass,
    'bob.proj_detections'::regclass,    'bob.proj_deliveries'::regclass]::oid[];
  parent_name text;
  child_name  text;
  child       regclass;
  lower_bound timestamptz;
  upper_bound timestamptz;
BEGIN
  IF parent IS NULL OR NOT (parent::oid = ANY (eight)) THEN
    RAISE EXCEPTION 'proj_ensure_partition: % is not one of the eight projections in schema bob',
      coalesce(parent::text, 'NULL') USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF month IS NULL OR month <> date_trunc('month', month)::date THEN
    RAISE EXCEPTION 'proj_ensure_partition: % is not the first day of a month',
      coalesce(month::text, 'NULL') USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT c.relname INTO parent_name FROM pg_class c WHERE c.oid = parent;
  child_name  := format('%s_y%sm%s', parent_name,
                        to_char(month, 'YYYY'), to_char(month, 'MM'));
  lower_bound := month::timestamp AT TIME ZONE 'UTC';
  upper_bound := (month + interval '1 month')::timestamp AT TIME ZONE 'UTC';

  -- Two feeder transactions reaching a new month together must not race on
  -- the catalog. The lock ends with the caller's transaction.
  PERFORM pg_advisory_xact_lock(hashtext('bob.proj_ensure_partition'),
                                hashtext(child_name));

  EXECUTE format('CREATE TABLE IF NOT EXISTS bob.%I PARTITION OF %s '
                 'FOR VALUES FROM (%L) TO (%L)',
                 child_name, parent, lower_bound, upper_bound);

  child := format('bob.%I', child_name)::regclass;

  -- IF NOT EXISTS skips silently when the name is taken. A table of that name
  -- that is not this month of this parent is refused, never granted.
  IF NOT EXISTS (
    SELECT 1 FROM pg_inherits i
      JOIN pg_class c2 ON c2.oid = i.inhrelid
     WHERE i.inhrelid = child AND i.inhparent = parent
       AND pg_get_expr(c2.relpartbound, c2.oid) =
           format('FOR VALUES FROM (%L) TO (%L)', lower_bound, upper_bound)) THEN
    RAISE EXCEPTION 'proj_ensure_partition: % exists and is not the % partition of %',
      child, month, parent USING ERRCODE = 'duplicate_table';
  END IF;

  -- PR-4: grants are not copied from a parent to a partition (F-18).
  PERFORM public.bob_grant_projection(child);

  -- §2: RLS is not inherited either. Direct reads of the partition get the
  -- same policy as the parent.
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', child);
  IF NOT EXISTS (SELECT 1 FROM pg_policy p
                  WHERE p.polrelid = child AND p.polname = 'org_' || child_name) THEN
    EXECUTE format(
      'CREATE POLICY %I ON %s FOR ALL '
      'USING (org_id = (auth.jwt() ->> ''org_id'')::uuid) '
      'WITH CHECK (org_id = (auth.jwt() ->> ''org_id'')::uuid)',
      'org_' || child_name, child);
  END IF;

  RETURN child;
END $$;

REVOKE EXECUTE ON FUNCTION bob.proj_ensure_partition(regclass, date)
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_ai_ro;
GRANT EXECUTE ON FUNCTION bob.proj_ensure_partition(regclass, date) TO bob_feeder;

COMMENT ON FUNCTION bob.proj_ensure_partition(regclass, date) IS
  'Contract §3 (H1). Creates, grants and guards the month of one of the eight '
  'projections, idempotently. Refuses any other parent and any date that is '
  'not the first of a month. EXECUTE: bob_feeder alone.';

COMMIT;
