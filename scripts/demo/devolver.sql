-- Semilla demo de BOb · devuelve la membresía que guardas.sql prestó (G5).
-- Corre al final, antes del COMMIT, con el rol que se conectó. Quita solo la
-- concesión que se hizo en esta transacción, la que lleva a quien corre como
-- concedente (GRANTED BY): una membresía que ya existía, como la de
-- supabase_admin sin SET en la imagen de la caja, se queda como estaba.
DO $$
DECLARE
  r     text;
  quien text := nullif(current_setting('bob_demo.prestado_a', true), '');
BEGIN
  IF quien IS DISTINCT FROM current_user
     AND nullif(current_setting('bob_demo.prestado', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'bob-demo: devolver.sql corre con %, pero la membresía se prestó a %', current_user, quien;
  END IF;
  FOREACH r IN ARRAY string_to_array(nullif(current_setting('bob_demo.prestado', true), ''), ',')
  LOOP
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', r, quien, quien);
    RAISE NOTICE 'bob-demo: membresía de % devuelta', r;
  END LOOP;
  PERFORM set_config('bob_demo.prestado', '', true);
END $$;
