-- Who may sign in, in pgTAP: the shape tests/users-access.test.mjs exercises.
-- `supabase test db supabase/tests/database` runs this.
BEGIN;
SELECT plan(10);

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

-- Henry, 26 Nov («Alta sola, como viewer»): the one narrow door for bob_app.
SELECT has_function('bob', 'claim_viewer_seat', ARRAY['uuid', 'text'],
  'bob.claim_viewer_seat(uuid, text) exists');
SELECT is_definer('bob', 'claim_viewer_seat', ARRAY['uuid', 'text'],
  'it is SECURITY DEFINER, so bob_app needs no INSERT on bob.users');
SELECT function_privs_are('bob', 'claim_viewer_seat', ARRAY['uuid', 'text'], 'bob_app', ARRAY['EXECUTE'],
  'bob_app executes it');
SELECT ok(NOT has_function_privilege('anon', 'bob.claim_viewer_seat(uuid,text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'bob.claim_viewer_seat(uuid,text)', 'EXECUTE')
          AND NOT has_function_privilege('service_role', 'bob.claim_viewer_seat(uuid,text)', 'EXECUTE'),
  'anon, authenticated and service_role do not');

SELECT * FROM finish();
ROLLBACK;
