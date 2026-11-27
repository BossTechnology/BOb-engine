# F-58 · Paso REVOKE aparte

Henry, 27 nov: «Paso REVOKE aparte». La caja instala el commit firmado `00f79b7`
tal cual. Este paso corre **una vez, a mano, justo después**, y le quita a todo
rol de la aplicación los privilegios TRIGGER y REFERENCES sobre las tablas de
`bob`.

**Por qué.** Las tablas de `bob` se crearon en `public`, donde los privilegios
por defecto de Supabase le dan a `authenticated` TRIGGER y REFERENCES, y se
movieron a `bob` con ese ACL. Un usuario de un tenant podía colgar un trigger
de `bob.alert_log` y tumbar cada inserción posterior, de todos los tenants. Solo
el dueño de la tabla puede quitar ese trigger.

**Qué no es.** No es una migración y no está en la cadena de instalación
(`supabase/provision/install-chain.sha256` no cambia). No toca `00f79b7` ni su
firma. El arreglo definitivo es la migración `20261127110000` del PR #66, que
hace lo mismo y entra cuando se firme la cadena siguiente. Correr este paso y
después esa migración no es problema: los dos son idempotentes.

**Quién lo corre.** Henry, en Febor. Los agentes, solo en los ensayos de lab-02 y
model-01.

## Archivos

- `revocar.sql`: una transacción. Se niega si no corre como dueño de `bob`.
  Revoca y al final comprueba con `has_table_privilege`: si queda algo, lanza un
  error y no cambia nada. Las tablas no están listadas: las encuentra el
  catálogo.
- `revocar.sh`: lo corre como `bob_migrador`, con las credenciales que dejó el
  alta (`/opt/bob/secrets/migrador.env`), igual que `instalar-bob.sh resto`.
  La clave va en un pgpass en un directorio privado y se borra al terminar.
  Nunca usa la service role: se niega a correr con ella o con cualquier rol que
  no sea dueño de `bob`.

## Cómo correrlo en la caja

Justo después de que `caja` termine `resto` sobre `00f79b7`. Desde un checkout
de este repositorio en el commit de este PR (o de `main` cuando se fusione),
copiar los dos archivos a la caja y correr:

```bash
scp scripts/f58/revocar.sh scripts/f58/revocar.sql <caja>:/tmp/f58/
```

```bash
ssh <caja> 'sudo bash /tmp/f58/revocar.sh'
```

`sudo` hace falta para leer `/opt/bob/secrets/migrador.env`. Si el alta dejó
`MIGRADOR_RED`, psql corre en un contenedor con la imagen de la base, en esa
red, como en la instalación.

## Salida esperada

```
F-58: revoking TRIGGER and REFERENCES on bob as bob_migrador@<host>:5432
psql:/run/bob/revocar.sql:…: NOTICE:  F-58 before: N grants of TRIGGER or REFERENCES held by application roles
psql:/run/bob/revocar.sql:…: NOTICE:  F-58 after: 0 grants left on M relations of bob. OK
F-58: done
```

En una caja recién instalada desde `00f79b7`, N es mayor que cero (en un stack
local instalado desde `00f79b7`, 56: TRIGGER y REFERENCES en 28 tablas para
`authenticated`; y M, 48 relaciones). Una segunda
corrida dice `before: 0` y termina igual: no cambia nada.

## Cómo comprobar que quedó

Corriéndolo otra vez: tiene que decir `F-58 before: 0 grants`. O, como dueño de
`bob`, esta consulta tiene que devolver 0:

```sql
SELECT count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob',
       unnest(ARRAY['anon','authenticated','service_role','bob_app','bob_feeder','bob_ai_ro']) g(r),
       unnest(ARRAY['TRIGGER','REFERENCES']) p
 WHERE c.relkind IN ('r','p','v','m','f') AND has_table_privilege(g.r, c.oid, p);
```

## Si falla

Un fallo no cambia nada: la transacción vuelve atrás entera. La caja queda
como la dejó la instalación, que funciona; lo que sigue abierto es el
hallazgo F-58. No reintentar en bucle.

- **`run as the owner of schema bob (…), not as …`**: `MIGRADOR_USUARIO` no es
  el dueño de `bob`. Revisar `/opt/bob/secrets/migrador.env`; no correrlo con
  otra cuenta.
- **`refused: … is not the owner of bob`**: el env apunta a un rol de la
  aplicación o a la service role. Igual que arriba.
- **`F-58: still held after the revoke: <rol> <privilegio> <tabla>`**: alguien
  que no es el dueño otorgó ese privilegio (otro otorgante), y el REVOKE del
  dueño no lo alcanza. Anotar la línea completa y avisar en el hilo de Febor
  antes de tocar nada. Quitarlo exige saber quién lo otorgó (`aclexplode` sobre
  `pg_class.relacl`) y revocarlo como ese rol; no se improvisa en la ventana.
- **`there is no schema bob here`** o un error de conexión: la caja no tiene
  BOb instalado, o el host o el puerto no son los de su base. Revisar que
  `caja` haya terminado `resto`.

## Probado

`tests/slice2-schema.test.mjs` («F-58 · the separate REVOKE step»), con el
wrapper, contra un stack instalado desde `00f79b7` y contra `main`: ve el
privilegio antes, ve fallar el paso con un privilegio de otro otorgante (sin
cambiar nada), pasa después y una segunda corrida no hace nada. Se niega como
service role.
