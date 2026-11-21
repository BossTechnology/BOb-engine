# CONTEXT.md — Glosario del dominio

Términos del proyecto y su significado exacto. Úsalos en código, commits, docs y conversación. Si un término no está aquí, no lo inventes: pregunta y agrégalo.

## Términos

| Término | Significado | Dónde aparece |
|---|---|---|
| Sellado (*sealed*) | Bucket completo: no llegan más hechos. No significa inmutable; la atribución se revisa por reconstrucción (D-12). | `docs/contracts/projection-contract.md` §4 |
| Unfounded claims | Nombre visible de la métrica `hallucinations`; aplica a los cuatro `actor_type`. | Contrato §6.1 |
| Celda | Lo que pinta un consumidor, al grano `(org_id, channel_id, métrica, actor_type, bucket_start)`. Tiene un estado y una lista de motivos. La resuelve `bob_cell_state(org, canales[], desde, hasta)`, una sola implementación para gráficas, matriz, sentimiento y BObee. | Spec Slice 3 §2, §7 |
| Estado de la celda | Uno de seis, evaluados en orden: `not_applicable`, `not_configured`, `pending`, `not_observed`, `observed`, y `off_shift` solo en el drill-down por actor. Los valores del esquema van en inglés y los nombres en español son los de abajo. | Spec Slice 3 §2 |
| No aplica (`not_applicable`) | El actor no puede producir esa métrica por definición (Resueltos, Desambiguación y Derivaciones para el cliente; las métricas degeneradas fuera de `user`). Celda vacía, sin acción. | Spec Slice 3 §4 |
| No configurado (`not_configured`) | Falta una declaración y nada *puede* llegar: `telemetry_started_at`, `source_key` (D-14), el mix, una capacidad, el idle bound, el ground truth o la definición. Sus motivos dicen qué declarar. | Contrato §5; D-14; Spec Slice 3 §3 |
| Pendiente (`pending`) | Sin fila, y el bucket todavía no se puede saber: sin sellar o lag no declarado. | Spec Slice 3 §3 |
| No observado (`not_observed`) | Configurado y sellado, sin fila y sin vivacidad. Se pinta con el guion (D-14). | Contrato §5; Spec Slice 3 §3 |
| Observado (`observed`) | Hay una cifra, y el cero es una cifra. Un cero siempre lleva motivo (UI-03). | Contrato §5; Spec Slice 3 §3 |
| Fuera de turno (`off_shift`) | Celda por actor del drill-down cuyo actor no está en turno. Comparte el guion con «no observado», y se distingue por estado y motivo. | Contrato §5; Spec Slice 3 §2 |
| Provisional | Marca sobre «observado»: la fila existe pero su bucket no ha sellado (O1). No es un estado. | Spec Slice 3 §2 |
| Motivo (`reasons`) | Lista ordenada de por qué una celda está en su estado, y qué hacer. Primero va lo que el cliente arregla en BOb. Los nombres van en `snake_case` inglés, como los de FR-23. | Spec Slice 3 §2 |
| Vivacidad (`liveness_source`) | Evidencia de que el canal estaba vivo en un bucket: `traffic` (hubo una interacción) o `probe` (`health_uptime`). Sin ninguna de las dos no hay cero observado. | Spec Slice 3 §5 (F-28) |
| Cobertura (`coverage`) | En un total de varios canales, «n de m canales», con cada canal excluido y su estado. | Spec Slice 3 §6 (F-30) |
| `affected_members` | Consulta a la fuente de verdad, nombrada en el contrato: miembros como filas, lo anónimo como conteo de interacciones. | Contrato §7.3 |
| `abandoned_in_queue` | Abandono antes de que alguien atendiera; problema de personal, no de conversación. Siempre `user`. | Contrato §6.1 |
| P5 | La capa de aplicación de BzzzBX (Runbook v1 §7): esquema de proyección, los tres roles con sus grants y el mecanismo de migraciones. Decisión de BzzzBX, sin número hasta firmarse. | `docs/p5-application-layer.md` |
| Los tres roles | `bob_app` (la aplicación), `bob_feeder` (el único que escribe proyecciones) y `bob_ai_ro` (vistas `v_ai_*` y nada más). Handoff §4.3. | `20260902100300_roles_and_grants.sql`; insumos P5 §3 |
| Dueño de las migraciones | El rol que aplica la cadena y es dueño de los objetos (`postgres` en la imagen de Supabase). Ningún servicio en marcha tiene su credencial. | Insumos P5 §3.4, §6.2 |
| Chequeo de caja | Chequeo de solo lectura que corre la caja de un cliente después de migrar (`scripts/box-check.mjs`): una sola organización, con el `slug` igual al `bzzz.tenant` de la caja, los tres roles y sin salida a red. Nunca carga un fixture. | Insumos P5 §6.2, §8 objeción 3 |
| Intención (*intention*) | Fila de `bob.outbound_queue`: lo que BOb pide que se haga. BOb la escribe y nunca la ejecuta ni guarda credenciales; la transmite otro. Lleva el alerta que la causó. | Slice 6, `20261121100200_outbound_queue.sql` |
| Outbox | `bob.outbound_queue`. Estados: `queued` (se drena), `awaiting_approval` (nada lo drena) y `drained`. Los límites se aplican al escribir. | Slice 6 |
| Vencida (*stale*) | Estado de verificación de un binding ok cuya verificación pasó de 30 días. Se calcula, no se guarda (RS-31). | `bob_autobotz_state()` |
| A-11 / A-12 | Números del registro para lo que en Relevo se llamó A-07 (drill-through de miembros) y A-09 (conteo de abstenciones). | `contract-amendments.md` |

## Fuera de alcance
Lo que este proyecto explícitamente NO hace.

## Decisiones clave
Enlaces a ADRs en `docs/adr/`.
