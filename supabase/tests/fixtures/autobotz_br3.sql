-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · the five BR-3 rulings — the AutoBotz example set, persisted.
--
-- NOT A MIGRATION. Loaded by the suite into a database already carrying
-- two_orgs.sql.
--
-- These are ab1 to ab5 from the simulator's in-memory seed (window._autoBotz),
-- with the rulings recorded in contract-amendments F-07 (superseded entry).
-- They were never persisted: the demo's bridge speaks the pre-rename schema and
-- is now disabled (ruled 23 Oct 2026). The test compares these rows with that
-- table, so the fixture and the record cannot drift apart.
--
--   ab1 · Auto-Scale Webhook   webhook     mutative  scales infrastructure
--   ab2 · Incident Bridge      webhook     mutative  creates an incident
--   ab3 · Checkout Flow Check  synthetics  mutative  every run is a real order
--   ab4 · CRM Case Opener      rpa         mutative  opens a case
--   ab5 · Root-Cause Triage    agent       inert     analyses, changes nothing
--
-- ab3 is BR-3's own example: the check walks the checkout to completion, so it
-- ships with requires_approval set.
--
-- Shape notes, none of them a ruling:
--   - provider follows the seed, with its misspelling corrected to 'bzzzbx'
--     (R-01).
--   - scope_kind is 'company' for all five. The seed gives ab3 scope 'aba',
--     which is not in the §3.4 set; scope is not what this fixture tests.
--   - ab2's reference keeps the shape of the seed's URL on a fake host.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO autobotz (id, org_id, type, label, provider, reference, scope_kind,
                      binding, mutative, requires_approval) VALUES
  ('aaaaaaaa-3333-4000-8000-0000000000a1',
   'aaaaaaaa-0000-4000-8000-000000000001', 'webhook', 'Auto-Scale Webhook',
   'bzzzbx', 'hooks/scale', 'company',
   '{"method":"POST"}', true, false),
  ('aaaaaaaa-3333-4000-8000-0000000000a2',
   'aaaaaaaa-0000-4000-8000-000000000001', 'webhook', 'Incident Bridge',
   'customer', 'https://hooks.example.test/incident', 'company',
   '{"method":"POST"}', true, false),
  ('aaaaaaaa-3333-4000-8000-0000000000a3',
   'aaaaaaaa-0000-4000-8000-000000000001', 'synthetics', 'Checkout Flow Check',
   'bzzzbx', 'syn/checkout-e2e', 'company',
   '{"env":"production"}', true, true),
  ('aaaaaaaa-3333-4000-8000-0000000000a4',
   'aaaaaaaa-0000-4000-8000-000000000001', 'rpa', 'CRM Case Opener',
   'customer', 'rpa/open-case', 'company',
   '{"params":"queue=support,priority=high"}', true, false),
  ('aaaaaaaa-3333-4000-8000-0000000000a5',
   'aaaaaaaa-0000-4000-8000-000000000001', 'agent', 'Root-Cause Triage',
   'bzzzbx', 'agents/triage-v2', 'company',
   '{"cap":"20 / day"}', false, false);
