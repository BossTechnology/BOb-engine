-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 5 · Migration 1 of 6 · Step 6a, the three durations
--
-- Spec: docs/slice-5-thresholds.md §1, §2. D-05 (Relevo task 9, 27 Oct), its six points
-- answered on 5 and 10 Nov.
--
-- NULL INHERITS. Each duration is nullable and NULL means "the system default",
-- which lives in one SQL function per duration. Replacing a function moves every
-- threshold that inherits and none that set a value, which is what "we change it
-- centrally" promised; a column DEFAULT would have stored the number in every
-- row (point 1). The evaluator reads only bob_effective_durations().
--
-- THE FLOOR IS IN BOTH PLACES. 300 s is one base bucket (C-13): below it a
-- duration is inert, not aggressive. The CHECK cannot see through a NULL, so
-- every default function returns through bob_duration_floor(), which raises
-- below 300 (point 2, and Federico's 5 Nov ruling).
--
-- F-48. UNIQUE (org_id, metric_id) gives way to one index on the scope, so a
-- threshold is per threshold: Voice and WhatsApp may hold different cooldowns.
--
-- notification_rules loses its two defaults (15, 30), which nothing reads
-- (Henry, 6 Nov; Federico, 10 Nov). The table stays until step 17.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE FUNCTION bob.bob_duration_floor(seconds integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE
SET search_path = bob, public
AS $$
BEGIN
  IF seconds IS NULL OR seconds < 300 THEN
    RAISE EXCEPTION 'A duration below one base bucket (300 s) is inert: %', seconds
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN seconds;
END $$;

CREATE FUNCTION bob.bob_default_cooldown_seconds()
RETURNS integer LANGUAGE sql IMMUTABLE
SET search_path = bob, public
BEGIN ATOMIC SELECT bob.bob_duration_floor(1800); END;

CREATE FUNCTION bob.bob_default_escalation_after_seconds()
RETURNS integer LANGUAGE sql IMMUTABLE
SET search_path = bob, public
BEGIN ATOMIC SELECT bob.bob_duration_floor(7200); END;

CREATE FUNCTION bob.bob_default_recovery_dwell_seconds()
RETURNS integer LANGUAGE sql IMMUTABLE
SET search_path = bob, public
BEGIN ATOMIC SELECT bob.bob_duration_floor(300); END;

ALTER TABLE bob.threshold_configs
  ADD COLUMN cooldown_seconds         integer,
  ADD COLUMN escalation_after_seconds integer,
  ADD COLUMN recovery_dwell_seconds   integer,
  ADD CONSTRAINT threshold_configs_cooldown_floor
      CHECK (cooldown_seconds IS NULL OR cooldown_seconds >= 300),
  ADD CONSTRAINT threshold_configs_escalation_floor
      CHECK (escalation_after_seconds IS NULL OR escalation_after_seconds >= 300),
  ADD CONSTRAINT threshold_configs_recovery_dwell_floor
      CHECK (recovery_dwell_seconds IS NULL OR recovery_dwell_seconds >= 300);

COMMENT ON COLUMN bob.threshold_configs.cooldown_seconds IS
  'D-05. NULL inherits bob_default_cooldown_seconds(). Never read directly: '
  'bob_effective_durations() resolves it.';
COMMENT ON COLUMN bob.threshold_configs.escalation_after_seconds IS
  'D-05. NULL inherits bob_default_escalation_after_seconds(). Time sustained, '
  'not time unacknowledged.';
COMMENT ON COLUMN bob.threshold_configs.recovery_dwell_seconds IS
  'D-05 (5 Nov, ruling 5). NULL inherits bob_default_recovery_dwell_seconds(). '
  'How long back inside the bound before a recovery fires and clears the cooldown.';

CREATE FUNCTION bob.bob_effective_durations(t bob.threshold_configs,
  OUT cooldown_seconds integer, OUT escalation_after_seconds integer,
  OUT recovery_dwell_seconds integer)
LANGUAGE sql STABLE
SET search_path = bob, public
BEGIN ATOMIC
  SELECT coalesce(t.cooldown_seconds,         bob.bob_default_cooldown_seconds()),
         coalesce(t.escalation_after_seconds, bob.bob_default_escalation_after_seconds()),
         coalesce(t.recovery_dwell_seconds,   bob.bob_default_recovery_dwell_seconds());
END;

-- F-48 · per threshold, not per metric.
ALTER TABLE bob.threshold_configs DROP CONSTRAINT threshold_configs_org_id_metric_id_key;
CREATE UNIQUE INDEX threshold_configs_scope_key
  ON bob.threshold_configs (org_id, metric_id, scope_kind, coalesce(scope_ref, ''));

ALTER TABLE bob.notification_rules
  ALTER COLUMN suppression_min DROP DEFAULT,
  ALTER COLUMN escalation_min  DROP DEFAULT;

COMMIT;
