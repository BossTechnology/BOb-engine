-- A stand-in, for CI only, for step 2 of Bzzz's alta: Bzzz
-- scripts/generar-secretos-vecina.sh with config/supabase/vecinas/bob.conf
-- (BossTechnology/bzzz#450, D77 §2.8, 77.17 to 77.22). What counts on a box is
-- that alta, not this file. Same names, same order, same transaction, measured
-- on supabase/postgres:17.6.1.136 (it relies on Postgres 16+: the creator of a
-- role holds ADMIN on it). Applied by postgres after the install chain;
-- idempotent, since lab-02 gets it over an existing bob.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bob_migrador') THEN
    CREATE ROLE bob_migrador NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 1;
  END IF;
END
$$;
ALTER ROLE bob_migrador CONNECTION LIMIT 1;

-- bob.conf: ROLES=bob_app:10 bob_feeder:4 bob_ai_ro:pendiente (0 until measured).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('bob_app', 10), ('bob_feeder', 4), ('bob_ai_ro', 0)) v(name, lim) LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT %s', r.name, r.lim);
    END IF;
    EXECUTE format('ALTER ROLE %I CONNECTION LIMIT %s', r.name, r.lim);
  END LOOP;
END
$$;

-- The two temporary permissions of #450, revoked before the COMMIT.
GRANT bob_migrador TO postgres WITH INHERIT FALSE, SET TRUE;
GRANT CREATE ON DATABASE postgres TO bob_migrador;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'bob') THEN
    CREATE SCHEMA bob AUTHORIZATION bob_migrador;
  ELSIF (SELECT nspowner FROM pg_namespace WHERE nspname = 'bob') <> 'bob_migrador'::regrole THEN
    ALTER SCHEMA bob OWNER TO bob_migrador;
  END IF;
END
$$;

-- The hand-over: everything in bob that is postgres's goes to bob_migrador;
-- anything of another role stops it. Sequences owned by a column, indexes and
-- row types follow their table.
DO $$
DECLARE r record; foreign_owned text;
BEGIN
  SELECT string_agg(x, ', ') INTO foreign_owned FROM (
    SELECT c.oid::regclass::text AS x FROM pg_class c WHERE c.relnamespace = 'bob'::regnamespace
       AND c.relowner NOT IN ('bob_migrador'::regrole, 'postgres'::regrole)
    UNION ALL SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'bob'::regnamespace
       AND p.proowner NOT IN ('bob_migrador'::regrole, 'postgres'::regrole)
    UNION ALL SELECT t.oid::regtype::text FROM pg_type t WHERE t.typnamespace = 'bob'::regnamespace
       AND t.typowner NOT IN ('bob_migrador'::regrole, 'postgres'::regrole)) a;
  IF foreign_owned IS NOT NULL THEN
    RAISE EXCEPTION 'in bob, not postgres''s nor bob_migrador''s: %', foreign_owned;
  END IF;
  FOR r IN
    SELECT format('ALTER TABLE %I.%I OWNER TO bob_migrador', n.nspname, c.relname) AS stmt
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'bob' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND c.relowner <> 'bob_migrador'::regrole
       AND NOT (c.relkind = 'S' AND EXISTS (
             SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')))
    UNION ALL
    SELECT format('ALTER ROUTINE %s OWNER TO bob_migrador', p.oid::regprocedure)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'bob' AND p.proowner <> 'bob_migrador'::regrole
    UNION ALL
    SELECT format('ALTER %s %I.%I OWNER TO bob_migrador', CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, n.nspname, t.typname)
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'bob' AND t.typowner <> 'bob_migrador'::regrole
       AND (t.typtype IN ('e', 'd', 'r', 'm')
            OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
  LOOP
    EXECUTE r.stmt;
  END LOOP;
END
$$;

REVOKE CREATE ON DATABASE postgres FROM bob_migrador;
REVOKE bob_migrador FROM postgres GRANTED BY postgres;

-- The FUERA= line of Bzzz's config/supabase/vecinas/bob.conf, as the alta grants it: by
-- postgres, after the two temporary permissions are revoked, and only if the
-- function exists. bob.sql itself no longer runs here: the alta runs it in a
-- session of its own as bob_migrador (Bzzz scripts/generar-secretos-vecina.sh,
-- step 4b), and today it is only a comment. owner-chain-check.mjs pins its bytes.
DO $$ DECLARE o text := to_regprocedure('public.bob_grant_projection(pg_catalog.regclass)')::text; BEGIN
  IF o IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO %I', o, 'bob_migrador');
  END IF; END $$;
COMMIT;
