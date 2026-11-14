# Changelog

Una línea por cambio entregado, en lenguaje de usuario.

## Sin publicar
- Contrato de proyección 0.5 con las elecciones de Federico del 13 nov: el corte de etiquetas es el sellado, una etiqueta que falta se cuenta como `label_missing`, una etiqueta tardía reconstruye el bucket sin deshacer alertas, y la reconciliación de fantasmas tiene su propia consulta. Los dos conteos del feeder quedan aceptados y el contrato dice qué cambia cuando llegue el bus.
- Borrador 0.5 del contrato de proyección: un canal sin lag declarado sigue mostrando cifras pero se marca «lag no declarado»; la duración de la conversación es del cliente; los eventos sin tenant y los actores sin resolver siguen dos caminos separados; se propone el corte tras el cual una etiqueta que falta es un fallo y no un retraso.
- Insumos de la capa de aplicación (P5) para BZZ-3: dónde vive el esquema de proyección, qué puede leer y escribir cada uno de los tres roles, dónde quedan sus credenciales y cómo llegan las migraciones a la caja, separando lo decidido de lo propuesto. Dos defectos del acceso del feeder quedan registrados (F-21, F-22).
- Borrador 0.4 del contrato de proyección: el abandono se atribuye a quien debía el siguiente turno y el abandono en cola se cuenta aparte; la salud del canal guarda numeradores y denominadores, nunca porcentajes; las duraciones de conversación quedan como distribución.
- Borrador 0.3 del contrato de proyección: las columnas de las ocho tablas salen del Handoff §3.3 con cinco cambios nombrados, la salud del canal deja de guardar un porcentaje, «quién fue afectado» se consulta a la fuente y el contrato dice dónde vive el umbral de inactividad por canal.
- Borrador del contrato de proyección del Slice 2: las ocho tablas, grano, procedencia, `org_id` como llave del tenant y quién es dueño de la correlación, para revisión antes de publicarlo.
- La suite de tenancy sigue a las tablas a cualquier esquema y falla si no encuentra las conocidas; PR-4 revisa particiones, PUBLIC y que el feeder pueda escribir. Cada guard se vio fallar a propósito.
- Toda AutoBotz binding queda obligada a declarar si cambia algo en el mundo (BR-3), también las anteriores a la regla; las cinco del ejemplo quedan como fixture con su test.
