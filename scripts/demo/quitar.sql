-- ════════════════════════════════════════════════════════════════════════════
-- Semilla demo de BOb · quitar.
--
-- Borra solo lo que lleva la marca de la semilla (la describe guardas.sql), con
-- los mismos roles que la escribieron: las filas de proyección como bob_feeder,
-- los actores y canales como bob_app. Las capacidades y la mezcla se van con
-- su canal (ON DELETE CASCADE), y las refs con su actor.
--
-- Antes de borrar canales y actores, G9 busca en el catálogo toda llave
-- foránea que apunte a bob.channels o bob.actors (descubiertas, no listadas) y
-- se niega si alguna fila que la semilla no escribió apunta a un canal o actor
-- de la semilla: turnos, skills, historial de refs, member_refs_seen, una
-- proyección sin la marca, o lo que se agregue después. Sin eso, el ON DELETE
-- CASCADE de esas tablas se las llevaría. Se cuentan como de la semilla solo:
-- las capacidades y la mezcla de un canal demo (son su configuración) y la ref
-- de un actor demo igual a su display_id. Si G9 se niega, la transacción entera
-- se deshace y no se borra nada.
--
-- Las particiones mensuales que creó bob.proj_ensure_partition se quedan,
-- vacías; son del mismo tipo que crea el alimentador y no pintan nada.
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

-- G9, con el rol que se conectó (ve todas las filas; G4).
DO $g9$
DECLARE
  fk record; n bigint; ajenas text[] := '{}';
  canales uuid[] := ARRAY(SELECT id FROM bob.channels
                           WHERE source_key LIKE 'demo-%' AND adapter_kind = 'synthetic'
                             AND (config ->> 'bob_demo') = 'true');
  actores uuid[] := ARRAY(SELECT id FROM bob.actors
                           WHERE display_id LIKE 'demo-%' AND (attributes ->> 'bob_demo') = 'true');
BEGIN
  FOR fk IN
    SELECT c.conrelid::regclass AS tabla, c.confrelid AS destino, a.attname AS columna,
           format('%I.%I', ns.nspname, cl.relname) AS nombre
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(local, remoto)
      JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = k.local
      JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.remoto
     WHERE c.contype = 'f' AND c.conparentid = 0 AND ra.attname = 'id'
       AND c.confrelid IN ('bob.channels'::regclass, 'bob.actors'::regclass)
     ORDER BY 1, 3
  LOOP
    EXECUTE format('SELECT count(*) FROM %s x WHERE x.%I = ANY ($1)%s', fk.tabla, fk.columna,
      CASE
        WHEN fk.tabla IN ('bob.channel_capabilities'::regclass, 'bob.channel_actor_mix'::regclass)
          THEN ' AND false'
        WHEN fk.tabla = 'bob.actor_external_refs'::regclass
          THEN ' AND NOT EXISTS (SELECT 1 FROM bob.actors a WHERE a.id = x.actor_id AND a.display_id = x.ref)'
        ELSE ''
      END)
      INTO n
      USING CASE WHEN fk.destino = 'bob.channels'::regclass THEN canales ELSE actores END;
    IF n > 0 THEN ajenas := ajenas || format('%s.%s (%s)', fk.nombre, fk.columna, n); END IF;
  END LOOP;
  IF cardinality(ajenas) > 0 THEN
    RAISE EXCEPTION 'bob-demo G9: filas que la semilla no escribió apuntan a sus canales o actores: %; no se borra nada',
      array_to_string(ajenas, ', ');
  END IF;
END
$g9$;

SET LOCAL ROLE bob_app;

DELETE FROM bob.actors
 WHERE display_id LIKE 'demo-%' AND (attributes ->> 'bob_demo') = 'true';

DELETE FROM bob.channels
 WHERE source_key LIKE 'demo-%' AND adapter_kind = 'synthetic' AND (config ->> 'bob_demo') = 'true';

RESET ROLE;
