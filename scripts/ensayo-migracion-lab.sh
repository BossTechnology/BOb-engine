#!/usr/bin/env bash
# scripts/ensayo-migracion-lab.sh — the failed-migration rehearsal of P5 (D62)
# on bzzz-lab-02, before the signature (docs/p5-application-layer.md §6.2 and
# §8, objections 2, 5 and 6).
#
# WHO RUNS IT. Henry, or someone he authorizes, on bzzz-lab-02. Never an agent,
# never a running service, never a customer box. It refuses any host that is
# not bzzz-lab-02 unless told it is a local target.
#
# WHAT IT DOES, in order, writing every step to a redacted evidence file:
#   0. preflight: the CLI at the version CI pins, the checkout, the container,
#      the migration credential in its own file, and a box with no BOb yet;
#   1. a full dump of the box's `postgres` database before anything changes;
#   2. a copy of the chain with two migrations rigged to fail half-way, one
#      not wrapped in BEGIN … COMMIT (among the nine old ones) and one wrapped
#      (inside Slice 2);
#   3. `supabase db push` three times, and after each one what
#      supabase_migrations.schema_migrations says, which objects exist and
#      whether the failing file left anything behind;
#   4. a restore of `bob` alone: synthetic data, a dump of `bob` taken the way
#      Bzzz scripts/backup.sh takes it (no proj_* data), what lives outside
#      `bob` and depends on it saved from the box (F-47), the schema dropped,
#      the dump restored and those objects put back, the definer views and
#      SECURITY DEFINER functions
#      compared against a fingerprint, and the projections rebuilt by the
#      reference feeder;
#   5. auth.users counted at every step: `auth` is never touched by BOb;
#   6. scripts/box-check.mjs, read-only. Its egress check fails closed (PR
#      #47): any extension outside the approved five, any foreign server, any
#      untrusted language but c and internal. The kit records every installed
#      extension, and still where `pg_net` and `http` stand (F-27).
#
# WHAT IT LEAVES. The box with the real chain applied at the checkout's commit,
# and no synthetic data. To take BOb off the box again: --deshacer <run dir>.
#
# USAGE
#   scripts/ensayo-migracion-lab.sh --dry-run      # preflight and `db push --dry-run`
#   scripts/ensayo-migracion-lab.sh --ejecutar     # the rehearsal
#   scripts/ensayo-migracion-lab.sh --deshacer <dir de la corrida>
#
# OPTIONS (the defaults are lab-02's)
#   --objetivo lab-02|local     local: a disposable stack on this machine
#   --contenedor NAME           the Supabase database container (bzzz-supabase-db)
#   --red NAME                  its docker network (bzzz-app)
#   --db-host HOST --db-port N  how the CLI and node reach it from this host
#                               (default: the container's address on --red, 5432)
#   --migrador FILE             /opt/bob/secrets/migrador.env (the alta, bzzz#450)
#   --salida DIR                /data/bzzz/misc/ensayo-p5
#   --supabase BIN              supabase
#
# THE CREDENTIAL FILE holds two lines, read by name and never printed:
#   MIGRADOR_USUARIO=…
#   MIGRADOR_CLAVE=...
# Mode 600. Only this script reads it (objection 6).
#
# EXIT: 0 every check as expected · 1 a check did not hold · 2 refused to start.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
AQUI="$REPO/scripts/ensayo-migracion-lab"

MODO="" ; DIR_DESHACER=""
OBJETIVO="lab-02"
CONT="bzzz-supabase-db"
RED="bzzz-app"
DB_HOST="" ; DB_PORT=""
MIGRADOR="/opt/bob/secrets/migrador.env"
SALIDA="/data/bzzz/misc/ensayo-p5"
SUPABASE="supabase"
NODE="node"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)    MODO=dry-run ;;
    --ejecutar)   MODO=ejecutar ;;
    --deshacer)   MODO=deshacer; DIR_DESHACER="${2:?--deshacer necesita el directorio de la corrida}"; shift ;;
    --objetivo)   OBJETIVO="${2:?}"; shift ;;
    --contenedor) CONT="${2:?}"; shift ;;
    --red)        RED="${2:?}"; shift ;;
    --db-host)    DB_HOST="${2:?}"; shift ;;
    --db-port)    DB_PORT="${2:?}"; shift ;;
    --migrador)   MIGRADOR="${2:?}"; shift ;;
    --salida)     SALIDA="${2:?}"; shift ;;
    --supabase)   SUPABASE="${2:?}"; shift ;;
    -h|--help)    sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "opción desconocida: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$MODO" ] || { echo "falta el modo: --dry-run, --ejecutar o --deshacer <dir>" >&2; exit 2; }

rechazar() { echo "RECHAZADO: $*" >&2; exit 2; }

# The sabotage switches exist for the local bench only, and are refused first.
SABOTAJE="${ENSAYO_P5_SABOTAJE:-}"
[ -z "$SABOTAJE" ] || [ "$OBJETIVO" = local ] || rechazar "ENSAYO_P5_SABOTAJE solo con --objetivo local"

# ── Where it may run ─────────────────────────────────────────────────────────
HOST_ACTUAL="$(hostname -s 2>/dev/null || hostname)"
case "$OBJETIVO" in
  lab-02)
    [ "$HOST_ACTUAL" = "bzzz-lab-02" ] || rechazar "esto corre en bzzz-lab-02, y esta máquina es $HOST_ACTUAL"
    ;;
  local)
    case "$HOST_ACTUAL" in bzzz-*) rechazar "--objetivo local en una caja ($HOST_ACTUAL)" ;; esac
    [ "$CONT" != "bzzz-supabase-db" ] || rechazar "--objetivo local con el contenedor de una caja"
    ;;
  *) rechazar "--objetivo es lab-02 o local" ;;
esac
# Sabotage switches exist so that the local bench can see each check fail. They
# are refused anywhere but a local target.

# ── The credential, by name, never printed ───────────────────────────────────
[ -f "$MIGRADOR" ] || rechazar "no existe $MIGRADOR (objeción 6: la credencial de migración va en su propio fichero)"
PERM="$(stat -c %a "$MIGRADOR" 2>/dev/null || stat -f %Lp "$MIGRADOR")"
[ "$PERM" = 600 ] || rechazar "$MIGRADOR está en modo $PERM, no en 600"
leer_var() { sed -n "s/^$1=//p" "$MIGRADOR" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
# The alta's names (bzzz#450); the older BOB_MIGRADOR_* still read.
USUARIO="$(leer_var MIGRADOR_USUARIO)"; [ -n "$USUARIO" ] || USUARIO="$(leer_var BOB_MIGRADOR_USUARIO)"
CLAVE="$(leer_var MIGRADOR_CLAVE)"; [ -n "$CLAVE" ] || CLAVE="$(leer_var BOB_MIGRADOR_CLAVE)"
[ -n "$USUARIO" ] || rechazar "$MIGRADOR no trae MIGRADOR_USUARIO"
[ -n "$CLAVE" ] || rechazar "$MIGRADOR no trae MIGRADOR_CLAVE"
[[ "$USUARIO" =~ ^[a-z_][a-z0-9_]*$ ]] || rechazar "MIGRADOR_USUARIO no tiene forma de rol"
export PGPASSWORD="$CLAVE" PGUSER="$USUARIO"

# ── The container and how to reach it ────────────────────────────────────────
command -v docker >/dev/null || rechazar "no hay docker"
docker inspect -f '{{.State.Running}}' "$CONT" 2>/dev/null | grep -qx true || rechazar "el contenedor $CONT no está en marcha"
IP_RED="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$RED\"}}{{.IPAddress}}{{end}}" "$CONT" 2>/dev/null || true)"
[ -n "$IP_RED" ] || rechazar "$CONT no está en la red $RED"
DB_HOST="${DB_HOST:-$IP_RED}"
DB_PORT="${DB_PORT:-5432}"
DB_URL="postgresql://$USUARIO@$DB_HOST:$DB_PORT/postgres?sslmode=disable"
export SUPABASE_DB_URL="$DB_URL"

# As the box's superuser through the container's socket, the way Bzzz
# backup.sh and docs/OPERACION_restaurar_identidad.md reach it.
psql_admin() { docker exec -i "$CONT" psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At "$@"; }
# As the migration owner, over the network path and with its password: the
# same authentication the CLI goes through. PGPASSWORD reaches the container
# by name (`-e PGPASSWORD`), never as an argument.
psql_mig() { docker exec -i -e PGPASSWORD -e PGUSER "$CONT" psql -X -q -h "$IP_RED" -p 5432 -d postgres -v ON_ERROR_STOP=1 -At "$@"; }
# </dev/null: with -i, docker exec waits for stdin to close, and a terminal
# or a bench never closes it.
q() { psql_admin -c "$1" </dev/null; }

# ── Evidence ─────────────────────────────────────────────────────────────────
SELLO="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
if [ "$MODO" = deshacer ]; then
  RUN="${DIR_DESHACER%/}"
  [ -f "$RUN/inventario-antes.txt" ] || rechazar "$RUN no es una corrida de --ejecutar (falta inventario-antes.txt)"
  EV="$RUN/deshacer-$SELLO.md"
else
  RUN="$SALIDA/$SELLO-$MODO"
  mkdir -p "$RUN"
  EV="$RUN/evidencia.md"
fi
FALLOS=0; CHECKS=0

# Every byte of evidence goes through here. The password is replaced by
# content, not by pattern (awk index, no regex to escape), and so are the
# container's address, any connection string with credentials, and e-mails.
redactar() {
  CLAVE_R="$CLAVE" IP_R="$IP_RED" HOST_R="$DB_HOST" awk '
    function rep(s, a, b,   i, o) { if (a == "") return s; o = "";
      while ((i = index(s, a)) > 0) { o = o substr(s, 1, i - 1) b; s = substr(s, i + length(a)) } return o s }
    { l = rep($0, ENVIRON["CLAVE_R"], "<clave>")
      l = rep(l, ENVIRON["IP_R"], "<ip-contenedor>")
      if (ENVIRON["HOST_R"] != "127.0.0.1") l = rep(l, ENVIRON["HOST_R"], "<host-db>")
      gsub(/postgres(ql)?:\/\/[^@ ]*@/, "postgresql://<usuario>@", l)
      gsub(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/, "<correo>", l)
      print l }'
}
ev() { printf '%s\n' "$*" | redactar >> "$EV"; }
ev_bloque() {  # <title> <cmd...>: runs it, keeps its rc in RC_BLOQUE
  local titulo="$1"; shift
  { printf '\n**%s**\n\n```\n' "$titulo"; } >> "$EV"
  set +e; "$@" 2>&1 | redactar >> "$EV"; RC_BLOQUE=${PIPESTATUS[0]}; set -e
  printf '```\nrc=%s\n' "$RC_BLOQUE" >> "$EV"
}
comprobar() {  # <what> <expected> <got>
  CHECKS=$((CHECKS + 1))
  if [ "$2" = "$3" ]; then
    ev "- OK · $1 — \`$3\`"; echo "  ok    $1"
  else
    FALLOS=$((FALLOS + 1))
    ev "- **FALLO** · $1 — esperado \`$2\`, obtenido \`$3\`"; echo "  FALLO $1 — esperado [$2] obtenido [$3]"
  fi
}
paso() { ev ""; ev "## $*"; ev ""; echo "── $*"; }

# ── Shared readings ──────────────────────────────────────────────────────────
auth_cuentas() { q "SELECT count(*) FROM auth.users"; }
# auth's shape and its rows, as one md5, never the rows themselves.
auth_huella() {
  q "SELECT md5(coalesce((SELECT string_agg(format('%s.%s:%s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod)), ',' ORDER BY c.relname, a.attnum)
                           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                          WHERE n.nspname = 'auth' AND c.relkind = 'r'), '')
                || coalesce((SELECT string_agg(md5(u::text), ',' ORDER BY u.id) FROM auth.users u), ''))"
}
versiones_aplicadas() {
  if [ "$(q "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL")" = t ]; then
    q "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version" | paste -sd, -
  fi
}
existe() { q "SELECT to_regclass('$1') IS NOT NULL"; }
objetos_ensayo() {
  q "SELECT coalesce(string_agg(n.nspname || '.' || c.relname, ',' ORDER BY 1), '')
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname LIKE 'ensayo\_p5\_%'"
}
# Every object outside the catalog, by name, to know what the chain added.
# The inventory comes out in the database's collation, and comm wants the
# shell's. On lab-02 (en_US.UTF-8) they differ, and comm then misses lines,
# which --deshacer relies on. Both sides are sorted bytewise here, so files
# from an earlier run compare right too.
comm_c() { LC_ALL=C comm "$1" <(LC_ALL=C sort "$2") <(LC_ALL=C sort "$3"); }
inventario() {
  q "SELECT 'schema|' || nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
     UNION ALL
     SELECT 'rel|' || n.nspname || '.' || c.relname || '|' || c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','S','f')
     UNION ALL
     SELECT 'function|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     UNION ALL
     SELECT 'trigger|' || n.nspname || '.' || c.relname || '|' || t.tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname NOT LIKE 'pg\_%'
     UNION ALL
     SELECT 'type|' || n.nspname || '.' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema' AND t.typtype IN ('e','d','c')
        AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid AND c.relkind <> 'c')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
     UNION ALL
     SELECT 'role|' || rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\_%'
     UNION ALL
     SELECT 'publication|' || pubname || '|' || schemaname || '.' || tablename FROM pg_publication_tables
     UNION ALL
     SELECT 'extension|' || extname FROM pg_extension
     ORDER BY 1"
}
huella_bob() { psql_admin -f - < "$AQUI/huella.sql"; }
conteos_bob() {  # rows of every bob table that is not a projection, one line each
  local t
  for t in $(q "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'bob' AND c.relkind = 'r' AND NOT c.relispartition
                   AND c.relname NOT LIKE 'proj\_%' ORDER BY 1"); do
    echo "bob.$t=$(q "SELECT count(*) FROM bob.\"$t\"")"
  done
}
# The bob-only dump, exactly as Bzzz scripts/backup.sh takes it. If one
# changes, the other changes in the same window.
volcar_bob() {  # <file.sql.gz>
  docker exec "$CONT" pg_dump -U supabase_admin -d postgres -n bob --exclude-table-data='bob.proj_*' | gzip -6 > "$1"
}
# `pubname table` per line: what backup.sh writes to its manifest, because
# pg_dump -n bob leaves the publication out.
publicacion_bob() { q "SELECT pubname || ' ' || quote_ident(schemaname) || '.' || quote_ident(tablename) FROM pg_publication_tables WHERE schemaname = 'bob' ORDER BY 1"; }
reponer_publicacion() {  # <file>
  local pub tabla
  while read -r pub tabla; do
    # </dev/null: docker exec -i would otherwise eat the rest of the list.
    [ -z "$pub" ] || q "ALTER PUBLICATION $pub ADD TABLE $tabla" >/dev/null </dev/null
  done < "$1"
}
mundo() { (cd "$REPO" && "$NODE" scripts/ensayo-migracion-lab/mundo.mjs "$@"); }

# F-47. What lives outside `bob` and depends on it (a function in `public` that
# returns a `bob` type, or one written with BEGIN ATOMIC over `bob` tables) is
# taken by DROP SCHEMA bob CASCADE and is not in bob.sql.gz. The same script the
# procedure uses (§4.3) notes it, saves it from the box and puts it back.
dependientes() { "$REPO/scripts/bob-dependientes.sh" --contenedor "$CONT" "$@"; }

# ── 0 · Preflight ────────────────────────────────────────────────────────────
preflight() {
  paso "0 · Preflight"
  ev "- modo: \`$MODO\` · objetivo: \`$OBJETIVO\` · máquina: \`$HOST_ACTUAL\` · sello: \`$SELLO\`"
  local cli_ci cli_aqui sha sucio imagen
  cli_ci="$(sed -n 's/^ *SUPABASE_CLI_VERSION: *//p' "$REPO/.github/workflows/ci.yml" | head -1)"
  cli_aqui="$("$SUPABASE" --version 2>/dev/null | grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  comprobar "el CLI de Supabase es el que fija CI (.github/workflows/ci.yml)" "$cli_ci" "${cli_aqui:-ninguno}"
  [ "$cli_ci" = "$cli_aqui" ] || rechazar "CLI $cli_aqui y CI fija $cli_ci"
  sha="$(git -C "$REPO" rev-parse HEAD)"
  sucio="$(git -C "$REPO" status --porcelain -- supabase/migrations scripts/ensayo-migracion-lab.sh scripts/ensayo-migracion-lab | wc -l | tr -d ' ')"
  ev "- commit de BOb-engine: \`$sha\`"
  if [ "$OBJETIVO" = local ]; then
    ev "- ficheros de la cadena o del ensayo sin commitear: $sucio (en local se admite)"
  else
    comprobar "la cadena y el ensayo no tienen cambios sin commitear" "0" "$sucio"
    [ "$sucio" = 0 ] || rechazar "hay cambios sin commitear en la cadena o en el ensayo"
  fi
  imagen="$(docker inspect -f '{{.Config.Image}}' "$CONT")"
  ev "- imagen de \`$CONT\`: \`$imagen\`"
  ev "- \`$MIGRADOR\`: modo $PERM; trae MIGRADOR_USUARIO y MIGRADOR_CLAVE (valores no impresos)"
  command -v "$NODE" >/dev/null || rechazar "no hay node: lo necesita la reconstrucción de las proyecciones"
  [ -d "$REPO/node_modules/pg" ] || rechazar "falta node_modules/pg: corre pnpm install --frozen-lockfile en $REPO"
  local quien
  quien="$(psql_mig -c "SELECT current_user || ' super=' || rolsuper || ' createrole=' || rolcreaterole || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname = current_user" 2>&1 </dev/null)" \
    || rechazar "no conecto como el migrador por $RED: $(printf '%s' "$quien" | redactar | tail -1)"
  ev "- el migrador conecta por la red con su clave: \`$quien\`"
  ev "- server: \`$(q 'SHOW server_version')\`"
  CUENTAS0="$(auth_cuentas)"; AUTH0="$(auth_huella)"
  ev "- auth.users: $CUENTAS0 cuenta(s); huella de auth \`${AUTH0:0:12}…\`"
  ev "- ¿hay esquema bob? \`$(q "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'bob')")\` · versiones aplicadas: \`$(versiones_aplicadas)\`"
  # F-27: evidence only, never a failure here. The verdict is step 6's.
  ev "- F-27 · extensiones de salida en la caja: \`$(extensiones_salida)\`"
  ev "- F-27 · extensiones instaladas: \`$(extensiones_instaladas)\`"
}
extensiones_instaladas() {
  # Read-only: every installed extension, to set against the approved five of
  # scripts/box-checks.mjs (APPROVED_EXTENSIONS).
  q "SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension"
}
extensiones_salida() {
  # Read-only: for each egress extension, installed or not, in which schema,
  # and how many of its functions PUBLIC can execute (F-27).
  q "SELECT string_agg(e.n || '=' || coalesce(
       (SELECT 'instalada ' || x.extversion || ' en ' || x.extnamespace::regnamespace
               || ', PUBLIC con EXECUTE en ' || (SELECT count(*) FILTER (WHERE has_function_privilege('public', p.oid, 'EXECUTE'))
                   || ' de ' || count(*) FROM pg_depend d JOIN pg_proc p ON p.oid = d.objid
                   WHERE d.refclassid = 'pg_extension'::regclass AND d.refobjid = x.oid
                     AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e') || ' funciones'
          FROM pg_extension x WHERE x.extname = e.n),
       (SELECT 'disponible, no instalada' FROM pg_available_extensions a WHERE a.name = e.n),
       'no disponible'), ' · ' ORDER BY e.n)
     FROM unnest(ARRAY['http', 'pg_net']) AS e(n)"
}

# The real chain's versions, from the files: what schema_migrations must hold
# at the end (F-15).
VERSIONES_REALES="$(ls "$REPO/supabase/migrations" | sed -n 's/^\([0-9]\{14\}\)_.*\.sql$/\1/p' | sort | paste -sd, -)"
antes_de() { echo "$VERSIONES_REALES" | tr , '\n' | awk -v v="$1" '$1 < v' | paste -sd, -; }

# ── The rigged chain ─────────────────────────────────────────────────────────
# Two rigged files. Their versions fall between real ones, so the real chain
# keeps its order around them.
AMANADA_SIN="20260700000000"   # after the fifth old file, among the nine not wrapped
AMANADA_CON="20261118100150"   # inside Slice 2: after the feeder views, before the projections
preparar_cadena() {
  CADENA="$RUN/cadena"
  mkdir -p "$CADENA/supabase/migrations"
  cp "$REPO/supabase/config.toml" "$CADENA/supabase/config.toml"
  cp "$REPO"/supabase/migrations/*.sql "$CADENA/supabase/migrations/"
  cat > "$CADENA/supabase/migrations/${AMANADA_SIN}_ensayo_p5_falla_sin_envolver.sql" <<'SQL'
-- Rehearsal only. Not wrapped, like the nine old files: does the CLI keep
-- what ran before the failure?
CREATE TABLE public.ensayo_p5_sin_envolver_antes (id int);
DO $$ BEGIN RAISE EXCEPTION 'ensayo P5: falla amañada, sin envolver'; END $$;
CREATE TABLE public.ensayo_p5_sin_envolver_despues (id int);
SQL
  cat > "$CADENA/supabase/migrations/${AMANADA_CON}_ensayo_p5_falla_envuelta.sql" <<'SQL'
-- Rehearsal only. Wrapped, like every file since 20260902100000.
BEGIN;
CREATE TABLE bob.ensayo_p5_envuelta_antes (id int);
DO $$ BEGIN RAISE EXCEPTION 'ensayo P5: falla amañada, envuelta'; END $$;
CREATE TABLE bob.ensayo_p5_envuelta_despues (id int);
COMMIT;
SQL
  if [ "$SABOTAJE" = amanada-no-falla ]; then
    sed -i.bak '/RAISE EXCEPTION/d' "$CADENA/supabase/migrations/${AMANADA_CON}_ensayo_p5_falla_envuelta.sql"
    rm -f "$CADENA"/supabase/migrations/*.bak
  fi
  ev "- cadena copiada de \`$REPO/supabase/migrations\` con dos migraciones amañadas: \`$AMANADA_SIN\` (sin envolver) y \`$AMANADA_CON\` (envuelta)"
}
push() {  # [--dry-run]
  "$SUPABASE" db push --workdir "$CADENA" --db-url "$DB_URL" --skip-vault --yes "$@"
}

# ── Modes ────────────────────────────────────────────────────────────────────
case "$MODO" in
dry-run)
  { echo "# Ensayo P5 en $HOST_ACTUAL · --dry-run · $SELLO"; echo; echo "Nada se escribe en la base."; } > "$EV"
  preflight
  CADENA="$RUN/cadena"; mkdir -p "$CADENA/supabase/migrations"
  cp "$REPO/supabase/config.toml" "$CADENA/supabase/"; cp "$REPO"/supabase/migrations/*.sql "$CADENA/supabase/migrations/"
  VERS0="$(versiones_aplicadas)"
  ESQ0="$(q "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'supabase_migrations')")"
  paso "1 · supabase db push --dry-run con la cadena real"
  ev_bloque "db push --dry-run" push --dry-run
  comprobar "db push --dry-run sale 0" 0 "$RC_BLOQUE"
  comprobar "el dry-run no escribió versiones ni creó supabase_migrations" "$VERS0 $ESQ0" \
    "$(versiones_aplicadas) $(q "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'supabase_migrations')")"
  comprobar "auth.users sin tocar" "$CUENTAS0 $AUTH0" "$(auth_cuentas) $(auth_huella)"
  ;;

ejecutar)
  { echo "# Ensayo P5 en $HOST_ACTUAL · $SELLO"
    echo
    echo "P5 (D62) §6.2 y §8, objeciones 2, 5 y 6. Redactado: sin claves, sin direcciones, sin correos, sin filas."; } > "$EV"
  preflight
  [ "$(q "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('bob', 'supabase_migrations'))")" = f ] \
    || rechazar "la caja ya tiene bob o supabase_migrations: el ensayo es para una caja sin BOb. Ver --deshacer"
  inventario > "$RUN/inventario-antes.txt"
  ev "- inventario de objetos antes: $(wc -l < "$RUN/inventario-antes.txt" | tr -d ' ') líneas (\`inventario-antes.txt\`, en la caja)"

  paso "1 · Volcado antes de empezar"
  docker exec "$CONT" pg_dump -U supabase_admin -d postgres -Fc > "$RUN/antes.dump"
  chmod 600 "$RUN/antes.dump"
  ev "- \`antes.dump\` (formato custom, en la caja, modo 600): $(wc -c < "$RUN/antes.dump" | tr -d ' ') bytes, sha256 \`$( (sha256sum "$RUN/antes.dump" 2>/dev/null || shasum -a 256 "$RUN/antes.dump") | cut -c1-16)…\`"
  # By effect: the dump lists auth.users' data, not just that pg_dump exited 0.
  comprobar "el volcado trae los datos de auth.users" 1 \
    "$(docker exec -i "$CONT" pg_restore --list < "$RUN/antes.dump" | grep -c 'TABLE DATA auth users ' || true)"

  paso "2 · La cadena amañada"
  preparar_cadena

  paso "3a · Push 1: falla en la migración sin envolver ($AMANADA_SIN)"
  ev_bloque "db push" push
  comprobar "el push sale distinto de 0" "no-cero" "$([ "$RC_BLOQUE" != 0 ] && echo no-cero || echo cero)"
  comprobar "schema_migrations tiene exactamente las anteriores a la amañada" "$(antes_de $AMANADA_SIN)" "$(versiones_aplicadas)"
  # Measured locally with CLI 2.120.0 on supabase/postgres 17.6.1.136: the CLI
  # runs each file as one implicit transaction, so even a file without BEGIN
  # leaves nothing behind. lab-02 confirms it or contradicts it.
  comprobar "la amañada sin envolver no dejó nada (ni lo de antes del fallo ni lo de después)" "" "$(objetos_ensayo)"
  ev "- tablas en public: $(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'") · esquema bob: $(q "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'bob')")"
  comprobar "auth.users sin tocar" "$CUENTAS0 $AUTH0" "$(auth_cuentas) $(auth_huella)"
  ev "- **arreglo:** la amañada nunca quedó registrada; se quita del directorio y el push siguiente sigue donde se paró."
  rm -f "$CADENA/supabase/migrations/${AMANADA_SIN}_"*.sql
  [ "$SABOTAJE" != restos ] || q "CREATE TABLE public.ensayo_p5_resto_sabotaje (id int)"

  paso "3b · Push 2: falla en la migración envuelta ($AMANADA_CON)"
  ev_bloque "db push" push
  comprobar "el push sale distinto de 0" "no-cero" "$([ "$RC_BLOQUE" != 0 ] && echo no-cero || echo cero)"
  comprobar "schema_migrations tiene exactamente las anteriores a la amañada" "$(antes_de $AMANADA_CON)" "$(versiones_aplicadas)"
  comprobar "la amañada envuelta no dejó nada" "" "$(objetos_ensayo)"
  comprobar "las vistas del alimentador existen (la migración de antes quedó)" "t t" "$(existe bob.v_feeder_channel_map) $(existe bob.v_feeder_actor_map)"
  comprobar "las proyecciones no existen (la migración de después no corrió)" 0 \
    "$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bob' AND c.relname LIKE 'proj\_%'")"
  comprobar "auth.users sin tocar" "$CUENTAS0 $AUTH0" "$(auth_cuentas) $(auth_huella)"
  rm -f "$CADENA/supabase/migrations/${AMANADA_CON}_"*.sql

  paso "3c · Push 3: el resto de la cadena"
  ev_bloque "db push" push
  comprobar "el push sale 0" 0 "$RC_BLOQUE"
  comprobar "F-15: schema_migrations tiene exactamente las versiones de los ficheros" "$VERSIONES_REALES" "$(versiones_aplicadas)"
  comprobar "ningún objeto del ensayo en la base" "" "$(objetos_ensayo)"
  comprobar "las ocho proyecciones existen" 8 \
    "$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bob' AND c.relkind = 'p' AND c.relname LIKE 'proj\_%'")"
  comprobar "auth.users sin tocar" "$CUENTAS0 $AUTH0" "$(auth_cuentas) $(auth_huella)"
  # What the chain itself leaves in bob, before any fixture: configuration a
  # migration seeds (bob.cell_catalog, Slice 3) is part of the box, not data.
  conteos_bob > "$RUN/conteos-cadena.txt"

  paso "4 · Restaurar bob solo y reconstruir las proyecciones"
  ev_bloque "datos sintéticos (fixtures del repo, todo inventado)" mundo cargar
  ev_bloque "el alimentador de referencia escribe las proyecciones" mundo alimentar
  mundo proyecciones > "$RUN/proyecciones-antes.txt"
  huella_bob > "$RUN/huella-antes.txt"
  conteos_bob > "$RUN/conteos-antes.txt"
  ev "- huella de bob: $(wc -l < "$RUN/huella-antes.txt" | tr -d ' ') objetos; tablas con filas: $(grep -cv '=0$' "$RUN/conteos-antes.txt" || true)"
  ev "- definer: vistas con security_invoker=false: $(grep -c 'security_invoker=false' "$RUN/huella-antes.txt" || true) · funciones SECURITY DEFINER en bob y public: $(grep -c '^function|.*definer=t' "$RUN/huella-antes.txt" || true)"
  comprobar "hay filas en las proyecciones antes del daño" "sí" \
    "$(awk '{split($2,a,"="); s+=a[2]} END{print (s>0)?"sí":"no"}' "$RUN/proyecciones-antes.txt")"

  volcar_bob "$RUN/bob.sql.gz"
  publicacion_bob > "$RUN/publicacion-bob.txt"
  ev "- \`bob.sql.gz\` como lo toma backup.sh: $(wc -c < "$RUN/bob.sql.gz" | tr -d ' ') bytes"
  ev "- tablas de bob en publicaciones, apuntadas al volcar como hace backup.sh en su manifiesto: $(wc -l < "$RUN/publicacion-bob.txt" | tr -d ' ')"
  # Measured on 2026-11-20: pg_dump -n bob carries no ALTER PUBLICATION, so the
  # membership comes back only from the manifest. If a later pg_dump carries
  # it, this check says so and the procedure loses a step.
  comprobar "pg_dump -n bob no trae la pertenencia a publicaciones (se repone desde el manifiesto)" 0 \
    "$(gunzip -c "$RUN/bob.sql.gz" | grep -c '^ALTER PUBLICATION' || true)"
  comprobar "el volcado de bob no trae filas de proj_*" 0 \
    "$(gunzip -c "$RUN/bob.sql.gz" | awk '/^COPY bob\.proj_/{f=1;next} f&&/^\\\.$/{f=0} f{n++} END{print n+0}')"

  # F-47: what lives outside bob and depends on it is taken by the CASCADE and
  # is not in bob.sql.gz. It is noted and saved here, from the box itself, and
  # put back after the restore (procedure §4.3).
  paso "4a · Antes del daño: lo que fuera de bob depende de bob"
  dependientes --listar > "$RUN/dependientes.txt"
  ev_bloque "dependientes de bob fuera de bob (pg_depend, transitivo)" cat "$RUN/dependientes.txt"
  comprobar "todo lo que depende de bob fuera de bob es una función o una vista" 0 \
    "$(grep -c '^otro|' "$RUN/dependientes.txt" || true)"
  ev_bloque "pg_dump --schema-only de esos objetos, filtrado con pg_restore -L" dependientes --guardar "$RUN"
  comprobar "sus definiciones quedan guardadas" 0 "$RC_BLOQUE"
  comprobar "cada dependiente tiene su CREATE en dependientes.sql" "$(wc -l < "$RUN/dependientes.txt" | tr -d ' ')" \
    "$(grep -cE '^CREATE (FUNCTION|VIEW|MATERIALIZED VIEW) ' "$RUN/dependientes.sql" || true)"

  paso "4a · El daño: DROP SCHEMA bob CASCADE"
  docker exec -i "$CONT" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    -c 'SET client_min_messages = notice' -c 'DROP SCHEMA bob CASCADE' > "$RUN/cascade.txt" 2>&1 </dev/null
  ev "- el CASCADE se llevó $(grep -c 'drop cascades to' "$RUN/cascade.txt" || true) objeto(s) nombrados, además de lo que vive en bob"
  ev_bloque "los que no son de bob (vacío = ninguno)" sh -c "grep 'drop cascades to' '$RUN/cascade.txt' | grep -v 'other objects' | grep -v ' bob\.' || true"
  comprobar "lo que el CASCADE se lleva fuera de bob es lo apuntado, ni más ni menos" \
    "$(wc -l < "$RUN/dependientes.txt" | tr -d ' ')" \
    "$(grep 'drop cascades to' "$RUN/cascade.txt" | grep -v 'other objects' | grep -vc ' bob\.' || true)"
  comprobar "bob ya no existe" f "$(q "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'bob')")"
  comprobar "auth.users sin tocar" "$CUENTAS0 $AUTH0" "$(auth_cuentas) $(auth_huella)"

  paso "4b · Restaurar bob.sql.gz"
  if [ "$SABOTAJE" = restaurar-sin-datos ]; then
    gunzip -c "$RUN/bob.sql.gz" | awk '/^COPY /{f=1;print;next} f&&/^\\\.$/{f=0} !f' | gzip > "$RUN/bob-sabotaje.sql.gz"
    mv "$RUN/bob-sabotaje.sql.gz" "$RUN/bob.sql.gz"
  fi
  ev_bloque "psql -1 -v ON_ERROR_STOP=1 como supabase_admin" sh -c "gunzip -c '$RUN/bob.sql.gz' | docker exec -i '$CONT' psql -X -q -1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 >/dev/null"
  comprobar "la restauración sale 0, en una transacción" 0 "$RC_BLOQUE"
  if [ "$SABOTAJE" != sin-dependientes ]; then
    ev_bloque "dependientes.sql, en una transacción" dependientes --reponer "$RUN"
    comprobar "lo apuntado fuera de bob se repone, en una transacción" 0 "$RC_BLOQUE"
  fi
  [ "$SABOTAJE" = sin-publicacion ] || reponer_publicacion "$RUN/publicacion-bob.txt"
  ev "- pertenencia a publicaciones repuesta desde lo apuntado: $(wc -l < "$RUN/publicacion-bob.txt" | tr -d ' ') tabla(s)"
  [ "$SABOTAJE" != vista-invoker ] || q "ALTER VIEW bob.v_feeder_channel_map SET (security_invoker = true)"
  [ "$SABOTAJE" != funcion-invoker ] || q "ALTER FUNCTION bob.proj_ensure_partition(regclass, date) SECURITY INVOKER"
  huella_bob > "$RUN/huella-despues.txt"
  conteos_bob > "$RUN/conteos-despues.txt"
  ev_bloque "diferencias de la huella (vacío = idéntica)" diff "$RUN/huella-antes.txt" "$RUN/huella-despues.txt"
  comprobar "la huella de bob es idéntica: dueños, permisos, vistas definer, SECURITY DEFINER, políticas" 0 "$RC_BLOQUE"
  ev_bloque "diferencias de filas fuera de proj_* (vacío = idénticas)" diff "$RUN/conteos-antes.txt" "$RUN/conteos-despues.txt"
  comprobar "las filas de configuración y estado vivo vuelven todas" 0 "$RC_BLOQUE"
  comprobar "las proyecciones vuelven vacías (no van en el volcado)" "" \
    "$(mundo proyecciones | grep -v ' filas=0 ' || true)"
  # By effect, as bob_feeder: the definer view answers, the base table refuses.
  q "GRANT bob_feeder TO supabase_admin" >/dev/null
  comprobar "como bob_feeder, v_feeder_channel_map responde con filas de los dos tenants" 2 \
    "$(q "SET ROLE bob_feeder; SELECT count(DISTINCT org_id) FROM bob.v_feeder_channel_map" 2>&1 | tail -1)"
  comprobar "como bob_feeder, bob.channels se niega" "negado" \
    "$(q "SET ROLE bob_feeder; SELECT count(*) FROM bob.channels" >/dev/null 2>&1 && echo leído || echo negado)"
  q "REVOKE bob_feeder FROM supabase_admin" >/dev/null
  comprobar "auth.users sin tocar" "$CUENTAS0 $AUTH0" "$(auth_cuentas) $(auth_huella)"

  paso "4c · Reconstruir las proyecciones con el alimentador"
  [ "$SABOTAJE" = sin-reconstruir ] || ev_bloque "el alimentador de referencia" mundo alimentar
  mundo proyecciones > "$RUN/proyecciones-despues.txt"
  ev_bloque "diferencias de las proyecciones (vacío = idénticas)" diff "$RUN/proyecciones-antes.txt" "$RUN/proyecciones-despues.txt"
  comprobar "las proyecciones reconstruidas son las de antes, fila a fila" 0 "$RC_BLOQUE"

  paso "5 · Dejar la caja con la cadena y sin datos sintéticos"
  ev_bloque "quitar los tenants del fixture" mundo limpiar
  comprobar "sin filas del fixture en bob (lo que deja la cadena, y nada más)" \
    "$(grep -v '=0$' "$RUN/conteos-cadena.txt" || true)" "$(conteos_bob | grep -v '=0$' || true)"
  comprobar "F-15 al terminar" "$VERSIONES_REALES" "$(versiones_aplicadas)"
  comprobar "auth.users sin tocar, de principio a fin" "$CUENTAS0 $AUTH0" "$(auth_cuentas) $(auth_huella)"

  paso "6 · El chequeo de caja (scripts/box-check.mjs, P5 §6.2 y F-27)"
  ev "Sin tenant aprovisionado, «one organization» sale FAIL a propósito: el ensayo no deja organización."
  [ "$SABOTAJE" != rol-de-mas ] || q "CREATE ROLE ensayo_p5_intruso LOGIN; GRANT USAGE ON SCHEMA bob TO ensayo_p5_intruso"
  ev_bloque "box-check, de solo lectura, como el migrador" \
    env BOX_DB_URL="$DB_URL" "$NODE" "$REPO/scripts/box-check.mjs"
  comprobar "box-check: tres roles y no más" "sí" \
    "$(grep -qE '^ok +three roles, no more$' "$EV" && echo sí || echo no)"
  # Fail closed since PR #47: this is red on any box with an extension outside
  # the approved five, on purpose, and so is the run. lab-02's 41/41 of 21 Nov
  # predates it (it checked only pg_net and http), and lab-02's full extension
  # list was not recorded, so a rerun there may be red until Henry rules on
  # each extension found. The installed list is in the evidence above.
  comprobar "box-check: sin salida a red desde la base, falla cerrado (solo las cinco extensiones aprobadas)" "sí" \
    "$(grep -qE '^ok +no egress from the database$' "$EV" && echo sí || echo no)"
  ev "- F-27 · extensiones de salida tras la cadena: \`$(extensiones_salida)\`"
  ev "- F-27 · extensiones instaladas tras la cadena: \`$(extensiones_instaladas)\`"
  inventario > "$RUN/inventario-despues.txt"
  ev "- lo que la cadena añadió fuera de bob y supabase_migrations:"
  comm_c -13 "$RUN/inventario-antes.txt" "$RUN/inventario-despues.txt" \
    | grep -Ev '^(rel|function|type|trigger)\|(bob|supabase_migrations)\.|^schema\|(bob|supabase_migrations)$' \
    | sed 's/^/  - /' | redactar >> "$EV" || true
  ;;

deshacer)
  { echo "# Deshacer el ensayo P5 en $HOST_ACTUAL · $SELLO"; echo; echo "Corrida: \`$(basename "$RUN")\`"; } > "$EV"
  CUENTAS0="$(auth_cuentas)"; AUTH0="$(auth_huella)"
  inventario > "$RUN/inventario-ahora.txt"
  comm_c -13 "$RUN/inventario-antes.txt" "$RUN/inventario-ahora.txt" > "$RUN/sobra.txt"
  paso "Lo que sobra respecto al inventario de antes"
  sed 's/^/  - /' "$RUN/sobra.txt" | redactar >> "$EV"
  # What was added, by kind, outside bob and supabase_migrations (those two go
  # whole, with everything in them). Never fails on an empty kind.
  sobra_de() { grep "^$1|" "$RUN/sobra.txt" | grep -Ev "^$1\|(bob|supabase_migrations)([.|]|$)" || true; }
  {
    echo "BEGIN;"
    echo "DROP SCHEMA IF EXISTS bob CASCADE;"
    echo "DROP SCHEMA IF EXISTS supabase_migrations CASCADE;"
    # The chain's trigger on auth.users is BOb's own object; dropping it is the
    # one write in auth this script makes, and only here.
    sobra_de trigger | awk -F'|' '{split($2,a,"."); printf "DROP TRIGGER IF EXISTS %s ON %s.%s;\n", $3, a[1], a[2]}'
    sobra_de publication | awk -F'|' '$3 !~ /^bob\./ {printf "ALTER PUBLICATION %s DROP TABLE %s;\n", $2, $3}'
    sobra_de function | cut -d'|' -f2 | sed 's/^/DROP FUNCTION IF EXISTS /; s/$/ CASCADE;/'
    sobra_de rel | awk -F'|' '$3=="v"{print "DROP VIEW IF EXISTS " $2 " CASCADE;"} $3=="r"||$3=="p"{print "DROP TABLE IF EXISTS " $2 " CASCADE;"} $3=="S"{print "DROP SEQUENCE IF EXISTS " $2 " CASCADE;"}'
    sobra_de type | cut -d'|' -f2 | sed 's/^/DROP TYPE IF EXISTS /; s/$/ CASCADE;/'
    sobra_de role | cut -d'|' -f2 | while read -r r; do echo "DROP OWNED BY $r; DROP ROLE $r;"; done
    sobra_de schema | cut -d'|' -f2 | sed 's/^/DROP SCHEMA IF EXISTS /; s/$/ CASCADE;/'
    echo "COMMIT;"
  } > "$RUN/deshacer.sql"
  ev_bloque "deshacer.sql" cat "$RUN/deshacer.sql"
  ev_bloque "aplicar" sh -c "docker exec -i '$CONT' psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < '$RUN/deshacer.sql'"
  comprobar "deshacer sale 0" 0 "$RC_BLOQUE"
  inventario > "$RUN/inventario-ahora.txt"
  ev_bloque "inventario contra el de antes (vacío = igual)" diff "$RUN/inventario-antes.txt" "$RUN/inventario-ahora.txt"
  comprobar "el inventario vuelve al de antes del ensayo" 0 "$RC_BLOQUE"
  comprobar "auth.users sin tocar" "$CUENTAS0 $AUTH0" "$(auth_cuentas) $(auth_huella)"
  ;;
esac

# ── Verdict ──────────────────────────────────────────────────────────────────
# By effect: the password must not be anywhere in the evidence.
if [ -n "$CLAVE" ] && grep -rqF -- "$CLAVE" "$EV"; then
  echo "FALLO: la clave del migrador quedó en $EV; se borra el fichero" >&2
  rm -f "$EV"; exit 1
fi
ev ""
if [ "$FALLOS" -eq 0 ]; then
  ev "**VEREDICTO: $CHECKS comprobaciones, todas como se esperaba.**"
  echo "VEREDICTO: $CHECKS comprobaciones, todas como se esperaba · evidencia en $EV"; exit 0
else
  ev "**VEREDICTO: $FALLOS de $CHECKS comprobaciones no se cumplieron.**"
  echo "VEREDICTO: $FALLOS de $CHECKS comprobaciones no se cumplieron · evidencia en $EV"; exit 1
fi
