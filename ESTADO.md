# ESTADO.md

> Actualizar al cerrar cada sesión. Es lo primero que lee la siguiente.

## Tarea actual
- BZZ-3 de Relevo, P5 («the whole application layer»): insumos en `docs/p5-application-layer.md`, rama `docs/p5-application-layer` (PR #16, revisado por Henry, sin fusionar). Separa lo decidido de lo propuesto: el esquema es el contrato 0.4; los tres roles se leen como `bob_app`, `bob_feeder` y `bob_ai_ro`; secretos en ficheros, no en Vault; la base de BOb en el `supabase-db` de la caja, esquema `bob`; migraciones desde BOb-engine aplicadas por Henry con el mismo CLI de CI, primero en lab-02. Respuesta a P5 publicada en BZZ-3 el 2026-11-11 con las tres preguntas para Federico; turno de Federico.
- Tarea 6 de Relevo («The projection read contract»): borrador 0.5 del contrato de proyección en `docs/contracts/projection-contract.md`, rama `docs/projection-contract-0.5` (PR #17, sin fusionar; lo revisa Henry). Recoge los rulings de Federico del 12 nov (O1–O5, numeración A-11/A-12 y las cinco elecciones de 0.4 aceptadas), separa el §7.2 en dos rutas y propone el corte de D-25 en el nuevo §4.1. Federico ruló el 13 nov (21:26): (a) en C1–C3 y O6, y aceptó los dos conteos con una condición de fin; todo está escrito en 0.5 (§4.1, §6.1, §7.3a, §8.6, §11) y en amendments. Falta revisar el PR, responder en la tarea 6 (borrador en el scratchpad de la sesión) y la firma de Henry. Ninguna migración del Slice 2 antes de la firma.
- Tarea 7 de Relevo («What is left to build — scope map»): paquete de guards antes del Slice 2, mergeado en PR #11.
- Tarea 9 de Relevo («Slice 5 · Cooldown and escalation durations», D-05): decisión cerrada por Federico el 27 oct, registrada en `contract-amendments.md` («Slice 5 · Cooldown and escalation»). Acuse publicado con seis puntos abiertos antes de escribir el paso 6a; turno de Federico.
- Tarea de Relevo «Licence scan on BOb, CHASS1S and Momentum dependency trees»: respuesta publicada el 5 nov con la distribución de licencias de producción y de desarrollo; turno de Federico.

## Hecho
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
- P5: F-21 (el feeder no puede leer `v_feeder_channel_map`: vista `security_invoker` sin grant en `channels`) y F-22 (la política de `org_id` rechaza las escrituras del feeder sin claim). Propuesta en los insumos §3.3; se arreglan con las migraciones del Slice 2. Encontrados leyendo, sin ejecutar.
- P5: cinco preguntas en §7 de los insumos (tres para Federico: los tres roles, el modelo de tenencia del runbook §7.3, el proyecto hospedado; dos para Henry: quién tiene `bob_feeder` primero y el número de la decisión).
- Contrato de proyección 0.5: nada abierto del lado de Federico. Henry revisa la condición de fin del §8.6 (las formas de los eventos en el bus quedan marcadas [PROPOSED]), responde en la tarea 6 y firma. D-33 recibe una entrada más (si el Slice 7 muestra «este bucket se reconstruyó después de sellarse») y sigue abierta. Interinos nombrados: los dos conteos del feeder hasta que el bus del Slice 8 acepte eventos del feeder, `todo` del guard de no mezclar hasta A-05b, retención sin aplicar hasta Slice 5.
- Para el Slice 2: llamar `bob_grant_projection()` y activar RLS en cada partición que se cree; afirmar que hay ocho proyecciones cuando el contrato las nombre; test de los grants de `bob_app`; las dos comprobaciones de ausencia de `slice0-schema` que solo miran `public`.
- Paso 6a (Migration Order): `cooldown_seconds` y `escalation_after_seconds` en `threshold_configs`, 1800/7200, CHECK `>= 300`. Se construye en Slice 5, no antes. Antes de escribirlo: los seis puntos de D-05 en amendments (DEFAULT vs NULL que hereda, piso del escalamiento, `notification_rules` paralela, sostenido vs sin acuse, recuperación y re-breach, granularidad).

## Bloqueado
- Nada.

## Siguiente paso
- Federico responde las tres preguntas de P5 en BZZ-3 (los tres roles, el modelo de tenencia del runbook §7.3, el proyecto hospedado). Después se escribe la decisión de BzzzBX con el siguiente número libre.
- Henry revisa el PR #17 (rulings del 13 nov y condición de fin del §8.6), publica la respuesta en la tarea 6 y firma 0.5; después la tarea 3.7 de BzzzBX implementa contra el contrato, con `member_refs_seen` como cuarto entregable.

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
