-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 5 · Migration 5 of 6 · A refusal is a row (F-49)
--
-- Spec: docs/slice-5-thresholds.md §8. D-31 (BOB-11, item 1): "a refusal is
-- recorded as a row with its reason — a suppressed intent — never silence",
-- placed in step 19. Slice 6 built admission to raise. Here a limit or a
-- binding that is not verified, fresh and enabled writes the intention as
-- `suppressed`, with its reason, and the trace from alert to intention holds
-- even when nothing will be sent.
--
-- Structural errors still raise: another organization's response, a binding
-- that does not match its response, a mutative binding with no limit. They are
-- a broken configuration, not a limit doing its job.
--
-- A suppressed row counts toward no limit, nothing drains it, and the
-- transition guard keeps it as written. Nobody writes one directly: an
-- intention is still written `queued`, and BOb decides.
--
-- Consumer impact: an INSERT over a limit returns a row whose state is
-- `suppressed` instead of an error.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE bob.outbound_queue
  ADD COLUMN suppressed_reason text;
ALTER TABLE bob.outbound_queue DROP CONSTRAINT outbound_queue_state_check;
ALTER TABLE bob.outbound_queue
  ADD CONSTRAINT outbound_queue_state_check
      CHECK (state IN ('queued', 'awaiting_approval', 'drained', 'suppressed')),
  ADD CONSTRAINT outbound_queue_suppressed_why
      CHECK ((state = 'suppressed') = (suppressed_reason IS NOT NULL));

CREATE OR REPLACE FUNCTION public.bob_outbox_admit()
RETURNS trigger LANGUAGE plpgsql
SET search_path = bob, public
AS $$
DECLARE
  r bob.response_rules;
  b bob.autobotz;
  n bigint;
  v text;
  why text;
BEGIN
  IF NEW.state IS DISTINCT FROM 'queued' OR NEW.drained_at IS NOT NULL
     OR NEW.suppressed_reason IS NOT NULL THEN
    RAISE EXCEPTION 'An intention is written queued. BOb decides whether it waits for '
      'approval or is suppressed, and only the drain marks one drained'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := clock_timestamp();

  SELECT * INTO r FROM bob.response_rules
   WHERE id = NEW.response_rule_id AND org_id = NEW.org_id;
  IF NOT FOUND OR r.type <> 'action' THEN
    RAISE EXCEPTION 'An intention comes from an Action response of its own organization; '
      '% is not one', NEW.response_rule_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.autobotz_id IS NULL THEN
    NEW.autobotz_id := r.autobotz_id;
  ELSIF NEW.autobotz_id <> r.autobotz_id THEN
    RAISE EXCEPTION 'The intention names AutoBotz binding %, but its Action response '
      'attaches %', NEW.autobotz_id, r.autobotz_id USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO b FROM bob.autobotz
   WHERE id = NEW.autobotz_id AND org_id = NEW.org_id FOR UPDATE;
  IF b.mutative AND b.rate_limit_per_hour IS NULL AND b.invocation_cap_daily IS NULL THEN
    RAISE EXCEPTION 'AutoBotz binding % changes the real world and declares no limit',
      b.id USING ERRCODE = 'check_violation';
  END IF;

  -- From here on, a refusal is a row with its reason, in this order.
  IF NOT b.enabled THEN
    why := 'binding_disabled';
  END IF;

  IF why IS NULL THEN
    v := public.bob_autobotz_state(b.verify_state, b.verified_at, clock_timestamp());
    IF v IS DISTINCT FROM 'ok' THEN
      why := 'binding_' || coalesce(v, 'unverified');
    END IF;
  END IF;

  IF why IS NULL AND b.rate_limit_per_hour IS NOT NULL THEN
    SELECT count(*) INTO n FROM bob.outbound_queue
     WHERE autobotz_id = b.id AND state <> 'suppressed'
       AND created_at > clock_timestamp() - interval '1 hour';
    IF n >= b.rate_limit_per_hour THEN why := 'rate_limit_per_hour'; END IF;
  END IF;
  IF why IS NULL AND b.invocation_cap_daily IS NOT NULL THEN
    SELECT count(*) INTO n FROM bob.outbound_queue
     WHERE autobotz_id = b.id AND state <> 'suppressed'
       AND created_at > clock_timestamp() - interval '24 hours';
    IF n >= b.invocation_cap_daily THEN why := 'invocation_cap_daily'; END IF;
  END IF;
  IF why IS NULL AND b.concurrency_limit IS NOT NULL THEN
    SELECT count(*) INTO n FROM bob.outbound_queue
     WHERE autobotz_id = b.id AND state = 'queued';
    IF n >= b.concurrency_limit THEN why := 'concurrency_limit'; END IF;
  END IF;

  IF why IS NOT NULL THEN
    NEW.state := 'suppressed';
    NEW.suppressed_reason := why;
  ELSIF b.requires_approval THEN
    NEW.state := 'awaiting_approval';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
