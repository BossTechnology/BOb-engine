// ID-10, ID-11 — tenancy. Build-blocking on every change (ID-12).
//
// "A leak in a metrics product exposes aggregates. A leak in BOb exposes an
// agent roster with per-person performance and a member population with
// behavioural history." Behavioural Rules §5.2.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  connect, loadFixture, asTenant, tenantTables, TENANCY_FLOOR, TENANT_A, TENANT_B,
} from './helpers/db.mjs'
import {
  structuralFindings, projectionGrantFindings, aggregateLeakFindings,
  feederStagingTables, tenantTablesUnreadableByApi,
  truncateFindings, truncateDefaultFindings,
} from './helpers/rls.mjs'

let db

before(async () => {
  db = await connect()
  await loadFixture(db)
})

after(async () => {
  await db?.end()
})

describe('ID-10 · every read and write is constrained to a single organisation', () => {
  // Every other test here loops over what discovery found. If it finds nothing,
  // they all pass while testing nothing, so this one fails first.
  test('discovery finds the tenant tables, wherever they live', async () => {
    const found = new Set((await tenantTables(db)).map((t) => t.table_name))
    const missing = TENANCY_FLOOR.filter((name) => !found.has(name))
    assert.deepEqual(
      missing, [],
      'tenantTables() did not find tables that carry org_id. The discovery is ' +
        'broken, not the schema, and every tenancy check below is looping over ' +
        `a set that is too small.\n  missing: ${missing.join(', ')}\n  found: ` +
        `${found.size} tables`,
    )
  })

  test('every table carrying org_id has RLS and a tenant-scoped policy', async () => {
    const findings = await structuralFindings(db)
    assert.deepEqual(
      findings, [],
      'structural tenancy findings:\n' +
        findings.map((f) => `  ${f.table} — ${f.finding}`).join('\n'),
    )
  })

  // A table `authenticated` cannot read at all cannot leak to it, and reading
  // it as `authenticated` would only raise. The checks below leave such tables
  // out, so this one pins the set: the feeder staging tables (P5 Q6 (a)), found
  // by their grants, and nothing else. A table that loses its grant by accident
  // shows up here rather than vanishing from the leak checks.
  test('the tables the API cannot read are the feeder staging tables, and only those', async () => {
    const hidden = (await tenantTablesUnreadableByApi(db)).map((t) => t.qualified)
    const staging = (await feederStagingTables(db)).map((t) => t.qualified)
    assert.ok(staging.length > 0, 'no staging table found, so the exclusion is untested')
    assert.deepEqual(hidden, staging)
  })

  test('no table carrying org_id returns another tenant\'s rows', async () => {
    const hidden = new Set((await tenantTablesUnreadableByApi(db)).map((t) => t.qualified))
    const tables = (await tenantTables(db)).filter((t) => !hidden.has(t.qualified))
    const leaks = []

    await asTenant(db, TENANT_A, async () => {
      for (const t of tables) {
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM ${t.qualified}
            WHERE org_id <> $1`, [TENANT_A])
        if (rows[0].n > 0) leaks.push(`${t.table_name}: ${rows[0].n} rows`)
      }
    })

    assert.deepEqual(leaks, [], `cross-tenant rows visible:\n  ${leaks.join('\n  ')}`)
  })

  // The same, as the role bob-web runs as in the box: bob_app under one
  // tenant's claim. Discovered tables, so a table added later is covered.
  test('as bob_app, no table carrying org_id returns another tenant\'s rows', async () => {
    const tables = await tenantTables(db)
    const leaks = []
    await db.query('GRANT bob_app TO current_user')
    try {
      await db.query('BEGIN')
      await db.query('SELECT set_config($1, $2, true)',
        ['request.jwt.claims', JSON.stringify({ org_id: TENANT_A })])
      await db.query('SET LOCAL ROLE bob_app')
      for (const t of tables) {
        await db.query('SAVEPOINT t')
        try {
          const { rows } = await db.query(
            `SELECT count(*)::int AS n FROM ${t.qualified} WHERE org_id <> $1`, [TENANT_A])
          if (rows[0].n > 0) leaks.push(`${t.table_name}: ${rows[0].n} rows`)
          await db.query('RELEASE SAVEPOINT t')
        } catch (e) {
          // Not granted to bob_app at all: nothing to leak.
          if (e.code !== '42501') throw e
          await db.query('ROLLBACK TO SAVEPOINT t')
        }
      }
    } finally {
      await db.query('ROLLBACK')
      await db.query('REVOKE bob_app FROM current_user')
    }
    assert.deepEqual(leaks, [], `cross-tenant rows visible to bob_app:\n  ${leaks.join('\n  ')}`)
  })

  // The case that gets missed. A count that leaks a magnitude has leaked, and
  // the rule names aggregates explicitly for that reason. Every discovered
  // table, not a list of four: Slice 2's projections are exactly the
  // aggregates.
  test('aggregates do not leak across the boundary', async () => {
    await db.query('BEGIN')
    try {
      const { otherRows, findings } = await aggregateLeakFindings(db, TENANT_A, TENANT_B)

      // A leak is only visible where the other tenant has rows to leak.
      assert.ok(otherRows > 0,
        'tenant B owns no rows, so no aggregate could show a leak. The fixture ' +
        'is not exercising this test')
      assert.deepEqual(findings, [],
        'an aggregate crossed the boundary:\n' +
          findings.map((f) => `  ${f.table} — ${f.finding}`).join('\n'))
    } finally {
      await db.query('ROLLBACK')
    }
  })

  test('a write carrying another tenant\'s org_id is rejected, not accepted', async () => {
    let rejected = false
    try {
      await asTenant(db, TENANT_A, async () => {
        await db.query(
          `INSERT INTO channels (org_id, channel_type, display_name, source_key)
           VALUES ($1, 'chat', 'Smuggled', 'smuggled')`, [TENANT_B])
      })
    } catch (e) {
      rejected = /row-level security|permission denied/i.test(e.message)
    }
    assert.ok(rejected, 'insert into another tenant was not rejected by policy')
  })

  test('an update cannot move a row across the boundary', async () => {
    let rejected = false
    try {
      await asTenant(db, TENANT_A, async () => {
        await db.query(
          `UPDATE channels SET org_id = $1 WHERE org_id = $2`,
          [TENANT_B, TENANT_A])
      })
    } catch (e) {
      rejected = /row-level security|permission denied/i.test(e.message)
    }
    assert.ok(rejected, 'a row could be reassigned to another tenant')
  })

  test('a tenant cannot read another tenant\'s organisation record', async () => {
    const rows = await asTenant(db, TENANT_A, async () => {
      const { rows } = await db.query('SELECT id, slug FROM organizations')
      return rows
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, TENANT_A)
  })
})

describe('F-44 · no role the application runs as can TRUNCATE a tenant table', () => {
  test('none holds TRUNCATE on a table carrying org_id, in any schema', async () => {
    const findings = await truncateFindings(db)
    assert.deepEqual(findings.map((f) => f.finding), [])
  })

  test('the migration owner\'s default privileges hand TRUNCATE to none of them', async () => {
    assert.deepEqual(await truncateDefaultFindings(db), [])
  })
})

describe('ID-11 · registry scope never crosses a tenant boundary', () => {
  // Company scope means THIS company. Slice 0 could prove it only for
  // autobotz; Slice 6 gives threshold_configs, anomaly_rules and text_rules
  // their scope columns (F-05), so the check runs over every table that carries
  // scope_kind, found in the catalog. A registry that gains scope later is
  // checked without anyone extending a list.
  async function scopedRegistries() {
    const { rows } = await db.query(`
      SELECT format('%I.%I', c.table_schema, c.table_name) AS qualified, c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.column_name = 'scope_kind' AND t.table_type = 'BASE TABLE'
         AND c.table_schema NOT LIKE 'pg\\_%' AND c.table_schema <> 'information_schema'
       ORDER BY 1`)
    return rows
  }
  const SCOPE_FLOOR = ['anomaly_rules', 'autobotz', 'text_rules', 'threshold_configs']

  test('discovery finds every scoped registry, and each is a tenant table', async () => {
    const found = await scopedRegistries()
    const names = new Set(found.map((r) => r.table_name))
    assert.deepEqual(SCOPE_FLOOR.filter((n) => !names.has(n)), [],
      'scope discovery is broken: a registry with scope_kind was not found')
    const tenant = new Set((await tenantTables(db)).map((t) => t.qualified))
    assert.deepEqual(found.filter((r) => !tenant.has(r.qualified)).map((r) => r.qualified), [],
      'a scoped registry carries no org_id, so its company scope means every company')
  })

  test('company scope resolves within one tenant only, in every scoped registry', async () => {
    const leaks = []
    for (const r of await scopedRegistries()) {
      const { rows: [other] } = await db.query(
        `SELECT count(*)::int AS n FROM ${r.qualified} WHERE scope_kind = 'company' AND org_id = $1`,
        [TENANT_B])
      assert.ok(other.n > 0, `${r.table_name}: tenant B has no company-scoped row, so no leak could show`)
      const seen = await asTenant(db, TENANT_A, async () => (await db.query(
        `SELECT count(*)::int AS n FROM ${r.qualified}
          WHERE scope_kind = 'company' AND org_id <> $1`, [TENANT_A])).rows[0].n)
      if (seen > 0) leaks.push(`${r.table_name}: ${seen}`)
    }
    assert.deepEqual(leaks, [], 'company scope reached beyond this company')
  })

  test('company-scoped AutoBotz bindings resolve within one tenant only', async () => {
    const rows = await asTenant(db, TENANT_A, async () => {
      const { rows } = await db.query(
        `SELECT id, org_id, label FROM autobotz WHERE scope_kind = 'company'`)
      return rows
    })
    assert.equal(rows.length, 1, 'company scope reached beyond this company')
    assert.equal(rows[0].org_id, TENANT_A)
  })

  test('company-scoped AutoComm entries resolve within one tenant only', async () => {
    const rows = await asTenant(db, TENANT_A, async () => {
      const { rows } = await db.query(
        'SELECT id, org_id FROM notification_channels')
      return rows
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].org_id, TENANT_A)
  })
})

describe('PR-4 · BOb never writes a projection table', () => {
  // Vacuous until Slice 2. Present now so that the eight projection tables
  // cannot be created without it, rather than being retrofitted after one of
  // them has already been granted by hand.
  test('no projection table is writable by the application', async () => {
    const findings = await projectionGrantFindings(db)
    assert.deepEqual(
      findings, [],
      findings.map((f) => `  ${f.table} — ${f.finding}`).join('\n'),
    )
  })
})
