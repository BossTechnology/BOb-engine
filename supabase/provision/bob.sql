-- bob.sql — lo que la vecina `bob` necesita fuera de su esquema (D77 §2.8, 77.22). Lo aplica
-- scripts/generar-secretos-vecina.sh como `postgres`, dentro de la transaccion del alta y DESPUES de quitar los permisos
-- temporales, asi que aqui no se puede hacer nada que `postgres` no pueda por si mismo. Cada permiso de este fichero va
-- tambien en una linea FUERA= de bob.conf: V14 y V15 admiten exactamente eso. Sin BEGIN, COMMIT, SET ROLE ni
-- metacomandos de psql: el alta se niega a aplicarlo si los lleva.
--
-- bob.proj_ensure_partition es SECURITY DEFINER y, tras el traspaso, corre como bob_migrador. Llama a
-- public.bob_grant_projection(regclass), que es de `postgres` y tiene el EXECUTE quitado a PUBLIC: sin este permiso el
-- feeder fallaria con 42501 al crear la particion del primer mes nuevo (BOb-engine#48, supabase/provision/bob-vecina.sql).
--
-- En una caja nueva la funcion aun no existe (la crea la cadena de BOb): no se concede nada, y V15 no echa de menos lo
-- que FUERA declara sobre un objeto que no existe. Despues de la primera cadena de BOb se vuelve a correr el alta.
DO $$ BEGIN
  IF to_regprocedure('public.bob_grant_projection(regclass)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.bob_grant_projection(regclass) TO bob_migrador;
  END IF;
END $$;

-- scripts/instalar-bob.sh resto aplica cada migracion de BOb como bob_migrador y la anota en el historial de la CLI en
-- la MISMA transaccion: si una falla, no queda ni a medias ni anotada (BOb-engine#48). Para anotar, bob_migrador
-- necesita USAGE en supabase_migrations y INSERT en schema_migrations, nada mas: no lee ni cambia lo de otros. La tabla
-- la crea la primera cadena de BOb (supabase db push como postgres); en una caja nueva aun no existe y no se concede nada.
DO $$ BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA supabase_migrations TO bob_migrador;
    GRANT INSERT ON supabase_migrations.schema_migrations TO bob_migrador;
  END IF;
END $$;
