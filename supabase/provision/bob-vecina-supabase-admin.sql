-- What only supabase_admin can do (D77 77.21 and 77.22). Applied after
-- bob-vecina.sql, on a box where postgres applied the install chain, so
-- everything in bob is postgres's. Idempotent.
--
-- postgres cannot do this part: it holds no grant option on schema auth (owner
-- supabase_admin), and it cannot give schema bob to bob_migrador, which has no
-- CREATE on the database, unless it is a superuser (measured, 532db30 and on).

-- Every tenant policy calls auth.jwt(); creating one needs USAGE on auth.
GRANT USAGE ON SCHEMA auth TO bob_migrador;

-- The hand-over: schema bob and everything in it to bob_migrador, so every
-- migration after the install chain applies as it. Sequences owned by a column
-- and table row types follow their table.
ALTER SCHEMA bob OWNER TO bob_migrador;

DO $$
DECLARE r record;
BEGIN
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
       AND (t.typtype IN ('e', 'd', 'r')
            OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
  LOOP
    EXECUTE r.stmt;
  END LOOP;
END
$$;
