#!/usr/bin/env bash
# BOb on a box, as decided for O-3 (D77 §2.8, P5 §6.2). Henry, 2026-11-24:
# «postgres una vez, luego migrador». Run by Henry in a window, never by an
# agent against a box. CI runs it against a disposable local stack.
#
# Three steps, in this order:
#   1. scripts/instalar-bob.sh cadena
#      The install chain: only the files in supabase/provision/install-chain.sha256,
#      each checked against its hash, pushed by postgres with --include-all (a
#      history that lacks one gets it; on lab-02 it is a no-op). The CLI's
#      history holds the chain and nothing else, so running it again is a no-op.
#   2. Bzzz's alta: scripts/generar-secretos-vecina.sh bob (bzzz#450). Roles,
#      schema bob, config/supabase/vecinas/bob.sql (= supabase/provision/bob.sql)
#      and the hand-over of bob to bob_migrador; its password in
#      /opt/bob/secrets/migrador.env. Not here: this script creates no role or
#      schema and never sets a password.
#   3. scripts/instalar-bob.sh resto
#      Every other migration, in order, applied as bob_migrador by
#      scripts/aplicar-migraciones.mjs (node-postgres, no psql): each file, its
#      row in bob.schema_migrations and one COMMIT in one transaction; a file
#      with a backslash anywhere is refused, and one that ends the transaction
#      itself is caught. That script says how. Not `supabase db push` as
#      bob_migrador: the CLI creates and alters its history table, shared and
#      not bob's, and stops with 42501 (measured, CI run 45630458545).
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
#                  MIGRADOR_RED set, step 3 runs in a container of NODE_IMAGE
#                  (default node:22-bookworm-slim) on that network, the only one
#                  bob_migrador may connect from (77.13), with this checkout
#                  (after `pnpm install`) and the pgpass file mounted read-only.
set -euo pipefail
cd "$(dirname "$0")/.."
step=${1:-}
case "$step" in cadena|resto) ;; *) echo "Usage: $0 cadena|resto" >&2; exit 2 ;; esac
LIST=supabase/provision/install-chain.sha256
SUDO=${SUDO-sudo}

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
rest=()
for path in $(ls supabase/migrations/*.sql | sort); do
  f=$(basename "$path")
  [[ "$f" =~ ^[0-9]+_.*\.sql$ ]] || continue
  chain_files | grep -qxF "$f" && continue
  rest+=("$path")
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
  docker run --rm --user 0 --network "$M_NET" -v "$PWD:/app:ro" -v "$priv/m:/run/bob:ro" -w /app \
    -e PGPASSFILE=/run/bob/pgpass -e PGHOST="$M_HOST" -e PGPORT="$M_PORT" -e PGUSER="$M_USER" \
    "${NODE_IMAGE:-node:22-bookworm-slim}" node scripts/aplicar-migraciones.mjs ${rest[@]+"${rest[@]}"}
else
  PGPASSFILE="$priv/m/pgpass" PGHOST="$M_HOST" PGPORT="$M_PORT" PGUSER="$M_USER" \
    node scripts/aplicar-migraciones.mjs ${rest[@]+"${rest[@]}"}
fi
echo "Finished."
