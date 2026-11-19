-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 2 · part 2 · Migration 1 of 1
-- What the feeder needs to know about a channel beyond lag and idle bound, and
-- the report of channels whose declarations are missing.
--
-- Projection contract §9.1: channel_capabilities. A row means the channel can
-- produce that class; no row means it cannot. Presence only (C-16).
--
-- §4.1 writes `label_missing` only on a channel that declares
-- `orga_conversation`, and §7.4 gives the feeder exactly two views. So the
-- feeder's channel map carries the channel's capabilities, as one more column
-- of the view it already reads, not a third view. Recorded as F-25 in
-- contract-amendments.md, with the contract change it needs.
--
-- §4 and §9.2: Slice 2 reports channels whose lag is not declared, and
-- channels whose lag is below their idle bound. v_channel_declaration_gaps.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── §9.1 · channel_capabilities ─────────────────────────────────────────────
CREATE TABLE bob.channel_capabilities (
  org_id      UUID NOT NULL REFERENCES bob.organizations(id) ON DELETE CASCADE,
  channel_id  UUID NOT NULL REFERENCES bob.channels(id) ON DELETE CASCADE,
  capability  TEXT NOT NULL CHECK (capability IN (
                'orga_conversation', 'meca_rum', 'response_time', 'resolution',
                'coherence', 'hallucination', 'health_latency', 'health_errors',
                'health_uptime', 'health_disconnects')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, channel_id, capability)
);

ALTER TABLE bob.channel_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_channel_capabilities" ON bob.channel_capabilities FOR ALL
  USING      (org_id = (auth.jwt() ->> 'org_id')::uuid)
  WITH CHECK (org_id = (auth.jwt() ->> 'org_id')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON bob.channel_capabilities TO bob_app, authenticated;

COMMENT ON TABLE bob.channel_capabilities IS
  'Contract §9.1. Declared per channel, never derived from the channel kind. A row '
  'means the channel can produce this class; no row means not configured (§5).';

-- ── §7.4 · the channel map carries the capabilities (F-25) ──────────────────
DROP VIEW bob.v_feeder_channel_map;

CREATE VIEW bob.v_feeder_channel_map
WITH (security_invoker = false) AS
  SELECT c.id AS channel_id,
         c.org_id,
         o.slug AS tenant_slug,
         c.source_key,
         c.lag_seconds,
         c.adapter_kind,
         c.idle_bound_seconds,
         ARRAY(SELECT cc.capability FROM bob.channel_capabilities cc
                WHERE cc.channel_id = c.id ORDER BY cc.capability) AS capabilities
    FROM bob.channels c
    JOIN bob.organizations o ON o.id = c.org_id;

COMMENT ON VIEW bob.v_feeder_channel_map IS
  'Contract §7.4. One of the two things the feeder reads from BOb: '
  '(tenant_slug, source_key) to (org_id, channel_id), with the per-channel '
  'declarations it needs: lag, idle bound, capabilities (F-25). Definer view '
  '(F-21): readable by bob_feeder alone, across tenants.';

REVOKE ALL ON bob.v_feeder_channel_map
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_ai_ro;
GRANT SELECT ON bob.v_feeder_channel_map TO bob_feeder;

-- ── §4, §9.2 · the declaration report ───────────────────────────────────────
-- An invoker view: each tenant sees its own channels, through RLS. The count
-- the operator reads is a count(*) over it as the migration owner.
CREATE VIEW bob.v_channel_declaration_gaps
WITH (security_invoker = true) AS
  SELECT c.org_id,
         c.id AS channel_id,
         c.lag_seconds IS NULL AS lag_not_declared,
         (c.lag_seconds IS NOT NULL AND c.idle_bound_seconds IS NOT NULL
          AND c.lag_seconds < c.idle_bound_seconds) AS lag_below_idle_bound
    FROM bob.channels c
   WHERE c.lag_seconds IS NULL
      OR (c.idle_bound_seconds IS NOT NULL AND c.lag_seconds < c.idle_bound_seconds);

COMMENT ON VIEW bob.v_channel_declaration_gaps IS
  'Contract §4 (O1) and §9.2. Channels surfaced as "lag not declared" (never '
  'sealed, never evaluated), and channels whose lag is below their idle bound '
  '(every idle abandonment lands behind the seal). Reported, not refused.';

REVOKE ALL ON bob.v_channel_declaration_gaps FROM PUBLIC, anon, service_role;
GRANT SELECT ON bob.v_channel_declaration_gaps TO bob_app, authenticated;

COMMIT;
