-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 6 · Migration 3 of 3
-- The outbox: bob.outbound_queue (Handoff Part 4), where BOb writes an
-- intention and something else transmits it.
--
-- BOb never executes and never holds a customer credential. So what is decided
-- here is what BOb writes and when it refuses to write (D-31, settled in the
-- scope map):
--   - The usage limits are enforced at the moment the intention is written,
--     and only BOb can enforce them: the transmitter sees one intention at a
--     time and does not know which rule produced it or how many came before.
--     With rate_limit_per_hour = 10, the eleventh in an hour is refused.
--     invocation_cap_daily counts a rolling 24 hours; concurrency_limit counts
--     intentions written and not yet drained.
--   - A binding that requires approval has its intention written
--     `awaiting_approval`, a state nothing drains and nothing leaves. Inert by
--     construction, not by omission. Approving one is not in v1.
--   - A binding that changes the real world and declares no limit gets no
--     intention, even if a rule attached it before migration 2 existed.
--   - The intention carries the alert that caused it (alert_log_id, NOT NULL,
--     keyed by organization), so "why did fourteen orders go out" is a query.
--
-- WHO DOES WHAT. bob_app writes intentions and, in v1, runs the stub drain
-- (outbox/stub-drainer.mjs) through public.bob_outbox_drain(). The outcome of an
-- attempt is not written here: it comes back through the projection path into
-- proj_deliveries, whose outbound_id joins this table. Which role the real
-- transmitter holds is a P5 question; it is not a fourth role here.
--
-- AN INTENTION MOVES ONCE. Written `queued` (or turned into `awaiting_approval`
-- by BOb, never by the writer), then `queued` to `drained`, stamped by the
-- database. Nothing else about it changes. Its time is the database's: a writer
-- cannot backdate one out of the limit's window, and the clock is the
-- statement's (clock_timestamp()), not the transaction's start.
-- Nobody the application runs as deletes an intention.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE bob.response_rules ADD CONSTRAINT response_rules_org_id_id_key UNIQUE (org_id, id);

CREATE TABLE bob.outbound_queue (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL REFERENCES bob.organizations (id) ON DELETE CASCADE,
  response_rule_id UUID        NOT NULL,
  autobotz_id      UUID        NOT NULL,
  alert_log_id     UUID        NOT NULL,
  idempotency_key  TEXT        NOT NULL,
  correlation_id   TEXT,
  state            TEXT        NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued', 'awaiting_approval', 'drained')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  drained_at       TIMESTAMPTZ,
  CONSTRAINT outbound_queue_drained_when CHECK ((state = 'drained') = (drained_at IS NOT NULL)),
  CONSTRAINT outbound_queue_idempotency_key UNIQUE (org_id, idempotency_key),
  CONSTRAINT outbound_queue_rule_fkey
    FOREIGN KEY (org_id, response_rule_id) REFERENCES bob.response_rules (org_id, id),
  CONSTRAINT outbound_queue_autobotz_fkey
    FOREIGN KEY (org_id, autobotz_id) REFERENCES bob.autobotz (org_id, id),
  CONSTRAINT outbound_queue_alert_fkey
    FOREIGN KEY (org_id, alert_log_id) REFERENCES bob.alert_log (org_id, id)
);

CREATE INDEX idx_outbound_queue_binding ON bob.outbound_queue (autobotz_id, created_at);
CREATE INDEX idx_outbound_queue_queued ON bob.outbound_queue (created_at)
  WHERE state = 'queued';

COMMENT ON TABLE bob.outbound_queue IS
  'The outbox. One row per intention BOb wrote; BOb never transmits it. Limits '
  'are enforced on insert, approval-gated intentions are never drained, and each '
  'carries the alert that caused it. Outcomes return through proj_deliveries.';

ALTER TABLE bob.outbound_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_outbound_queue" ON bob.outbound_queue FOR ALL
  USING      (org_id = (auth.jwt() ->> 'org_id')::uuid)
  WITH CHECK (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- No DELETE for anyone the application runs as: deleting an intention would
-- lose why an action happened and give its binding room under its limit
-- again. Only bob_app updates, and the transition trigger allows one change.
-- The rows go with their organization (ON DELETE CASCADE, as the owner).
REVOKE ALL ON bob.outbound_queue FROM anon, service_role, authenticated, bob_app;
GRANT SELECT, INSERT ON bob.outbound_queue TO bob_app, authenticated;
GRANT UPDATE ON bob.outbound_queue TO bob_app;

-- ── Admission: the intention as BOb writes it ───────────────────────────────
CREATE FUNCTION public.bob_outbox_admit()
RETURNS trigger LANGUAGE plpgsql
SET search_path = bob, public
AS $$
DECLARE
  r bob.response_rules;
  b bob.autobotz;
  n bigint;
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

CREATE TRIGGER trg_outbox_admit
  BEFORE INSERT ON bob.outbound_queue
  FOR EACH ROW EXECUTE FUNCTION public.bob_outbox_admit();

-- ── Transition: queued to drained, once, and nothing else ───────────────────
CREATE FUNCTION public.bob_outbox_transition()
RETURNS trigger LANGUAGE plpgsql
SET search_path = bob, public
AS $$
BEGIN
  IF OLD.state = 'queued' AND NEW.state = 'drained'
     AND (NEW.id, NEW.org_id, NEW.response_rule_id, NEW.autobotz_id, NEW.alert_log_id,
          NEW.idempotency_key, NEW.correlation_id, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.org_id, OLD.response_rule_id, OLD.autobotz_id, OLD.alert_log_id,
          OLD.idempotency_key, OLD.correlation_id, OLD.created_at) THEN
    NEW.drained_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An intention moves once, from queued to drained, and is otherwise '
    'immutable. It is %, and was asked to become %', OLD.state, NEW.state
    USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER trg_outbox_transition
  BEFORE UPDATE ON bob.outbound_queue
  FOR EACH ROW EXECUTE FUNCTION public.bob_outbox_transition();

-- ── The drain ───────────────────────────────────────────────────────────────
-- Only `queued` is drainable. Under the caller's claim, so one organization.
CREATE FUNCTION public.bob_outbox_drain(p_limit integer DEFAULT 100)
RETURNS SETOF bob.outbound_queue LANGUAGE sql
SET search_path = bob, public
AS $$
  UPDATE bob.outbound_queue q
     SET state = 'drained'
   WHERE q.id IN (SELECT id FROM bob.outbound_queue
                   WHERE state = 'queued'
                   ORDER BY created_at, id
                   LIMIT p_limit
                   FOR UPDATE SKIP LOCKED)
  RETURNING q.*
$$;

REVOKE EXECUTE ON FUNCTION public.bob_outbox_drain(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bob_outbox_drain(integer) TO bob_app;

COMMIT;
