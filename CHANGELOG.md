# Changelog

Una línea por cambio entregado, en lenguaje de usuario.

## Sin publicar
- Borrador 0.3 del contrato de proyección: las columnas de las ocho tablas salen del Handoff §3.3 con cinco cambios nombrados, la salud del canal deja de guardar un porcentaje, «quién fue afectado» se consulta a la fuente y el contrato dice dónde vive el umbral de inactividad por canal.
- Borrador del contrato de proyección del Slice 2: las ocho tablas, grano, procedencia, `org_id` como llave del tenant y quién es dueño de la correlación, para revisión antes de publicarlo.
- La suite de tenancy sigue a las tablas a cualquier esquema y falla si no encuentra las conocidas; PR-4 revisa particiones, PUBLIC y que el feeder pueda escribir. Cada guard se vio fallar a propósito.
- Toda AutoBotz binding queda obligada a declarar si cambia algo en el mundo (BR-3), también las anteriores a la regla; las cinco del ejemplo quedan como fixture con su test.
