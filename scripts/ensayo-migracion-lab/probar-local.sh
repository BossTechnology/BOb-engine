#!/usr/bin/env bash
# scripts/ensayo-migracion-lab/probar-local.sh — the rehearsal end to end on a
# disposable copy of lab-02's identity stack, on this machine.
#
# It starts the two containers of Bzzz compose/l6-supabase.yml at the same
# image digests (supabase/postgres 17.6.1.136 and gotrue v2.189.0) on a private
# network, with the database published on 127.0.0.1:58372 only. Nothing that is
# already running is stopped or touched. Every secret is generated here and
# lives in a temporary directory that is removed at the end.
#
# Then it runs the rehearsal the way Henry will on lab-02, and sees every check
# fail when it should:
#   - --dry-run, --ejecutar, --deshacer, and --ejecutar again on the undone box;
#   - each sabotage switch, which must end in exit 1 naming its check;
#   - each refusal (wrong CLI, credential file not 600, a box that already has
#     BOb, a host that is not lab-02), which must end in exit 2.
#
# USAGE
#   SUPABASE=/path/to/supabase-2.120.0 scripts/ensayo-migracion-lab/probar-local.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
ENSAYO="$REPO/scripts/ensayo-migracion-lab.sh"
SUPABASE="${SUPABASE:-supabase}"
PUERTO="${ENSAYO_P5_PUERTO:-58372}"
IMG_DB="supabase/postgres:17.6.1.136@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00"
IMG_AUTH="supabase/gotrue:v2.189.0@sha256:385184459f57569c54c25209f51f3b2be99ddd7c4ce9e3555b5d3eea8447b7cf"
DB=ensayo-p5-db; AUTH=ensayo-p5-auth; RED=ensayo-p5-red

# --levantar: start the stack, write its options to <dir>/opciones and stop
# there, for working on the rehearsal by hand. --bajar removes it.
case "${1:-}" in
  --bajar) docker rm -f "$DB" "$AUTH" >/dev/null 2>&1; docker network rm "$RED" >/dev/null 2>&1
           docker volume rm ensayo-p5-db-config >/dev/null 2>&1; exit 0 ;;
esac
T="$(mktemp -d "${TMPDIR:-/tmp}/ensayo-p5.XXXXXX")"
chmod 700 "$T"
limpiar() {
  docker rm -f "$DB" "$AUTH" >/dev/null 2>&1
  docker network rm "$RED" >/dev/null 2>&1
  docker volume rm ensayo-p5-db-config >/dev/null 2>&1
  rm -rf "$T"
}
trap limpiar EXIT

for c in "$DB" "$AUTH"; do
  docker inspect "$c" >/dev/null 2>&1 && { echo "ya existe un contenedor $c: no lo toco, para"; exit 2; }
done
if lsof -nP -iTCP:"$PUERTO" -sTCP:LISTEN >/dev/null 2>&1; then echo "el puerto $PUERTO está ocupado"; exit 2; fi

PG_PASS="$(openssl rand -hex 24)"; JWT="$(openssl rand -hex 32)"
docker network create "$RED" >/dev/null
docker run -d --name "$DB" --network "$RED" -p "127.0.0.1:$PUERTO:5432" \
  -e POSTGRES_PASSWORD="$PG_PASS" -e POSTGRES_HOST=/var/run/postgresql -e PGPORT=5432 -e PGDATABASE=postgres \
  -e JWT_SECRET="$JWT" -e JWT_EXP=3600 \
  -v ensayo-p5-db-config:/etc/postgresql-custom \
  "$IMG_DB" postgres -c config_file=/etc/postgresql/postgresql.conf -c log_min_messages=fatal >/dev/null
echo "esperando la base…"
for _ in $(seq 1 90); do
  # Over TCP on the private network, as gotrue will connect: during init the
  # image runs a temporary server on the socket only, which answers too early.
  docker exec -e PGPASSWORD="$PG_PASS" "$DB" psql -h "$DB" -U supabase_admin -tAc "select 1 from pg_roles where rolname='supabase_auth_admin'" 2>/dev/null | grep -q 1 && break
  sleep 2
done
# What config/supabase/roles.sql and jwt.sql do in the box.
docker exec -i "$DB" psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -v pgpass="$PG_PASS" -v jwt="$JWT" <<'SQL' >/dev/null
SELECT format('ALTER USER %I WITH PASSWORD %L', rolname, :'pgpass') FROM pg_roles
 WHERE rolname IN ('authenticator', 'pgbouncer', 'supabase_auth_admin', 'postgres') \gexec
ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt';
SQL
docker run -d --name "$AUTH" --network "$RED" --restart unless-stopped \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:$PG_PASS@$DB:5432/postgres" \
  -e GOTRUE_JWT_SECRET="$JWT" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_ADMIN_ROLES=service_role -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_SITE_URL=http://localhost -e API_EXTERNAL_URL=http://localhost/auth/v1 \
  -e GOTRUE_DISABLE_SIGNUP=true -e GOTRUE_MAILER_AUTOCONFIRM=true -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
  "$IMG_AUTH" >/dev/null
echo "esperando a gotrue (crea el esquema auth)…"
for _ in $(seq 1 60); do
  docker exec "$AUTH" wget -q --spider http://localhost:9999/health 2>/dev/null && break
  sleep 2
done
sleep 3
# Two invented portal accounts, so that "auth untouched" counts something.
docker exec -i "$DB" psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO auth.users (instance_id, id, aud, role, email, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'cuenta.uno@example.com', now(), now()),
       ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'cuenta.dos@example.com', now(), now());
SQL

printf 'BOB_MIGRADOR_USUARIO=postgres\nBOB_MIGRADOR_CLAVE=%s\n' "$PG_PASS" > "$T/migrador.env"
chmod 600 "$T/migrador.env"

if [ "${1:-}" = --levantar ]; then
  trap - EXIT
  echo "--objetivo local --contenedor $DB --red $RED --db-host 127.0.0.1 --db-port $PUERTO --migrador $T/migrador.env --salida $T/salida --supabase $SUPABASE" > "$T/opciones"
  echo "levantado; opciones en $T/opciones (quitar con --bajar)"; exit 0
fi

FALLOS=0
caso() {  # <name> <expected rc> <expected line or ""> -- <args...>
  local nombre="$1" rc_esp="$2" linea="$3"; shift 4
  "$@" > "$T/salida.txt" 2>&1 </dev/null; local rc=$?
  local ok=1
  [ "$rc" = "$rc_esp" ] || ok=0
  [ -z "$linea" ] || grep -qF -- "$linea" "$T/salida.txt" || ok=0
  if [ $ok = 1 ]; then echo "OK   $nombre (rc=$rc)"
  else FALLOS=$((FALLOS + 1)); echo "✗✗✗  $nombre — esperado rc=$rc_esp «$linea», obtenido rc=$rc"; tail -15 "$T/salida.txt" | sed 's/^/       /'; fi
}
ensayo() { "$ENSAYO" --objetivo local --contenedor "$DB" --red "$RED" --db-host 127.0.0.1 --db-port "$PUERTO" \
             --migrador "$T/migrador.env" --salida "$T/salida" --supabase "$SUPABASE" "$@"; }
# The newest --ejecutar run that got past preflight (a refused one has no inventory).
ultima() { ls -1d "$T/salida/"*-ejecutar | sort | while read -r d; do [ -f "$d/inventario-antes.txt" ] && echo "$d"; done | tail -1; }
sin_clave() {  # the evidence of every run never carries the password
  if grep -rqF -- "$PG_PASS" "$T/salida"; then echo "✗✗✗  la clave aparece en la evidencia"; FALLOS=$((FALLOS + 1))
  else echo "OK   la clave no aparece en ninguna evidencia"; fi
}

echo "── el camino de Henry"
caso "--dry-run sale 0 y no escribe" 0 "VEREDICTO" -- ensayo --dry-run
caso "--ejecutar sale 0" 0 "todas como se esperaba" -- ensayo --ejecutar
cp "$(ultima)/evidencia.md" "$T/evidencia-buena.md"
caso "--ejecutar otra vez se niega: la caja ya tiene BOb" 2 "ya tiene bob" -- ensayo --ejecutar
caso "--deshacer vuelve al inventario de antes" 0 "todas como se esperaba" -- ensayo --deshacer "$(ultima)"
caso "--ejecutar sobre la caja deshecha sale 0 otra vez" 0 "todas como se esperaba" -- ensayo --ejecutar
caso "--deshacer otra vez" 0 "todas como se esperaba" -- ensayo --deshacer "$(ultima)"

echo "── cada comprobación, vista fallar"
for s in "amanada-no-falla|el push sale distinto de 0" \
         "restos|la amañada envuelta no dejó nada" \
         "restaurar-sin-datos|las filas de configuración y estado vivo vuelven todas" \
         "vista-invoker|la huella de bob es idéntica" \
         "funcion-invoker|la huella de bob es idéntica" \
         "sin-publicacion|la huella de bob es idéntica" \
         "sin-dependientes|la huella de bob es idéntica" \
         "sin-reconstruir|las proyecciones reconstruidas son las de antes" \
         "rol-de-mas|box-check: tres roles y no más"; do
  caso "sabotaje ${s%%|*}" 1 "FALLO ${s#*|}" -- env ENSAYO_P5_SABOTAJE="${s%%|*}" "$ENSAYO" --objetivo local --contenedor "$DB" \
    --red "$RED" --db-host 127.0.0.1 --db-port "$PUERTO" --migrador "$T/migrador.env" --salida "$T/salida" --supabase "$SUPABASE" --ejecutar
  ensayo --deshacer "$(ultima)" > "$T/deshacer.txt" 2>&1 || { echo "✗✗✗  no se pudo deshacer tras ${s%%|*}"; tail -5 "$T/deshacer.txt"; FALLOS=$((FALLOS + 1)); }
done

echo "── cada rechazo"
printf '#!/bin/sh\necho 2.119.0\n' > "$T/cli-viejo"; chmod +x "$T/cli-viejo"
caso "un CLI distinto del de CI" 2 "RECHAZADO: CLI 2.119.0" -- \
  "$ENSAYO" --objetivo local --contenedor "$DB" --red "$RED" --db-host 127.0.0.1 --db-port "$PUERTO" --migrador "$T/migrador.env" --salida "$T/salida" --supabase "$T/cli-viejo" --dry-run
cp "$T/migrador.env" "$T/migrador-644.env"; chmod 644 "$T/migrador-644.env"
caso "la credencial no está en 600" 2 "no en 600" -- \
  "$ENSAYO" --objetivo local --contenedor "$DB" --red "$RED" --migrador "$T/migrador-644.env" --supabase "$SUPABASE" --dry-run
printf 'BOB_MIGRADOR_USUARIO=postgres\nBOB_MIGRADOR_CLAVE=no-es-esta\n' > "$T/migrador-mala.env"; chmod 600 "$T/migrador-mala.env"
caso "una clave equivocada" 2 "no conecto como el migrador" -- \
  "$ENSAYO" --objetivo local --contenedor "$DB" --red "$RED" --db-host 127.0.0.1 --db-port "$PUERTO" --migrador "$T/migrador-mala.env" --salida "$T/salida" --supabase "$SUPABASE" --dry-run
caso "lab-02 en una máquina que no es lab-02" 2 "esto corre en bzzz-lab-02" -- \
  "$ENSAYO" --migrador "$T/migrador.env" --supabase "$SUPABASE" --dry-run
caso "un sabotaje fuera de local" 2 "solo con --objetivo local" -- \
  env ENSAYO_P5_SABOTAJE=restos "$ENSAYO" --migrador "$T/migrador.env" --dry-run
sin_clave

# The good run's evidence, for whoever reads this bench's output.
if [ -n "${ENSAYO_P5_COPIAR_EVIDENCIA:-}" ]; then cp "$T/evidencia-buena.md" "$ENSAYO_P5_COPIAR_EVIDENCIA"; fi

echo
if [ "$FALLOS" -eq 0 ]; then echo "TODOS LOS CASOS CASAN"; exit 0; else echo "$FALLOS CASO(S) NO CASAN"; exit 1; fi
