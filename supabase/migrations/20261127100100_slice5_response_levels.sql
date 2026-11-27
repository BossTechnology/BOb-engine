-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 5 · Migration 2 of 6 · Depth and persistence on the response
--
-- Spec: docs/slice-5-thresholds.md §3. Federico's 10 Nov rulings 2 and 3: the
-- display shows what is true now, an alert requires persistence, so the dwell
-- belongs to the response. Several responses on one threshold at different
-- depths are several rows, and each has its own cooldown (evaluation_state).
--
--   trigger_level          absolute, in the metric's units, on the breaching
--                          side of a bound; NULL is the bound itself
--   sustained_for_seconds  consecutive sealed buckets past the level, times
--                          300; NULL fires on the first
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE bob.response_rules
  ADD COLUMN trigger_level         numeric,
  ADD COLUMN sustained_for_seconds integer,
  ADD CONSTRAINT response_rules_sustained_floor
      CHECK (sustained_for_seconds IS NULL OR sustained_for_seconds >= 300);

-- The level must sit past one of the threshold's bounds: a level inside the
-- bound would fire before the threshold breaches. It depends on another table,
-- so a trigger checks it on write. In schema bob, which bob_migrador owns on a
-- box; it holds no CREATE on public (F-51).
CREATE FUNCTION bob.bob_response_level_check()
RETURNS trigger LANGUAGE plpgsql
SET search_path = bob, public
AS $$
DECLARE t bob.threshold_configs;
BEGIN
  IF NEW.trigger_level IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO t FROM bob.threshold_configs
   WHERE id = NEW.threshold_id AND org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trigger_level needs a threshold of the response''s organization'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (   (t.upper_bound IS NOT NULL AND NEW.trigger_level >= t.upper_bound)
          OR (t.lower_bound IS NOT NULL AND NEW.trigger_level <= t.lower_bound)) THEN
    RAISE EXCEPTION 'trigger_level % is inside the bounds of threshold % (% to %)',
      NEW.trigger_level, t.id, t.lower_bound, t.upper_bound USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_response_level_check
  BEFORE INSERT OR UPDATE OF trigger_level, threshold_id ON bob.response_rules
  FOR EACH ROW EXECUTE FUNCTION bob.bob_response_level_check();

COMMIT;
