// P5 (D62) §6.3 · the role guards Slice 2 did not build, and the box check of
// §8, objection 3.
//
// Each was seen failing on purpose before it was trusted; the table is in
// contract-amendments.md, "P5 · The role guards, built". The queries live in
// scripts/box-checks.mjs, so the box runs the same SQL that is tested here.
//
// Everything that changes something does so inside a transaction and rolls
// back.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { execFile } from 'node:child_process'
import {
  connect, loadFixture, tenantTables, TENANCY_FLOOR, TENANT_A, DB_URL, REPO_ROOT,
} from './helpers/db.mjs'
import {
  BOB_ROLES, rolesWithPrivilegeInBob, threeRolesFindings, egressFunctions,
  egressFindings, oneOrganizationFindings,
} from '../scripts/box-checks.mjs'

let db

before(async () => {
  db = await connect()
  await loadFixture(db)
})
after(async () => { await db?.end() })

async function inTx(fn) {
  await db.query('BEGIN')
  try { return await fn() } finally { await db.query('ROLLBACK') }
}

// Run `sql` and return the SQLSTATE it raised, or null. Inside a savepoint, so
// the caller's transaction survives the error.
async function refusal(sql) {
  await db.query('SAVEPOINT probe')
  try {
    await db.query(sql)
    await db.query('RELEASE SAVEPOINT probe')
    return null
  } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT probe')
    return e.code || e.message
  }
}

// ── Three roles, no more ───────────────────────────────────────────────────
describe('P5 §6.3 · three roles, no more', () => {
  test('the roles holding anything in bob are Supabase\'s and the three, and none is privileged', async () => {
    assert.deepEqual(await threeRolesFindings(db), [])
  })

  // The guard compares a discovered set with the three. These keep it honest:
  // the discovery sees each of the three, and sees a fourth when there is one.
  test('discovery finds each of the three by itself', async () => {
    const found = (await rolesWithPrivilegeInBob(db)).map((r) => r.rolname)
    for (const role of BOB_ROLES) assert.ok(found.includes(role), `${role} not found`)
  })

  test('a fourth role, LOGIN or not, granted directly or by membership, is reported', async () => {
    await inTx(async () => {
      await db.query('CREATE ROLE p5_probe_direct NOLOGIN')
      await db.query('GRANT SELECT ON bob.channels TO p5_probe_direct')
      await db.query('CREATE ROLE p5_probe_member LOGIN NOINHERIT')
      await db.query('GRANT bob_app TO p5_probe_member')
      const findings = await threeRolesFindings(db)
      assert.ok(findings.some((f) => f.startsWith('p5_probe_direct ')), findings.join('\n'))
      assert.ok(findings.some((f) => f.startsWith('p5_probe_member (LOGIN)')), findings.join('\n'))
    })
  })

  test('the empty discovery is an error, not a green set', async () => {
    await assert.rejects(rolesWithPrivilegeInBob(db, 'p5_no_such_schema'), /no role holds anything/)
  })
})

// ── bob_ai_ro reads views only (IR-1) ──────────────────────────────────────
// Every base table and partition in every schema BOb or Supabase made, found.
async function baseTables() {
  const { rows } = await db.query(`
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified, c.relname,
           (SELECT format('%I', a.attname) FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum LIMIT 1) AS first_column
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
     ORDER BY 1`)
  return rows
}

async function aiViews() {
  const { rows } = await db.query(`
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('v', 'm') AND c.relname LIKE 'v\\_ai\\_%'
     ORDER BY 1`)
  return rows.map((r) => r.qualified)
}

describe('P5 §6.3 · bob_ai_ro reads views only (IR-1)', () => {
  // A discovery that finds nothing passes every loop over what it found. The
  // tenancy floor must be in the set, and every org_id table with it.
  test('the base tables found include every tenant table', async () => {
    const found = new Set((await baseTables()).map((t) => t.qualified))
    const tenant = await tenantTables(db)
    for (const name of TENANCY_FLOOR) {
      assert.ok(tenant.some((t) => t.table_name === name), `${name} is not a tenant table`)
    }
    for (const t of tenant) assert.ok(found.has(t.qualified), `${t.qualified} not found`)
  })

  test('as bob_ai_ro, every base table refuses SELECT', async () => {
    const tables = await baseTables()
    await inTx(async () => {
      await db.query('GRANT bob_ai_ro TO current_user')
      await db.query('SET LOCAL ROLE bob_ai_ro')
      const readable = []
      for (const t of tables) {
        if (await refusal(`SELECT 1 FROM ${t.qualified} LIMIT 1`) === null) readable.push(t.qualified)
      }
      assert.deepEqual(readable, [], 'bob_ai_ro reads a base table')
    })
  })

  test('as bob_ai_ro, every base table refuses UPDATE', async () => {
    const tables = await baseTables()
    await inTx(async () => {
      await db.query('GRANT bob_ai_ro TO current_user')
      await db.query('SET LOCAL ROLE bob_ai_ro')
      const accepted = []
      for (const t of tables.filter((x) => x.first_column)) {
        // SET to DEFAULT and WHERE false read no column, so the UPDATE grant
        // is all that is asked for. `SET c = c` also needs SELECT on c, and
        // was refused for that even with UPDATE granted (seen blind).
        const code = await refusal(
          `UPDATE ${t.qualified} SET ${t.first_column} = DEFAULT WHERE false`)
        if (code !== '42501') accepted.push(`${t.qualified}: ${code ?? 'accepted'}`)
      }
      assert.deepEqual(accepted, [], 'bob_ai_ro is not refused an UPDATE')
    })
  })

  // The UPDATE above probes one column per table. A grant on another column,
  // or of INSERT, DELETE or TRUNCATE, is read from the catalog instead.
  test('bob_ai_ro holds no write privilege on any relation, on any column', async () => {
    const { rows } = await db.query(`
      SELECT format('%I.%I', n.nspname, c.relname) AS qualified
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
         AND (has_any_column_privilege('bob_ai_ro', c.oid, 'UPDATE')
              OR has_table_privilege('bob_ai_ro', c.oid, 'INSERT, DELETE, TRUNCATE'))
       ORDER BY 1`)
    assert.deepEqual(rows.map((r) => r.qualified), [], 'bob_ai_ro can write')
  })

  // No v_ai_* view exists yet (P5 §3.2). An absent set must not pass as a
  // checked one: while there is none, bob_ai_ro reads nothing at all, and the
  // day one appears this test asks for the views to be readable and for
  // nothing else to be.
  test('bob_ai_ro reads exactly the v_ai_* views, and today that is none', async (t) => {
    const views = await aiViews()
    const { rows } = await db.query(`
      SELECT format('%I.%I', n.nspname, c.relname) AS qualified
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
         AND has_table_privilege('bob_ai_ro', c.oid, 'SELECT')
         AND has_schema_privilege('bob_ai_ro', n.oid, 'USAGE')
       ORDER BY 1`)
    t.diagnostic(`v_ai_* views: ${views.length}`)
    assert.deepEqual(rows.map((r) => r.qualified), views)
  })
})

// ── No egress from the database ────────────────────────────────────────────
describe('P5 §6.3 · no egress from the database', () => {
  test('nothing outside the approved list is installed: extensions, foreign servers, untrusted languages', async (t) => {
    const fns = await egressFunctions(db)
    t.diagnostic(`egress functions installed: ${fns.length}`)
    assert.deepEqual(await egressFindings(db), [])
  })

  // Neither extension is installed in CI, so the test above reads an empty
  // set. Installed here and rolled back: pg_net where it always goes, http in
  // a schema nobody would guess, so "wherever they are installed" is tried.
  const installed = (fn) => inTx(async () => {
    await db.query('CREATE EXTENSION pg_net')
    await db.query('CREATE SCHEMA p5_odd')
    await db.query('CREATE EXTENSION http SCHEMA p5_odd')
    return fn()
  })

  test('the guard sees both extensions\' functions, wherever they are installed', async () => {
    await installed(async () => {
      const fns = await egressFunctions(db)
      const where = [...new Set(fns.map((f) => `${f.extname}:${f.schema}`))].sort()
      assert.deepEqual(where, ['http:p5_odd', 'pg_net:net'])
    })
  })

  // F-27, closed by (c). Installing either one hands EXECUTE on every function
  // to PUBLIC, so all three can call them; pg_net also hands out its queue
  // tables. "Not granted" (P5 §3.2) does not hold once installed, only "not
  // installed", so the guard refuses the install itself, wherever it lands.
  test('installed anywhere, the guard reports each extension', async () => {
    await installed(async () => {
      const findings = await egressFindings(db)
      // pg_net's own schema is wherever CREATE EXTENSION ran (its functions go
      // to `net` regardless), so only http's is pinned.
      for (const where of ['http is installed (in p5_odd)', 'pg_net is installed (in ']) {
        assert.ok(findings.some((f) => f.startsWith(where)),
          `"${where}" went unreported: ${JSON.stringify(findings.slice(0, 3))}`)
      }
    })
  })

  // The review of PR #44: naming two extensions leaves every other way out
  // open. The guard fails closed on what is not approved, so each of these is
  // installed for real and rolled back.
  test('dblink, installed, fails the guard', async () => {
    await inTx(async () => {
      await db.query('CREATE EXTENSION dblink')
      const findings = await egressFindings(db)
      assert.ok(findings.some((f) => f.startsWith('dblink is installed')),
        `dblink went unreported: ${JSON.stringify(findings.slice(0, 3))}`)
    })
  })

  // Not named anywhere as egress. Outside the approved list is enough.
  test('an extension nobody named, outside the approved list, fails the guard', async () => {
    await inTx(async () => {
      await db.query('CREATE EXTENSION fuzzystrmatch')
      const findings = await egressFindings(db)
      assert.ok(findings.some((f) => f.startsWith('fuzzystrmatch is installed')),
        `an unapproved extension went unreported: ${JSON.stringify(findings.slice(0, 3))}`)
    })
  })

  test('a foreign server fails the guard', async () => {
    await inTx(async () => {
      await db.query('CREATE EXTENSION postgres_fdw')
      await db.query(`CREATE SERVER p5_probe_srv FOREIGN DATA WRAPPER postgres_fdw
                        OPTIONS (host 'example.invalid')`)
      const findings = await egressFindings(db)
      assert.ok(findings.some((f) => f.startsWith('foreign server p5_probe_srv')),
        `a foreign server went unreported: ${JSON.stringify(findings.slice(0, 3))}`)
    })
  })

  // Only a superuser creates a language, and `postgres` is not one on
  // Supabase, so this probe runs as the local stack's supabase_admin, in its
  // own transaction, rolled back.
  test('an untrusted language fails the guard', async () => {
    const url = new URL(process.env.SUPABASE_DB_URL ||
      'postgresql://postgres:postgres@127.0.0.1:54322/postgres')
    url.username = 'supabase_admin'
    const admin = new pg.Client({ connectionString: url.href })
    await admin.connect()
    try {
      await admin.query('BEGIN')
      await admin.query('CREATE LANGUAGE p5_probe_untrusted HANDLER plpgsql_call_handler')
      const findings = await egressFindings(admin)
      assert.ok(findings.some((f) => f.startsWith('untrusted language p5_probe_untrusted')),
        `an untrusted language went unreported: ${JSON.stringify(findings.slice(0, 3))}`)
    } finally {
      await admin.query('ROLLBACK').catch(() => {})
      await admin.end()
    }
  })
})

// ── One organization per box (objection 3) ─────────────────────────────────
// The check is the box's (scripts/box-check.mjs), not the suite's: the
// fixture holds two tenants on purpose. Here it is seen refusing that, and
// passing only where a box would.
describe('P5 objection 3 · the box check: one organization, slug = bzzz.tenant', () => {
  test('refuses the two-tenant fixture', async () => {
    const findings = await oneOrganizationFindings(db, 'tenant-a')
    assert.ok(findings.some((f) => /holds 2 rows/.test(f)), findings.join('\n'))
  })

  // loadFixture cleared the projections, the only tables whose keys to an
  // organization do not cascade, so the delete goes through.
  const alone = (fn) => inTx(async () => {
    await db.query('DELETE FROM bob.organizations WHERE id <> $1', [TENANT_A])
    return fn()
  })

  test('passes with one organization whose slug is the box tenant', async () => {
    await alone(async () => assert.deepEqual(await oneOrganizationFindings(db, 'tenant-a'), []))
  })

  test('refuses one organization whose slug is another tenant', async () => {
    await alone(async () => {
      const findings = await oneOrganizationFindings(db, 'tenant-b')
      assert.ok(findings.some((f) => /slug tenant-a, the box tenant is tenant-b/.test(f)), findings.join('\n'))
    })
  })

  test('refuses no organization, and a missing box tenant', async () => {
    await inTx(async () => {
      await db.query('DELETE FROM bob.organizations')
      const findings = await oneOrganizationFindings(db, 'tenant-a')
      assert.ok(findings.some((f) => /holds 0 rows/.test(f)), findings.join('\n'))
    })
    assert.deepEqual(await oneOrganizationFindings(db, ''), ['the box tenant (bzzz.tenant) was not given'])
  })
})

// ── scripts/box-check.mjs, end to end ──────────────────────────────────────
// The functions above are what box-check.mjs runs; this runs the script itself,
// as the operator does, and reads its exit code. Against a scratch database on
// the same cluster, holding the least a box has (one organization, one active
// user, a staging run, the three roles), so that every other check is green and the exit code answers for
// egress alone. The suite's database cannot serve: its two tenants make "one
// organization" fail, and exit 1 would prove nothing. The script reads only
// the database it connects to (`pg_extension` is per database).
describe('P5 §6.3 · box-check.mjs exits 1 on an egress finding', () => {
  const SCRATCH = 'bob_box_check_e2e'
  const url = new URL(DB_URL)
  url.pathname = `/${SCRATCH}`

  const boxCheck = () => new Promise((done) => {
    execFile(process.execPath, [`${REPO_ROOT}/scripts/box-check.mjs`, '--tenant', 'cliente-demo'],
      { env: { ...process.env, BOX_DB_URL: url.toString() } },
      (error, stdout) => done({ code: error ? error.code : 0, stdout }))
  })

  test('green box: exit 0; an extension outside the list: FAIL and exit 1', async () => {
    await db.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`)
    await db.query(`CREATE DATABASE ${SCRATCH}`)
    const box = new pg.Client({ connectionString: url.toString() })
    await box.connect()
    try {
      await box.query(`
        CREATE SCHEMA bob;
        CREATE TABLE bob.organizations (id uuid PRIMARY KEY, slug text NOT NULL);
        CREATE TABLE bob.users (id uuid PRIMARY KEY, org_id uuid NOT NULL, active boolean NOT NULL);
        CREATE TABLE bob.member_refs_runs (org_id uuid NOT NULL, ran_at timestamptz NOT NULL);
        INSERT INTO bob.organizations VALUES ('${TENANT_A}', 'cliente-demo');
        INSERT INTO bob.users VALUES (gen_random_uuid(), '${TENANT_A}', true);
        INSERT INTO bob.member_refs_runs VALUES ('${TENANT_A}', now());
        GRANT USAGE ON SCHEMA bob TO ${BOB_ROLES.join(', ')};`)

      const green = await boxCheck()
      assert.match(green.stdout, /^ok +no egress from the database$/m, green.stdout)
      assert.equal(green.code, 0, `a green box did not exit 0:\n${green.stdout}`)

      await box.query('CREATE EXTENSION fuzzystrmatch')
      const red = await boxCheck()
      assert.match(red.stdout, /^FAIL +no egress from the database$/m, red.stdout)
      assert.match(red.stdout, /fuzzystrmatch is installed/, red.stdout)
      assert.equal(red.code, 1, `an egress finding did not exit 1:\n${red.stdout}`)
    } finally {
      await box.end()
      await db.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`)
    }
  })
})
