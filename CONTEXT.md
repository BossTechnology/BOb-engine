# CONTEXT.md — Glosario del dominio

Términos del proyecto y su significado exacto. Úsalos en código, commits, docs y conversación. Si un término no está aquí, no lo inventes: pregunta y agrégalo.

## Términos

| Término | Significado | Dónde aparece |
|---|---|---|
| Sellado (*sealed*) | Bucket completo: no llegan más hechos. No significa inmutable; la atribución se revisa por reconstrucción (D-12). | `docs/contracts/projection-contract.md` §4 |
| Unfounded claims | Nombre visible de la métrica `hallucinations`; aplica a los cuatro `actor_type`. | Contrato §6.1 |
| No configurado | Tercer estado junto a «no observado» y «observado, cero»: el canal no declara la capacidad (D-14). | Contrato §5 |
| `affected_members` | Consulta a la fuente de verdad, nombrada en el contrato: miembros como filas, lo anónimo como conteo de interacciones. | Contrato §7.3 |

## Fuera de alcance
Lo que este proyecto explícitamente NO hace.

## Decisiones clave
Enlaces a ADRs en `docs/adr/`.
