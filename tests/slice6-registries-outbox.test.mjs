// Slice 6 · Registries and the outbox. RS-30 to RS-35 (Behavioural Rules,
// Part 4 §4.4), the move of webhook entries into the AutoBotz registry, and the
// outbox that the stub drains.
//
// What is tested here and what is not. BOb writes an intention and never
// executes one; the outbox drains to a stub, and the outcome is read back
// through the real projection path (stub -> truth store -> reference feeder ->
// proj_deliveries). That BOb's intention reaches a real provider is NOT
// testable until execution exists, and is a `todo` below rather than a claim.
//
// Everything that changes something runs in a transaction that is rolled back,
// except the read-back, which needs three connections and commits.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  connect, connectAs, loadFixture, loadRoster, loadFeederWorld, loadBr3Rulings,
  becomeTenant, tenantTables, REPO_ROOT, TENANT_A, TENANT_B,
} from './helpers/db.mjs'
import { MemoryTruthStore } from '../feeder/memory-truth-store.mjs'
import { runFeeder } from '../feeder/reference-feeder.mjs'
import { drainToStub } from '../outbox/stub-drainer.mjs'

const MIGRATIONS = join(REPO_ROOT, 'supabase/migrations')

// The F-07 rulings (fixture autobotz_br3.sql), all tenant A.
const AB1 = 'aaaaaaaa-3333-4000-8000-0000000000a1'   // webhook, mutative, no approval
const AB3 = 'aaaaaaaa-3333-4000-8000-0000000000a3'   // synthetics, mutative, requires approval
const AB5 = 'aaaaaaaa-3333-4000-8000-0000000000a5'   // agent, not mutative
const B_HOOK = 'bbbbbbbb-3333-4000-8000-000000000002' // tenant B's binding
const EMAIL_A = 'aaaaaaaa-4444-4000-8000-000000000001'

let db, feeder, app

before(async () => {
  db = await connect()
  await loadFixture(db)
  await loadRoster(db)
  await loadFeederWorld(db)
  await loadBr3Rulings(db)
  await db.query('GRANT bob_feeder, bob_app TO current_user')
  feeder = await connectAs('bob_feeder')
  app = await connectAs('bob_app')
})
after(async () => {
  await feeder?.end()
  await app?.end()
  await db?.query('REVOKE bob_feeder, bob_app FROM current_user')
  await db?.end()
})

async function inTx(fn) {
  await db.query('BEGIN')
  try { return await fn() } finally { await db.query('ROLLBACK') }
}

// As tenant A through PostgREST's role, inside the caller's transaction.
async function inTenantTx(fn, org = TENANT_A) {
  return inTx(async () => { await becomeTenant(db, org); return fn() })
}

// As bob_app under a tenant's claim, the way the application and the drain run.
async function inAppTx(fn, org = TENANT_A) {
  return inTx(async () => {
    await db.query('SELECT set_config($1, $2, true)',
      ['request.jwt.claims', JSON.stringify({ org_id: org })])
    await db.query('SET LOCAL ROLE bob_app')
    return fn()
  })
}

// Run `sql` and return the error it raised, or null. Inside a savepoint, so the
// caller's transaction survives.
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

const state = async (id, at = null) => (await db.query(
  `SELECT public.bob_autobotz_state(verify_state, verified_at, coalesce($2::timestamptz, now())) AS s
     FROM autobotz WHERE id = $1`, [id, at])).rows[0].s

// Record a passing verification through Verify, under `org`'s claim. The claim
// is set by a materialized CTE, so it is in place before Verify reads it; it is
// LOCAL, so it lasts as long as the caller's transaction (or this statement).
async function verifyOk(binding, org = TENANT_A) {
  await db.query(`
    WITH c AS MATERIALIZED (SELECT set_config('request.jwt.claims', $2, true) AS x)
    SELECT public.bob_autobotz_record_verification($1, true, 'probe') FROM c`,
  [binding, JSON.stringify({ org_id: org })])
}

// An Action response attaching `binding`, and an alert to cause intentions.
// The binding is verified afterwards, because an intention needs a binding
// whose last verification passed and is fresh. Edits made before this call
// (a limit, say) invalidate the verification under RS-32, so verify comes last.
async function actionFor(binding, org = TENANT_A, { verify = true } = {}) {
  const { rows: [r] } = await db.query(`
    INSERT INTO response_rules (org_id, type, name, autobotz_id)
    VALUES ($1, 'action', 'Slice 6 probe', $2) RETURNING id`, [org, binding])
  const { rows: [a] } = await db.query(`
    INSERT INTO alert_log (org_id, metric_id, metric_name, alert_type, value, threshold, severity)
    VALUES ($1, 'abandonment', 'Abandonment', 'upper', 12, 10, 'critical') RETURNING id`, [org])
  if (verify) await verifyOk(binding, org)
  return { rule: r.id, alert: a.id }
}

const intend = (org, rule, alert, key) => db.query(`
  INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
  VALUES ($1, $2, $3, $4) RETURNING *`, [org, rule, alert, key])

// Slice 5 (F-49): a refusal by a limit, or by a binding that is not enabled,
// verified and fresh, is a row with its reason, never an error. Returns the
// row as written, or the error if one was raised.
async function written(sql, params) {
  await db.query('SAVEPOINT probe')
  try {
    const { rows: [r] } = await db.query(`${sql} RETURNING state, suppressed_reason`, params)
    await db.query('RELEASE SAVEPOINT probe')
    return r
  } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT probe')
    return { error: e.message }
  }
}
const suppressedAs = (r, reason) =>
  assert.deepEqual(r, { state: 'suppressed', suppressed_reason: reason })

// ── RS-30 ──────────────────────────────────────────────────────────────────
describe('RS-30 · four verification states, never-verified distinct from verified', () => {
  test('unverified, ok, failed and stale read as four different states', async () => {
    const { rows } = await db.query(`
      SELECT public.bob_autobotz_state('unverified', NULL, now()) AS never,
             public.bob_autobotz_state('ok', now(), now()) AS ok,
             public.bob_autobotz_state('failed', now(), now()) AS failed,
             public.bob_autobotz_state('ok', now() - interval '31 days', now()) AS stale`)
    const s = rows[0]
    assert.deepEqual(new Set(Object.values(s)).size, 4, JSON.stringify(s))
    assert.notEqual(s.never, s.ok)
  })

  test('the picker renders the four states distinguishably', async () => {
    await inTx(async () => {
      await db.query(`UPDATE autobotz SET verify_state = 'ok', verified_at = now() WHERE id = $1`, [AB1])
      await db.query(`UPDATE autobotz SET verify_state = 'failed', verified_at = now() WHERE id = $1`, [AB3])
      await db.query(`UPDATE autobotz SET verify_state = 'ok',
                      verified_at = now() - interval '40 days' WHERE id = $1`, [AB5])
      const { rows } = await db.query(`
        SELECT DISTINCT verification_state FROM v_action_binding_picker
         WHERE org_id = $1 ORDER BY 1`, [TENANT_A])
      assert.deepEqual(rows.map((r) => r.verification_state), ['failed', 'ok', 'stale', 'unverified'])
    })
  })

  test('the stored state and its timestamp cannot disagree', async () => {
    await inTx(async () => {
      const okWithout = await refusal(
        `UPDATE autobotz SET verify_state = 'ok', verified_at = NULL WHERE id = $1`, [AB5])
      assert.equal(okWithout?.code, '23514', 'ok without a verification time was stored')
      const { rows: [born] } = await db.query(`
        INSERT INTO autobotz (org_id, type, label, reference, mutative, verify_state, verified_at)
        VALUES ($1, 'agent', 'Claims to be verified', 'agents/x', false, 'ok', now())
        RETURNING verify_state, verified_at`, [TENANT_A])
      assert.deepEqual(born, { verify_state: 'unverified', verified_at: null },
        'a binding was born verified without a verification')
      const future = await refusal(`UPDATE autobotz SET verify_state = 'ok',
                                    verified_at = now() + interval '10 years' WHERE id = $1`, [AB5])
      assert.equal(future?.code, '23514', 'a verification time in the future was stored, so it never goes stale')
    })
  })
})

// ── RS-31 ──────────────────────────────────────────────────────────────────
describe('RS-31 · freshness is derived from the verification time, never stored', () => {
  test('past the window the entry reads stale, and nothing was written', async () => {
    await inTx(async () => {
      await db.query(`UPDATE autobotz SET verify_state = 'ok', verified_at = now() WHERE id = $1`, [AB5])
      const before = (await db.query('SELECT xmin::text AS x, verify_state FROM autobotz WHERE id = $1', [AB5])).rows[0]
      const window = (await db.query('SELECT public.bob_autobotz_freshness_window() AS w')).rows[0].w
      assert.equal(window.days, 30)
      assert.equal(await state(AB5, new Date(Date.now() + 29 * 86_400_000)), 'ok')
      assert.equal(await state(AB5, new Date(Date.now() + 31 * 86_400_000)), 'stale')
      const after = (await db.query('SELECT xmin::text AS x, verify_state FROM autobotz WHERE id = $1', [AB5])).rows[0]
      assert.deepEqual(after, before, 'reading freshness wrote to the row')
    })
  })

  test('stale is not a value the registry can store', async () => {
    await inTx(async () => {
      const e = await refusal(`UPDATE autobotz SET verify_state = 'stale', verified_at = now() WHERE id = $1`, [AB5])
      assert.equal(e?.code, '23514')
      const { rows } = await db.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'autobotz' AND column_name ~* '(stale|fresh)'`)
      assert.deepEqual(rows, [], 'a column stores freshness')
    })
  })
})

// ── RS-32 ──────────────────────────────────────────────────────────────────
describe('RS-32 · changing a binding invalidates its verification', () => {
  for (const [what, set] of [
    ['the reference', `reference = 'agents/triage-v3'`],
    ['the binding inputs', `binding = binding || '{"cap":"5 / day"}'`],
    ['the provider', `provider = 'customer'`],
  ]) {
    test(`editing ${what} returns the state to unverified`, async () => {
      await inTx(async () => {
        await db.query(`UPDATE autobotz SET verify_state = 'ok', verified_at = now() WHERE id = $1`, [AB5])
        await db.query(`UPDATE autobotz SET ${set} WHERE id = $1`, [AB5])
        const { rows: [r] } = await db.query('SELECT verify_state, verified_at FROM autobotz WHERE id = $1', [AB5])
        assert.deepEqual(r, { verify_state: 'unverified', verified_at: null })
      })
    })
  }

  test('an edit cannot carry its own verification with it', async () => {
    await inTx(async () => {
      await db.query(`UPDATE autobotz SET reference = 'agents/other', verify_state = 'ok',
                      verified_at = now() WHERE id = $1`, [AB5])
      assert.equal(await state(AB5), 'unverified')
    })
  })

  test('renaming the label is not a change to what is invoked', async () => {
    await inTx(async () => {
      await db.query(`UPDATE autobotz SET verify_state = 'ok', verified_at = now() WHERE id = $1`, [AB5])
      await db.query(`UPDATE autobotz SET label = 'Triage' WHERE id = $1`, [AB5])
      assert.equal(await state(AB5), 'ok')
    })
  })
})

// ── RS-33 ──────────────────────────────────────────────────────────────────
describe('RS-33 · a failed verification raises an alert', () => {
  const alerts = async () => (await db.query(`
    SELECT count(*)::int AS n FROM alert_log
     WHERE autobotz_id = $1 AND alert_type = 'verification_failed'`, [AB5])).rows[0].n

  test('each failure is an alert; a success is not', async () => {
    await inTenantTx(async () => {
      assert.equal(await alerts(), 0)
      await db.query(`SELECT public.bob_autobotz_record_verification($1, false, 'reference not found')`, [AB5])
      assert.equal(await alerts(), 1)
      await db.query(`SELECT public.bob_autobotz_record_verification($1, false, 'still not found')`, [AB5])
      assert.equal(await alerts(), 2)
      await db.query(`SELECT public.bob_autobotz_record_verification($1, true, 'resolved')`, [AB5])
      assert.equal(await alerts(), 2)
      assert.equal(await state(AB5), 'ok')
    })
  })

  test('a failure written directly, not through the function, still alerts', async () => {
    await inTx(async () => {
      await db.query(`UPDATE autobotz SET verify_state = 'failed', verified_at = now() WHERE id = $1`, [AB5])
      assert.equal(await alerts(), 1)
    })
  })
})

// ── RS-34 ──────────────────────────────────────────────────────────────────
describe('RS-34 · the Action response picker shows each binding\'s state', () => {
  test('every binding of the tenant, once, with the derived state; none of another tenant', async () => {
    await inTenantTx(async () => {
      const { rows: picker } = await db.query(
        'SELECT autobotz_id, verification_state FROM v_action_binding_picker ORDER BY 1')
      const { rows: registry } = await db.query(`
        SELECT id AS autobotz_id, public.bob_autobotz_state(verify_state, verified_at, now()) AS verification_state
          FROM autobotz ORDER BY 1`)
      assert.ok(registry.length >= 6, 'the fixture is not exercising the picker')
      assert.deepEqual(picker, registry)
      assert.ok(!picker.some((p) => p.autobotz_id === B_HOOK), 'the picker shows another tenant')
    })
  })
})

// ── RS-35 ──────────────────────────────────────────────────────────────────
describe('RS-35 · a safe verification never causes a side effect', () => {
  // Every row count in every tenant table, found. Verify may touch the binding
  // and, on failure, the alert log. Nothing else, and never the outbox.
  async function counts() {
    const out = {}
    for (const t of await tenantTables(db)) {
      out[t.qualified] = (await db.query(`SELECT count(*)::int AS n FROM ${t.qualified}`)).rows[0].n
    }
    return out
  }

  test('Verify records its result and writes no intention, and nothing else', async () => {
    await inTx(async () => {
      // The owner counts every table; Verify still needs a tenant's claim.
      await db.query('SELECT set_config($1, $2, true)',
        ['request.jwt.claims', JSON.stringify({ org_id: TENANT_A })])
      const before = await counts()
      assert.ok('bob.outbound_queue' in before, 'the outbox is not among the tables found')
      await db.query(`SELECT public.bob_autobotz_record_verification($1, true, 'resolved')`, [AB1])
      assert.deepEqual(await counts(), before)
      await db.query(`SELECT public.bob_autobotz_record_verification($1, false, 'gone')`, [AB1])
      const after = await counts()
      const changed = Object.keys(after).filter((k) => after[k] !== before[k])
      assert.deepEqual(changed, ['bob.alert_log'])
    })
  })
})

// ── Only Verify writes a verdict ───────────────────────────────────────────
// Every verification column in BOb's schemas, found by name. None may be
// written directly by the application's roles: the verdict comes from Verify,
// whose time is the database's clock, so it can neither be claimed nor dated
// into the future to stay fresh forever.
const WRITERS = ['bob_app', 'authenticated', 'anon']
async function verdictColumnFindings() {
  const { rows } = await db.query(`
    SELECT table_schema, table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'bob' AND column_name IN ('verify_state', 'verified_at', 'verify_msg')`)
  assert.ok(rows.some((r) => r.table_name === 'autobotz' && r.column_name === 'verify_state'),
    'the verdict discovery found nothing')
  const findings = []
  for (const r of rows) {
    for (const role of WRITERS) for (const p of ['INSERT', 'UPDATE']) {
      const { rows: [h] } = await db.query('SELECT has_column_privilege($1, $2::regclass, $3, $4) AS h',
        [role, `${r.table_schema}.${r.table_name}`, r.column_name, p])
      if (h.h) findings.push(`${role} ${p} ${r.table_name}.${r.column_name}`)
    }
  }
  return findings
}

describe('RS-30, RS-31 · only Verify writes a verdict, and only with the database\'s clock', () => {
  test('no application role can write a verification column', async () => {
    assert.deepEqual(await verdictColumnFindings(), [])
  })

  test('as a tenant, claiming a verification directly is refused', async () => {
    await inTenantTx(async () => {
      assert.equal((await refusal(`UPDATE autobotz SET verify_state = 'ok' WHERE id = $1`, [AB5]))?.code, '42501')
      assert.equal((await refusal(`UPDATE autobotz SET verified_at = now() WHERE id = $1`, [AB5]))?.code, '42501')
      assert.equal((await refusal(`
        INSERT INTO autobotz (org_id, type, label, reference, mutative, verify_state)
        VALUES ($1, 'agent', 'x', 'agents/x', false, 'ok')`, [TENANT_A]))?.code, '42501')
      // What the tenant may still do: register a binding and edit it.
      await db.query(`INSERT INTO autobotz (org_id, type, label, reference, mutative)
                      VALUES ($1, 'agent', 'Allowed', 'agents/y', false)`, [TENANT_A])
      await db.query(`UPDATE autobotz SET label = 'Renamed' WHERE id = $1`, [AB5])
    })
  })

  test('Verify stamps its own time, and cannot reach another tenant\'s binding', async () => {
    await inTenantTx(async () => {
      await db.query(`SELECT public.bob_autobotz_record_verification($1, true, 'ok')`, [AB5])
      const { rows: [r] } = await db.query(
        'SELECT verified_at >= now() AND verified_at <= clock_timestamp() AS stamped FROM autobotz WHERE id = $1', [AB5])
      assert.equal(r.stamped, true)
      assert.equal((await refusal(`SELECT public.bob_autobotz_record_verification($1, true, 'x')`, [B_HOOK]))?.code, 'P0002')
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_proc
        WHERE proname = 'bob_autobotz_record_verification' AND pronargs <> 3`)
      assert.equal(rows[0].n, 0, 'Verify still takes a caller-supplied time')
    })
  })
})

// ── The webhook move ───────────────────────────────────────────────────────
// The migration that moves webhook entries, found by what it executes.
function moveMigration() {
  const found = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).filter((f) =>
    /^\s*DELETE FROM bob\.notification_channels WHERE type = 'webhook'/m
      .test(readFileSync(join(MIGRATIONS, f), 'utf8')))
  assert.equal(found.length, 1, `expected one migration to move webhooks, found: ${found.join(', ') || 'none'}`)
  return readFileSync(join(MIGRATIONS, found[0]), 'utf8')
}

// Put the two tables back the way the chain had them before the move.
async function beforeTheMove() {
  await db.query('ALTER TABLE bob.response_rules DROP COLUMN autobotz_id CASCADE')
  await db.query('ALTER TABLE bob.autobotz DROP CONSTRAINT autobotz_org_id_id_key CASCADE')
  await db.query(`ALTER TABLE bob.response_rules ADD COLUMN webhook_url TEXT,
                  ADD COLUMN webhook_method TEXT DEFAULT 'POST', ADD COLUMN webhook_payload TEXT`)
  await db.query(`ALTER TABLE bob.notification_channels DROP CONSTRAINT notification_channels_type_check,
                  ADD CONSTRAINT notification_channels_type_check
                  CHECK (type IN ('email','sms','call','slack','webhook'))`)
}

const body = () => moveMigration().replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '')

describe('Webhook entries move to the AutoBotz registry, and Action responses repoint, at once', () => {
  test('the file is one transaction: BEGIN first, COMMIT last, and nothing outside', () => {
    const statements = moveMigration().replace(/--[^\n]*/g, '').split(';')
      .map((x) => x.trim()).filter(Boolean)
    assert.equal(statements[0], 'BEGIN')
    assert.equal(statements.at(-1), 'COMMIT')
    assert.equal(statements.filter((x) => /^(BEGIN|COMMIT|ROLLBACK)$/i.test(x)).length, 2)
  })

  test('replayed and made to fail at its last step, the move leaves nothing behind', async () => {
    await inTx(async () => {
      await beforeTheMove()
      const W = 'aaaaaaaa-4444-4000-8000-0000000000e3'
      await db.query(`INSERT INTO notification_channels (id, org_id, type, label, values)
                      VALUES ($1, $2, 'webhook', 'A hook', '{https://hooks.example.test/a}')`, [W, TENANT_A])
      const { rows: [r] } = await db.query(`
        INSERT INTO response_rules (org_id, type, name, channel_ids)
        VALUES ($1, 'action', 'By channel', ARRAY[$2]::uuid[]) RETURNING id`, [TENANT_A, W])
      // The last data step is the DELETE from the communication registry.
      await db.query(`CREATE FUNCTION pg_temp.refuse() RETURNS trigger LANGUAGE plpgsql
                      AS $f$ BEGIN RAISE EXCEPTION 'injected at the last step'; END $f$`)
      await db.query(`CREATE TRIGGER zz_refuse BEFORE DELETE ON bob.notification_channels
                      FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse()`)
      const e = await refusal(body())
      assert.match(e?.message ?? '', /injected at the last step/)
      const { rows: moved } = await db.query('SELECT id FROM autobotz WHERE id = $1', [W])
      assert.deepEqual(moved, [], 'the binding exists although the move failed')
      const { rows: [still] } = await db.query(
        'SELECT channel_ids, webhook_url IS NULL AS no_inline FROM response_rules WHERE id = $1', [r.id])
      assert.deepEqual(still, { channel_ids: [W], no_inline: true }, 'the Action response was repointed by a failed move')
    })
  })

  test('replayed: every webhook becomes a binding, and every Action response points at one', async () => {
    await inTx(async () => {
      await beforeTheMove()
      const W = 'aaaaaaaa-4444-4000-8000-0000000000e1'
      await db.query(`INSERT INTO notification_channels (id, org_id, type, label, values)
                      VALUES ($1, $2, 'webhook', 'A hook', '{https://hooks.example.test/a}')`, [W, TENANT_A])
      const { rows: [r1] } = await db.query(`
        INSERT INTO response_rules (org_id, type, name, channel_ids)
        VALUES ($1, 'action', 'By channel', ARRAY[$2, $3]::uuid[]) RETURNING id`, [TENANT_A, W, EMAIL_A])
      const { rows: [r2] } = await db.query(`
        INSERT INTO response_rules (org_id, type, name, webhook_url, webhook_method, webhook_payload)
        VALUES ($1, 'action', 'Inline', 'https://hooks.example.test/inline', 'PUT', '{"x":1}')
        RETURNING id`, [TENANT_A])
      const { rows: [r3] } = await db.query(`
        INSERT INTO response_rules (org_id, type, name, channel_ids)
        VALUES ($1, 'alert', 'Mail only', ARRAY[$2]::uuid[]) RETURNING id`, [TENANT_A, EMAIL_A])

      await db.query(body())

      const { rows: [b1] } = await db.query(
        'SELECT type, reference, mutative, requires_approval, verify_state FROM autobotz WHERE id = $1', [W])
      assert.deepEqual(b1, { type: 'webhook', reference: 'https://hooks.example.test/a',
        mutative: true, requires_approval: true, verify_state: 'unverified' })
      const rr = async (id) => (await db.query(
        'SELECT autobotz_id, channel_ids FROM response_rules WHERE id = $1', [id])).rows[0]
      assert.deepEqual(await rr(r1.id), { autobotz_id: W, channel_ids: [EMAIL_A] })
      const inline = await rr(r2.id)
      const { rows: [b2] } = await db.query(
        'SELECT reference, binding FROM autobotz WHERE id = $1', [inline.autobotz_id])
      assert.deepEqual(b2, { reference: 'https://hooks.example.test/inline',
        binding: { method: 'PUT', payload: '{"x":1}' } })
      assert.deepEqual(await rr(r3.id), { autobotz_id: null, channel_ids: [EMAIL_A] })
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM notification_channels WHERE type = 'webhook'`)
      assert.equal(rows[0].n, 0)
    })
  })

  test('replayed: an alert that sends to a webhook stops the move and is named', async () => {
    await inTx(async () => {
      await beforeTheMove()
      const W = 'aaaaaaaa-4444-4000-8000-0000000000e2'
      await db.query(`INSERT INTO notification_channels (id, org_id, type, label, values)
                      VALUES ($1, $2, 'webhook', 'A hook', '{https://hooks.example.test/a}')`, [W, TENANT_A])
      await db.query(`INSERT INTO response_rules (org_id, type, name, channel_ids)
                      VALUES ($1, 'alert', 'Pages a hook', ARRAY[$2]::uuid[])`, [TENANT_A, W])
      const e = await refusal(body())
      assert.match(e?.message ?? '', /Pages a hook/)
    })
  })

  test('the communication registry refuses a webhook, and no webhook column is left', async () => {
    await inTx(async () => {
      const e = await refusal(`INSERT INTO notification_channels (org_id, type, label, values)
                               VALUES ($1, 'webhook', 'Late', '{https://x.example.test}')`, [TENANT_A])
      assert.equal(e?.code, '23514')
      const { rows } = await db.query(`
        SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'bob' AND column_name LIKE 'webhook%'`)
      assert.deepEqual(rows, [])
    })
  })

  test('an Action response needs a binding of its own tenant, and only an Action has one', async () => {
    await inTx(async () => {
      const none = await refusal(`INSERT INTO response_rules (org_id, type, name) VALUES ($1, 'action', 'x')`, [TENANT_A])
      assert.equal(none?.code, '23514')
      const alert = await refusal(`INSERT INTO response_rules (org_id, type, name, autobotz_id)
                                   VALUES ($1, 'alert', 'x', $2)`, [TENANT_A, AB5])
      assert.equal(alert?.code, '23514')
      // B's binding is mutative; with a limit, only the tenant key can refuse it.
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 5 WHERE id = $1', [B_HOOK])
      const foreign = await refusal(`INSERT INTO response_rules (org_id, type, name, autobotz_id)
                                     VALUES ($1, 'action', 'x', $2)`, [TENANT_A, B_HOOK])
      assert.equal(foreign?.code, '23503')
    })
  })
})

// ── The rule may not attach an unlimited real-world binding ────────────────
describe('A binding that changes the real world is attached only with a limit', () => {
  test('mutative with no limit is refused; with one it is accepted; not mutative needs none', async () => {
    await inTx(async () => {
      const bare = await refusal(`INSERT INTO response_rules (org_id, type, name, autobotz_id)
                                  VALUES ($1, 'action', 'x', $2)`, [TENANT_A, AB1])
      assert.equal(bare?.code, '23514')
      assert.match(bare.message, /limit/)
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 10 WHERE id = $1', [AB1])
      await db.query(`INSERT INTO response_rules (org_id, type, name, autobotz_id)
                      VALUES ($1, 'action', 'x', $2)`, [TENANT_A, AB1])
      await db.query(`INSERT INTO response_rules (org_id, type, name, autobotz_id)
                      VALUES ($1, 'action', 'y', $2)`, [TENANT_A, AB5])
    })
  })

  test('the limit cannot be taken away while a rule attaches the binding', async () => {
    await inTx(async () => {
      await db.query('UPDATE autobotz SET invocation_cap_daily = 5 WHERE id = $1', [AB1])
      await actionFor(AB1)
      const e = await refusal('UPDATE autobotz SET invocation_cap_daily = NULL WHERE id = $1', [AB1])
      assert.equal(e?.code, '23514')
    })
  })
})

// ── The outbox ─────────────────────────────────────────────────────────────
describe('The outbox · limits apply when the intention is written', () => {
  test('with a limit of ten an hour, the eleventh intention is refused, as a suppressed row', async () => {
    await inTenantTx(async () => {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 10 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1)
      for (let i = 1; i <= 10; i++) await intend(TENANT_A, rule, alert, `k-${i}`)
      suppressedAs(await written(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
                                  VALUES ($1, $2, $3, 'k-11')`, [TENANT_A, rule, alert]), 'rate_limit_per_hour')
      // A suppressed row counts toward nothing: the twelfth is refused the same way, not by it.
      suppressedAs(await written(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
                                  VALUES ($1, $2, $3, 'k-12')`, [TENANT_A, rule, alert]), 'rate_limit_per_hour')
    })
  })

  test('the daily cap and the concurrency limit refuse the same way', async () => {
    await inTenantTx(async () => {
      await db.query('UPDATE autobotz SET invocation_cap_daily = 2 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1)
      await intend(TENANT_A, rule, alert, 'd-1'); await intend(TENANT_A, rule, alert, 'd-2')
      suppressedAs(await written(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
                                  VALUES ($1, $2, $3, 'd-3')`, [TENANT_A, rule, alert]), 'invocation_cap_daily')
      await db.query('UPDATE autobotz SET invocation_cap_daily = NULL, rate_limit_per_hour = 50, concurrency_limit = 2 WHERE id = $1', [AB1])
      suppressedAs(await written(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
                                  VALUES ($1, $2, $3, 'c-3')`, [TENANT_A, rule, alert]), 'concurrency_limit')
    })
  })

  test('an intention cannot backdate itself out of the window', async () => {
    await inTenantTx(async () => {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 1 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1)
      await intend(TENANT_A, rule, alert, 'b-1')
      suppressedAs(await written(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key, created_at)
                                  VALUES ($1, $2, $3, 'b-2', now() - interval '2 hours')`, [TENANT_A, rule, alert]),
      'rate_limit_per_hour')
    })
  })

  test('a mutative binding with no limit cannot be written to, even if it is already attached', async () => {
    await inTx(async () => {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 10 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1)
      await db.query('ALTER TABLE response_rules DISABLE TRIGGER USER')
      await db.query('ALTER TABLE autobotz DISABLE TRIGGER USER')
      await db.query('UPDATE autobotz SET rate_limit_per_hour = NULL WHERE id = $1', [AB1])
      await db.query('ALTER TABLE autobotz ENABLE TRIGGER USER')
      await db.query('ALTER TABLE response_rules ENABLE TRIGGER USER')
      const e = await refusal(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
                               VALUES ($1, $2, $3, 'n-1')`, [TENANT_A, rule, alert])
      assert.match(e?.message ?? '', /declares no limit/)
    })
  })

  test('a disabled binding, a duplicate key, and a binding the rule does not attach are refused', async () => {
    await inTenantTx(async () => {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 10 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1)
      await intend(TENANT_A, rule, alert, 'dup')
      assert.equal((await refusal(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
                                   VALUES ($1, $2, $3, 'dup')`, [TENANT_A, rule, alert]))?.code, '23505')
      assert.ok(await refusal(`INSERT INTO outbound_queue (org_id, response_rule_id, autobotz_id, alert_log_id, idempotency_key)
                               VALUES ($1, $2, $3, $4, 'other')`, [TENANT_A, rule, AB5, alert]))
      await db.query('UPDATE autobotz SET enabled = false WHERE id = $1', [AB1])
      suppressedAs(await written(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
                                  VALUES ($1, $2, $3, 'off')`, [TENANT_A, rule, alert]), 'binding_disabled')
    })
  })
})

describe('The outbox · approval, the causing alert, and what drains', () => {
  test('a binding that requires approval is written awaiting approval, and nothing drains it', async () => {
    await inTenantTx(async () => {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 10 WHERE id = $1', [AB3])
      const { rule, alert } = await actionFor(AB3)
      const { rows: [q] } = await intend(TENANT_A, rule, alert, 'appr-1')
      assert.equal(q.state, 'awaiting_approval')
      // The drain belongs to bob_app; as the owner, inside this transaction.
      await db.query('RESET ROLE')
      const drained = await db.query('SELECT * FROM public.bob_outbox_drain(100)')
      assert.equal(drained.rows.filter((r) => r.id === q.id).length, 0)
      const moved = await refusal(`UPDATE outbound_queue SET state = 'drained' WHERE id = $1`, [q.id])
      assert.equal(moved?.code, '23514')
    })
  })

  test('an intention is written queued and moves only to drained, once', async () => {
    await inAppTx(async () => {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 10 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1)
      const pre = await refusal(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key, state)
                                 VALUES ($1, $2, $3, 'pre', 'drained')`, [TENANT_A, rule, alert])
      assert.equal(pre?.code, '23514')
      const { rows: [q] } = await intend(TENANT_A, rule, alert, 'once')
      assert.equal(q.state, 'queued')
      await db.query(`UPDATE outbound_queue SET state = 'drained' WHERE id = $1`, [q.id])
      assert.equal((await refusal(`UPDATE outbound_queue SET state = 'queued' WHERE id = $1`, [q.id]))?.code, '23514')
      assert.equal((await refusal(`UPDATE outbound_queue SET idempotency_key = 'x' WHERE id = $1`, [q.id]))?.code, '23514')
    })
  })

  test('the intention carries the alert that caused it, from its own tenant', async () => {
    await inTx(async () => {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 20 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1)
      for (let i = 0; i < 14; i++) await intend(TENANT_A, rule, alert, `why-${i}`)
      const missing = await refusal(`INSERT INTO outbound_queue (org_id, response_rule_id, idempotency_key)
                                     VALUES ($1, $2, 'no-alert')`, [TENANT_A, rule])
      assert.equal(missing?.code, '23502')
      const { rows: [b] } = await db.query(`
        INSERT INTO alert_log (org_id, metric_id, metric_name, alert_type, severity)
        VALUES ($1, 'm', 'M', 'upper', 'info') RETURNING id`, [TENANT_B])
      const foreign = await refusal(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
                                     VALUES ($1, $2, $3, 'foreign')`, [TENANT_A, rule, b.id])
      assert.equal(foreign?.code, '23503')
      // Why did fourteen go out? A query, not an investigation.
      const { rows } = await db.query(`
        SELECT a.metric_id, a.value, count(*)::int AS n FROM outbound_queue q
          JOIN alert_log a ON a.org_id = q.org_id AND a.id = q.alert_log_id
         WHERE q.autobotz_id = $1 GROUP BY 1, 2`, [AB1])
      assert.deepEqual(rows, [{ metric_id: 'abandonment', value: '12', n: 14 }])
    })
  })
})

// ── The trace from action to alert cannot be cut ───────────────────────────
// Every table that holds a key to alert_log, found. Deleting a row from one
// would lose why an action happened, and deleting an intention would also give
// its binding room under its limit again. Only bob_app moves an intention, and
// only through the drain's one transition.
async function traceFindings() {
  const { rows: tables } = await db.query(`
    SELECT DISTINCT format('%I.%I', n.nspname, c.relname) AS qualified
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE k.contype = 'f' AND k.confrelid = 'bob.alert_log'::regclass`)
  assert.ok(tables.some((t) => t.qualified === 'bob.outbound_queue'), 'the trace discovery found nothing')
  const findings = []
  for (const t of tables) {
    for (const role of WRITERS) {
      const { rows: [h] } = await db.query(`
        SELECT has_table_privilege($1, $2::regclass, 'DELETE') AS del,
               has_table_privilege($1, $2::regclass, 'TRUNCATE') AS trunc,
               has_any_column_privilege($1, $2::regclass, 'UPDATE') AS upd`, [role, t.qualified])
      if (h.del) findings.push(`${role} DELETE ${t.qualified}`)
      if (h.trunc) findings.push(`${role} TRUNCATE ${t.qualified}`)
      if (h.upd && role !== 'bob_app') findings.push(`${role} UPDATE ${t.qualified}`)
    }
  }
  return findings
}

describe('The outbox · the trace from action to alert cannot be cut', () => {
  test('no application role deletes a row that keys an alert; only bob_app updates one', async () => {
    assert.deepEqual(await traceFindings(), [])
  })

  test('as a tenant, deleting or draining an intention directly is refused', async () => {
    await inTenantTx(async () => {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 1 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1)
      const { rows: [q] } = await intend(TENANT_A, rule, alert, 'cut-1')
      assert.equal((await refusal('DELETE FROM outbound_queue WHERE id = $1', [q.id]))?.code, '42501')
      assert.equal((await refusal(`UPDATE outbound_queue SET state = 'drained' WHERE id = $1`, [q.id]))?.code, '42501')
      // And the limit still holds: the one written counts.
      suppressedAs(await written(`INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
                                  VALUES ($1, $2, $3, 'cut-2')`, [TENANT_A, rule, alert]), 'rate_limit_per_hour')
    })
  })
})

describe('The outbox · the clock is the statement\'s, not the transaction\'s', () => {
  test('a long transaction cannot date its intentions at its own start', async () => {
    await inAppTx(async () => {
      await db.query('RESET ROLE')
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 10 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1)
      await db.query('SET LOCAL ROLE bob_app')
      await db.query('SELECT pg_sleep(0.05)')
      const { rows: [q] } = await intend(TENANT_A, rule, alert, 'clock-1')
      const { rows: [c] } = await db.query('SELECT $1::timestamptz > now() AS later', [q.created_at])
      assert.equal(c.later, true, 'the intention carries the transaction start')
      await db.query('SELECT pg_sleep(0.05)')
      const { rows: [d] } = await db.query('SELECT * FROM public.bob_outbox_drain(100) WHERE id = $1', [q.id])
      assert.ok(new Date(d.drained_at) > new Date(q.created_at), 'drained_at is not the statement\'s clock')
    })
  })
})

// ── Admission needs a verified, fresh binding (Henry, 21 Nov) ──────────────
describe('The outbox · only a binding whose verification passed and is fresh gets an intention', () => {
  const write = (rule, alert, key) => written(`
    INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
    VALUES ($1, $2, $3, $4)`, [TENANT_A, rule, alert, key])

  test('never verified is refused, and so is a binding edited since it passed', async () => {
    await inTx(async () => {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 10 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1, TENANT_A, { verify: false })
      suppressedAs(await write(rule, alert, 'v-1'), 'binding_unverified')
      await verifyOk(AB1)
      assert.deepEqual(await write(rule, alert, 'v-2'), { state: 'queued', suppressed_reason: null })
      await db.query('UPDATE autobotz SET reference = $2 WHERE id = $1', [AB1, 'https://example.com/hook-2'])
      suppressedAs(await write(rule, alert, 'v-3'), 'binding_unverified')
    })
  })

  test('a failed verification and a stale one are refused', async () => {
    await inTx(async () => {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 10 WHERE id = $1', [AB1])
      const { rule, alert } = await actionFor(AB1)
      await db.query(`
        WITH c AS MATERIALIZED (SELECT set_config('request.jwt.claims', $2, true) AS x)
        SELECT public.bob_autobotz_record_verification($1, false, 'gone') FROM c`,
      [AB1, JSON.stringify({ org_id: TENANT_A })])
      suppressedAs(await write(rule, alert, 's-1'), 'binding_failed')
      await db.query(`UPDATE autobotz SET verify_state = 'ok',
                      verified_at = now() - interval '31 days' WHERE id = $1`, [AB1])
      suppressedAs(await write(rule, alert, 's-2'), 'binding_stale')
    })
  })
})

// Two writers at once, on two connections, each as bob_app under A's claim.
describe('Concurrency · two writers cannot both find room', () => {
  let c1, c2
  const rules = []
  before(async () => {
    c1 = await connectAs('bob_app'); c2 = await connectAs('bob_app')
  })
  after(async () => {
    await c1?.end(); await c2?.end()
    await db.query('DELETE FROM outbound_queue WHERE response_rule_id = ANY($1)', [rules])
    await db.query('DELETE FROM response_rules WHERE id = ANY($1)', [rules])
    await db.query('DELETE FROM alert_log WHERE org_id = $1 AND metric_id = $2', [TENANT_A, 'abandonment'])
    await db.query('UPDATE autobotz SET rate_limit_per_hour = NULL WHERE id = $1', [AB1])
  })
  const claim = (c) => c.query('SELECT set_config($1, $2, true)',
    ['request.jwt.claims', JSON.stringify({ org_id: TENANT_A })])
  const settle = (p) => p.then(() => null, (e) => e)
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))

  test('with a limit of one an hour, the second of two concurrent intentions is suppressed', async () => {
    await db.query('UPDATE autobotz SET rate_limit_per_hour = 1 WHERE id = $1', [AB1])
    const { rule, alert } = await actionFor(AB1)
    rules.push(rule)
    const sql = `INSERT INTO outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
                 VALUES ($1, $2, $3, $4) RETURNING state, suppressed_reason`
    await c1.query('BEGIN'); await claim(c1)
    await c2.query('BEGIN'); await claim(c2)
    await c1.query(sql, [TENANT_A, rule, alert, 'race-1'])
    const second = c2.query(sql, [TENANT_A, rule, alert, 'race-2']).then((r) => r.rows[0], (e) => ({ error: e.message }))
    await pause(300)
    await c1.query('COMMIT')
    const r = await second
    await c2.query(r.error ? 'ROLLBACK' : 'COMMIT')
    suppressedAs(r, 'rate_limit_per_hour')
  })

  test('a rule attaching a binding and an edit removing its limit cannot both win', async () => {
    await db.query('UPDATE autobotz SET rate_limit_per_hour = 5 WHERE id = $1', [AB1])
    await db.query('DELETE FROM outbound_queue WHERE response_rule_id = ANY($1)', [rules])
    await db.query('DELETE FROM response_rules WHERE id = ANY($1)', [rules])
    rules.length = 0
    await c1.query('BEGIN'); await claim(c1)
    await c2.query('BEGIN'); await claim(c2)
    const { rows: [r] } = await c1.query(`INSERT INTO response_rules (org_id, type, name, autobotz_id)
                                          VALUES ($1, 'action', 'Race', $2) RETURNING id`, [TENANT_A, AB1])
    rules.push(r.id)
    const edit = settle(c2.query('UPDATE autobotz SET rate_limit_per_hour = NULL WHERE id = $1', [AB1]))
    await pause(300)
    await c1.query('COMMIT')
    const e = await edit
    await c2.query(e ? 'ROLLBACK' : 'COMMIT')
    assert.equal(e?.code ?? 'the limit was removed under an attached rule', '23514')
  })
})

// ── BOb holds no customer credential ───────────────────────────────────────
// Every column in every schema BOb or Supabase made outside Supabase's own,
// found. A column named for a secret is a credential BOb would be holding.
// `token` only as the end of a name: bobee_conversations.token_count counts
// model tokens and holds nothing.
const CREDENTIAL = /(secret|passw|credential|api_?key|private_?key|(^|_)token$)/i
async function credentialColumns() {
  const { rows } = await db.query(`
    SELECT table_schema, table_name, column_name FROM information_schema.columns
     WHERE table_schema IN (SELECT nspname FROM pg_namespace
                             WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN
                               ('information_schema','auth','storage','realtime','supabase_functions',
                                'supabase_migrations','extensions','graphql','graphql_public',
                                'vault','pgsodium','pgsodium_masks','net','_realtime','_analytics','pgbouncer'))`)
  assert.ok(rows.some((r) => r.table_name === 'autobotz'), 'the column discovery found nothing in bob')
  return rows.filter((r) => CREDENTIAL.test(r.column_name))
    .map((r) => `${r.table_schema}.${r.table_name}.${r.column_name}`)
}

describe('BOb never holds a customer credential', () => {
  test('no column in BOb\'s schemas is named for a secret', async () => {
    assert.deepEqual(await credentialColumns(), [])
  })
  test('the guard reports one when there is one', async () => {
    await inTx(async () => {
      await db.query('ALTER TABLE bob.autobotz ADD COLUMN api_token TEXT')
      assert.deepEqual(await credentialColumns(), ['bob.autobotz.api_token'])
    })
  })
})

// ── Read back through the real projection path ─────────────────────────────
describe('The outbox drains to a stub, and the outcome is read back as a projection', () => {
  test('two queued intentions drain, one awaiting approval does not, and proj_deliveries says so', async () => {
    const rules = []
    try {
      await db.query('UPDATE autobotz SET rate_limit_per_hour = 10 WHERE id = ANY($1)', [[AB1, AB3]])
      const go = await actionFor(AB1)
      const wait = await actionFor(AB3)
      rules.push(go.rule, wait.rule)
      const { rows: [q1] } = await intend(TENANT_A, go.rule, go.alert, 'e2e-1')
      const { rows: [q2] } = await intend(TENANT_A, go.rule, go.alert, 'e2e-2')
      const { rows: [q3] } = await intend(TENANT_A, wait.rule, wait.alert, 'e2e-3')

      const events = await drainToStub(app, {
        orgId: TENANT_A, tenantSlug: 'tenant-a', sourceKey: 'tenant-a.whatsapp',
      })
      assert.deepEqual(events.map((e) => e.attributes.outbound_id).sort(), [q1.id, q2.id].sort())

      const at = new Date(events[0].event_time).getTime()
      const from = new Date(Math.floor(at / 300_000) * 300_000)
      const to = new Date(from.getTime() + 600_000)
      await runFeeder(feeder, new MemoryTruthStore({ events, watermark: to }),
        { from, to, orgIds: [TENANT_A] })

      await app.query('BEGIN')
      try {
        await app.query('SELECT set_config($1, $2, true)',
          ['request.jwt.claims', JSON.stringify({ org_id: TENANT_A })])
        const { rows } = await app.query(`
          SELECT q.idempotency_key, q.state, d.kind, d.provider, d.outcome
            FROM outbound_queue q LEFT JOIN proj_deliveries d
              ON d.org_id = q.org_id AND d.outbound_id = q.id
           WHERE q.id = ANY($1) ORDER BY 1`, [[q1.id, q2.id, q3.id]])
        assert.deepEqual(rows, [
          { idempotency_key: 'e2e-1', state: 'drained', kind: 'autobotz', provider: 'stub', outcome: 'delivered' },
          { idempotency_key: 'e2e-2', state: 'drained', kind: 'autobotz', provider: 'stub', outcome: 'delivered' },
          { idempotency_key: 'e2e-3', state: 'awaiting_approval', kind: null, provider: null, outcome: null },
        ])
      } finally { await app.query('ROLLBACK') }
    } finally {
      await db.query(`DELETE FROM proj_deliveries WHERE org_id = $1 AND provider = 'stub'`, [TENANT_A])
      await db.query('DELETE FROM outbound_queue WHERE response_rule_id = ANY($1)', [rules])
      await db.query('DELETE FROM response_rules WHERE id = ANY($1)', [rules])
      await db.query('UPDATE autobotz SET rate_limit_per_hour = NULL WHERE id = ANY($1)', [[AB1, AB3]])
    }
  })

  test.todo('end to end: a drained intention reaches a real provider and its outcome returns. ' +
    'Not testable until execution exists; BOb v1 writes intentions and never executes them')
})

// F-47. The drain runs under the caller's claim, so only a role that meets RLS
// may call it. Read from the catalog, not from the migration: every role that
// is not a superuser and can EXECUTE it, through PUBLIC or membership too.
test('F-47 · of the roles that are not superusers and do not own it, bob_app alone can call the outbox drain', async () => {
  const { rows } = await db.query(`
    SELECT r.rolname FROM pg_roles r
     WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%'
       AND r.oid <> (SELECT proowner FROM pg_proc WHERE oid = 'public.bob_outbox_drain(integer)'::regprocedure)
       AND has_function_privilege(r.oid, 'public.bob_outbox_drain(integer)', 'EXECUTE')
     ORDER BY 1`)
  assert.deepEqual(rows.map((r) => r.rolname), ['bob_app'])
})
