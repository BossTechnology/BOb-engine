#!/bin/bash
# F-58 · the separate REVOKE step. Runs scripts/f58/revocar.sql once, as
# bob_migrador (the owner of schema bob), with the credentials the alta wrote:
# MIGRADOR_ENV, default /opt/bob/secrets/migrador.env, keys MIGRADOR_USUARIO,
# MIGRADOR_CLAVE, MIGRADOR_HOST, MIGRADOR_RED; MIGRADOR_PUERTO (default 5432).
# With MIGRADOR_RED set, psql runs in a container of the database's own image
# on that network, as scripts/instalar-bob.sh does. The password goes in a
# pgpass file in a private directory, never on a command line, and is removed.
#
# Never as the service role: revocar.sql refuses any role that does not own
# schema bob. See scripts/f58/README.md.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SQL="$HERE/revocar.sql"
[ -f "$SQL" ] || { echo "revocar.sql not found next to $0" >&2; exit 2; }

ENVF=${MIGRADOR_ENV:-/opt/bob/secrets/migrador.env}
[ -r "$ENVF" ] || { echo "cannot read $ENVF (run with sudo on a box)" >&2; exit 2; }
key() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
M_USER=$(key MIGRADOR_USUARIO); M_HOST=$(key MIGRADOR_HOST); M_NET=$(key MIGRADOR_RED)
M_PORT=${MIGRADOR_PUERTO:-5432}
mpw=$(key MIGRADOR_CLAVE)
[ -n "$M_USER" ] && [ -n "$M_HOST" ] && [ -n "$mpw" ] || { echo "$ENVF lacks MIGRADOR_USUARIO, MIGRADOR_HOST or MIGRADOR_CLAVE" >&2; exit 2; }
[[ "$M_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "MIGRADOR_USUARIO is not a role name" >&2; exit 2; }
case "$M_USER" in service_role|authenticated|anon|bob_app|bob_feeder|bob_ai_ro)
  echo "refused: $M_USER is not the owner of bob; this runs as bob_migrador" >&2; exit 2 ;; esac

priv=$(mktemp -d); chmod 700 "$priv"
trap 'rm -rf "$priv"' EXIT
p=${mpw//\\/\\\\}; p=${p//:/\\:}
( umask 077; printf '%s:%s:*:%s:%s\n' "$M_HOST" "$M_PORT" "$M_USER" "$p" > "$priv/pgpass"; cp "$SQL" "$priv/revocar.sql" )
unset mpw p

echo "F-58: revoking TRIGGER and REFERENCES on bob as $M_USER@$M_HOST:$M_PORT"
if [ -n "$M_NET" ]; then
  img=$(docker inspect -f '{{.Image}}' "$M_HOST")
  docker run --rm --user 0 --network "$M_NET" -v "$priv:/run/bob:ro" \
    -e PGPASSFILE=/run/bob/pgpass -e PGREQUIREAUTH=scram-sha-256 "$img" \
    psql -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d postgres -X -q -v ON_ERROR_STOP=1 -f /run/bob/revocar.sql
else
  PGPASSFILE="$priv/pgpass" psql -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d postgres -X -q -v ON_ERROR_STOP=1 -f "$priv/revocar.sql"
fi
echo "F-58: done"
