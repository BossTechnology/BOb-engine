# F-58 · Paso REVOKE aparte

Henry, 27 nov: «Paso REVOKE aparte», «00f79b7 + REVOKE». La caja instala el
commit firmado `00f79b7` tal cual. Este paso corre **una vez, a mano, justo
después**. Les quita a los roles de la aplicación todo privilegio sobre las
tablas de `bob` que no sea SELECT, INSERT, UPDATE o DELETE: TRIGGER,
REFERENCES, TRUNCATE, MAINTAIN y cualquier otro que aparezca en el ACL. Esos
cuatro quedan exactamente como estaban, y el viewer sigue leyendo lo mismo.

**Por qué.** Las tablas de `bob` se crearon en `public`. Ahí, los privilegios
por defecto de Supabase les dan `arwdDxtm` a `anon`, `authenticated` y
`service_role` (en la imagen de la caja, Postgres 17.6; `m` es MAINTAIN). Las
tablas se movieron a `bob` con ese ACL. Con TRIGGER, un miembro de un tenant
puede colgar un trigger de `bob.alert_log` y tumbar cada inserción posterior,
de todos los tenants. Con MAINTAIN puede bloquear la tabla.

**Qué no es.** No es una migración y no está en la cadena de instalación:
`supabase/provision/install-chain.sha256` no cambia. No toca `00f79b7` ni su
firma. No incluye nada del Slice 5. El arreglo definitivo es la migración
`20261127110000` del PR #66, que entra cuando se firme la cadena siguiente.
Correr este paso y después esa migración no es problema: los dos son
idempotentes.

**Quién lo corre.** Henry, en Febor. Los agentes, solo en los ensayos de
lab-02 y model-01, que están en `00f79b7`.

## Con qué rol, y por qué

Con **`bob_migrador`**, nunca con `postgres` ni con la service role.

- Después del alta, `bob_migrador` es el dueño del esquema `bob` y de sus
  tablas, y figura como otorgante de esos privilegios en el ACL
  (`authenticated=arwdDxtm/bob_migrador`).
- Un REVOKE solo quita lo que otorgó quien lo corre (o un miembro del dueño).
- En la imagen de Supabase, `postgres` no es superusuario ni miembro de
  `bob_migrador`. Su REVOKE solo avisaría, y la comprobación final fallaría.
- `bob_migrador` es además el rol con menos poder que puede hacerlo, y el
  mismo que ya usa `instalar-bob.sh resto`, con sus credenciales del alta
  (`/opt/bob/secrets/migrador.env`).

El SQL se niega si quien lo corre no es dueño de `bob`, y dice quién lo es. El
wrapper se niega con la service role o con un rol `bob_*`.

## Archivos

- `revocar.sql`: corre en una sola transacción y no lleva ninguna tabla ni
  ningún privilegio escrito a mano, solo los roles de la aplicación que el
  servidor tenga. Las relaciones salen de `pg_class` y los privilegios del ACL
  (`aclexplode`). Revoca a nivel de tabla y de columna. Al final comprueba dos
  cosas, y si alguna falla lanza un error y no cambia nada:
  - que no quede nada (`has_table_privilege`, el ACL y
    `has_any_column_privilege`);
  - que SELECT, INSERT, UPDATE y DELETE de todos esos roles sean los mismos
    que antes.
- `revocar.sh`: corre el SQL como `bob_migrador`.
  - La clave va en un pgpass, en un directorio privado en tmpfs
    (`$XDG_RUNTIME_DIR` o `/dev/shm`), que se borra al terminar. Si no hay
    tmpfs, para en vez de escribir la clave en disco.
  - Solo manda la clave a loopback o a un host de `/opt/bob/hosts-permitidos`,
    y solo con SCRAM (`PGREQUIREAUTH`), en las dos ramas.
  - Se niega a correr si él mismo, el SQL o su directorio los puede escribir
    alguien que no sea quien lo corre. Como root, corre solo copias de root.
  - Si el alta dejó `MIGRADOR_RED`, corre psql en un contenedor de la imagen
    de la base, en esa red, como `instalar-bob.sh`.
  - Devuelve 0 si quedó bien, 3 si quedó algo (el error de psql) y 2 si se
    negó a correr.

## Cómo correrlo en la caja: un solo comando

Justo después de que `caja` termine `resto` sobre `00f79b7`. Se corre desde la
copia del motor que la caja ya tiene, `~/bob-engine`, sin `scp` y sin `/tmp`.
`<commit>` es el head del PR #67, o el de `main` cuando se fusione.

```bash
cd ~/bob-engine && git fetch -q origin && git checkout -q --detach <commit> && sudo install -d -o root -g root -m 700 /root/f58 && sudo install -o root -g root -m 755 scripts/f58/revocar.sh scripts/f58/revocar.sql /root/f58/ && sudo bash /root/f58/revocar.sh
```

- **Qué ejecuta root.** Root solo ejecuta copias suyas: `install -o root` las
  deja en `/root/f58`, de root y con modo 700. Es lo mismo que hace el
  instalador del desinstalador. El wrapper vuelve a comprobarlo y se niega si
  algo de eso lo puede escribir otro.
- **Qué no toca.** Nada de `/opt/bob`, así que la huella de lo instalado no
  cambia. `caja` lee el commit del repositorio, no el árbol de trabajo.
- **Si `git checkout` se niega por cambios locales en `~/bob-engine`,** parar y
  avisar. No forzar.
- **Por qué `sudo`.** Hace falta para leer `/opt/bob/secrets/migrador.env`.

## Salida esperada

```
F-58: revoking every privilege but SELECT, INSERT, UPDATE and DELETE on bob as bob_migrador@<host>:5432
psql:…/revocar.sql:…: NOTICE:  F-58 before: N grants beyond SELECT, INSERT, UPDATE and DELETE held by application roles
psql:…/revocar.sql:…: NOTICE:  F-58 after: 0 grants left on M relations of bob; SELECT, INSERT, UPDATE and DELETE unchanged. OK
psql:…/revocar.sql:…: NOTICE:  F-58 default privileges: none beyond SELECT, INSERT, UPDATE and DELETE for new tables in bob
F-58: done
```

Código de salida 0. En una caja recién instalada desde `00f79b7`, N es mayor
que cero y M ronda las 48 relaciones. En un stack local (Postgres 15)
instalado desde `00f79b7`, N es 56: TRIGGER y REFERENCES en 28 tablas para
`authenticated`. En la imagen de la caja se suman MAINTAIN y, si sigue ahí,
TRUNCATE. Una segunda corrida dice `before: 0` y termina igual: no cambia
nada.

## Cómo comprobar que quedó

Hay dos formas:
- correrlo otra vez: tiene que decir `F-58 before: 0 grants` y salir con 0;
- como dueño de `bob`, correr esta consulta: tiene que devolver 0 filas.

```sql
SELECT c.relname, coalesce(r.rolname, 'PUBLIC') AS rol, a.privilege_type
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob',
       aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
 WHERE a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
   AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role', 'bob_app', 'bob_feeder', 'bob_ai_ro'));
```

## Si falla

Un fallo no cambia nada: la transacción vuelve atrás entera. La caja queda
como la dejó la instalación, que funciona; lo que sigue abierto es el
hallazgo F-58. No reintentar en bucle.

- **`run as the owner of schema bob (…), not as …`**: `MIGRADOR_USUARIO` no es
  el dueño de `bob`. Revisar `/opt/bob/secrets/migrador.env`, y no correrlo
  con otra cuenta.
- **`refused: … is not the owner of bob`**: el env apunta a un rol de la
  aplicación o a la service role. Se resuelve igual que el anterior.
- **`MIGRADOR_HOST … is not permitted`**: el host no es loopback ni está en
  `/opt/bob/hosts-permitidos`. Es la misma regla que en la instalación; no
  editar esa lista para esto.
- **`F-58: still held after the revoke: <rol> <privilegio> <tabla>`**: alguien
  que no es el dueño otorgó ese privilegio (otro otorgante), y el REVOKE del
  dueño no lo alcanza. Anotar la línea completa y avisar en el hilo de Febor
  antes de tocar nada. Quitarlo exige saber quién lo otorgó (el otorgante en
  `pg_class.relacl`) y revocarlo como ese rol. No se improvisa en la ventana.
- **`F-58: SELECT, INSERT, UPDATE or DELETE changed: …`**: no debería pasar
  nunca, porque el paso no toca esos cuatro. Es la red que protege al viewer.
  Anotar la línea y avisar.
- **`schema bob holds no relation: nothing was checked`**: `bob` existe pero
  está vacío. No es la base instalada, o la instalación no terminó. No
  significa «0 privilegios»: revisar que `caja` haya terminado `resto`.
- **`MIGRADOR_HOST … is not permitted`**, **`no tmpfs for the password file`**
  o **`… is writable by someone other than uid …`**: el wrapper se negó antes
  de mandar la clave, y no cambió nada. Revisar el env, el tmpfs o la forma de
  instalar los archivos (el comando de arriba, tal cual).
- **`WARNING: F-58 default privileges: … gives … on new tables …`**: no es un
  fallo, porque el paso termina con 0 y quitó lo que hay. Avisa que las tablas
  que se creen después en `bob` traerían esos privilegios. Anotar la línea y
  avisar a Henry; la próxima migración lo decide.
- **`there is no schema bob here`** o un error de conexión: la caja no tiene
  BOb instalado, o el host o el puerto no son los de su base. Revisar que
  `caja` haya terminado `resto`.

## Probado

`tests/slice2-schema.test.mjs`, bloque «F-58 · the separate REVOKE step»,
corre con el wrapper contra un stack instalado desde `00f79b7` y contra
`main`. Comprueba ocho cosas:
- Antes de correr el paso, los roles de la aplicación tienen privilegios de
  más: TRIGGER, REFERENCES y TRUNCATE, uno de columna, y MAINTAIN en 17.
  Después no queda ninguno, y una segunda corrida no hace nada.
- El viewer sigue leyendo. SELECT, INSERT, UPDATE y DELETE de cada rol sobre
  cada relación quedan iguales. También es igual lo que lee un miembro
  (`authenticated`, como admin y como viewer) en toda relación que puede leer,
  con su número de filas.
- Un privilegio de otro otorgante hace fallar el paso, sin cambiar nada.
- Se niega a correr como la service role.
- Se niega a mandar la clave a un host no permitido. Exige SCRAM y deja el
  pgpass en tmpfs con modo 700; sin tmpfs, para.
- Se niega si el SQL, el wrapper o su directorio los puede escribir otro.
- Un `bob` sin relaciones es un fallo.
- Avisa de privilegios por defecto que darían TRIGGER o REFERENCES en tablas
  nuevas de `bob`.

Cada test se vio fallar una vez con un sabotaje:
- el SQL revocaba también SELECT, con su red apagada;
- el SQL dejaba TRUNCATE;
- el wrapper sin control de host, sin SCRAM, con el pgpass en el disco o sin
  control de quién puede escribir los archivos;
- el SQL sin la parada por un `bob` vacío, o sin el aviso de privilegios por
  defecto.

Además se corrió a mano en la imagen de la caja (`supabase/postgres:17.6.1.136`)
como `bob_migrador`, sobre tablas con el ACL que deja Supabase (`arwdDxtm`):
- quedó `arwd` para `anon`, `authenticated` y `service_role`;
- se fue la REFERENCES de columna;
- la segunda corrida dijo `before: 0`.
