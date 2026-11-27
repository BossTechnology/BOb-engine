-- ════════════════════════════════════════════════════════════════════════════
-- F-58 · the separate REVOKE step (Henry, 27 Nov: «Paso REVOKE aparte»)
--
-- The tables of bob were created in public, where Supabase's default
-- privileges for postgres give authenticated TRIGGER and REFERENCES, and were
-- moved to bob with that ACL. A member could attach a trigger to any table of
-- bob. This takes them away from every role the application runs as.
--
-- Not a migration and not part of the install chain: the signed commit
-- 00f79b7 is installed as it is, and this runs once after it, by hand, as the
-- owner of schema bob (bob_migrador on a box). It is idempotent and runs in
-- one transaction: it ends by checking, and raises if anything is left, so
-- either everything is revoked or nothing changed.
--
-- The tables are not listed: REVOKE … ON ALL TABLES IN SCHEMA bob covers every
-- relation there, and the checks read pg_class.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Only the owner of bob: it holds the grants to revoke, and the service role
-- or a member must not be the one doing it.
DO $$
DECLARE owner_name text;
BEGIN
  SELECT nspowner::regrole::text INTO owner_name FROM pg_namespace WHERE nspname = 'bob';
  IF owner_name IS NULL THEN
    RAISE EXCEPTION 'F-58: there is no schema bob here' USING ERRCODE = 'invalid_schema_name';
  END IF;
  IF NOT pg_has_role(current_user, owner_name, 'USAGE') THEN
    RAISE EXCEPTION 'F-58: run as the owner of schema bob (%), not as %', owner_name, current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Before: what is held, for the record.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_class c
    JOIN pg_namespace s ON s.oid = c.relnamespace AND s.nspname = 'bob'
    CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role',
                            'bob_app', 'bob_feeder', 'bob_ai_ro']) AS g(name)
    JOIN pg_roles r ON r.rolname = g.name
    CROSS JOIN unnest(ARRAY['TRIGGER', 'REFERENCES']) AS p
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_table_privilege(r.oid, c.oid, p);
  RAISE NOTICE 'F-58 before: % grants of TRIGGER or REFERENCES held by application roles', n;
END $$;

REVOKE TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA bob
  FROM PUBLIC, anon, authenticated, service_role, bob_app, bob_feeder, bob_ai_ro;

-- After: nothing may be left. A grant this role did not make (another grantor)
-- survives a REVOKE, which only warns; this refuses instead, and the
-- transaction takes back the rest.
DO $$
DECLARE left_over text; tables int;
BEGIN
  SELECT string_agg(DISTINCT r.rolname || ' ' || p || ' ' || c.relname, ', ') INTO left_over
    FROM pg_class c
    JOIN pg_namespace s ON s.oid = c.relnamespace AND s.nspname = 'bob'
    CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role',
                            'bob_app', 'bob_feeder', 'bob_ai_ro']) AS g(name)
    JOIN pg_roles r ON r.rolname = g.name
    CROSS JOIN unnest(ARRAY['TRIGGER', 'REFERENCES']) AS p
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_table_privilege(r.oid, c.oid, p);
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION 'F-58: still held after the revoke: %', left_over
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*) INTO tables FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'bob' AND c.relkind IN ('r', 'p', 'v', 'm', 'f');
  RAISE NOTICE 'F-58 after: 0 grants left on % relations of bob. OK', tables;
END $$;

COMMIT;
