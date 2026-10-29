// Test-suite database helpers.
//
// Connects to the Supabase CLI local stack (D-23 / Q10). The tenancy tests must
// run against the policies we actually ship, and a plain Postgres container has
// no auth.jwt(), no `authenticated` role and no supabase_auth_admin — it would
// test a reconstruction of the policies rather than the policies.

import pg from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..')

const CONNECTION =
  process.env.SUPABASE_DB_URL ||
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

export const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001'
export const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002'
export const USER_A = 'aaaaaaaa-1111-4000-8000-000000000001'

export async function connect() {
  const client = new pg.Client({ connectionString: CONNECTION })
  await client.connect()

  // Every test file loads fixtures into the SAME database, and fixture loading
  // deletes before it inserts. Run two files at once and they deadlock — and
  // node's runner reports the casualties as `cancelledByParent`, which does not
  // increment the failure count. The suite then reads green while a third of it
  // never ran, which is the exact failure ID-12 exists to prevent.
  //
  // The npm scripts pass --test-concurrency=1. This lock is the second layer,
  // so that someone changing that flag later gets a slow suite rather than a
  // dishonest one. Session-scoped: released when the connection closes.
  await client.query('SELECT pg_advisory_lock(hashtext($1))', ['bob-test-fixtures'])
  return client
}

// Load the two-tenant fixture. Idempotent across runs within one suite: the
// suite owns the database and resets it before starting.
export async function loadFixture(client) {
  const sql = readFileSync(
    resolve(REPO_ROOT, 'supabase/tests/fixtures/two_orgs.sql'),
    'utf8',
  )
  await client.query('BEGIN')
  await clearTenants(client)
  await client.query(sql)
  await client.query('COMMIT')
}

// Remove both test tenants without naming their tables. Deleting the
// organisations cascades through every foreign key to them; the sweep after it
// reaches the tables that carry org_id with no such key, which the cascade
// cannot see. A table added later is cleared without anyone extending a list.
async function clearTenants(client) {
  const tenants = [TENANT_A, TENANT_B]
  await client.query(
    `DELETE FROM ${await organizationsTable(client)} WHERE id = ANY($1::uuid[])`,
    [tenants])
  for (const t of await tenantTables(client)) {
    await client.query(
      `DELETE FROM ${t.qualified} WHERE org_id = ANY($1::uuid[])`, [tenants])
  }
}

// Found, not assumed to be in `public`, for the same reason as tenantTables.
async function organizationsTable(client) {
  const { rows } = await client.query(`
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'organizations' AND c.relkind IN ('r', 'p')
       AND n.nspname NOT LIKE 'pg\\_%'`)
  if (rows.length !== 1) {
    throw new Error(`expected one organizations table, found ${rows.length}`)
  }
  return rows[0].qualified
}

// The Slice 1 roster. Separate from the two-tenant fixture because the tenancy
// suite must keep running against the smallest possible fixture — a leak is
// easier to see in five rows than in eighty.
export async function loadRoster(client) {
  const sql = readFileSync(
    resolve(REPO_ROOT, 'supabase/tests/fixtures/roster.sql'),
    'utf8',
  )
  await client.query('BEGIN')
  await client.query(sql)
  await client.query('COMMIT')
}

// The five BR-3 rulings (F-07). Separate from the two-tenant fixture for the
// same reason as the roster: the tenancy suite keeps its smallest fixture.
// loadFixture deletes every autobotz row in both tenants, so reloading after it
// is idempotent.
export async function loadBr3Rulings(client) {
  const sql = readFileSync(
    resolve(REPO_ROOT, 'supabase/tests/fixtures/autobotz_br3.sql'),
    'utf8',
  )
  await client.query('BEGIN')
  await client.query(sql)
  await client.query('COMMIT')
}

// Run a function as `authenticated` carrying a tenant's JWT claims, exactly the
// way PostgREST does. Always rolled back: a tenancy test must not be able to
// leave state behind that a later tenancy test then reads.
export async function asTenant(client, orgId, fn) {
  await client.query('BEGIN')
  try {
    const claims = JSON.stringify({
      org_id: orgId,
      sub: USER_A,
      role: 'authenticated',
      app_role: 'admin',
    })
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      claims,
    ])
    await client.query('SET LOCAL ROLE authenticated')
    return await fn()
  } finally {
    await client.query('ROLLBACK')
  }
}

// Every table that carries an org_id, in whatever schema it lives. Discovered,
// never listed: a table added later without RLS must fail this suite without
// anyone remembering to extend an array.
//
// The schema is discovered too. Slice 2 moves the tables from `public` to `bob`,
// and a query pinned to 'public' would then return nothing and every assertion
// would loop over zero tables and pass. Only the catalog schemas are left out,
// by prefix, so a schema nobody has heard of yet is included by default.
//
// `qualified` is quoted and schema-qualified, ready to interpolate.
export async function tenantTables(client) {
  const { rows } = await client.query(`
    SELECT n.nspname AS table_schema,
           c.relname AS table_name,
           format('%I.%I', n.nspname, c.relname) AS qualified,
           c.relrowsecurity  AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           (SELECT count(*)::int FROM pg_policies p
             WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT LIKE 'pg\\_%'
       AND n.nspname <> 'information_schema'
       AND c.relkind IN ('r', 'p')
       AND EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'org_id'
            AND NOT a.attisdropped)
     ORDER BY n.nspname, c.relname`)
  return rows
}

// The floor under tenantTables. A discovery that finds nothing passes every
// check that loops over what it found, so the suite asserts these are in the
// set wherever they live. They are the tables the tenancy tests and the
// two-tenant fixture name; the list is a lower bound, not the set, and a table
// missing from it is still discovered and still checked.
export const TENANCY_FLOOR = [
  'actors', 'autobotz', 'channel_actor_mix', 'channels',
  'notification_channels', 'users',
]
