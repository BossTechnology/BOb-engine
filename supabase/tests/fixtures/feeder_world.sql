-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 2 · the reference feeder's world.
--
-- NOT A MIGRATION. Loaded by the feeder suite into a database already carrying
-- two_orgs.sql and roster.sql. Pairs with feeder_events.json, the business
-- events the in-memory truth store serves.
--
-- What it adds:
--   - tenant B a channel that emits (its fixture channel's source_key is unset,
--     SR-2), so the feeder writes two tenants in two transactions (F-22);
--   - capabilities (§9.1): WhatsApp, the website and B's chat declare
--     orga_conversation; voice declares no label, as Febor voice today;
--   - one agent and one ASA per emitting channel, with their refs (§7.2);
--   - one identified member per tenant, with its history (§9.4).
-- Member refs m:a002 and m:a003 have no actor: they are the ghosts the
-- reconciliation creates. Every value is invented.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO channels (id, org_id, channel_type, display_name, source_key,
                      lag_seconds, adapter_kind, idle_bound_seconds) VALUES
  ('bbbbbbbb-2222-4000-8000-00000000000c',
   'bbbbbbbb-0000-4000-8000-000000000002', 'chat', 'Chat',
   'tenant-b.chat', 60, 'signal_maker', 1800);

INSERT INTO channel_capabilities (org_id, channel_id, capability) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-000000000001', 'orga_conversation'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-000000000001', 'resolution'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000a', 'resolution'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000b', 'orga_conversation'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2222-4000-8000-00000000000b', 'resolution'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-2222-4000-8000-00000000000c', 'orga_conversation'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-2222-4000-8000-00000000000c', 'resolution');

INSERT INTO actors (id, org_id, actor_type, display_id, display_name, identity_rung,
                    provider, instances_total, instances_live) VALUES
  ('aaaaaaaa-5555-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'human', 'AG-2001', 'Agente Demo', 'identified', NULL, NULL, NULL),
  ('aaaaaaaa-5555-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   'asa', 'ASA-FEED-01', NULL, 'inferred', 'botplatform', 1, 1),
  ('aaaaaaaa-5555-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   'user', 'MBR-A001', 'Cliente Demo', 'identified', NULL, NULL, NULL),
  ('bbbbbbbb-5555-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002',
   'human', 'AG-3001', 'Agente B', 'identified', NULL, NULL, NULL),
  ('bbbbbbbb-5555-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002',
   'user', 'MBR-B001', 'Cliente B', 'identified', NULL, NULL, NULL);

-- Agent refs are <source_key>:<external id>; the ASA's is
-- <platform>:<deployment>, the platform being actors.provider (§7.2).
INSERT INTO actor_external_refs (org_id, actor_id, ref) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000001', 'tenant-a.whatsapp:2001'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000002', 'botplatform:web-01'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5555-4000-8000-000000000003', 'm:a001'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-5555-4000-8000-000000000001', 'tenant-b.chat:3001'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-5555-4000-8000-000000000003', 'm:b001');

INSERT INTO actor_ref_history (org_id, ref, actor_id, identity_rung, valid_from) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'm:a001',
   'aaaaaaaa-5555-4000-8000-000000000003', 'identified', '2026-01-01 00:00:00+00'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'm:b001',
   'bbbbbbbb-5555-4000-8000-000000000003', 'identified', '2026-01-01 00:00:00+00');
