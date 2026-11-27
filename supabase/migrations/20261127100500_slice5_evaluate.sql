-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 5 · Migration 6 of 6 · The evaluator (step 19)
--
-- Spec: docs/slice-5-thresholds.md §7, §8, §9. D-05 and D-31.
--
-- bob_evaluation_input(org, from, to)  SQL-standard body: bob_threshold_status
--                                      crossed with the responses, ordered. The
--                                      evaluator reads the breach only through
--                                      it, so pg_depend can show that.
-- bob_evaluate_at(org, at)             the loop, with an injected clock
-- bob_evaluate(org)                    the same at clock_timestamp()
--
-- FOR EACH (subject, response), in bucket order, after the last one evaluated
-- and no further back than 24 hours:
--   not evaluated  reported with its reason. An unsealed bucket stops the
--                  subject there (it is evaluated once it seals); a sealed
--                  absent one is passed, and breaks every consecutive count.
--   breach         past this response's level for its sustained buckets, and
--                  the cooldown clear: write the alert, and for an Action the
--                  intention. Escalate once, one step up, after the effective
--                  escalation time sustained.
--   inside         after the recovery dwell, write the recovery (no cooldown)
--                  and clear the cooldown, the breach and the escalation.
-- Time is the bucket's, not the wall clock's: a cooldown is measured from the
-- end of the bucket that fired, so a pass that catches up decides as the
-- passes it replaces would have.
--
-- WHO RUNS IT. SECURITY DEFINER, owned by the migration owner. The tenant is an
-- argument and every read and write filters on it (F-02's obligation). No
-- EXECUTE for PUBLIC or any role the application runs as: which caller runs it
-- on a box is P5's question (spec §9). Nothing schedules it in this chain.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE FUNCTION bob.bob_evaluation_input(p_org uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  threshold_id uuid, subject_key text, channel_id uuid, metric text, actor_type text,
  bucket_start timestamptz, status text, side text, bound numeric, value numeric,
  severity text, sealed boolean, in_peak_window boolean, reasons text[],
  upper_bound numeric, lower_bound numeric,
  response_id uuid, response_type text, trigger_level numeric, sustained_for_seconds integer,
  cooldown_seconds integer, escalation_after_seconds integer, recovery_dwell_seconds integer
)
LANGUAGE sql STABLE
SET search_path = bob, public
BEGIN ATOMIC
  SELECT s.threshold_id, s.subject_key, s.channel_id, s.metric, s.actor_type,
         s.bucket_start, s.status, s.side, s.bound, s.value, s.severity, s.sealed,
         s.in_peak_window, s.reasons, t.upper_bound, t.lower_bound,
         r.id, r.type, r.trigger_level, r.sustained_for_seconds,
         (bob.bob_effective_durations(t)).cooldown_seconds,
         (bob.bob_effective_durations(t)).escalation_after_seconds,
         (bob.bob_effective_durations(t)).recovery_dwell_seconds
    FROM bob.bob_threshold_status(
           p_org, ARRAY(SELECT c.id FROM bob.channels c WHERE c.org_id = p_org),
           p_from, p_to) s
    JOIN bob.threshold_configs t ON t.id = s.threshold_id AND t.org_id = p_org
    JOIN bob.response_rules r ON r.threshold_id = t.id AND r.org_id = p_org
   ORDER BY s.subject_key, r.id, s.bucket_start;
END;

CREATE FUNCTION bob.bob_evaluate_at(p_org uuid, p_at timestamptz)
RETURNS TABLE (threshold_id uuid, subject_key text, response_id uuid,
               bucket_start timestamptz, outcome text, reasons text[], alert_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = bob, public
AS $$
#variable_conflict use_column
DECLARE
  horizon   timestamptz;
  x         record;
  st        bob.evaluation_state;
  have      boolean := false;
  stopped   boolean := false;
  bend      timestamptz;
  need      integer;
  lvl       numeric;
  lvl_side  text;
  past      boolean;
  a_id      uuid;
  q_state   text;
  q_reason  text;
  prev_sev  text;
  esc_id    uuid;
  first_id  uuid;
BEGIN
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM bob.organizations o WHERE o.id = p_org) THEN
    RAISE EXCEPTION 'bob_evaluate needs an organization that exists, given %', p_org
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'bob_evaluate needs a time' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  horizon := date_bin('5 minutes', p_at - interval '24 hours', TIMESTAMPTZ '1970-01-01 00:00:00+00');

  FOR x IN SELECT * FROM bob.bob_evaluation_input(p_org, horizon, p_at) LOOP
    IF NOT have OR x.subject_key IS DISTINCT FROM st.subject_key
       OR x.response_id IS DISTINCT FROM st.response_id THEN
      IF have THEN
        INSERT INTO bob.evaluation_state AS e VALUES (st.*)
        ON CONFLICT (org_id, subject_key, response_id) DO UPDATE SET
          breached_since = EXCLUDED.breached_since, past_level_buckets = EXCLUDED.past_level_buckets,
          last_fired_at = EXCLUDED.last_fired_at, last_alert_id = EXCLUDED.last_alert_id,
          escalated_alert_id = EXCLUDED.escalated_alert_id, inside_since = EXCLUDED.inside_since,
          last_bucket_evaluated = EXCLUDED.last_bucket_evaluated, updated_at = clock_timestamp();
      END IF;
      SELECT * INTO st FROM bob.evaluation_state e
       WHERE e.org_id = p_org AND e.subject_key = x.subject_key AND e.response_id = x.response_id;
      IF NOT FOUND THEN
        st := ROW(p_org, x.subject_key, x.response_id, x.threshold_id, x.channel_id, x.actor_type,
                  NULL, 0, NULL, NULL, NULL, NULL, NULL, clock_timestamp())::bob.evaluation_state;
      END IF;
      have := true;
      stopped := false;
      IF st.last_bucket_evaluated IS NOT NULL
         AND st.last_bucket_evaluated < horizon - interval '5 minutes' THEN
        threshold_id := x.threshold_id; subject_key := x.subject_key; response_id := x.response_id;
        bucket_start := st.last_bucket_evaluated; outcome := 'refused';
        reasons := ARRAY['catch_up_window_exceeded']; alert_id := NULL;
        RETURN NEXT;
        st.past_level_buckets := 0;
        st.inside_since := NULL;
      END IF;
    END IF;

    CONTINUE WHEN stopped;
    CONTINUE WHEN st.last_bucket_evaluated IS NOT NULL AND x.bucket_start <= st.last_bucket_evaluated;

    threshold_id := x.threshold_id; subject_key := x.subject_key; response_id := x.response_id;
    bucket_start := x.bucket_start; reasons := x.reasons; alert_id := NULL;
    bend := x.bucket_start + interval '5 minutes';

    IF x.status = 'not_evaluated' THEN
      outcome := 'refused';
      RETURN NEXT;
      IF NOT x.sealed THEN
        stopped := true;
        CONTINUE;
      END IF;
      st.past_level_buckets := 0;
      st.inside_since := NULL;
      st.last_bucket_evaluated := x.bucket_start;
      CONTINUE;
    END IF;

    outcome := NULL;
    IF x.status = 'breach' THEN
      st.breached_since := coalesce(st.breached_since, x.bucket_start);
      st.inside_since := NULL;
      IF x.trigger_level IS NULL THEN
        lvl := x.bound; lvl_side := x.side;
      ELSE
        lvl := x.trigger_level;
        lvl_side := CASE WHEN x.upper_bound IS NOT NULL AND x.trigger_level >= x.upper_bound
                         THEN 'upper' ELSE 'lower' END;
      END IF;
      past := x.side = lvl_side AND CASE lvl_side WHEN 'upper' THEN x.value > lvl
                                                  ELSE x.value < lvl END;
      st.past_level_buckets := CASE WHEN past THEN st.past_level_buckets + 1 ELSE 0 END;
      need := CASE WHEN x.sustained_for_seconds IS NULL THEN 1
                   ELSE ceil(x.sustained_for_seconds / 300.0)::integer END;

      IF st.past_level_buckets >= need
         AND (st.last_fired_at IS NULL
              OR bend - st.last_fired_at >= x.cooldown_seconds * interval '1 second') THEN
        IF x.in_peak_window THEN
          outcome := 'suppressed_peak_window';
        ELSE
          INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type, value, threshold,
                 severity, responses_fired, threshold_id, response_id, subject_key, channel_id,
                 actor_type, bucket_start)
          VALUES (p_org, x.metric, x.metric, x.side, x.value, lvl, x.severity,
                  jsonb_build_array(x.response_id), x.threshold_id, x.response_id, x.subject_key,
                  x.channel_id, x.actor_type, x.bucket_start)
          RETURNING id INTO a_id;
          st.last_fired_at := bend;
          st.last_alert_id := a_id;
          alert_id := a_id;
          outcome := 'fired';
          IF x.response_type = 'action' THEN
            BEGIN
              INSERT INTO bob.outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
              VALUES (p_org, x.response_id, a_id, a_id::text)
              RETURNING state, suppressed_reason INTO q_state, q_reason;
              outcome := 'fired_intention_' || q_state;
              IF q_reason IS NOT NULL THEN reasons := reasons || q_reason; END IF;
            EXCEPTION WHEN check_violation THEN
              outcome := 'fired_intention_refused';
              reasons := reasons || SQLERRM;
            END;
          END IF;
        END IF;
        RETURN NEXT;
      END IF;

      -- Escalation: once per subject and breach, however many responses the
      -- subject has, and only if an alert was fired in this breach (spec §7).
      -- The breach is the subject's; the firing is the response's.
      IF st.escalated_alert_id IS NULL AND NOT x.in_peak_window
         AND bend - st.breached_since >= x.escalation_after_seconds * interval '1 second' THEN
        SELECT a.id INTO esc_id FROM bob.alert_log a
         WHERE a.org_id = p_org AND a.subject_key = x.subject_key
           AND a.alert_type = 'escalation' AND a.bucket_start >= st.breached_since
         LIMIT 1;
        IF esc_id IS NOT NULL THEN
          st.escalated_alert_id := esc_id;
        ELSE
          SELECT a.id, a.severity INTO first_id, prev_sev FROM bob.alert_log a
           WHERE a.org_id = p_org AND a.subject_key = x.subject_key
             AND a.alert_type IN ('upper', 'lower') AND a.bucket_start >= st.breached_since
           ORDER BY a.bucket_start, a.created_at, a.id
           LIMIT 1;
          IF first_id IS NOT NULL THEN
            INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type, value, threshold,
                   severity, responses_fired, threshold_id, response_id, subject_key, channel_id,
                   actor_type, bucket_start, escalates_alert_id)
            VALUES (p_org, x.metric, x.metric, 'escalation', x.value, x.bound,
                    CASE prev_sev WHEN 'info' THEN 'warning' ELSE 'critical' END,
                    '[]'::jsonb, x.threshold_id, x.response_id, x.subject_key, x.channel_id,
                    x.actor_type, x.bucket_start, first_id)
            RETURNING id INTO a_id;
            st.escalated_alert_id := a_id;
            alert_id := a_id; outcome := 'escalated'; reasons := x.reasons;
            RETURN NEXT;
          END IF;
        END IF;
      END IF;
    ELSE
      st.past_level_buckets := 0;
      IF st.breached_since IS NOT NULL THEN
        st.inside_since := coalesce(st.inside_since, x.bucket_start);
        IF bend - st.inside_since >= x.recovery_dwell_seconds * interval '1 second' THEN
          IF st.last_alert_id IS NOT NULL AND NOT x.in_peak_window THEN
            INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type, value, threshold,
                   severity, responses_fired, threshold_id, response_id, subject_key, channel_id,
                   actor_type, bucket_start)
            VALUES (p_org, x.metric, x.metric, 'recovery', x.value, x.bound, 'info', '[]'::jsonb,
                    x.threshold_id, x.response_id, x.subject_key, x.channel_id, x.actor_type,
                    x.bucket_start)
            RETURNING id INTO a_id;
            alert_id := a_id; outcome := 'recovered';
            RETURN NEXT;
          END IF;
          -- A recovery ends the breach and clears its cooldown (5 Nov, ruling 5).
          st.breached_since := NULL; st.inside_since := NULL; st.last_fired_at := NULL;
          st.last_alert_id := NULL; st.escalated_alert_id := NULL;
        END IF;
      END IF;
    END IF;
    IF outcome IS NULL AND x.in_peak_window THEN
      outcome := 'evaluated'; RETURN NEXT;
    END IF;
    st.last_bucket_evaluated := x.bucket_start;
  END LOOP;

  IF have THEN
    INSERT INTO bob.evaluation_state AS e VALUES (st.*)
    ON CONFLICT (org_id, subject_key, response_id) DO UPDATE SET
      breached_since = EXCLUDED.breached_since, past_level_buckets = EXCLUDED.past_level_buckets,
      last_fired_at = EXCLUDED.last_fired_at, last_alert_id = EXCLUDED.last_alert_id,
      escalated_alert_id = EXCLUDED.escalated_alert_id, inside_since = EXCLUDED.inside_since,
      last_bucket_evaluated = EXCLUDED.last_bucket_evaluated, updated_at = clock_timestamp();
  END IF;
END $$;

CREATE FUNCTION bob.bob_evaluate(p_org uuid)
RETURNS TABLE (threshold_id uuid, subject_key text, response_id uuid,
               bucket_start timestamptz, outcome text, reasons text[], alert_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = bob, public
BEGIN ATOMIC
  SELECT * FROM bob.bob_evaluate_at(p_org, clock_timestamp());
END;

COMMENT ON FUNCTION bob.bob_evaluate(uuid) IS
  'Slice 5 spec §9. The evaluator for one organization, named explicitly. No role '
  'the application runs as may execute it; the caller on a box is a P5 question.';

REVOKE ALL ON FUNCTION
  bob.bob_evaluation_input(uuid, timestamptz, timestamptz),
  bob.bob_evaluate_at(uuid, timestamptz),
  bob.bob_evaluate(uuid)
FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;

COMMIT;
