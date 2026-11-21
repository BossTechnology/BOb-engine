-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 6 · Migration 2 of 3
-- Verification as Behavioural Rules RS-30 to RS-35 have it, the limit a
-- real-world binding must declare, and registry scope completed (ID-11, F-05).
--
-- RS-30  Four states a person can tell apart: unverified, ok, failed, stale.
--        Three are stored; the stored state and its timestamp cannot disagree,
--        so a never-verified binding is one with no verification time.
-- RS-31  Stale is derived: public.bob_autobotz_state() reads it from
--        verified_at and a 30-day window. Nothing stores it, so nothing has to
--        remember to write it.
-- RS-32  A change to what is invoked (type, provider, reference, binding)
--        returns the state to unverified in the same UPDATE, whatever that
--        UPDATE asked for. The label is not what is invoked.
-- RS-33  A failed verification writes an alert_log row, whichever path wrote
--        the failure.
-- RS-34  bob.v_action_binding_picker: every binding with its derived state, at
--        the point an Action response attaches one.
-- RS-35  public.bob_autobotz_record_verification() records a result and
--        touches nothing else. Resolving the reference happens outside the
--        database and invokes nothing; that half is not testable here.
--
-- THE LIMIT. A rule may not attach a binding that changes the real world
-- unless the binding declares a usage limit: rate_limit_per_hour or
-- invocation_cap_daily. concurrency_limit bounds how many run at once, not how
-- many there are, so it does not count. Enforced when a rule attaches, and when
-- an attached binding's limits or ruling change. Rows attached before this
-- migration (only those migration 1 moved, all requires_approval) are visibly
-- exempt, as with the BR-3 constraint, and migration 3 refuses an intention for
-- them anyway:
--   SELECT r.id, a.id FROM bob.response_rules r JOIN bob.autobotz a ON a.id = r.autobotz_id
--    WHERE a.mutative AND a.rate_limit_per_hour IS NULL AND a.invocation_cap_daily IS NULL;
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ID-11 · scope on the three registries that lacked it (F-05) ─────────────
ALTER TABLE bob.threshold_configs
  ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'company',
  ADD COLUMN scope_ref  TEXT,
  ADD CONSTRAINT threshold_configs_scope_kind_check
      CHECK (scope_kind IN ('company', 'metric', 'entity', 'actor'));
ALTER TABLE bob.anomaly_rules
  ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'company',
  ADD COLUMN scope_ref  TEXT,
  ADD CONSTRAINT anomaly_rules_scope_kind_check
      CHECK (scope_kind IN ('company', 'metric', 'entity', 'actor'));
ALTER TABLE bob.text_rules
  ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'company',
  ADD COLUMN scope_ref  TEXT,
  ADD CONSTRAINT text_rules_scope_kind_check
      CHECK (scope_kind IN ('company', 'metric', 'entity', 'actor'));

-- ── RS-30 · the stored state and its time agree ─────────────────────────────
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(format('%s (%s, %s)', id, label, verify_state), ', ' ORDER BY id)
    INTO bad FROM bob.autobotz
   WHERE (verify_state = 'unverified') <> (verified_at IS NULL);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AutoBotz bindings whose state and verification time disagree: %. '
      'Re-verify each, or set it unverified with no time.', bad;
  END IF;
END $$;

ALTER TABLE bob.autobotz
  ADD CONSTRAINT autobotz_verified_at_matches_state
      CHECK ((verify_state = 'unverified') = (verified_at IS NULL)),
  ADD CONSTRAINT autobotz_limits_positive
      CHECK (coalesce(rate_limit_per_hour, 1) > 0
         AND coalesce(concurrency_limit, 1) > 0
         AND coalesce(invocation_cap_daily, 1) > 0);

-- ── RS-31 · freshness, derived ──────────────────────────────────────────────
CREATE FUNCTION public.bob_autobotz_freshness_window()
RETURNS interval LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT interval '30 days' $$;

CREATE FUNCTION public.bob_autobotz_state(verify_state text, verified_at timestamptz,
                                          at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN verify_state = 'ok'
            AND verified_at <= at - public.bob_autobotz_freshness_window() THEN 'stale'
           ELSE verify_state
         END
$$;

COMMENT ON FUNCTION public.bob_autobotz_state(text, timestamptz, timestamptz) IS
  'RS-30, RS-31. The state a person sees: unverified, ok, failed, or stale, which '
  'is ok past the freshness window. Derived, never stored.';

-- ── RS-32 · a change to what is invoked invalidates the verification ────────
CREATE FUNCTION public.bob_autobotz_invalidate_on_change()
RETURNS trigger LANGUAGE plpgsql
SET search_path = bob, public
AS $$
BEGIN
  IF (NEW.type, NEW.provider, NEW.reference, NEW.binding)
     IS DISTINCT FROM (OLD.type, OLD.provider, OLD.reference, OLD.binding) THEN
    NEW.verify_state := 'unverified';
    NEW.verified_at  := NULL;
    NEW.verify_msg   := 'The binding changed, so its verification no longer applies';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_autobotz_invalidate_on_change
  BEFORE UPDATE ON bob.autobotz
  FOR EACH ROW EXECUTE FUNCTION public.bob_autobotz_invalidate_on_change();

-- ── RS-33 · a failed verification is an alert ───────────────────────────────
ALTER TABLE bob.alert_log
  ADD COLUMN autobotz_id UUID,
  ADD CONSTRAINT alert_log_org_id_id_key UNIQUE (org_id, id),
  ADD CONSTRAINT alert_log_autobotz_fkey
      FOREIGN KEY (org_id, autobotz_id) REFERENCES bob.autobotz (org_id, id)
      ON DELETE SET NULL (autobotz_id),
  DROP CONSTRAINT alert_log_alert_type_check,
  ADD CONSTRAINT alert_log_alert_type_check
      CHECK (alert_type IN ('upper', 'lower', 'recovery', 'keyword', 'verification_failed'));

CREATE FUNCTION public.bob_autobotz_alert_on_failure()
RETURNS trigger LANGUAGE plpgsql
SET search_path = bob, public
AS $$
BEGIN
  IF NEW.verify_state = 'failed'
     AND (TG_OP = 'INSERT'
          OR OLD.verify_state IS DISTINCT FROM 'failed'
          OR OLD.verified_at IS DISTINCT FROM NEW.verified_at) THEN
    INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type, severity, autobotz_id)
    VALUES (NEW.org_id, 'autobotz_verification', NEW.label, 'verification_failed',
            'warning', NEW.id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_autobotz_alert_on_failure
  AFTER INSERT OR UPDATE OF verify_state, verified_at ON bob.autobotz
  FOR EACH ROW EXECUTE FUNCTION public.bob_autobotz_alert_on_failure();

-- ── RS-35 · recording a verification touches the registry and nothing else ──
CREATE FUNCTION public.bob_autobotz_record_verification(
  p_autobotz_id uuid, p_ok boolean, p_message text, p_at timestamptz DEFAULT now())
RETURNS text LANGUAGE plpgsql
SET search_path = bob, public
AS $$
DECLARE s text;
BEGIN
  UPDATE bob.autobotz
     SET verify_state = CASE WHEN p_ok THEN 'ok' ELSE 'failed' END,
         verified_at  = p_at,
         verify_msg   = coalesce(p_message, '')
   WHERE id = p_autobotz_id
  RETURNING verify_state INTO s;
  IF s IS NULL THEN
    RAISE EXCEPTION 'no AutoBotz binding % is visible to this caller', p_autobotz_id
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN s;
END $$;

REVOKE EXECUTE ON FUNCTION public.bob_autobotz_record_verification(uuid, boolean, text, timestamptz)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.bob_autobotz_record_verification(uuid, boolean, text, timestamptz)
  TO bob_app, authenticated;

-- ── RS-34 · the state where a binding is chosen ─────────────────────────────
CREATE VIEW bob.v_action_binding_picker WITH (security_invoker = true) AS
  SELECT a.id AS autobotz_id, a.org_id, a.label, a.type, a.provider, a.enabled,
         a.mutative, a.requires_approval, a.rate_limit_per_hour,
         a.invocation_cap_daily, a.concurrency_limit, a.verified_at, a.verify_msg,
         public.bob_autobotz_state(a.verify_state, a.verified_at, now()) AS verification_state,
         (a.mutative AND a.rate_limit_per_hour IS NULL
                     AND a.invocation_cap_daily IS NULL) AS needs_limit
    FROM bob.autobotz a;

COMMENT ON VIEW bob.v_action_binding_picker IS
  'RS-34. What the Action response picker shows: each binding with its derived '
  'verification state, and whether it needs a limit before a rule can attach it.';

REVOKE ALL ON bob.v_action_binding_picker FROM anon, service_role;
GRANT SELECT ON bob.v_action_binding_picker TO bob_app, authenticated;

-- ── The limit a real-world binding declares before a rule attaches it ───────
CREATE FUNCTION public.bob_response_requires_limit()
RETURNS trigger LANGUAGE plpgsql
SET search_path = bob, public
AS $$
BEGIN
  IF NEW.autobotz_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM bob.autobotz a
        WHERE a.id = NEW.autobotz_id AND a.mutative
          AND a.rate_limit_per_hour IS NULL AND a.invocation_cap_daily IS NULL) THEN
    RAISE EXCEPTION 'An Action response may not attach AutoBotz binding %, which '
      'changes the real world, unless the binding declares a limit '
      '(rate_limit_per_hour or invocation_cap_daily)', NEW.autobotz_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_response_requires_limit
  BEFORE INSERT OR UPDATE OF autobotz_id, type ON bob.response_rules
  FOR EACH ROW EXECUTE FUNCTION public.bob_response_requires_limit();

CREATE FUNCTION public.bob_autobotz_keeps_limit()
RETURNS trigger LANGUAGE plpgsql
SET search_path = bob, public
AS $$
BEGIN
  IF NEW.mutative AND NEW.rate_limit_per_hour IS NULL AND NEW.invocation_cap_daily IS NULL
     AND EXISTS (SELECT 1 FROM bob.response_rules r WHERE r.autobotz_id = NEW.id) THEN
    RAISE EXCEPTION 'AutoBotz binding % is attached by an Action response and changes '
      'the real world, so it must keep a limit', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_autobotz_keeps_limit
  BEFORE UPDATE OF mutative, rate_limit_per_hour, invocation_cap_daily ON bob.autobotz
  FOR EACH ROW EXECUTE FUNCTION public.bob_autobotz_keeps_limit();

COMMIT;
