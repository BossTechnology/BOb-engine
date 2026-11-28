-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 5 · The security review of 27 Nov (F-52 to F-55, nits)
--
-- An independent review of ee90c6b approved Slice 5 with nits; #63 was merged
-- at that commit before the fixes were written, so they come here, after it.
-- Febor's box has viewers. Spec: docs/slice-5-thresholds.md §10.
--
--   F-52 · authenticated inserts no intention. A refusal is a row that counts
--          toward no limit (F-49), so a viewer could fill the outbox.
--   F-53 · alert_log is written only as the owner (the evaluator, and the RS-33
--          trigger inside the definer that records a verification). The
--          evaluator reads it for a breach's first alert and its escalation,
--          so a row written by bob_app or a member could silence a real one.
--   F-54 · peak_windows must be an array of {start, end} in HH:MM. A malformed
--          value made bob_threshold_status raise, and with it the evaluator
--          of the whole organization.
--   F-55 · one evaluation of an organization at a time.
--   F-58 · no application role holds a table privilege on bob beyond
--          SELECT, INSERT, UPDATE and DELETE (review of 8ab846e, critical):
--          TRIGGER, REFERENCES (also on a column), TRUNCATE, MAINTAIN on 17.
--          The tables were created in public, where Supabase's default
--          privileges give arwdxt (arwdDxtm on the box image), and moved to
--          bob with that ACL; Slice 2 revoked the four DML rights only. A
--          member could create a trigger on alert_log that stops the
--          evaluator for every tenant. The same as scripts/f58 (#67).
--   F-59 · a threshold's bounds cannot move past a response's trigger_level.
--   Nits · the threshold and response an alert names, and the threshold of a
--          breach state, are keyed with the organization; the definers end
--          their search_path with pg_temp.
--
-- Consumer check, outside this repository: anything in bob-web or Bob-New
-- that inserts intentions as a member, or inserts or updates alert_log as
-- bob_app or as a member. bob_app keeps its INSERT on the outbox.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── F-58 ───────────────────────────────────────────────────────────────────
-- Every table privilege but SELECT, INSERT, UPDATE and DELETE is taken from
-- every application role, as scripts/f58/revocar.sql does after 00f79b7: on
-- the box image (17.6) a table postgres made in public carries arwdDxtm for
-- anon, authenticated and service_role, so TRUNCATE and MAINTAIN too, and a
-- column may carry REFERENCES. The relations and the privilege types are read
-- from the catalog (aclexplode), so MAINTAIN is taken without being named and
-- a type nobody has named yet would be too. Schema bob holds no default
-- privileges, so a table created later gets none of these; the default
-- privileges of public are Supabase's, and the resto creates nothing there
-- (F-51).
--
-- Checked here, not only in the suite: on a box the grants were made by the
-- chain's postgres and bob_migrador pushes this file, so a REVOKE that could
-- not take one away would warn and carry on. This refuses instead. And the
-- four this step must not touch are compared before and after (F-52 and F-53
-- below take some of them on purpose, after this block).
DO $$
DECLARE
  app  text[] := ARRAY['anon', 'authenticated', 'service_role', 'bob_app', 'bob_feeder', 'bob_ai_ro'];
  extra text[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']
    || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
  g record; left_over text; dml_before text[]; dml_after text[]; rels int;
BEGIN
  SELECT count(*) INTO rels FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob'
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f');
  IF rels = 0 THEN
    RAISE EXCEPTION 'F-58: schema bob holds no relation: nothing was checked';
  END IF;

  dml_before := ARRAY(
    SELECT r.rolname || ' ' || p || ' ' || c.oid::regclass::text || ' '
           || has_table_privilege(r.oid, c.oid, p) || ' '
           || CASE WHEN p <> 'DELETE' THEN has_any_column_privilege(r.oid, c.oid, p)::text ELSE '-' END
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob',
           pg_roles r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND r.rolname = ANY (app)
     ORDER BY 1);

  -- Table-wide: each grant found in the ACL, to an application role or PUBLIC.
  FOR g IN
    SELECT DISTINCT c.oid::regclass::text AS rel, a.privilege_type AS priv,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS rol
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob',
           aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND (a.grantee = 0 OR r.rolname = ANY (app))
       AND a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  LOOP
    EXECUTE format('REVOKE %s ON %s FROM %s', g.priv, g.rel, g.rol);
  END LOOP;

  -- On a column: REFERENCES, the one column privilege outside the four.
  FOR g IN
    SELECT DISTINCT c.oid::regclass::text AS rel, quote_ident(t.attname) AS col,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END AS rol
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob'
      JOIN pg_attribute t ON t.attrelid = c.oid AND t.attnum > 0 AND NOT t.attisdropped,
           aclexplode(t.attacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE (a.grantee = 0 OR r.rolname = ANY (app)) AND a.privilege_type = 'REFERENCES'
  LOOP
    EXECUTE format('REVOKE REFERENCES (%s) ON %s FROM %s', g.col, g.rel, g.rol);
  END LOOP;

  -- Nothing left: by inheritance, in the ACL under any type, or on a column.
  SELECT string_agg(x, ', ' ORDER BY x) INTO left_over FROM (
    SELECT r.rolname || ' ' || e.p || ' ' || c.oid::regclass::text AS x
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob',
           pg_roles r, unnest(extra) e(p)
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND r.rolname = ANY (app)
       AND has_table_privilege(r.oid, c.oid, e.p)
    UNION
    SELECT coalesce(r.rolname, 'PUBLIC') || ' ' || a.privilege_type || ' ' || c.oid::regclass::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob',
           aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND (a.grantee = 0 OR r.rolname = ANY (app))
       AND a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    UNION
    SELECT r.rolname || ' REFERENCES (column) ' || c.oid::regclass::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob', pg_roles r
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND r.rolname = ANY (app)
       AND has_any_column_privilege(r.oid, c.oid, 'REFERENCES')) q;
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION 'F-58: still held after the revoke: %', left_over
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  dml_after := ARRAY(
    SELECT r.rolname || ' ' || p || ' ' || c.oid::regclass::text || ' '
           || has_table_privilege(r.oid, c.oid, p) || ' '
           || CASE WHEN p <> 'DELETE' THEN has_any_column_privilege(r.oid, c.oid, p)::text ELSE '-' END
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob',
           pg_roles r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND r.rolname = ANY (app)
     ORDER BY 1);
  IF dml_after IS DISTINCT FROM dml_before THEN
    RAISE EXCEPTION 'F-58: SELECT, INSERT, UPDATE or DELETE changed';
  END IF;
END $$;

-- With TRIGGER gone nobody else can attach a function to a table, and a
-- trigger runs its function whatever the firing role holds. EXECUTE on bob's
-- trigger functions is also taken from PUBLIC, the ones this migration may
-- change (the owner's), discovered. Those in public belong to the install
-- chain (postgres) and wait for its next signature.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'bob'
            WHERE p.prorettype = 'trigger'::regtype
              AND pg_has_role(current_user, p.proowner, 'USAGE') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, '
                   'service_role, bob_app, bob_feeder, bob_ai_ro', f);
  END LOOP;
END $$;

-- ── F-52 ───────────────────────────────────────────────────────────────────
REVOKE INSERT ON bob.outbound_queue FROM authenticated;

-- ── F-53 ───────────────────────────────────────────────────────────────────
-- DELETE and TRUNCATE went in migration 20261127100300 (F-50).
REVOKE INSERT, UPDATE ON bob.alert_log FROM bob_app, authenticated;

-- ── F-54 ───────────────────────────────────────────────────────────────────
CREATE FUNCTION bob.bob_peak_windows_valid(w jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path = bob, pg_temp
BEGIN ATOMIC
  SELECT CASE WHEN jsonb_typeof(w) IS DISTINCT FROM 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(w) e
       WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
          OR jsonb_typeof(e -> 'start') IS DISTINCT FROM 'string'
          OR jsonb_typeof(e -> 'end') IS DISTINCT FROM 'string'
          OR (e ->> 'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          OR (e ->> 'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  END;
END;

-- Validated, not NOT VALID: a row that would break its organization's
-- evaluation stops the install instead of waiting for the evaluator.
ALTER TABLE bob.threshold_configs
  ADD CONSTRAINT threshold_configs_peak_windows_shape
      CHECK (bob.bob_peak_windows_valid(peak_windows));

-- ── Nits · keyed with the organization ─────────────────────────────────────
ALTER TABLE bob.threshold_configs
  ADD CONSTRAINT threshold_configs_org_id_id_key UNIQUE (org_id, id);

ALTER TABLE bob.alert_log
  DROP CONSTRAINT alert_log_threshold_id_fkey,
  ADD CONSTRAINT alert_log_threshold_fkey
      FOREIGN KEY (org_id, threshold_id) REFERENCES bob.threshold_configs (org_id, id)
      ON DELETE SET NULL (threshold_id),
  ADD CONSTRAINT alert_log_response_fkey
      FOREIGN KEY (org_id, response_id) REFERENCES bob.response_rules (org_id, id)
      ON DELETE SET NULL (response_id);

ALTER TABLE bob.evaluation_state
  DROP CONSTRAINT evaluation_state_threshold_id_fkey,
  ADD CONSTRAINT evaluation_state_threshold_fkey
      FOREIGN KEY (org_id, threshold_id) REFERENCES bob.threshold_configs (org_id, id)
      ON DELETE CASCADE;

-- ── F-59 ───────────────────────────────────────────────────────────────────
-- bob_response_level_check runs when a response is written. Moving the
-- threshold's bounds afterwards could leave a level inside them, which fires
-- before the threshold breaches. The same rule, from the other side.
CREATE FUNCTION bob.bob_threshold_bounds_check()
RETURNS trigger LANGUAGE plpgsql
SET search_path = bob, pg_temp
AS $$
DECLARE bad uuid;
BEGIN
  SELECT r.id INTO bad FROM bob.response_rules r
   WHERE r.org_id = NEW.org_id AND r.threshold_id = NEW.id AND r.trigger_level IS NOT NULL
     AND NOT (   (NEW.upper_bound IS NOT NULL AND r.trigger_level >= NEW.upper_bound)
              OR (NEW.lower_bound IS NOT NULL AND r.trigger_level <= NEW.lower_bound))
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'threshold % (% to %) would put the trigger_level of response % inside its bounds',
      NEW.id, NEW.lower_bound, NEW.upper_bound, bad USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION bob.bob_threshold_bounds_check()
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;

CREATE TRIGGER trg_threshold_bounds_check
  AFTER UPDATE OF upper_bound, lower_bound ON bob.threshold_configs
  FOR EACH ROW EXECUTE FUNCTION bob.bob_threshold_bounds_check();

-- ── F-55 ───────────────────────────────────────────────────────────────────
-- Replaced whole; only the lock after the two argument checks is new. Its
-- privileges (none for any application role) are kept by OR REPLACE.
CREATE OR REPLACE FUNCTION bob.bob_evaluate_at(p_org uuid, p_at timestamptz)
RETURNS TABLE (threshold_id uuid, subject_key text, response_id uuid,
               bucket_start timestamptz, outcome text, reasons text[], alert_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = bob, public, pg_temp
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
  -- One evaluation of an organization at a time (F-55): two passes reading
  -- the same state before either writes it would both fire, past the
  -- cooldown. Held to the end of the caller's transaction; another
  -- organization is not held.
  PERFORM pg_advisory_xact_lock(hashtextextended('bob_evaluate ' || p_org::text, 0));
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

-- ── Nit · pg_temp last in the definer that wraps it ────────────────────────
CREATE OR REPLACE FUNCTION bob.bob_evaluate(p_org uuid)
RETURNS TABLE (threshold_id uuid, subject_key text, response_id uuid,
               bucket_start timestamptz, outcome text, reasons text[], alert_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = bob, public, pg_temp
BEGIN ATOMIC
  SELECT * FROM bob.bob_evaluate_at(p_org, clock_timestamp());
END;

COMMIT;
