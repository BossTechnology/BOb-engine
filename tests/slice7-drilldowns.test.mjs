// Slice 7 · the drill-downs, against docs/slice-7-drilldowns.md §11. Channel →
// actor → bucket, in the database: the per-actor zero derived at read time,
// the unattributed remainder, the bucket's detail and the link from a cell to
// its alerts. Each test was written first and seen failing against the chain
// without the Slice 7 migrations; the sabotages are in contract-amendments.md,
// "Slice 7 · built".
//
// The world is the two-tenant fixture, the roster and the Slice 3 world, plus
// rows written here inside a transaction that rolls back, so the actor, its
// shift, the channel's figure, its seal and its computed_at are all chosen by
// the test. Reads run as bob_app under the tenant's claim (SET LOCAL ROLE in
// the same transaction), the way bob-web reads them. The D-33 tests are the
// last block, on their own: they are the ones rewritten if Federico rules (b)
// or (c) (spec §8).

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  connect, loadFixture, loadRoster, loadFeederWorld, loadSlice3World, loadBr3Rulings,
  connectAs, REPO_ROOT, TENANT_A, TENANT_B,
} from './helpers/db.mjs'
import { MemoryTruthStore } from '../feeder/memory-truth-store.mjs'
import { runFeeder } from '../feeder/reference-feeder.mjs'

const read = (f) => JSON.parse(readFileSync(resolve(REPO_ROOT, f), 'utf8'))
const SLICE2 = read('supabase/tests/fixtures/feeder_events.json')
const SLICE3 = read('supabase/tests/fixtures/slice3_events.json')
const EVENTS = [...SLICE2.events, ...SLICE3.events]
const WATERMARK = SLICE3.watermark
const RUN = { from: '2026-11-18T00:00:00Z', to: '2026-11-18T15:00:00Z' }
const DAY = RUN

const WHATSAPP = 'aaaaaaaa-2222-4000-8000-000000000001'   // lag 0
const VOICE = 'aaaaaaaa-2222-4000-8000-00000000000a'      // lag 900
const WEBSITE = 'aaaaaaaa-2222-4000-8000-00000000000b'    // lag NULL
const A_CHANNELS = [WHATSAPP, VOICE, WEBSITE,
  'aaaaaaaa-2222-4000-8000-00000000000d', 'aaaaaaaa-2222-4000-8000-00000000000e']
const VOICE_B = 'bbbbbbbb-2222-4000-8000-000000000002'
const CHAT_B = 'bbbbbbbb-2222-4000-8000-00000000000c'
const B_CHANNELS = [VOICE_B, CHAT_B]
const T0 = Date.parse('2026-11-25T10:00:00Z')
const B = 300_000
const at = (i) => new Date(T0 + i * B).toISOString()
const iso = (t) => (t ? new Date(t).toISOString() : t)
const num = (v) => (v === null || v === undefined ? null : Number(v))

let db, feeder
let METRIC   // a per-actor count metric configured for humans on WhatsApp, discovered

const truth = () => new MemoryTruthStore({ events: EVENTS, watermark: WATERMARK })

before(async () => {
  db = await connect()
  await loadFixture(db)
  await loadRoster(db)
  await loadFeederWorld(db)
  await loadSlice3World(db)
  await loadBr3Rulings(db)
  await db.query('GRANT bob_feeder, bob_app TO current_user')
  feeder = await connectAs('bob_feeder')
  for (const t of ['bob.proj_metric_counts', 'bob.proj_actor_metrics']) {
    await db.query('SELECT bob.proj_ensure_partition($1::regclass, $2::date)', [t, '2026-11-01'])
  }
  await runFeeder(feeder, truth(), { ...RUN, orgIds: [TENANT_A, TENANT_B] })
  const { rows } = await db.query(`
    SELECT w.metric
      FROM bob.bob_cell_state($1, ARRAY[$2]::uuid[], $3, $4) w
      JOIN bob.cell_catalog k ON k.metric = w.metric
     WHERE k.source = 'proj_metric_counts' AND NOT k.degenerate AND w.actor_type = 'human'
       AND w.state IN ('pending', 'not_observed')
     ORDER BY w.metric LIMIT 1`, [TENANT_A, WHATSAPP, at(0), at(1)])
  assert.ok(rows.length, 'no per-actor count metric configured for humans on WhatsApp')
  METRIC = rows[0].metric
})
after(async () => {
  await feeder?.end()
  await db?.query('REVOKE bob_feeder, bob_app FROM current_user')
  await db?.end()
})

async function inTx(fn) {
  await db.query('BEGIN')
  try { return await fn() } finally { await db.query('ROLLBACK') }
}

// Run `sql` as bob_app holding the tenant's claim, inside the open transaction.
async function readAs(orgId, sql, params = []) {
  await db.query('SET LOCAL ROLE bob_app')
  await db.query(`SELECT set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ org_id: orgId })])
  try {
    return (await db.query(sql, params)).rows
  } finally {
    await db.query('RESET ROLE')
  }
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

// ── The world the tests write ──────────────────────────────────────────────
let seq = 0
async function addActor(type, { shift = 'live', skilled = true, org = TENANT_A,
  channel = WHATSAPP } = {}) {
  const { rows: [a] } = await db.query(`
    INSERT INTO bob.actors (org_id, actor_type, display_id, active)
    VALUES ($1, $2, $3, true) RETURNING id`, [org, type, `S7-${type}-${++seq}`])
  if (skilled) {
    await db.query(`INSERT INTO bob.actor_channel_skills (org_id, actor_id, channel_id)
                    VALUES ($1, $2, $3)`, [org, a.id, channel])
  }
  if (shift !== 'none') {
    // 'live' covers T0; 'ended' ended before it.
    const [s, e] = shift === 'live' ? [at(-12), at(12)] : [at(-24), at(-12)]
    await db.query(`INSERT INTO bob.actor_shifts (org_id, actor_id, starts_at, ends_at, status)
                    VALUES ($1, $2, $3, $4, 'scheduled')`, [org, a.id, s, e])
  }
  return a.id
}

// The channel cell's row, one per (channel, type, metric, bucket).
async function channelRow(value, { type = 'human', i = 0, sealed = true, metric = METRIC,
  channel = WHATSAPP, org = TENANT_A, computedAt = null, watermark = null } = {}) {
  await db.query(`
    INSERT INTO bob.proj_metric_counts (org_id, channel_id, actor_type, metric_id, bucket_start,
      event_count, session_count, sealed, computed_at, source_watermark, feeder_version)
    VALUES ($1, $2, $3, $4, $5, $6, $6, $7, coalesce($8::timestamptz, now()), $9, 'slice7-test')`,
  [org, channel, type, metric, at(i), value, sealed, computedAt, watermark ?? at(i + 1)])
}

async function actorRow(actorId, value, { type = 'human', i = 0, sealed = true, metric = METRIC,
  channel = WHATSAPP, org = TENANT_A } = {}) {
  await db.query(`
    INSERT INTO bob.proj_actor_metrics (org_id, actor_id, actor_type, channel_id, metric_id,
      identity_rung_at_interaction, bucket_start, event_count, sealed, source_watermark,
      feeder_version)
    VALUES ($1, $2, $3, $4, $5, $10, $6, $7, $8, $9, 'slice7-test')`,
  [org, actorId, type, channel, metric, at(i), value, sealed, at(i + 1),
    type === 'user' ? 'identified' : 'not_applicable'])
}

// A row on another channel whose watermark moves the tenant's past the bucket,
// so a cell with no row there is not_observed rather than pending (R3).
const moveWatermark = (i = 10) => channelRow(0, { channel: VOICE, watermark: at(i), i: 20 })

const actorCell = async (actorId, { org = TENANT_A, channel = WHATSAPP, metric = METRIC,
  from = at(0), to = at(1) } = {}) => {
  const rows = await readAs(org, `
    SELECT * FROM bob.bob_actor_cell_state($1, ARRAY[$2]::uuid[], $3, $4)
     WHERE actor_id = $5 AND metric = $6`, [org, channel, from, to, actorId, metric])
  assert.equal(rows.length, 1, `expected one cell for the actor, got ${rows.length}`)
  return { ...rows[0], value: num(rows[0].value) }
}

// ── The derived zero (§2, §3) ──────────────────────────────────────────────
describe('§2 · the per-actor zero, derived at read time', () => {
  test('1 · a human on shift, skilled, under an observed channel bucket, no actor row: observed 0 from the shift', async () => {
    await inTx(async () => {
      const h = await addActor('human')
      await channelRow(5)
      const c = await actorCell(h)
      assert.deepEqual([c.state, c.reasons, c.value, c.provisional, c.liveness_source],
        ['observed', ['none_observed'], 0, false, 'shift'])
    })
  })

  test('2 · the same human with the shift ended: off_shift, not_on_shift, no value', async () => {
    await inTx(async () => {
      const h = await addActor('human', { shift: 'ended' })
      await channelRow(5)
      const c = await actorCell(h)
      assert.deepEqual([c.state, c.reasons, c.value], ['off_shift', ['not_on_shift'], null])
    })
  })

  test('2e · the shift is judged at the bucket\'s instant, not at the instant of reading', async () => {
    await inTx(async () => {
      await channelRow(5)
      // On shift at the bucket, and the shift over by the time anyone reads.
      const was = await addActor('human', { shift: 'none' })
      await db.query(`INSERT INTO bob.actor_shifts (org_id, actor_id, starts_at, ends_at, status)
                      VALUES ($1, $2, $3, $4, 'scheduled')`, [TENANT_A, was, at(-1), at(1)])
      assert.deepEqual([(await actorCell(was)).state, (await actorCell(was)).liveness_source],
        ['observed', 'shift'])
      // A shift that starts after the bucket, however current, does not cover it.
      const later = await addActor('human', { shift: 'none' })
      await db.query(`INSERT INTO bob.actor_shifts (org_id, actor_id, starts_at, ends_at, status)
                      VALUES ($1, $2, now() - interval '1 hour', now() + interval '1 hour', 'scheduled')`,
      [TENANT_A, later])
      assert.equal((await actorCell(later)).state, 'off_shift')
      // Moving the shift off the bucket moves the answer; the bucket's own
      // instant is the only clock.
      await db.query(`UPDATE bob.actor_shifts SET starts_at = $2, ends_at = $3 WHERE actor_id = $1`,
        [was, at(5), at(9)])
      assert.equal((await actorCell(was)).state, 'off_shift')
    })
  })

  test('2b · a human skilled with no shift at all is off_shift too', async () => {
    await inTx(async () => {
      const h = await addActor('human', { shift: 'none' })
      await channelRow(5)
      assert.equal((await actorCell(h)).state, 'off_shift')
    })
  })

  test('2c · a human on shift but not skilled on the channel gets no cell and no zero', async () => {
    await inTx(async () => {
      const h = await addActor('human', { skilled: false })
      await channelRow(5)
      const rows = await readAs(TENANT_A, `
        SELECT 1 FROM bob.bob_actor_cell_state($1, ARRAY[$2]::uuid[], $3, $4) WHERE actor_id = $5`,
      [TENANT_A, WHATSAPP, at(0), at(1), h])
      assert.deepEqual(rows, [])
    })
  })

  test('2d · skilled elsewhere, with a row here: the row, never a zero', async () => {
    await inTx(async () => {
      const h = await addActor('human', { skilled: false })
      await channelRow(5)
      await actorRow(h, 5)
      const c = await actorCell(h)
      assert.deepEqual([c.state, c.value, c.liveness_source], ['observed', 5, 'traffic'])
    })
  })

  test('3 · under a not_observed channel bucket: not_observed; under a pending one: pending; no zero', async () => {
    await inTx(async () => {
      const h = await addActor('human')
      const pending = await actorCell(h)
      assert.deepEqual([pending.state, pending.value, pending.liveness_source],
        ['pending', null, null])
      await moveWatermark()
      const notObserved = await actorCell(h)
      assert.deepEqual([notObserved.state, notObserved.reasons, notObserved.value],
        ['not_observed', ['no_actor_row'], null])
    })
  })

  test('4 · an ASA, and a member, with no row under an observed channel bucket: not_observed, no_actor_row', async () => {
    await inTx(async () => {
      for (const type of ['asa', 'user']) {
        const x = await addActor(type, { shift: 'none' })
        await channelRow(5, { type })
        const c = await actorCell(x)
        assert.deepEqual([type, c.state, c.reasons, c.value],
          [type, 'not_observed', ['no_actor_row'], null])
      }
    })
  })

  test('5 · a declared-absent channel zero stays the declared zero, not a derived one', async () => {
    await inTx(async () => {
      const h = await addActor('human')
      await db.query(`UPDATE bob.channel_actor_mix SET present = false
                       WHERE org_id = $1 AND channel_id = $2 AND actor_type = 'human'`,
      [TENANT_A, WHATSAPP])
      const c = await actorCell(h)
      assert.deepEqual([c.state, c.reasons, c.value], ['observed', ['actor_not_present'], 0])
      assert.notEqual(c.liveness_source, 'shift')
    })
  })

  test('6 · a metric with no channel row (the feeder does not count it): no actor gets a zero', async () => {
    await inTx(async () => {
      const h = await addActor('human')
      await channelRow(5)
      await moveWatermark()
      const rows = await readAs(TENANT_A, `
        SELECT * FROM bob.bob_actor_cell_state($1, ARRAY[$2]::uuid[], $3, $4)
         WHERE actor_id = $5 AND metric <> $6`, [TENANT_A, WHATSAPP, at(0), at(1), h, METRIC])
      assert.ok(rows.length > 0, 'no other per-actor metric to look at')
      for (const r of rows) {
        assert.ok(r.state !== 'observed' || r.liveness_source !== 'shift',
          `${r.metric} has a derived zero with no channel row`)
        assert.notDeepEqual([r.state, num(r.value)], ['observed', 0],
          `${r.metric} is a zero with no channel row`)
      }
    })
  })

  test('7 · a derived zero under an unsealed channel bucket is provisional', async () => {
    await inTx(async () => {
      const h = await addActor('human')
      await channelRow(5, { sealed: false })
      const c = await actorCell(h)
      assert.deepEqual([c.state, c.value, c.provisional, c.liveness_source],
        ['observed', 0, true, 'shift'])
    })
  })

  test('8 · the shift rule is the one definition: the function depends on public.bob_shift_is_live', async () => {
    const { rows } = await db.query(`
      SELECT DISTINCT d.refobjid::regproc::text AS dep
        FROM pg_depend d JOIN pg_proc p ON p.oid = d.objid
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'bob' AND p.proname = 'bob_actor_cell_state'
         AND d.classid = 'pg_proc'::regclass AND d.refclassid = 'pg_proc'::regclass`)
    const deps = rows.map((r) => r.dep)
    assert.ok(deps.includes('bob_shift_is_live') || deps.includes('public.bob_shift_is_live'),
      `bob_actor_cell_state depends on ${deps.join(', ')}`)
    // Not a second copy of it: the function's body names no shift column
    // comparison of its own.
    const { rows: [{ src }] } = await db.query(`
      SELECT pg_get_functiondef(p.oid) AS src FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'bob' AND p.proname = 'bob_actor_cell_state'`)
    assert.ok(!/starts_at\s*(<=|>=|<|>)/.test(src) && !/ends_at\s*(<=|>=|<|>)/.test(src),
      'the shift window is compared inline')
  })

  test('9 · nothing above wrote to proj_actor_metrics, and no Slice 7 function can', async () => {
    await inTx(async () => {
      const count = async () => Number((await db.query(
        'SELECT count(*) FROM bob.proj_actor_metrics WHERE org_id = $1', [TENANT_A])).rows[0].count)
      const h = await addActor('human')
      await channelRow(5)
      const before = await count()
      await actorCell(h)
      await readAs(TENANT_A, `SELECT * FROM bob.bob_actor_unattributed($1, ARRAY[$2]::uuid[], $3, $4)`,
        [TENANT_A, WHATSAPP, at(0), at(1)])
      assert.equal(await count(), before)
    })
    const { rows } = await db.query(`
      SELECT p.proname, p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'bob' AND (p.proname LIKE 'bob\\_cell\\_%' OR p.proname LIKE 'bob\\_actor\\_%')`)
    assert.ok(rows.length >= 8, `found ${rows.map((r) => r.proname)}`)
    for (const r of rows) assert.equal(r.provolatile, 's', `${r.proname} is not STABLE`)
  })

  test('3b · bob_actor_cell_state carries liveness_source, in the position after provisional', async () => {
    const { rows } = await db.query(`
      SELECT a.attname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
             LATERAL unnest(p.proargnames, p.proargmodes) WITH ORDINALITY a(attname, mode, pos)
       WHERE n.nspname = 'bob' AND p.proname = 'bob_actor_cell_state' AND a.mode = 't'
       ORDER BY a.pos`)
    assert.deepEqual(rows.map((r) => r.attname).slice(-2), ['provisional', 'liveness_source'])
  })
})

// ── The remainder (§4) ─────────────────────────────────────────────────────
describe('§4 · the unattributed remainder', () => {
  const remainder = (org, channel, i0 = 0, i1 = 1) => readAs(org, `
    SELECT * FROM bob.bob_actor_unattributed($1, ARRAY[$2]::uuid[], $3, $4) WHERE metric = $5`,
  [org, channel, at(i0), at(i1), METRIC])

  test('10 · on the fixture the actors of each type add up to the channel cell: no remainder row', async () => {
    const rows = await readAs(TENANT_A, `
      SELECT * FROM bob.bob_actor_unattributed($1, $2::uuid[], $3, $4)`,
    [TENANT_A, A_CHANNELS, DAY.from, DAY.to])
    assert.deepEqual(rows, [])
    const other = await readAs(TENANT_B, `
      SELECT * FROM bob.bob_actor_unattributed($1, $2::uuid[], $3, $4)`,
    [TENANT_B, B_CHANNELS, DAY.from, DAY.to])
    assert.deepEqual(other, [])
  })

  test('11 · an event attributed to the type and to no actor: one row, unattributed, value 1', async () => {
    await inTx(async () => {
      const h = await addActor('human')
      await channelRow(4)
      await actorRow(h, 3)
      const rows = await remainder(TENANT_A, WHATSAPP)
      assert.equal(rows.length, 1)
      assert.deepEqual([rows[0].state, rows[0].reasons, num(rows[0].value), rows[0].actor_type],
        ['observed', ['unattributed'], 1, 'human'])
    })
  })

  test('11b · actors that add up to the channel leave no row; a channel with no row leaves none', async () => {
    await inTx(async () => {
      const h = await addActor('human')
      const g = await addActor('human')
      await channelRow(5)
      await actorRow(h, 2)
      await actorRow(g, 3)
      assert.deepEqual(await remainder(TENANT_A, WHATSAPP), [])
      assert.deepEqual(await remainder(TENANT_A, WHATSAPP, 1, 2), [])
    })
  })

  test('12 · actors adding up to more than the channel: actor_sum_exceeds_channel, negative, never clamped', async () => {
    await inTx(async () => {
      const h = await addActor('human')
      await channelRow(2)
      await actorRow(h, 3)
      const rows = await remainder(TENANT_A, WHATSAPP)
      assert.equal(rows.length, 1)
      assert.deepEqual([rows[0].state, rows[0].reasons, num(rows[0].value)],
        ['observed', ['actor_sum_exceeds_channel'], -1])
    })
  })

  test('12b · a declared-absent channel zero has no remainder', async () => {
    await inTx(async () => {
      await db.query(`UPDATE bob.channel_actor_mix SET present = false
                       WHERE org_id = $1 AND channel_id = $2 AND actor_type = 'human'`,
      [TENANT_A, WHATSAPP])
      assert.deepEqual(await remainder(TENANT_A, WHATSAPP), [])
    })
  })
})

// ── The bucket (§5) ────────────────────────────────────────────────────────
describe('§5 · bob_cell_detail', () => {
  const detail = (org, channel, metric, type, bucket) => readAs(org, `
    SELECT * FROM bob.bob_cell_detail($1, $2, $3, $4, $5)`, [org, channel, metric, type, bucket])

  test('13 · the same state, reasons and value as bob_cell_state for every cell of a frame', async () => {
    const frame = { from: '2026-11-18T13:30:00Z', to: '2026-11-18T14:30:00Z' }
    await inTx(async () => {
      const rows = await readAs(TENANT_A, `
        SELECT c.metric, c.actor_type, c.bucket_start,
               c.state AS cs, c.reasons AS cr, c.value AS cv, c.provisional AS cp,
               c.liveness_source AS cl,
               d.state AS ds, d.reasons AS dr, d.value AS dv, d.provisional AS dp,
               d.liveness_source AS dl
          FROM bob.bob_cell_state($1, $2::uuid[], $3, $4) c
          LEFT JOIN LATERAL bob.bob_cell_detail($1, c.channel_id, c.metric, c.actor_type,
                                                c.bucket_start) d ON true`,
      [TENANT_A, [WHATSAPP], frame.from, frame.to])
      assert.ok(rows.length > 100, `only ${rows.length} cells`)
      assert.ok(rows.some((r) => r.cs === 'observed') && rows.some((r) => r.cs !== 'observed'),
        'the frame needs observed and unobserved cells')
      for (const r of rows) {
        assert.deepEqual([r.ds, r.dr, num(r.dv), r.dp, r.dl],
          [r.cs, r.cr, num(r.cv), r.cp, r.cl],
          `${r.metric}/${r.actor_type}/${iso(r.bucket_start)}`)
      }
    })
  })

  test('14 · the provenance is the projection row\'s; a cell with no row has none', async () => {
    await inTx(async () => {
      await channelRow(5, { sealed: true, computedAt: at(3), watermark: at(2) })
      const [d] = await detail(TENANT_A, WHATSAPP, METRIC, 'human', at(0))
      assert.deepEqual([d.sealed, iso(d.computed_at), iso(d.source_watermark), d.feeder_version],
        [true, at(3), at(2), 'slice7-test'])
      const [none] = await detail(TENANT_A, WHATSAPP, METRIC, 'human', at(1))
      assert.deepEqual([none.sealed, none.computed_at, none.source_watermark, none.feeder_version],
        [null, null, null, null])
    })
  })

  test('14b · several rows behind one cell: the greatest computed_at and watermark, sealed as bool_and', async () => {
    await inTx(async () => {
      // A metric that is a channel figure by the catalog can have rungs; a count
      // metric has one row per (channel, type, bucket). Two rows of one cell
      // are two actor types of one channel under the same metric, read by the
      // 'user' cell only when it is the one that rolls them up: the provenance
      // helper's contract is the same on any frame, so read it directly.
      await channelRow(5, { sealed: true, computedAt: at(3), watermark: at(2) })
      await channelRow(5, { sealed: false, computedAt: at(4), watermark: at(5), type: 'asa' })
      const rows = await readAs(TENANT_A, `
        SELECT * FROM bob.bob_cell_provenance($1, ARRAY[$2]::uuid[], $3, $4)
         WHERE metric = $5 AND actor_type IN ('human', 'asa')
         ORDER BY actor_type`, [TENANT_A, WHATSAPP, at(0), at(1), METRIC])
      assert.equal(rows.length, 2)
      assert.deepEqual(rows.map((r) => [r.actor_type, r.sealed, iso(r.computed_at)]),
        [['asa', false, at(4)], ['human', true, at(3)]])
    })
  })

  test('15 · a channel with a NULL lag: lag_seconds NULL, never 0', async () => {
    await inTx(async () => {
      const [w] = await detail(TENANT_A, WEBSITE, METRIC, 'human', at(0))
      assert.ok(w, 'no cell for the website')
      assert.equal(w.lag_seconds, null)
      const [v] = await detail(TENANT_A, WHATSAPP, METRIC, 'human', at(0))
      assert.equal(v.lag_seconds, 0)
    })
  })

  test('16 · affected_frame carries metric_id and actor_type, the frame and the channel\'s keys, and no event_name', async () => {
    await inTx(async () => {
      const [d] = await detail(TENANT_A, WHATSAPP, METRIC, 'human', at(0))
      const f = d.affected_frame
      assert.equal(f.metric_id, METRIC)
      assert.equal(f.actor_type, 'human')
      assert.equal(iso(f.from), at(0))
      assert.equal(iso(f.to), at(1))
      assert.ok(f.tenant_slug && f.source_key, JSON.stringify(f))
      assert.ok(!('event_name' in f), 'the filter carries an event_name')
    })
  })

  test('16b · a cell nobody can see is no row', async () => {
    await inTx(async () => {
      assert.deepEqual(await detail(TENANT_A, VOICE_B, METRIC, 'human', at(0)), [])
      assert.deepEqual(await detail(TENANT_B, WHATSAPP, METRIC, 'human', at(0)), [])
    })
  })
})

// ── Alerts (§6) ────────────────────────────────────────────────────────────
describe('§6 · bob_cell_alerts', () => {
  const alertsOf = (org, channels, type, i0 = 0, i1 = 6) => readAs(org, `
    SELECT * FROM bob.bob_cell_alerts($1, $2::uuid[], $3, $4, $5, $6) ORDER BY created_at, alert_id`,
  [org, channels, METRIC, type, at(i0), at(i1)])

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
    const c = { org_id: TENANT_A, threshold_id: thresholdId, type: 'alert', name: 'slice7', ...cols }
    const keys = Object.keys(c)
    const { rows: [r] } = await db.query(
      `INSERT INTO bob.response_rules (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(c))
    return r.id
  }
  const evaluate = (i, org = TENANT_A) => db.query('SELECT * FROM bob.bob_evaluate_at($1, $2)',
    [org, at(i)])

  test('17 · an alert written by bob_evaluate_at is returned for its cell, with value_at_firing = alert_log.value', async () => {
    await inTx(async () => {
      const t = await threshold()
      await response(t)
      await channelRow(50)
      await evaluate(1)
      const { rows: [log] } = await db.query(
        'SELECT * FROM bob.alert_log WHERE threshold_id = $1', [t])
      assert.ok(log, 'the evaluator wrote no alert')
      const rows = await alertsOf(TENANT_A, [WHATSAPP], 'human')
      assert.equal(rows.length, 1)
      const a = rows[0]
      assert.equal(a.alert_id, log.id)
      assert.equal(num(a.value_at_firing), num(log.value))
      assert.equal(num(a.value_at_firing), 50)
      assert.equal(num(a.value_now), 50)
      assert.equal(num(a.bound), num(log.threshold))
      assert.deepEqual([a.alert_type, a.severity, a.channel_id, a.actor_type, iso(a.bucket_start),
        a.threshold_id, a.subject_key, a.escalates_alert_id],
      [log.alert_type, log.severity, WHATSAPP, 'human', at(0), t, log.subject_key, null])
    })
  })

  test('18 · a cell with no alert returns nothing; a breach with no response is breach and has no row', async () => {
    await inTx(async () => {
      const t = await threshold()
      await channelRow(50)
      const status = (await db.query(`
        SELECT status FROM bob.bob_threshold_status($1, ARRAY[$2]::uuid[], $3, $4)
         WHERE threshold_id = $5 AND actor_type = 'human'`,
      [TENANT_A, WHATSAPP, at(0), at(1), t])).rows
      assert.deepEqual(status.map((s) => s.status), ['breach'])
      assert.deepEqual(await alertsOf(TENANT_A, [WHATSAPP], 'human'), [])
    })
  })

  test('19 · an escalation is listed with its escalates_alert_id', async () => {
    await inTx(async () => {
      const t = await threshold({ upper_bound: 100, escalation_after_seconds: 600 })
      await response(t)
      for (const i of [0, 1, 2, 3]) await channelRow(110, { i })
      await evaluate(4)
      const rows = await alertsOf(TENANT_A, [WHATSAPP], 'human')
      const fired = rows.find((r) => r.alert_type === 'upper')
      const esc = rows.find((r) => r.alert_type === 'escalation')
      assert.ok(fired && esc, JSON.stringify(rows.map((r) => r.alert_type)))
      assert.equal(esc.escalates_alert_id, fired.alert_id)
    })
  })

  test('20 · tenant B\'s alerts never appear in tenant A\'s frame', async () => {
    await inTx(async () => {
      for (const [org, channel] of [[TENANT_A, WHATSAPP], [TENANT_B, VOICE_B]]) {
        await db.query(`
          INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type, value, threshold,
            severity, channel_id, actor_type, bucket_start)
          VALUES ($1, $2, $2, 'upper', 9, 5, 'warning', $3, 'human', $4)`,
        [org, METRIC, channel, at(0)])
      }
      const a = await alertsOf(TENANT_A, [WHATSAPP, VOICE_B], 'human')
      assert.deepEqual(a.map((r) => r.channel_id), [WHATSAPP])
      assert.deepEqual(await alertsOf(TENANT_A, [VOICE_B], 'human'), [])
      // Asking for B's organization under A's claim: RLS leaves nothing.
      const asB = await readAs(TENANT_A, `
        SELECT * FROM bob.bob_cell_alerts($1, $2::uuid[], $3, $4, $5, $6)`,
      [TENANT_B, [VOICE_B], METRIC, 'human', at(0), at(6)])
      assert.deepEqual(asB, [])
    })
  })

  test('20b · an alert is for its own metric and its own actor type', async () => {
    await inTx(async () => {
      await db.query(`
        INSERT INTO bob.alert_log (org_id, metric_id, metric_name, alert_type, value, threshold,
          severity, channel_id, actor_type, bucket_start)
        VALUES ($1, $2, $2, 'upper', 9, 5, 'warning', $3, 'asa', $4)`,
      [TENANT_A, METRIC, WHATSAPP, at(0)])
      assert.deepEqual(await alertsOf(TENANT_A, [WHATSAPP], 'human'), [])
      assert.equal((await alertsOf(TENANT_A, [WHATSAPP], 'asa')).length, 1)
      const other = await readAs(TENANT_A, `
        SELECT * FROM bob.bob_cell_alerts($1, $2::uuid[], 'no_such_metric', 'asa', $3, $4)`,
      [TENANT_A, [WHATSAPP], at(0), at(6)])
      assert.deepEqual(other, [])
    })
  })
})

// ── Permissions and tenancy (§7) ───────────────────────────────────────────
describe('§7 · every Slice 7 function is invoker, SQL-bodied and granted as Slice 3\'s', () => {
  const discover = async () => (await db.query(`
    SELECT p.oid, p.proname, p.prosecdef, p.prosqlbody IS NOT NULL AS atomic, l.lanname,
           p.provolatile, p.proconfig, pg_get_function_identity_arguments(p.oid) AS args,
           p.proargnames
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
     WHERE n.nspname = 'bob'
       AND (p.proname LIKE 'bob\\_cell\\_%' OR p.proname LIKE 'bob\\_actor\\_%')
     ORDER BY p.proname`)).rows

  const MINE = ['bob_actor_unattributed', 'bob_cell_alerts', 'bob_cell_detail',
    'bob_cell_markers', 'bob_cell_provenance']

  test('21a · the guard finds the Slice 7 functions, and Slice 3\'s alongside', async () => {
    const names = (await discover()).map((f) => f.proname)
    for (const n of [...MINE, 'bob_cell_state', 'bob_cell_rollup', 'bob_actor_cell_state']) {
      assert.ok(names.includes(n), `${n} not found among ${names}`)
    }
  })

  test('21 · invoker, SQL-standard body, STABLE, search_path bob, public', async () => {
    for (const f of await discover()) {
      assert.equal(f.prosecdef, false, `${f.proname} is SECURITY DEFINER`)
      assert.equal(f.lanname, 'sql', `${f.proname} is ${f.lanname}`)
      assert.equal(f.atomic, true, `${f.proname} has no BEGIN ATOMIC body (no pg_depend)`)
      assert.equal(f.provolatile, 's', `${f.proname} is not STABLE`)
      assert.ok((f.proconfig ?? []).some((c) => /^search_path=bob, public/.test(c)),
        `${f.proname}: ${f.proconfig}`)
    }
  })

  test('21b · EXECUTE: bob_app and authenticated, and no other role, exactly as bob_cell_state', async () => {
    const roles = (await db.query(`
      SELECT rolname FROM pg_roles WHERE NOT rolsuper AND rolname NOT LIKE 'pg\\_%'`)).rows
      .map((r) => r.rolname)
    assert.ok(['bob_app', 'authenticated', 'bob_ai_ro', 'bob_feeder', 'anon', 'service_role']
      .every((r) => roles.includes(r)))
    const holders = async (oid) => (await db.query(`
      SELECT r AS rolname FROM unnest($1::text[]) r
       WHERE has_function_privilege(r, $2::oid, 'EXECUTE')
       ORDER BY 1`, [roles, oid])).rows.map((x) => x.rolname)
    const fns = await discover()
    const reference = await holders(fns.find((f) => f.proname === 'bob_cell_state').oid)
    for (const r of ['bob_app', 'authenticated']) assert.ok(reference.includes(r))
    for (const f of fns) {
      const got = await holders(f.oid)
      assert.deepEqual(got.filter((r) => !['postgres'].includes(r)),
        reference.filter((r) => !['postgres'].includes(r)), f.proname)
      for (const r of ['bob_ai_ro', 'bob_feeder', 'anon', 'service_role']) {
        assert.ok(!got.includes(r), `${r} can execute ${f.proname}`)
      }
    }
    const { rows: [{ pub }] } = await db.query(`
      SELECT bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) AS pub
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'bob' AND (p.proname LIKE 'bob\\_cell\\_%' OR p.proname LIKE 'bob\\_actor\\_%')`)
    assert.equal(pub, false, 'PUBLIC can execute one')
  })

  // Arguments by name, for any function the guard discovers.
  const argsFor = (f, org, channels, channel) => f.proargnames.slice(0,
    (f.args.match(/,/g) || []).length + 1).map((n) => ({
    p_org: org, p_channels: channels, p_channel: channel, p_metric: METRIC, p_actor_type: 'human',
    p_from: DAY.from, p_to: DAY.to, p_bucket: DAY.from,
  })[n])

  test('22 · as bob_app with tenant A\'s claim, asking for tenant B\'s organization returns no rows from any of them', async () => {
    await inTx(async () => {
      let own = 0
      for (const f of await discover()) {
        const types = f.args.split(', ').map((a) => a.split(' ').slice(1).join(' '))
        const sql = `SELECT * FROM bob.${f.proname}(${types.map((t, i) => `$${i + 1}::${t}`).join(', ')})`
        const asB = await readAs(TENANT_B, sql, argsFor(f, TENANT_B, B_CHANNELS, VOICE_B))
        own += asB.length
        const crossed = await readAs(TENANT_A, sql, argsFor(f, TENANT_B, B_CHANNELS, VOICE_B))
        assert.deepEqual(crossed, [], `${f.proname} returned tenant B's rows to tenant A`)
      }
      assert.ok(own > 0, 'no function returned a row for its own tenant: the test is vacuous')
    })
  })

  test('23 · bob_ai_ro cannot execute any of them', async () => {
    for (const f of await discover()) {
      const { rows: [{ ok }] } = await db.query(
        `SELECT has_function_privilege('bob_ai_ro', $1::oid, 'EXECUTE') AS ok`, [f.oid])
      assert.equal(ok, false, f.proname)
    }
  })
})

// ── D-33 · option (a), the block that is rewritten if Federico picks (b) or (c) ──
describe('§8 · D-33, option (a): bob_cell_markers', () => {
  const marker = (org, channel, i) => readAs(org, `
    SELECT * FROM bob.bob_cell_markers($1, ARRAY[$2]::uuid[], $3, $4)
     WHERE metric = $5 AND actor_type = 'human'`, [org, channel, at(i), at(i + 1), METRIC])

  async function threshold(cols = {}) {
    const c = { org_id: TENANT_A, metric_id: METRIC, upper_bound: 10, scope_kind: 'entity',
      scope_ref: WHATSAPP, ...cols }
    const keys = Object.keys(c)
    const { rows: [r] } = await db.query(
      `INSERT INTO bob.threshold_configs (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(c))
    return r.id
  }

  test('D1 · a sealed row rebuilt after its deadline plus one cycle: rebuilt_at is its computed_at, the state still observed', async () => {
    await inTx(async () => {
      // bucket 0, lag 0: deadline 10 minutes after bucket_start, plus one cycle.
      const late = at(2) /* 10 min */
      const rebuilt = new Date(Date.parse(late) + 5 * 60_000 + 1000).toISOString()
      await channelRow(5, { computedAt: rebuilt, sealed: true })
      const [m] = await marker(TENANT_A, WHATSAPP, 0)
      assert.equal(iso(m.rebuilt_at), rebuilt)
      const [d] = await readAs(TENANT_A, `SELECT * FROM bob.bob_cell_detail($1, $2, $3, 'human', $4)`,
        [TENANT_A, WHATSAPP, METRIC, at(0)])
      assert.equal(d.state, 'observed')
      assert.equal(iso(d.rebuilt_at), rebuilt)
    })
  })

  test('D2 · sealed by its first write, inside the cycle: rebuilt_at NULL; a NULL lag: NULL', async () => {
    await inTx(async () => {
      await channelRow(5, { computedAt: new Date(Date.parse(at(0)) + 9 * 60_000).toISOString() })
      assert.equal((await marker(TENANT_A, WHATSAPP, 0))[0].rebuilt_at, null)
      // exactly at the boundary is not past it
      await channelRow(5, { i: 1, computedAt: new Date(Date.parse(at(1)) + 10 * 60_000).toISOString() })
      assert.equal((await marker(TENANT_A, WHATSAPP, 1))[0].rebuilt_at, null)
      await channelRow(5, { channel: WEBSITE, computedAt: at(40), i: 0 })
      const [w] = await marker(TENANT_A, WEBSITE, 0)
      assert.ok(w, 'no cell for the website')
      assert.equal(w.rebuilt_at, null)
    })
  })

  test('D2b · an unsealed row is not a rebuild, however late', async () => {
    await inTx(async () => {
      await channelRow(5, { sealed: false, computedAt: at(60) })
      assert.equal((await marker(TENANT_A, WHATSAPP, 0))[0].rebuilt_at, null)
    })
  })

  test('D3 · an alert fired, then its bucket rebuilt to another value: rebuilt_after_firing, two values, alert_log unchanged', async () => {
    await inTx(async () => {
      const t = await threshold()
      await db.query(`INSERT INTO bob.response_rules (org_id, threshold_id, type, name)
                      VALUES ($1, $2, 'alert', 'slice7')`, [TENANT_A, t])
      await channelRow(50)
      await db.query('SELECT * FROM bob.bob_evaluate_at($1, $2)', [TENANT_A, at(1)])
      const { rows: [before] } = await db.query(
        'SELECT id, value, created_at FROM bob.alert_log WHERE threshold_id = $1', [t])
      assert.ok(before, 'no alert fired')
      await db.query(`UPDATE bob.proj_metric_counts SET event_count = 3, session_count = 3,
                        computed_at = $4::timestamptz + interval '1 hour'
                       WHERE org_id = $1 AND channel_id = $2 AND metric_id = $3 AND bucket_start = $5`,
      [TENANT_A, WHATSAPP, METRIC, before.created_at, at(0)])
      const [a] = await readAs(TENANT_A, `
        SELECT * FROM bob.bob_cell_alerts($1, ARRAY[$2]::uuid[], $3, 'human', $4, $5)`,
      [TENANT_A, WHATSAPP, METRIC, at(0), at(6)])
      assert.equal(a.rebuilt_after_firing, true)
      assert.deepEqual([num(a.value_at_firing), num(a.value_now)], [50, 3])
      const { rows: [after] } = await db.query('SELECT value FROM bob.alert_log WHERE id = $1',
        [before.id])
      assert.equal(num(after.value), num(before.value))
    })
  })

  test('D4 · an alert whose bucket was not rebuilt: rebuilt_after_firing false, the two values equal', async () => {
    await inTx(async () => {
      const t = await threshold()
      await db.query(`INSERT INTO bob.response_rules (org_id, threshold_id, type, name)
                      VALUES ($1, $2, 'alert', 'slice7')`, [TENANT_A, t])
      await channelRow(50)
      await db.query('SELECT * FROM bob.bob_evaluate_at($1, $2)', [TENANT_A, at(1)])
      const [a] = await readAs(TENANT_A, `
        SELECT * FROM bob.bob_cell_alerts($1, ARRAY[$2]::uuid[], $3, 'human', $4, $5)`,
      [TENANT_A, WHATSAPP, METRIC, at(0), at(6)])
      assert.equal(a.rebuilt_after_firing, false)
      assert.equal(num(a.value_at_firing), num(a.value_now))
    })
  })

  test('D6 · a channel that declares coverage_records: its cells with counts are unvouched, its cells without are not, other channels never', async () => {
    await inTx(async () => {
      await channelRow(5)
      await channelRow(7, { channel: VOICE, i: 0 })
      const unv = async (channel, i) => (await marker(TENANT_A, channel, i))[0].unvouched
      assert.deepEqual([await unv(WHATSAPP, 0), await unv(VOICE, 0)], [false, false])
      await db.query(`INSERT INTO bob.channel_capabilities (org_id, channel_id, capability)
                      VALUES ($1, $2, 'coverage_records')`, [TENANT_A, WHATSAPP])
      assert.equal(await unv(WHATSAPP, 0), true, 'counts and no record')
      assert.equal(await unv(WHATSAPP, 1), false, 'no counts: nothing to vouch for')
      assert.equal(await unv(VOICE, 0), false, 'capability absent')
      const [d] = await readAs(TENANT_A, `SELECT * FROM bob.bob_cell_detail($1, $2, $3, 'human', $4)`,
        [TENANT_A, WHATSAPP, METRIC, at(0)])
      assert.deepEqual([d.unvouched, d.state], [true, 'observed'])
    })
  })

  test('D5 · with no channel declaring coverage_records, no cell is unvouched', async () => {
    await inTx(async () => {
      const rows = await readAs(TENANT_A, `
        SELECT unvouched FROM bob.bob_cell_markers($1, $2::uuid[], $3, $4)`,
      [TENANT_A, A_CHANNELS, '2026-11-18T09:00:00Z', '2026-11-18T11:00:00Z'])
      assert.ok(rows.length > 100, `only ${rows.length} cells`)
      assert.ok(rows.every((r) => r.unvouched === false), 'a cell is unvouched or NULL')
    })
  })
})
