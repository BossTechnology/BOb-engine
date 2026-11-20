# ESTADO.md

> Actualizar al cerrar cada sesión. Es lo primero que lee la siguiente.

## Tarea actual
- Slice 2 terminado y en `main`: PR #20 (`9fbd367`) y PR #21 (`c4ebf1d`), contrato 0.5.3. El aviso de 0.5.3 a Federico se publicó en la tarea 6 de Relevo el 19 nov, y el turno es de Federico (3.7).
- BZZ-3 de Relevo, P5 («the whole application layer»), decisión D62 de BzzzBX, sin firmar: insumos en `docs/p5-application-layer.md`. El 19 nov se pusieron al día después del Slice 2, con F-26 como Q6 y las siete objeciones del abogado del diablo en el §8. Henry respondió la 1 (BOb v1 corre dentro de la caja), la 2 (base compartida, `bob` se recupera solo) y la 3 (una organización por caja; la RLS es defensa en profundidad); el resto sigue abierto (rama `docs/p5-d62-after-slice-2`). Federico respondió Q1–Q3 (tres roles de Handoff §4.3; `organizations`/`org_id` en vez de `tenants`/`app_entities`; Q3 en su forma del 15 nov: desarrollo en Supabase local, lab-02 para integración y ensayo, el proyecto hospedado vuelve a la demo). Henry respondió en BZZ-19 el 18 nov: el alimentador de referencia tiene `bob_feeder` primero; número D62 (D60 se firmó ese día para otra cosa).
- Tarea 6 de Relevo («The projection read contract»): contrato de proyección **0.5.1 firmado** por Henry en la tarea 6 el 2026-11-18 (marca «Decisión firmada») y fusionado en `main` (PR #17, `5e2966d`). Las correcciones que encontró el Slice 2 están en 0.5.2 (F-23, F-24 con §8.7) y 0.5.3 (F-25), aceptadas por Henry; 0.5.2 y 0.5.3 ya se avisaron a Federico. Turno de Federico para la pregunta de H3.
- Tarea 7 de Relevo («What is left to build — scope map»): paquete de guards antes del Slice 2, mergeado en PR #11.
- Tarea 9 de Relevo («Slice 5 · Cooldown and escalation durations», D-05): decisión cerrada por Federico el 27 oct, registrada en `contract-amendments.md` («Slice 5 · Cooldown and escalation»). Acuse publicado con seis puntos abiertos antes de escribir el paso 6a; turno de Federico.
- Tarea de Relevo «Licence scan on BOb, CHASS1S and Momentum dependency trees»: respuesta publicada el 5 nov con la distribución de licencias de producción y de desarrollo; turno de Federico.

## Hecho
- Slice 2, PR 2 (#21, `c4ebf1d`):
  - el alimentador de referencia: un tenant por transacción bajo su claim (F-22), sellado por la regla del §4, `label_missing` solo al sellar y solo en canales con `orga_conversation`, los dos conteos del §8.6 por separado, y el §8.7 aplicado;
  - la reconciliación de fantasmas como `bob_app`, con la ventana de H3, el barrido de retención y la vinculación;
  - `channel_capabilities` y la columna `capabilities` en `v_feeder_channel_map` (F-25, contrato 0.5.3), y el reporte `v_channel_declaration_gaps`;
  - 25 guards nuevos, cada uno visto fallar. Dos estaban ciegos en la primera corrida y se reescribieron, y el guard de capacidades por tipo atrapó el comentario de la propia migración.
  - Suite: 167 (166 pasan, 1 `todo`). CI en verde.
- Slice 2, PR 1 (rama `slice-2-projection-schema`): tres migraciones. Las tablas y vistas pasan de `public` a `bob` (las funciones se quedan en `public` con `search_path = bob, public`). Las ocho `proj_*`. `bob.proj_ensure_partition` con H1. `actor_external_refs`, `actor_ref_history` (solo agregar, por trigger), `idle_bound_seconds`, `v_feeder_channel_map` y `v_feeder_actor_map` como vistas definer solo para `bob_feeder` (F-21 cerrado), y F-22 probado en el esquema. Los guards de `bob_app` encontraron seis tablas sin grants y quedan concedidas. Cada guard se vio fallar; la tabla está en amendments. Suite: 142 (141 pasan, 1 `todo`).
- Guards (a) y (c) de la revisión de la tarea 7 de Relevo, y lo barato de (b), (e) y (f): la tenancy descubre el esquema, hay un piso (`TENANCY_FLOOR`), las sondas de los meta-tests corren en `public` y en `bob`, PR-4 revisa particiones, PUBLIC y la escritura del feeder, el test de agregados y la limpieza del fixture descubren sus tablas, y el glob y `ci-coverage` son recursivos. Suite: 100.
- Cada guard se vio fallar a propósito; la tabla está en `contract-amendments.md` (F-17 a F-19).
- Conteo de archivos: 44 rastreados en `71c5fea`. El «57» era el número de entradas del zip (44 archivos + 13 directorios); el «60 files» del zip de `aa696e2` tiene el mismo error (47 + 13).
- PR #11 con CI verde y mergeado; respuesta publicada en la tarea 7 de Relevo y turno pasado a Federico.
- Regla de `main`: «Do not allow bypassing the above settings» marcado; la API lee `everyone` (2026-10-29). Confirmado en la tarea 7 de Relevo y registrado en PR #12.
- Escaneo de licencias (2026-11-05), sobre los lockfiles de `main` y lo que se instala en producción (linux-x64, sin dev):
  - En los cuatro repos no hay GPL ni AGPL sin alternativa, ni licencias source-available, ni paquetes sin licencia.
  - BOb-engine: 0 de producción y 14 de desarrollo (`pg`).
  - Bob-New: 40 de producción; el único LGPL es libvips, que trae sharp.
  - Momentum: 0 de producción.
  - CHASS1S (repo `CHS`): 137 de producción. jszip tiene doble licencia (MIT o GPL), duck declara solo «BSD» y Chromium se descarga en tiempo de ejecución.

## Pendiente
- P5 (D62): Henry responde Q6 (F-26) y las siete objeciones del §8 antes de firmar. Las objeciones 1 a 3 ya tienen respuesta; quedan de la 4 a la 7.
- Tres guards del §6.3 de P5 no están construidos: tres roles y no más, `bob_ai_ro` solo vistas, y sin salida a red desde la base.
- Hallazgo en P5 §6.2: `restore.sh` no restaura Postgres. La identidad se restaura a mano, y la respuesta a la objeción 2 lo reemplaza con un respaldo y una recuperación propios de `bob`.
- F-26: Henry está de acuerdo en que quien programa la reconciliación le entregue `(org_id, tenant_slug)`. Quién la programa es pregunta de P5 (D62).
- Fuera del Slice 2: dónde se escribe la medición p99 de H2; la igualdad de `affected_members` espera el endpoint de 3.7.
- Límites del alimentador de referencia, a propósito: no escribe `proj_durations`, `proj_channel_health` ni `proj_rum_signals` (el fixture no trae esa instrumentación), y lee 24 horas de contexto antes de la ventana.
- P5 (D62): el abogado del diablo ya corrió (19 nov, §8). Antes de la primera ventana, o antes de la firma si así se responde la objeción 5: ensayo en lab-02 de una migración amañada para fallar a mitad de cadena, con dump antes, que también restaure `bob` solo, y el procedimiento escrito (primero arreglo hacia delante y, si no alcanza, restaurar `bob` y reconstruir las proyecciones). F-21 y F-22 quedaron cerrados en el Slice 2.
- Contrato de proyección 0.5.1 (firmado): en la tarea 6, turno de Federico, abierta para 3.7 la pregunta de H3 (horario y costo en ClickHouse del barrido de `member_refs_seen` sobre la retención); no frena el Slice 2. D-33 sigue abierta (si el Slice 7 muestra «este bucket se reconstruyó después de sellarse»). Interinos nombrados: los dos conteos del feeder hasta el bus del Slice 8, `todo` del guard de no mezclar hasta A-05b, retención sin aplicar hasta Slice 5.
- Paso 6a (Migration Order): `cooldown_seconds` y `escalation_after_seconds` en `threshold_configs`, 1800/7200, CHECK `>= 300`. Se construye en Slice 5, no antes. Antes de escribirlo: los seis puntos de D-05 en amendments (DEFAULT vs NULL que hereda, piso del escalamiento, `notification_rules` paralela, sostenido vs sin acuse, recuperación y re-breach, granularidad).

## Bloqueado
- Nada.

## Siguiente paso
- P5: Henry revisa el PR de la puesta al día y responde el §8 y Q6. Si P5 sigue en pie, firma D62.
- La tarea 3.7 de BzzzBX implementa contra el contrato 0.5.3, con `member_refs_seen` como cuarto entregable (turno de Federico).

## Notas de sesión
<!-- AAAA-MM-DD: una o dos líneas -->
- 2026-10-28: VALIDATE CONSTRAINT y fixture BR-3 en `main`; puente AutoBotz de Bob-New desactivado (Bob-New #24). Respuesta a Federico publicada con fechas del TTL (Febor: 2026-10-26 16:55:42 UTC).
- 2026-10-28: D-05 verificada contra el esquema en `aed52ba` y registrada en amendments; paso 6a queda para Slice 5.
- 2026-10-29: paquete de guards de la tarea 7 de Relevo (F-17 a F-19), 82 → 100 tests; cada guard visto fallar. PR #11 verde, respuesta publicada.
- 2026-10-29: borrador del contrato de proyección (Slice 2). Los ocho nombres salen del paso 14 del Migration Order (paquete Slice 1c); las columnas, salvo `proj_response_time`, siguen propuestas (F-20).
- 2026-11-05: escaneo de licencias de BOb, CHASS1S y Momentum publicado en Relevo; ninguna dependencia cambiada. Sin verificar: si el binario de libvips entra en el bundle desplegado en Vercel.
- 2026-11-10: borrador 0.3 del contrato de proyección con §3.3 (md5 `eb89363d…`) y los rulings del 4 y 10 nov; entrada «Slice 2 · The projection read contract, 0.3» en amendments. Dieciséis preguntas abiertas para la tarea 6.
- 2026-11-11: borrador 0.4 con las dieciséis respuestas de Federico del 11 nov; `proj_response_time` pasa a `proj_durations`; A-11 y A-12 registradas. Cinco preguntas abiertas.
- 2026-11-11: respuesta de 0.4 publicada en la tarea 6 de Relevo (numeración A-11/A-12, decisiones propias, O1–O5) y turno pasado a Federico.
- 2026-11-11: insumos de P5 (capa de aplicación) para BZZ-3 en `docs/p5-application-layer.md`; F-21 y F-22 registrados en amendments; ninguna migración ni base tocada.
- 2026-11-11: respuesta a P5 publicada en BZZ-3 tras la revisión del PR #16, y turno pasado a Federico.
- 2026-11-12: borrador 0.5 con los rulings O1–O5 de Federico; §7.2 en dos rutas; §4.1 nuevo con la latencia de voz de la tarea 14 y el corte de D-25 propuesto (`label_missing`, tres elecciones abiertas). Respuesta sin publicar.
- 2026-11-13: respuesta de 0.5 publicada en la tarea 6 de Relevo (PR #17, corte de D-25, C1–C3 y O6) y turno pasado a Federico.
- 2026-11-13: rulings de Federico del 13 nov escritos en 0.5 (C1–C3 y O6 en (a), dos conteos aceptados) y condición de fin del interino en el §8.6; C3 deja la pregunta de mostrar la reconstrucción a D-33. Respuesta sin publicar.
- 2026-11-18: insumos de P5 al día con las respuestas de Federico (Q1–Q3) y de Henry (BZZ-19): alimentador de referencia primero, número D62. Conteo leído: 19 migraciones, 10 envueltas en `BEGIN … COMMIT`, 9 sin envolver. P5 sigue sin firmar.
- 2026-11-18: revisión de Henry de los ocho [PROPOSED] de 0.5: cuatro quedan como estaban y cuatro se ajustan (H1 la función de particiones rechaza lo que no es de las ocho; H2 lag con p99 de 7 días medido; H3 ventana de fantasmas que se solapa, sin cursor; H4 `valid_to` derivado). Versión 0.5.1; `main` fusionado en la rama.
- 2026-11-18: 0.5.1 firmado por Henry en la tarea 6 y PR #17 fusionado (`5e2966d`); turno de la tarea 6 pasado a Federico.
- 2026-11-18: Slice 2, PR 1: esquema `bob`, ocho proyecciones, función de particiones (H1), refs y vistas del feeder (F-21, F-22); 100 → 140 tests, cada guard visto fallar. F-23 y F-24 preguntados a Henry. Puertos locales movidos a 583xx en el worktree, sin commitear (54322 lo ocupa otro proyecto).
- 2026-11-18: Henry acepta F-24 (a) y F-23; contrato 0.5.2 con §8.7 y el guard de hora de evento inmutable, visto fallar; 142 tests.
- 2026-11-18: Slice 2, PR 2: alimentador de referencia, reconciliación de fantasmas, `channel_capabilities` (F-25) y reporte de declaraciones. De 142 a 166 tests. Cada guard se vio fallar; dos estaban ciegos en la primera corrida y se reescribieron. F-26 registrado.
- 2026-11-18: Henry elige la opción (a) de F-25 y el contrato pasa a 0.5.3. El guard de capacidad se vio fallar en los dos lados. 167 tests.
- 2026-11-19: PR #21 fusionado por orden de Henry (`c4ebf1d`), con CI en verde. Slice 2 cerrado.
- 2026-11-19: PR #21 fusionado (`c4ebf1d`) y aviso de 0.5.3 publicado en la tarea 6. Abogado del diablo sobre P5 con siete objeciones, y los insumos de P5 puestos al día con F-26 (Q6). Henry respondió las objeciones 1 a 3. Nada firmado.
