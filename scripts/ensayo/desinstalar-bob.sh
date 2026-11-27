#!/usr/bin/env bash
# desinstalar-bob.sh — deja la caja de ensayo model-01 SIN BOb, como estaba antes de su primera puesta, para ensayar
# ahí la de Febor desde cero: base vacía → la huella de 00f79b7 (544fe970…) en un solo salto, con la aprobación
# e3b0c442…-544fe970…. No es parte de la instalación: vive fuera de supabase/migrations, nada de la cadena firmada lo
# nombra, y solo corre en model-01. Lo corre Henry, a mano; ninguna IA lo corre contra una caja.
#
# USO, en model-01, como root, desde una copia de root de este fichero (no desde un clon que otro pueda escribir):
#   sudo install -o root -g root -m 755 scripts/ensayo/desinstalar-bob.sh /root/desinstalar-bob.sh
#   sudo /root/desinstalar-bob.sh --caja model-01 --motor <clon de BOb-engine> <commit instalado>
#   sudo /root/desinstalar-bob.sh --caja model-01 --motor <clon de BOb-engine> <commit instalado> --ejecutar
# Sin --ejecutar no escribe nada: la base se lee en una transacción READ ONLY, y de ficheros y Docker solo se lista.
# Con --ejecutar enseña lo mismo, pide escribir «desinstalo» y lo hace. <commit instalado> es el sha entero del commit
# de BOb-engine que la caja tiene puesto: su huella tiene que ser la de /opt/bob/instalacion-firmada. Las
# migraciones de ese commit, leídas de sus objetos de git, son el mapa de lo que la cadena creó.
#
# EL MAPA: lo que la primera puesta crea (runbook PRIMERA-PUESTA-FEBOR.md de Bob-New en 7f805eb, B2 a B14), y quién
# lo deshace. Se deshace en orden inverso: B12, B9/B8/B6 en /opt/bob, la base (B8b, B8, B7, B6, B5), B4 y B3.
#   Docker (B12):     el contenedor bob-web (proyecto de compose `bob`) y sus imágenes: las de BOB_WEB_IMAGEN y
#                     BOB_WEB_IMAGEN_ANTERIOR de /opt/bob/.env y la del contenedor, con sus etiquetas bob-web:*.
#                     Sus rutas de Traefik son etiquetas del contenedor: se van con él. bob-feeder no existe en v1;
#                     si estuviera, se trata igual.
#   /opt/bob (B3, B6, B8, B9, B12, caja): bin/firma-instalacion, firmantes_instalacion, aprobaciones-revocadas,
#                     aprobaciones/, instalacion-firmada, instalacion-aprobacion, instalacion-en-curso,
#                     hosts-permitidos, .instalando, trabajo.*; secrets/migrador.env (el alta), secrets/app.env (B8),
#                     y feeder.env y vecinos/ si estuvieran; config/caja.env, deploy.sh, rollback.sh, lib.sh,
#                     fijos.sh, comprobar-aislamiento.sh, compose.yml y .env (B9); entrega/ y atestaciones/ (B12).
#                     Antes de la primera puesta /opt/bob no existía: se quita entero.
#   /root/bob-install (B4): postgres.env, si B14 no lo quitó, y la carpeta.
#   La base, en una sola transacción:
#     - el esquema bob y todo lo que tiene (B5, B7, la org de B8b, las filas de bob.users de B13);
#     - las funciones que la cadena deja en public (las que sus migraciones nombran, de postgres);
#     - la historia del CLI (supabase_migrations, que antes no existía: B0 lo midió en model-01 y en Febor);
#     - el TRUNCATE que 20261121170000 quitó a anon y authenticated en los privilegios por defecto de postgres en
#       public, que se devuelve; el USAGE en public de bob_app, bob_feeder y bob_ai_ro; el USAGE en auth de
#       bob_migrador (el alta, como supabase_admin). El USAGE en public de supabase_auth_admin (20260606120001) NO
#       se quita: Postgres lo apunta como concedido por pg_database_owner lo dé quien lo dé, así que no se distingue
#       del que Bzzz pudiera dar para su propio hook de auth, y quitárselo a Bzzz rompería el login del portal. Se
#       queda, el guion lo dice, e imprime la orden por si Henry confirma que Bzzz no lo usa;
#     - los roles bob_app, bob_feeder y bob_ai_ro (la cadena) y bob_migrador (el alta), con su contraseña (B6, B8) y
#       la fila de ADMIN que Postgres 16+ deja a postgres sobre cada uno.
#     En auth no hay nada que quitar: la cadena no crea usuarios ni claims (el disparador on_auth_user_created lo crea
#     20260606120000 y lo quita 20261121130000; si siguiera, el guion lo vería y se pararía), B8 solo da LOGIN, y las
#     cuentas de BzzzBX con las que se entra en B13 son de Bzzz y se quedan.
#   Lo de Bzzz se queda: el guion no lo toca (lo de abajo, «LO QUE SE QUEDA EN BZZZ», dice qué y cómo).
#
# GUARDAS. Todas fallan cerradas: ante la duda, no borra nada.
#   G1  --caja model-01, escrito así.
#   G2  el nombre corto de la máquina (uname -n hasta el primer punto, lo mismo que hostname -s) es bzzz-model-01,
#       exacto: ni model-01 a secas, ni bzzz-model-010, ni bzzz-model-01x, ni febor-ex-model-01.
#   G3  bob.organizations tiene una sola fila y su slug es `modelo`. Sin esa tabla tampoco empieza.
#   G4  con --ejecutar, escribir «desinstalo» en una terminal.
#   G5  nunca la service role: con una variable de entorno que la nombre no empieza, y en la base solo se entra como
#       supabase_admin y se baja a postgres o al dueño de bob con SET ROLE.
#   G6  nunca toca lo que la puesta no creó: lo de Bzzz (auth, otros esquemas, otras vecinas como opsrun) no está en el
#       mapa, y si algo de fuera depende de lo que se va a borrar, se para.
#   G7  si encuentra algo que no está en el mapa, lo dice y se para en vez de borrarlo: un fichero de /opt/bob o de
#       /root/bob-install que no es de la puesta, un contenedor bob-* o una etiqueta que no conoce, un rol bob_*
#       que la cadena no crea, un permiso de un rol bob_* fuera de lo suyo, un objeto de fuera que cuelga de bob,
#       una historia del CLI que no es de la cadena.
#   G8  ningún contenedor (GoTrue de Bzzz, sobre todo) tiene un hook activo que llama a una función de public que se va
#       a borrar: GoTrue la llama por nombre (pg-functions://…/public/custom_access_token_hook) y, borrada, nadie
#       recibe un token, ni en el portal de Bzzz, hasta reinstalar. Se para en vez de avisar: parar no toca nada, y
#       seguir dejaría la caja sin login. Se descubre en el entorno de cada contenedor, sin lista de hooks.
#   Además: la huella del commit es la de /opt/bob/instalacion-firmada; lo que se ejecuta es lo que se enseñó (la
#   transacción vuelve a hacer el plan y lo compara); y antes del COMMIT, la misma comprobación que hace `cadena`
#   desde la base vacía (scripts/instalar-bob.sh, BOB_BASE_VACIA=1) tiene que no encontrar nada.
#
# POR QUÉ supabase_admin. El alta de Bzzz da `GRANT USAGE ON SCHEMA auth TO bob_migrador` como supabase_admin (77.22),
# y solo quien lo concedió puede quitarlo: como postgres, el REVOKE no quita nada («no privileges could be revoked»)
# y DROP ROLE bob_migrador falla. Para tenerlo todo en una transacción se entra como supabase_admin, igual que el alta
# (docker exec bzzz-supabase-db psql -U supabase_admin, sin contraseña), y todo menos ese REVOKE corre con SET LOCAL
# ROLE postgres o con el dueño de bob: los permisos de postgres siguen poniendo el límite. No es la service role.
#
# SI FALLA A MEDIAS. Antes de la transacción se para bob-web y /opt/bob y /root/bob-install se mueven a un lado, sin
# borrarlos. Si la transacción falla, vuelven a su sitio y bob-web arranca otra vez: la caja queda como estaba. Solo
# después del COMMIT se borran el contenedor, las imágenes y las dos carpetas.
#
# LO QUE SE QUEDA EN BZZZ (el guion no lo toca; lo imprime al final con sus órdenes): BZZZ_HOST_BOB en
# /opt/bzzz/compose/.env y el portal y la puerta que lo leen (B10); la red bzzz-vecina-bob y el pg_hba de las vecinas
# (B6); bzzz-vecinos, su CA y su certificado de servidor (B13); Bzzz en main (B1); los ficheros de bzzzops en su home
# (A6, B3). Ver scripts/ensayo/README.md.
#
# SALIDA: 0 hecho (o, en seco, nada que impida hacerlo) · 1 una guarda o una comprobación lo paró, o algo falló (lo
# dice la última línea) · 2 uso.
set -euo pipefail

CAJA_ENSAYO=model-01
# El nombre corto de la máquina de model-01 (hostname -s), medido en la caja. No es el nombre de la caja: --caja
# model-01 es el nombre lógico, y G2 compara la máquina con este, exacto.
MAQUINA_ENSAYO=bzzz-model-01
SLUG_ENSAYO=modelo
PALABRA=desinstalo
MARCA_VACIADA=BASE-YA-VACIADA
# Cada sesión del guion en la base se llama así (application_name): quien recupere la caja después de un kill -9
# busca en pg_stat_activity si queda alguna, porque psql puede seguir vivo y hacer COMMIT después de morir el guion.
APPNAME=desinstalar-bob
NS_BOB=bob
MIGRADOR=bob_migrador

no() { echo "desinstalar-bob: no: $1" >&2; exit 1; }
uso() { echo "Uso: $0 --caja $CAJA_ENSAYO --motor <clon de BOb-engine> <commit instalado> [--ejecutar]" >&2; exit 2; }

CAJA=""; REPO=""; COMMIT=""; EJECUTAR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --caja) [ $# -ge 2 ] || uso; CAJA=$2; shift 2 ;;
    --motor) [ $# -ge 3 ] || uso; REPO=$2; COMMIT=$3; shift 3 ;;
    --ejecutar) EJECUTAR=1; shift ;;
    *) uso ;;
  esac
done

# G5: la service role no entra por ninguna variable.
for v in $(compgen -e); do
  case "$(printf '%s' "$v" | tr '[:lower:]' '[:upper:]')" in
    *SERVICE_ROLE*|*SERVICE_KEY*|*SERVICEROLE*) no "G5: la variable $v nombra la service role; este guion nunca la usa: quítala del entorno" ;;
  esac
done

# G1
[ "$CAJA" = "$CAJA_ENSAYO" ] || no "G1: solo para la caja de ensayo: --caja $CAJA_ENSAYO (llegó '${CAJA}')"

# Dónde vive cada cosa. En una caja, fijo. El modo de prueba (tests/ensayo-desinstalar.test.mjs) lo cambia solo si
# no se es root, la máquina no tiene /opt/bzzz y la raíz lleva su marca: un DESINSTALAR_PRUEBA_RAIZ olvidado en una
# caja no apaga nada.
PRUEBA=""
for v in $(compgen -e); do
  case "$v" in DESINSTALAR_PRUEBA_*) PRUEBA=1 ;; esac
done
if [ -n "$PRUEBA" ]; then
  R=${DESINSTALAR_PRUEBA_RAIZ:-}
  [ "$(id -u)" != 0 ] || no "el modo de prueba (DESINSTALAR_PRUEBA_*) nunca corre como root"
  [ ! -e /opt/bzzz ] && [ ! -L /opt/bzzz ] || no "el modo de prueba no corre en una máquina con /opt/bzzz"
  [[ "$R" =~ ^/[A-Za-z0-9_./-]+$ ]] && [ -d "$R" ] && [ ! -L "$R" ] && [ -O "$R" ] || no "DESINSTALAR_PRUEBA_RAIZ: una carpeta propia, con ruta absoluta"
  case "$R" in /opt|/opt/*) no "DESINSTALAR_PRUEBA_RAIZ no puede estar en /opt" ;; esac
  [ -f "$R/.desinstalar-prueba" ] && [ "$(cat "$R/.desinstalar-prueba")" = "desinstalar-prueba $R" ] || no "falta la marca $R/.desinstalar-prueba"
  OPT_BOB=$R/opt/bob
  ROOT_INSTALL=$R/root/bob-install
  MAQUINA=${DESINSTALAR_PRUEBA_HOSTNAME:-$(uname -n)}
  DOCKER=${DESINSTALAR_PRUEBA_DOCKER:-}
  [ -x "$DOCKER" ] || no "DESINSTALAR_PRUEBA_DOCKER: el docker falso de la prueba"
  URL=${DESINSTALAR_PRUEBA_URL:-}
  [[ "$URL" =~ ^postgresql://supabase_admin:[^@/]*@(127\.0\.0\.1|localhost):[0-9]+/[a-z_][a-z0-9_]*$ ]] \
    || no "DESINSTALAR_PRUEBA_URL: supabase_admin en loopback"
  psql_su() { PGAPPNAME=$APPNAME psql "$URL" -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 "$@"; }
else
  [ "$(id -u)" = 0 ] || no "en una caja corre como root (sudo): /opt/bob y /root/bob-install son de root"
  OPT_BOB=/opt/bob
  ROOT_INSTALL=/root/bob-install
  MAQUINA=$(uname -n)
  DOCKER=docker
  DB=bzzz-supabase-db
  command -v docker >/dev/null || no "falta docker"
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$DB" 2>/dev/null)" = healthy ] || no "$DB no está sano"
  # Como el alta de Bzzz (psql_su de generar-secretos-vecina.sh): supabase_admin por el socket del contenedor.
  psql_su() { docker exec -i -e PGAPPNAME="$APPNAME" "$DB" psql -X -q -A -t -F $'\t' -U supabase_admin -d postgres -v ON_ERROR_STOP=1 "$@"; }
fi

# G2: igual, no «contiene»: bzzz-model-010 o febor-ex-model-01 no son la máquina de model-01.
[ "${MAQUINA%%.*}" = "$MAQUINA_ENSAYO" ] || no "G2: esta máquina se llama '$MAQUINA', y la de $CAJA_ENSAYO es $MAQUINA_ENSAYO: nada borrado"

TMP=$(mktemp -d); chmod 700 "$TMP"
# Todo rm -rf de este guion va con --one-file-system: no cruza a otro sistema de ficheros montado dentro de lo que
# borra. En una caja (GNU) es obligatorio; solo el modo de prueba, en una máquina cuyo rm no lo tiene, sigue sin él.
RMF=(rm -rf --one-file-system)
mkdir "$TMP/sonda"
if ! "${RMF[@]}" "$TMP/sonda" 2>/dev/null; then
  [ -n "$PRUEBA" ] || no "este rm no tiene --one-file-system"
  RMF=(rm -rf)
fi
trap '"${RMF[@]}" "$TMP"' EXIT

# Una corrida anterior que murió después de su COMMIT dejó su marca en la carpeta apartada: la base ya está vacía, y
# esas carpetas no se devuelven (dirían que la caja tiene BOb sobre una base sin él). Antes de nada más.
for x in "$OPT_BOB" "$ROOT_INSTALL"; do
  for y in "$(dirname "$x")"/."$(basename "$x")".desinstalando.*; do
    [ ! -e "$y/$MARCA_VACIADA" ] || no "$y/$MARCA_VACIADA: una corrida anterior ya vació la base (COMMIT) y murió antes de borrar sus carpetas. No las devuelvas: bórralas (sudo ${RMF[*]} $y), quita bob-web y sus imágenes a mano, y sigue con B3 desde la base vacía"
  done
done

# ── El árbol instalado: su huella es la de instalacion-firmada, y sus migraciones son el mapa ──────────────────────
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || no "el commit instalado: su sha entero (git rev-parse), no '${COMMIT}'"
[[ "$REPO" =~ ^/[A-Za-z0-9_./-]+$ ]] || no "--motor: la ruta absoluta de un clon de BOb-engine"
FIRMA=$OPT_BOB/bin/firma-instalacion
[ -f "$FIRMA" ] || no "no está $FIRMA: sin ella no hay cómo medir qué árbol tiene puesto esta caja"
[ -f "$OPT_BOB/instalacion-firmada" ] || no "no está $OPT_BOB/instalacion-firmada: no se sabe qué tiene puesto esta caja"
if [ -z "$PRUEBA" ]; then
  for f in /opt "$OPT_BOB" "$OPT_BOB/bin" "$FIRMA" "$OPT_BOB/instalacion-firmada"; do
    [ "$(stat -c '%u' "$f")" = 0 ] && (( (8#$(stat -c '%a' "$f") & 8#022) == 0 )) || no "$f no es de root, o la escriben otros"
  done
fi
INSTALADA=$(head -1 "$OPT_BOB/instalacion-firmada")
[[ "$INSTALADA" =~ ^[0-9a-f]{64}$ ]] || no "$OPT_BOB/instalacion-firmada no tiene una huella"
# El clon se lee una sola vez: se copia a una carpeta propia (git clone --no-checkout --no-local, que vuelve a calcular el
# id de cada objeto al recibirlo), y la huella y el mapa salen los dos de esa copia, que nadie más escribe. Un clon
# que cambia mientras el guion corre no puede dar una huella de un árbol y un mapa de otro.
G() { git -c core.fsmonitor= -c core.hooksPath=/dev/null -c safe.directory='*' -c color.ui=never --git-dir="$GD" "$@"; }
# Sin --bare: con safe.bareRepository=explicit, git no abre un repositorio desnudo con -C.
COPIA=$TMP/motor; GD=$COPIA/.git
git -c core.fsmonitor= -c core.hooksPath=/dev/null -c safe.directory='*' -c protocol.file.allow=always -c color.ui=never \
  clone -q --no-checkout --no-local --no-hardlinks -- "$REPO" "$COPIA" 2> "$TMP/clone.err" \
  || { sed 's/^/  /' "$TMP/clone.err" >&2; no "no pude copiar el clon $REPO"; }
[ "$(G rev-parse -q --verify "$COMMIT^{commit}")" = "$COMMIT" ] || no "$REPO no tiene el commit $COMMIT"
HUELLA=$(/bin/bash -p "$FIRMA" huella "$COMMIT" "$COPIA") || no "no pude medir la huella de $COMMIT"
[ "$HUELLA" = "$INSTALADA" ] || no "la huella de $COMMIT es $HUELLA, y esta caja está en $INSTALADA: el mapa tiene que ser el del árbol instalado"
mkdir "$TMP/migrations"
G ls-tree --name-only "$COMMIT" supabase/migrations/ > "$TMP/ls" || no "no pude leer supabase/migrations de $COMMIT"
while IFS= read -r p; do
  f=${p##*/}
  [[ "$f" =~ ^[0-9]{14}_[A-Za-z0-9_.-]+\.sql$ ]] || continue
  G cat-file blob "$COMMIT:$p" > "$TMP/migrations/$f" || no "no pude leer $p de $COMMIT"
done < "$TMP/ls"
ls "$TMP/migrations" | grep -q . || no "$COMMIT no tiene migraciones"

# Lo mismo que scripts/instalar-bob.sh saca del árbol para su comprobación de la base vacía, con las mismas
# expresiones: las versiones, los nombres que dan las migraciones y los esquemas que crean o a los que mueven.
vs=$(ls "$TMP/migrations" | sed -n 's/^\([0-9]\{14\}\)_.*\.sql$/\1/p' | paste -sd, -)
sql=$(cat "$TMP"/migrations/*.sql | tr 'A-Z' 'a-z' | tr -s '[:space:]' ' ')
nombre() { awk '{print $NF}' | tr -d '"' | sed 's/.*\.//' | grep -E '^[a-z_][a-z0-9_]*$' | grep -vxE 'if|not|exists|on|or|only' | sort -u | paste -sd, -; }
names=$(grep -o -E '(create( or replace)?( unique)?( unlogged)? (table|view|materialized view|function|procedure|type|domain|sequence|index)( concurrently)?( if not exists)? [a-z0-9_".]+|rename to [a-z0-9_"]+)' <<<"$sql" | nombre) || names=""
sch=$( { echo bob; grep -o -E '(create schema( if not exists)? [a-z0-9_"]+|set schema [a-z0-9_"]+)' <<<"$sql"; } | nombre) || sch=bob
# Los roles que crea la cadena, y el del alta (bob.conf de Bzzz: <vecina>_migrador).
roles=$( { echo "$MIGRADOR"; grep -o -E 'create role [a-z0-9_"]+' <<<"$sql"; } | nombre) || roles=$MIGRADOR
# Las firmas exactas de las funciones que la cadena crea en public (con esquema public o sin esquema): nombre y tipos
# de entrada, sin nombres de parámetro, sin valores por defecto y sin los OUT, como las escribe regprocedure. La base
# las resuelve con to_regprocedure; una que no resuelva no cuenta como de la cadena, y la función que hubiera con ese
# nombre queda «desconocida» (G7): falla cerrado.
command -v perl >/dev/null || no "falta perl"
firmas=$(perl -0777 -ne '
  while (/create (?:or replace )?function ((?:"?[a-z0-9_]+"?\.)?"?[a-z0-9_]+"?) ?(\(((?:[^()]++|(?2))*)\))/g) {
    my ($n, $a) = ($1, $3); $n =~ s/"//g; my $s = "public";
    ($s, $n) = ($1, $2) if $n =~ /^(.+)\.(.+)$/;
    next unless $s eq "public";
    my (@p, @t); my ($d, $c) = (0, "");
    for my $x (split //, $a) {
      $d++ if $x eq "("; $d-- if $x eq ")";
      if ($x eq "," && $d == 0) { push @p, $c; $c = "" } else { $c .= $x }
    }
    push @p, $c if $c =~ /\S/;
    for (@p) {
      s/^\s+|\s+$//g; s/\s+(default\s.*|=.*)$//; next if /^out\s/; s/^(in|inout|variadic)\s+//;
      my @w = split /\s+/; shift @w if @w > 1; push @t, join(" ", @w);
    }
    print "$n(" . join(",", @t) . ")\n";
  }' <<<"$sql" | sort -u | paste -sd';' -) || firmas=""
[[ "$vs" =~ ^[0-9,]+$ && "$names" =~ ^[a-z0-9_,]+$ && "$sch" =~ ^[a-z0-9_,]+$ && "$roles" =~ ^[a-z0-9_,]+$ ]] || no "no pude leer las migraciones de $COMMIT"
re_firmas='^[a-z0-9_]+\([][a-z0-9_, ]*\)(;[a-z0-9_]+\([][a-z0-9_, ]*\))*$'
[[ "$firmas" =~ $re_firmas ]] || no "no pude leer las firmas de las funciones de public de $COMMIT"

# ── La comprobación de la base vacía, la de scripts/instalar-bob.sh con BOB_BASE_VACIA=1 ───────────────────────────
# Mismo texto que allí, con la historia del CLI leída solo si su tabla existe (query_to_xml), para poder correrla
# dentro de una transacción en la que esa tabla puede haberse ido ya.
CHEQUEO="WITH sa AS (SELECT oid FROM pg_roles WHERE rolname = 'supabase_admin'),
  nm AS (SELECT unnest(string_to_array('$names', ',')) AS name),
  obj AS (SELECT relname AS name, relnamespace AS ns, 'relation' AS k FROM pg_class WHERE relkind IN ('r','v','m','p','f','S','i','I')
          UNION ALL SELECT proname, pronamespace, 'function' FROM pg_proc
          UNION ALL SELECT typname, typnamespace, 'type' FROM pg_type t WHERE typtype IN ('e','d','c','r')
            AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid))
  SELECT 'role ' || rolname FROM pg_roles WHERE rolname = 'bob' OR rolname LIKE 'bob\_%'
  UNION ALL SELECT 'schema ' || nspname FROM pg_namespace n
    WHERE (nspname = ANY (string_to_array('$sch', ',')) AND (EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = n.oid) OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = n.oid)))
       OR pg_get_userbyid(nspowner) LIKE 'bob\_%'
  UNION ALL SELECT DISTINCT o.k || ' ' || n.nspname || '.' || o.name FROM obj o JOIN nm USING (name) JOIN pg_namespace n ON n.oid = o.ns
    WHERE n.nspowner NOT IN (SELECT oid FROM sa) AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL SELECT 'history ' || h FROM unnest(xpath('//v/text()', query_to_xml(
      'SELECT version AS v FROM supabase_migrations.schema_migrations WHERE version = ANY (string_to_array(''$vs'', '',''))', false, false, ''))::text[]) h
    WHERE to_regclass('supabase_migrations.schema_migrations') IS NOT NULL"

# G3, en la base. Dentro de la transacción, antes de leer o escribir nada más.
G3="DO \$\$ DECLARE n bigint; s text; BEGIN
  IF to_regclass('$NS_BOB.organizations') IS NULL THEN
    RAISE EXCEPTION 'G3: no hay $NS_BOB.organizations: esta base no es la de $CAJA_ENSAYO con BOb (la org $SLUG_ENSAYO); nada borrado';
  END IF;
  EXECUTE 'SELECT count(*), min(slug) FROM $NS_BOB.organizations' INTO n, s;
  IF n <> 1 OR s IS DISTINCT FROM '$SLUG_ENSAYO' THEN
    RAISE EXCEPTION 'G3: $NS_BOB.organizations tiene % fila(s) (slug %); en $CAJA_ENSAYO hay una sola, $SLUG_ENSAYO: nada borrado', n, coalesce(s, 'ninguno');
  END IF;
END \$\$;"

# El esquema de un objeto del catálogo, también de los que no tienen uno propio (un valor por defecto, una
# restricción, un disparador, una política, una regla): el de su tabla. pg_identify_object no lo da para esos.
ns_de() {  # <classid> <objid>
  echo "CASE $1
    WHEN 'pg_class'::regclass THEN (SELECT relnamespace FROM pg_class WHERE oid = $2)
    WHEN 'pg_proc'::regclass THEN (SELECT pronamespace FROM pg_proc WHERE oid = $2)
    WHEN 'pg_type'::regclass THEN (SELECT typnamespace FROM pg_type WHERE oid = $2)
    WHEN 'pg_constraint'::regclass THEN (SELECT connamespace FROM pg_constraint WHERE oid = $2)
    WHEN 'pg_statistic_ext'::regclass THEN (SELECT stxnamespace FROM pg_statistic_ext WHERE oid = $2)
    WHEN 'pg_attrdef'::regclass THEN (SELECT c.relnamespace FROM pg_attrdef x JOIN pg_class c ON c.oid = x.adrelid WHERE x.oid = $2)
    WHEN 'pg_trigger'::regclass THEN (SELECT c.relnamespace FROM pg_trigger x JOIN pg_class c ON c.oid = x.tgrelid WHERE x.oid = $2)
    WHEN 'pg_policy'::regclass THEN (SELECT c.relnamespace FROM pg_policy x JOIN pg_class c ON c.oid = x.polrelid WHERE x.oid = $2)
    WHEN 'pg_rewrite'::regclass THEN (SELECT c.relnamespace FROM pg_rewrite x JOIN pg_class c ON c.oid = x.ev_class WHERE x.oid = $2)
  END"
}

# ── El inventario de la base: una fila por cosa, con la sentencia que la deshace ───────────────────────────────────
# estado: borra (tiene sentencia), cascada (se va con DROP SCHEMA bob), info, paso (un cambio de rol) o desconocido
# (G7: se para). Solo lee el catálogo.
INVENTARIO="WITH
cfg AS (SELECT string_to_array('$names', ',') AS nombres, string_to_array('$roles', ',') AS roles,
               string_to_array('$firmas', ';') AS firmas,
               string_to_array('$vs', ',') AS versiones),
sa AS (SELECT oid FROM pg_roles WHERE rolname = 'supabase_admin'),
br AS (SELECT oid, rolname FROM pg_roles WHERE rolname = 'bob' OR rolname LIKE 'bob\_%'),
nsb AS (SELECT oid, nspowner FROM pg_namespace WHERE nspname = '$NS_BOB'),
-- Los dos esquemas que se borran con CASCADE: bob y la historia del CLI. Lo que cuelgue de cualquiera de los dos
-- desde fuera cascaría con él, así que los dos entran en la comprobación de dependencias (G6).
nsm AS (SELECT oid FROM pg_namespace WHERE nspname IN ('$NS_BOB', 'supabase_migrations')),
-- Lo que tienen esos dos esquemas, como (classid, objid).
enmapa AS (
  SELECT 'pg_namespace'::regclass AS classid, oid AS objid FROM nsm
  UNION ALL SELECT 'pg_class'::regclass, c.oid FROM pg_class c JOIN nsm ON nsm.oid = c.relnamespace
  UNION ALL SELECT 'pg_proc'::regclass, p.oid FROM pg_proc p JOIN nsm ON nsm.oid = p.pronamespace
  UNION ALL SELECT 'pg_type'::regclass, t.oid FROM pg_type t JOIN nsm ON nsm.oid = t.typnamespace),
-- Fuera de bob, lo que lleva un nombre que dan las migraciones (lo mismo que ve la comprobación de la base vacía).
fuera AS (
  SELECT 'pg_proc'::regclass AS classid, p.oid AS objid, n.nspname, p.proname::text AS nombre, pg_get_userbyid(p.proowner) AS dueno,
         'función'::text AS clase, p.oid::regprocedure::text AS identidad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, cfg
   WHERE p.proname = ANY (cfg.nombres) AND n.nspname <> '$NS_BOB'
     AND n.nspowner NOT IN (SELECT oid FROM sa) AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL
  SELECT 'pg_class', c.oid, n.nspname, c.relname::text, pg_get_userbyid(c.relowner), 'relación', n.nspname || '.' || c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, cfg
   WHERE c.relkind IN ('r','v','m','p','f','S','i','I') AND c.relname = ANY (cfg.nombres) AND n.nspname <> '$NS_BOB'
     AND n.nspowner NOT IN (SELECT oid FROM sa) AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL
  SELECT 'pg_type', t.oid, n.nspname, t.typname::text, pg_get_userbyid(t.typowner), 'tipo', n.nspname || '.' || t.typname
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace, cfg
   WHERE t.typtype IN ('e','d','c','r') AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid)
     AND t.typname = ANY (cfg.nombres) AND n.nspname <> '$NS_BOB'
     AND n.nspowner NOT IN (SELECT oid FROM sa) AND n.nspname NOT IN ('pg_catalog', 'information_schema')),
-- De eso, lo que la cadena deja fuera de bob: funciones de postgres en public con la firma exacta que crea una de
-- sus migraciones. Otra sobrecarga con el mismo nombre no es suya, ni lo demás (G6, G7).
fmapa AS (SELECT * FROM fuera, cfg WHERE clase = 'función' AND nspname = 'public' AND dueno = 'postgres'
            AND objid IN (SELECT to_regprocedure('public.' || f)::oid FROM unnest(cfg.firmas) f)),
mapa AS (SELECT classid, objid FROM enmapa UNION ALL SELECT classid, objid FROM fmapa),
-- Lo de fuera que depende de lo que se va a borrar (G6): cascaría con ello.
dep AS (
  SELECT DISTINCT d.classid, d.objid, d.objsubid, ($(ns_de d.classid d.objid)) IN (SELECT oid FROM nsm) AS dentro,
         (pg_identify_object(d.classid, d.objid, d.objsubid)).*
    FROM pg_depend d JOIN mapa m ON m.classid = d.refclassid AND m.objid = d.refobjid
   WHERE d.deptype IN ('n', 'a')
     AND NOT EXISTS (SELECT 1 FROM mapa m2 WHERE m2.classid = d.classid AND m2.objid = d.objid)),
-- Lo que cuelga de los roles bob*: dueño, permisos, políticas (G7).
shd AS (
  SELECT s.dbid, s.classid, s.objid, s.deptype, r.rolname, coalesce(($(ns_de s.classid s.objid)) IN (SELECT oid FROM nsm), false) AS dentro,
         (pg_identify_object(s.classid, s.objid, s.objsubid)).*
    FROM pg_shdepend s JOIN br r ON r.oid = s.refobjid
   WHERE s.refclassid = 'pg_authid'::regclass AND s.deptype IN ('o', 'a', 'r')
     AND (s.dbid = 0 OR s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database()))),
acl_public AS (
  SELECT a.grantee, a.grantor, a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'public'),
acl_auth AS (
  SELECT a.grantee, a.grantor, a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'auth'),
defacl AS (
  SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)) FILTER (WHERE a.privilege_type = 'TRUNCATE') AS con_truncate
    FROM pg_default_acl d, aclexplode(d.defaclacl) a
   WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r'),
hay_defacl AS (
  SELECT count(*) AS n FROM pg_default_acl d
   WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r'),
smig AS (SELECT oid, nspowner FROM pg_namespace WHERE nspname = 'supabase_migrations')
SELECT * FROM (
  -- 1 · el esquema bob, con su dueño
  SELECT 10 AS orden, 'paso'::text AS estado, 'rol'::text AS clase, pg_get_userbyid(nspowner)::text AS identidad,
         format('SET LOCAL ROLE %I', pg_get_userbyid(nspowner))::text AS sentencia FROM nsb
  UNION ALL SELECT 11, 'borra', 'esquema', '$NS_BOB (con todo lo que tiene)', format('DROP SCHEMA %I CASCADE', '$NS_BOB') FROM nsb
  UNION ALL SELECT 12, CASE WHEN pg_get_userbyid(nspowner) IN ('$MIGRADOR', 'postgres') THEN 'info' ELSE 'desconocido' END,
         'dueño del esquema', '$NS_BOB es de ' || pg_get_userbyid(nspowner), NULL FROM nsb
  UNION ALL SELECT 13, 'cascada',
         CASE c.relkind WHEN 'r' THEN 'tabla' WHEN 'p' THEN 'tabla' WHEN 'v' THEN 'vista' WHEN 'm' THEN 'vista materializada'
              WHEN 'S' THEN 'secuencia' WHEN 'f' THEN 'tabla foránea' END,
         '$NS_BOB.' || c.relname, NULL
    FROM pg_class c JOIN nsb ON nsb.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
  UNION ALL SELECT 13, 'cascada', 'función', p.oid::regprocedure::text, NULL FROM pg_proc p JOIN nsb ON nsb.oid = p.pronamespace
  UNION ALL SELECT 14, 'info', 'filas', '$NS_BOB.' || t || ': ' || coalesce((xpath('//n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', '$NS_BOB', t), false, false, '')))[1]::text, '?'), NULL
    FROM unnest(ARRAY['organizations', 'users', 'channels', 'interactions']) t WHERE to_regclass('$NS_BOB.' || t) IS NOT NULL
  -- 2 · lo de fuera que depende de bob o de las funciones de public: la publicación de Realtime es de Supabase y
  --     solo pierde las tablas de bob; cualquier otra cosa de fuera se queda y el guion se para (G6)
  UNION ALL SELECT 15, CASE WHEN dep.type = 'publication relation' AND dep.identity LIKE '% in publication supabase_realtime' THEN 'cascada'
                            WHEN dep.dentro THEN NULL ELSE 'desconocido' END,
         'depende de lo que se borra: ' || dep.type, dep.identity, NULL FROM dep
  -- 3 · las funciones que la cadena deja en public
  UNION ALL SELECT 20, 'paso', 'rol', 'postgres', 'SET LOCAL ROLE postgres'
  UNION ALL SELECT 21, 'borra', 'función en public', identidad, format('DROP FUNCTION IF EXISTS %s RESTRICT', objid::regprocedure) FROM fmapa
  UNION ALL SELECT 22, 'desconocido', clase || ' fuera de $NS_BOB con un nombre de BOb, de ' || dueno, identidad, NULL
    FROM fuera f WHERE NOT EXISTS (SELECT 1 FROM fmapa x WHERE x.classid = f.classid AND x.objid = f.objid)
  -- 4 · permisos en public
  UNION ALL SELECT 30, 'borra', 'permiso en el esquema public', a.privilege_type || ' de ' || pg_get_userbyid(a.grantee),
         format('REVOKE %s ON SCHEMA public FROM %I', a.privilege_type, pg_get_userbyid(a.grantee))
    FROM acl_public a WHERE a.grantee IN (SELECT oid FROM br)
  -- El de supabase_auth_admin no: concedido por pg_database_owner, venga de la cadena o de Bzzz, no se sabe de quién es.
  UNION ALL SELECT 33, 'info', 'permiso en el esquema public',
         a.privilege_type || ' de supabase_auth_admin: SE QUEDA (lo apunta ' || pg_get_userbyid(a.grantor) || ', sea de BOb o de Bzzz; ver al final)', NULL
    FROM acl_public a WHERE a.grantee = 'supabase_auth_admin'::regrole
  UNION ALL SELECT 31, 'borra', 'privilegio por defecto', 'TRUNCATE de anon y authenticated en las tablas nuevas de postgres en public (también en las que Bzzz cree después: ahí deshace F-44; ver al final)',
         'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT TRUNCATE ON TABLES TO anon, authenticated'
    FROM defacl, hay_defacl
   WHERE hay_defacl.n = 1 AND NOT ('anon' = ANY (coalesce(con_truncate, '{}'))) AND NOT ('authenticated' = ANY (coalesce(con_truncate, '{}')))
  UNION ALL SELECT 32, 'desconocido', 'privilegio por defecto', 'los de postgres en public no tienen la forma que deja la cadena', NULL
    FROM defacl, hay_defacl
   WHERE hay_defacl.n <> 1 OR (('anon' = ANY (coalesce(con_truncate, '{}'))) <> ('authenticated' = ANY (coalesce(con_truncate, '{}'))))
  -- 5 · la historia del CLI: antes de la puesta no existía
  UNION ALL SELECT 40, 'borra', 'historia del CLI', 'supabase_migrations (' || coalesce((xpath('//n/text()', query_to_xml(
           'SELECT count(*) AS n FROM supabase_migrations.schema_migrations', false, false, '')))[1]::text, '0') || ' versiones de la cadena)',
         'DROP SCHEMA supabase_migrations CASCADE' FROM smig
  UNION ALL SELECT 41, 'desconocido', 'historia del CLI', 'supabase_migrations no es de postgres', NULL FROM smig WHERE pg_get_userbyid(nspowner) <> 'postgres'
  UNION ALL SELECT 42, 'desconocido', 'en supabase_migrations, que no es del CLI', c.relname, NULL
    FROM pg_class c JOIN smig ON smig.oid = c.relnamespace
   WHERE NOT (c.relname IN ('schema_migrations', 'seed_files') OR (c.relkind = 'i' AND c.relname IN ('schema_migrations_pkey', 'seed_files_pkey')))
  UNION ALL SELECT 42, 'desconocido', 'en supabase_migrations, que no es del CLI', p.oid::regprocedure::text, NULL
    FROM pg_proc p JOIN smig ON smig.oid = p.pronamespace
  UNION ALL SELECT 43, 'desconocido', 'historia del CLI que no es de este árbol', h, NULL
    FROM unnest(xpath('//v/text()', query_to_xml('SELECT version AS v FROM supabase_migrations.schema_migrations', false, false, ''))::text[]) h, cfg
   WHERE to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AND NOT h = ANY (cfg.versiones)
  UNION ALL SELECT 44, 'desconocido', 'semillas del CLI', 'supabase_migrations.seed_files tiene filas', NULL
   WHERE to_regclass('supabase_migrations.seed_files') IS NOT NULL
     AND (xpath('//n/text()', query_to_xml('SELECT count(*) AS n FROM supabase_migrations.seed_files', false, false, '')))[1]::text <> '0'
  -- 6 · el permiso en auth que dio el alta, como supabase_admin
  UNION ALL SELECT 50, 'paso', 'rol', 'supabase_admin', 'RESET ROLE'
  UNION ALL SELECT 51, CASE WHEN a.grantor = 'supabase_admin'::regrole AND a.privilege_type = 'USAGE' THEN 'borra' ELSE 'desconocido' END,
         'permiso en el esquema auth', a.privilege_type || ' de ' || pg_get_userbyid(a.grantee) || ' (lo dio ' || pg_get_userbyid(a.grantor) || ')',
         CASE WHEN a.grantor = 'supabase_admin'::regrole AND a.privilege_type = 'USAGE'
              THEN format('REVOKE USAGE ON SCHEMA auth FROM %I', pg_get_userbyid(a.grantee)) END
    FROM acl_auth a WHERE a.grantee IN (SELECT oid FROM br)
  -- 7 · los roles: los de la cadena y el del alta, y nada que cuelgue de ellos fuera de lo de arriba
  UNION ALL SELECT 60, 'paso', 'rol', 'postgres', 'SET LOCAL ROLE postgres'
  UNION ALL SELECT 61, CASE WHEN r.rolname = ANY (cfg.roles) THEN 'borra' ELSE 'desconocido' END,
         CASE WHEN r.rolname = ANY (cfg.roles) THEN 'rol' ELSE 'rol bob* que la cadena no crea' END, r.rolname,
         CASE WHEN r.rolname = ANY (cfg.roles) THEN format('DROP ROLE %I', r.rolname) END FROM br r, cfg
  UNION ALL SELECT 62, 'desconocido', 'pertenencia', pg_get_userbyid(m.roleid) || ' → ' || pg_get_userbyid(m.member), NULL
    FROM pg_auth_members m
   WHERE (m.roleid IN (SELECT oid FROM br) OR m.member IN (SELECT oid FROM br))
     AND NOT (m.roleid IN (SELECT oid FROM br) AND m.member = 'postgres'::regrole AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option)
  UNION ALL SELECT 62, 'info', 'pertenencia', pg_get_userbyid(m.roleid) || ' → postgres (ADMIN, la de CREATE ROLE; se va con el rol)', NULL
    FROM pg_auth_members m
   WHERE m.roleid IN (SELECT oid FROM br) AND m.member = 'postgres'::regrole AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option
  UNION ALL SELECT 63, 'desconocido', 'ajuste de rol', coalesce(s.setrole::regrole::text, '-') || ': ' || array_to_string(s.setconfig, ','), NULL
    FROM pg_db_role_setting s WHERE s.setrole IN (SELECT oid FROM br)
  UNION ALL SELECT 64, 'desconocido', 'de ' || shd.rolname || ' (' || CASE shd.deptype WHEN 'o' THEN 'dueño' WHEN 'a' THEN 'permiso' ELSE 'política' END || ')',
         coalesce(shd.type || ' ' || shd.identity, shd.classid::regclass::text || ' ' || shd.objid), NULL
    FROM shd
   WHERE NOT (shd.dbid <> 0 AND (EXISTS (SELECT 1 FROM mapa m WHERE m.classid = shd.classid AND m.objid = shd.objid) OR shd.dentro))
     AND NOT (shd.deptype = 'a' AND shd.classid = 'pg_namespace'::regclass AND shd.objid IN ('public'::regnamespace, 'auth'::regnamespace))
  UNION ALL SELECT 65, 'desconocido', 'en otra base de datos', 'algo de ' || r.rolname || ' en la base ' || d.datname, NULL
    FROM pg_shdepend s JOIN br r ON r.oid = s.refobjid JOIN pg_database d ON d.oid = s.dbid
   WHERE s.dbid <> (SELECT oid FROM pg_database WHERE datname = current_database())
  UNION ALL SELECT 66, 'info', 'sesión abierta', usename || ' desde ' || coalesce(client_addr::text, 'local') || ' (se cierra al parar bob-web)', NULL
    FROM pg_stat_activity WHERE usename IN (SELECT rolname FROM br)
  UNION ALL SELECT 70, 'paso', 'rol', 'supabase_admin', 'RESET ROLE'
) i WHERE estado IS NOT NULL"

# La huella del plan: la calcula la base, igual en seco que dentro de la transacción. Sin las filas «info», que
# cambian al parar bob-web (las sesiones).
plan_huella() {  # <fuente>
  echo "SELECT md5(coalesce(string_agg(orden || '|' || estado || '|' || clase || '|' || identidad || '|' || coalesce(sentencia, ''), E'\\n'
                                  ORDER BY orden, clase, identidad), '')) FROM $1 plan WHERE estado <> 'info'"
}

# ── 1 · Mirar, sin escribir ───────────────────────────────────────────────────────────────────────────────────────
echo "== desinstalar BOb de $CAJA_ENSAYO ($MAQUINA), árbol $COMMIT (huella $INSTALADA)"
[ "$EJECUTAR" = 1 ] && echo "   con --ejecutar: después de enseñarlo, pide «$PALABRA»" || echo "   en seco: no escribe nada"
DESCONOCIDO=0
desconocido() { echo "  ⚠ no está en el mapa: $1"; DESCONOCIDO=$((DESCONOCIDO + 1)); }

# Ficheros. Nada de enlaces: un enlace no se sigue, se para.
FICHEROS=$TMP/ficheros; : > "$FICHEROS"
conocido_opt() {  # <ruta relativa a /opt/bob>
  local re='^[0-9a-f]{64}-[0-9a-f]{64}\.aprobacion(\.sig)?$'
  case "$1" in
    bin|bin/firma-instalacion|firmantes_instalacion|aprobaciones-revocadas|aprobaciones|instalacion-firmada|instalacion-firmada.nuevo) return 0 ;;
    instalacion-aprobacion|instalacion-aprobacion.nuevo|instalacion-en-curso|instalacion-en-curso.nuevo|hosts-permitidos|.instalando) return 0 ;;
    trabajo.*) return 0 ;;
    secrets|secrets/migrador.env|secrets/app.env|secrets/feeder.env|secrets/vecinos|secrets/vecinos/cliente.key|secrets/vecinos/cliente.crt|secrets/vecinos/ca.crt) return 0 ;;
    config|config/caja.env|deploy.sh|rollback.sh|lib.sh|fijos.sh|comprobar-aislamiento.sh|compose.yml|.env|.env.*) return 0 ;;
    entrega|entrega/??????|entrega/??????/imagen.tar|entrega/??????/atestacion|entrega/??????/atestacion.sig|entrega/??????/err.*) return 0 ;;
    atestaciones|atestaciones/bob-web-*.atestacion|atestaciones/bob-web-*.atestacion.sig|atestaciones/bob-feeder-*.atestacion|atestaciones/bob-feeder-*.atestacion.sig) return 0 ;;
    aprobaciones/*) [[ "${1#aprobaciones/}" =~ $re ]] ;;
    *) return 1 ;;
  esac
}
for d in "$OPT_BOB" "$ROOT_INSTALL"; do
  for x in "$(dirname "$d")"/."$(basename "$d")".desinstalando.*; do
    [ ! -e "$x" ] || desconocido "$x: lo dejó una corrida anterior de este guion; mirarlo antes de seguir"
  done
done
if [ -e "$OPT_BOB" ]; then
  [ -d "$OPT_BOB" ] && [ ! -L "$OPT_BOB" ] || desconocido "$OPT_BOB no es una carpeta"
  while IFS= read -r -d '' p; do
    rel=${p#"$OPT_BOB"/}
    case "$rel" in trabajo.*/*) continue ;; esac   # la copia del árbol que hace caja: se va con su carpeta
    if [ -L "$p" ]; then desconocido "$p es un enlace"
    elif conocido_opt "$rel"; then [ -d "$p" ] || echo "$p" >> "$FICHEROS"
    else desconocido "$p"; fi
  done < <(find "$OPT_BOB" -mindepth 1 -print0 | sort -z)
fi
if [ -e "$ROOT_INSTALL" ]; then
  [ -d "$ROOT_INSTALL" ] && [ ! -L "$ROOT_INSTALL" ] || desconocido "$ROOT_INSTALL no es una carpeta"
  while IFS= read -r -d '' p; do
    if [ "${p#"$ROOT_INSTALL"/}" = postgres.env ] && [ -f "$p" ] && [ ! -L "$p" ]; then echo "$p" >> "$FICHEROS"
    else desconocido "$p"; fi
  done < <(find "$ROOT_INSTALL" -mindepth 1 -print0 | sort -z)
fi
NFICH=$(grep -c . "$FICHEROS" || true)

# Docker: contenedores bob-* o del proyecto bob, y sus imágenes.
CONT=$TMP/contenedores; IMGS=$TMP/imagenes; ETQ=$TMP/etiquetas; : > "$CONT"; : > "$IMGS"; : > "$ETQ"
"$DOCKER" ps -a --format '{{.Names}}	{{.Label "com.docker.compose.project"}}' > "$TMP/ps" || no "docker ps falló"
while IFS=$'\t' read -r n proy; do
  [ -n "$n" ] || continue
  case "$n" in bob-*) ;; *) [ "$proy" = bob ] || continue ;; esac
  case "$n" in bob-web|bob-feeder) echo "$n" >> "$CONT" ;; *) desconocido "contenedor $n (proyecto ${proy:-ninguno})" ;; esac
done < "$TMP/ps"
leer_env() { [ -f "$OPT_BOB/.env" ] && sed -n "s/^$1=//p" "$OPT_BOB/.env" | tail -1 || true; }
{
  for k in BOB_WEB_IMAGEN BOB_WEB_IMAGEN_ANTERIOR BOB_FEEDER_IMAGEN BOB_FEEDER_IMAGEN_ANTERIOR; do leer_env "$k"; done
  while IFS= read -r n; do "$DOCKER" inspect -f '{{.Image}}' "$n" 2>/dev/null || true; done < "$CONT"
} | grep -E '^sha256:[0-9a-f]{64}$' | sort -u > "$TMP/ids" || true
while IFS= read -r id; do
  real=$("$DOCKER" image inspect -f '{{.Id}}' "$id" 2>/dev/null) || continue   # ya no está en el disco
  [ "$real" = "$id" ] || { desconocido "la imagen $id dice ser $real"; continue; }
  echo "$id" >> "$IMGS"
  for t in $("$DOCKER" image inspect -f '{{range .RepoTags}}{{.}} {{end}}' "$id"); do
    case "$t" in bob-web:*|bob-feeder:*) echo "$t" >> "$ETQ" ;; *) desconocido "la imagen $id lleva la etiqueta $t, que no es de BOb" ;; esac
  done
  while IFS= read -r usa; do
    [ -z "$usa" ] || grep -qxF "$usa" "$CONT" || desconocido "la imagen $id la usa también el contenedor $usa"
  done < <("$DOCKER" ps -a --filter "ancestor=$id" --format '{{.Names}}')
done < "$TMP/ids"

# G8: un hook activo de un contenedor que llama a una función de public que se va a borrar. Se mira el entorno de
# todos los contenedores, no una lista: cualquier variable cuyo valor sea pg-functions://<base>/public/<función> con
# una función que la cadena crea en public. Si la variable acaba en _URI, su <prefijo>_ENABLED decide; el hook solo
# cuenta como apagado con false o 0, escrito así. Lo demás, o sin _ENABLED, cuenta como activo (falla cerrado).
FPUB=$(tr ';' '\n' <<<"$firmas" | sed 's/(.*//' | sort -u)
HOOKS=0; : > "$TMP/hooks"
while IFS=$'\t' read -r n _p; do
  [ -n "$n" ] || continue
  envn=$("$DOCKER" inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$n" 2>/dev/null) || no "G8: no pude leer el entorno del contenedor $n: nada borrado"
  while IFS= read -r l; do
    [[ "$l" =~ ^([A-Za-z0-9_]+)=pg-functions://[^/]*/public/([A-Za-z0-9_]+)$ ]] || continue
    k=${BASH_REMATCH[1]}; fn=${BASH_REMATCH[2]}
    grep -qxF "$fn" <<<"$FPUB" || continue
    act=activo
    if [[ "$k" == *_URI ]]; then
      case "$(sed -n "s/^${k%_URI}_ENABLED=//p" <<<"$envn" | tail -1)" in false|0) act=apagado ;; esac
    fi
    if [ "$act" = apagado ]; then
      echo "  (info)   hook: $n tiene $k=…/public/$fn, apagado (${k%_URI}_ENABLED); la función se va igual" >> "$TMP/hooks"
    else
      echo "  ⚠ G8: $n llama a public.$fn ($k) y el hook está activo: borrarla deja sin token a todos los que entran por ese GoTrue" >> "$TMP/hooks"
      echo "    para seguir: ${k%_URI}_ENABLED=false en el compose de Bzzz que arranca $n, y recrearlo (docker compose up -d de ese servicio); para volver, true y lo mismo" >> "$TMP/hooks"
      HOOKS=$((HOOKS + 1))
    fi
  done <<<"$envn"
done < "$TMP/ps"

# La base, en una transacción de solo lectura.
psql_su > "$TMP/inventario" 2> "$TMP/inventario.err" <<SQL || { sed 's/^/  /' "$TMP/inventario.err" >&2; no "la base no deja empezar (lo de arriba): nada borrado"; }
BEGIN READ ONLY;
$G3
SELECT orden, estado, clase, identidad, coalesce(sentencia, '') FROM ($INVENTARIO) i ORDER BY orden, clase, identidad;
SELECT '#plan', ($(plan_huella "($INVENTARIO)"));
ROLLBACK;
SQL
PLAN_MD5=$(sed -n 's/^#plan\t\([0-9a-f]\{32\}\)$/\1/p' "$TMP/inventario")
[[ "$PLAN_MD5" =~ ^[0-9a-f]{32}$ ]] || no "no pude calcular la huella del plan"
sed -i.bak '/^#plan\t/d' "$TMP/inventario" && rm -f "$TMP/inventario.bak"
while IFS=$'\t' read -r _o est cl id _s; do
  [ "$est" = desconocido ] && desconocido "en la base: $cl: $id"
done < "$TMP/inventario"
psql_su > "$TMP/chequeo-antes" <<SQL || no "no pude correr la comprobación de la base vacía"
BEGIN READ ONLY;
$CHEQUEO;
ROLLBACK;
SQL

echo
echo "== Lo que borraría"
echo "-- Docker (B12)"
while IFS= read -r n; do echo "  contenedor $n"; done < "$CONT"
while IFS= read -r t; do echo "  etiqueta $t"; done < "$ETQ"
while IFS= read -r i; do echo "  imagen $i"; done < "$IMGS"
echo "-- Ficheros (B3, B4, B6, B8, B9, B12)"
while IFS= read -r f; do echo "  $f"; done < "$FICHEROS"
[ ! -d "$OPT_BOB" ] || echo "  y la carpeta $OPT_BOB entera"
[ ! -d "$ROOT_INSTALL" ] || echo "  y la carpeta $ROOT_INSTALL"
echo "-- La base (B5, B6, B7, B8, B8b), en una transacción"
cat "$TMP/hooks"
awk -F'\t' '$2 == "borra" || $2 == "cascada" { printf "  %-8s %s: %s\n", $2, $3, $4 } $2 == "info" { printf "  (info)   %s: %s\n", $3, $4 }' "$TMP/inventario"
NBASE=$(awk -F'\t' '$2 == "borra" || $2 == "cascada"' "$TMP/inventario" | wc -l | tr -d ' ')
echo
echo "== Cuenta: $(wc -l < "$CONT" | tr -d ' ') contenedor(es), $(wc -l < "$IMGS" | tr -d ' ') imagen(es) con $(wc -l < "$ETQ" | tr -d ' ') etiqueta(s), $NFICH fichero(s), $NBASE cosa(s) en la base:"
awk -F'\t' '$2 == "borra" || $2 == "cascada" { print $3 }' "$TMP/inventario" | sort | uniq -c | sed 's/^/  /'
echo "   La comprobación de la base vacía de \`cadena\` hoy encuentra $(grep -c . "$TMP/chequeo-antes" || true) rastro(s) de BOb; después tiene que encontrar 0."

bzzz() {
  cat <<'TXT'

== Lo que se queda en Bzzz (este guion no lo toca; lo deshace Henry con las herramientas de Bzzz, si quiere)
  B10  BZZZ_HOST_BOB en /opt/bzzz/compose/.env, la tarjeta del portal y la vuelta de la puerta. Febor no lo tiene
       antes de su puesta. Para quitarlo (runbook, C «Si falla el deploy»):
         sudo sed -i '/^BZZZ_HOST_BOB=/d' /opt/bzzz/compose/.env
         cd /opt/bzzz && scripts/generar-config-portal.sh '<dominio base de model-01>'; echo "rc=$?"
         cd /opt/bzzz && docker compose --env-file compose/.env -f compose/l6-portal.yml up -d
       Hasta que B10 vuelva a ponerlo, verify-deployment.sh ya no espera un BOb.
  B6   la red bzzz-vecina-bob y el pg_hba de las vecinas (pg_hba_vecinas.conf y conf.d/bzzz-vecinas.conf en el volumen
       de configuración de bzzz-supabase-db). Bzzz no tiene baja de una vecina; el alta los vuelve a encontrar y no
       los pisa. Se quedan: lo único que cambia en el ensayo es que en model-01 el alta saldrá 0, sin --reiniciar,
       y en Febor saldrá 3 la primera vez («escrito y NO activo») y pedirá --reiniciar [ventana].
  B8   el login de bob_app: no hace falta `generar-secretos-bob.sh --deshacer`; el rol y /opt/bob/secrets/app.env se van
       con este guion.
  B13  bzzz-vecinos encendido, su CA y su certificado de servidor (/opt/bzzz/secrets/vecinos-mtls). Es de Bzzz y
       Febor lo necesita igual: se queda. En model-01, B13 ya lo encontrará en marcha y no se repite.
  B1   Bzzz en main y lo que trajo (bob.conf, firmantes_imagen, los usuarios de ClickHouse de bzzz-vecinos): se queda.
  F-44 el TRUNCATE que se devuelve a anon y authenticated vale para toda tabla nueva de postgres en public, también
       las que Bzzz cree después: es el estado de antes de la puesta, y la cadena lo vuelve a quitar en B5.
  G8   si un GoTrue de Bzzz llama a una función de BOb en public (custom_access_token_hook), el guion se para antes de
       nada. Apagarlo es de Bzzz: <PREFIJO>_ENABLED=false en su compose y recrear el contenedor; volverlo a encender,
       true y lo mismo, después de reinstalar.
  A6/B3 en el home de bzzzops: entrega-bob/, bob-new/, bob-engine/ y bob-engine.bundle. Se quedan; A6 los vuelve a traer.
  B5   el USAGE en el esquema public de supabase_auth_admin. La cadena lo da (20260606120001, para el hook de BOb),
       pero Postgres lo apunta como concedido por pg_database_owner, igual que si lo hubiera dado Bzzz para su
       propio hook: no se sabe de quién es, y quitárselo a Bzzz rompería el login del portal. Se queda; la cadena
       lo vuelve a dar sin error. Solo si Henry comprueba que ningún hook de auth de Bzzz vive en public:
         sudo docker exec bzzz-supabase-db psql -U supabase_admin -d postgres -c 'REVOKE USAGE ON SCHEMA public FROM supabase_auth_admin'
TXT
}

if [ "$HOOKS" -gt 0 ]; then
  bzzz
  no "G8: $HOOKS hook(s) de auth activos llaman a una función que se borraría (las ⚠ de arriba): nada borrado; apágalos antes de seguir"
fi
if [ "$DESCONOCIDO" -gt 0 ]; then
  bzzz
  no "G7: $DESCONOCIDO cosa(s) que no están en el mapa (las ⚠ de arriba): no se borra nada; mirarlas antes de seguir"
fi
if [ "$EJECUTAR" != 1 ]; then
  bzzz
  echo
  echo "en-seco: nada escrito. Para hacerlo, la misma orden con --ejecutar."
  exit 0
fi

# ── 2 · Hacerlo ───────────────────────────────────────────────────────────────────────────────────────────────────
if [ -z "$PRUEBA" ]; then [ -t 0 ] || no "G4: la confirmación necesita una terminal"; fi
printf '\nEscribe «%s» para borrar BOb de %s: ' "$PALABRA" "$CAJA_ENSAYO"
read -r ans || ans=""
[ "$ans" = "$PALABRA" ] || no "G4: no confirmado: nada borrado"

# Parar bob-web (las sesiones de bob_app se cierran con él); se arranca otra vez si la base falla.
CORRIAN=$TMP/corrian; : > "$CORRIAN"
arrancar_otra_vez() {
  while IFS= read -r n; do "$DOCKER" start "$n" >/dev/null 2>&1 && echo "  arrancado otra vez: $n" || echo "  NO pude arrancar $n: docker start $n"; done < "$CORRIAN"
}
while IFS= read -r n; do
  [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$n" 2>/dev/null)" = true ] && echo "$n" >> "$CORRIAN"
  "$DOCKER" stop "$n" >/dev/null || { arrancar_otra_vez; no "no pude parar $n: nada borrado"; }
  echo "  parado: $n"
done < "$CONT"

# Las carpetas, a un lado: se borran después del COMMIT o vuelven a su sitio.
MOVIDAS=$TMP/movidas; : > "$MOVIDAS"
devolver() {
  while IFS=$'\t' read -r de a; do mv "$a" "$de" && echo "  devuelto: $de" || echo "  NO pude devolver $a a $de: mv $a $de"; done < "$MOVIDAS"
}
for d in "$OPT_BOB" "$ROOT_INSTALL"; do
  [ -e "$d" ] || continue
  a="$(dirname "$d")/.$(basename "$d").desinstalando.$$"
  mv "$d" "$a" || { devolver; arrancar_otra_vez; no "no pude apartar $d: nada borrado"; }
  printf '%s\t%s\n' "$d" "$a" >> "$MOVIDAS"
  echo "  apartado: $d"
done

# La base, en una transacción: G3 otra vez, el mismo plan, las sentencias, y la comprobación de la base vacía.
echo "== la base, en una transacción"
if ! psql_su > "$TMP/ejecucion" 2> "$TMP/ejecucion.err" <<SQL
BEGIN;
$G3
CREATE TEMP TABLE plan ON COMMIT DROP AS SELECT * FROM ($INVENTARIO) i;
DO \$\$ DECLARE x text; BEGIN
  SELECT string_agg(clase || ': ' || identidad, '; ') INTO x FROM plan WHERE estado = 'desconocido';
  IF x IS NOT NULL THEN RAISE EXCEPTION 'G7: no está en el mapa: %', x; END IF;
  SELECT string_agg(usename, ', ') INTO x FROM pg_stat_activity WHERE usename = 'bob' OR usename LIKE 'bob\_%';
  IF x IS NOT NULL THEN RAISE EXCEPTION 'sesiones abiertas de % con bob-web parado: de quién son, antes de seguir', x; END IF;
END \$\$;
SELECT CASE WHEN ($(plan_huella plan)) = '$PLAN_MD5' THEN 'el plan es el que se enseñó' END AS plan \gset
\if :{?plan}
\else
  SELECT 'la base cambió entre lo que se enseñó y ahora: nada borrado' AS error;
  ROLLBACK;
  \quit
\endif
SELECT sentencia FROM plan WHERE sentencia IS NOT NULL ORDER BY orden, clase, identidad \gexec
RESET ROLE;
DO \$\$ DECLARE x text; BEGIN
  SELECT string_agg(f, ', ') INTO x FROM ($CHEQUEO) c(f);
  IF x IS NOT NULL THEN RAISE EXCEPTION 'la comprobación de la base vacía aún encuentra: %: ROLLBACK, nada borrado', x; END IF;
END \$\$;
COMMIT;
SELECT 'commit';
SQL
then
  sed 's/^/  /' "$TMP/ejecucion.err" >&2
  devolver; arrancar_otra_vez
  no "la transacción de la base falló (lo de arriba): ROLLBACK; la caja queda como estaba"
fi
if ! grep -qx commit "$TMP/ejecucion"; then
  sed 's/^/  /' "$TMP/ejecucion" >&2
  devolver; arrancar_otra_vez
  no "la transacción no llegó al COMMIT (lo de arriba): la caja queda como estaba"
fi
echo "  COMMIT: $NBASE cosa(s) de la base borradas"
# La base ya no tiene BOb: si el guion muere desde aquí, las carpetas apartadas no deben volver a su sitio. Lo dice
# una marca en cada una, que la corrida siguiente lee antes de nada (y el README, a quien recupere a mano).
while IFS=$'\t' read -r de a; do
  printf 'la base se vació (COMMIT) %s; %s no se devuelve: se borra\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$de" > "$a/$MARCA_VACIADA" \
    || echo "  NO pude marcar $a: si este guion muere antes de borrarla, NO la devuelvas a $de (la base ya está vacía)"
done < "$MOVIDAS"

# Después del COMMIT: lo que no tiene vuelta.
FALLOS=0
while IFS= read -r n; do "$DOCKER" rm -f "$n" >/dev/null && echo "  borrado el contenedor $n" || { echo "  NO pude borrar el contenedor $n: docker rm -f $n"; FALLOS=$((FALLOS + 1)); }; done < "$CONT"
while IFS= read -r t; do "$DOCKER" image rm "$t" >/dev/null && echo "  quitada la etiqueta $t" || { echo "  NO pude quitar $t: docker image rm $t"; FALLOS=$((FALLOS + 1)); }; done < "$ETQ"
while IFS= read -r i; do
  "$DOCKER" image inspect "$i" >/dev/null 2>&1 || { echo "  la imagen $i ya no está"; continue; }
  "$DOCKER" image rm "$i" >/dev/null && echo "  borrada la imagen $i" || { echo "  NO pude borrar la imagen $i: docker image rm $i"; FALLOS=$((FALLOS + 1)); }
done < "$IMGS"
while IFS=$'\t' read -r de a; do
  "${RMF[@]}" "$a" && echo "  borrada la carpeta $de" || { echo "  NO pude borrar $a (era $de): ${RMF[*]} $a"; FALLOS=$((FALLOS + 1)); }
done < "$MOVIDAS"

# La comprobación final, otra vez y en una sesión nueva: la de `cadena` desde la base vacía.
psql_su > "$TMP/chequeo" <<SQL || no "no pude correr la comprobación final"
BEGIN READ ONLY;
$CHEQUEO;
ROLLBACK;
SQL
if grep -q . "$TMP/chequeo"; then
  sed 's/^/  /' "$TMP/chequeo"
  no "la comprobación de la base vacía encuentra $(grep -c . "$TMP/chequeo") rastro(s) de BOb después del COMMIT"
fi
echo "== base vacía: la comprobación de \`cadena\` (instalar-bob.sh, BOB_BASE_VACIA=1) no encuentra nada: sin esquema bob, sin historia del CLI de la cadena, sin roles bob*"
bzzz
echo
[ "$FALLOS" = 0 ] || no "$FALLOS cosa(s) de Docker o de ficheros no se pudieron borrar (las órdenes están arriba); la base ya está vacía"
echo "desinstalado: $CAJA_ENSAYO no tiene BOb. Siguiente: B3 con la base vacía (firma-instalacion vacia) y B5 con la aprobación e3b0c442…-544fe970…"
