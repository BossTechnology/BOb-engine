#!/usr/bin/env bash
# scripts/bob-dependientes.sh — what lives outside `bob` and depends on it, for
# a restore of `bob` alone (F-47; docs/p5-failed-migration-procedure.md §4.3).
#
# DROP SCHEMA bob CASCADE also drops every object outside `bob` that depends on
# a `bob` object, and pg_dump -n bob does not carry them back. Today these are
# functions in `public`: one returns a `bob` type (Slice 6's bob_outbox_drain),
# and Slice 3's are written with BEGIN ATOMIC over `bob` tables. They are found
# in pg_depend, transitively, never listed by hand.
#
# USAGE (as the box's superuser, through the container's socket, the way the
# restore itself runs)
#   scripts/bob-dependientes.sh --listar                 # one line per object
#   scripts/bob-dependientes.sh --guardar <dir>          # before the DROP
#   scripts/bob-dependientes.sh --reponer <dir>          # after bob.sql.gz
# OPTIONS
#   --contenedor NAME    the Supabase database container (bzzz-supabase-db)
#
# --listar prints `function|<schema>|<name>(<arg types>)|<name>(<identity args>)`, `view|<schema>|<name>`,
# or `otro|<type>|<identity>` for a kind this script cannot bring back (a
# trigger, a policy, a column default). Any `otro` line stops --guardar: the
# restore of `bob` alone would lose it, and that is decided by hand.
#
# --guardar writes into <dir>:
#   dependientes.txt    what --listar printed
#   dependientes.dump   pg_dump --schema-only of the schemas they live in
#   dependientes.lista  the pg_restore TOC entries for exactly those objects:
#                       their CREATE, owner, grants and comments
#   dependientes.sql    those entries as SQL, readable before anything runs
# The definitions come from the box itself, just before the drop, so they are
# whatever the applied chain made them.
#
# --reponer runs dependientes.sql in one transaction, stopping at the first
# error. Nothing else is touched.
#
# EXIT: 0 done · 1 failed, or an object it cannot bring back · 2 bad usage.
set -euo pipefail

CONT=bzzz-supabase-db; MODO=""; DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --contenedor) CONT="$2"; shift 2 ;;
    --listar) MODO=listar; shift ;;
    --guardar|--reponer) MODO="${1#--}"; DIR="${2:-}"; shift 2 || { echo "falta el directorio" >&2; exit 2; } ;;
    *) echo "opción desconocida: $1" >&2; exit 2 ;;
  esac
done
[ -n "$MODO" ] || { echo "uso: $0 [--contenedor NAME] --listar | --guardar <dir> | --reponer <dir>" >&2; exit 2; }
[ "$MODO" = listar ] || [ -d "$DIR" ] || { echo "no existe el directorio: $DIR" >&2; exit 2; }

listar() {
  docker exec -i "$CONT" psql -X -q -At -U supabase_admin -d postgres -v ON_ERROR_STOP=1 </dev/null -c "
WITH RECURSIVE en_bob(classid, objid) AS (
       SELECT 'pg_class'::regclass, c.oid FROM pg_class c WHERE c.relnamespace = 'bob'::regnamespace
       UNION ALL SELECT 'pg_type'::regclass, t.oid FROM pg_type t WHERE t.typnamespace = 'bob'::regnamespace
       UNION ALL SELECT 'pg_proc'::regclass, p.oid FROM pg_proc p WHERE p.pronamespace = 'bob'::regnamespace
     ), dep(classid, objid) AS (
       SELECT d.classid, d.objid FROM pg_depend d
         JOIN en_bob b ON b.classid = d.refclassid AND b.objid = d.refobjid
        WHERE d.deptype IN ('n', 'a', 'i')
       UNION
       SELECT d.classid, d.objid FROM pg_depend d
         JOIN dep x ON x.classid = d.refclassid AND x.objid = d.refobjid
        WHERE d.deptype IN ('n', 'a', 'i')
     ), con_esquema AS (
       -- pg_identify_object names no schema for a default, a trigger, a policy
       -- or a view's rule: theirs is the schema of the relation they hang on.
       SELECT d.classid, d.objid, o.type, o.identity,
              COALESCE(o.schema, (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                   WHERE c.oid = CASE d.classid
                                     WHEN 'pg_attrdef'::regclass THEN (SELECT adrelid FROM pg_attrdef WHERE oid = d.objid)
                                     WHEN 'pg_trigger'::regclass THEN (SELECT tgrelid FROM pg_trigger WHERE oid = d.objid)
                                     WHEN 'pg_policy'::regclass  THEN (SELECT polrelid FROM pg_policy WHERE oid = d.objid)
                                     WHEN 'pg_rewrite'::regclass THEN (SELECT ev_class FROM pg_rewrite WHERE oid = d.objid)
                                     WHEN 'pg_constraint'::regclass THEN (SELECT conrelid FROM pg_constraint WHERE oid = d.objid)
                                   END)) AS schema
         FROM dep d, pg_identify_object(d.classid, d.objid, 0) o
        -- Publication membership is not an object to bring back: the
        -- procedure re-adds it from bob_publicaciones.txt (F-36).
        WHERE d.classid <> 'pg_publication_rel'::regclass
     ), fuera AS (
       SELECT type, schema, identity, classid, objid FROM con_esquema
        WHERE schema IS DISTINCT FROM 'bob' AND schema IS DISTINCT FROM 'pg_toast'
     )
     SELECT DISTINCT linea FROM (
       SELECT 'function|' || n.nspname || '|' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')'
              || '|' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS linea
         FROM fuera f JOIN pg_proc p ON f.classid = 'pg_proc'::regclass AND p.oid = f.objid
         JOIN pg_namespace n ON n.oid = p.pronamespace
       UNION ALL
       SELECT 'view|' || n.nspname || '|' || c.relname
         FROM fuera f JOIN pg_rewrite r ON f.classid = 'pg_rewrite'::regclass AND r.oid = f.objid
         JOIN pg_class c ON c.oid = r.ev_class AND c.relkind IN ('v', 'm')
         JOIN pg_namespace n ON n.oid = c.relnamespace
       UNION ALL
       SELECT 'view|' || n.nspname || '|' || c.relname
         FROM fuera f JOIN pg_class c ON f.classid = 'pg_class'::regclass AND c.oid = f.objid AND c.relkind IN ('v', 'm')
         JOIN pg_namespace n ON n.oid = c.relnamespace
       UNION ALL
       SELECT 'otro|' || f.type || '|' || f.identity FROM fuera f
        WHERE f.classid NOT IN ('pg_proc'::regclass, 'pg_rewrite'::regclass)
          AND NOT (f.classid = 'pg_class'::regclass
                   AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = f.objid AND c.relkind IN ('v', 'm')))
          AND NOT (f.classid = 'pg_type'::regclass
                   AND EXISTS (SELECT 1 FROM pg_type t JOIN pg_class c ON c.reltype = t.oid
                                WHERE t.oid = f.objid AND c.relkind IN ('v', 'm')))
     ) l ORDER BY 1"
}

case "$MODO" in
  listar) listar ;;
  guardar)
    listar > "$DIR/dependientes.txt"
    if grep -q '^otro|' "$DIR/dependientes.txt"; then
      echo "hay objetos fuera de bob que dependen de bob y que este script no sabe reponer:" >&2
      grep '^otro|' "$DIR/dependientes.txt" >&2; exit 1
    fi
    : > "$DIR/dependientes.sql"; : > "$DIR/dependientes.lista"
    esquemas="$(cut -d'|' -f2 "$DIR/dependientes.txt" | sort -u | sed 's/^/-n /' | paste -sd' ' -)"
    [ -n "$esquemas" ] || exit 0
    # shellcheck disable=SC2086
    docker exec "$CONT" pg_dump -U supabase_admin -d postgres --schema-only -Fc $esquemas > "$DIR/dependientes.dump"
    # A TOC line reads `id; tableoid oid DESC SCHEMA TAG OWNER`. A function's
    # CREATE is `FUNCTION public f(integer) owner`, by argument types, and its
    # grant and comment are `ACL public FUNCTION f(p_limit integer) owner` and
    # `COMMENT public FUNCTION …`, by identity arguments, names included.
    # A view's grant is tagged TABLE.
    docker exec -i "$CONT" pg_restore -l < "$DIR/dependientes.dump" | awk -v L="$DIR/dependientes.txt" '
      BEGIN { while ((getline x < L) > 0) { split(x, a, "|")
                if (a[1] == "function") { w[" FUNCTION " a[2] " " a[3] " "]; w[" " a[2] " FUNCTION " a[4] " "] }
                if (a[1] == "view") { w[" VIEW " a[2] " " a[3] " "]; w[" MATERIALIZED VIEW " a[2] " " a[3] " "]
                                      w[" " a[2] " TABLE " a[3] " "]; w[" " a[2] " VIEW " a[3] " "] } } }
      /^;/ { next }
      { for (k in w) if (index($0 " ", k) > 0) { print; next } }' > "$DIR/dependientes.lista"
    # Recreated as the superuser, each object also gets the default privileges
    # of `public` (Supabase's hand EXECUTE to anon, authenticated and
    # service_role), and pg_dump's grants only state the difference from the
    # built-in default. So dependientes.sql is: the CREATEs and owners, then a
    # reset of each object's ACL to the built-in default (owner, and EXECUTE
    # to PUBLIC for a function), then the dumped grants.
    parte() {  # <awk filter on the TOC> -> SQL of those entries
      docker exec -i -e TOC="$(awk "$1" "$DIR/dependientes.lista")" "$CONT" \
        sh -c 'l=$(mktemp); trap "rm -f \$l" EXIT; printf "%s\n" "$TOC" > "$l"; pg_restore -L "$l" -f -' \
        < "$DIR/dependientes.dump"
    }
    funciones="$(awk -F'|' '$1 == "function" { printf "%s%s", s, "'"'"'" $2 "." $3 "'"'"'"; s = "," }' "$DIR/dependientes.txt")"
    vistas="$(awk -F'|' '$1 == "view" { printf "%s%s", s, "'"'"'" $2 "." $3 "'"'"'"; s = "," }' "$DIR/dependientes.txt")"
    {
      parte '$4 != "ACL"'
      cat <<SQL
-- bob-dependientes.sh: each object back to the built-in default ACL, so the
-- grants below land on what the dump assumed, not on public's defaults.
DO \$\$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure::text AS o, a.grantee
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.oid = ANY (ARRAY[${funciones:-NULL}]::regprocedure[]) AND a.grantee <> p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', r.o,
                   CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.grantee::regrole::text) END);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure::text AS o FROM pg_proc p
            WHERE p.oid = ANY (ARRAY[${funciones:-NULL}]::regprocedure[]) LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', r.o);
  END LOOP;
  FOR r IN SELECT c.oid::regclass::text AS o, a.grantee
             FROM pg_class c, aclexplode(c.relacl) a
            WHERE c.oid = ANY (ARRAY[${vistas:-NULL}]::regclass[]) AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM %s', r.o,
                   CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(r.grantee::regrole::text) END);
  END LOOP;
END
\$\$;
SQL
      parte '$4 == "ACL"'
    } > "$DIR/dependientes.sql"
    n="$(wc -l < "$DIR/dependientes.txt" | tr -d ' ')"
    c="$(grep -cE '^CREATE (FUNCTION|VIEW|MATERIALIZED VIEW) ' "$DIR/dependientes.sql" || true)"
    [ "$n" = "$c" ] || { echo "apuntados $n, con CREATE en dependientes.sql $c" >&2; exit 1; }
    echo "guardados $n objeto(s) en $DIR/dependientes.sql" ;;
  reponer)
    [ -f "$DIR/dependientes.sql" ] || { echo "no existe $DIR/dependientes.sql" >&2; exit 2; }
    docker exec -i "$CONT" psql -X -q -1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < "$DIR/dependientes.sql" >/dev/null
    echo "repuestos $(grep -cE '^CREATE (FUNCTION|VIEW|MATERIALIZED VIEW) ' "$DIR/dependientes.sql" || true) objeto(s)" ;;
esac
