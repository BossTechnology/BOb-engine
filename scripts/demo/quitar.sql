-- ════════════════════════════════════════════════════════════════════════════
-- Semilla demo de BOb · quitar.
--
-- Borra solo lo que lleva la marca de la semilla (la describe guardas.sql), con
-- los mismos roles que la escribieron: las filas de proyección como bob_feeder,
-- los actores y canales como bob_app. Las capacidades y la mezcla se van con
-- su canal (ON DELETE CASCADE), y las refs con su actor.
--
-- Si una fila sin la marca apunta a un canal o actor de la semilla, la llave
-- foránea lo impide y la transacción entera se deshace: no se borra nada que no
-- sea de la semilla. Las particiones vacías que creó se quedan; son del mismo
-- tipo que crea el alimentador y no pintan nada.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF current_setting('bob_demo.guarda', true) IS DISTINCT FROM 'pasada'
     OR current_setting('bob_demo.accion', true) IS DISTINCT FROM 'quitar' THEN
    RAISE EXCEPTION 'bob-demo: quitar.sql corre solo después de guardas.sql con la acción quitar, en la misma transacción';
  END IF;
END $$;

SELECT set_config('request.jwt.claims', json_build_object('org_id', o.id)::text, true)
  FROM bob.organizations o
 WHERE o.slug = current_setting('bob_demo.tenant');

SET LOCAL ROLE bob_feeder;

DO $$
DECLARE t record; n bigint;
BEGIN
  FOR t IN
    SELECT format('%I.%I', ns.nspname, c.relname) AS tabla
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'bob' AND c.relkind = 'p' AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'feeder_version' AND NOT a.attisdropped)
     ORDER BY 1
  LOOP
    EXECUTE format('DELETE FROM %s WHERE feeder_version = %L', t.tabla, 'bob-demo/1');
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'bob-demo: % filas fuera de %', n, t.tabla;
  END LOOP;
END $$;

RESET ROLE;
SET LOCAL ROLE bob_app;

DELETE FROM bob.actors
 WHERE display_id LIKE 'demo-%' AND (attributes ->> 'bob_demo') = 'true';

DELETE FROM bob.channels
 WHERE source_key LIKE 'demo-%' AND adapter_kind = 'synthetic' AND (config ->> 'bob_demo') = 'true';

RESET ROLE;
