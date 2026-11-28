// Slice 5 · thresholds, cooldown, escalation and the evaluator, against
// docs/slice-5-thresholds.md §12. Each guard was seen failing before it was
// trusted: first against the chain without the Slice 5 migrations, then by
// sabotage. The table is in contract-amendments.md, "Slice 5 · built".
//
// The world is the two-tenant fixture, the roster and the Slice 3 world. The
// figures are projection rows written here, inside a transaction that rolls
// back, so every bucket's value and seal is chosen by the test. The evaluator
// runs with an injected clock (bob_evaluate_at), as the migration owner.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  connect, connectAs, loadFixture, loadRoster, loadFeederWorld, loadSlice3World, loadBr3Rulings,
  tenantTables, TENANT_A, TENANT_B, DB_URL, REPO_ROOT,
} from './helpers/db.mjs'
import pg from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const WHATSAPP = 'aaaaaaaa-2222-4000-8000-000000000001'  // lag 0
const VOICE = 'aaaaaaaa-2222-4000-8000-00000000000a'     // lag 900
const WEBSITE = 'aaaaaaaa-2222-4000-8000-00000000000b'   // lag NULL (roster.sql:36)
const AB1 = 'aaaaaaaa-3333-4000-8000-0000000000a1'       // webhook, mutative, no approval
const T0 = Date.parse('2026-11-25T10:00:00Z')
const B = 300_000
const at = (i) => new Date(T0 + i * B).toISOString()

let db, app
let METRIC, ACTOR   // a configured count metric on WhatsApp, discovered

before(async () => {
  db = await connect()
  await loadFixture(db)
  await loadRoster(db)
  await loadFeederWorld(db)
  await loadSlice3World(db)
  await loadBr3Rulings(db)
  await db.query('GRANT bob_app TO current_user')
  app = await connectAs('bob_app')
  await db.query(`SELECT bob.proj_ensure_partition('bob.proj_metric_counts'::regclass, '2026-11-01')`)
  // A count metric the cell would show on WhatsApp (configured, applicable, no
  // row yet) and on the Website, where it waits on the undeclared lag.
  const { rows } = await db.query(`
    SELECT w.metric, w.actor_type
      FROM bob.bob_cell_state($1, ARRAY[$2]::uuid[], $4, $5) w
      JOIN bob.bob_cell_state($1, ARRAY[$3]::uuid[], $4, $5) x USING (metric, actor_type)
      JOIN bob.cell_catalog k ON k.metric = w.metric
     WHERE k.source = 'proj_metric_counts' AND w.actor_type IS NOT NULL AND NOT k.degenerate
       AND w.state IN ('pending', 'not_observed')
       AND x.state = 'pending' AND x.reasons = ARRAY['lag_not_declared']
     ORDER BY w.metric, w.actor_type LIMIT 1`, [TENANT_A, WHATSAPP, WEBSITE, at(0), at(1)])
  assert.ok(rows.length, 'no count metric configured on both WhatsApp and the Website')
  ;({ metric: METRIC, actor_type: ACTOR } = rows[0])
})
after(async () => {
  await app?.end()
  await db?.query('REVOKE bob_app FROM current_user')
  await db?.end()
})

async function inTx(fn) {
  await db.query('BEGIN')
  try { return await fn() } finally { await db.query('ROLLBACK') }
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

// One row per value, five minutes apart from T0. `null` leaves the bucket
// without a row (absent, not zero). Sealed unless told otherwise.
async function series(values, { channel = WHATSAPP, metric = METRIC, actor = ACTOR,
  org = TENANT_A, sealed = true, from = 0 } = {}) {
  for (const [k, v] of values.entries()) {
    if (v === null) continue
    const i = from + k
    await db.query(`
      INSERT INTO bob.proj_metric_counts (org_id, channel_id, actor_type, metric_id,
        bucket_start, event_count, session_count, sealed, source_watermark, feeder_version)
      VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, 'slice5-test')`,
    [org, channel, actor, metric, at(i), v, sealed, at(i + 1)])
  }
}

async function threshold(cols = {}) {
  const c = { org_id: TENANT_A, metric_id: METRIC, upper_bound: 10, scope_kind: 'entity',
    scope_ref: WHATSAPP, ...cols }
  const keys = Object.keys(c)
  const { rows: [r] } = await db.query(
    `INSERT INTO bob.threshold_configs (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(c))
  return r.id
}

async function response(thresholdId, cols = {}) {
  const c = { org_id: TENANT_A, threshold_id: thresholdId, type: 'alert', name: 'slice5', ...cols }
  const keys = Object.keys(c)
  const { rows: [r] } = await db.query(
    `INSERT INTO bob.response_rules (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(c))
  return r.id
}

const evaluate = async (i, org = TENANT_A) => (await db.query(
  'SELECT * FROM bob.bob_evaluate_at($1, $2)', [org, at(i)])).rows

const alerts = async (thresholdId) => (await db.query(`
  SELECT * FROM bob.alert_log WHERE threshold_id = $1
   ORDER BY bucket_start, created_at, alert_type`, [thresholdId])).rows

// ── Step 6a · the three durations ──────────────────────────────────────────
describe('Step 6a · durations that inherit, with a floor in two places', () => {
  const COLS = ['cooldown_seconds', 'escalation_after_seconds', 'recovery_dwell_seconds']

  test('the defaults are 1800, 7200 and 300, read through one function each', async () => {
    const { rows: [r] } = await db.query(`
      SELECT bob.bob_default_cooldown_seconds() AS c,
             bob.bob_default_escalation_after_seconds() AS e,
             bob.bob_default_recovery_dwell_seconds() AS d`)
    assert.deepEqual([r.c, r.e, r.d], [1800, 7200, 300])
  })

  test('NULL inherits and moves with the function; an explicit 1800 does not move', async () => {
    await inTx(async () => {
      const inherits = await threshold()
      const pinned = await threshold({ scope_ref: VOICE, cooldown_seconds: 1800 })
      await db.query(`CREATE OR REPLACE FUNCTION bob.bob_default_cooldown_seconds()
        RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = bob, public
        BEGIN ATOMIC SELECT bob.bob_duration_floor(2400); END`)
      const { rows } = await db.query(`
        SELECT t.id, (bob.bob_effective_durations(t)).cooldown_seconds AS c
          FROM bob.threshold_configs t WHERE t.id = ANY ($1)`, [[inherits, pinned]])
      const by = Object.fromEntries(rows.map((r) => [r.id, r.c]))
      assert.equal(by[inherits], 2400)
      assert.equal(by[pinned], 1800)
    })
  })

  for (const col of COLS) {
    test(`${col} refuses 299 and accepts 300 and NULL`, async () => {
      await inTx(async () => {
        assert.ok(await refusal(
          `INSERT INTO bob.threshold_configs (org_id, metric_id, ${col}) VALUES ($1, 'x5', 299)`,
          [TENANT_A]), '299 accepted')
        assert.equal(await refusal(
          `INSERT INTO bob.threshold_configs (org_id, metric_id, ${col}) VALUES ($1, 'x6', 300)`,
          [TENANT_A]), null)
        assert.equal(await refusal(
          `INSERT INTO bob.threshold_configs (org_id, metric_id, ${col}) VALUES ($1, 'x7', NULL)`,
          [TENANT_A]), null)
      })
    })
  }

  test('a default function cannot return below the floor', async () => {
    await inTx(async () => {
      await db.query(`CREATE OR REPLACE FUNCTION bob.bob_default_cooldown_seconds()
        RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = bob, public
        BEGIN ATOMIC SELECT bob.bob_duration_floor(120); END`)
      assert.ok(await refusal('SELECT bob.bob_default_cooldown_seconds()'), '120 returned')
    })
  })

  test('every default function goes through the floor (read from pg_depend)', async () => {
    const { rows } = await db.query(`
      SELECT p.proname,
             EXISTS (SELECT 1 FROM pg_depend d JOIN pg_proc f ON f.oid = d.refobjid
                      WHERE d.objid = p.oid AND f.proname = 'bob_duration_floor') AS floored
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'bob' AND p.proname LIKE 'bob\\_default\\_%\\_seconds'`)
    assert.equal(rows.length, 3, JSON.stringify(rows))
    assert.deepEqual(rows.filter((r) => !r.floored), [])
  })

  test('notification_rules keeps no default for suppression_min or escalation_min', async () => {
    const { rows } = await db.query(`
      SELECT column_name, column_default FROM information_schema.columns
       WHERE table_schema = 'bob' AND table_name = 'notification_rules'
         AND column_name IN ('suppression_min', 'escalation_min')`)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.filter((r) => r.column_default !== null), [])
  })

  test('F-48 · two scopes of one metric coexist; the same scope twice is refused', async () => {
    await inTx(async () => {
      await threshold()
      assert.equal(await refusal(`INSERT INTO bob.threshold_configs
        (org_id, metric_id, scope_kind, scope_ref) VALUES ($1, $2, 'entity', $3)`,
      [TENANT_A, METRIC, VOICE]), null)
      assert.ok(await refusal(`INSERT INTO bob.threshold_configs
        (org_id, metric_id, scope_kind, scope_ref) VALUES ($1, $2, 'entity', $3)`,
      [TENANT_A, METRIC, WHATSAPP]), 'duplicate scope accepted')
    })
  })
})

// ── §3 · on the response ───────────────────────────────────────────────────
describe('§3 · trigger_level and sustained_for_seconds', () => {
  test('a trigger level on the inside of the bound is refused', async () => {
    await inTx(async () => {
      const t = await threshold({ upper_bound: 10 })
      assert.ok(await refusal(`INSERT INTO bob.response_rules (org_id, threshold_id, type, trigger_level)
        VALUES ($1, $2, 'alert', 5)`, [TENANT_A, t]), 'level inside the bound accepted')
      assert.equal(await refusal(`INSERT INTO bob.response_rules (org_id, threshold_id, type, trigger_level)
        VALUES ($1, $2, 'alert', 40)`, [TENANT_A, t]), null)
    })
  })

  test('sustained_for_seconds refuses 299', async () => {
    await inTx(async () => {
      const t = await threshold()
      assert.ok(await refusal(`INSERT INTO bob.response_rules (org_id, threshold_id, type, sustained_for_seconds)
        VALUES ($1, $2, 'alert', 299)`, [TENANT_A, t]))
    })
  })
})

// ── §4 · what is evaluated ────────────────────────────────────────────────
describe('§4 · only a sealed, observed cell is evaluated', () => {
  test('A-04 · a channel whose lag is NULL is never evaluated', async () => {
    await inTx(async () => {
      const t = await threshold({ scope_ref: WEBSITE })
      await response(t)
      await series([50, 50, 50], { channel: WEBSITE, sealed: false })
      const out = await evaluate(3)
      assert.deepEqual(await alerts(t), [])
      const mine = out.filter((o) => o.threshold_id === t && o.subject_key.endsWith(`:${WEBSITE}:${ACTOR}`))
      assert.ok(mine.length > 0, 'the refusal was silent')
      assert.ok(mine.every((o) => o.outcome === 'refused' && o.reasons.includes('lag_not_declared')),
        JSON.stringify(mine))
      const { rows } = await db.query(`SELECT last_bucket_evaluated FROM bob.evaluation_state
        WHERE threshold_id = $1 AND actor_type = $2`, [t, ACTOR])
      assert.equal(rows.length, 1)
      assert.ok(rows.every((r) => r.last_bucket_evaluated === null), 'it advanced past an unsealed bucket')
    })
  })

  test('a provisional bucket on a declared channel is not_sealed', async () => {
    await inTx(async () => {
      const t = await threshold()
      await response(t)
      await series([50], { sealed: false })
      const out = (await evaluate(1)).filter((o) => o.threshold_id === t)
      assert.deepEqual(await alerts(t), [])
      assert.ok(out.some((o) => o.reasons.includes('not_sealed')), JSON.stringify(out))
    })
  })

  test('an absent bucket after a breach neither recovers nor breaches', async () => {
    await inTx(async () => {
      const t = await threshold()
      await response(t)
      await series([50, null, 50])
      await evaluate(3)
      const a = await alerts(t)
      assert.deepEqual(a.map((x) => x.alert_type), ['upper'])
      const { rows: [s] } = await db.query(
        'SELECT breached_since FROM bob.evaluation_state WHERE threshold_id = $1 AND actor_type = $2', [t, ACTOR])
      assert.equal(new Date(s.breached_since).toISOString(), at(0))
    })
  })

  test('hallucinations with no ground truth is not_configured and never evaluated', async () => {
    await inTx(async () => {
      const { rows: [h] } = await db.query(`SELECT applicable_actor_types[1] AS a
        FROM bob.cell_catalog WHERE metric = 'hallucinations'`)
      const t = await threshold({ metric_id: 'hallucinations', upper_bound: 0 })
      await response(t)
      await series([9, 9], { metric: 'hallucinations', actor: h.a })
      const out = (await evaluate(2)).filter((o) => o.threshold_id === t)
      assert.deepEqual(await alerts(t), [])
      assert.ok(out.length && out.every((o) => o.outcome === 'refused'
        && o.reasons.includes('no_ground_truth')), JSON.stringify(out))
    })
  })

  test('peak_mode observed is refused with its reason', async () => {
    await inTx(async () => {
      const t = await threshold({ peak_mode: 'observed' })
      await response(t)
      await series([50])
      const out = (await evaluate(1)).filter((o) => o.threshold_id === t)
      assert.deepEqual(await alerts(t), [])
      assert.ok(out.some((o) => o.reasons.includes('peak_observed_unsupported')), JSON.stringify(out))
    })
  })

  test('another tenant is never read or written by an evaluation of tenant A', async () => {
    await inTx(async () => {
      const tb = await threshold({ org_id: TENANT_B, scope_kind: 'company', scope_ref: null })
      await response(tb, { org_id: TENANT_B })
      const ta = await threshold()
      await response(ta)
      await series([50])
      await series([50], { org: TENANT_B, channel: 'bbbbbbbb-2222-4000-8000-000000000002' })
      const out = await evaluate(1, TENANT_A)
      assert.ok(out.every((o) => o.threshold_id !== tb))
      assert.deepEqual(await alerts(tb), [])
      const { rows } = await db.query('SELECT 1 FROM bob.evaluation_state WHERE org_id = $1', [TENANT_B])
      assert.deepEqual(rows, [])
    })
  })
})

// ── §5 · colour without a response ────────────────────────────────────────
describe('§5 · the breach is read without responses', () => {
  const status = async (t, i) => (await db.query(`
    SELECT * FROM bob.bob_threshold_status($1, ARRAY[$2]::uuid[], $3, $4)
     WHERE threshold_id = $5 AND actor_type = $6 ORDER BY bucket_start`,
  [TENANT_A, WHATSAPP, at(0), at(i), t, ACTOR])).rows

  test('a breaching threshold with no response paints breach', async () => {
    await inTx(async () => {
      const t = await threshold()
      await series([50])
      const [s] = await status(t, 1)
      assert.equal(s.status, 'breach')
      assert.equal(s.severity, 'critical')
    })
  })

  test('bob_threshold_status depends on neither evaluation_state nor response_rules', async () => {
    const { rows } = await db.query(`
      SELECT c.relname FROM pg_depend d
        JOIN pg_proc p ON p.oid = d.objid
        JOIN pg_class c ON c.oid = d.refobjid
       WHERE p.proname = 'bob_threshold_status'`)
    const names = rows.map((r) => r.relname)
    assert.ok(names.includes('threshold_configs'), `no dependencies recorded: ${names}`)
    assert.ok(!names.includes('evaluation_state') && !names.includes('response_rules'), names.join(', '))
  })

  test('warning within 20 % past the bound, critical beyond; near writes no alert', async () => {
    await inTx(async () => {
      const t = await threshold({ upper_bound: 100 })
      await response(t)
      await series([110, 130, 90])
      const s = await status(t, 3)
      assert.deepEqual(s.map((x) => [x.status, x.severity]),
        [['breach', 'warning'], ['breach', 'critical'], ['near', null]])
      await evaluate(3)
      // 90 is near, and inside: the breach recovers, and no proximity alert exists.
      assert.deepEqual((await alerts(t)).map((a) => [a.alert_type, a.severity]),
        [['upper', 'warning'], ['recovery', 'info']])
    })
  })

  test('the evaluator reads the breach only through bob_threshold_status', async () => {
    const { rows } = await db.query(`
      SELECT f.proname FROM pg_depend d
        JOIN pg_proc p ON p.oid = d.objid JOIN pg_proc f ON f.oid = d.refobjid
       WHERE p.proname = 'bob_evaluation_input'`)
    assert.ok(rows.some((r) => r.proname === 'bob_threshold_status'), JSON.stringify(rows))
    // plpgsql records no dependencies, so its source is read: the loop takes its
    // rows from the input function and never restates the cell or the bound.
    const { rows: [src] } = await db.query(
      `SELECT prosrc FROM pg_proc WHERE proname = 'bob_evaluate_at'`)
    assert.match(src.prosrc, /bob_evaluation_input/)
    assert.doesNotMatch(src.prosrc, /bob_cell_state|proj_metric_counts/)
  })
})

// ── §7 · cooldown, escalation, recovery ───────────────────────────────────
describe('§7 · one subject and response at a time', () => {
  test('two passes over the same sealed bucket write one alert', async () => {
    await inTx(async () => {
      const t = await threshold()
      await response(t)
      await series([50])
      await evaluate(1)
      await evaluate(1)
      assert.equal((await alerts(t)).length, 1)
    })
  })

  test('six breached buckets: one alert at the 1800 s default, six at 300', async () => {
    await inTx(async () => {
      const t1 = await threshold()
      await response(t1)
      const t2 = await threshold({ scope_kind: 'company', scope_ref: null, cooldown_seconds: 300 })
      await response(t2)
      await series([50, 50, 50, 50, 50, 50])
      await evaluate(6)
      assert.equal((await alerts(t1)).filter((a) => a.alert_type === 'upper').length, 1)
      const many = (await alerts(t2)).filter((a) => a.alert_type === 'upper'
        && a.channel_id === WHATSAPP)
      assert.equal(many.length, 6)
    })
  })

  test('two responses at different depths keep separate cooldowns', async () => {
    await inTx(async () => {
      const t = await threshold()
      const shallow = await response(t)
      const deep = await response(t, { trigger_level: 40 })
      await series([20, 50])
      await evaluate(2)
      const a = await alerts(t)
      assert.deepEqual(a.map((x) => [x.response_id, new Date(x.bucket_start).toISOString()]),
        [[shallow, at(0)], [deep, at(1)]])
    })
  })

  test('15 · one escalation per subject and breach, with two responses on it', async () => {
    await inTx(async () => {
      const t = await threshold({ upper_bound: 100, escalation_after_seconds: 600 })
      await response(t)
      await response(t, { trigger_level: 105 })
      await series([110, 110, 110, 110])
      await evaluate(4)
      const a = await alerts(t)
      const fired = a.filter((x) => x.alert_type === 'upper')
      const esc = a.filter((x) => x.alert_type === 'escalation')
      assert.equal(fired.length, 2, 'each response fires its own alert')
      assert.equal(esc.length, 1, JSON.stringify(a.map((x) => [x.alert_type, x.response_id])))
      assert.ok(fired.every((f) => f.severity === 'warning'))
      assert.equal(esc[0].severity, 'critical')
      assert.ok(fired.some((f) => f.id === esc[0].escalates_alert_id), 'not linked to an alert of the breach')
      assert.equal(new Date(esc[0].bucket_start).toISOString(), at(1))
    })
  })

  test('15a · a breach that never reaches the response\'s level fires and escalates nothing', async () => {
    await inTx(async () => {
      const t = await threshold({ upper_bound: 100, escalation_after_seconds: 600 })
      await response(t, { trigger_level: 1000 })
      await series([110, 110, 110, 110])
      await evaluate(4)
      assert.deepEqual(await alerts(t), [])
    })
  })

  test('15b · a breach wholly inside a manual peak window writes no recovery', async () => {
    await inTx(async () => {
      // The window covers the two breached buckets and ends before the third,
      // so the recovery bucket is outside it: only "no alert fired" stops it.
      const t = await threshold({ peak_mode: 'manual', escalation_after_seconds: 300,
        peak_windows: JSON.stringify([{ start: '10:00', end: '10:10' }]) })
      await response(t)
      await series([50, 50, 1])
      await evaluate(3)
      assert.deepEqual(await alerts(t), [])
      const { rows: [s] } = await db.query(`SELECT breached_since FROM bob.evaluation_state
        WHERE threshold_id = $1 AND actor_type = $2`, [t, ACTOR])
      assert.equal(s.breached_since, null, 'the breach did not end')
    })
  })

  test('16 · recovery is immediate after the dwell, and a re-breach alerts inside the old cooldown', async () => {
    await inTx(async () => {
      const t = await threshold()
      await response(t)
      await series([50, 1, 50])
      await evaluate(3)
      assert.deepEqual((await alerts(t)).map((x) => x.alert_type), ['upper', 'recovery', 'upper'])
    })
  })

  test('17 · the default dwell is one bucket: alternation recovers each time; 600 s damps it', async () => {
    await inTx(async () => {
      const byDefault = await threshold()
      await response(byDefault)
      const damped = await threshold({ scope_kind: 'company', scope_ref: null,
        recovery_dwell_seconds: 600 })
      await response(damped)
      await series([50, 1, 50, 1, 50])
      await evaluate(5)
      assert.deepEqual((await alerts(byDefault)).map((x) => x.alert_type),
        ['upper', 'recovery', 'upper', 'recovery', 'upper'])
      assert.deepEqual((await alerts(damped)).filter((x) => x.channel_id === WHATSAPP)
        .map((x) => x.alert_type), ['upper'])
    })
  })

  test('sustained_for_seconds 600 fires on the second consecutive bucket', async () => {
    await inTx(async () => {
      const t = await threshold()
      await response(t, { sustained_for_seconds: 600 })
      await series([50, 1, 50, 50])
      await evaluate(4)
      const a = await alerts(t)
      assert.deepEqual(a.map((x) => new Date(x.bucket_start).toISOString()), [at(3)])
    })
  })

  test('a manual peak window moves state and writes nothing', async () => {
    await inTx(async () => {
      const t = await threshold({ peak_mode: 'manual',
        peak_windows: JSON.stringify([{ start: '10:00', end: '11:00' }]) })
      await response(t)
      await series([50])
      const out = (await evaluate(1)).filter((o) => o.threshold_id === t)
      assert.deepEqual(await alerts(t), [])
      assert.ok(out.some((o) => o.reasons.includes('suppressed_peak_window')), JSON.stringify(out))
      const { rows: [s] } = await db.query(
        'SELECT breached_since FROM bob.evaluation_state WHERE threshold_id = $1 AND actor_type = $2', [t, ACTOR])
      assert.ok(s.breached_since)
    })
  })

  test('buckets older than 24 h are skipped with catch_up_window_exceeded', async () => {
    await inTx(async () => {
      const t = await threshold()
      await response(t)
      await series([50])
      await evaluate(1)
      await series([1, 50], { from: 300 })
      const out = (await evaluate(302)).filter((o) => o.threshold_id === t)
      assert.ok(out.some((o) => o.reasons.includes('catch_up_window_exceeded')), JSON.stringify(out))
    })
  })
})

// ── §8 · intentions and their refusals ─────────────────────────────────────
describe('§8 · D-31 · a refusal is a row with its reason', () => {
  async function actionOn(t, limits = {}) {
    await db.query(`UPDATE bob.autobotz SET rate_limit_per_hour = $2, invocation_cap_daily = $3,
      concurrency_limit = $4 WHERE id = $1`,
    [AB1, limits.hour ?? 10, limits.day ?? null, limits.concurrent ?? null])
    const r = await response(t, { type: 'action', autobotz_id: AB1 })
    await db.query(`
      WITH c AS MATERIALIZED (SELECT set_config('request.jwt.claims', $2, true) AS x)
      SELECT public.bob_autobotz_record_verification($1, true, 'probe') FROM c`,
    [AB1, JSON.stringify({ org_id: TENANT_A })])
    return r
  }
  const intents = async (r) => (await db.query(`
    SELECT * FROM bob.outbound_queue WHERE response_rule_id = $1 ORDER BY created_at`, [r])).rows

  test('the eleventh firing in an hour is suppressed, not drained, and counts toward nothing', async () => {
    await inTx(async () => {
      const t = await threshold({ cooldown_seconds: 300 })
      const r = await actionOn(t, { hour: 10 })
      await series(Array(11).fill(50))
      await evaluate(11)
      const q = await intents(r)
      assert.equal(q.length, 11)
      assert.deepEqual(q.map((x) => x.state).filter((s) => s === 'suppressed'), ['suppressed'])
      const s = q.find((x) => x.state === 'suppressed')
      assert.equal(s.suppressed_reason, 'rate_limit_per_hour')
      assert.ok(q.every((x) => x.alert_log_id), 'an intention without its alert')
      assert.ok(await refusal(`UPDATE bob.outbound_queue SET state = 'drained', drained_at = now()
        WHERE id = $1`, [s.id]), 'a suppressed intention was drained')
    })
  })

  test('the daily cap and an unverified binding suppress with their reasons', async () => {
    await inTx(async () => {
      const t = await threshold({ cooldown_seconds: 300 })
      const r = await actionOn(t, { hour: 100, day: 1 })
      await series([50, 50])
      await evaluate(2)
      assert.deepEqual((await intents(r)).map((x) => x.suppressed_reason), [null, 'invocation_cap_daily'])
      await db.query(`UPDATE bob.autobotz SET reference = reference || '?edited' WHERE id = $1`, [AB1])
      await series([50], { from: 2 })
      await evaluate(3)
      const last = (await intents(r)).at(-1)
      assert.equal(last.state, 'suppressed')
      assert.match(last.suppressed_reason, /^binding_/)
    })
  })

  test('another organization\'s response still raises at admission', async () => {
    await inTx(async () => {
      const t = await threshold()
      const r = await actionOn(t)
      const { rows: [a] } = await db.query(`INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type)
        VALUES ($1, 'x', 'x', 'upper') RETURNING id`, [TENANT_B])
      assert.ok(await refusal(`INSERT INTO bob.outbound_queue (org_id, response_rule_id, alert_log_id,
        idempotency_key) VALUES ($1, $2, $3, 'k')`, [TENANT_B, r, a.id]))
    })
  })

  test('nobody writes a suppressed row directly', async () => {
    await inTx(async () => {
      const t = await threshold()
      const r = await actionOn(t)
      const { rows: [a] } = await db.query(`INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type)
        VALUES ($1, 'x', 'x', 'upper') RETURNING id`, [TENANT_A])
      assert.ok(await refusal(`INSERT INTO bob.outbound_queue (org_id, response_rule_id, alert_log_id,
        idempotency_key, state, suppressed_reason) VALUES ($1, $2, $3, 'k', 'suppressed', 'made up')`,
      [TENANT_A, r, a.id]))
    })
  })
})

// ── §9 · who runs it ──────────────────────────────────────────────────────
describe('§9 · the tenant is explicit, and no application role runs it', () => {
  test('NULL and an unknown organization raise', async () => {
    await inTx(async () => {
      assert.ok(await refusal('SELECT * FROM bob.bob_evaluate(NULL)'))
      assert.ok(await refusal(`SELECT * FROM bob.bob_evaluate('00000000-0000-4000-8000-000000000000')`))
    })
  })

  test('no role but the owner and superusers can execute any bob_evaluate* (functions and roles discovered)', async () => {
    // Every role that is not a superuser, not a pg_ built-in and does not own
    // the function, PUBLIC included through has_function_privilege.
    const { rows } = await db.query(`
      SELECT p.oid::regprocedure::text AS fn, p.prosecdef,
             coalesce(array_agg(r.rolname::text ORDER BY r.rolname)
               FILTER (WHERE has_function_privilege(r.oid, p.oid, 'EXECUTE')), '{}'::text[]) AS who,
             count(r.oid)::int AS roles
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        LEFT JOIN pg_roles r ON NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%' AND r.oid <> p.proowner
                            AND NOT pg_has_role(r.oid, p.proowner, 'USAGE')
       WHERE p.proname LIKE 'bob\\_evaluate%'
       GROUP BY p.oid, p.prosecdef`)
    assert.ok(rows.length >= 2, `found ${rows.length}`)
    assert.ok(rows.every((r) => r.roles >= 6), `too few roles discovered: ${rows.map((r) => r.roles)}`)
    assert.deepEqual(rows.filter((r) => r.who.length).map((r) => `${r.fn}: ${r.who}`), [])
    assert.ok(rows.every((r) => r.prosecdef), 'not a definer')
  })

  test('bob_app reads its own evaluation state and writes none', async () => {
    const { rows: [g] } = await db.query(`
      SELECT has_table_privilege('bob_app', 'bob.evaluation_state', 'SELECT') AS r,
             has_table_privilege('bob_app', 'bob.evaluation_state', 'INSERT') OR
             has_table_privilege('bob_app', 'bob.evaluation_state', 'UPDATE') OR
             has_table_privilege('bob_app', 'bob.evaluation_state', 'DELETE') AS w,
             has_table_privilege('authenticated', 'bob.evaluation_state', 'INSERT') OR
             has_table_privilege('authenticated', 'bob.evaluation_state', 'UPDATE') AS aw`)
    assert.deepEqual(g, { r: true, w: false, aw: false })
  })

  test('evaluation_state is a tenant table the tenancy suite discovers', async () => {
    const tables = await tenantTables(db)
    assert.ok(tables.some((t) => (t.table_name ?? t) === 'evaluation_state'
      || String(t.qualified ?? t).endsWith('evaluation_state')), JSON.stringify(tables.slice(0, 3)))
  })

  test('alert_log carries acknowledged_at, and nothing writes it', async () => {
    const { rows } = await db.query(`
      SELECT col_description('bob.alert_log'::regclass, a.attnum) AS d
        FROM pg_attribute a WHERE a.attrelid = 'bob.alert_log'::regclass AND a.attname = 'acknowledged_at'`)
    assert.equal(rows.length, 1)
    assert.match(rows[0].d ?? '', /deliberate/i)
  })
})

// ── Review of 27 Nov (security review of ee90c6b) ──────────────────────────
// Febor's box has viewers. Each test below was seen failing before its fix.
describe('Review of 27 Nov · what a viewer can write', () => {
  async function asViewer(fn) {
    await db.query('BEGIN')
    try {
      await db.query('SELECT set_config($1, $2, true)', ['request.jwt.claims',
        JSON.stringify({ org_id: TENANT_A, role: 'authenticated', app_role: 'viewer' })])
      await db.query('SET LOCAL ROLE authenticated')
      return await fn()
    } finally { await db.query('ROLLBACK') }
  }

  test('R1 · authenticated holds no INSERT on the outbox, and a viewer\'s insert is refused', async () => {
    const { rows: [g] } = await db.query(`SELECT has_table_privilege('authenticated', 'bob.outbound_queue', 'INSERT') AS i`)
    assert.equal(g.i, false)
    await asViewer(async () => {
      const e = await refusal(`INSERT INTO bob.outbound_queue (org_id, response_rule_id, alert_log_id, idempotency_key)
        VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'viewer-flood')`, [TENANT_A])
      assert.equal(e?.code, '42501', e?.message)
    })
  })

  test('R2 · no application role inserts or updates alert_log; a viewer cannot forge an escalation', async () => {
    const { rows } = await db.query(`
      SELECT r || ' ' || p AS g FROM unnest(ARRAY['authenticated', 'bob_app', 'bob_feeder', 'bob_ai_ro', 'anon', 'service_role']) r,
             unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
       WHERE has_table_privilege(r, 'bob.alert_log', p) ORDER BY 1`)
    assert.deepEqual(rows.map((r) => r.g), [])
    await asViewer(async () => {
      const e = await refusal(`INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type, subject_key,
        escalates_alert_id, bucket_start) VALUES ($1, 'x', 'x', 'escalation', 'forged', gen_random_uuid(), now())`, [TENANT_A])
      assert.equal(e?.code, '42501', e?.message)
    })
  })

  const PEAK_BAD = [
    ['an object, not an array', { start: '09:00', end: '10:00' }],
    ['an hour of 25', [{ start: '25:00', end: '01:00' }]],
    ['a missing end', [{ start: '09:00' }]],
    ['a number for a time', [{ start: 9, end: 10 }]],
    ['a string element', ['09:00-10:00']],
    ['seconds in the time', [{ start: '09:00:00', end: '10:00' }]],
  ]
  for (const [what, w] of PEAK_BAD) {
    test(`R3 · peak_windows refuses ${what}`, async () => {
      await inTx(async () => {
        const e = await refusal(`INSERT INTO bob.threshold_configs (org_id, metric_id, upper_bound, scope_kind,
          scope_ref, peak_windows) VALUES ($1, $2, 10, 'entity', $3, $4::jsonb)`, [TENANT_A, METRIC, WHATSAPP, JSON.stringify(w)])
        assert.equal(e?.code, '23514', e?.message ?? 'accepted')
      })
    })
  }

  test('R3 · peak_windows accepts [], and windows that cross midnight; the status still reads', async () => {
    await inTx(async () => {
      await threshold({ peak_windows: JSON.stringify([]) })
      await threshold({ scope_ref: VOICE, peak_mode: 'manual',
        peak_windows: JSON.stringify([{ start: '23:00', end: '01:00' }, { start: '09:30', end: '10:00' }]) })
      await series([50])
      assert.ok((await db.query('SELECT * FROM bob.bob_threshold_status($1, $2::uuid[], $3, $4)',
        [TENANT_A, [WHATSAPP, VOICE], at(0), at(1)])).rows.length > 0)
    })
  })
})

describe('Review of 27 Nov · one evaluation of an organization at a time', () => {
  test('R4 · a second evaluation of the same organization waits; another organization does not', async () => {
    // Plain clients: connect() takes the suite's own advisory lock, which this
    // file's connection already holds.
    const raw = async () => { const c = new pg.Client({ connectionString: DB_URL }); await c.connect(); return c }
    const c1 = await raw(); const c2 = await raw()
    try {
      await c1.query('BEGIN')
      await c1.query('SELECT * FROM bob.bob_evaluate_at($1, $2)', [TENANT_A, at(0)])
      const { rows: [l] } = await db.query(`SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND pid = $1`, [c1.processID])
      assert.ok(l.n >= 1, 'the first evaluation holds no advisory lock')
      await c2.query("SET lock_timeout = '300ms'")
      await c2.query('BEGIN')
      const e = await c2.query('SELECT * FROM bob.bob_evaluate_at($1, $2)', [TENANT_A, at(0)]).then(() => null, (x) => x)
      assert.equal(e?.code, '55P03', e?.message ?? 'the second evaluation did not wait')
      await c2.query('ROLLBACK')
      await c2.query('BEGIN')
      await c2.query('SELECT * FROM bob.bob_evaluate_at($1, $2)', [TENANT_B, at(0)])
      await c2.query('ROLLBACK')
    } finally {
      await c1.query('ROLLBACK').catch(() => {})
      await c1.end(); await c2.end()
    }
  })
})

describe('Review of 27 Nov · nits', () => {
  test('an alert cannot name another organization\'s threshold or response', async () => {
    await inTx(async () => {
      const t = await threshold()
      const r = await response(t)
      const e1 = await refusal(`INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type, threshold_id)
        VALUES ($1, 'x', 'x', 'upper', $2)`, [TENANT_B, t])
      assert.equal(e1?.code, '23503', e1?.message ?? 'accepted')
      const e2 = await refusal(`INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type, response_id)
        VALUES ($1, 'x', 'x', 'upper', $2)`, [TENANT_B, r])
      assert.equal(e2?.code, '23503', e2?.message ?? 'accepted')
      const e3 = await refusal(`INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type, response_id)
        VALUES ($1, 'x', 'x', 'upper', gen_random_uuid())`, [TENANT_A])
      assert.equal(e3?.code, '23503', e3?.message ?? 'a response that does not exist was accepted')
    })
  })
})

describe('Review of 8ab846e · triggers and references, and bounds that move', () => {
  test('F-58 · no role but the owner and superusers holds a table privilege on bob beyond SELECT, INSERT, UPDATE and DELETE (discovered)', async () => {
    // By inheritance (TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN on 17), in
    // the ACL under any type, and REFERENCES on a column.
    const { rows } = await db.query(`
      WITH rels AS (SELECT c.oid, c.relname, c.relacl, c.relowner FROM pg_class c
                      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob'
                     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')),
           extra AS (SELECT p FROM unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) p
                     UNION ALL SELECT 'MAINTAIN' WHERE current_setting('server_version_num')::int >= 170000),
           others AS (SELECT x.oid AS rel, r.oid AS role, r.rolname FROM rels x
                        JOIN pg_roles r ON NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%' AND r.oid <> x.relowner
                                       AND NOT pg_has_role(r.oid, x.relowner, 'USAGE'))
      SELECT o.rolname || ' ' || e.p || ' ' || x.relname AS g
        FROM others o JOIN rels x ON x.oid = o.rel, extra e WHERE has_table_privilege(o.role, o.rel, e.p)
      UNION
      SELECT coalesce(r.rolname, 'PUBLIC') || ' ' || a.privilege_type || ' ' || x.relname
        FROM rels x, aclexplode(x.relacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
       WHERE a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
         AND (a.grantee = 0 OR (NOT r.rolsuper AND a.grantee <> x.relowner AND NOT pg_has_role(a.grantee, x.relowner, 'USAGE')))
      UNION
      SELECT o.rolname || ' REFERENCES (column) ' || x.relname
        FROM others o JOIN rels x ON x.oid = o.rel WHERE has_any_column_privilege(o.role, o.rel, 'REFERENCES')
       ORDER BY 1`)
    assert.deepEqual(rows.map((r) => r.g), [])
    const { rows: [k] } = await db.query(`SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bob' AND c.relkind IN ('r', 'p')`)
    assert.ok(k.n > 20, `only ${k.n} tables found in bob`)
  })

  // What a box may still carry that a local stack from 00f79b7 does not:
  // TRUNCATE, a column REFERENCES, and MAINTAIN on 17. Planted, then the
  // migration's own F-58 block (read from the file, not copied here) is run
  // again, in a transaction that is rolled back.
  test('F-58 · the migration takes TRUNCATE, MAINTAIN and a column REFERENCES too, and leaves the four as they were', async () => {
    const dir = resolve(REPO_ROOT, 'supabase/migrations')
    const file = readdirSync(dir).find((f) => /^\d+_slice5_review_fixes\.sql$/.test(f))
    const text = readFileSync(resolve(dir, file), 'utf8')
    const block = text.slice(text.indexOf('-- ── F-58 '), text.indexOf('-- With TRIGGER gone'))
    assert.match(block, /^DO \$\$/m, 'the F-58 block of the migration was not found')
    const held = async () => (await db.query(`
      SELECT coalesce(r.rolname, 'PUBLIC') || ' ' || a.privilege_type || ' ' || c.relname AS g
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob',
             aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
       WHERE a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE') AND a.grantee <> c.relowner
      UNION
      SELECT r.rolname || ' REFERENCES (' || t.attname || ') ' || c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob'
        JOIN pg_attribute t ON t.attrelid = c.oid AND t.attnum > 0, aclexplode(t.attacl) a
        JOIN pg_roles r ON r.oid = a.grantee
       WHERE a.privilege_type = 'REFERENCES'
       ORDER BY 1`)).rows.map((r) => r.g)
    const dml = async () => (await db.query(`
      SELECT r.rolname || ' ' || p || ' ' || c.relname || ' ' || has_table_privilege(r.oid, c.oid, p) AS g
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob',
             pg_roles r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND r.rolname IN ('anon', 'authenticated', 'service_role', 'bob_app', 'bob_feeder', 'bob_ai_ro')
       ORDER BY 1`)).rows.map((r) => r.g)
    await inTx(async () => {
      await db.query('GRANT TRUNCATE, TRIGGER ON bob.alert_log TO authenticated')
      await db.query('GRANT TRUNCATE ON bob.alert_log TO service_role')
      await db.query('GRANT REFERENCES (id) ON bob.organizations TO bob_app')
      const { rows: [v] } = await db.query(`SELECT current_setting('server_version_num')::int >= 170000 AS m`)
      if (v.m) await db.query('GRANT MAINTAIN ON bob.alert_log TO anon')
      const before = await held()
      for (const g of ['authenticated TRUNCATE alert_log', 'service_role TRUNCATE alert_log',
        'bob_app REFERENCES (id) organizations', ...(v.m ? ['anon MAINTAIN alert_log'] : [])]) {
        assert.ok(before.includes(g), `${g} not planted`)
      }
      const four = await dml()
      await db.query(block)
      assert.deepEqual(await held(), [])
      assert.deepEqual(await dml(), four)
    })
  })

  // Febor runs scripts/f58 after 00f79b7 (#67), and this migration later:
  // after that script, the migration's F-58 block changes no ACL at all.
  test('F-58 · after scripts/f58/revocar.sql, the migration\'s block changes nothing', async () => {
    const dir = resolve(REPO_ROOT, 'supabase/migrations')
    const file = readdirSync(dir).find((f) => /^\d+_slice5_review_fixes\.sql$/.test(f))
    const text = readFileSync(resolve(dir, file), 'utf8')
    const block = text.slice(text.indexOf('-- ── F-58 '), text.indexOf('-- With TRIGGER gone'))
    const step = readFileSync(resolve(REPO_ROOT, 'scripts/f58/revocar.sql'), 'utf8')
      .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')
    // Every ACL of bob, table and column, as text.
    const acls = async () => (await db.query(`
      SELECT c.relname || ' ' || coalesce(c.relacl::text, '-') AS g
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob'
      UNION ALL
      SELECT c.relname || '.' || t.attname || ' ' || t.attacl::text
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'bob'
        JOIN pg_attribute t ON t.attrelid = c.oid AND t.attacl IS NOT NULL
       ORDER BY 1`)).rows.map((r) => r.g)
    await inTx(async () => {
      await db.query('GRANT TRUNCATE, TRIGGER, REFERENCES ON bob.alert_log TO authenticated')
      await db.query('GRANT REFERENCES (id) ON bob.organizations TO bob_app')
      const planted = await acls()
      await db.query(step)
      const afterStep = await acls()
      assert.notDeepEqual(afterStep, planted, 'the step took nothing: the comparison would prove nothing')
      await db.query(block)
      assert.deepEqual(await acls(), afterStep)
    })
  })

  test('F-58 · no role but the owner and superusers executes a trigger function in bob (discovered)', async () => {
    const { rows } = await db.query(`
      SELECT r.rolname || ' ' || p.proname AS g
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'bob'
        JOIN pg_roles r ON NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%' AND r.oid <> p.proowner
                       AND NOT pg_has_role(r.oid, p.proowner, 'USAGE')
       WHERE p.prorettype = 'trigger'::regtype AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
       ORDER BY 1`)
    assert.deepEqual(rows.map((r) => r.g), [])
  })

  test('F-58 · a member cannot create a trigger on alert_log', async () => {
    await inTx(async () => {
      await db.query('SELECT set_config($1, $2, true)', ['request.jwt.claims',
        JSON.stringify({ org_id: TENANT_A, role: 'authenticated', app_role: 'admin' })])
      await db.query('SET LOCAL ROLE authenticated')
      // A trigger function authenticated can still execute (it is the install
      // chain's, in public), so the refusal is the TRIGGER privilege's alone.
      const e = await refusal(`CREATE TRIGGER evil BEFORE INSERT ON bob.alert_log
        FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()`)
      assert.equal(e?.code, '42501', e?.message ?? 'the trigger was created')
    })
  })

  test('F-59 · a threshold\'s bounds cannot move past a response\'s trigger_level', async () => {
    await inTx(async () => {
      const t = await threshold({ upper_bound: 10 })
      await response(t, { trigger_level: 15 })
      const e = await refusal('UPDATE bob.threshold_configs SET upper_bound = 20 WHERE id = $1', [t])
      assert.equal(e?.code, '23514', e?.message ?? 'the bound moved past the level')
      assert.equal(await refusal('UPDATE bob.threshold_configs SET upper_bound = 12 WHERE id = $1', [t]), null)
    })
  })
})
