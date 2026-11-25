#!/usr/bin/env bash
# BOb on a box, as decided for O-3 (D77 §2.8, P5 §6.2). Henry, 2026-11-24:
# «postgres una vez, luego migrador». Run by Henry in a window, never by an
# agent against a box. CI runs it against a disposable local stack.
#
# On a box it runs only from root's copy of the commit Henry signed, never
# from a checkout:
#   sudo POSTGRES_ENV=… /opt/bob/bin/firma-instalacion caja <repo> <commit> cadena|resto
# That copy of scripts/firma-instalacion.sh writes the commit's tree, from git
# objects, into a directory of root's, checks that Henry signed its digest from
# the state this box stands at, and runs this script from there, as root, with
# a clean environment. Run any other way, this script refuses. Only CI skips
# that (INSTALAR_SIN_FIRMA=ci under GitHub Actions), on a stack it throws away.
#
# Three steps, in this order:
#   1. cadena: the install chain, only the files in
#      supabase/provision/install-chain.sha256, each checked against its hash,
#      pushed by postgres with --include-all (a history that lacks one gets it;
#      on lab-02 it is a no-op). The CLI's history holds the chain and nothing
#      else, so running it again is a no-op.
#   2. Bzzz's alta: scripts/generar-secretos-vecina.sh bob (bzzz#450). Roles,
#      schema bob, config/supabase/vecinas/bob.sql (= supabase/provision/bob.sql)
#      and the hand-over of bob to bob_migrador; its password in
#      /opt/bob/secrets/migrador.env. Not here: this script creates no role or
#      schema and never sets a password.
#   3. resto: every other migration, in order, as bob_migrador, recorded in
#      bob.schema_migrations, bob_migrador's own table. Each file goes as one
#      `psql -c` argument: psql sends it to the server as it is, one simple
#      query, with no metacommand (no \!, no \i) and no variable. A file with a
#      backslash anywhere is refused anyway, and so is one over 120 000 bytes
#      (an argument's limit is 128 KiB; the largest today is 24 KB). The file,
#      its record and the COMMIT share one transaction: a file that fails
#      leaves nothing applied and nothing recorded.
#      A COMMIT, END or ROLLBACK written into a file is detected and reported
#      (a LOCAL value set before the file is gone after it): the file is not
#      recorded and the run stops. Not prevented: what the file ran before it
#      stays, and a file written to dodge the check (saving that value at
#      session level, then BEGIN again) can. bob_migrador gains nothing by it
#      that it does not already have; the files are reviewed code.
#      Not `supabase db push` as bob_migrador: the CLI creates and alters its
#      history table, shared and not bob's, and stops with 42501 (measured, CI
#      run 45630458545).
#
# What runs: bash, psql, the supabase CLI (the version CI pins, checked) and
# docker from the box, and from the signed tree only. No node, no pnpm.
#
# Connections. No password is ever on a command line, in the environment of a
# process or a container, or printed. Each is read, with sudo, from a file of
# KEY=value lines, by key (never sourced), into a pgpass file in a private
# directory on tmpfs ($XDG_RUNTIME_DIR or /dev/shm; with neither, the script
# stops), removed on exit:
#   postgres:      POSTGRES_ENV (required), key POSTGRES_PASSWORD;
#                  POSTGRES_HOST (default 127.0.0.1), POSTGRES_PORT (5432).
#   bob_migrador:  MIGRADOR_ENV (default /opt/bob/secrets/migrador.env, the
#                  alta's), keys MIGRADOR_USUARIO, MIGRADOR_CLAVE, MIGRADOR_HOST,
#                  MIGRADOR_RED; MIGRADOR_PUERTO (default 5432). With
#                  MIGRADOR_RED set, psql runs on that network, the only one
#                  bob_migrador may connect from (77.13), in a container of the
#                  database's own image, named by its image ID, with the pgpass
#                  file mounted read-only.
set -euo pipefail
cd "$(dirname "$0")/.."
step=${1:-}
case "$step" in cadena|resto) ;; *) echo "Usage: $0 cadena|resto" >&2; exit 2 ;; esac
LIST=supabase/provision/install-chain.sha256
SUDO=${SUDO-sudo}

if [ -z "${BOB_FIRMA_VERIFICADA:-}" ]; then
  if [ "${INSTALAR_SIN_FIRMA:-}" = ci ] && [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "CI: Henry's signature is not checked here (a disposable stack)"
  else
    echo "Not run from a signed tree: nothing installed. On a box, as Henry (P5 §6.2):" >&2
    echo "  sudo POSTGRES_ENV=… /opt/bob/bin/firma-instalacion caja <repo> <commit> $step" >&2
    exit 2
  fi
fi

priv=""
for base in "${XDG_RUNTIME_DIR:-}" /dev/shm; do
  [ -n "$base" ] && [ -d "$base" ] && [ -w "$base" ] || continue
  if [ "$(uname)" = Linux ]; then
    case "$(stat -f -c %T "$base")" in tmpfs|ramfs) ;; *) continue ;; esac
  fi
  priv=$(mktemp -d "$base/bob-instalar.XXXXXX"); break
done
[ -n "$priv" ] || { echo "no tmpfs for the password files (\$XDG_RUNTIME_DIR or /dev/shm): stopping rather than writing them to disk" >&2; exit 2; }
chmod 700 "$priv"
trap 'rm -rf "$priv"' EXIT

key() {  # <file> <KEY>: the value, never printed
  $SUDO cat "$1" | sed -n "s/^$2=//p" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
pgpass_line() {  # <host> <port> <user> <password>, with : and \ escaped
  local p=${4//\\/\\\\}; p=${p//:/\\:}
  printf '%s:%s:*:%s:%s\n' "$1" "$2" "$3" "$p"
}
unset PGPASSWORD

: "${POSTGRES_ENV:?POSTGRES_ENV: the file holding POSTGRES_PASSWORD}"
PG_HOST=${POSTGRES_HOST:-127.0.0.1}; PG_PORT=${POSTGRES_PORT:-5432}
pw=$(key "$POSTGRES_ENV" POSTGRES_PASSWORD)
[ -n "$pw" ] || { echo "$POSTGRES_ENV lacks POSTGRES_PASSWORD" >&2; exit 2; }
( umask 077; pgpass_line "$PG_HOST" "$PG_PORT" postgres "$pw" > "$priv/pgpass" )
unset pw
as_postgres() { PGPASSFILE="$priv/pgpass" psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
chain_files() { grep -v '^#' "$LIST" | awk '{ print $2 }'; }

if [ "$step" = cadena ]; then
  if command -v sha256sum >/dev/null; then SHA=(sha256sum); else SHA=(shasum -a 256); fi
  work="$priv/work"; mkdir -p "$work/supabase/migrations"
  cp supabase/config.toml "$work/supabase/"
  echo "== 1 · the install chain, as postgres"
  (cd supabase/migrations && grep -v '^#' "../provision/install-chain.sha256" | "${SHA[@]}" -c --quiet -)
  chain_files | while read -r f; do cp "supabase/migrations/$f" "$work/supabase/migrations/"; done
  # No password in the URL: the CLI's driver reads PGPASSFILE.
  PGPASSFILE="$priv/pgpass" supabase db push --db-url "postgresql://postgres@$PG_HOST:$PG_PORT/postgres" \
    --workdir "$work" --include-all --yes
  exit 0
fi

echo "== 3 · every other migration, as bob_migrador"
# The chain must be in the CLI's history before anything else goes in.
cli=$(as_postgres -A -t -c 'SELECT version FROM supabase_migrations.schema_migrations')
for f in $(chain_files); do
  grep -qx "${f%%_*}" <<<"$cli" || { echo "$f is in the install chain and not applied: run step 1 first" >&2; exit 1; }
done

ENVF=${MIGRADOR_ENV:-/opt/bob/secrets/migrador.env}
M_USER=$(key "$ENVF" MIGRADOR_USUARIO); M_HOST=$(key "$ENVF" MIGRADOR_HOST); M_NET=$(key "$ENVF" MIGRADOR_RED)
M_PORT=${MIGRADOR_PUERTO:-5432}
mpw=$(key "$ENVF" MIGRADOR_CLAVE)
[ -n "$M_USER" ] && [ -n "$M_HOST" ] && [ -n "$mpw" ] || { echo "$ENVF lacks MIGRADOR_USUARIO, MIGRADOR_HOST or MIGRADOR_CLAVE" >&2; exit 2; }
[[ "$M_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "MIGRADOR_USUARIO is not a role name" >&2; exit 2; }
mkdir -m 700 "$priv/m"
( umask 077; pgpass_line "$M_HOST" "$M_PORT" "$M_USER" "$mpw" > "$priv/m/pgpass" )
unset mpw
if [ -n "$M_NET" ]; then
  img=$(docker inspect -f '{{.Image}}' "$M_HOST")
  mig() { docker run --rm --user 0 --network "$M_NET" -v "$priv/m:/run/bob:ro" -e PGPASSFILE=/run/bob/pgpass "$img" \
            psql -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
else
  mig() { PGPASSFILE="$priv/m/pgpass" psql -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
fi

# bob_migrador's history: made on the first run, nobody else's.
mig -c "
  CREATE TABLE IF NOT EXISTS bob.schema_migrations (
    version    text PRIMARY KEY CHECK (version ~ '^[0-9]+\$'),
    name       text NOT NULL,
    sha256     text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by name NOT NULL DEFAULT current_user);
  COMMENT ON TABLE bob.schema_migrations IS 'BOb''s migrations after the install chain, applied by bob_migrador (instalar-bob.sh resto, O-3). The install chain is in supabase_migrations.schema_migrations.';
  DO \$\$ DECLARE g oid; BEGIN
    FOR g IN SELECT DISTINCT a.grantee FROM pg_class c, aclexplode(c.relacl) a
              WHERE c.oid = 'bob.schema_migrations'::regclass AND a.grantee <> c.relowner LOOP
      EXECUTE format('REVOKE ALL ON bob.schema_migrations FROM %s', CASE WHEN g = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g)) END);
    END LOOP;
  END \$\$;"
done_v=$(mig -A -t -c 'SELECT version FROM bob.schema_migrations')

applied=0; seen=0
for path in $(ls supabase/migrations/*.sql | sort); do
  f=$(basename "$path")
  [[ "$f" =~ ^[0-9]+_.*\.sql$ ]] || continue
  chain_files | grep -qxF "$f" && continue
  seen=$((seen + 1))
  v=${f%%_*}; n=${f#*_}; n=${n%.sql}
  grep -qx "$v" <<<"$done_v" && continue
  [[ "$n" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "$f refused, nothing applied: its name holds characters other than letters, digits, _ . -" >&2; exit 1; }
  if grep -q '\\' "$path"; then
    echo "$f refused, nothing applied: line $(grep -n '\\' "$path" | head -1 | cut -d: -f1) holds a backslash. None is allowed, not even in a string; write E'\\n' as chr(10)." >&2; exit 1
  fi
  [ "$(tr -d '\000' < "$path" | wc -c)" -eq "$(wc -c < "$path")" ] || { echo "$f refused, nothing applied: it holds a NUL byte" >&2; exit 1; }
  [ "$(wc -c < "$path")" -le 120000 ] || { echo "$f refused, nothing applied: over 120 000 bytes, split it" >&2; exit 1; }
  text=$(cat "$path"; printf x); text=${text%x}
  # A file written BEGIN; … COMMIT; on its first and last lines has those two
  # blanked: the transaction is this script's. Anything else is sent as written.
  first=$(sed -e 's/--.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$path" | grep -n -m1 . | cut -d: -f1 || true)
  last=$(sed -e 's/--.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$path" | grep -n . | tail -1 | cut -d: -f1 || true)
  body=$text
  if [ -n "$first" ] && [ "$first" != "$last" ] \
     && sed -n "${first}p" "$path" | sed 's/--.*//' | grep -qiE '^[[:space:]]*BEGIN[[:space:]]*;[[:space:]]*$' \
     && sed -n "${last}p" "$path" | sed 's/--.*//' | grep -qiE '^[[:space:]]*COMMIT[[:space:]]*;[[:space:]]*$'; then
    body=$(awk -v a="$first" -v b="$last" 'NR == a || NR == b { print ""; next } { print }' "$path")
  fi
  sum=$(printf '%s' "$text" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)
  nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  echo "Applying $f as $M_USER"
  if ! mig -c "SET default_transaction_read_only = on" \
         -c "BEGIN READ WRITE" \
         -c "DO \$\$ BEGIN PERFORM set_config('bob.instalar', '$nonce', true); END \$\$" \
         -c "$body" \
         -c "DO \$\$ BEGIN IF current_setting('bob.instalar', true) IS DISTINCT FROM '$nonce' THEN
               RAISE EXCEPTION 'the file ended the transaction itself (a COMMIT, END or ROLLBACK in it): not recorded; what it ran before that may be committed';
             END IF; END \$\$" \
         -c "INSERT INTO bob.schema_migrations (version, name, sha256) VALUES ('$v', '$n', '$sum')" \
         -c "COMMIT"; then
    echo "$f failed: nothing of it is recorded; unless it ended the transaction itself, nothing of it is applied" >&2
    exit 1
  fi
  applied=$((applied + 1))
done
echo "$applied applied, $((seen - applied)) already recorded."
echo "Finished."
