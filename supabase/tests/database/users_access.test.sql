-- Who may sign in, in pgTAP: the shape tests/users-access.test.mjs exercises.
-- `supabase test db supabase/tests/database` runs this.
BEGIN;
SELECT plan(6);

SELECT policies_are('bob', 'users',
  ARRAY['app_reads_org_users', 'app_stamps_org_login', 'auth_admin_read_users', 'org_members_read_users'],
  'bob.users: members read, auth admin reads, bob_app reads and stamps a login');
SELECT policy_roles_are('bob', 'users', 'app_reads_org_users', ARRAY['bob_app'],
  'the read policy is bob_app''s');
SELECT ok(has_table_privilege('bob_app', 'bob.users', 'SELECT'), 'bob_app reads bob.users');
SELECT ok(NOT has_table_privilege('bob_app', 'bob.users', 'INSERT')
          AND NOT has_table_privilege('bob_app', 'bob.users', 'DELETE'),
  'bob_app neither creates nor deletes a user');
SELECT ok(has_column_privilege('bob_app', 'bob.users', 'last_login_at', 'UPDATE')
          AND NOT has_column_privilege('bob_app', 'bob.users', 'role', 'UPDATE'),
  'bob_app stamps last_login_at and cannot change a role');
SELECT hasnt_trigger('auth', 'users', 'on_auth_user_created',
  'signing up does not create a bob.users row');

SELECT * FROM finish();
ROLLBACK;
