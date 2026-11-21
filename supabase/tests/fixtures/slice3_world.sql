-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 3 · the cell's world (spec §8.1).
--
-- NOT A MIGRATION. Loaded by tests/slice3-cell-state.test.mjs into a database
-- already carrying two_orgs.sql, roster.sql and feeder_world.sql. Pairs with
-- slice3_events.json. Every value is invented.
--
-- What it adds, so that every state appears at least once:
--   - tenant A has started telemetry; tenant B has not (D-14, D-18). B's voice
--     channel is on the source_key sentinel (SR-2, from two_orgs.sql);
--   - WhatsApp declares response_time and health_uptime, the three new
--     capabilities (F-29), and an idle bound. Voice declares none of the new
--     ones;
--   - a chat channel with ASA present, humans declared absent and no `user`
--     mix row, which declares orga_conversation, hallucination and meca_rum
--     and no idle bound (F-28 corrected, F-38, FR-32, the degenerate metrics);
--   - an app channel with no channel_actor_mix row (mix_not_declared);
--   - the website declares meca_rum and gets no RUM row (Slice 4 writes it).
-- ════════════════════════════════════════════════════════════════════════════

UPDATE organizations SET telemetry_started_at = '2026-11-01 00:00:00+00'
 WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';

UPDATE channels SET idle_bound_seconds = 1800
 WHERE id = 'aaaaaaaa-2222-4000-8000-000000000001';

INSERT INTO channels (id, org_id, channel_type, display_name, source_key,
                      lag_seconds, adapter_kind, idle_bound_seconds) VALUES
  ('aaaaaaaa-2222-4000-8000-00000000000d',
   'aaaaaaaa-0000-4000-8000-000000000001', 'chat', 'Chat',
   'tenant-a.chat', 60, 'signal_maker', NULL),
  ('aaaaaaaa-2222-4000-8000-00000000000e',
   'aaaaaaaa-0000-4000-8000-000000000001', 'app', 'App',
   'tenant-a.app', 60, 'signal_maker', NULL);

INSERT INTO channel_actor_mix (org_id, channel_id, actor_type, present) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000d', 'asa',   true),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000d', 'human', false);

INSERT INTO channel_capabilities (org_id, channel_id, capability) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-000000000001', 'response_time'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-000000000001', 'health_uptime'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-000000000001', 'disambiguation'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-000000000001', 'escalation'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-000000000001', 'queue'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000b', 'meca_rum'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000d', 'orga_conversation'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000d', 'resolution'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000d', 'hallucination'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000d', 'meca_rum'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000e', 'resolution');

-- The chat channel's ASA, with its ref (§7.2).
INSERT INTO actors (id, org_id, actor_type, display_id, identity_rung,
                    provider, instances_total, instances_live) VALUES
  ('aaaaaaaa-5555-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001',
   'asa', 'ASA-CHAT-01', 'inferred', 'botplatform', 1, 1);

INSERT INTO actor_external_refs (org_id, actor_id, ref) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000004', 'botplatform:chat-01');
