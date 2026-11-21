-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 6 · Admission needs a verified, fresh binding
--
-- Ruled by Henry on 21 Nov, answering the review of PR #26: an AutoBotz binding
-- that was never verified, whose last verification failed, or whose last
-- passing verification is older than the freshness window gets no intention.
-- The state is the derived one (public.bob_autobotz_state, RS-31), read with the
-- statement's clock, so stale is never stored. An edit that invalidates a
-- verification (RS-32) therefore also stops new intentions until Verify passes
-- again. Intentions already written are not touched.
--
-- The function is replaced whole; only the verification check is new.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.bob_outbox_admit()
RETURNS trigger LANGUAGE plpgsql
SET search_path = bob, public
AS $$
DECLARE
  r bob.response_rules;
  b bob.autobotz;
  n bigint;
  v text;
BEGIN
  IF NEW.state IS DISTINCT FROM 'queued' OR NEW.drained_at IS NOT NULL THEN
    RAISE EXCEPTION 'An intention is written queued. BOb decides whether it waits for '
      'approval, and only the drain marks one drained' USING ERRCODE = 'check_violation';
  END IF;
  -- The statement's clock, not the transaction's: a long transaction must not
  -- date its intentions at its own start, outside the window.
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

  -- One writer at a time per binding, so two intentions cannot both see room
  -- for one more.
  SELECT * INTO b FROM bob.autobotz
   WHERE id = NEW.autobotz_id AND org_id = NEW.org_id FOR UPDATE;
  IF NOT b.enabled THEN
    RAISE EXCEPTION 'AutoBotz binding % is disabled', b.id USING ERRCODE = 'check_violation';
  END IF;
  IF b.mutative AND b.rate_limit_per_hour IS NULL AND b.invocation_cap_daily IS NULL THEN
    RAISE EXCEPTION 'AutoBotz binding % changes the real world and declares no limit',
      b.id USING ERRCODE = 'check_violation';
  END IF;

  -- Only a binding whose last verification passed, and passed recently enough,
  -- gets an intention. Unverified, failed and stale are refused alike.
  v := public.bob_autobotz_state(b.verify_state, b.verified_at, clock_timestamp());
  IF v IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'AutoBotz binding % is %: an intention needs a binding whose last '
      'verification passed and is fresh', b.id, v USING ERRCODE = 'check_violation';
  END IF;

  IF b.rate_limit_per_hour IS NOT NULL THEN
    SELECT count(*) INTO n FROM bob.outbound_queue
     WHERE autobotz_id = b.id AND created_at > clock_timestamp() - interval '1 hour';
    IF n >= b.rate_limit_per_hour THEN
      RAISE EXCEPTION 'rate_limit_per_hour: AutoBotz binding % has % intentions in the '
        'last hour, and its limit is %', b.id, n, b.rate_limit_per_hour
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF b.invocation_cap_daily IS NOT NULL THEN
    SELECT count(*) INTO n FROM bob.outbound_queue
     WHERE autobotz_id = b.id AND created_at > clock_timestamp() - interval '24 hours';
    IF n >= b.invocation_cap_daily THEN
      RAISE EXCEPTION 'invocation_cap_daily: AutoBotz binding % has % intentions in the '
        'last 24 hours, and its cap is %', b.id, n, b.invocation_cap_daily
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF b.concurrency_limit IS NOT NULL THEN
    SELECT count(*) INTO n FROM bob.outbound_queue
     WHERE autobotz_id = b.id AND state = 'queued';
    IF n >= b.concurrency_limit THEN
      RAISE EXCEPTION 'concurrency_limit: AutoBotz binding % has % intentions not yet '
        'drained, and its limit is %', b.id, n, b.concurrency_limit
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF b.requires_approval THEN
    NEW.state := 'awaiting_approval';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
