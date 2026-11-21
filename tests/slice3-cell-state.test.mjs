// Slice 3 · the absent-not-zero state, against docs/slice-3-absent-not-zero.md
// §8. FR-32, UI-03, PR-10 and SR-2 against one implementation, bob_cell_state,
// and the rest of what the grill decided.
//
// The world is the two-tenant fixture, the roster, the feeder's world and the
// cell's world (§8.1), projected by the reference feeder running as
// bob_feeder over feeder_events.json plus slice3_events.json. Cells are read
// as bob_app under the tenant's claim, the way bob-web reads them. Each guard
// was seen failing on purpose before it was trusted; the table is in
// contract-amendments.md, "Slice 3 · The absent-not-zero state, built".
//
// Everything that changes something does so inside a transaction and rolls
// back, except the feeder runs, which rebuild their window.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  connect, connectAs, loadFixture, loadRoster, loadFeederWorld, loadSlice3World,
  REPO_ROOT, TENANT_A, TENANT_B,
} from './helpers/db.mjs'
import { MemoryTruthStore } from '../feeder/memory-truth-store.mjs'
import { runFeeder } from '../feeder/reference-feeder.mjs'
import {
  ZERO_RULES, ZERO_PRECONDITIONS, LABEL_FAILURES, TRAFFIC_KINDS, kindOf,
} from '../feeder/event-mapping.mjs'

const read = (f) => JSON.parse(readFileSync(resolve(REPO_ROOT, f), 'utf8'))
const SLICE2 = read('supabase/tests/fixtures/feeder_events.json')
const SLICE3 = read('supabase/tests/fixtures/slice3_events.json')
const EVENTS = [...SLICE2.events, ...SLICE3.events]
const WATERMARK = SLICE3.watermark
const RUN = { from: '2026-11-18T00:00:00Z', to: '2026-11-18T15:00:00Z' }

const WHATSAPP = 'aaaaaaaa-2222-4000-8000-000000000001'
const VOICE = 'aaaaaaaa-2222-4000-8000-00000000000a'
const WEBSITE = 'aaaaaaaa-2222-4000-8000-00000000000b'
const CHAT = 'aaaaaaaa-2222-4000-8000-00000000000d'
const APP = 'aaaaaaaa-2222-4000-8000-00000000000e'
const VOICE_B = 'bbbbbbbb-2222-4000-8000-000000000002'
const CHAT_B = 'bbbbbbbb-2222-4000-8000-00000000000c'
const A_CHANNELS = [WHATSAPP, VOICE, WEBSITE, CHAT, APP]
const B_CHANNELS = [VOICE_B, CHAT_B]
const TENANTS = [TENANT_A, TENANT_B]
const DAY = { from: '2026-11-18T00:00:00Z', to: '2026-11-18T15:00:00Z' }
const AFTERNOON = { from: '2026-11-18T14:00:00Z', to: '2026-11-18T15:00:00Z' }
const LABELS = ['abstained', 'classifier_down', 'label_missing']
const NEVER_USER = ['resolved', 'disambiguation', 'escalations']

let db, feeder, app

const truth = () => new MemoryTruthStore({ events: EVENTS, watermark: WATERMARK })
const run = () => runFeeder(feeder, truth(), { ...RUN, orgIds: TENANTS })

before(async () => {
  db = await connect()
  await loadFixture(db)
  await loadRoster(db)
  await loadFeederWorld(db)
  await loadSlice3World(db)
  await db.query('GRANT bob_feeder, bob_app TO current_user')
  feeder = await connectAs('bob_feeder')
  app = await connectAs('bob_app')
  await run()
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

// Read as bob_app holding a tenant's claim, as bob-web does.
async function asApp(orgId, sql, params = []) {
  await app.query('BEGIN')
  try {
    await app.query('SELECT set_config($1, $2, true)',
      ['request.jwt.claims', JSON.stringify({ org_id: orgId })])
    return (await app.query(sql, params)).rows
  } finally {
    await app.query('ROLLBACK')
  }
}

const iso = (t) => new Date(t).toISOString()
const norm = (r) => ({
  ...r,
  bucket_start: r.bucket_start ? iso(r.bucket_start) : r.bucket_start,
  value: r.value === null || r.value === undefined ? null : Number(r.value),
})

async function cells(orgId, channels, frame) {
  return (await asApp(orgId,
    'SELECT * FROM bob.bob_cell_state($1, $2::uuid[], $3, $4)',
    [orgId, channels, frame.from, frame.to])).map(norm)
}

async function rollup(orgId, channels, frame) {
  return (await asApp(orgId,
    'SELECT * FROM bob.bob_cell_rollup($1, $2::uuid[], $3, $4)',
    [orgId, channels, frame.from, frame.to])).map(norm)
}

const one = (list, where) => {
  const found = list.filter((c) => Object.entries(where).every(([k, v]) => c[k] === v))
  assert.equal(found.length, 1, `expected one cell for ${JSON.stringify(where)}, found ${found.length}`)
  return found[0]
}

// Run `sql` and return the SQLSTATE it raised, or null, inside a savepoint.
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

async function catalog() {
  return (await db.query('SELECT * FROM bob.cell_catalog ORDER BY metric')).rows
}

// ── §4 · the catalog ────────────────────────────────────────────────────────
// The values a projection's single-column CHECK accepts for metric_id or
// measure, read from the constraints themselves.
async function checkedMetricValues() {
  const { rows } = await db.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           pg_get_constraintdef(k.oid) AS def
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'c' AND n.nspname = 'bob' AND c.relkind = 'p'
       AND cardinality(k.conkey) = 1
       AND a.attname IN ('metric_id', 'measure')`)
  const out = []
  for (const r of rows) {
    for (const m of r.def.matchAll(/'([a-z_]+)'::text/g)) {
      out.push({ table: r.table_name, column: r.column_name, value: m[1] })
    }
  }
  return out
}

describe('§4 · the catalog', () => {
  test('every metric_id and measure a projection CHECK accepts is in the catalog', async () => {
    const values = await checkedMetricValues()
    assert.ok(values.length >= 15, `the CHECK discovery found ${values.length} values`)
    const tables = new Set(values.map((v) => v.table))
    for (const t of ['proj_metric_counts', 'proj_durations', 'proj_actor_metrics']) {
      assert.ok(tables.has(t), `${t} not discovered`)
    }
    const known = new Set((await catalog()).map((k) => k.metric))
    const missing = values.filter((v) => !known.has(v.value)).map((v) => `${v.table}.${v.column} = ${v.value}`)
    assert.deepEqual(missing, [], 'a projection accepts a metric the catalog does not know')
  })

  // Discovered by behaviour: a row for each metric, under a non-user actor,
  // is offered to the table; the CHECK refuses it exactly when the catalog
  // says the metric is degenerate.
  test('the degenerate CHECKs and the catalog agree', async () => {
    const disagree = []
    await inTx(async () => {
      await db.query('SELECT bob.proj_ensure_partition($1::regclass, $2::date)',
        ['bob.proj_metric_counts', '2026-11-01'])
      await db.query('SELECT bob.proj_ensure_partition($1::regclass, $2::date)',
        ['bob.proj_durations', '2026-11-01'])
      for (const k of await catalog()) {
        if (!['proj_metric_counts', 'proj_durations'].includes(k.source)) continue
        const sql = k.source === 'proj_metric_counts'
          ? `INSERT INTO bob.proj_metric_counts (org_id, channel_id, actor_type, metric_id,
               bucket_start, source_watermark, feeder_version)
             VALUES ($1, $2, 'asa', $3, '2026-11-02 00:00:00+00', now(), 'probe')`
          : `INSERT INTO bob.proj_durations (org_id, channel_id, actor_type, measure,
               bucket_start, n, sum_ms, hist_offset, source_watermark, feeder_version)
             VALUES ($1, $2, 'asa', $3, '2026-11-02 00:00:00+00', 0, 0, 0, now(), 'probe')`
        const code = await refusal(sql, [TENANT_A, WHATSAPP, k.metric])
        const refused = code === '23514'
        if (refused !== k.degenerate) disagree.push(`${k.metric}: CHECK refuses ${refused}, catalog degenerate ${k.degenerate}`)
      }
    })
    assert.deepEqual(disagree, [])
  })

  test('every capability the catalog requires is one channel_capabilities accepts', async () => {
    const { rows: [{ def }] } = await db.query(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'channel_capabilities_capability_check'`)
    const accepted = new Set([...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]))
    assert.equal(accepted.size, 13, 'F-29: thirteen capabilities')
    for (const c of ['disambiguation', 'escalation', 'queue']) assert.ok(accepted.has(c), c)
    const unknown = (await catalog()).flatMap((k) => k.required_capabilities)
      .filter((c) => !accepted.has(c))
    assert.deepEqual(unknown, [])
  })

  test('the feeder\'s exclusion list equals the catalog\'s preconditioned metrics, both ways', async () => {
    const fromCatalog = Object.fromEntries((await catalog())
      .filter((k) => k.precondition !== null).map((k) => [k.metric, k.precondition]))
    assert.deepEqual(ZERO_PRECONDITIONS, fromCatalog)
  })

  // The feeder cannot read the catalog (two views, §7.4), so it carries a
  // copy. Every metric the feeder writes a zero for, with its capability and
  // actor types, is the catalog's; every catalog metric read from those two
  // projections is the feeder's, except the label failures (§4.1).
  test('the feeder\'s zero rules equal the catalog, both ways', async () => {
    const want = {}
    for (const k of await catalog()) {
      if (!['proj_metric_counts', 'proj_durations'].includes(k.source)) continue
      if (LABEL_FAILURES.has(k.metric) || k.metric === 'label_missing') continue
      want[k.metric] = {
        table: k.source, capability: k.required_capabilities[0] ?? null,
        actors: k.applicable_actor_types, ...(k.degenerate ? { degenerate: true } : {}),
      }
      assert.ok(k.required_capabilities.length <= 1, `${k.metric} requires more than one capability`)
    }
    assert.deepEqual(ZERO_RULES, want)
  })
})

// ── SR-2 and "one implementation, not four" ─────────────────────────────────
// What a function or view references, from pg_depend, walked transitively.
async function reaches(fromSql, target) {
  const { rows: [{ found }] } = await db.query(`
    WITH RECURSIVE start AS (SELECT ${fromSql} AS oid),
    walk(classid, objid) AS (
      SELECT 'pg_proc'::regclass, s.oid FROM start s
       WHERE EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = s.oid)
      UNION
      SELECT 'pg_rewrite'::regclass, r.oid FROM start s JOIN pg_rewrite r ON r.ev_class = s.oid
      UNION
      SELECT d.refclassid, d.refobjid FROM walk w
        JOIN pg_depend d ON d.classid = w.classid AND d.objid = w.objid
       WHERE d.refclassid = 'pg_proc'::regclass
    )
    SELECT EXISTS (SELECT 1 FROM walk WHERE classid = 'pg_proc'::regclass
                     AND objid = ${target}) AS found`)
  return found
}

const CELL = `'bob.bob_cell_state(uuid, uuid[], timestamptz, timestamptz)'::regprocedure::oid`

describe('SR-2 · the cell calls the one definition of the sentinel', () => {
  test('bob_cell_state depends on bob_source_key_unset(), through pg_depend', async () => {
    assert.equal(await reaches(CELL, `'public.bob_source_key_unset(text)'::regprocedure::oid`), true)
  })

  test('a channel on the sentinel is not_configured in every applicable cell, source_key_unset ahead of any capability', async () => {
    const list = await cells(TENANT_B, B_CHANNELS, AFTERNOON)
    const voice = list.filter((c) => c.channel_id === VOICE_B && c.state !== 'not_applicable')
    assert.ok(voice.length > 100)
    for (const c of voice) {
      assert.equal(c.state, 'not_configured', JSON.stringify(c))
      const at = c.reasons.indexOf('source_key_unset')
      assert.ok(at >= 0, JSON.stringify(c))
      const cap = c.reasons.findIndex((r) => r.startsWith('capability_not_declared:'))
      assert.ok(cap === -1 || at < cap, JSON.stringify(c))
      assert.equal(c.value, null)
    }
  })

  test('an organisation with no telemetry_started_at gives telemetry_not_started, first', async () => {
    const list = (await cells(TENANT_B, B_CHANNELS, AFTERNOON)).filter((c) => c.state !== 'not_applicable')
    assert.ok(list.length > 0)
    for (const c of list) assert.equal(c.reasons[0], 'telemetry_not_started', JSON.stringify(c))
    const a = (await cells(TENANT_A, A_CHANNELS, AFTERNOON))
    assert.ok(!a.some((c) => c.reasons.includes('telemetry_not_started')))
  })
})

describe('one implementation, not four', () => {
  test('the rollup, the per-actor cells and BObee\'s face read bob_cell_state, through pg_depend', async () => {
    for (const from of [
      `'bob.bob_cell_rollup(uuid, uuid[], timestamptz, timestamptz)'::regprocedure::oid`,
      `'bob.bob_actor_cell_state(uuid, uuid[], timestamptz, timestamptz)'::regprocedure::oid`,
      `'bob.v_ai_cell_state'::regclass::oid`,
    ]) {
      assert.equal(await reaches(from, CELL), true, `${from} does not reach bob_cell_state`)
    }
  })

  // Discovered: every function that reads the catalog or calls bob_cell_state
  // must have a SQL-standard body, or pg_depend would show nothing for it and
  // a second definition of the order could hide there.
  test('every function of the mechanism has a BEGIN ATOMIC body', async () => {
    const { rows } = await db.query(`
      SELECT p.oid::regprocedure::text AS fn, p.prosqlbody IS NOT NULL AS atomic
        FROM pg_proc p
       WHERE p.oid = ${CELL}
          OR p.oid IN (SELECT d.objid FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass
                          AND ((d.refclassid = 'pg_class'::regclass
                                AND d.refobjid = 'bob.cell_catalog'::regclass)
                            OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid = ${CELL})))
       ORDER BY 1`)
    const names = rows.map((r) => r.fn.replace(/\(.*$/, '').replace(/^.*\./, ''))
    for (const f of ['bob_cell_state', 'bob_cell_rollup', 'bob_actor_cell_state', 'bob_ai_cell_state']) {
      assert.ok(names.includes(f), `${f} not discovered`)
    }
    assert.deepEqual(rows.filter((r) => !r.atomic).map((r) => r.fn), [])
  })

  test('Available\'s translation reads bob_availability() and has a BEGIN ATOMIC body', async () => {
    const fn = `'bob.bob_available_state(uuid, uuid[], bigint, numeric, numeric, timestamptz)'::regprocedure::oid`
    assert.equal(await reaches(fn,
      `'public.bob_availability(uuid, uuid[], bigint, numeric, numeric, timestamptz)'::regprocedure::oid`), true)
    const { rows: [{ atomic }] } = await db.query(
      `SELECT prosqlbody IS NOT NULL AS atomic FROM pg_proc WHERE oid = ${fn}`)
    assert.equal(atomic, true)
  })
})

// ── The four rules ──────────────────────────────────────────────────────────
describe('FR-32 · MECA is never a zero it did not observe', () => {
  test('a selection of Voice only: not_configured (capability_not_declared:meca_rum), value NULL', async () => {
    const [r] = (await rollup(TENANT_A, [VOICE], AFTERNOON)).filter((x) => x.metric === 'meca')
    assert.equal(r.state, 'not_configured')
    assert.deepEqual(r.reasons, ['capability_not_declared:meca_rum'])
    assert.equal(r.value, null)
    for (const c of (await cells(TENANT_A, [VOICE], AFTERNOON)).filter((x) => x.metric === 'meca')) {
      assert.equal(c.value, null)
    }
  })

  // The spec says not_observed for the website. Its lag is not declared, and
  // R3 rules that such a channel never shows not_observed: it is pending
  // (finding F-45). The chat channel declares meca_rum with a lag and gives
  // not_observed. Neither is ever 0.
  test('a channel that declares meca_rum and has no RUM row: never 0', async () => {
    const web = (await cells(TENANT_A, [WEBSITE], AFTERNOON)).filter((c) => c.metric === 'meca')
    assert.ok(web.length > 0)
    for (const c of web) {
      assert.equal(c.state, 'pending', JSON.stringify(c))
      assert.deepEqual(c.reasons, ['lag_not_declared'])
      assert.equal(c.value, null)
    }
    const chat = (await cells(TENANT_A, [CHAT], AFTERNOON)).filter((c) => c.metric === 'meca')
    const sealed = chat.filter((c) => Date.parse(c.bucket_start) + 360_000 <= Date.parse(WATERMARK))
    assert.ok(sealed.length > 0)
    for (const c of sealed) {
      assert.equal(c.state, 'not_observed', JSON.stringify(c))
      assert.equal(c.value, null)
    }
  })
})

describe('UI-03 · every empty or zero figure says why', () => {
  // not_applicable carries no reason by §3 step 1: it is painted empty and
  // muted, with no action and no em dash. Every other cell or rollup whose
  // value is NULL or 0 carries at least one.
  test('over every cell of the whole frame, both tenants', async () => {
    let n = 0
    const silent = []
    for (const [org, chans] of [[TENANT_A, A_CHANNELS], [TENANT_B, B_CHANNELS]]) {
      for (const c of await cells(org, chans, DAY)) {
        n++
        if (c.state === 'not_applicable') continue
        if ((c.value === null || c.value === 0) && c.reasons.length === 0) silent.push(c)
      }
    }
    assert.ok(n > 10_000, `only ${n} cells`)
    assert.deepEqual(silent.slice(0, 3), [])
  })

  test('over every rollup of the whole frame, both tenants', async () => {
    const silent = []
    for (const [org, chans] of [[TENANT_A, A_CHANNELS], [TENANT_B, B_CHANNELS]]) {
      for (const r of await rollup(org, chans, DAY)) {
        if (r.state === 'not_applicable') continue
        if ((r.value === null || r.value === 0) && r.reasons.length === 0) silent.push(r)
      }
    }
    assert.deepEqual(silent, [])
  })

  test('every state of §2 appears in the fixture', async () => {
    const seen = new Set((await cells(TENANT_A, A_CHANNELS, DAY)).map((c) => c.state))
    for (const s of ['not_applicable', 'not_configured', 'pending', 'not_observed', 'observed']) {
      assert.ok(seen.has(s), `${s} never appears`)
    }
  })
})

describe('PR-10 · the same capability and sealed bucket, three ways', () => {
  // WhatsApp declares `escalation`; humans are present. Lag 0, so every bucket
  // before the watermark is sealed.
  const at = (bucket) => ({ from: bucket, to: new Date(Date.parse(bucket) + 300_000).toISOString() })

  test('no traffic and no probe: not_observed, with no row', async () => {
    const c = one(await cells(TENANT_A, [WHATSAPP], at('2026-11-18T14:40:00Z')),
      { metric: 'escalations', actor_type: 'human' })
    assert.equal(c.state, 'not_observed')
    assert.deepEqual(c.reasons, ['no_liveness'])
    assert.equal(c.value, null)
    const { rows } = await db.query(`SELECT 1 FROM bob.proj_metric_counts WHERE channel_id = $1
      AND metric_id = 'escalations' AND bucket_start = '2026-11-18 14:40:00+00'`, [WHATSAPP])
    assert.equal(rows.length, 0)
  })

  test('traffic and no event: observed 0, from a written row, liveness traffic', async () => {
    const c = one(await cells(TENANT_A, [WHATSAPP], at('2026-11-18T14:00:00Z')),
      { metric: 'escalations', actor_type: 'human' })
    assert.deepEqual([c.state, c.value, c.liveness_source, c.provisional],
      ['observed', 0, 'traffic', false])
    assert.deepEqual(c.reasons, ['none_observed'])
    const { rows } = await db.query(`SELECT event_count FROM bob.proj_metric_counts
      WHERE channel_id = $1 AND metric_id = 'escalations' AND actor_type = 'human'
        AND bucket_start = '2026-11-18 14:00:00+00'`, [WHATSAPP])
    assert.deepEqual(rows.map((r) => Number(r.event_count)), [0])
  })

  test('a probe and no traffic: observed 0, liveness probe', async () => {
    const c = one(await cells(TENANT_A, [WHATSAPP], at('2026-11-18T03:00:00Z')),
      { metric: 'escalations', actor_type: 'human' })
    assert.deepEqual([c.state, c.value, c.liveness_source], ['observed', 0, 'probe'])
    assert.deepEqual(c.reasons, ['none_observed'])
    const up = one(await cells(TENANT_A, [WHATSAPP], at('2026-11-18T03:00:00Z')),
      { metric: 'health_uptime', actor_type: null })
    assert.deepEqual([up.state, up.value, up.liveness_source], ['observed', 300, 'probe'])
  })

  test('a declared-false mix is not an undeclared one (G8)', async () => {
    const absent = one(await cells(TENANT_A, [CHAT], at('2026-11-18T14:30:00Z')),
      { metric: 'resolved', actor_type: 'human' })
    assert.deepEqual([absent.state, absent.value, absent.reasons], ['observed', 0, ['actor_not_present']])
    const undeclared = one(await cells(TENANT_A, [APP], at('2026-11-18T14:30:00Z')),
      { metric: 'resolved', actor_type: 'human' })
    assert.deepEqual([undeclared.state, undeclared.value, undeclared.reasons],
      ['not_configured', null, ['mix_not_declared']])
  })
})

// ── The rest of what the grill decided ──────────────────────────────────────
describe('FR-11 · an actor declared absent everywhere is exactly 0', () => {
  test('in sealed and unsealed buckets alike, with actor_not_present', async () => {
    // Humans: declared absent on the website (lag NULL, never sealed) and on
    // the chat channel (lag 60, sealed behind the watermark).
    const list = (await cells(TENANT_A, [WEBSITE, CHAT], AFTERNOON))
      .filter((c) => c.metric === 'resolved' && c.actor_type === 'human')
    assert.ok(list.some((c) => c.channel_id === WEBSITE))
    assert.ok(list.some((c) => c.channel_id === CHAT
      && Date.parse(c.bucket_start) + 360_000 <= Date.parse(WATERMARK)))
    for (const c of list) {
      assert.deepEqual([c.state, c.value, c.reasons, c.provisional],
        ['observed', 0, ['actor_not_present'], false], JSON.stringify(c))
    }
    const [r] = (await rollup(TENANT_A, [WEBSITE, CHAT], AFTERNOON))
      .filter((x) => x.metric === 'resolved' && x.actor_type === 'human')
    assert.deepEqual([r.state, r.value, r.reasons], ['observed', 0, ['actor_not_present']])
  })
})

describe('the degenerate metrics ignore the mix', () => {
  test('on a channel with no user mix row, the label failures resolve from their rows', async () => {
    const { rows } = await db.query(`SELECT 1 FROM bob.channel_actor_mix
      WHERE channel_id = $1 AND actor_type = 'user'`, [CHAT])
    assert.equal(rows.length, 0, 'the chat channel has no user mix row')
    const list = (await cells(TENANT_A, [CHAT], { from: '2026-11-18T14:30:00Z', to: '2026-11-18T14:35:00Z' }))
      .filter((c) => LABELS.includes(c.metric) && c.actor_type === 'user')
    assert.equal(list.length, 3)
    for (const c of list) {
      assert.equal(c.state, 'observed', JSON.stringify(c))
      assert.ok(!c.reasons.includes('mix_not_declared'))
    }
    assert.equal(one(list, { metric: 'label_missing' }).value, 1)
  })
})

describe('F-30 · the "All" total carries its coverage', () => {
  test('the label-failure total reads 2 of 3 channels, with Voice not_configured', async () => {
    const frame = { from: '2026-11-18T14:00:00Z', to: '2026-11-18T14:30:00Z' }
    const r = one(await rollup(TENANT_A, [WHATSAPP, VOICE, WEBSITE], frame),
      { metric: 'abstained', actor_type: 'user' })
    assert.equal(r.state, 'observed')
    assert.equal(r.value, 1)
    assert.equal(r.coverage.n, 2)
    assert.equal(r.coverage.m, 3)
    assert.deepEqual(r.coverage.excluded, [{
      channel_id: VOICE, state: 'not_configured',
      reasons: ['capability_not_declared:orga_conversation'],
    }])
  })

  test('the figure sums the observed cells only', async () => {
    const frame = { from: '2026-11-18T14:00:00Z', to: '2026-11-18T14:30:00Z' }
    const list = await cells(TENANT_A, [WHATSAPP, VOICE, WEBSITE], frame)
    for (const r of await rollup(TENANT_A, [WHATSAPP, VOICE, WEBSITE], frame)) {
      const mine = list.filter((c) => c.metric === r.metric && c.actor_type === r.actor_type
        && c.state === 'observed')
      const sum = mine.length ? mine.reduce((a, c) => a + c.value, 0) : null
      assert.equal(r.value, sum, `${r.metric}/${r.actor_type}`)
      assert.equal(r.provisional, mine.some((c) => c.provisional), `${r.metric}/${r.actor_type}`)
    }
  })
})

describe('R3 · pending follows the current lag', () => {
  test('raising a lag turns back only the cells inside the new window', async () => {
    const before = await cells(TENANT_A, [WHATSAPP], AFTERNOON)
    const lag = 1200
    const edge = Date.parse(WATERMARK) - 300_000 - lag * 1000
    await db.query('UPDATE bob.channels SET lag_seconds = $1 WHERE id = $2', [lag, WHATSAPP])
    let after
    try {
      after = await cells(TENANT_A, [WHATSAPP], AFTERNOON)
    } finally {
      await db.query('UPDATE bob.channels SET lag_seconds = 0 WHERE id = $1', [WHATSAPP])
    }
    const key = (c) => `${c.metric}|${c.actor_type}|${c.bucket_start}`
    const was = new Map(before.map((c) => [key(c), c]))
    assert.equal(after.length, before.length)
    let changed = 0
    for (const c of after) {
      const b = was.get(key(c))
      if (Date.parse(c.bucket_start) > edge) {
        if (b.state !== c.state) {
          changed++
          assert.deepEqual([b.state, c.state, c.reasons], ['not_observed', 'pending', ['not_sealed']])
        }
      } else {
        assert.deepEqual(c, b, `a cell outside the new window changed: ${key(c)}`)
      }
    }
    assert.ok(changed > 0, 'no cell inside the new window turned back')
  })

  test('a channel with lag NULL never shows not_observed', async () => {
    const web = await cells(TENANT_A, [WEBSITE], DAY)
    assert.ok(web.length > 0)
    assert.equal(web.filter((c) => c.state === 'not_observed').length, 0)
    assert.ok(web.some((c) => c.state === 'pending' && c.reasons[0] === 'lag_not_declared'))
  })
})

describe('R7 · no selection', () => {
  test('an empty channel set gives not_applicable with no_channels_selected', async () => {
    const list = await rollup(TENANT_A, [], AFTERNOON)
    assert.ok(list.length > 20)
    for (const r of list) {
      assert.deepEqual([r.state, r.reasons, r.value], ['not_applicable', ['no_channels_selected'], null])
    }
    const avail = await asApp(TENANT_A, 'SELECT * FROM bob.bob_available_state($1, $2::uuid[])',
      [TENANT_A, []])
    assert.equal(avail.length, 3)
    for (const a of avail) {
      assert.deepEqual([a.state, a.reasons, a.value], ['not_applicable', ['no_channels_selected'], null])
    }
  })

  test('Available: mix_not_declared is not_configured, every other FR-23 reason an observed 0', async () => {
    const at = '2026-09-03T10:00:00Z'
    const byType = async (chans) => Object.fromEntries((await asApp(TENANT_A,
      'SELECT * FROM bob.bob_available_state($1, $2::uuid[], NULL, NULL, NULL, $3)',
      [TENANT_A, chans, at])).map((a) => [a.actor_type, { ...a, value: a.value === null ? null : Number(a.value) }]))
    const app_ = await byType([APP])
    assert.deepEqual([app_.human.state, app_.human.reasons, app_.human.value],
      ['not_configured', ['mix_not_declared'], null])
    const web = await byType([WEBSITE])
    assert.deepEqual([web.human.state, web.human.reasons, web.human.value],
      ['observed', ['no_channels_carry_actor_type'], 0])
    const whats = await byType([WHATSAPP])
    assert.equal(whats.human.state, 'observed')
    assert.ok(whats.human.value > 0)
    assert.deepEqual(whats.human.reasons, [])
  })
})

describe('provisional', () => {
  test('the website\'s Resolved (lag NULL) is observed and provisional, with lag not declared', async () => {
    const c = one(await cells(TENANT_A, [WEBSITE], { from: '2026-11-18T14:20:00Z', to: '2026-11-18T14:25:00Z' }),
      { metric: 'resolved', actor_type: 'asa' })
    assert.deepEqual([c.state, c.value, c.provisional], ['observed', 1, true])
    assert.deepEqual(c.reasons, ['lag_not_declared'])
    const { rows } = await db.query(
      'SELECT lag_not_declared FROM bob.v_channel_declaration_gaps WHERE channel_id = $1', [WEBSITE])
    assert.deepEqual(rows, [{ lag_not_declared: true }])
  })
})

describe('F-33 · not applicable', () => {
  test('Resolved, Disambiguation and Escalations under user are not_applicable, on every channel', async () => {
    const list = (await cells(TENANT_A, A_CHANNELS, AFTERNOON))
      .filter((c) => NEVER_USER.includes(c.metric) && c.actor_type === 'user')
    assert.ok(list.length > 0)
    for (const c of list) assert.deepEqual([c.state, c.reasons, c.value], ['not_applicable', [], null])
  })

  test('the feeder never writes a user row for any of the three', async () => {
    const { rows } = await db.query(`SELECT metric_id, channel_id FROM bob.proj_metric_counts
      WHERE org_id = ANY($1::uuid[]) AND actor_type = 'user' AND metric_id = ANY($2)`,
    [TENANTS, NEVER_USER])
    assert.deepEqual(rows, [])
  })
})

// ── The zero rows (F-28, corrected; F-38) ───────────────────────────────────
async function zeroRows() {
  const { rows } = await db.query(`
    SELECT channel_id, actor_type, metric_id AS metric, bucket_start, session_count
      FROM bob.proj_metric_counts
     WHERE org_id = ANY($1::uuid[]) AND event_count = 0 AND NOT (metric_id = ANY($2))
    UNION ALL
    SELECT channel_id, actor_type, measure, bucket_start, NULL
      FROM bob.proj_durations
     WHERE org_id = ANY($1::uuid[]) AND n = 0`, [TENANTS, LABELS])
  return rows.map((r) => ({ ...r, bucket_start: iso(r.bucket_start) }))
}

// The buckets where the truth store holds liveness for a channel, from the
// events themselves: traffic, or an uptime probe on a channel declaring it.
async function livenessInTruth() {
  const { rows: chans } = await db.query(`
    SELECT c.id, o.slug, c.source_key,
           ARRAY(SELECT capability FROM bob.channel_capabilities cc WHERE cc.channel_id = c.id) AS caps
      FROM bob.channels c JOIN bob.organizations o ON o.id = c.org_id`)
  const byKey = new Map(chans.map((c) => [`${c.slug}|${c.source_key}`, c]))
  const live = new Set()
  for (const e of EVENTS) {
    const ch = byKey.get(`${e['bzzz.tenant']}|${e.source_key}`)
    if (!ch) continue
    const kind = kindOf(e)
    const probe = kind === 'probe' && ch.caps.includes('health_uptime')
    if (!TRAFFIC_KINDS.has(kind) && !probe) continue
    const b = new Date(Math.floor(Date.parse(e.event_time) / 300_000) * 300_000).toISOString()
    live.add(`${ch.id}|${b}`)
  }
  return live
}

describe('F-28 · the feeder writes the observed zero, and only that one', () => {
  test('there are zero rows, on both projections', async () => {
    const z = await zeroRows()
    assert.ok(z.some((r) => r.metric === 'resolved'))
    assert.ok(z.some((r) => r.metric === 'response_time'))
    assert.ok(z.some((r) => r.metric === 'interaction_duration'))
  })

  test('every zero has liveness and a declared capability, and is sealed', async () => {
    const live = await livenessInTruth()
    const cat = Object.fromEntries((await catalog()).map((k) => [k.metric, k]))
    const { rows: caps } = await db.query('SELECT channel_id, capability FROM bob.channel_capabilities')
    const declared = new Set(caps.map((c) => `${c.channel_id}|${c.capability}`))
    const { rows: chans } = await db.query('SELECT id, idle_bound_seconds FROM bob.channels')
    const idle = new Map(chans.map((c) => [c.id, c.idle_bound_seconds]))
    const bad = []
    for (const z of await zeroRows()) {
      const k = cat[z.metric]
      if (!live.has(`${z.channel_id}|${z.bucket_start}`)) bad.push(`no liveness: ${JSON.stringify(z)}`)
      for (const c of k.required_capabilities) {
        if (!declared.has(`${z.channel_id}|${c}`)) bad.push(`undeclared ${c}: ${JSON.stringify(z)}`)
      }
      if (k.precondition === 'ground_truth') bad.push(`ground truth unseen: ${JSON.stringify(z)}`)
      if (k.precondition === 'idle_bound' && idle.get(z.channel_id) === null) bad.push(`no idle bound: ${JSON.stringify(z)}`)
    }
    assert.deepEqual(bad, [])
    const { rows: unsealed } = await db.query(`
      SELECT 1 FROM bob.proj_metric_counts WHERE org_id = ANY($1::uuid[]) AND event_count = 0
         AND NOT sealed AND NOT (metric_id = ANY($2))
      UNION ALL
      SELECT 1 FROM bob.proj_durations WHERE org_id = ANY($1::uuid[]) AND n = 0 AND NOT sealed`,
    [TENANTS, LABELS])
    assert.equal(unsealed.length, 0, 'a zero was written before its bucket sealed')
  })

  test('a probe-only bucket writes session_count 0', async () => {
    const z = (await zeroRows()).filter((r) => r.channel_id === WHATSAPP
      && r.bucket_start === '2026-11-18T03:00:00.000Z' && r.session_count !== null)
    assert.ok(z.length > 0)
    for (const r of z) assert.equal(Number(r.session_count), 0)
  })

  test('the rebuild (clear, re-run) renders the zero rows identically', async () => {
    const snap = async () => {
      const out = {}
      for (const t of ['proj_metric_counts', 'proj_durations', 'proj_channel_health']) {
        out[t] = (await db.query(`SELECT to_jsonb(x) - 'computed_at' AS r FROM bob.${t} x
          WHERE org_id = ANY($1::uuid[]) ORDER BY (to_jsonb(x) - 'computed_at')::text`, [TENANTS])).rows
      }
      return out
    }
    const first = await snap()
    assert.ok(first.proj_channel_health.length > 0)
    for (const t of Object.keys(first)) {
      await db.query(`DELETE FROM bob.${t} WHERE org_id = ANY($1::uuid[])`, [TENANTS])
    }
    await run()
    assert.deepEqual(await snap(), first)
  })
})

describe('F-28, corrected · no zero for a preconditioned metric', () => {
  test('a channel declaring hallucination, with traffic, gets no hallucinations row', async () => {
    const { rows } = await db.query(`SELECT 1 FROM bob.proj_metric_counts
      WHERE channel_id = $1 AND metric_id = 'hallucinations'`, [CHAT])
    assert.equal(rows.length, 0)
    assert.ok((await livenessInTruth()).has(`${CHAT}|2026-11-18T14:30:00.000Z`), 'the chat channel has traffic')
    const c = one(await cells(TENANT_A, [CHAT], { from: '2026-11-18T14:30:00Z', to: '2026-11-18T14:35:00Z' }),
      { metric: 'hallucinations', actor_type: 'asa' })
    assert.deepEqual([c.state, c.reasons], ['not_configured', ['no_ground_truth']])
  })

  test('a channel with traffic and no idle bound gets no abandoned row; with the bound, it does', async () => {
    const { rows } = await db.query(`SELECT channel_id FROM bob.proj_metric_counts
      WHERE org_id = $1 AND metric_id = 'abandoned' GROUP BY channel_id`, [TENANT_A])
    assert.deepEqual(rows.map((r) => r.channel_id), [WHATSAPP])
    const c = one(await cells(TENANT_A, [CHAT], { from: '2026-11-18T14:30:00Z', to: '2026-11-18T14:35:00Z' }),
      { metric: 'abandoned', actor_type: 'asa' })
    assert.deepEqual([c.state, c.reasons], ['not_configured', ['idle_bound_not_declared']])
  })
})

// The degenerate metrics belong to the conversation and write `user` whatever
// the mix says (§5); the mix decides the actor-typed ones.
const DEGENERATE = Object.entries(ZERO_RULES).filter(([, r]) => r.degenerate).map(([m]) => m)

describe('F-38 · zeros only for declared-present actors', () => {
  test('ASA present and humans declared absent: zero rows for asa only', async () => {
    const z = (await zeroRows()).filter((r) => r.channel_id === CHAT && !DEGENERATE.includes(r.metric))
    assert.ok(z.length > 0)
    assert.deepEqual([...new Set(z.map((r) => r.actor_type))].sort(), ['asa'])
  })

  test('a channel with no mix row gets no zero row for an actor-typed metric', async () => {
    assert.ok((await livenessInTruth()).has(`${APP}|2026-11-18T14:30:00.000Z`), 'the app channel has traffic')
    assert.deepEqual((await zeroRows()).filter((r) => r.channel_id === APP && !DEGENERATE.includes(r.metric)), [])
  })

  test('degenerate metrics write user only, whatever the mix', async () => {
    const z = (await zeroRows()).filter((r) => ['abandoned_in_queue', 'interaction_duration'].includes(r.metric))
    assert.ok(z.length > 0)
    for (const r of z) assert.equal(r.actor_type, 'user')
  })
})

// ── Off shift ───────────────────────────────────────────────────────────────
describe('§2 · off_shift, in the per-actor drill-down', () => {
  test('an actor not on shift gives off_shift, apart from an actor on shift with no row', async () => {
    const frame = { from: '2026-09-03T10:00:00Z', to: '2026-09-03T10:05:00Z' }
    const list = await asApp(TENANT_A,
      'SELECT * FROM bob.bob_actor_cell_state($1, $2::uuid[], $3, $4)',
      [TENANT_A, [WHATSAPP], frame.from, frame.to])
    const resolved = list.filter((c) => c.metric === 'resolved' && c.actor_type === 'human')
    const off = resolved.filter((c) => c.state === 'off_shift')
    const on = resolved.filter((c) => c.state === 'not_observed')
    assert.ok(off.length > 0, 'no off_shift cell')
    assert.ok(on.length > 0, 'no on-shift not_observed cell')
    for (const c of off) assert.deepEqual([c.reasons, c.value], [['not_on_shift'], null])
    for (const c of on) assert.deepEqual([c.reasons, c.value], [['no_actor_row'], null])
    const ids = (cs) => new Set(cs.map((c) => c.actor_id))
    for (const id of ids(off)) assert.ok(!ids(on).has(id))
    const { rows: [{ live }] } = await db.query(`
      SELECT bool_or(public.bob_shift_is_live(starts_at, ends_at, status, $2)) AS live
        FROM bob.actor_shifts WHERE actor_id = ANY($1::uuid[])`, [[...ids(off)], frame.from])
    assert.equal(live, false)
    const channel = one((await cells(TENANT_A, [WHATSAPP], frame)),
      { metric: 'resolved', actor_type: 'human' })
    assert.equal(channel.state, 'not_observed')
  })
})

// ── Exactly one state per cell, in the §3 order ─────────────────────────────
// A property test over fuzzed declarations, seals, rows and probes, on one
// cell (resolved, human) of a throwaway channel. The oracle is §3 as written.
function oracle(x, bucket, watermark) {
  const missing = []
  if (x.keyUnset) missing.push('source_key_unset')
  if (x.mix === 'none') missing.push('mix_not_declared')
  if (!x.cap) missing.push('capability_not_declared:resolution')
  if (missing.length) return { state: 'not_configured', reasons: missing, value: null }
  if (x.mix === 'false') return { state: 'observed', reasons: ['actor_not_present'], value: 0 }
  if (!x.row) {
    const sealed = x.lag !== null && Date.parse(bucket) + 300_000 + x.lag * 1000 <= Date.parse(watermark)
    if (!sealed) return { state: 'pending', reasons: [x.lag === null ? 'lag_not_declared' : 'not_sealed'], value: null }
    return { state: 'not_observed', reasons: ['no_liveness'], value: null }
  }
  const reasons = []
  if (x.row.value === 0) reasons.push('none_observed')
  if (!x.row.sealed) reasons.push(x.lag === null ? 'lag_not_declared' : 'not_sealed')
  const traffic = x.row.value > 0 || x.row.session > 0
  return {
    state: 'observed', reasons, value: x.row.value, provisional: !x.row.sealed,
    liveness_source: x.probe && !traffic ? 'probe' : 'traffic',
  }
}

describe('§3 · exactly one state per cell, in order', () => {
  test('over fuzzed combinations of declarations, seals, rows and probes', async () => {
    let seed = 20261121
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 }
    const pick = (xs) => xs[Math.floor(rand() * xs.length)]
    const CH = 'aaaaaaaa-2222-4000-8000-0000000000ff'
    const failures = []
    const seen = new Set()
    for (let i = 0; i < 160; i++) {
      const x = {
        keyUnset: rand() < 0.15, mix: pick(['none', 'true', 'true', 'false']), cap: rand() < 0.8,
        lag: pick([null, 0, 3600, 3600]), probe: rand() < 0.4,
        row: rand() < 0.5 ? { value: pick([0, 0, 2]), session: pick([0, 3]), sealed: rand() < 0.6 } : null,
      }
      const bucket = pick(['2026-11-18T14:50:00.000Z', '2026-11-18T13:00:00.000Z'])
      await inTx(async () => {
        await db.query(`INSERT INTO bob.channels (id, org_id, channel_type, display_name, source_key, lag_seconds)
          VALUES ($1, $2, 'chat', 'Fuzz', $3, $4)`,
        [CH, TENANT_A, x.keyUnset ? `__unset__:${CH}` : 'tenant-a.fuzz', x.lag]);
        // The statement ends above: the capability below is drawn at random,
        // never derived from channel_type (slice2-schema's capability guard).
        if (x.mix !== 'none') {
          await db.query(`INSERT INTO bob.channel_actor_mix (org_id, channel_id, actor_type, present)
            VALUES ($1, $2, 'human', $3)`, [TENANT_A, CH, x.mix === 'true'])
        }
        if (x.cap) {
          await db.query(`INSERT INTO bob.channel_capabilities (org_id, channel_id, capability)
            VALUES ($1, $2, 'resolution')`, [TENANT_A, CH])
        }
        if (x.row) {
          await db.query(`INSERT INTO bob.proj_metric_counts (org_id, channel_id, actor_type, metric_id,
              bucket_start, event_count, session_count, sealed, source_watermark, feeder_version)
            VALUES ($1, $2, 'human', 'resolved', $3, $4, $5, $6, $7, 'fuzz')`,
          [TENANT_A, CH, bucket, x.row.value, x.row.session, x.row.sealed, WATERMARK])
        }
        if (x.probe) {
          await db.query(`INSERT INTO bob.proj_channel_health (org_id, channel_id, bucket_start,
              uptime_seconds, observed_seconds, observed, sealed, source_watermark, feeder_version)
            VALUES ($1, $2, $3, 300, 300, true, true, $4, 'fuzz')`, [TENANT_A, CH, bucket, WATERMARK])
        }
        const { rows } = await db.query(`SELECT * FROM bob.bob_cell_state($1, $2::uuid[], $3,
            $3::timestamptz + interval '5 minutes')`, [TENANT_A, [CH], bucket])
        const keys = rows.map((r) => `${r.metric}|${r.actor_type}`)
        if (new Set(keys).size !== keys.length) failures.push(`case ${i}: a cell appears twice`)
        const got = norm(rows.find((r) => r.metric === 'resolved' && r.actor_type === 'human'))
        const want = oracle(x, bucket, WATERMARK)
        seen.add(want.state)
        seen.add(want.state + (want.reasons[0] ?? ''))
        const view = { state: got.state, reasons: got.reasons, value: got.value }
        if (want.provisional !== undefined) Object.assign(view, { provisional: got.provisional, liveness_source: got.liveness_source })
        try { assert.deepEqual(view, want) } catch { failures.push(`case ${i} ${JSON.stringify(x)} ${bucket}: got ${JSON.stringify(view)}, want ${JSON.stringify(want)}`) }
      })
    }
    assert.deepEqual(failures, [])
    for (const s of ['not_configured', 'observedactor_not_present', 'pendingnot_sealed',
      'pendinglag_not_declared', 'not_observedno_liveness', 'observednone_observed']) {
      assert.ok(seen.has(s), `the fuzz never reached ${s}`)
    }
  })
})
