// Who may sign in to a box. bob-web answers 403 to a GoTrue account with no row
// in bob.users, or with active = false (Henry, 21 Nov: "no row, 403"). So three
// things have to hold, and this file holds them:
//
//   - bob_app, the role bob-web runs as, can read its own organization's users,
//     and only those, and can stamp last_login_at and nothing else;
//   - a row is never created by signing up: GoTrue's account metadata is the
//     signer's to write, so a trigger that copied org_id and role from it would
//     let anyone pick their organization and their role;
//   - the one way a row is made is scripts/provision-user.mjs, run by the
//     operator with the migration owner's credential, dry by default.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { connect, loadFixture, TENANT_A, TENANT_B } from './helpers/db.mjs'
import { provisionUser } from '../scripts/provision-user.mjs'
import { activeUserFindings } from '../scripts/box-checks.mjs'

const USER_A = 'aaaaaaaa-1111-4000-8000-000000000001'
const USER_B = 'bbbbbbbb-1111-4000-8000-000000000002'

let db
const accounts = []

before(async () => {
  db = await connect()
  await loadFixture(db)
  await db.query('GRANT bob_app TO current_user')
})
after(async () => {
  if (accounts.length) {
    await db.query('DELETE FROM bob.users WHERE id = ANY($1)', [accounts])
    await db.query('DELETE FROM auth.users WHERE id = ANY($1)', [accounts])
  }
  await db?.query('REVOKE bob_app FROM current_user')
  await db?.end()
})

async function inTx(fn) {
  await db.query('BEGIN')
  try { return await fn() } finally { await db.query('ROLLBACK') }
}

// As bob_app under a tenant's claim, the way bob-web runs in the box.
async function asApp(fn, org = TENANT_A) {
  return inTx(async () => {
    await db.query('SELECT set_config($1, $2, true)',
      ['request.jwt.claims', JSON.stringify({ org_id: org })])
    await db.query('SET LOCAL ROLE bob_app')
    return fn()
  })
}

async function refusal(sql, params = []) {
  await db.query('SAVEPOINT probe')
  try {
    await db.query(sql, params)
    await db.query('RELEASE SAVEPOINT probe')
    return null
  } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT probe')
    return e
  }
}

// A GoTrue account, as the identity stack would hold it. Committed, so the
// provisioning script's own transaction can see it; removed in after().
async function account(email, meta = {}) {
  const id = randomUUID()
  accounts.push(id)
  await db.query(`INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
                  VALUES ($1, $2, 'authenticated', 'authenticated', $3)`,
  [id, email, JSON.stringify(meta)])
  return id
}

describe('bob_app reads its own organization\'s users, and only those', () => {
  test('under tenant A it sees A\'s user and not B\'s', async () => {
    await asApp(async () => {
      const { rows } = await db.query('SELECT id::text, org_id::text FROM bob.users ORDER BY id')
      assert.deepEqual(rows.map((r) => r.id), [USER_A])
      const b = await db.query('SELECT count(*)::int AS n FROM bob.users WHERE id = $1', [USER_B])
      assert.equal(b.rows[0].n, 0)
    })
  })

  test('it stamps last_login_at on its own users, and cannot reach another organization\'s', async () => {
    await asApp(async () => {
      const own = await db.query('UPDATE bob.users SET last_login_at = now() WHERE id = $1', [USER_A])
      assert.equal(own.rowCount, 1)
      const other = await db.query('UPDATE bob.users SET last_login_at = now() WHERE id = $1', [USER_B])
      assert.equal(other.rowCount, 0)
    })
  })

  test('it cannot create, delete, or change role, active, email or organization', async () => {
    await asApp(async () => {
      for (const col of ['role', 'active', 'email', 'org_id', 'full_name']) {
        const value = { role: 'viewer', active: false, email: 'x@example.test', org_id: TENANT_A, full_name: 'X' }[col]
        const e = await refusal(`UPDATE bob.users SET ${col} = $2 WHERE id = $1`, [USER_A, value])
        assert.equal(e?.code, '42501', `bob_app could write bob.users.${col}`)
      }
      const ins = await refusal(`INSERT INTO bob.users (id, org_id, email, role)
                                 VALUES (gen_random_uuid(), $1, 'new@example.test', 'admin')`, [TENANT_A])
      assert.equal(ins?.code, '42501')
      assert.equal((await refusal('DELETE FROM bob.users WHERE id = $1', [USER_A]))?.code, '42501')
    })
  })
})

describe('Signing up never creates a row', () => {
  test('a GoTrue account whose metadata names an organization and admin gets no bob.users row', async () => {
    await inTx(async () => {
      const id = randomUUID()
      await db.query(`INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
                      VALUES ($1, 'signup@example.test', 'authenticated', 'authenticated', $2)`,
      [id, JSON.stringify({ org_id: TENANT_A, role: 'admin', full_name: 'Self Made' })])
      const { rows } = await db.query('SELECT count(*)::int AS n FROM bob.users WHERE id = $1', [id])
      assert.equal(rows[0].n, 0)
    })
  })

  test('no trigger on auth.users writes into bob', async () => {
    const { rows } = await db.query(`
      SELECT t.tgname, p.proname FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
         AND p.prosrc ~* '\\m(bob\\.)?users\\M' AND p.prosrc ~* '\\m(insert|update)\\M'`)
    assert.deepEqual(rows, [])
  })
})

describe('scripts/provision-user.mjs · the one way a row is made', () => {
  test('dry by default: it says what it would do and writes nothing', async () => {
    const id = await account('dry@example.test')
    const r = await provisionUser(db, { tenant: 'tenant-a', email: 'dry@example.test', role: 'analyst' })
    assert.equal(r.executed, false)
    assert.match(r.plan, /insert/)
    const { rows } = await db.query('SELECT count(*)::int AS n FROM bob.users WHERE id = $1', [id])
    assert.equal(rows[0].n, 0)
  })

  test('with execute, it inserts the account\'s id into the tenant\'s organization with its role', async () => {
    const id = await account('Real.Person@example.test')
    const r = await provisionUser(db, {
      tenant: 'tenant-a', email: 'real.person@example.test', role: 'analyst', execute: true })
    assert.equal(r.executed, true)
    const { rows: [u] } = await db.query('SELECT org_id::text, role, active, email FROM bob.users WHERE id = $1', [id])
    assert.deepEqual(u, { org_id: TENANT_A, role: 'analyst', active: true, email: 'Real.Person@example.test' })

    const again = await provisionUser(db, {
      tenant: 'tenant-a', email: 'real.person@example.test', role: 'viewer', execute: true })
    assert.match(again.plan, /update/)
    const { rows: [v] } = await db.query('SELECT role FROM bob.users WHERE id = $1', [id])
    assert.equal(v.role, 'viewer')

    await provisionUser(db, { tenant: 'tenant-a', email: 'real.person@example.test', deactivate: true, execute: true })
    const { rows: [w] } = await db.query('SELECT active, role FROM bob.users WHERE id = $1', [id])
    assert.deepEqual(w, { active: false, role: 'viewer' })
  })

  test('it refuses what it cannot do safely, and writes nothing when it does', async () => {
    await account('elsewhere@example.test')
    await provisionUser(db, { tenant: 'tenant-b', email: 'elsewhere@example.test', role: 'viewer', execute: true })
    const cases = [
      [{ tenant: 'tenant-a', email: 'nobody@example.test', role: 'viewer' }, /no GoTrue account/],
      [{ tenant: 'no-such-tenant', email: 'elsewhere@example.test', role: 'viewer' }, /no organization/],
      [{ tenant: 'tenant-a', email: 'elsewhere@example.test', role: 'viewer' }, /another organization/],
      [{ tenant: 'tenant-b', email: 'elsewhere@example.test', role: 'owner' }, /role/],
      [{ tenant: 'tenant-b', email: 'elsewhere@example.test', role: 'service' }, /role/],
      [{ email: 'elsewhere@example.test', role: 'viewer' }, /tenant/],
    ]
    for (const [opts, why] of cases) {
      await assert.rejects(provisionUser(db, { ...opts, execute: true }), why, JSON.stringify(opts))
    }
    const { rows } = await db.query(`SELECT org_id::text, role FROM bob.users WHERE email = 'elsewhere@example.test'`)
    assert.deepEqual(rows, [{ org_id: TENANT_B, role: 'viewer' }])
  })
})

// Henry, 26 Nov («Alta sola, como viewer»): the first time a live BzzzBX
// session reaches BOb in the box, bob-web gives it a viewer seat in the box's
// organization. bob_app still cannot write bob.users; bob.claim_viewer_seat()
// is the one narrow door, and it opens to bob_app alone. The id and email are
// the ones GoTrue answered for the session (bob-web asks GoTrue on every
// request); the organization is the claim, never an argument; the role is
// viewer, never an argument. A row that exists, inactive or in another
// organization, is left as it is.
const SEAT = 'SELECT bob.claim_viewer_seat($1, $2) AS took'

async function seat(id, email, org = TENANT_A) {
  return asApp(async () => (await db.query(SEAT, [id, email])).rows[0].took, org)
}

describe('bob.claim_viewer_seat · a signed-in account takes a viewer seat, nothing more', () => {
  // Seat and read back in one transaction, rolled back: as bob_app for the
  // seat, as the test's own login for the read.
  async function seatThenRead(fn) {
    return inTx(async () => {
      await db.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', JSON.stringify({ org_id: TENANT_A })])
      await db.query('SET LOCAL ROLE bob_app')
      const take = async (id, email) => (await db.query(SEAT, [id, email])).rows[0].took
      const read = async (id) => {
        await db.query('RESET ROLE')
        const { rows } = await db.query('SELECT org_id::text, role, active, email FROM bob.users WHERE id = $1', [id])
        await db.query('SET LOCAL ROLE bob_app')
        return rows
      }
      return fn(take, read)
    })
  }

  test('a new account gets an active viewer row in the claim\'s organization', async () => {
    await seatThenRead(async (take, read) => {
      const id = randomUUID()
      assert.equal(await take(id, 'first.visit@example.test'), true)
      assert.deepEqual(await read(id),
        [{ org_id: TENANT_A, role: 'viewer', active: true, email: 'first.visit@example.test' }])
    })
  })

  test('a second visit takes nothing and changes nothing', async () => {
    await seatThenRead(async (take, read) => {
      const id = randomUUID()
      assert.equal(await take(id, 'twice@example.test'), true)
      assert.equal(await take(id, 'changed@example.test'), false)
      assert.deepEqual((await read(id)).map((r) => [r.email, r.role]), [['twice@example.test', 'viewer']])
    })
  })

  test('an inactive row stays inactive, with its role', async () => {
    await inTx(async () => {
      await db.query(`UPDATE bob.users SET active = false, role = 'analyst' WHERE id = $1`, [USER_A])
      await db.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', JSON.stringify({ org_id: TENANT_A })])
      await db.query('SET LOCAL ROLE bob_app')
      const { rows: [r] } = await db.query(SEAT, [USER_A, 'a@example.test'])
      assert.equal(r.took, false)
      await db.query('RESET ROLE')
      const { rows } = await db.query('SELECT active, role, org_id::text FROM bob.users WHERE id = $1', [USER_A])
      assert.deepEqual(rows, [{ active: false, role: 'analyst', org_id: TENANT_A }])
    })
  })

  test('another organization\'s row is not touched, and no seat is made beside it', async () => {
    assert.equal(await seat(USER_B, 'b@example.test', TENANT_A), false)
    const { rows } = await db.query('SELECT org_id::text, role FROM bob.users WHERE id = $1', [USER_B])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].org_id, TENANT_B)
  })

  test('an email another account already holds takes nothing', async () => {
    const id = randomUUID()
    const { rows: [a] } = await db.query('SELECT email FROM bob.users WHERE id = $1', [USER_A])
    assert.equal(await seat(id, a.email), false)
    const { rows } = await db.query('SELECT count(*)::int AS n FROM bob.users WHERE id = $1', [id])
    assert.equal(rows[0].n, 0)
  })

  test('with no claim, an unknown organization, no id or no email, nothing is made', async () => {
    const id = randomUUID()
    const cases = [
      [id, 'x@example.test', null],
      [id, 'x@example.test', randomUUID()],
      [null, 'x@example.test', TENANT_A],
      [id, null, TENANT_A],
      [id, '  ', TENANT_A],
    ]
    for (const [i, e, org] of cases) {
      const took = await inTx(async () => {
        if (org) await db.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', JSON.stringify({ org_id: org })])
        await db.query('SET LOCAL ROLE bob_app')
        return (await db.query(SEAT, [i, e])).rows[0].took
      })
      assert.equal(took, false, JSON.stringify([i, e, org]))
    }
    const { rows } = await db.query('SELECT count(*)::int AS n FROM bob.users WHERE id = $1', [id])
    assert.equal(rows[0].n, 0)
  })

  test('it takes an id and an email, and nothing that names a role or an organization', async () => {
    const { rows } = await db.query(`
      SELECT pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef, p.proconfig
        FROM pg_proc p WHERE p.pronamespace = 'bob'::regnamespace AND p.proname = 'claim_viewer_seat'`)
    assert.deepEqual(rows.map((r) => r.args), ['p_user uuid, p_email text'])
    assert.equal(rows[0].prosecdef, true)
    assert.ok((rows[0].proconfig ?? []).some((c) => c.startsWith('search_path=')), 'search_path is not pinned')
  })

  test('bob_app alone executes it', async () => {
    const { rows } = await db.query(`
      SELECT CASE WHEN a.grantee = 0 THEN 'public' ELSE pg_get_userbyid(a.grantee) END AS role
        FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = 'bob.claim_viewer_seat(uuid,text)'::regprocedure
         AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
       ORDER BY 1`)
    assert.deepEqual(rows.map((r) => r.role), ['bob_app'])
    for (const r of ['anon', 'authenticated', 'service_role', 'bob_feeder', 'bob_ai_ro']) {
      const { rows: [x] } = await db.query(
        `SELECT has_function_privilege($1, 'bob.claim_viewer_seat(uuid,text)', 'EXECUTE') AS can`, [r])
      assert.equal(x.can, false, `${r} can take a seat`)
    }
  })
})

describe('The box check warns when nobody can sign in', () => {
  test('an organization with no active user is reported, one with an active user is not', async () => {
    assert.deepEqual(await activeUserFindings(db, 'tenant-a'), [])
    await inTx(async () => {
      await db.query('UPDATE bob.users SET active = false WHERE org_id = $1', [TENANT_A])
      const [w] = await activeUserFindings(db, 'tenant-a')
      assert.match(w ?? 'nothing reported', /no active user/)
      await db.query('DELETE FROM bob.users WHERE org_id = $1', [TENANT_A])
      assert.equal((await activeUserFindings(db, 'tenant-a')).length, 1)
    })
  })
})
