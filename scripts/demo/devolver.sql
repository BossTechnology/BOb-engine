-- Semilla demo de BOb · devuelve la membresía que guardas.sql prestó (G5).
-- Corre al final, antes del COMMIT, con el rol que se conectó. Quita solo lo
-- que se prestó en esta transacción; una membresía que ya existía se queda.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY string_to_array(nullif(current_setting('bob_demo.prestado', true), ''), ',')
  LOOP
    EXECUTE format('REVOKE %I FROM %I', r, current_user);
    RAISE NOTICE 'bob-demo: membresía de % devuelta', r;
  END LOOP;
END $$;
