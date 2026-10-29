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

  test('no table carrying org_id returns another tenant\'s rows', async () => {
    const tables = await tenantTables(db)
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

describe('ID-11 · registry scope never crosses a tenant boundary', () => {
  // Company scope means THIS company. Provable in Slice 0 against
  // autobotz.scope_kind, which lands in migration 1.
  //
  // STATED GAP: notification_channels, threshold_configs, anomaly_rules and
  // text_rules do not gain scope columns until Migration Order Phase C, so
  // ID-11 is only partially covered here and completes in Slice 6. Recorded in
  // the Phase 0 Cut List rather than discovered later.
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
