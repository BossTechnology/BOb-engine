-- Slice 6, in pgTAP: the shape the node suite (tests/slice6-registries-outbox.test.mjs)
-- exercises. `supabase test db supabase/tests/database` runs this; the bare
-- command also picks up supabase/tests/fixtures/*.sql, which are not tests.
BEGIN;
SELECT plan(9);

SELECT has_table('bob', 'outbound_queue', 'the outbox exists');
SELECT policies_are('bob', 'outbound_queue', ARRAY['org_outbound_queue'],
  'the outbox has exactly its tenant policy');
SELECT is(public.bob_autobotz_state('ok', now() - interval '31 days', now()), 'stale',
  'RS-31: stale is derived past the window');
SELECT is(public.bob_autobotz_state('ok', now(), now()), 'ok', 'RS-31: fresh is ok');
SELECT isnt(public.bob_autobotz_state('unverified', NULL, now()), 'ok',
  'RS-30: never-verified is not verified');
SELECT hasnt_column('bob', 'response_rules', 'webhook_url', 'webhooks left the response rules');
SELECT has_column('bob', 'response_rules', 'autobotz_id', 'Action responses point at a binding');
SELECT has_column('bob', 'outbound_queue', 'alert_log_id', 'an intention carries its alert');
SELECT throws_ok(
  $$INSERT INTO bob.notification_channels (org_id, type, label, values)
    VALUES ('00000000-0000-4000-8000-000000000000', 'webhook', 'x', '{https://x.example.test}')$$,
  '23514', NULL, 'the communication registry refuses a webhook (CHECK runs before the key)');

SELECT * FROM finish();
ROLLBACK;
