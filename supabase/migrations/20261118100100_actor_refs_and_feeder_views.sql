-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 2 · Migration 2 of 3
-- What the feeder resolves through: actor refs, their history, the idle bound,
-- and the two views it reads.
--
-- Projection contract 0.5.1:
--   §9.3  actor_external_refs; actors.external_ref dropped; UNIQUE (id, actor_type)
--   §9.4  actor_ref_history, append-only, member refs only        [PROPOSED]
--   §9.2  channels.idle_bound_seconds
--   §7.4  v_feeder_channel_map gains idle_bound_seconds; v_feeder_actor_map,
--         valid_to derived (H4)                                     [PROPOSED]
--
-- And F-21 (amendments, "P5 · The application layer, inputs"): the feeder could
-- not read its own view. 20260902100300 created v_feeder_channel_map as an
-- invoker view and granted bob_feeder the view alone, so Postgres checked
-- `channels` against bob_feeder and refused. Both feeder views are now definer
-- views owned by the migration owner, exposing their named columns and nothing
-- else, readable by bob_feeder and by no other role.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── §9.2 · the per-channel idle bound ───────────────────────────────────────
-- NULL refuses `abandoned` on that channel, not the channel (11 Nov, Q11), and
-- never `abandoned_in_queue` (12 Nov, O3). A declared relationship with
-- lag_seconds, not a CHECK (Q5).
ALTER TABLE bob.channels ADD COLUMN idle_bound_seconds INTEGER
  CHECK (idle_bound_seconds IS NULL OR idle_bound_seconds > 0);

COMMENT ON COLUMN bob.channels.idle_bound_seconds IS
  'Contract §9.2. Silence past this is an idle abandonment. NULL: `abandoned` '
  'renders not configured and no `abandoned` row is written for the channel; '
  '`abandoned_in_queue` is unaffected (O3).';

-- ── §9.3 · actors ───────────────────────────────────────────────────────────
-- The composite key proj_actor_metrics uses to keep its denormalised
-- actor_type equal to the actor's own (§6.6 (a), accepted 12 Nov).
ALTER TABLE bob.actors ADD CONSTRAINT actors_id_actor_type_key UNIQUE (id, actor_type);

-- Replaced by actor_external_refs (11 Nov, Q14). Kept beside its replacement it
-- would be two sources of truth for one fact. No row on any chain carries a
-- value: nothing ever wrote one.
ALTER TABLE bob.actors DROP COLUMN external_ref;

-- ── §9.3 · actor_external_refs ──────────────────────────────────────────────
-- The current state: which actor a ref resolves to. All four actor types.
-- `ref` is `m:…` for a member (computed, D47), `<source_key>:<id>` for an
-- agent, `<platform>:<deployment>` for an ASA (§7.2). No namespace is written
-- in this file or in any code path; a guard asserts it.
CREATE TABLE bob.actor_external_refs (
  org_id      UUID        NOT NULL REFERENCES bob.organizations(id) ON DELETE CASCADE,
  actor_id    UUID        NOT NULL REFERENCES bob.actors(id) ON DELETE CASCADE,
  ref         TEXT        NOT NULL CHECK (ref <> ''),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, ref)
);

CREATE INDEX idx_actor_external_refs_ref   ON bob.actor_external_refs (ref);
CREATE INDEX idx_actor_external_refs_actor ON bob.actor_external_refs (actor_id);

ALTER TABLE bob.actor_external_refs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_actor_external_refs" ON bob.actor_external_refs FOR ALL
  USING      (org_id = (auth.jwt() ->> 'org_id')::uuid)
  WITH CHECK (org_id = (auth.jwt() ->> 'org_id')::uuid);

COMMENT ON TABLE bob.actor_external_refs IS
  'Contract §7.2, §9.3. One row per external identifier; (org_id, ref) unique. '
  'Written by bob_app (the ghost reconciliation, linkage). The feeder reads it '
  'only through v_feeder_actor_map and never creates an actor.';

-- ── §9.4 · actor_ref_history ────────────────────────────────────────────────
-- What a member ref pointed to, and at which rung, from when. The rebuild
-- reads it to recover identity_rung_at_interaction as of each event's time
-- (§6.6, D-12), which current state cannot give.
CREATE TABLE bob.actor_ref_history (
  org_id        UUID        NOT NULL REFERENCES bob.organizations(id) ON DELETE CASCADE,
  ref           TEXT        NOT NULL CHECK (ref <> ''),
  actor_id      UUID        NOT NULL REFERENCES bob.actors(id) ON DELETE CASCADE,
  identity_rung TEXT        NOT NULL
                CHECK (identity_rung IN ('identified','ghost','guest','inferred')),
  valid_from    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, ref, valid_from)
);

CREATE INDEX idx_actor_ref_history_actor ON bob.actor_ref_history (actor_id);

ALTER TABLE bob.actor_ref_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_actor_ref_history" ON bob.actor_ref_history FOR ALL
  USING      (org_id = (auth.jwt() ->> 'org_id')::uuid)
  WITH CHECK (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- Append-only, and members only. Enforced by a trigger rather than by
-- withholding UPDATE and DELETE from bob_app: contract §10 asserts bob_app
-- holds all four on every non-projection, and a trigger binds every role,
-- the owner included. A DELETE that arrives through a foreign-key cascade
-- (the organisation or the actor going away) is allowed; a DELETE issued
-- against this table is not.
CREATE FUNCTION bob.actor_ref_history_guard()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = bob, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'actor_ref_history is append-only: append a row with a later valid_from'
      USING ERRCODE = 'check_violation';
  ELSIF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'actor_ref_history is append-only: rows leave only with their organisation or actor'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT. Only members have a rung (§9.4); agent and ASA refs are read from
  -- actor_external_refs directly.
  IF NOT EXISTS (SELECT 1 FROM bob.actors a
                  WHERE a.id = NEW.actor_id AND a.org_id = NEW.org_id
                    AND a.actor_type = 'user') THEN
    RAISE EXCEPTION 'actor_ref_history holds member refs only: % is not a user actor of this organisation',
      NEW.actor_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_actor_ref_history_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bob.actor_ref_history
  FOR EACH ROW EXECUTE FUNCTION bob.actor_ref_history_guard();

REVOKE EXECUTE ON FUNCTION bob.actor_ref_history_guard() FROM PUBLIC;

COMMENT ON TABLE bob.actor_ref_history IS
  'Contract §9.4 [PROPOSED]. Append-only: the state of a ref at t is its row '
  'with the greatest valid_from <= t. Member refs only. actor_external_refs is '
  'the current state and must equal the latest row here for every member ref.';

-- ── bob_app · configuration grants ──────────────────────────────────────────
-- Contract §10: bob_app holds SELECT, INSERT, UPDATE and DELETE on every
-- non-projection that carries org_id. The hand list in 20260902100300 missed
-- the six tables inherited from Bob-New; the guard that replaces the list
-- found them.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  bob.actor_external_refs, bob.actor_ref_history,
  bob.baselines, bob.interactions, bob.metric_snapshots,
  bob.patterns, bob.rootcause_log, bob.sentiment_readings
TO bob_app;

-- `authenticated` holds on the two new tables what it holds on every other
-- configuration table, which Supabase's defaults gave it in `public` and the
-- move carried over. Whether user reads go through PostgREST at all is A-05b's
-- choice, with the first route handler; until then the two tables are not the
-- exception, and the tenancy suite reads them as every other table, through RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  bob.actor_external_refs, bob.actor_ref_history
TO authenticated;

-- ── §7.4 · v_feeder_channel_map, F-21 ───────────────────────────────────────
-- A definer view: Postgres reads `channels` and `organizations` as the view's
-- owner, so bob_feeder needs no grant on either, and RLS (which bob_feeder,
-- holding no claim yet, would fail) is the owner's to bypass. That is the
-- boundary Handoff §4.3 describes: the feeder needs the map across every
-- tenant before it knows which org_id an event belongs to. It sees these
-- seven columns and nothing else.
DROP VIEW bob.v_feeder_channel_map;

CREATE VIEW bob.v_feeder_channel_map
WITH (security_invoker = false) AS
  SELECT c.id AS channel_id,
         c.org_id,
         o.slug AS tenant_slug,
         c.source_key,
         c.lag_seconds,
         c.adapter_kind,
         c.idle_bound_seconds
    FROM bob.channels c
    JOIN bob.organizations o ON o.id = c.org_id;

COMMENT ON VIEW bob.v_feeder_channel_map IS
  'Contract §7.4. One of the two things the feeder reads from BOb: '
  '(tenant_slug, source_key) to (org_id, channel_id), with the two per-channel '
  'declarations it needs (lag, idle bound). Definer view (F-21): readable by '
  'bob_feeder alone, across tenants, with no grant on the tables.';

-- ── §7.4 · v_feeder_actor_map, H4 ───────────────────────────────────────────
-- Member refs come from the history, with valid_to derived as the next
-- valid_from of the same ref and NULL for the current row (H4: nothing stores
-- valid_to). Agent and ASA refs come from actor_external_refs, carry no
-- dates, and carry the rung the feeder writes for them, 'not_applicable'
-- (§6.6 (a)), so the feeder holds no rule of its own about which types have a
-- rung. No display_name, no display_id: the feeder never sees a name.
CREATE VIEW bob.v_feeder_actor_map
WITH (security_invoker = false) AS
  SELECT h.org_id,
         h.ref,
         h.actor_id,
         a.actor_type,
         h.identity_rung,
         h.valid_from,
         lead(h.valid_from) OVER (PARTITION BY h.org_id, h.ref
                                  ORDER BY h.valid_from) AS valid_to
    FROM bob.actor_ref_history h
    JOIN bob.actors a ON a.id = h.actor_id
  UNION ALL
  SELECT r.org_id,
         r.ref,
         r.actor_id,
         a.actor_type,
         'not_applicable'::text AS identity_rung,
         NULL::timestamptz      AS valid_from,
         NULL::timestamptz      AS valid_to
    FROM bob.actor_external_refs r
    JOIN bob.actors a ON a.id = r.actor_id
   WHERE a.actor_type <> 'user';

COMMENT ON VIEW bob.v_feeder_actor_map IS
  'Contract §7.4 [PROPOSED, H4]. The second thing the feeder reads from BOb: '
  'ref to actor, with the linkage history for member refs so the actor and '
  'rung as of an event''s time can be derived. valid_to is derived, never '
  'stored. Definer view, readable by bob_feeder alone.';

-- ── Who reads the two views ─────────────────────────────────────────────────
-- A definer view hands its owner's reach to whoever can select from it, so the
-- grant is the whole boundary. bob_feeder, and nobody else.
REVOKE ALL ON bob.v_feeder_channel_map, bob.v_feeder_actor_map
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_ai_ro;
GRANT SELECT ON bob.v_feeder_channel_map, bob.v_feeder_actor_map TO bob_feeder;

COMMIT;
