# Ensayo de la primera puesta: desinstalar BOb de model-01

`desinstalar-bob.sh` deja model-01 **sin BOb**, como estaba antes de su primera puesta. Así se puede ensayar ahí
el camino exacto de Febor: base vacía → huella `544fe970…` (motor `00f79b7`) en un solo salto, con la aprobación
`e3b0c442…-544fe970…`. model-01 llegó a esa huella en dos saltos (vacía → `2be50c17…` → `544fe970…`); Febor
irá en uno.

No es parte de la instalación. Nada de la cadena firmada lo nombra y solo corre en model-01. Lo corre Henry, a
mano, como root. Ninguna IA lo corre contra una caja.

## Órdenes

En model-01, desde una copia de root del guion, no desde un clon que otro pueda escribir:

```bash
sudo install -o root -g root -m 755 scripts/ensayo/desinstalar-bob.sh /root/desinstalar-bob.sh
```

En seco: lee la base en una transacción `READ ONLY`, lista ficheros y Docker, y no escribe nada.

```bash
sudo /root/desinstalar-bob.sh --caja model-01 --motor /home/bzzzops/bob-engine 00f79b7<resto del sha>
```

Para hacerlo, la misma orden con `--ejecutar`. Enseña lo mismo y pide escribir `desinstalo` en la terminal.

```bash
sudo /root/desinstalar-bob.sh --caja model-01 --motor /home/bzzzops/bob-engine 00f79b7<resto del sha> --ejecutar
```

Dos argumentos:

- `--motor`: un clon de BOb-engine que tenga el commit.
- El commit instalado, con su sha entero (`git rev-parse 00f79b7`). Su huella (`/opt/bob/bin/firma-instalacion
  huella`) tiene que ser la de `/opt/bob/instalacion-firmada`. Las migraciones de ese commit, leídas de sus
  objetos de git, son el mapa de lo que la cadena creó.

Salida:

- `0`: hecho; en seco, nada impide hacerlo.
- `1`: una guarda o una comprobación lo paró, o algo falló. Lo dice la última línea.
- `2`: uso.

## El mapa: lo que crea la primera puesta

Las fuentes son el runbook `PRIMERA-PUESTA-FEBOR.md` de Bob-New en `7f805eb` (B2 a B14), `firma-instalacion.sh`,
`supabase/provision` y las migraciones. Lo de la base se midió contra el catálogo: una pila 17.6.1.136 limpia
frente a la misma con BOb instalado como lo instala una caja. El guion lo deshace en orden inverso.

| Paso | Qué deja | Lo deshace el guion |
|---|---|---|
| B12 | El contenedor `bob-web` (proyecto de compose `bob`), sus imágenes (`BOB_WEB_IMAGEN` y `BOB_WEB_IMAGEN_ANTERIOR` de `/opt/bob/.env`, más la del contenedor) y sus etiquetas `bob-web:*`. Las rutas de Traefik son etiquetas del contenedor. | `docker stop`; después del COMMIT, `docker rm -f`, `docker image rm` de las etiquetas y de los ids. |
| B12 | `/opt/bob/entrega/XXXXXX/` (`imagen.tar`, `atestacion`, `atestacion.sig`, `err.*`) y `/opt/bob/atestaciones/bob-web-*.atestacion(.sig)`. | Se va con `/opt/bob`. |
| B9 | `/opt/bob/.env`, `config/caja.env`, `deploy.sh`, `rollback.sh`, `lib.sh`, `fijos.sh`, `comprobar-aislamiento.sh`, `compose.yml`. | Se va con `/opt/bob`. |
| B8 | `bob_app` con LOGIN y contraseña; `/opt/bob/secrets/app.env`. | `DROP ROLE bob_app`; el fichero se va con `/opt/bob`. |
| B8b | La organización `modelo` en `bob.organizations`. | Se va con `DROP SCHEMA bob CASCADE`. |
| B7 | Las migraciones de después de la cadena, en `bob` y en `bob.schema_migrations`. | Con el esquema. |
| B6 | El alta de Bzzz: `bob_migrador` (LOGIN, contraseña), dueño de `bob`; `GRANT USAGE ON SCHEMA auth TO bob_migrador` (lo da `supabase_admin`); `/opt/bob/secrets/migrador.env`. | `REVOKE USAGE ON SCHEMA auth FROM bob_migrador` (como `supabase_admin`), `DROP ROLE bob_migrador`. |
| B5 | La cadena (33 migraciones) como `postgres`: el esquema `bob` y todo lo suyo; `bob_app`, `bob_feeder` y `bob_ai_ro`, cada uno con su fila de ADMIN para `postgres` (16+); 25 funciones en `public` de `postgres` (`bob_*`, `update_updated_at`, `cap_alert_log`, `enforce_slug_immutability`, `custom_access_token_hook`); `USAGE` en `public` para `bob_app`, `bob_feeder` y `bob_ai_ro`, y para `supabase_auth_admin` (este se queda: ver abajo); el TRUNCATE que `20261121170000` quitó a `anon` y `authenticated` en los privilegios por defecto de `postgres` en `public`; cuatro tablas de `bob` en la publicación `supabase_realtime`; el esquema `supabase_migrations` con la historia del CLI, que antes no existía. | `DROP SCHEMA bob CASCADE` (con el dueño de `bob`), `DROP FUNCTION … RESTRICT` de las de `public`, `REVOKE USAGE ON SCHEMA public FROM …`, `ALTER DEFAULT PRIVILEGES … GRANT TRUNCATE ON TABLES TO anon, authenticated`, `DROP SCHEMA supabase_migrations CASCADE`, `DROP ROLE` de los tres. La publicación sigue: solo pierde las tablas de `bob`. |
| B4 | `/root/bob-install/postgres.env`, si B14 no lo quitó, y la carpeta. | La quita. |
| B3 | `/opt/bob/bin/firma-instalacion`, `firmantes_instalacion`, `aprobaciones-revocadas`, `aprobaciones/`, `instalacion-firmada`, `instalacion-aprobacion`, `instalacion-en-curso`, `hosts-permitidos`, `.instalando`, `trabajo.*`. Antes de la primera puesta `/opt/bob` no existía. | Quita `/opt/bob` entero. |

En `auth` no hay nada que quitar. La cadena no crea usuarios ni claims. El disparador `on_auth_user_created` lo
crea `20260606120000` y lo quita `20261121130000`; si siguiera, el guion lo vería y se pararía. B8 solo da LOGIN,
y las cuentas de BzzzBX con las que se entra en B13 son de Bzzz y se quedan. `public.bob_outbox_drain` se va con
la cascada del esquema `bob` (F-47).

La base va en **una sola transacción**. Se entra como `supabase_admin`, igual que el alta (`docker exec
bzzz-supabase-db psql -U supabase_admin`, sin contraseña). Todo, salvo un REVOKE, corre con `SET LOCAL ROLE
postgres` o con el dueño de `bob`. Ese REVOKE es el del `USAGE` en `auth`: solo quien lo concedió puede quitarlo.
Como `postgres`, el REVOKE no quita nada y `DROP ROLE bob_migrador` falla; `DROP OWNED` tampoco lo quita. No es la
service role.

## Las guardas

Todas fallan cerradas, y `tests/ensayo-desinstalar.test.mjs` ve cada una negarse:

- **G1**: `--caja model-01`, escrito así.
- **G2**: el nombre de la máquina (`uname -n`) contiene `model-01`.
- **G3**: `bob.organizations` tiene una sola fila, y su slug es `modelo`. Se comprueba en seco y otra vez dentro de
  la transacción.
- **G4**: con `--ejecutar`, escribir `desinstalo` en una terminal.
- **G5**: nunca la service role. Con una variable de entorno que la nombre, no empieza. En la base solo se entra
  como `supabase_admin`, que baja con `SET ROLE`.
- **G6**: nunca toca lo que la puesta no creó: el `auth` de Bzzz, otros esquemas, otras vecinas como `opsrun`. Si
  algo de fuera depende de lo que se va a borrar (una vista sobre `bob` o sobre la historia del CLI,
  `supabase_migrations`, por ejemplo), se para: los dos esquemas se borran con CASCADE.
- **G7**: si encuentra algo que no está en el mapa, lo dice y se para en vez de borrarlo. Puede ser:
  - un fichero de `/opt/bob` o de `/root/bob-install` que no es de la puesta;
  - un enlace;
  - un contenedor `bob-*` o una etiqueta que no conoce;
  - una imagen que usa otro contenedor;
  - un rol `bob*` que la cadena no crea;
  - un permiso, una propiedad o un ajuste de un rol `bob*` fuera de lo suyo;
  - una pertenencia que no es la de ADMIN de `CREATE ROLE`;
  - un objeto con nombre de BOb fuera de `bob`, salvo las funciones de `postgres` en `public` con la firma exacta
    que crea la cadena: otra sobrecarga con el mismo nombre no es suya;
  - una versión del historial del CLI que no es de este árbol;
  - otra base de datos con cosas de `bob*`.

Además:

- La huella del commit tiene que ser la de `instalacion-firmada`.
- Lo que se ejecuta es lo que se enseñó: la transacción rehace el plan y compara su md5; si la base cambió, ROLLBACK.
- No puede quedar abierta una sesión de un rol `bob*` con `bob-web` parado.
- Antes del COMMIT, y otra vez después en una sesión nueva, la comprobación de la base vacía de
  `scripts/instalar-bob.sh cadena` con `BOB_BASE_VACIA=1` tiene que no encontrar nada: ni esquema `bob`, ni
  historial del CLI de la cadena, ni roles `bob*`. El guion lo dice:
  `== base vacía: la comprobación de \`cadena\` … no encuentra nada`.

## Si falla a medias

Antes de la transacción, el guion para `bob-web` y mueve `/opt/bob` y `/root/bob-install` a un lado
(`/opt/.bob.desinstalando.<pid>`, `/root/.bob-install.desinstalando.<pid>`), sin borrarlos. Si la transacción
falla, vuelven a su sitio y `bob-web` arranca otra vez: la caja queda como estaba, y el guion lo dice («la caja
queda como estaba»). Solo después del COMMIT borra el contenedor, las imágenes y las dos carpetas.

Si el guion muere a la fuerza (un corte de luz, un `kill -9`) con las carpetas `.desinstalando.*` todavía ahí, lo
primero es saber si la transacción llegó al COMMIT. **No las devuelvas sin mirar**: si la base ya está vacía,
devolver `/opt/bob` dejaría `instalacion-firmada` diciendo `544fe970…` sobre una base sin BOb.

**Antes de mirar nada, espera a que no quede nada del guion corriendo.** Un `kill -9` mata a bash, pero su hijo
`psql` (el `docker exec … psql`) puede seguir vivo dentro de la transacción y hacer COMMIT después. Si miraras
antes, leerías «la base no cambió» y luego cambiaría. Cada sesión del guion en la base se llama `desinstalar-bob`
(`application_name`). Las dos órdenes tienen que no devolver nada; si devuelven algo, espera y vuelve a mirar:

```bash
pgrep -af 'docker exec -i -e PGAPPNAME=desinstalar-bob'
```

```bash
sudo docker exec bzzz-supabase-db psql -X -A -t -U supabase_admin -d postgres -c "SELECT pid, state, xact_start, wait_event FROM pg_stat_activity WHERE application_name = 'desinstalar-bob'"
```

Si una sesión sigue ahí, colgada sin avanzar, se puede cortar. `pg_terminate_backend` hace ROLLBACK de lo que no
llegó al COMMIT, y lo que ya llegó, queda. Después de cortarla, se mira igual que siempre:

```bash
sudo docker exec bzzz-supabase-db psql -X -A -t -U supabase_admin -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'desinstalar-bob'"
```

Cuando no quede nada, mira la marca y la base. Justo después del COMMIT, el guion deja una marca `BASE-YA-VACIADA`
en cada carpeta apartada. Y la base lo dice ella misma: si `bob` ya no existe, el COMMIT pasó.

```bash
ls /opt/.bob.desinstalando.*/BASE-YA-VACIADA /root/.bob-install.desinstalando.*/BASE-YA-VACIADA
```

```bash
sudo docker exec bzzz-supabase-db psql -X -A -t -U supabase_admin -d postgres -c "SELECT to_regnamespace('bob') IS NULL AS base_vaciada"
```

- **Sin marca y `base_vaciada` es `f`**: la transacción no llegó al COMMIT y la base no cambió. Se devuelven:

  ```bash
  sudo mv /opt/.bob.desinstalando.<pid> /opt/bob
  ```

  ```bash
  sudo mv /root/.bob-install.desinstalando.<pid> /root/bob-install
  ```

  ```bash
  sudo docker start bob-web
  ```

- **Con marca, o `base_vaciada` es `t`**: la base ya está vacía. Las carpetas no se devuelven, se borran. Después
  se quitan `bob-web` y sus imágenes (las órdenes que el guion imprimió en seco), y se sigue con B3 desde la base
  vacía:

  ```bash
  sudo rm -rf --one-file-system /opt/.bob.desinstalando.<pid> /root/.bob-install.desinstalando.<pid>
  ```

Mientras queden carpetas `.desinstalando.*`, una corrida nueva se para en vez de pisarlas. Si llevan la marca, dice
que la base ya se vació y que se borren.

## Lo que se queda en Bzzz

El guion no lo toca, y lo imprime al final. Lo deshace Henry con las herramientas de Bzzz, si quiere. Bzzz no tiene
baja de una vecina, y aquí no se reimplementa.

- **B10**: `BZZZ_HOST_BOB` en `/opt/bzzz/compose/.env`, la tarjeta del portal y la vuelta de la puerta. Febor no lo
  tiene antes de su puesta. Para quitarlo (runbook, C «Si falla el deploy»):
  ```bash
  sudo sed -i '/^BZZZ_HOST_BOB=/d' /opt/bzzz/compose/.env
  ```
  ```bash
  cd /opt/bzzz && scripts/generar-config-portal.sh '<dominio base de model-01>'; echo "rc=$?"
  ```
  ```bash
  cd /opt/bzzz && docker compose --env-file compose/.env -f compose/l6-portal.yml up -d
  ```
  Hasta que B10 vuelva a ponerlo, `verify-deployment.sh` ya no espera un BOb.
- **B6**: la red `bzzz-vecina-bob` y el pg_hba de las vecinas (`pg_hba_vecinas.conf` y `conf.d/bzzz-vecinas.conf`
  en el volumen de configuración de `bzzz-supabase-db`). No hay herramienta de Bzzz que los quite, y el alta los
  vuelve a encontrar sin pisarlos. Se quedan. Por eso el ensayo no es idéntico a Febor en este paso: en model-01 el
  alta sale 0 sin `--reiniciar`, y en Febor sale 3 la primera vez («escrito y NO activo») y pide
  `--reiniciar [ventana]`.
- **B8**: no hace falta `generar-secretos-bob.sh --deshacer`: el rol `bob_app` y `/opt/bob/secrets/app.env` se van
  con el guion.
- **B13**: `bzzz-vecinos` encendido, su CA y su certificado de servidor (`/opt/bzzz/secrets/vecinos-mtls`). Son de
  Bzzz y Febor los necesita igual. En model-01, B13 ya los encontrará en marcha.
- **B5, el `USAGE` en `public` de `supabase_auth_admin`**: la cadena lo da (`20260606120001`, para el hook de BOb).
  Pero Postgres apunta como concedente a `pg_database_owner` lo dé quien lo dé, así que no se distingue del que
  Bzzz pudiera dar para un hook de auth propio. Quitárselo a Bzzz rompería el login del portal. Se queda, y la
  cadena lo vuelve a dar sin error. Solo si Henry comprueba que ningún hook de auth de Bzzz vive en `public`:
  ```bash
  sudo docker exec bzzz-supabase-db psql -U supabase_admin -d postgres -c 'REVOKE USAGE ON SCHEMA public FROM supabase_auth_admin'
  ```
- **B1**: Bzzz en `main` y lo que trajo (`bob.conf`, `firmantes_imagen`, los usuarios de ClickHouse de
  `bzzz-vecinos`). Se queda.
- **A6/B3**: en el home de `bzzzops`, `entrega-bob/`, `bob-new/`, `bob-engine/` y `bob-engine.bundle`. Se quedan;
  A6 los vuelve a traer.

## Cómo devolver model-01 si el ensayo sale mal

model-01 es la caja de pruebas: lo único que se pierde es la organización `modelo` y los datos inventados. Ninguno
es de un cliente.

- **Si el guion se para antes del COMMIT** (y no lo mataron: ver «Si falla a medias»), no hay nada que devolver: la caja sigue con BOb en `544fe970…` y
  `bob-web` vuelve a correr. Lo que lo paró está en la última línea.
- **Si el guion terminó**, la base está vacía. Para volver a tener BOb, se sigue el runbook desde B3 con la base
  vacía, que es justamente el ensayo:
  - B3: `firma-instalacion vacia` en `instalacion-firmada`;
  - B4: `postgres.env`;
  - B5: `cadena` con la aprobación `e3b0c442…-544fe970…`;
  - B6: el alta (en model-01 sale 0);
  - B7: `resto`;
  - B8: el login de `bob_app`;
  - B8b: la organización `modelo`, en `enterprise`;
  - B9 y B10: configuración y `BZZZ_HOST_BOB`;
  - B12: el deploy de `bob-web` desde Bob-New `7f805eb`;
  - B13: la entrada.
- **Si el ensayo de la puesta falla a mitad de B5**, la base queda con la cadena a medias. Se sigue el runbook: el
  reintento de `cadena` desde la base vacía es `BOB_BASE_VACIA=reanuda`, con la marca `instalacion-en-curso` que
  dejó `caja`. Este guion no sirve para eso: pide una caja con BOb entero (la huella de `instalacion-firmada`, que
  ahí es la base vacía, y la organización `modelo`), y se niega.

## La prueba

`tests/ensayo-desinstalar.test.mjs` corre en su propio job de CI, «Uninstall rehearsal on the box image
(model-01)». Usa la imagen de la caja (17.6.1.136) y una base sin BOb. Ahí planta cosas de Bzzz (otra vecina
`opsrun`, una cuenta en `auth`, una tabla y una función en `public`), instala BOb como una caja, y monta un
`/opt/bob`, un `/root/bob-install` y un Docker falso (`tests/helpers/docker-falso.sh`) con la forma de model-01.
Después comprueba:

- Cada guarda se niega, y no cambia nada: el catálogo, los ficheros, Docker (que solo se lee).
- En seco no escribe nada.
- Si la base cambia mientras espera la palabra, hay ROLLBACK, y las carpetas y `bob-web` vuelven.
- Con `--ejecutar`, el catálogo es el de antes de la puesta, línea por línea, y lo de Bzzz sigue.
- `instalar-bob.sh cadena` desde la base vacía la acepta, y la instalación entera vuelve a correr encima.

El modo de prueba (`DESINSTALAR_PRUEBA_*`) nunca corre como root ni en una máquina con `/opt/bzzz`. Además, pide
una marca en su raíz: un `DESINSTALAR_PRUEBA_RAIZ` olvidado en una caja no apaga nada.

En local, contra una base sin BOb en la imagen de la caja:

```bash
DESINSTALAR_DB_URL=postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres BOB_DESINSTALAR_REQUIRED=1 node --test --test-concurrency=1 tests/ensayo-desinstalar.test.mjs
```
