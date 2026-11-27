-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 5 · Migration 4 of 6 · evaluation_state, and what alert_log
-- learns
--
-- Spec: docs/slice-5-thresholds.md §6, §7. D-05 keyed breach state on the
-- composite subject; Federico's 10 Nov ruling 3 keys it on (subject, response),
-- so a shallow response's cooldown cannot suppress a deep one.
--
-- Only the evaluator writes evaluation_state (it runs as the migration owner).
-- bob_app and authenticated read their own organization's rows; nobody the
-- application runs as writes them.
--
-- alert_log gains the subject, the response and the bucket, the escalation it
-- may link to, and acknowledged_at: nullable, read and written by nothing in
-- v1 (Federico, 5 Nov ruling 4). It is a cut, not an omission.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE bob.evaluation_state (
  org_id                uuid        NOT NULL REFERENCES bob.organizations (id) ON DELETE CASCADE,
  subject_key           text        NOT NULL,
  response_id           uuid        NOT NULL,
  threshold_id          uuid        NOT NULL,
  channel_id            uuid        NOT NULL,
  actor_type            text,
  breached_since        timestamptz,
  past_level_buckets    integer     NOT NULL DEFAULT 0,
  last_fired_at         timestamptz,
  last_alert_id         uuid,
  escalated_alert_id    uuid,
  inside_since          timestamptz,
  last_bucket_evaluated timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, subject_key, response_id),
  FOREIGN KEY (org_id, response_id) REFERENCES bob.response_rules (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (threshold_id) REFERENCES bob.threshold_configs (id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, last_alert_id) REFERENCES bob.alert_log (org_id, id),
  FOREIGN KEY (org_id, escalated_alert_id) REFERENCES bob.alert_log (org_id, id)
);

COMMENT ON TABLE bob.evaluation_state IS
  'Slice 5 spec §6. Breach state per (subject, response): when the breach began, '
  'the cooldown, the one escalation, the recovery dwell, and the last sealed '
  'bucket evaluated. Written by bob_evaluate alone.';

ALTER TABLE bob.evaluation_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_evaluation_state_read" ON bob.evaluation_state FOR SELECT
  TO authenticated, bob_app
  USING (org_id = (auth.jwt() ->> 'org_id')::uuid);

REVOKE ALL ON bob.evaluation_state
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;
GRANT SELECT ON bob.evaluation_state TO bob_app, authenticated;

ALTER TABLE bob.alert_log
  ADD COLUMN threshold_id       uuid REFERENCES bob.threshold_configs (id) ON DELETE SET NULL,
  ADD COLUMN response_id        uuid,
  ADD COLUMN subject_key        text,
  ADD COLUMN channel_id         uuid,
  ADD COLUMN actor_type         text,
  ADD COLUMN bucket_start       timestamptz,
  ADD COLUMN escalates_alert_id uuid,
  ADD COLUMN acknowledged_at    timestamptz,
  ADD CONSTRAINT alert_log_escalates_fkey
      FOREIGN KEY (org_id, escalates_alert_id) REFERENCES bob.alert_log (org_id, id),
  ADD CONSTRAINT alert_log_escalation_links
      CHECK ((alert_type = 'escalation') = (escalates_alert_id IS NOT NULL));

ALTER TABLE bob.alert_log DROP CONSTRAINT alert_log_alert_type_check;
ALTER TABLE bob.alert_log ADD CONSTRAINT alert_log_alert_type_check
  CHECK (alert_type IN ('upper', 'lower', 'recovery', 'keyword', 'verification_failed',
                        'escalation'));

-- F-50 · an alert keeps its rows. An escalation keys the alert it raises, the
-- way an intention keys the alert that caused it, so the Slice 6 trace guard
-- now finds alert_log itself. Deleting an alert would leave an escalation, an
-- intention or a breach state without its cause. Nobody the application runs
-- as deletes one; only bob_app updates one.
REVOKE DELETE, TRUNCATE ON bob.alert_log FROM bob_app, authenticated;
REVOKE UPDATE ON bob.alert_log FROM authenticated;

COMMENT ON COLUMN bob.alert_log.acknowledged_at IS
  'Deliberate, and unused in v1 (D-05, 5 Nov ruling 4): escalation is time '
  'sustained, not time unacknowledged, and there is no surface to acknowledge '
  'from. Added now so a later acknowledgement touches no existing row shape.';
COMMENT ON COLUMN bob.alert_log.escalates_alert_id IS
  'For alert_type escalation: the alert whose severity this raises, once per breach (RS-04).';

COMMIT;
