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
import { isMemberRef } from '../reconciliation/ghosts.mjs'
import { stagingRunWarnings } from '../scripts/box-checks.mjs'

let db

before(async () => {
  db = await connect()
  await loadFixture(db)
})
after(async () => { await db?.end() })

const TABLE = 'bob.member_refs_seen'
const RUNS = 'bob.member_refs_runs'
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
  test('member_refs_seen and member_refs_runs are feeder staging tables and tenant tables, not projections', async () => {
    const staging = (await feederStagingTables(db)).map((t) => t.qualified)
    assert.deepEqual(staging, [RUNS, TABLE])
    const tenant = await tenantTables(db)
    const projections = await projectionTables(db)
    for (const name of staging) {
      assert.ok(tenant.some((t) => t.qualified === name), `${name} is not a tenant table`)
      assert.ok(!projections.some((t) => t.qualified === name), `${name} was taken for a projection`)
    }
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

  // Review of PR #33: a write other than INSERT on an actor table, with no
  // read, fell through both discoveries. Any feeder write without SELECT is
  // staging now, so the rule sees it.
  test('bob_feeder given DELETE on actors is reported (Q13)',
    widened('GRANT DELETE ON bob.actors TO bob_feeder', /^actors: bob_feeder holds DELETE/))
  test('bob_feeder given UPDATE on one column of actor_external_refs is reported (Q13)',
    widened('GRANT UPDATE (actor_id) ON bob.actor_external_refs TO bob_feeder',
      /^actor_external_refs: bob_feeder holds UPDATE/))
  test('bob_feeder given TRUNCATE on actor_ref_history is reported (Q13)',
    widened('GRANT TRUNCATE ON bob.actor_ref_history TO bob_feeder',
      /^actor_ref_history: bob_feeder holds TRUNCATE/))

  // The roles are discovered from the grants, not only checked from a list.
  test('a grant to a role the rule does not name is reported', async () => {
    await inTx(async () => {
      await db.query('CREATE ROLE q6_probe NOLOGIN')
      await db.query(`GRANT SELECT ON ${TABLE} TO q6_probe`)
      const findings = (await stagingGrantFindings(db)).map((f) => `${f.table}: ${f.finding}`)
      assert.ok(findings.some((f) => /^member_refs_seen: q6_probe holds SELECT/.test(f)),
        findings.join('\n') || 'no finding')
    })
  })
  test('a column grant to a role the rule does not name is reported', async () => {
    await inTx(async () => {
      await db.query('CREATE ROLE q6_probe NOLOGIN')
      await db.query(`GRANT SELECT (ref) ON ${TABLE} TO q6_probe`)
      const findings = (await stagingGrantFindings(db)).map((f) => `${f.table}: ${f.finding}`)
      assert.ok(findings.some((f) => /^member_refs_seen: q6_probe holds SELECT/.test(f)),
        findings.join('\n') || 'no finding')
    })
  })

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

// The grant helper rewrites a table's ACL, so only its owner runs it. Every
// grantee is read from the function's ACL, not listed (review of PR #33: the
// revoke had left out service_role).
test('P5 Q6 (a) · bob_grant_feeder_staging() is executable by its owner alone', async () => {
  const { rows } = await db.query(`
    SELECT CASE WHEN a.grantee = 0 THEN 'public' ELSE pg_get_userbyid(a.grantee) END AS role
      FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'public.bob_grant_feeder_staging(regclass)'::regprocedure
       AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
     ORDER BY 1`)
  assert.deepEqual(rows.map((r) => r.role), [])
})

// ── A staged ref is a member ref (review of PR #33) ─────────────────────────
// The feeder sets its own claim, and every staged ref becomes a ghost. The
// table holds it to the member shape (D47: `m:…`), and the reconciliation
// checks it again before it creates anything.
describe('P5 Q6 (a) · only member refs can be staged, and only member refs become ghosts', () => {
  test('an agent ref, an empty member ref and an over-long ref are refused', async () => {
    await inTx(async () => {
      assert.equal(await refusal(stage, [TENANT_A, CHANNEL_A, 'tenant-a.whatsapp:4711']), '23514')
      assert.equal(await refusal(stage, [TENANT_A, CHANNEL_A, 'm:']), '23514')
      assert.equal(await refusal(stage, [TENANT_A, CHANNEL_A, 'm:x'.padEnd(257, 'x')]), '23514')
      assert.equal(await refusal(stage, [TENANT_A, CHANNEL_A, 'm:x'.padEnd(256, 'x')]), null)
    })
  })

  test('the reconciliation\'s own check agrees with the table\'s', () => {
    assert.equal(isMemberRef('m:a002'), true)
    assert.equal(isMemberRef('tenant-a.whatsapp:4711'), false)
    assert.equal(isMemberRef('botplatform:web-01'), false)
    assert.equal(isMemberRef('m:'), false)
    assert.equal(isMemberRef('m:x'.padEnd(257, 'x')), false)
    assert.equal(isMemberRef(null), false)
  })
})

// ── A run leaves a mark (review of PR #33) ──────────────────────────────────
// If the feeder stops staging, the reconciliation reads zero rows and cannot
// tell that from a quiet day. Each staging run writes a row per tenant in
// member_refs_runs, even with nothing to stage, and the box check warns when
// the newest is too old.
describe('P5 Q6 (a) · the box check warns when staging has gone quiet', () => {
  const NOW = new Date('2026-11-18T14:30:00Z')
  const run = `INSERT INTO ${RUNS} (org_id, window_from, window_to, staged_count, mapped_count, ran_at)
               VALUES ($1, '2026-11-18 13:00+00', '2026-11-18 14:30+00', 0, 0, $2)`

  test('a tenant with no run is warned about', async () => {
    await inTx(async () => {
      const w = await stagingRunWarnings(db, { now: NOW, maxAgeHours: 24 })
      assert.ok(w.some((x) => x.includes(TENANT_A) && /no staging run/.test(x)), w.join('\n'))
    })
  })

  test('a run older than the bound is warned about, a fresh one is not', async () => {
    await inTx(async () => {
      await db.query(run, [TENANT_A, '2026-11-17 12:00+00'])
      await db.query(run, [TENANT_B, '2026-11-18 14:00+00'])
      const w = await stagingRunWarnings(db, { now: NOW, maxAgeHours: 24 })
      assert.ok(w.some((x) => x.includes(TENANT_A) && /last staging run/.test(x)), w.join('\n'))
      assert.ok(!w.some((x) => x.includes(TENANT_B)), w.join('\n'))
    })
  })

  test('bob_feeder can write a run row and not read one', async () => {
    await inTx(async () => {
      await becomeRole('bob_feeder', TENANT_A)
      assert.equal(await refusal(run, [TENANT_A, NOW]), null)
      assert.equal(await refusal(`SELECT 1 FROM ${RUNS} LIMIT 1`), '42501')
      assert.equal(await refusal(run, [TENANT_B, NOW]), '42501')
    })
  })
})
