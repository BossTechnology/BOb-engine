-- What postgres does once on a box, before bob_migrador applies BOb's chain
-- (D77 §2.8). The proposal for Bzzz config/supabase/vecinas/bob.sql, measured
-- by scripts/owner-chain-check.mjs in CI (O-3). One statement per line group,
-- no bodies: the check applies them one at a time.

-- The owner. LOGIN; its password comes from the box's secret, never from here.
CREATE ROLE bob_migrador LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- On Postgres 15 the creator of a role is not its admin, and CREATE SCHEMA …
-- AUTHORIZATION needs membership in the owner.
GRANT bob_migrador TO postgres;

-- Its schema, so it needs no CREATE on the database.
CREATE SCHEMA bob AUTHORIZATION bob_migrador;

-- The three application roles, since bob_migrador has no CREATEROLE.
CREATE ROLE bob_app NOLOGIN;
CREATE ROLE bob_feeder NOLOGIN;
CREATE ROLE bob_ai_ro NOLOGIN;

-- O-3 sabotage, to be reverted: one grant D77 does not allow.
GRANT CREATE ON SCHEMA extensions TO bob_migrador;
