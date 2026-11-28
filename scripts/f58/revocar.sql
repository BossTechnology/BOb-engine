-- ════════════════════════════════════════════════════════════════════════════
-- F-58 · the separate REVOKE step (Henry, 27 Nov: «Paso REVOKE aparte»;
-- «00f79b7 + REVOKE»)
--
-- The tables of bob were created in public, where Supabase's default
-- privileges for postgres give authenticated TRIGGER and REFERENCES (and, on
-- Postgres 17, MAINTAIN), and were moved to bob with that ACL. A member could
-- attach a trigger to any table of bob, or lock it. The application needs
-- only SELECT, INSERT, UPDATE and DELETE on bob's relations; this takes every
-- other table privilege away from every role the application runs as, and
-- leaves those four exactly as they were (the viewer's reads included).
--
-- Not a migration and not part of the install chain: the signed commit
-- 00f79b7 is installed as it is, and this runs once after it, by hand, as the
-- owner of schema bob (bob_migrador on a box). It is idempotent and runs in
-- one transaction: it ends by checking, and raises if anything is left or if
-- any SELECT, INSERT, UPDATE or DELETE changed, so either all of it is done or
-- nothing changed.
--
-- Nothing is listed by hand but the application's roles: the relations come
-- from pg_class, the privileges from their ACLs (aclexplode), so a privilege
-- type this file does not name (MAINTAIN on 17) is found and taken too.
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

-- The roles the application runs as, those this server has (0 = PUBLIC).
CREATE TEMP TABLE f58_roles ON COMMIT DROP AS
  SELECT r.oid AS grantee, quote_ident(r.rolname) AS name
    FROM pg_roles r
   WHERE r.rolname IN ('anon', 'authenticated', 'service_role', 'bob_app', 'bob_feeder', 'bob_ai_ro')
  UNION ALL SELECT 0::oid, 'PUBLIC';

-- The relations of bob.
CREATE TEMP TABLE f58_rels ON COMMIT DROP AS
  SELECT c.oid AS rel, format('%I.%I', s.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace AND s.nspname = 'bob'
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f');

-- The table privileges this server knows, besides the four the application
-- uses. MAINTAIN exists from Postgres 17.
CREATE TEMP TABLE f58_extra ON COMMIT DROP AS
  SELECT p FROM unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) p
  UNION ALL SELECT 'MAINTAIN' WHERE current_setting('server_version_num')::int >= 170000;

-- What is held that should not be: by inheritance (has_table_privilege), in
-- the ACL under any type but the four (aclexplode), or on a column
-- (REFERENCES, the one column privilege that is not one of the four).
CREATE TEMP VIEW f58_held AS
  SELECT rl.name AS rol, e.p AS priv, x.name AS rel
    FROM f58_rels x CROSS JOIN f58_roles rl CROSS JOIN f58_extra e
   WHERE rl.grantee <> 0 AND has_table_privilege(rl.grantee, x.rel, e.p)
  UNION
  SELECT rl.name, a.privilege_type, x.name
    FROM f58_rels x JOIN pg_class c ON c.oid = x.rel, aclexplode(c.relacl) a
    JOIN f58_roles rl ON rl.grantee = a.grantee
   WHERE a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  UNION
  SELECT rl.name, 'REFERENCES (column)', x.name
    FROM f58_rels x CROSS JOIN f58_roles rl
   WHERE rl.grantee <> 0 AND has_any_column_privilege(rl.grantee, x.rel, 'REFERENCES')
     AND NOT has_table_privilege(rl.grantee, x.rel, 'REFERENCES');

-- SELECT, INSERT, UPDATE and DELETE as they stand: none may change.
CREATE TEMP TABLE f58_dml ON COMMIT DROP AS
  SELECT rl.grantee, x.rel, p,
         has_table_privilege(rl.grantee, x.rel, p) AS tabla,
         CASE WHEN p <> 'DELETE' THEN has_any_column_privilege(rl.grantee, x.rel, p) END AS columna
    FROM f58_rels x CROSS JOIN f58_roles rl
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
   WHERE rl.grantee <> 0;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM f58_held;
  RAISE NOTICE 'F-58 before: % grants beyond SELECT, INSERT, UPDATE and DELETE held by application roles', n;
END $$;

-- Revoke each one found, table-wide and on every column. A REVOKE of a grant
-- someone else made only warns; the check below refuses it.
DO $$
DECLARE g record;
BEGIN
  FOR g IN
    SELECT DISTINCT x.name AS rel, rl.name AS rol, a.privilege_type AS priv
      FROM f58_rels x JOIN pg_class c ON c.oid = x.rel, aclexplode(c.relacl) a
      JOIN f58_roles rl ON rl.grantee = a.grantee
     WHERE a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  LOOP
    EXECUTE format('REVOKE %s ON %s FROM %s', g.priv, g.rel, g.rol);
  END LOOP;
  FOR g IN
    SELECT DISTINCT x.name AS rel, rl.name AS rol, quote_ident(t.attname) AS col
      FROM f58_rels x JOIN pg_attribute t ON t.attrelid = x.rel AND t.attnum > 0 AND NOT t.attisdropped,
           aclexplode(t.attacl) a
      JOIN f58_roles rl ON rl.grantee = a.grantee
     WHERE a.privilege_type = 'REFERENCES'
  LOOP
    EXECUTE format('REVOKE REFERENCES (%s) ON %s FROM %s', g.col, g.rel, g.rol);
  END LOOP;
END $$;

-- After: nothing may be left, and nothing the application uses may be gone.
DO $$
DECLARE left_over text; changed text; tables int;
BEGIN
  SELECT string_agg(rol || ' ' || priv || ' ' || rel, ', ' ORDER BY rol, priv, rel)
    INTO left_over FROM f58_held;
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION 'F-58: still held after the revoke: %', left_over
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT string_agg(pg_get_userbyid(d.grantee) || ' ' || d.p || ' ' || d.rel::regclass::text, ', ')
    INTO changed FROM f58_dml d
   WHERE d.tabla IS DISTINCT FROM has_table_privilege(d.grantee, d.rel, d.p)
      OR d.columna IS DISTINCT FROM CASE WHEN d.p <> 'DELETE' THEN has_any_column_privilege(d.grantee, d.rel, d.p) END;
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'F-58: SELECT, INSERT, UPDATE or DELETE changed: %', changed;
  END IF;
  SELECT count(*) INTO tables FROM f58_rels;
  IF tables = 0 THEN
    -- Nothing checked is not «0 grants left»: bob is empty or not the
    -- installed one.
    RAISE EXCEPTION 'F-58: schema bob holds no relation: nothing was checked'
      USING ERRCODE = 'undefined_table';
  END IF;
  RAISE NOTICE 'F-58 after: 0 grants left on % relations of bob; SELECT, INSERT, UPDATE and DELETE unchanged. OK', tables;
END $$;

-- Tables made later: default privileges of the owner of bob (or of whoever
-- runs this) that would give an application role or PUBLIC more than SELECT,
-- INSERT, UPDATE and DELETE on new tables in bob, or in every schema. Not
-- changed here (the step takes what exists); reported, so the next migration
-- or Henry decides.
DO $$
DECLARE found text;
BEGIN
  SELECT string_agg(DISTINCT pg_get_userbyid(d.defaclrole) || ' gives '
           || coalesce(rl.name, 'PUBLIC') || ' ' || a.privilege_type || ' on new tables '
           || CASE WHEN d.defaclnamespace = 0 THEN 'in every schema' ELSE 'in bob' END, '; ')
    INTO found
    FROM pg_default_acl d, aclexplode(d.defaclacl) a
    JOIN f58_roles rl ON rl.grantee = a.grantee
   WHERE d.defaclobjtype = 'r'
     AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'bob'::regnamespace)
     AND d.defaclrole IN ((SELECT nspowner FROM pg_namespace WHERE nspname = 'bob'),
                          (SELECT oid FROM pg_roles WHERE rolname = current_user))
     AND a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  IF found IS NOT NULL THEN
    RAISE WARNING 'F-58 default privileges: %', found
      USING HINT = 'Tables created later in bob would carry these. Not changed by this step: tell Henry.';
  ELSE
    RAISE NOTICE 'F-58 default privileges: none beyond SELECT, INSERT, UPDATE and DELETE for new tables in bob';
  END IF;
END $$;

DROP VIEW f58_held;
COMMIT;
