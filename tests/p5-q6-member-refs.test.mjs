// P5 Q6 (a) · the member refs the feeder stages, and who may touch them.
//
// Henry, 2026-11-21: the feeder container reads member_refs_seen from the
// truth store and writes it to bob.member_refs_seen; bob_app creates the
// ghosts from it (F-40, F-41). These are the guards on the table itself. The
// ghost path that runs through it is in slice2-feeder.test.mjs.
//
// Each was seen failing on purpose before it was trusted; the table is in
// contract-amendments.md, "P5 · Q6 (a), built". Everything that changes
// something does so inside a transaction and rolls back.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { connect, loadFixture, tenantTables, TENANT_A, TENANT_B } from './helpers/db.mjs'
import {
  feederStagingTables, stagingGrantFindings, projectionTables, projectionGrantFindings,
} from './helpers/rls.mjs'

let db

before(async () => {
  db = await connect()
  await loadFixture(db)
})
after(async () => { await db?.end() })

const TABLE = 'bob.member_refs_seen'
const CHANNEL_A = 'aaaaaaaa-2222-4000-8000-000000000001'   // tenant A
const CHANNEL_B = 'bbbbbbbb-2222-4000-8000-000000000002'   // tenant B

async function inTx(fn) {
  await db.query('BEGIN')
  try { return await fn() } finally { await db.query('ROLLBACK') }
}

async function becomeRole(role, orgId) {
  await db.query(`GRANT ${role} TO current_user`)
  if (orgId) {
    await db.query('SELECT set_config($1, $2, true)',
      ['request.jwt.claims', JSON.stringify({ org_id: orgId })])
  }
  await db.query(`SET LOCAL ROLE ${role}`)
}

async function refusal(sql, params = []) {
  await db.query('SAVEPOINT probe')
  try {
    await db.query(sql, params)
    await db.query('RELEASE SAVEPOINT probe')
    return null
  } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT probe')
    return e.code || e.message
  }
}

const stage = `
  INSERT INTO bob.member_refs_seen
    (org_id, channel_id, ref, first_seen, last_seen, window_from, window_to)
  VALUES ($1, $2, $3, '2026-11-18 14:05+00', '2026-11-18 14:06+00',
          '2026-11-18 14:00+00', '2026-11-18 14:30+00')`

// A staged row in each tenant, written as the migration owner.
async function seedBoth() {
  await db.query(stage, [TENANT_A, CHANNEL_A, 'm:q6-a'])
  await db.query(stage, [TENANT_B, CHANNEL_B, 'm:q6-b'])
}

// ── Found by discovery, held to its own rule ───────────────────────────────
describe('P5 Q6 (a) · the staging table is found by its grants, not listed', () => {
  test('member_refs_seen is a feeder staging table and a tenant table, not a projection', async () => {
    const staging = (await feederStagingTables(db)).map((t) => t.qualified)
    assert.deepEqual(staging, [TABLE])
    assert.ok((await tenantTables(db)).some((t) => t.qualified === TABLE), 'not a tenant table')
    assert.ok(!(await projectionTables(db)).some((t) => t.qualified === TABLE),
      'a staging table was taken for a projection')
  })

  test('every staging table holds exactly its grants', async () => {
    assert.deepEqual(await stagingGrantFindings(db), [])
  })

  // The guard above reads a set it discovered. These widen one grant at a
  // time and see it go red, so a green run means the grants are right.
  const widened = (grant, pattern) => async () => {
    await inTx(async () => {
      await db.query(grant)
      const findings = (await stagingGrantFindings(db)).map((f) => `${f.table}: ${f.finding}`)
      assert.ok(findings.some((f) => pattern.test(f)), findings.join('\n') || 'no finding')
    })
  }
  test('bob_feeder given UPDATE is reported',
    widened(`GRANT UPDATE ON ${TABLE} TO bob_feeder`, /member_refs_seen: bob_feeder holds INSERT, UPDATE/))
  test('bob_feeder given UPDATE on one column is reported',
    widened(`GRANT UPDATE (ref) ON ${TABLE} TO bob_feeder`, /bob_feeder holds INSERT, UPDATE/))
  test('bob_app given INSERT is reported',
    widened(`GRANT INSERT ON ${TABLE} TO bob_app`, /bob_app holds SELECT, INSERT, DELETE/))
  test('authenticated given SELECT is reported',
    widened(`GRANT SELECT ON ${TABLE} TO authenticated`, /authenticated holds SELECT/))
  test('bob_ai_ro given SELECT is reported',
    widened(`GRANT SELECT ON ${TABLE} TO bob_ai_ro`, /bob_ai_ro holds SELECT/))
  // SELECT to PUBLIC is SELECT to bob_feeder too, so the table stops being
  // staging and becomes a projection by its grants. PR-4 reports it there.
  test('PUBLIC given SELECT is reported, by PR-4', async () => {
    await inTx(async () => {
      await db.query(`GRANT SELECT ON ${TABLE} TO PUBLIC`)
      const findings = [...await stagingGrantFindings(db), ...await projectionGrantFindings(db)]
        .map((f) => `${f.table}: ${f.finding}`)
      assert.ok(findings.some((f) => /^member_refs_seen: bob_app holds DELETE/.test(f)),
        findings.join('\n') || 'no finding')
    })
  })

  // Q13: the feeder never creates an actor. An INSERT grant on an actor table
  // makes that table look like staging, and the rule refuses it there.
  test('bob_feeder given INSERT on actors is reported (Q13)',
    widened('GRANT INSERT ON bob.actors TO bob_feeder', /^actors: bob_app holds SELECT, INSERT, UPDATE, DELETE/))

  // And read access turns it into a projection, which PR-4 refuses.
  test('bob_feeder given SELECT makes it a projection, and PR-4 reports it', async () => {
    await inTx(async () => {
      await db.query(`GRANT SELECT ON ${TABLE} TO bob_feeder`)
      const findings = (await projectionGrantFindings(db)).map((f) => `${f.table}: ${f.finding}`)
      assert.ok(findings.some((f) => /^member_refs_seen: bob_app holds DELETE/.test(f)),
        findings.join('\n') || 'no finding')
    })
  })
})

// ── bob_feeder: INSERT, and nothing else ───────────────────────────────────
describe('P5 Q6 (a) · bob_feeder can INSERT and cannot SELECT, UPDATE or DELETE', () => {
  test('under tenant A\'s claim, a tenant A row is accepted', async () => {
    await inTx(async () => {
      await becomeRole('bob_feeder', TENANT_A)
      assert.equal(await refusal(stage, [TENANT_A, CHANNEL_A, 'm:q6-a']), null)
    })
  })

  test('SELECT is refused', async () => {
    await inTx(async () => {
      await seedBoth()
      await becomeRole('bob_feeder', TENANT_A)
      assert.equal(await refusal(`SELECT 1 FROM ${TABLE} LIMIT 1`), '42501')
      assert.equal(await refusal(`SELECT count(*) FROM ${TABLE}`), '42501')
    })
  })

  test('UPDATE is refused', async () => {
    await inTx(async () => {
      await seedBoth()
      await becomeRole('bob_feeder', TENANT_A)
      // SET to DEFAULT and WHERE false read no column: only UPDATE is asked.
      assert.equal(await refusal(`UPDATE ${TABLE} SET staged_at = DEFAULT WHERE false`), '42501')
    })
  })

  test('DELETE is refused', async () => {
    await inTx(async () => {
      await seedBoth()
      await becomeRole('bob_feeder', TENANT_A)
      assert.equal(await refusal(`DELETE FROM ${TABLE} WHERE false`), '42501')
    })
  })

  test('TRUNCATE is refused', async () => {
    await inTx(async () => {
      await becomeRole('bob_feeder', TENANT_A)
      assert.equal(await refusal(`TRUNCATE ${TABLE}`), '42501')
    })
  })
})

// ── Under the claim, and only that tenant's channels (F-22) ────────────────
describe('P5 Q6 (a) · a write under another tenant\'s claim is refused', () => {
  test('under tenant A\'s claim, a tenant B row is refused', async () => {
    await inTx(async () => {
      await becomeRole('bob_feeder', TENANT_A)
      assert.equal(await refusal(stage, [TENANT_B, CHANNEL_B, 'm:q6-b']), '42501')
    })
  })

  test('with no claim, every write is refused', async () => {
    await inTx(async () => {
      await becomeRole('bob_feeder')
      assert.equal(await refusal(stage, [TENANT_A, CHANNEL_A, 'm:q6-a']), '42501')
    })
  })

  test('under tenant A\'s claim, a tenant A row naming a tenant B channel is refused', async () => {
    await inTx(async () => {
      await becomeRole('bob_feeder', TENANT_A)
      assert.equal(await refusal(stage, [TENANT_A, CHANNEL_B, 'm:q6-x']), '23503')
    })
  })

  // The same row, as the migration owner, so the refusals above are the
  // claim's and the key's, not the row's.
  test('the rows refused above are well-formed', async () => {
    await inTx(async () => {
      assert.equal(await refusal(stage, [TENANT_B, CHANNEL_B, 'm:q6-b']), null)
      assert.equal(await refusal(stage, [TENANT_A, CHANNEL_B, 'm:q6-x']), '23503')
    })
  })
})

// ── bob_app: SELECT and DELETE, under its tenant's claim ───────────────────
describe('P5 Q6 (a) · bob_app reads and consumes, one tenant at a time', () => {
  test('under tenant A\'s claim it sees tenant A\'s rows and none of B\'s', async () => {
    await inTx(async () => {
      await seedBoth()
      await becomeRole('bob_app', TENANT_A)
      const { rows } = await db.query(`SELECT org_id::text, ref FROM ${TABLE} ORDER BY ref`)
      assert.deepEqual(rows, [{ org_id: TENANT_A, ref: 'm:q6-a' }])
    })
  })

  test('its DELETE reaches its own tenant\'s rows only', async () => {
    await inTx(async () => {
      await seedBoth()
      await becomeRole('bob_app', TENANT_A)
      const { rowCount } = await db.query(`DELETE FROM ${TABLE}`)
      assert.equal(rowCount, 1)
      await db.query('RESET ROLE')
      const { rows } = await db.query(`SELECT ref FROM ${TABLE} ORDER BY ref`)
      assert.deepEqual(rows.map((r) => r.ref), ['m:q6-b'])
    })
  })

  test('INSERT and UPDATE are refused', async () => {
    await inTx(async () => {
      await becomeRole('bob_app', TENANT_A)
      assert.equal(await refusal(stage, [TENANT_A, CHANNEL_A, 'm:q6-a']), '42501')
      assert.equal(await refusal(`UPDATE ${TABLE} SET staged_at = DEFAULT WHERE false`), '42501')
    })
  })
})

// ── Nobody else ────────────────────────────────────────────────────────────
describe('P5 Q6 (a) · bob_ai_ro, anon and authenticated hold nothing', () => {
  for (const role of ['bob_ai_ro', 'anon', 'authenticated']) {
    test(`${role}: SELECT and INSERT are refused`, async () => {
      await inTx(async () => {
        await seedBoth()
        await becomeRole(role, TENANT_A)
        assert.equal(await refusal(`SELECT 1 FROM ${TABLE} LIMIT 1`), '42501')
        assert.equal(await refusal(stage, [TENANT_A, CHANNEL_A, 'm:q6-a']), '42501')
      })
    })
  }
})
