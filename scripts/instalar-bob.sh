#!/usr/bin/env bash
# BOb on a box, as decided for O-3 (D77 §2.8, P5 §6.2). Henry, 2026-11-24:
# «postgres una vez, luego migrador». Run by Henry in a window, never by an
# agent against a box. CI runs it against a disposable local stack.
#
# Three steps, in this order:
#   1. scripts/instalar-bob.sh cadena
#      The install chain: only the files in supabase/provision/install-chain.sha256,
#      each checked against its hash, pushed by postgres with --include-all (a
#      history that lacks one gets it; on lab-02 it is a no-op).
#   2. Bzzz's alta: scripts/generar-secretos-vecina.sh bob (bzzz#450). Roles,
#      schema bob, config/supabase/vecinas/bob.sql (= supabase/provision/bob.sql)
#      and the hand-over of bob to bob_migrador; its password in
#      /opt/bob/secrets/migrador.env. Not here: this script creates no role or
#      schema and never sets a password.
#   3. scripts/instalar-bob.sh resto
#      Every other migration not yet recorded, in order. Each file goes in ONE
#      transaction, from one psql as bob_migrador, together with its row in
#      supabase_migrations.schema_migrations, as the CLI records it: a file that
#      fails leaves nothing applied and nothing recorded, and stops the script.
#      The file goes through stdin, never argv. A file with a psql metacommand
#      (a backslash line outside a dollar-quoted body), or with transaction
#      control other than one leading BEGIN and one closing COMMIT, is refused
#      before anything runs. Not `supabase db push` as bob_migrador: the CLI
#      creates and alters that history table, shared and not bob's, and stops
#      with 42501 (measured, CI run 45630458545); bob_migrador only INSERTs.
#
# Connections. No password is ever on a command line, in the environment of a
# container, or printed. Each is read, with sudo, from a file of KEY=value
# lines, keys only (never sourced), into a pgpass file in a private tmpfs
# directory that is removed on exit:
#   postgres:      POSTGRES_ENV (required), key POSTGRES_PASSWORD;
#                  POSTGRES_HOST (default 127.0.0.1), POSTGRES_PORT (5432).
#   bob_migrador:  MIGRADOR_ENV (default /opt/bob/secrets/migrador.env, the
#                  alta's), keys MIGRADOR_USUARIO, MIGRADOR_CLAVE, MIGRADOR_HOST,
#                  MIGRADOR_RED; MIGRADOR_PUERTO (default 5432). With
#                  MIGRADOR_RED set, psql runs in a container of the database's
#                  image on that network, the only one bob_migrador may connect
#                  from (77.13), with the pgpass file mounted read-only.
set -euo pipefail
cd "$(dirname "$0")/.."
step=${1:-}
case "$step" in cadena|resto|revisar) ;; *) echo "Usage: $0 cadena|resto|revisar <file>…" >&2; exit 2 ;; esac
LIST=supabase/provision/install-chain.sha256
SUDO=${SUDO-sudo}

# What resto refuses, before anything runs, judged on the text outside
# dollar-quoted bodies and comments: any backslash (psql reads one as a
# metacommand, \! or \i among them, anywhere on a line), and transaction
# control other than one BEGIN opening the file and one COMMIT closing it.
# Prints "wrapped" for that BEGIN … COMMIT, "bare" for none.
shape() {
  awk '
    BEGIN { tag = ""; first = ""; last = ""; begins = 0; commits = 0; bad = "" }
    {
      rest = $0; out = ""
      while (rest != "") {
        if (tag == "") {
          d = match(rest, /\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$/); ds = RSTART; dl = RLENGTH
          c = index(rest, "--")
          if (c && (!d || c < ds)) { out = out substr(rest, 1, c - 1); rest = "" }
          else if (d) { out = out substr(rest, 1, ds - 1) " "; tag = substr(rest, ds, dl); rest = substr(rest, ds + dl) }
          else { out = out rest; rest = "" }
        } else {
          i = index(rest, tag)
          if (i) { rest = substr(rest, i + length(tag)); tag = "" } else rest = ""
        }
      }
      t = out; gsub(/^[ \t]+|[ \t]+$/, "", t)
      if (t ~ /\\/) bad = bad sprintf("line %d: a backslash outside a dollar-quoted body\n", NR)
      u = toupper(t)
      if (u ~ /^(BEGIN|START TRANSACTION|BEGIN TRANSACTION|BEGIN WORK)[ \t]*;$/) begins++
      else if (u ~ /^(COMMIT|END|COMMIT TRANSACTION|COMMIT WORK)[ \t]*;$/) commits++
      else if (u ~ /(^|;)[ \t]*(COMMIT|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE TRANSACTION|START TRANSACTION)([ \t;]|$)/) bad = bad sprintf("line %d: transaction control\n", NR)
      if (t != "") { if (first == "") first = u; last = u }
    }
    END {
      if (tag != "") bad = bad "a dollar-quoted body is never closed\n"
      if (begins > 1 || commits > 1 || begins != commits) bad = bad "more than one BEGIN or COMMIT, or one without the other\n"
      if (begins == 1 && (first !~ /^(BEGIN|START)/ || last !~ /^(COMMIT|END)/)) bad = bad "BEGIN must open the file and COMMIT close it\n"
      if (bad != "") { printf "%s", bad > "/dev/stderr"; exit 1 }
      print (begins ? "wrapped" : "bare")
    }' "$1"
}

# scripts/instalar-bob.sh revisar <file>: what resto would say of a file, with
# no database. CI runs it on every migration.
if [ "$step" = revisar ]; then shift; for f in "$@"; do printf '%s: ' "$f"; shape "$f"; done; exit 0; fi

priv=""
for base in "${XDG_RUNTIME_DIR:-}" /dev/shm "${TMPDIR:-/tmp}"; do
  [ -n "$base" ] && [ -d "$base" ] && [ -w "$base" ] && { priv=$(mktemp -d "$base/bob-instalar.XXXXXX"); break; }
done
[ -n "$priv" ] || { echo "no private temporary directory" >&2; exit 2; }
chmod 700 "$priv"
trap 'rm -rf "$priv"' EXIT

key() {  # <file> <KEY>: the value, never printed
  $SUDO cat "$1" | sed -n "s/^$2=//p" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
pgpass_line() {  # <host> <port> <user> <password>, with : and \ escaped
  local p=${4//\\/\\\\}; p=${p//:/\\:}
  printf '%s:%s:*:%s:%s\n' "$1" "$2" "$3" "$p"
}

: "${POSTGRES_ENV:?POSTGRES_ENV: the file holding POSTGRES_PASSWORD}"
PG_HOST=${POSTGRES_HOST:-127.0.0.1}; PG_PORT=${POSTGRES_PORT:-5432}
pw=$(key "$POSTGRES_ENV" POSTGRES_PASSWORD)
[ -n "$pw" ] || { echo "$POSTGRES_ENV lacks POSTGRES_PASSWORD" >&2; exit 2; }
( umask 077; pgpass_line "$PG_HOST" "$PG_PORT" postgres "$pw" > "$priv/pgpass" )
unset pw
export PGPASSFILE="$priv/pgpass"
as_postgres() { psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }

if [ "$step" = cadena ]; then
  if command -v sha256sum >/dev/null; then SHA=(sha256sum); else SHA=(shasum -a 256); fi
  work="$priv/work"; mkdir -p "$work/supabase/migrations"
  cp supabase/config.toml "$work/supabase/"
  echo "== 1 · the install chain, as postgres"
  (cd supabase/migrations && grep -v '^#' "../provision/install-chain.sha256" | "${SHA[@]}" -c --quiet -)
  grep -v '^#' "$LIST" | while read -r _ f; do cp "supabase/migrations/$f" "$work/supabase/migrations/"; done
  # No password in the URL: the CLI's driver reads PGPASSFILE.
  supabase db push --db-url "postgresql://postgres@$PG_HOST:$PG_PORT/postgres" --workdir "$work" --include-all --yes
  exit 0
fi

echo "== 3 · every other migration, as bob_migrador"
ENVF=${MIGRADOR_ENV:-/opt/bob/secrets/migrador.env}
M_USER=$(key "$ENVF" MIGRADOR_USUARIO); M_HOST=$(key "$ENVF" MIGRADOR_HOST); M_NET=$(key "$ENVF" MIGRADOR_RED)
M_PORT=${MIGRADOR_PUERTO:-5432}
mpw=$(key "$ENVF" MIGRADOR_CLAVE)
[ -n "$M_USER" ] && [ -n "$M_HOST" ] && [ -n "$mpw" ] || { echo "$ENVF lacks MIGRADOR_USUARIO, MIGRADOR_HOST or MIGRADOR_CLAVE" >&2; exit 2; }
[[ "$M_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "MIGRADOR_USUARIO is not a role name" >&2; exit 2; }
mkdir -m 700 "$priv/m"
( umask 077; pgpass_line "$M_HOST" "$M_PORT" "$M_USER" "$mpw" > "$priv/m/pgpass" )
unset mpw
as_migrador() {  # SQL on stdin
  if [ -n "$M_NET" ]; then
    img=$(docker inspect -f '{{.Config.Image}}' "$M_HOST")
    docker run --rm -i --user 0 --network "$M_NET" -v "$priv/m:/run/bob:ro" -e PGPASSFILE=/run/bob/pgpass "$img" \
      psql -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d postgres -X -q -v ON_ERROR_STOP=1 -f -
  else
    PGPASSFILE="$priv/m/pgpass" psql -h "$M_HOST" -p "$M_PORT" -U "$M_USER" -d postgres -X -q -v ON_ERROR_STOP=1 -f -
  fi
}

applied=$(as_postgres -A -t -c 'SELECT version FROM supabase_migrations.schema_migrations')
for path in $(ls supabase/migrations/*.sql | sort); do
  f=$(basename "$path")
  [[ "$f" =~ ^[0-9]+_.*\.sql$ ]] || continue
  v=${f%%_*}
  grep -qx "$v" <<<"$applied" && continue
  if grep -q "  $f\$" "$LIST"; then echo "$f is in the install chain and not applied: run step 1 first" >&2; exit 1; fi
  n=${f#*_}; n=${n%.sql}
  form=$(shape "$path") || { echo "$f refused, nothing applied" >&2; exit 1; }
  tag="bob_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  if grep -qF "\$$tag\$" "$path"; then echo "$f: quoting tag collision, run again" >&2; exit 1; fi
  echo "Applying $f as bob_migrador"
  {
    if [ "$form" = wrapped ]; then
      # Everything but the closing COMMIT; the record goes before it.
      awk '{ l[NR] = $0 } END { for (i = NR; i > 0; i--) { t = toupper(l[i]); sub(/--.*/, "", t); gsub(/^[ \t]+|[ \t]+$/, "", t); if (t != "") { last = i; break } } for (i = 1; i < last; i++) print l[i] }' "$path"
    else
      echo "BEGIN;"; cat "$path"; echo
    fi
    printf "INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES ('%s', '%s', ARRAY[\$%s\$" "$v" "$n" "$tag"
    cat "$path"
    printf "\$%s\$]);\nCOMMIT;\n" "$tag"
  } | as_migrador
done
echo "Finished."
