-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · F-44 · no role the application runs as can TRUNCATE
--
-- TRUNCATE does not go through row-level security. `authenticated` held it on
-- 26 tables in `bob` (organizations, users, actors, alert_log, interactions…),
-- handed out by Supabase's default privileges in `public` when the tables were
-- created there, and carried along by the move to `bob`. Nothing reached it
-- (PostgREST never issues TRUNCATE), but anything that ever ran SQL as
-- `authenticated` could have emptied every tenant's rows in one statement.
-- Ruled by Henry on 21 Nov: revoke, and stop handing it out.
--
-- Revoked from the five roles the application runs as, on every table in
-- `bob`. The default privileges the migration owner sets in `public` stop
-- giving TRUNCATE to anon and authenticated, so a table created there later
-- does not bring it back. Every other privilege is untouched.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA bob
  FROM PUBLIC, anon, authenticated, bob_app, bob_feeder, bob_ai_ro;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM anon, authenticated;

COMMIT;
