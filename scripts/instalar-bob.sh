#!/usr/bin/env bash
# BOb on a box, as decided for O-3 (D77 §2.8, P5 §6.2). Henry, 2026-11-24:
# «postgres una vez, luego migrador». Run by Henry in a window, never by an
# agent against a box. CI runs it against a disposable local stack.
#
# Three steps, in this order:
#   1. POSTGRES_URL=… scripts/instalar-bob.sh cadena
#      The install chain: only the files in supabase/provision/install-chain.sha256,
#      each checked against its hash, pushed by postgres with --include-all (a
#      history that lacks one gets it; on lab-02 it is a no-op).
#   2. Bzzz's alta: scripts/generar-secretos-vecina.sh bob (bzzz#450). Roles,
#      schema bob, config/supabase/vecinas/bob.sql (= supabase/provision/bob.sql)
#      and the hand-over of bob to bob_migrador; the password in
#      /opt/bob/secrets/migrador.env. Not here: this script creates no role or
#      schema and never touches a password.
#   3. POSTGRES_URL=… scripts/instalar-bob.sh resto
#      Every other migration not yet recorded, in order, applied by bob_migrador
#      with psql, and recorded by postgres in supabase_migrations.schema_migrations
#      as the CLI records it. Not `supabase db push` as bob_migrador: the CLI
#      reads and creates that history table, shared and not bob's, and stops
#      with 42501 (measured, CI run 45630458545). A file that fails stops the
#      script; the files before it stay applied and recorded.
#      bob_migrador's connection comes from the alta's file, MIGRADOR_ENV
#      (default /opt/bob/secrets/migrador.env, read with sudo, keys only, never
#      printed): MIGRADOR_USUARIO, MIGRADOR_CLAVE, MIGRADOR_HOST, MIGRADOR_RED.
#      With MIGRADOR_RED set, psql runs in a container of the database's image
#      on that network, the only one bob_migrador may connect from (77.13).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${POSTGRES_URL:?}"
step=${1:-}
case "$step" in cadena|resto) ;; *) echo "Usage: $0 cadena|resto" >&2; exit 2 ;; esac
LIST=supabase/provision/install-chain.sha256

if [ "$step" = cadena ]; then
  if command -v sha256sum >/dev/null; then SHA=(sha256sum); else SHA=(shasum -a 256); fi
  work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
  mkdir -p "$work/supabase/migrations"
  cp supabase/config.toml "$work/supabase/"
  echo "== 1 · the install chain, as postgres"
  (cd supabase/migrations && grep -v '^#' "../provision/install-chain.sha256" | "${SHA[@]}" -c --quiet -)
  grep -v '^#' "$LIST" | while read -r _ f; do cp "supabase/migrations/$f" "$work/supabase/migrations/"; done
  supabase db push --db-url "$POSTGRES_URL" --workdir "$work" --include-all --yes
  exit 0
fi

echo "== 3 · every other migration, as bob_migrador"
ENVF=${MIGRADOR_ENV:-/opt/bob/secrets/migrador.env}
SUDO=${SUDO-sudo}
key() { $SUDO cat "$ENVF" | sed -n "s/^$1=//p" | tail -1; }
M_USER=$(key MIGRADOR_USUARIO); M_HOST=$(key MIGRADOR_HOST); M_NET=$(key MIGRADOR_RED)
M_PORT=${MIGRADOR_PUERTO:-5432}
export PGPASSWORD; PGPASSWORD=$(key MIGRADOR_CLAVE)
[ -n "$M_USER" ] && [ -n "$M_HOST" ] && [ -n "$PGPASSWORD" ] || { echo "$ENVF lacks MIGRADOR_USUARIO, MIGRADOR_HOST or MIGRADOR_CLAVE" >&2; exit 2; }
as_migrador() {  # <file>
  if [ -n "$M_NET" ]; then
    img=$(docker inspect -f '{{.Config.Image}}' "$M_HOST")
    docker run --rm -i --network "$M_NET" -e PGPASSWORD "$img" \
      psql -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d postgres -X -q -v ON_ERROR_STOP=1 -f - < "$1"
  else
    psql -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d postgres -X -q -v ON_ERROR_STOP=1 -f "$1"
  fi
}
applied=$(PGPASSWORD= psql "$POSTGRES_URL" -X -A -t -q -c 'SELECT version FROM supabase_migrations.schema_migrations')
for path in $(ls supabase/migrations/*.sql | sort); do
  f=$(basename "$path")
  [[ "$f" =~ ^[0-9]+_.*\.sql$ ]] || continue
  v=${f%%_*}
  grep -qx "$v" <<<"$applied" && continue
  if grep -q "  $f\$" "$LIST"; then echo "$f is in the install chain and not applied: run step 1 first" >&2; exit 1; fi
  n=${f#*_}; n=${n%.sql}
  echo "Applying $f as bob_migrador"
  as_migrador "$path"
  PGPASSWORD= psql "$POSTGRES_URL" -X -q -v ON_ERROR_STOP=1 -v v="$v" -v n="$n" -v body="$(cat "$path")" <<'SQL'
INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES (:'v', :'n', ARRAY[:'body']);
SQL
done
echo "Finished."
