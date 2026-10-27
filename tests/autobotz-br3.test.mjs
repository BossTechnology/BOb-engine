// BR-3 / D-10 — the mutative exemption is closed, and the five rulings exist.
//
// 20260902100000 shipped autobotz_mutative_declared NOT VALID. The 23 Oct 2026 ruling:
// VALIDATE CONSTRAINT ships as a plain migration, with the five F-07 rulings as
// a fixture. This file asserts both, and that the migration's guard goes red on
// an unruled row rather than only ever being seen green.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { connect, loadFixture, loadBr3Rulings, REPO_ROOT, TENANT_A } from './helpers/db.mjs'

const MIGRATIONS = join(REPO_ROOT, 'supabase/migrations')
const AMENDMENTS = join(REPO_ROOT, 'Documentation/contract-amendments.md')
const FIXTURE_IDS = 'aaaaaaaa-3333-4000-8000-0000000000a_'

let db

before(async () => {
  db = await connect()
  await loadFixture(db)
  await loadBr3Rulings(db)
})
after(async () => { await db?.end() })

async function inRollback(fn) {
  await db.query('BEGIN')
  try { return await fn() } finally { await db.query('ROLLBACK') }
}

// The migration that validates, discovered by what it executes rather than by
// file name. 20260902100000 carries the same statement in a comment, so only a
// line that starts with it counts.
function validatingMigration() {
  const found = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => /^\s*ALTER TABLE autobotz VALIDATE CONSTRAINT autobotz_mutative_declared/m
      .test(readFileSync(join(MIGRATIONS, f), 'utf8')))
  assert.equal(found.length, 1,
    `expected one migration to validate autobotz_mutative_declared, found: ${found.join(', ') || 'none'}`)
  return readFileSync(join(MIGRATIONS, found[0]), 'utf8')
}

// Its body without its own BEGIN and COMMIT, so it can run inside a test
// transaction that is rolled back.
function migrationBody() {
  return validatingMigration().replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '')
}

// Put the table back in the state 20260902100000 left it: the constraint
// present, NOT VALID, and one row in the database that predates it.
async function reopenExemption(mutative) {
  await db.query('ALTER TABLE autobotz DROP CONSTRAINT autobotz_mutative_declared')
  await db.query(`
    INSERT INTO autobotz (id, org_id, type, label, reference, mutative)
    VALUES ('aaaaaaaa-3333-4000-8000-0000000000ff', $1, 'webhook',
            'Predates the ruling', 'hooks/legacy', $2)`, [TENANT_A, mutative])
  await db.query(`
    ALTER TABLE autobotz ADD CONSTRAINT autobotz_mutative_declared
      CHECK (mutative IS NOT NULL) NOT VALID`)
}

async function isValidated() {
  const { rows } = await db.query(`
    SELECT convalidated FROM pg_constraint
     WHERE conrelid = 'autobotz'::regclass
       AND conname = 'autobotz_mutative_declared'`)
  assert.equal(rows.length, 1, 'autobotz_mutative_declared does not exist')
  return rows[0].convalidated
}

describe('BR-3 / D-10 · the NOT VALID exemption is closed', () => {
  test('autobotz_mutative_declared is validated, so no row is exempt', async () => {
    assert.equal(await isValidated(), true,
      'the constraint is still NOT VALID: rows that predate it are exempt')
  })

  test('the migration refuses an unruled row, and names it', async () => {
    let message = ''
    await inRollback(async () => {
      await reopenExemption(null)
      assert.equal(await isValidated(), false, 'the setup did not reopen the exemption')
      try { await db.query(migrationBody()) } catch (e) { message = e.message }
    })
    assert.match(message, /carry no BR-3 ruling/,
      'the migration ran over an unruled row, or failed for another reason: ' + message)
    assert.match(message, /aaaaaaaa-3333-4000-8000-0000000000ff/,
      'the failure does not say which row needs a ruling')
  })

  test('the migration validates once every row is ruled', async () => {
    await inRollback(async () => {
      await reopenExemption(false)
      await db.query(migrationBody())
      assert.equal(await isValidated(), true)
    })
  })

  test('a ruled binding cannot be returned to unruled', async () => {
    let rejected = false
    await inRollback(async () => {
      try {
        await db.query(`
          UPDATE autobotz SET mutative = NULL
           WHERE id = 'aaaaaaaa-3333-4000-8000-0000000000a5'`)
      } catch (e) {
        rejected = /autobotz_mutative_declared/.test(e.message)
      }
    })
    assert.ok(rejected, 'a ruling was cleared with an UPDATE')
  })
})

describe('F-07 · the five rulings, persisted as a fixture', () => {
  // The rulings table under "F-07 · Superseded", read from the record rather
  // than copied here, so a change to either side fails this test.
  function rulingsOnRecord() {
    const doc = readFileSync(AMENDMENTS, 'utf8')
    const section = doc.split(/^### F-07 · Superseded/m)[1]?.split(/^### /m)[0] ?? ''
    return [...section.matchAll(
      /^\|\s*ab\d\s*·\s*(.+?)\s*\|\s*(\w+)\s*\|\s*\*\*(true|false)\*\*\s*\|/gm)]
      .map((m) => ({ label: m[1], type: m[2], mutative: m[3] === 'true' }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  test('the fixture carries exactly the rulings on record', async () => {
    const recorded = rulingsOnRecord()
    assert.equal(recorded.length, 5,
      `the discovery is broken, not the fixture: ${recorded.length} rulings read from F-07`)

    const { rows } = await db.query(`
      SELECT label, type, mutative FROM autobotz
       WHERE id::text LIKE $1 ORDER BY label`, [FIXTURE_IDS])
    const fixture = rows.sort((a, b) => a.label.localeCompare(b.label))

    assert.deepEqual(fixture, recorded,
      'the fixture and contract-amendments F-07 disagree about the BR-3 rulings')
  })

  // BR-3's own example. The check completes the checkout, so every run is a
  // real order.
  test('the checkout check is mutative and requires approval', async () => {
    const { rows } = await db.query(`
      SELECT mutative, requires_approval FROM autobotz
       WHERE id::text LIKE $1 AND label = 'Checkout Flow Check'`, [FIXTURE_IDS])
    assert.deepEqual(rows, [{ mutative: true, requires_approval: true }])
  })
})
