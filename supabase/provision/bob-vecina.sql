-- What postgres does once on a box, before bob_migrador applies BOb's chain
-- (D77 §2.8; Bzzz config/supabase/vecinas/bob.sql). Under measurement for O-3:
-- each statement is applied on its own and reported if postgres cannot.
-- Statements tagged `-- probe:` are there to learn whether the chain needs
-- them, not because D77 allows them.

-- The owner. LOGIN; its password is set by the box's secret, never here.
CREATE ROLE bob_migrador LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- Its schema, so it needs no CREATE on the database.
CREATE SCHEMA bob AUTHORIZATION bob_migrador;

-- The three application roles, made by postgres, since bob_migrador has no CREATEROLE.
CREATE ROLE bob_app NOLOGIN;
CREATE ROLE bob_feeder NOLOGIN;
CREATE ROLE bob_ai_ro NOLOGIN;

-- Reads the chain makes of Supabase's own objects.
GRANT USAGE ON SCHEMA auth TO bob_migrador;

-- probe: the chain's first twenty migrations build in public.
GRANT USAGE, CREATE ON SCHEMA public TO bob_migrador WITH GRANT OPTION;
-- probe: 20260606120002 adds tables to the publication.
ALTER PUBLICATION supabase_realtime OWNER TO bob_migrador;
-- probe: 20260606120000 puts a trigger on auth.users.
GRANT TRIGGER ON auth.users TO bob_migrador;
