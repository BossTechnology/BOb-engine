-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 6 · Migration 1 of 3
-- Webhook entries leave the communication registry for the AutoBotz registry,
-- and every Action response repoints, in this one transaction.
--
-- Three separate migrations would leave Action responses pointing at nothing in
-- between. There is no safe intermediate state, so there is one transaction.
--
-- WHAT A WEBHOOK BECOMES. An AutoBotz binding of type `webhook`: provider
-- `customer`, scope `company`, the entry's single address as the reference.
-- A webhook entry keeps its id as the binding's id, so an Action response that
-- named it in channel_ids repoints by id. An Action response that carried an
-- inline webhook_url gets a binding of its own.
--
-- THE RULING THIS MIGRATION DOES NOT MAKE. BR-3 asks whether invoking a binding
-- changes the world, and no one has asked that of these entries. They move
-- `mutative = true` and `requires_approval = true`: the side that refuses to
-- act, never the side that asserts something nobody checked. An intention for
-- such a binding is written in a state nothing drains (migration 3), and a rule
-- cannot write one at all until the binding declares a limit. A person rules on
-- each, and the reason is in verify_msg. On the chain as it starts, and on the
-- hosted table (0 rows, 6 Sep), nothing moves.
--
-- WHAT STOPS IT. Each refusal names the rows and says what to rule on:
--   - a webhook entry without exactly one address;
--   - an Alert or Alarm response that sends to a webhook (only an Action
--     attaches a binding, and turning an alert into an action is a ruling);
--   - an Action response that does not name exactly one webhook of its own
--     organization.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(format('%s (%s)', nc.id, nc.label), ', ' ORDER BY nc.id) INTO bad
    FROM bob.notification_channels nc
   WHERE nc.type = 'webhook' AND coalesce(array_length(nc."values", 1), 0) <> 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'webhook entries without exactly one address: %. Give each one '
      'address before this migration can proceed.', bad;
  END IF;

  SELECT string_agg(format('%s (%s, %s)', r.id, r.name, r.type), ', ' ORDER BY r.id) INTO bad
    FROM bob.response_rules r
   WHERE r.type <> 'action'
     AND (r.webhook_url IS NOT NULL OR EXISTS (
           SELECT 1 FROM bob.notification_channels nc
            WHERE nc.type = 'webhook' AND nc.id = ANY (r.channel_ids)));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Alert and Alarm responses that send to a webhook: %. A webhook '
      'becomes an AutoBotz binding, which only an Action response attaches. Rule on '
      'each: make it an Action, or remove the webhook.', bad;
  END IF;

  SELECT string_agg(format('%s (%s)', r.id, r.name), ', ' ORDER BY r.id) INTO bad
    FROM bob.response_rules r
   WHERE r.type = 'action'
     AND (SELECT count(*) FROM bob.notification_channels nc
           WHERE nc.type = 'webhook' AND nc.org_id = r.org_id
             AND nc.id = ANY (r.channel_ids))
         + (r.webhook_url IS NOT NULL)::int <> 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Action responses that do not name exactly one webhook of their '
      'own organization: %. Rule on each before this migration can proceed.', bad;
  END IF;
END $$;

-- An Action response and its binding share an organization by key, not by
-- convention: the foreign key below carries org_id.
ALTER TABLE bob.autobotz ADD CONSTRAINT autobotz_org_id_id_key UNIQUE (org_id, id);
ALTER TABLE bob.response_rules ADD COLUMN autobotz_id UUID;

-- ── The entries move, keeping their ids ─────────────────────────────────────
INSERT INTO bob.autobotz (id, org_id, type, label, provider, scope_kind, reference,
                          binding, mutative, requires_approval, verify_msg)
SELECT nc.id, nc.org_id, 'webhook', nc.label, 'customer', 'company', nc."values"[1],
       '{"method":"POST"}'::jsonb, true, true,
       'Moved from the communication registry in Slice 6. Not yet ruled on: '
       || 'mutative and requires_approval are set until someone rules'
  FROM bob.notification_channels nc
 WHERE nc.type = 'webhook';

UPDATE bob.response_rules r
   SET autobotz_id = nc.id,
       channel_ids = array_remove(r.channel_ids, nc.id)
  FROM bob.notification_channels nc
 WHERE r.type = 'action' AND nc.type = 'webhook'
   AND nc.org_id = r.org_id AND nc.id = ANY (r.channel_ids);

-- ── Inline webhooks become bindings of their own ────────────────────────────
UPDATE bob.response_rules
   SET autobotz_id = gen_random_uuid()
 WHERE type = 'action' AND webhook_url IS NOT NULL;

INSERT INTO bob.autobotz (id, org_id, type, label, provider, scope_kind, reference,
                          binding, mutative, requires_approval, verify_msg)
SELECT r.autobotz_id, r.org_id, 'webhook', coalesce(nullif(r.name, ''), 'Action webhook'),
       'customer', 'company', r.webhook_url,
       jsonb_strip_nulls(jsonb_build_object(
         'method', coalesce(r.webhook_method, 'POST'), 'payload', r.webhook_payload)),
       true, true,
       'Moved from an inline Action webhook in Slice 6. Not yet ruled on: '
       || 'mutative and requires_approval are set until someone rules'
  FROM bob.response_rules r
 WHERE r.type = 'action' AND r.webhook_url IS NOT NULL;

-- ── Only an Action attaches a binding, and it always does ───────────────────
ALTER TABLE bob.response_rules
  ADD CONSTRAINT response_rules_autobotz_fkey
      FOREIGN KEY (org_id, autobotz_id) REFERENCES bob.autobotz (org_id, id),
  ADD CONSTRAINT response_rules_action_binding_check
      CHECK ((type = 'action') = (autobotz_id IS NOT NULL)),
  DROP COLUMN webhook_url,
  DROP COLUMN webhook_method,
  DROP COLUMN webhook_payload;

CREATE INDEX idx_rr_autobotz ON bob.response_rules (autobotz_id);

-- ── The communication registry no longer holds webhooks ─────────────────────
DELETE FROM bob.notification_channels WHERE type = 'webhook';

ALTER TABLE bob.notification_channels
  DROP CONSTRAINT notification_channels_type_check,
  ADD CONSTRAINT notification_channels_type_check
      CHECK (type IN ('email', 'sms', 'call', 'slack'));

COMMENT ON COLUMN bob.response_rules.autobotz_id IS
  'The AutoBotz binding an Action response attaches. Set for every Action and '
  'for nothing else. Slice 6: webhooks are bindings, not communication entries.';

COMMIT;
