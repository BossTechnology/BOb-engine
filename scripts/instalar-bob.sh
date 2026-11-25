#!/usr/bin/env bash
# BOb on a box, as decided for O-3 (D77 §2.8, P5 §6.2). Henry, 2026-11-24:
# «postgres una vez, luego migrador». Run by Henry in a window, never by an
# agent against a box. CI runs it against a disposable local stack.
#
#   POSTGRES_URL=…  SUPABASE_ADMIN_URL=…  MIGRADOR_URL=…  MIGRADOR_PASSWORD=… \
#   scripts/instalar-bob.sh
#
# 1. The install chain, only the files in supabase/provision/install-chain.sha256,
#    each checked against its hash, pushed by postgres. --include-all, so a box
#    whose history lacks one of them (lab-02, if it does) gets it; one already
#    applied is skipped.
# 2. The provisioning: bob-vecina.sql as postgres, then the password, then
#    bob-vecina-supabase-admin.sql as supabase_admin (the auth grant and the
#    hand-over of bob). Idempotent.
# 3. Every other migration not yet recorded, in order, applied by bob_migrador
#    with psql, and recorded by postgres in supabase_migrations.schema_migrations
#    as the CLI records it. Not `supabase db push` as bob_migrador: the CLI reads
#    and creates that history table, shared and not bob's, and stops with 42501
#    (measured, CI run 45630458545). A file that fails stops the script; the
#    files before it stay applied and recorded.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${POSTGRES_URL:?}" "${SUPABASE_ADMIN_URL:?}" "${MIGRADOR_URL:?}" "${MIGRADOR_PASSWORD:?}"
LIST=supabase/provision/install-chain.sha256
if command -v sha256sum >/dev/null; then SHA=(sha256sum); else SHA=(shasum -a 256); fi

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
mkdir -p "$work/supabase/migrations"
cp supabase/config.toml "$work/supabase/"

echo "== 1 · the install chain, as postgres"
(cd supabase/migrations && grep -v '^#' "../provision/install-chain.sha256" | "${SHA[@]}" -c --quiet -)
grep -v '^#' "$LIST" | while read -r _ f; do cp "supabase/migrations/$f" "$work/supabase/migrations/"; done
supabase db push --db-url "$POSTGRES_URL" --workdir "$work" --include-all --yes

echo "== 2 · the provisioning"
psql "$POSTGRES_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/provision/bob-vecina.sql
psql "$POSTGRES_URL" -X -q -v ON_ERROR_STOP=1 -v pw="$MIGRADOR_PASSWORD" <<'SQL'
ALTER ROLE bob_migrador PASSWORD :'pw';
SQL
psql "$SUPABASE_ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -f supabase/provision/bob-vecina-supabase-admin.sql

echo "== 3 · every other migration, as bob_migrador"
applied=$(psql "$POSTGRES_URL" -X -A -t -q -c 'SELECT version FROM supabase_migrations.schema_migrations')
for path in $(ls supabase/migrations/*.sql | sort); do
  f=$(basename "$path")
  [[ "$f" =~ ^[0-9]+_.*\.sql$ ]] || continue
  v=${f%%_*}
  grep -qx "$v" <<<"$applied" && continue
  if grep -q "  $f\$" "$LIST"; then echo "$f is in the install chain and not applied: run step 1 again" >&2; exit 1; fi
  n=${f#*_}; n=${n%.sql}
  echo "Applying $f as bob_migrador"
  psql "$MIGRADOR_URL" -X -q -v ON_ERROR_STOP=1 -f "$path"
  psql "$POSTGRES_URL" -X -q -v ON_ERROR_STOP=1 -v v="$v" -v n="$n" -v body="$(cat "$path")" <<'SQL'
INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES (:'v', :'n', ARRAY[:'body']);
SQL
done
echo "Finished."
