-- Semilla demo de BOb · lo que hay con la marca, al final de la transacción.
-- Lo corre bob-demo.sh después de sembrar o quitar, con el rol que se conectó.
DO $$
DECLARE t record; n bigint;
BEGIN
  SELECT count(*) INTO n FROM bob.channels
   WHERE source_key LIKE 'demo-%' AND (config ->> 'bob_demo') = 'true';
  RAISE NOTICE 'bob-demo: canales de la semilla: %', n;
  SELECT count(*) INTO n FROM bob.actors
   WHERE display_id LIKE 'demo-%' AND (attributes ->> 'bob_demo') = 'true';
  RAISE NOTICE 'bob-demo: actores de la semilla: %', n;
  FOR t IN
    SELECT format('%I.%I', ns.nspname, c.relname) AS tabla
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'bob' AND c.relkind = 'p' AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'feeder_version' AND NOT a.attisdropped)
     ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE feeder_version = %L', t.tabla, 'bob-demo/1') INTO n;
    RAISE NOTICE 'bob-demo: %: % filas', t.tabla, n;
  END LOOP;
  SELECT count(*) INTO n FROM bob.organizations WHERE telemetry_started_at IS NULL;
  IF n > 0 THEN
    RAISE NOTICE 'bob-demo: AVISO: la organización no tiene telemetry_started_at; bob-web pintará «No configurado» en cada celda hasta que se declare';
  END IF;
END $$;
