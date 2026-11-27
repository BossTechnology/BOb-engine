#!/usr/bin/env bash
# Semilla demo de BOb: datos INVENTADOS para ver las pantallas de bob-web con
# contenido en una caja de laboratorio. No es una migración, no entra en la
# cadena de instalación y no se corre en la caja de un cliente.
#
#   scripts/demo/bob-demo.sh --caja lab-02 --tenant <bzzz.tenant>              # en seco
#   scripts/demo/bob-demo.sh --caja lab-02 --tenant <bzzz.tenant> --ejecutar   # siembra
#   scripts/demo/bob-demo.sh --caja lab-02 --tenant <bzzz.tenant> --quitar --ejecutar
#
# Opciones:
#   --caja lab-02|local   obligatoria; cualquier otro valor se rechaza.
#                         lab-02: el nombre de esta máquina (hostname) debe
#                         contener «lab-02». local: PGHOST y PGHOSTADDR vacíos
#                         o de loopback, sin PGSERVICE. Esto solo frena un
#                         descuido aquí; quien decide es la base (guarda G8:
#                         la org lleva settings.bob_demo_caja igual a --caja).
#   --tenant <slug>       el slug de la única organización de la caja
#                         (bzzz.tenant; el mismo que usa provision-user.mjs).
#   --zona <IANA>         la hora local de la curva diaria; America/Bogota.
#   --quitar              borra lo sembrado en vez de sembrar.
#   --ejecutar            confirma. Sin él todo corre y se deshace (ROLLBACK).
#
# La conexión es la de libpq (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSFILE,
# PGSSLMODE): ninguna clave pasa por la línea de órdenes y el guion no imprime
# la conexión. El rol que se conecta solo lee para las guardas; escribe bajando
# a bob_app (canales y actores) y a bob_feeder (proyecciones) con SET LOCAL
# ROLE. Nunca el service role: las guardas lo rechazan.
#
# Todo va en una transacción: guardas.sql, luego semilla.sql o quitar.sql,
# luego resumen.sql y devolver.sql. Si algo falla, no queda nada.
#
# Salida: 0 hecho (o ensayado en seco), 1 la base se negó (una guarda o un
# error de SQL; leer el mensaje), 2 los argumentos o el destino no valen.
set -euo pipefail

aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
caja='' tenant='' zona='America/Bogota' accion='sembrar' fin='ROLLBACK'

no() { echo "bob-demo: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --caja)     [ $# -ge 2 ] || no "--caja necesita un valor"; caja=$2; shift 2 ;;
    --tenant)   [ $# -ge 2 ] || no "--tenant necesita un valor"; tenant=$2; shift 2 ;;
    --zona)     [ $# -ge 2 ] || no "--zona necesita un valor"; zona=$2; shift 2 ;;
    --quitar)   accion='quitar'; shift ;;
    --ejecutar) fin='COMMIT'; shift ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    *)          no "opción desconocida: $1" ;;
  esac
done

case "$caja" in
  lab-02)
    host=$(hostname 2>/dev/null || true)
    case "$host" in
      *lab-02*) ;;
      *) no "--caja lab-02 pero esta máquina se llama «${host}»; la semilla solo corre en lab-02" ;;
    esac ;;
  local)
    case "${PGHOST:-}" in
      ''|127.0.0.1|localhost|::1|/*) ;;
      *) no "--caja local pero PGHOST no es de loopback" ;;
    esac
    case "${PGHOSTADDR:-}" in
      ''|127.0.0.1|::1) ;;
      *) no "--caja local pero PGHOSTADDR no es de loopback" ;;
    esac
    [ -z "${PGSERVICE:-}${PGSERVICEFILE:-}" ] || no "--caja local no acepta PGSERVICE: el destino tiene que verse" ;;
  '') no "falta --caja: la semilla solo corre con un destino de laboratorio explícito (lab-02 o local)" ;;
  *)  no "--caja ${caja}: no es una caja de laboratorio (solo lab-02 o local)" ;;
esac

[[ "$tenant" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || no "--tenant: el slug de la organización de la caja (minúsculas, cifras y guiones)"
[[ "$zona" =~ ^[A-Za-z_]+(/[A-Za-z_+-]+){0,2}$ ]] || no "--zona: un nombre IANA, p. ej. America/Bogota"

archivo=semilla.sql
[ "$accion" = quitar ] && archivo=quitar.sql

echo "bob-demo: ${accion} en ${caja}, tenant ${tenant}, $([ "$fin" = COMMIT ] && echo 'EJECUTANDO' || echo 'en seco (ROLLBACK)')"

# Los valores ya están validados por las expresiones de arriba: ninguno lleva comillas.
if ! "${PSQL:-psql}" -X -q -v ON_ERROR_STOP=1 \
    -c "BEGIN" \
    -c "SELECT set_config('bob_demo.caja', '${caja}', true), set_config('bob_demo.tenant', '${tenant}', true), set_config('bob_demo.accion', '${accion}', true), set_config('bob_demo.zona', '${zona}', true)" \
    -f "$aqui/guardas.sql" \
    -f "$aqui/$archivo" \
    -f "$aqui/resumen.sql" \
    -f "$aqui/devolver.sql" \
    -c "$fin" > /dev/null; then
  echo "bob-demo: la base se negó o falló; no quedó nada escrito" >&2
  exit 1
fi

if [ "$fin" = COMMIT ]; then
  echo "bob-demo: hecho"
else
  echo "bob-demo: en seco, deshecho; repetir con --ejecutar"
fi
