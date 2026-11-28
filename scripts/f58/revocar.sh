#!/bin/bash
# F-58 · the separate REVOKE step. Runs scripts/f58/revocar.sql once, as
# bob_migrador (the owner of schema bob), with the credentials the alta wrote:
# MIGRADOR_ENV, default /opt/bob/secrets/migrador.env, keys MIGRADOR_USUARIO,
# MIGRADOR_CLAVE, MIGRADOR_HOST, MIGRADOR_RED; MIGRADOR_PUERTO (default 5432).
# With MIGRADOR_RED set, psql runs in a container of the database's own image
# on that network, as scripts/instalar-bob.sh does. The password goes in a
# pgpass file in a private directory on tmpfs, never on a command line or on
# disk, and is removed; only to loopback or a host in /opt/bob/hosts-permitidos,
# and only over SCRAM.
#
# Never as the service role: revocar.sql refuses any role that does not own
# schema bob. It exits non-zero (psql's 3) if anything is left, and changes
# nothing then. See scripts/f58/README.md.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SQL="$HERE/revocar.sql"
[ -f "$SQL" ] || { echo "revocar.sql not found next to $0" >&2; exit 2; }
# Run (as root, on a box) only what nobody else can write: this script, the
# SQL and their directory belong to whoever runs them, with no group or other
# write. The runbook installs them into /root with install -o root.
me=$(id -u)
for f in "$HERE/revocar.sh" "$SQL" "$HERE"; do
  owner=$(stat -c '%u' "$f" 2>/dev/null || stat -f '%u' "$f")
  mode=$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f")
  if [ "$owner" != "$me" ] || [ $(( 8#$mode & 8#022 )) -ne 0 ]; then
    echo "refused: $f is writable by someone other than uid $me (owner $owner, mode $mode); install it as the runbook says" >&2; exit 2
  fi
done

ENVF=${MIGRADOR_ENV:-/opt/bob/secrets/migrador.env}
[ -r "$ENVF" ] || { echo "cannot read $ENVF (run with sudo on a box)" >&2; exit 2; }
key() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
M_USER=$(key MIGRADOR_USUARIO); M_HOST=$(key MIGRADOR_HOST); M_NET=$(key MIGRADOR_RED)
M_PORT=${MIGRADOR_PUERTO:-5432}
# A port is digits, 1 to 65535: anything else would reach the pgpass line.
[[ "$M_PORT" =~ ^[0-9]{1,5}$ ]] && [ "$M_PORT" -ge 1 ] && [ "$M_PORT" -le 65535 ] \
  || { echo "MIGRADOR_PUERTO is not a port number" >&2; exit 2; }
mpw=$(key MIGRADOR_CLAVE)
[ -n "$M_USER" ] && [ -n "$M_HOST" ] && [ -n "$mpw" ] || { echo "$ENVF lacks MIGRADOR_USUARIO, MIGRADOR_HOST or MIGRADOR_CLAVE" >&2; exit 2; }
[[ "$M_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "MIGRADOR_USUARIO is not a role name" >&2; exit 2; }
case "$M_USER" in service_role|authenticated|anon|bob_app|bob_feeder|bob_ai_ro)
  echo "refused: $M_USER is not the owner of bob; this runs as bob_migrador" >&2; exit 2 ;; esac
# Passwords go only to loopback or a host in /opt/bob/hosts-permitidos
# (root's), as in scripts/instalar-bob.sh; never in the clear (SCRAM only).
# As root the list is always that file; F58_HOSTS_PERMITIDOS, another list,
# is honoured only for a non-root run (the tests), which cannot read a box's
# migrador.env anyway.
HOSTS=/opt/bob/hosts-permitidos
[ "$me" != 0 ] && [ -n "${F58_HOSTS_PERMITIDOS:-}" ] && HOSTS=$F58_HOSTS_PERMITIDOS
case "$M_HOST" in 127.0.0.1|localhost|::1) ;; *)
  { [ -f "$HOSTS" ] && sed -e 's/#.*//' -e 's/[[:space:]]//g' "$HOSTS" | grep -qxF -- "$M_HOST"; } \
    || { echo "MIGRADOR_HOST $M_HOST is not permitted ($HOSTS)" >&2; exit 2; } ;; esac
export PGREQUIREAUTH=scram-sha-256

# The pgpass goes on tmpfs ($XDG_RUNTIME_DIR or /dev/shm), never on disk; with
# neither, stop, as scripts/instalar-bob.sh does.
priv=""
for base in "${XDG_RUNTIME_DIR:-}" /dev/shm; do
  [ -n "$base" ] && [ -d "$base" ] && [ -w "$base" ] || continue
  if [ "$(uname)" = Linux ]; then
    case "$(stat -f -c %T "$base")" in tmpfs|ramfs) ;; *) continue ;; esac
  fi
  priv=$(mktemp -d "$base/bob-f58.XXXXXX"); break
done
[ -n "$priv" ] || { echo "no tmpfs for the password file (\$XDG_RUNTIME_DIR or /dev/shm): stopping rather than writing it to disk" >&2; exit 2; }
chmod 700 "$priv"
trap 'rm -rf "$priv"' EXIT
p=${mpw//\\/\\\\}; p=${p//:/\\:}
( umask 077; printf '%s:%s:*:%s:%s\n' "$M_HOST" "$M_PORT" "$M_USER" "$p" > "$priv/pgpass"; cp "$SQL" "$priv/revocar.sql" )
unset mpw p

echo "F-58: revoking every privilege but SELECT, INSERT, UPDATE and DELETE on bob as $M_USER@$M_HOST:$M_PORT"
if [ -n "$M_NET" ]; then
  img=$(docker inspect -f '{{.Image}}' "$M_HOST")
  docker run --rm --user 0 --network "$M_NET" -v "$priv:/run/bob:ro" \
    -e PGPASSFILE=/run/bob/pgpass -e PGREQUIREAUTH=scram-sha-256 "$img" \
    psql -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d postgres -X -q -v ON_ERROR_STOP=1 -f /run/bob/revocar.sql
else
  PGPASSFILE="$priv/pgpass" psql -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d postgres -X -q -v ON_ERROR_STOP=1 -f "$priv/revocar.sql"
fi
echo "F-58: done"
