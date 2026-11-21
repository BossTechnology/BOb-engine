-- The fingerprint of schema `bob`, and of what outside it BOb's chain owns.
--
-- One line per object, `kind|name|detail`, sorted. Two runs over the same
-- schema print the same text, so a restore is checked by diffing the text
-- taken before the damage against the text taken after the restore. Every
-- object is found in the catalog, never listed: an object a later slice adds is
-- in the fingerprint without anyone extending this file.
--
-- What it covers, and why each one:
--   - relations in `bob`: kind, owner, grants, reloptions (security_invoker on
--     the definer views), RLS flags, partition bound, and the md5 of their
--     columns or their view definition;
--   - constraints, indexes, policies and triggers on those relations;
--   - functions in `bob` and in `public`: owner, SECURITY DEFINER, their
--     search_path, grants and the md5 of their source. Public is included
--     because the chain keeps BOb's functions there (Slice 2, migration 1), and
--     a DROP SCHEMA bob CASCADE can take one with it;
--   - default privileges, publication membership, sequences and comments;
--   - triggers on tables outside `bob` that call a function of the chain
--     (on_auth_user_created on auth.users).
-- No row values. Row counts are taken separately and never printed here.

WITH bob_rel AS (
  SELECT c.oid, c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'bob' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
),
lines AS (
  SELECT 'schema' AS kind, n.nspname AS name,
         format('owner=%s acl=%s', pg_get_userbyid(n.nspowner), n.nspacl::text) AS detail
    FROM pg_namespace n WHERE n.nspname = 'bob'
  UNION ALL
  SELECT 'relation', 'bob.' || c.relname,
         format('kind=%s owner=%s acl=%s options=%s rls=%s force=%s partition=%s shape=%s',
           c.relkind, pg_get_userbyid(c.relowner), c.relacl::text, c.reloptions::text,
           c.relrowsecurity, c.relforcerowsecurity,
           coalesce(pg_get_expr(c.relpartbound, c.oid), '-'),
           CASE WHEN c.relkind IN ('v', 'm') THEN md5(pg_get_viewdef(c.oid))
                ELSE md5(coalesce((
                  SELECT string_agg(format('%s:%s:%s:%s', a.attname,
                           format_type(a.atttypid, a.atttypmod), a.attnotnull,
                           coalesce(pg_get_expr(d.adbin, d.adrelid), '')), ',' ORDER BY a.attnum)
                    FROM pg_attribute a
                    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '')) END)
    FROM pg_class c JOIN bob_rel r ON r.oid = c.oid
  UNION ALL
  SELECT 'constraint', 'bob.' || r.relname || '.' || k.conname,
         format('type=%s def=%s', k.contype, md5(pg_get_constraintdef(k.oid)))
    FROM pg_constraint k JOIN bob_rel r ON r.oid = k.conrelid
  UNION ALL
  SELECT 'index', 'bob.' || i.indexname, md5(i.indexdef)
    FROM pg_indexes i WHERE i.schemaname = 'bob'
  UNION ALL
  SELECT 'policy', 'bob.' || p.tablename || '.' || p.policyname,
         format('permissive=%s cmd=%s roles=%s using=%s check=%s', p.permissive, p.cmd,
           p.roles::text, md5(coalesce(p.qual, '')), md5(coalesce(p.with_check, '')))
    FROM pg_policies p WHERE p.schemaname = 'bob'
  UNION ALL
  SELECT 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname,
         format('enabled=%s def=%s', t.tgenabled, md5(pg_get_triggerdef(t.oid)))
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc f ON f.oid = t.tgfoid
    JOIN pg_namespace fn ON fn.oid = f.pronamespace
   WHERE NOT t.tgisinternal
     AND (n.nspname = 'bob' OR fn.nspname IN ('bob', 'public'))
  UNION ALL
  SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         format('owner=%s definer=%s config=%s acl=%s returns=%s src=%s',
           pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig::text, p.proacl::text,
           pg_get_function_result(p.oid), md5(p.prosrc))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('bob', 'public')
  UNION ALL
  SELECT 'default_acl', coalesce(n.nspname, '*') || '.' || d.defaclobjtype::text,
         format('role=%s acl=%s', pg_get_userbyid(d.defaclrole), d.defaclacl::text)
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
   WHERE n.nspname = 'bob'
  UNION ALL
  SELECT 'publication', pt.pubname || ':' || pt.schemaname || '.' || pt.tablename, '-'
    FROM pg_publication_tables pt WHERE pt.schemaname = 'bob'
  UNION ALL
  SELECT 'sequence', 'bob.' || s.sequencename,
         format('owner=%s last=%s', s.sequenceowner, coalesce(s.last_value::text, 'null'))
    FROM pg_sequences s WHERE s.schemaname = 'bob'
  UNION ALL
  SELECT 'comment', 'bob.' || r.relname, md5(coalesce(obj_description(r.oid, 'pg_class'), ''))
    FROM bob_rel r
)
SELECT kind || '|' || name || '|' || coalesce(detail, '') FROM lines ORDER BY 1;
