-- ════════════════════════════════════════════════════════════════════════════
-- Semilla demo de BOb · las guardas.
--
-- Corre primero, en la misma transacción que semilla.sql o quitar.sql (y
-- resumen.sql y devolver.sql al final). Lo pone
-- todo bob-demo.sh; los tests lo corren igual, por node, dentro de una
-- transacción que deshacen.
--
-- Lee tres ajustes de la transacción, que pone quien llama:
--   bob_demo.caja     el destino declarado: 'lab-02' o 'local'. Nada más.
--   bob_demo.tenant   el slug de la única organización de la caja (bzzz.tenant).
--   bob_demo.accion   'sembrar' o 'quitar'.
--
-- Se niega, y no queda nada escrito, cuando:
--   G1  el destino no es una caja de laboratorio;
--   G2  falta la acción o el tenant;
--   G3  la base no tiene exactamente una organización, o no es la del tenant
--       (una caja, una organización: P5, objeción 3);
--   G4  quien corre no puede leer todas las filas (sin BYPASSRLS la guarda
--       contaría bajo RLS y vería cero), o es un rol de la API;
--   G5  quien corre no puede bajar a bob_app y a bob_feeder para escribir, ni
--       tomar su membresía prestada para esta transacción (devolver.sql la quita);
--   G6  (solo al sembrar) hay datos que no son de la semilla: una fila de
--       cualquier proyección de cualquier organización con otro feeder_version,
--       o una fila en bob.interactions;
--   G7  (solo al sembrar) un canal o un actor usa un nombre de la semilla sin
--       llevar su marca.
-- Si todo pasa, deja bob_demo.guarda = 'pasada' solo para esta transacción. La
-- semilla y el borrado se niegan sin esa marca: no corren sin las guardas, ni
-- fuera de una transacción.
--
-- La marca de la semilla, la misma en los tres ficheros:
--   proyecciones  feeder_version = 'bob-demo/1'
--   canales       source_key 'demo-…', adapter_kind 'synthetic', config.bob_demo
--   actores       display_id 'demo-…', attributes.bob_demo
-- ════════════════════════════════════════════════════════════════════════════

DO $guardas$
DECLARE
  marca   CONSTANT text := 'bob-demo/1';
  caja    text := nullif(current_setting('bob_demo.caja', true), '');
  tenant  text := nullif(current_setting('bob_demo.tenant', true), '');
  accion  text := nullif(current_setting('bob_demo.accion', true), '');
  n       bigint;
  t       record;
  ajenas  text[] := '{}';
BEGIN
  -- G1
  IF caja IS NULL OR caja NOT IN ('lab-02', 'local') THEN
    RAISE EXCEPTION 'bob-demo G1: el destino % no es una caja de laboratorio (solo lab-02 o local)',
      coalesce(caja, '(ninguno)');
  END IF;

  -- G2
  IF accion IS NULL OR accion NOT IN ('sembrar', 'quitar') THEN
    RAISE EXCEPTION 'bob-demo G2: la acción % no es sembrar ni quitar', coalesce(accion, '(ninguna)');
  END IF;
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'bob-demo G2: falta el tenant de la caja (bzzz.tenant)';
  END IF;

  -- G4, antes de contar nada
  IF session_user IN ('service_role', 'authenticator', 'anon', 'authenticated')
     OR current_user IN ('service_role', 'authenticator', 'anon', 'authenticated') THEN
    RAISE EXCEPTION 'bob-demo G4: % es un rol de la API; la semilla nunca corre con él', session_user;
  END IF;
  IF NOT (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'bob-demo G4: % no ve todas las filas (sin BYPASSRLS); la guarda contaría bajo RLS', current_user;
  END IF;

  -- G5. La cadena no hace a postgres miembro de bob_app ni de bob_feeder. Si
  -- no lo es, la membresía se presta para esta transacción y devolver.sql la
  -- quita antes del COMMIT; si algo falla, el ROLLBACK la quita igual. El rol
  -- va por su nombre: `GRANT … TO current_user` tumba el servidor de la caja
  -- (F-35).
  BEGIN
    IF NOT pg_has_role(current_user, 'bob_app', 'MEMBER') THEN
      EXECUTE format('GRANT bob_app TO %I', current_user);
      PERFORM set_config('bob_demo.prestado', concat_ws(',',
        nullif(current_setting('bob_demo.prestado', true), ''), 'bob_app'), true);
    END IF;
    IF NOT pg_has_role(current_user, 'bob_feeder', 'MEMBER') THEN
      EXECUTE format('GRANT bob_feeder TO %I', current_user);
      PERFORM set_config('bob_demo.prestado', concat_ws(',',
        nullif(current_setting('bob_demo.prestado', true), ''), 'bob_feeder'), true);
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'bob-demo G5: % no puede bajar a bob_app y a bob_feeder (%)', current_user, SQLERRM;
  END;

  -- G3
  SELECT count(*) INTO n FROM bob.organizations;
  IF n <> 1 THEN
    RAISE EXCEPTION 'bob-demo G3: la base tiene % organizaciones; la semilla solo corre en una caja con una', n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bob.organizations o WHERE o.slug = tenant) THEN
    RAISE EXCEPTION 'bob-demo G3: la organización de la caja no es %', tenant;
  END IF;

  IF accion = 'sembrar' THEN
    -- G6. Las proyecciones se descubren, no se enumeran: toda tabla particionada
    -- de `bob` con feeder_version.
    FOR t IN
      SELECT format('%I.%I', n2.nspname, c.relname) AS tabla
        FROM pg_class c JOIN pg_namespace n2 ON n2.oid = c.relnamespace
       WHERE n2.nspname = 'bob' AND c.relkind = 'p' AND NOT c.relispartition
         AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'feeder_version'
                        AND NOT a.attisdropped)
       ORDER BY 1
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE feeder_version IS DISTINCT FROM $1', t.tabla)
        INTO n USING marca;
      IF n > 0 THEN ajenas := ajenas || format('%s (%s)', t.tabla, n); END IF;
    END LOOP;
    SELECT count(*) INTO n FROM bob.interactions;
    IF n > 0 THEN ajenas := ajenas || format('bob.interactions (%s)', n); END IF;
    IF cardinality(ajenas) > 0 THEN
      RAISE EXCEPTION 'bob-demo G6: la base ya tiene datos que no son de la semilla: %',
        array_to_string(ajenas, ', ');
    END IF;

    -- G7
    IF EXISTS (SELECT 1 FROM bob.channels c
                WHERE c.source_key LIKE 'demo-%'
                  AND (c.adapter_kind IS DISTINCT FROM 'synthetic'
                       OR (c.config ->> 'bob_demo') IS DISTINCT FROM 'true')) THEN
      RAISE EXCEPTION 'bob-demo G7: hay un canal con source_key demo-… sin la marca de la semilla';
    END IF;
    IF EXISTS (SELECT 1 FROM bob.actors a
                WHERE a.display_id LIKE 'demo-%'
                  AND (a.attributes ->> 'bob_demo') IS DISTINCT FROM 'true') THEN
      RAISE EXCEPTION 'bob-demo G7: hay un actor con display_id demo-… sin la marca de la semilla';
    END IF;
  END IF;

  PERFORM set_config('bob_demo.guarda', 'pasada', true);
  RAISE NOTICE 'bob-demo: guardas pasadas (caja %, tenant %, %)', caja, tenant, accion;
END
$guardas$;
