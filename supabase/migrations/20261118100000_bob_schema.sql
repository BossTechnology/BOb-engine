-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · Slice 2 · Migration 1 of 3
-- BOb's tables move to schema `bob`.
--
-- Projection contract 0.5.1 §1: BOb lives in Postgres, schema `bob`. P5 inputs
-- §5.1: in the box's `supabase-db`, beside GoTrue's `auth`. The eight
-- projections are created there by the next migrations; this one moves what
-- already exists, so that configuration and projections share one schema.
--
-- WHAT MOVES. Every table and view this chain created in `public`, named
-- below. The list is written out because a migration is a record of what it
-- did; discovering "everything in public" would move whatever else a box keeps
-- there. The guard runs the other way: tests/slice2-schema.test.mjs discovers
-- what is left in `public` and fails on any table or view.
--
-- WHAT STAYS. The functions stay in `public`. GoTrue calls the access-token hook
-- at the address in config.toml (`pg-functions://postgres/public/…`), and the
-- availability functions and bob_grant_projection() are called by name from
-- the suite and, later, the application. Moving them changes every call site
-- for no gain in isolation: what a function can touch is set by its grants and
-- its search_path, not by the schema it sits in. So each one that reads a table
-- gets `bob` on its search_path, and the two that named `public.users` are
-- recreated naming `bob.users`.
--
-- WHO REACHES `bob`. USAGE goes to the three roles of Handoff §4.3, to
-- `authenticated` (the role PostgREST switches to, and the one the tenancy
-- suite reads as), and to `supabase_auth_admin` for the hook. Not to `anon` and
-- not to `service_role` (P5 inputs §3.2 and §3.4: anon holds nothing, and no
-- BOb component holds the service role). The table grants Supabase's default
-- privileges gave those two in `public` are revoked as the tables move, so a
-- later USAGE grant cannot bring them back.
--
-- Postgres moves a table's indexes, constraints, owned sequences, triggers,
-- policies, grants and publication membership with it. Views, policies and
-- foreign keys hold OIDs, not names, and are unaffected.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE SCHEMA IF NOT EXISTS bob;

COMMENT ON SCHEMA bob IS
  'BOb v1: configuration, live state and the eight projections. Projection '
  'contract §1; P5 inputs §5.1.';

-- ── The move ────────────────────────────────────────────────────────────────
ALTER TABLE public.actor_channel_skills  SET SCHEMA bob;
ALTER TABLE public.actor_shifts          SET SCHEMA bob;
ALTER TABLE public.actors                SET SCHEMA bob;
ALTER TABLE public.alert_log             SET SCHEMA bob;
ALTER TABLE public.alerts                SET SCHEMA bob;
ALTER TABLE public.anomalies             SET SCHEMA bob;
ALTER TABLE public.anomaly_rules         SET SCHEMA bob;
ALTER TABLE public.audit_log             SET SCHEMA bob;
ALTER TABLE public.autobotz              SET SCHEMA bob;
ALTER TABLE public.baselines             SET SCHEMA bob;
ALTER TABLE public.bobee_conversations   SET SCHEMA bob;
ALTER TABLE public.channel_actor_mix     SET SCHEMA bob;
ALTER TABLE public.channels              SET SCHEMA bob;
ALTER TABLE public.configurations        SET SCHEMA bob;
ALTER TABLE public.interactions          SET SCHEMA bob;
ALTER TABLE public.metric_snapshots      SET SCHEMA bob;
ALTER TABLE public.notification_channels SET SCHEMA bob;
ALTER TABLE public.notification_log      SET SCHEMA bob;
ALTER TABLE public.notification_rules    SET SCHEMA bob;
ALTER TABLE public.organizations         SET SCHEMA bob;
ALTER TABLE public.patterns              SET SCHEMA bob;
ALTER TABLE public.response_rules        SET SCHEMA bob;
ALTER TABLE public.rootcause_log         SET SCHEMA bob;
ALTER TABLE public.sentiment_readings    SET SCHEMA bob;
ALTER TABLE public.text_rules            SET SCHEMA bob;
ALTER TABLE public.threshold_configs     SET SCHEMA bob;
ALTER TABLE public.users                 SET SCHEMA bob;

ALTER VIEW public.v_feeder_channel_map   SET SCHEMA bob;
ALTER VIEW public.v_roster               SET SCHEMA bob;

-- ── Who reaches the schema ──────────────────────────────────────────────────
GRANT USAGE ON SCHEMA bob TO bob_app, bob_feeder, bob_ai_ro,
                             authenticated, supabase_auth_admin;

-- What Supabase's default privileges handed anon and service_role in `public`
-- does not travel into `bob` as live access: they get no USAGE above. Revoked
-- as well, so nothing is left waiting for a grant of USAGE to wake it.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'bob' AND c.relkind IN ('r', 'p', 'v')
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM anon, service_role', r.qualified);
  END LOOP;
END $$;

-- ── Functions that read tables find them in `bob` ───────────────────────────
-- The availability functions were created without a pinned search_path and
-- resolved their tables through the caller's. They are pinned here, which is
-- also what lint 0011 asked of the others in 20260606120003.
ALTER FUNCTION public.update_updated_at()               SET search_path = bob, public;
ALTER FUNCTION public.cap_alert_log()                   SET search_path = bob, public;
ALTER FUNCTION public.enforce_slug_immutability()       SET search_path = bob, public;
ALTER FUNCTION public.bob_source_key_unset(TEXT)        SET search_path = bob, public;
ALTER FUNCTION public.bob_grant_projection(regclass)    SET search_path = bob, public;
ALTER FUNCTION public.bob_shift_is_live(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TIMESTAMPTZ)
  SET search_path = bob, public;
ALTER FUNCTION public.bob_availability(UUID, UUID[], BIGINT, NUMERIC, NUMERIC, TIMESTAMPTZ)
  SET search_path = bob, public;
ALTER FUNCTION public.bob_availability_asa(UUID, UUID[])
  SET search_path = bob, public;
ALTER FUNCTION public.bob_availability_human(UUID, UUID[], TIMESTAMPTZ)
  SET search_path = bob, public;
ALTER FUNCTION public.bob_availability_human_summed(UUID, UUID[], TIMESTAMPTZ)
  SET search_path = bob, public;
ALTER FUNCTION public.bob_availability_reason(UUID, UUID[], TEXT, TIMESTAMPTZ)
  SET search_path = bob, public;
ALTER FUNCTION public.bob_availability_user(BIGINT, NUMERIC, NUMERIC)
  SET search_path = bob, public;

-- The two functions whose bodies named `public.users`. Same bodies, the new
-- schema named. A qualified name in a body is not rewritten by SET SCHEMA.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = bob, public AS $$
BEGIN
  INSERT INTO bob.users (id, email, org_id, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    NULLIF(NEW.raw_user_meta_data ->> 'org_id', '')::uuid,
    NEW.raw_user_meta_data ->> 'full_name',
    COALESCE(NEW.raw_user_meta_data ->> 'role', 'viewer')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = bob, public AS $$
DECLARE
  claims jsonb;
  u RECORD;
BEGIN
  SELECT usr.org_id, usr.role, org.slug AS org_slug, org.plan
  INTO u
  FROM bob.users usr
  JOIN bob.organizations org ON org.id = usr.org_id
  WHERE usr.id = (event ->> 'user_id')::uuid;

  claims := event -> 'claims';
  IF u.org_id IS NOT NULL THEN
    claims := jsonb_set(claims, '{org_id}',   to_jsonb(u.org_id));
    -- `role` is reserved for PostgREST — publish the app role separately.
    claims := jsonb_set(claims, '{app_role}', to_jsonb(u.role));
    claims := jsonb_set(claims, '{org_slug}', to_jsonb(u.org_slug));
    claims := jsonb_set(claims, '{plan}',     to_jsonb(u.plan));
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

COMMIT;
