-- ════════════════════════════════════════════════════════════════════════════
-- BOb v1 · BR-3 / D-10 · close the NOT VALID exemption on autobotz.mutative
--
-- 20260902100000 added autobotz_mutative_declared as NOT VALID: enforced on
-- every INSERT and UPDATE, while rows that predated it stayed visibly unruled
-- instead of being defaulted to `false`. That migration named this step:
--
--   Once every row is ruled, this closes the exemption:
--     ALTER TABLE autobotz VALIDATE CONSTRAINT autobotz_mutative_declared;
--
-- RULED (23 Oct 2026): it ships here as a plain migration, and the five
-- BR-3 rulings of contract-amendments F-07 (superseded entry) go in as a test
-- fixture, supabase/tests/fixtures/autobotz_br3.sql. They are not seeded here.
-- A fixture in the migration chain is a fixture that reaches production.
--
-- Nothing is exempted anywhere today. The hosted bindings table held 0 rows on
-- 6 Sep, and BOb-engine's chain starts empty. If an unruled row does exist when
-- this runs, the migration stops and names it. It never rules on a row itself.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- VALIDATE would fail on an unruled row anyway, but only with the constraint's
-- name. Say which rows, and what to do, so the person reading the failure can
-- rule on each one rather than reach for a default.
DO $$
DECLARE unruled TEXT;
BEGIN
  SELECT string_agg(format('%s (%s, %s)', id, label, type), ', ' ORDER BY id)
    INTO unruled
    FROM autobotz
   WHERE mutative IS NULL;
  IF unruled IS NOT NULL THEN
    RAISE EXCEPTION
      'autobotz rows carry no BR-3 ruling: %. Set mutative on each, explicitly, '
      'before this migration can proceed.', unruled;
  END IF;
END $$;

ALTER TABLE autobotz VALIDATE CONSTRAINT autobotz_mutative_declared;

COMMIT;
