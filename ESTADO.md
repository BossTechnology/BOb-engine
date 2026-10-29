# ESTADO.md

> Actualizar al cerrar cada sesión. Es lo primero que lee la siguiente.

## Tarea actual
- Tarea 6 de Relevo («The projection read contract»): borrador 0.2 del contrato de proyección en `docs/contracts/projection-contract.md`, en PR #13. Publicado en la tarea 6 de Relevo el 29 oct con F-20 y las cinco preguntas para la 3.7; turno de Federico. Ninguna migración del Slice 2 antes de la firma.
- Tarea 7 de Relevo («What is left to build — scope map»): paquete de guards antes del Slice 2, mergeado en PR #11.
- Tarea 9 de Relevo («Slice 5 · Cooldown and escalation durations», D-05): decisión cerrada por Federico el 27 oct, registrada en `contract-amendments.md` («Slice 5 · Cooldown and escalation»). Acuse publicado con seis puntos abiertos antes de escribir el paso 6a; turno de Federico.

## Hecho
- Guards (a) y (c) de la revisión de la tarea 7 de Relevo, y lo barato de (b), (e) y (f): la tenancy descubre el esquema, hay un piso (`TENANCY_FLOOR`), las sondas de los meta-tests corren en `public` y en `bob`, PR-4 revisa particiones, PUBLIC y la escritura del feeder, el test de agregados y la limpieza del fixture descubren sus tablas, y el glob y `ci-coverage` son recursivos. Suite: 100.
- Cada guard se vio fallar a propósito; la tabla está en `contract-amendments.md` (F-17 a F-19).
- Conteo de archivos: 44 rastreados en `71c5fea`. El «57» era el número de entradas del zip (44 archivos + 13 directorios); el «60 files» del zip de `aa696e2` tiene el mismo error (47 + 13).
- PR #11 con CI verde y mergeado; respuesta publicada en la tarea 7 de Relevo y turno pasado a Federico.

## Pendiente
- Contrato de proyección: siete de las ocho listas de columnas y dos nombres de procedencia siguen propuestos, porque el Handoff §3.3 no está en ningún paquete (F-20). Diez preguntas abiertas en el §11 del contrato.
- Regla de `main`: `enforcement_level` sigue en `non_admins`. Henry marca «Do not allow bypassing the above settings» (necesita admin; `gh` de esta máquina no lo es).
- Para el Slice 2: llamar `bob_grant_projection()` y activar RLS en cada partición que se cree; afirmar que hay ocho proyecciones cuando el contrato las nombre; test de los grants de `bob_app`; las dos comprobaciones de ausencia de `slice0-schema` que solo miran `public`.
- Paso 6a (Migration Order): `cooldown_seconds` y `escalation_after_seconds` en `threshold_configs`, 1800/7200, CHECK `>= 300`. Se construye en Slice 5, no antes. Antes de escribirlo: los seis puntos de D-05 en amendments (DEFAULT vs NULL que hereda, piso del escalamiento, `notification_rules` paralela, sostenido vs sin acuse, recuperación y re-breach, granularidad).

## Bloqueado
- Nada.

## Siguiente paso
- Respuesta de Federico en la tarea 6 sobre F-20 (Handoff §3.3) y el §11; luego firma y la tarea 3.7 de BzzzBX implementa contra el contrato.
- Confirmar en la tarea 7 de Relevo cuando la regla de `main` lea `everyone`.

## Notas de sesión
<!-- AAAA-MM-DD: una o dos líneas -->
- 2026-10-28: VALIDATE CONSTRAINT y fixture BR-3 en `main`; puente AutoBotz de Bob-New desactivado (Bob-New #24). Respuesta a Federico publicada con fechas del TTL (Febor: 2026-10-26 16:55:42 UTC).
- 2026-10-28: D-05 verificada contra el esquema en `aed52ba` y registrada en amendments; paso 6a queda para Slice 5.
- 2026-10-29: paquete de guards de la tarea 7 de Relevo (F-17 a F-19), 82 → 100 tests; cada guard visto fallar. PR #11 verde, respuesta publicada.
- 2026-10-29: borrador del contrato de proyección (Slice 2). Los ocho nombres salen del paso 14 del Migration Order (paquete Slice 1c); las columnas, salvo `proj_response_time`, siguen propuestas (F-20).
