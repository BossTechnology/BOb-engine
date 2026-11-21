-- F-43 in pgTAP: the audit trail is read by bob_app and written outside the
-- application. `supabase test db supabase/tests/database` runs this.
BEGIN;
SELECT plan(2);

SELECT ok(has_table_privilege('bob_app', 'bob.audit_log', 'SELECT'), 'bob_app reads bob.audit_log');
SELECT ok(NOT has_any_column_privilege('bob_app', 'bob.audit_log', 'INSERT')
          AND NOT has_any_column_privilege('bob_app', 'bob.audit_log', 'UPDATE')
          AND NOT has_table_privilege('bob_app', 'bob.audit_log', 'DELETE')
          AND NOT has_table_privilege('bob_app', 'bob.audit_log', 'TRUNCATE'),
  'bob_app writes nothing to bob.audit_log');

SELECT * FROM finish();
ROLLBACK;
