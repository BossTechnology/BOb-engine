# ESTADO.md

> Actualizar al cerrar cada sesión. Es lo primero que lee la siguiente.

## Tarea actual
- Tarea 7 de Relevo («What is left to build — scope map»): paquete de guards antes del Slice 2, en la rama `test/guards-fail-on-purpose`.

## Hecho
- Guards (a) y (c) de la revisión de la tarea 7 de Relevo, y lo barato de (b), (e) y (f): la tenancy descubre el esquema, hay un piso (`TENANCY_FLOOR`), las sondas de los meta-tests corren en `public` y en `bob`, PR-4 revisa particiones, PUBLIC y la escritura del feeder, el test de agregados y la limpieza del fixture descubren sus tablas, y el glob y `ci-coverage` son recursivos. Suite: 100.
- Cada guard se vio fallar a propósito; la tabla está en `contract-amendments.md` (F-17 a F-19).
- Conteo de archivos: 44 rastreados en `71c5fea`. El «57» era el número de entradas del zip (44 archivos + 13 directorios); el «60 files» del zip de `aa696e2` tiene el mismo error (47 + 13).

## Pendiente
- Regla de `main`: `enforcement_level` sigue en `non_admins`. Henry marca «Do not allow bypassing the above settings» (necesita admin; `gh` de esta máquina no lo es).
- Para el Slice 2: llamar `bob_grant_projection()` y activar RLS en cada partición que se cree; afirmar que hay ocho proyecciones cuando el contrato las nombre; test de los grants de `bob_app`; las dos comprobaciones de ausencia de `slice0-schema` que solo miran `public`.

## Bloqueado
- Nada.

## Siguiente paso
- Mergear el PR del paquete de guards, responder en la tarea 7 de Relevo y abrir el Slice 2 publicando el contrato de proyección.

## Notas de sesión
<!-- AAAA-MM-DD: una o dos líneas -->
- 2026-10-28: VALIDATE CONSTRAINT y fixture BR-3 en `main`; puente AutoBotz de Bob-New desactivado (Bob-New #24). Respuesta a Federico publicada con fechas del TTL (Febor: 2026-10-26 16:55:42 UTC).
- 2026-10-29: paquete de guards de la tarea 7 de Relevo (F-17 a F-19), 82 → 100 tests; cada guard visto fallar.
