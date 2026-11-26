-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 3 · Migration 1 of 2
-- The cell catalog, three capabilities, and the actor types the feeder sees.
--
-- Spec: docs/slice-3-absent-not-zero.md, §4, §5 and §9. Proposed for 0.6 as
-- F-29, F-38 and F-39 in contract-amendments.md, not yet signed; the contract
-- text stays at 0.5.3 until Federico accepts them.
--
-- F-29 · §9.1 · Three new capabilities, presence only, declared per channel and
-- never mapped from the channel kind: `disambiguation`, `escalation`, `queue`.
-- Ten become thirteen.
--
-- §4 · The catalog. One configuration table beside the mechanism, saying for
-- each metric where it is read, what it requires and which actor types can
-- produce it. bob_cell_state() reads it; it is not a list in application code.
-- A guard discovers the metric_id and measure values from the CHECK
-- constraints of the projections and fails if one is missing here.
--
-- F-38 · §7.4 · v_feeder_channel_map gains `actor_types TEXT[]`: the channel's
-- channel_actor_mix rows with present = true, sorted, empty when none is
-- declared present. F-25's pattern; the feeder still reads two views.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── F-29 · §9.1 · thirteen capabilities ─────────────────────────────────────
ALTER TABLE bob.channel_capabilities
  DROP CONSTRAINT channel_capabilities_capability_check;

ALTER TABLE bob.channel_capabilities
  ADD CONSTRAINT channel_capabilities_capability_check CHECK (capability IN (
    'orga_conversation', 'meca_rum', 'response_time', 'resolution',
    'coherence', 'hallucination', 'health_latency', 'health_errors',
    'health_uptime', 'health_disconnects',
    'disambiguation', 'escalation', 'queue'));

-- ── §4 · the catalog ────────────────────────────────────────────────────────
-- Global configuration, the same for every tenant: no org_id, no RLS. Written
-- by migrations only. bob_app and authenticated read it because
-- bob_cell_state() runs as its caller.
--
--   metric                  the stored metric_id or measure, or the cell's own
--                           name where no projection key exists (available,
--                           response_quality, orga, meca, the health components)
--   source                  where the figure is read
--   actor_grain             the cell has an actor_type; false for the channel
--                           figures (sentiment, health)
--   degenerate              belongs to the conversation: `user` only, and
--                           channel_actor_mix does not reach it (§3 step 2.3)
--   applicable_actor_types  the actor types that can produce it (§4, F-33)
--   required_capabilities   checked in this order (§3 step 2.4)
--   precondition            a measurement precondition beyond the capability.
--                           F-28, corrected: the feeder writes no zero for these
--                           unless the precondition is met; the list is closed
--   undefined_by            the open decision without which the figure has no
--                           definition (Response quality, D-15)
CREATE TABLE bob.cell_catalog (
  metric                  TEXT    PRIMARY KEY CHECK (metric ~ '^[a-z][a-z_]*$'),
  source                  TEXT    NOT NULL CHECK (source IN (
                            'proj_metric_counts', 'proj_durations', 'proj_sentiment',
                            'proj_channel_health', 'proj_actor_metrics',
                            'bob_availability', 'none')),
  actor_grain             BOOLEAN NOT NULL,
  degenerate              BOOLEAN NOT NULL DEFAULT false,
  applicable_actor_types  TEXT[]  NOT NULL
                          CHECK (applicable_actor_types <@ ARRAY['user','asa','human','arep']),
  required_capabilities   TEXT[]  NOT NULL DEFAULT '{}',
  precondition            TEXT    CHECK (precondition IN ('idle_bound', 'ground_truth')),
  undefined_by            TEXT,
  -- a channel figure has no actor; a degenerate one has exactly `user`
  CONSTRAINT cell_catalog_grain_pairs
    CHECK (actor_grain OR (cardinality(applicable_actor_types) = 0 AND NOT degenerate)),
  CONSTRAINT cell_catalog_degenerate_is_user
    CHECK (NOT degenerate OR applicable_actor_types = ARRAY['user'])
);

COMMENT ON TABLE bob.cell_catalog IS
  'Slice 3 spec §4. Metric → source, required declarations, applicable actor '
  'types. Read by bob_cell_state(). Global configuration, written by '
  'migrations only. A guard discovers every metric_id and measure in the '
  'projection CHECKs and requires it here.';

INSERT INTO bob.cell_catalog
  (metric, source, actor_grain, degenerate, applicable_actor_types,
   required_capabilities, precondition, undefined_by) VALUES
  -- The Performance matrix, row by row (§4)
  ('available',            'bob_availability',    true,  false, '{user,asa,human,arep}', '{}',                     NULL,           NULL),
  ('response_time',        'proj_durations',      true,  false, '{user,asa,human,arep}', '{response_time}',        NULL,           NULL),
  ('response_quality',     'none',                true,  false, '{user,asa,human,arep}', '{coherence}',            NULL,           'D-15'),
  ('resolved',             'proj_metric_counts',  true,  false, '{asa,human,arep}',      '{resolution}',           NULL,           NULL),
  ('abandoned',            'proj_metric_counts',  true,  false, '{user,asa,human,arep}', '{}',                     'idle_bound',   NULL),
  ('disambiguation',       'proj_metric_counts',  true,  false, '{asa,human,arep}',      '{disambiguation}',       NULL,           NULL),
  ('escalations',          'proj_metric_counts',  true,  false, '{asa,human,arep}',      '{escalation}',           NULL,           NULL),
  ('hallucinations',       'proj_metric_counts',  true,  false, '{user,asa,human,arep}', '{hallucination}',        'ground_truth', NULL),
  ('abandoned_in_queue',   'proj_metric_counts',  true,  true,  '{user}',                '{queue}',                NULL,           NULL),
  -- Elsewhere (§4)
  ('abstained',            'proj_metric_counts',  true,  true,  '{user}',                '{orga_conversation}',    NULL,           NULL),
  ('classifier_down',      'proj_metric_counts',  true,  true,  '{user}',                '{orga_conversation}',    NULL,           NULL),
  ('label_missing',        'proj_metric_counts',  true,  true,  '{user}',                '{orga_conversation}',    NULL,           NULL),
  ('interaction_duration', 'proj_durations',      true,  true,  '{user}',                '{resolution}',           NULL,           NULL),   -- F-39
  ('orga',                 'proj_sentiment',      false, false, '{}',                    '{orga_conversation}',    NULL,           NULL),
  ('meca',                 'proj_sentiment',      false, false, '{}',                    '{meca_rum}',             NULL,           NULL),
  ('health_latency',       'proj_channel_health', false, false, '{}',                    '{health_latency}',       NULL,           NULL),
  ('health_errors',        'proj_channel_health', false, false, '{}',                    '{health_errors}',        NULL,           NULL),
  ('health_uptime',        'proj_channel_health', false, false, '{}',                    '{health_uptime}',        NULL,           NULL),
  ('health_disconnects',   'proj_channel_health', false, false, '{}',                    '{health_disconnects}',   NULL,           NULL),
  -- §6.6 only: the per-actor count of interactions handled. Not a channel cell;
  -- listed so that every metric_id the projections accept has a row (§4 guard).
  ('handled',              'proj_actor_metrics',  true,  false, '{user,asa,human,arep}', '{}',                     NULL,           NULL);

REVOKE ALL ON bob.cell_catalog FROM PUBLIC, anon, authenticated, service_role,
                                     bob_app, bob_feeder, bob_ai_ro;
GRANT SELECT ON bob.cell_catalog TO bob_app, authenticated;

-- ── F-38 · §7.4 · the channel map carries the present actor types ───────────
-- Same columns as 20261119100000, in the same order, plus one at the end.
CREATE OR REPLACE VIEW bob.v_feeder_channel_map
WITH (security_invoker = false) AS
  SELECT c.id AS channel_id,
         c.org_id,
         o.slug AS tenant_slug,
         c.source_key,
         c.lag_seconds,
         c.adapter_kind,
         c.idle_bound_seconds,
         ARRAY(SELECT cc.capability FROM bob.channel_capabilities cc
                WHERE cc.channel_id = c.id ORDER BY cc.capability) AS capabilities,
         ARRAY(SELECT m.actor_type FROM bob.channel_actor_mix m
                WHERE m.channel_id = c.id AND m.present
                ORDER BY m.actor_type) AS actor_types
    FROM bob.channels c
    JOIN bob.organizations o ON o.id = c.org_id;

COMMENT ON VIEW bob.v_feeder_channel_map IS
  'Contract §7.4. One of the two things the feeder reads from BOb: '
  '(tenant_slug, source_key) to (org_id, channel_id), with the per-channel '
  'declarations it needs: lag, idle bound, capabilities (F-25) and the actor '
  'types declared present (F-38, proposed for 0.6). Definer view (F-21): '
  'readable by bob_feeder alone, across tenants.';

-- CREATE OR REPLACE keeps the grants; restated so the file says who reads it.
REVOKE ALL ON bob.v_feeder_channel_map
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_ai_ro;
GRANT SELECT ON bob.v_feeder_channel_map TO bob_feeder;

COMMIT;
