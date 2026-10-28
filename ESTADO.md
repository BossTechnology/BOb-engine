# ESTADO.md

> Actualizar al cerrar cada sesión. Es lo primero que lee la siguiente.

## Tarea actual
- Ninguna abierta en este repositorio. La tarea de Relevo «Slice 1 cerrado · ocho preguntas para preparar Slice 2» (alias N-05) está respondida y en el turno de Federico.

## Hecho
- PR #8: `20261025100000_autobotz_validate_mutative.sql` valida `autobotz_mutative_declared`; las cinco rulings de F-07 van como fixture (`supabase/tests/fixtures/autobotz_br3.sql`) y `tests/autobotz-br3.test.mjs` añade 6 tests. Suite: 82.
- PR #5 mergeado con `main` sin aprobación requerida y los cuatro checks obligatorios.
- Zip de `main` en `aa696e2` entregado a Federico (md5 `c6bd02f2479725a1342ca0a180288fe2`).
- El test 75 es el guard de checks requeridos (PR #4, `dd0d27a`); el 76 es el pin del CLI de Supabase (PR #6).

## Pendiente
- Regla de `main`: `enforcement_level` está en `non_admins`, así que un admin puede saltarse los checks. Falta marcar «Do not allow bypassing the above settings». Lo hace Federico; la cuenta `hdgarzon` no es admin.

## Bloqueado
- Nada.

## Siguiente paso
- Slice 2: construir el feeder y publicar el contrato de proyección (tablas, columnas, grano, procedencia, quién es dueño de la correlación) antes de que la tarea 3.7 de BzzzBX implemente contra él.

## Notas de sesión
<!-- AAAA-MM-DD: una o dos líneas -->
- 2026-10-28: VALIDATE CONSTRAINT y fixture BR-3 en `main`; puente AutoBotz de Bob-New desactivado (Bob-New #24). Respuesta a Federico publicada con fechas del TTL (Febor: 2026-10-26 16:55:42 UTC).
