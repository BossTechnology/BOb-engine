// Slice 2 · the reference feeder and the ghost reconciliation, against
// projection contract 0.5.2 §7, §8 and §10.
//
// The §10 guards that need rows the feeder wrote. Each was seen failing on
// purpose before it was trusted; the table is in contract-amendments.md,
// "Slice 2 · The reference feeder, built".
//
// The feeder runs as bob_feeder and the reconciliation as bob_app, each on its
// own connection, against the in-memory truth store and its event fixture.
// Unlike the schema suite these runs commit: the feeder owns its transactions
// (one per tenant, F-22). Every describe starts from a freshly loaded world.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  connect, connectAs, loadFixture, loadRoster, loadFeederWorld, asTenant,
  REPO_ROOT, TENANT_A, TENANT_B,
} from './helpers/db.mjs'
import { MemoryTruthStore } from '../feeder/memory-truth-store.mjs'
import { runFeeder, EventTimeConflict } from '../feeder/reference-feeder.mjs'
import { reconcileGhosts, linkMemberRef } from '../reconciliation/ghosts.mjs'

const FIXTURE = JSON.parse(readFileSync(
  resolve(REPO_ROOT, 'supabase/tests/fixtures/feeder_events.json'), 'utf8'))
const FROM = '2026-11-18T14:00:00Z'
const TO = '2026-11-18T14:30:00Z'
const NOW = TO
const WHATSAPP_A = 'aaaaaaaa-2222-4000-8000-000000000001'
const WEBSITE_A = 'aaaaaaaa-2222-4000-8000-00000000000b'
const VOICE_A = 'aaaaaaaa-2222-4000-8000-00000000000a'
const CHAT_B = 'bbbbbbbb-2222-4000-8000-00000000000c'
const TENANTS = [TENANT_A, TENANT_B]

let db, feeder, app

async function freshWorld() {
  await loadFixture(db)
  await loadRoster(db)
  await loadFeederWorld(db)
}

before(async () => {
  db = await connect()
  await freshWorld()
  // The two credentials, held by the migration owner for this file only.
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

const truth = (extra = []) =>
  new MemoryTruthStore({ events: [...FIXTURE.events, ...extra], watermark: FIXTURE.watermark })

const event = (at, source_key, correlation_id, event_name, attributes, tenant = 'tenant-a') =>
  ({ event_time: at, 'bzzz.tenant': tenant, source_key, correlation_id, event_name, attributes })

// The projection tables, found: every partitioned table in `bob` named proj_*.
async function projections() {
  const { rows } = await db.query(`
    SELECT c.relname AS name,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                     AND a.attname = 'sealed' AND NOT a.attisdropped) AS bucketed
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'bob' AND c.relkind = 'p' AND c.relname LIKE 'proj\\_%'
     ORDER BY 1`)
  assert.equal(rows.length, 8, 'the eight projections were not found')
  return rows
}

async function clearProjections() {
  for (const p of await projections()) {
    await db.query(`DELETE FROM bob.${p.name} WHERE org_id = ANY($1::uuid[])`, [TENANTS])
  }
}

// Everything the feeder wrote, minus computed_at, in a stable order: what the
// application would render from.
async function snapshot() {
  const out = {}
  for (const p of await projections()) {
    const { rows } = await db.query(
      `SELECT to_jsonb(t) - 'computed_at' AS r FROM bob.${p.name} t
        WHERE org_id = ANY($1::uuid[]) ORDER BY (to_jsonb(t) - 'computed_at')::text`, [TENANTS])
    out[p.name] = rows.map((x) => x.r)
  }
  return out
}

const metric = async (channel, bucket, id) => (await db.query(
  `SELECT event_count, session_count, sealed FROM bob.proj_metric_counts
    WHERE channel_id = $1 AND bucket_start = $2 AND metric_id = $3`,
  [channel, bucket, id])).rows[0]

const reading = async (channel, bucket, state) => (await db.query(
  `SELECT reading_count, closing_count FROM bob.proj_sentiment
    WHERE channel_id = $1 AND bucket_start = $2 AND state = $3`,
  [channel, bucket, state])).rows[0]

// ── §8.6 · the two counts ──────────────────────────────────────────────────
describe('§8.6 · unmapped by route', () => {
  before(freshWorld)

  test('both counts are zero against the fixture, member refs included', async () => {
    const r = await runFeeder(feeder, truth(), { from: FROM, to: TO })
    assert.deepEqual([r.unmappedEvents, r.unresolvedAgentRefs], [0, 0])
    // Non-vacuous: the fixture does carry member refs with no actor.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM bob.actor_external_refs WHERE ref = ANY($1)`,
      [['m:a002', 'm:a003']])
    assert.equal(rows[0].n, 0)
  })

  test('an unmappable event moves route A only', async () => {
    const r = await runFeeder(feeder, truth([
      event('2026-11-18T14:02:30Z', 'tenant-a.fax', 'cx', 'turn',
        { side: 'business', 'actor.ref': 'tenant-a.whatsapp:2001', 'actor.type': 'human' }),
    ]), { from: FROM, to: TO })
    assert.deepEqual([r.unmappedEvents, r.unresolvedAgentRefs], [1, 0])
  })

  test('an agent ref with no actor moves route B only', async () => {
    const r = await runFeeder(feeder, truth([
      event('2026-11-18T14:02:30Z', 'tenant-a.whatsapp', 'c1', 'turn',
        { side: 'business', 'actor.ref': 'tenant-a.whatsapp:9999', 'actor.type': 'human' }),
    ]), { from: FROM, to: TO })
    assert.deepEqual([r.unmappedEvents, r.unresolvedAgentRefs], [0, 1])
  })

  test('a member ref with no actor moves neither', async () => {
    const r = await runFeeder(feeder, truth([
      event('2026-11-18T14:02:30Z', 'tenant-a.whatsapp', 'c9', 'turn',
        { side: 'customer', turn_id: 't99', 'miembro.id': 'm:a999' }),
    ]), { from: FROM, to: TO })
    assert.deepEqual([r.unmappedEvents, r.unresolvedAgentRefs], [0, 0])
  })
})

// ── §4, §8.3 · sealed at write time ─────────────────────────────────────────
describe('§4 · sealed at write time', () => {
  before(async () => {
    await freshWorld()
    await runFeeder(feeder, truth(), { from: FROM, to: TO })
  })

  // The rule of §4 written again in SQL, apart from the feeder's own isSealed:
  // a guard that asked the feeder whether the feeder was right would pass any
  // rule the feeder chose.
  test('every bucketed row is sealed exactly when its channel lag and watermark say', async () => {
    let sealed = 0, open = 0
    for (const p of (await projections()).filter((x) => x.bucketed)) {
      const { rows } = await db.query(
        `SELECT t.sealed, coalesce(t.bucket_start + interval '5 minutes'
                  + c.lag_seconds * interval '1 second' <= t.source_watermark, false) AS rule,
                c.id AS channel, t.bucket_start
           FROM bob.${p.name} t JOIN bob.channels c ON c.id = t.channel_id
          WHERE t.org_id = ANY($1::uuid[])`, [TENANTS])
      for (const r of rows) {
        assert.equal(r.sealed, r.rule, `${p.name} ${r.channel} ${r.bucket_start.toISOString()}`)
        if (r.sealed) sealed++; else open++
      }
    }
    assert.ok(sealed > 0 && open > 0, `sealed ${sealed}, open ${open}: the guard needs both`)
  })

  test('every row carries the watermark and the feeder version it was written with', async () => {
    for (const p of await projections()) {
      const { rows } = await db.query(
        `SELECT DISTINCT source_watermark, feeder_version FROM bob.${p.name}
          WHERE org_id = ANY($1::uuid[])`, [TENANTS])
      for (const r of rows) {
        assert.equal(r.source_watermark.toISOString(), new Date(FIXTURE.watermark).toISOString())
        assert.match(r.feeder_version, /^reference-feeder\//)
      }
    }
  })

  test('a replay changes nothing but computed_at', async () => {
    const first = await snapshot()
    await runFeeder(feeder, truth(), { from: FROM, to: TO })
    assert.deepEqual(await snapshot(), first)
  })

  test('a window off the five-minute grain is refused', async () => {
    await assert.rejects(runFeeder(feeder, truth(), { from: '2026-11-18T14:03:00Z', to: TO }),
      /five-minute boundary/)
  })
})

// ── §4.1 · every turn accounted at seal ─────────────────────────────────────
async function accountingFindings() {
  const { rows } = await db.query(`
    WITH orga AS (
      SELECT channel_id FROM bob.channel_capabilities WHERE capability = 'orga_conversation'),
    m AS (
      SELECT channel_id, bucket_start,
             sum(event_count) FILTER (WHERE metric_id IN ('abstained','classifier_down','label_missing')) AS failed,
             max(session_count) FILTER (WHERE metric_id = 'label_missing') AS denominator
        FROM bob.proj_metric_counts
       WHERE sealed AND org_id = ANY($1::uuid[]) AND channel_id IN (SELECT channel_id FROM orga)
       GROUP BY 1, 2),
    s AS (
      SELECT channel_id, bucket_start, sum(reading_count) AS read
        FROM bob.proj_sentiment WHERE source = 'orga' GROUP BY 1, 2)
    SELECT m.channel_id, m.bucket_start, m.failed, coalesce(s.read, 0) AS read, m.denominator
      FROM m LEFT JOIN s USING (channel_id, bucket_start)`, [TENANTS])
  return rows
}

describe('§4.1 · every turn accounted at seal', () => {
  before(async () => {
    await freshWorld()
    await runFeeder(feeder, truth(), { from: FROM, to: TO })
  })

  test('states, abstained, classifier_down and label_missing add up to the denominator', async () => {
    const rows = await accountingFindings()
    assert.ok(rows.length >= 3, 'the guard needs sealed ORGA buckets to look at')
    for (const r of rows) {
      assert.ok(r.denominator !== null, `${r.channel_id} ${r.bucket_start.toISOString()}: no label_missing row at seal`)
      assert.equal(Number(r.read) + Number(r.failed), Number(r.denominator),
        `${r.channel_id} ${r.bucket_start.toISOString()}`)
    }
  })

  test('label_missing exists only at seal', async () => {
    const { rows } = await db.query(
      `SELECT channel_id, bucket_start, sealed FROM bob.proj_metric_counts
        WHERE metric_id = 'label_missing' AND org_id = ANY($1::uuid[])`, [TENANTS])
    assert.ok(rows.length > 0)
    for (const r of rows) assert.ok(r.sealed, JSON.stringify(r))
  })

  // Both sides of the capability, each in a sealed bucket with an unlabelled
  // customer turn: WhatsApp declares orga_conversation and writes the row;
  // voice does not, and writes nothing (§4.1, contract 0.5.3).
  test('label_missing on a channel with orga_conversation, never on one without', async () => {
    const { rows: c } = await db.query(
      `SELECT c.id AS channel_id, c.lag_seconds,
              EXISTS (SELECT 1 FROM bob.channel_capabilities cc WHERE cc.channel_id = c.id
                        AND cc.capability = 'orga_conversation') AS orga
         FROM bob.channels c WHERE c.id = ANY($1::uuid[])`, [[WHATSAPP_A, VOICE_A]])
    const ch = Object.fromEntries(c.map((r) => [r.channel_id, r]))
    assert.equal(ch[WHATSAPP_A].orga, true)
    assert.equal(ch[VOICE_A].orga, false)

    // With it: t4, unlabelled, in a sealed bucket.
    const withIt = await metric(WHATSAPP_A, '2026-11-18T14:05:00Z', 'label_missing')
    assert.ok(withIt?.sealed, 'WhatsApp 14:05 is sealed')
    assert.equal(Number(withIt.event_count), 1)

    // Without it: t9, unlabelled, in a bucket its 900 s lag has already sealed.
    const sealable = new Date('2026-11-18T14:05:00Z').getTime() + ch[VOICE_A].lag_seconds * 1000 <=
      new Date(FIXTURE.watermark).getTime()
    assert.ok(sealable, 'voice 14:00 is behind its lag, so only the capability can keep it out')
    const { rows: voice } = await db.query(
      `SELECT metric_id FROM bob.proj_metric_counts
        WHERE channel_id = $1 AND bucket_start = '2026-11-18 14:00:00+00'`, [VOICE_A])
    assert.deepEqual(voice, [])
  })

  // No label accounting at all, not even zeros, on a channel that does not
  // declare orga_conversation: there it is "not configured", never "zero" (§5).
  test('no label accounting on a channel that does not expect labels', async () => {
    const { rows } = await db.query(`
      SELECT 'metric' AS kind, channel_id, metric_id AS what FROM bob.proj_metric_counts
       WHERE metric_id IN ('abstained','classifier_down','label_missing')
         AND org_id = ANY($1::uuid[])
      UNION ALL
      SELECT 'sentiment', channel_id, state FROM bob.proj_sentiment
       WHERE source = 'orga' AND org_id = ANY($1::uuid[])`, [TENANTS])
    const { rows: orga } = await db.query(
      `SELECT channel_id FROM bob.channel_capabilities WHERE capability = 'orga_conversation'`)
    const expected = new Set(orga.map((o) => o.channel_id))
    assert.ok(rows.length > 0)
    assert.deepEqual(rows.filter((r) => !expected.has(r.channel_id)), [])
  })

  test('the withheld label lands in label_missing, and moves to its state on a rebuild', async () => {
    const bucket = '2026-11-18T14:05:00Z'
    assert.equal(Number((await metric(WHATSAPP_A, bucket, 'label_missing')).event_count), 1)
    assert.equal(await reading(WHATSAPP_A, bucket, 's2'), undefined)

    const late = truth([event('2026-11-18T14:06:30Z', 'tenant-a.whatsapp', 'c1', 'orga_label',
      { turn_id: 't4', 'orga.state': 's2' })])
    await runFeeder(feeder, late, { from: bucket, to: '2026-11-18T14:10:00Z', orgIds: [TENANT_A] })

    assert.equal(Number((await metric(WHATSAPP_A, bucket, 'label_missing')).event_count), 0)
    assert.equal(Number((await reading(WHATSAPP_A, bucket, 's2')).reading_count), 1)
    for (const r of await accountingFindings()) {
      assert.equal(Number(r.read) + Number(r.failed), Number(r.denominator))
    }
  })
})

// ── §4, §9.2 · lag not declared ─────────────────────────────────────────────
describe('§4 · lag not declared', () => {
  before(async () => {
    await freshWorld()
    await runFeeder(feeder, truth(), { from: FROM, to: TO })
  })

  test('the website writes rows and none of them is sealed', async () => {
    let n = 0
    for (const p of (await projections()).filter((x) => x.bucketed)) {
      const { rows } = await db.query(
        `SELECT sealed FROM bob.${p.name} WHERE channel_id = $1`, [WEBSITE_A])
      n += rows.length
      for (const r of rows) assert.equal(r.sealed, false, p.name)
    }
    assert.ok(n > 0, 'the website wrote nothing, so the guard proved nothing')
  })

  test('the declaration report names the channel, per tenant', async () => {
    const a = await asTenant(db, TENANT_A, async () =>
      (await db.query('SELECT * FROM bob.v_channel_declaration_gaps')).rows)
    assert.deepEqual(a.map((r) => [r.channel_id, r.lag_not_declared]), [[WEBSITE_A, true]])
    const b = await asTenant(db, TENANT_B, async () =>
      (await db.query('SELECT * FROM bob.v_channel_declaration_gaps')).rows)
    assert.deepEqual(b.map((r) => [r.channel_id, r.lag_below_idle_bound]), [[CHAT_B, true]])
  })
})

// ── §7.2, §7.3a · the ghost path ────────────────────────────────────────────
// The reconciliation sees the truth store through member_refs_seen and nothing
// else: anything else it touched would throw.
function onlyMemberRefsSeen(store) {
  let calls = 0
  return {
    get calls() { return calls },
    memberRefsSeen(frame, page) { calls++; return store.memberRefsSeen(frame, page) },
  }
}

const actorCounts = async () => (await db.query(
  `SELECT actor_type, identity_rung, count(*)::int AS n FROM bob.actors
    WHERE org_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`, [TENANT_A])).rows

describe('§7.2 · the ghost path', () => {
  before(freshWorld)

  test('member refs only, all at rung ghost, never a non-user actor', async () => {
    const store = truth([
      event('2026-11-18T14:09:00Z', 'tenant-a.whatsapp', 'c1', 'turn',
        { side: 'business', 'actor.ref': 'tenant-a.whatsapp:9999', 'actor.type': 'human' }),
      event('2026-11-18T14:09:30Z', 'tenant-a.web', 'c3', 'turn',
        { side: 'business', 'actor.ref': 'botplatform:web-99', 'actor.type': 'asa' }),
    ])
    const before = await actorCounts()
    const seen = onlyMemberRefsSeen(store)
    const r = await reconcileGhosts(app, seen, { orgId: TENANT_A, tenantSlug: 'tenant-a' },
      { now: NOW, intervalSeconds: 1800 })

    assert.ok(seen.calls > 0)
    assert.deepEqual(r.created.map((c) => c.ref).sort(), ['m:a002', 'm:a003'])
    const after = await actorCounts()
    const added = after.map((a) => {
      const b = before.find((x) => x.actor_type === a.actor_type && x.identity_rung === a.identity_rung)
      return { ...a, n: a.n - (b?.n ?? 0) }
    }).filter((a) => a.n !== 0)
    assert.deepEqual(added, [{ actor_type: 'user', identity_rung: 'ghost', n: 2 }])
    const { rows: hist } = await db.query(
      `SELECT ref, identity_rung, valid_from FROM bob.actor_ref_history
        WHERE org_id = $1 AND ref = ANY($2) ORDER BY ref`, [TENANT_A, ['m:a002', 'm:a003']])
    assert.deepEqual(hist.map((h) => [h.ref, h.identity_rung, h.valid_from.toISOString()]), [
      ['m:a002', 'ghost', '2026-11-18T14:11:00.000Z'],
      ['m:a003', 'ghost', '2026-11-18T14:21:00.000Z'],
    ])
  })

  test('the window trails by interval plus the largest declared lag (H3)', async () => {
    // A ref seen 40 minutes before now: inside 30 min + voice's 15, outside 30 alone.
    const store = truth([event('2026-11-18T13:50:00Z', 'tenant-a.voice', 'c8', 'turn',
      { side: 'customer', turn_id: 't80', 'miembro.id': 'm:a050' })])
    const r = await reconcileGhosts(app, onlyMemberRefsSeen(store),
      { orgId: TENANT_A, tenantSlug: 'tenant-a' }, { now: NOW, intervalSeconds: 1800 })
    assert.equal(r.window.from.toISOString(), '2026-11-18T13:45:00.000Z')
    assert.deepEqual(r.created.map((c) => c.ref), ['m:a050'])
  })

  test('a second run creates nothing', async () => {
    const r = await reconcileGhosts(app, onlyMemberRefsSeen(truth()),
      { orgId: TENANT_A, tenantSlug: 'tenant-a' }, { now: NOW, intervalSeconds: 1800 })
    assert.deepEqual(r.created, [])
  })

  test('the rebuild it triggers projects the ghosts at rung ghost', async () => {
    await runFeeder(feeder, truth(), { from: FROM, to: TO })
    const { rows } = await db.query(`
      SELECT r.ref, m.identity_rung_at_interaction AS rung
        FROM bob.proj_actor_metrics m
        JOIN bob.actor_external_refs r ON r.actor_id = m.actor_id
       WHERE r.ref = ANY($1) AND m.metric_id = 'handled' ORDER BY 1`, [['m:a002', 'm:a003']])
    assert.deepEqual(rows, [{ ref: 'm:a002', rung: 'ghost' }, { ref: 'm:a003', rung: 'ghost' }])
  })
})

// ── §8.5 · rebuild with linkage ─────────────────────────────────────────────
describe('§8.5 · rebuild with linkage', () => {
  let identified

  before(async () => {
    await freshWorld()
    await reconcileGhosts(app, onlyMemberRefsSeen(truth()),
      { orgId: TENANT_A, tenantSlug: 'tenant-a' }, { now: NOW, intervalSeconds: 1800 })
    await runFeeder(feeder, truth(), { from: FROM, to: TO })
    identified = (await db.query(
      `INSERT INTO bob.actors (org_id, actor_type, display_id, display_name, identity_rung)
       VALUES ($1, 'user', 'MBR-A002', 'Cliente Demo Dos', 'identified') RETURNING id`,
      [TENANT_A])).rows[0].id
    const window = await linkMemberRef(app, {
      orgId: TENANT_A, ref: 'm:a002', actorId: identified, rung: 'identified',
      at: '2026-11-18T14:20:00Z', now: NOW,
    })
    await runFeeder(feeder, truth(), { ...window, orgIds: [TENANT_A] })
  })

  test('the rung stays as it was at event time, beside the actor the ref now points to', async () => {
    const { rows } = await db.query(`
      SELECT actor_id, identity_rung_at_interaction AS rung FROM bob.proj_actor_metrics
       WHERE channel_id = $1 AND bucket_start = '2026-11-18 14:10:00+00' AND actor_type = 'user'`,
      [WHATSAPP_A])
    assert.deepEqual(rows, [{ actor_id: identified, rung: 'ghost' }])
  })

  test('the render is identical to a full rebuild', async () => {
    const incremental = await snapshot()
    await clearProjections()
    await runFeeder(feeder, truth(), { from: FROM, to: TO })
    assert.deepEqual(await snapshot(), incremental)
  })
})

// ── §8.7 · event time is immutable ──────────────────────────────────────────
describe('§8.7 · event time is immutable, over the feeder output', () => {
  before(async () => {
    await freshWorld()
    await runFeeder(feeder, truth(), { from: FROM, to: TO })
  })

  test('no id appears with two times', async () => {
    for (const [table, id, at] of [['proj_detections', 'detection_id', 'detected_at'],
      ['proj_deliveries', 'attempt_id', 'attempted_at']]) {
      const { rows: [{ n }] } = await db.query(`SELECT count(*)::int AS n FROM bob.${table}`)
      assert.ok(n > 0, `${table}: nothing written, nothing proved`)
      const { rows } = await db.query(
        `SELECT org_id, ${id} FROM bob.${table} GROUP BY 1, 2 HAVING count(DISTINCT ${at}) > 1`)
      assert.deepEqual(rows, [], table)
    }
  })

  test('an id that comes back with another time is refused, and nothing is written', async () => {
    const first = await snapshot()
    const moved = new MemoryTruthStore({
      watermark: FIXTURE.watermark,
      events: FIXTURE.events.map((e) => e.attributes.detection_id === 'det-1'
        ? { ...e, event_time: '2026-11-18T14:17:00Z' } : e),
    })
    await assert.rejects(runFeeder(feeder, moved, { from: FROM, to: TO }), EventTimeConflict)
    assert.deepEqual(await snapshot(), first)
  })
})

// ── F-22 · one tenant per transaction, under its claim ──────────────────────
describe('F-22 · the feeder writes each tenant under its own claim', () => {
  before(freshWorld)

  test('every insert runs under the claim of the tenant it writes', async () => {
    let claim = null
    const seen = new Set()
    const watched = {
      query(sql, params) {
        if (/set_config/.test(sql) && params?.[0] === 'request.jwt.claims') {
          claim = JSON.parse(params[1]).org_id
        }
        if (/^(COMMIT|ROLLBACK)/.test(sql)) claim = null
        if (/^\s*INSERT INTO bob\.proj_/.test(sql)) {
          assert.equal(params[0], claim, sql)
          seen.add(claim)
        }
        return feeder.query(sql, params)
      },
    }
    await runFeeder(watched, truth(), { from: FROM, to: TO })
    assert.deepEqual([...seen].sort(), [TENANT_A, TENANT_B])
  })

  test('every row the feeder wrote belongs to its channel tenant', async () => {
    for (const p of (await projections()).filter((x) => x.bucketed)) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM bob.${p.name} t JOIN bob.channels c ON c.id = t.channel_id
          WHERE t.org_id <> c.org_id`)
      assert.equal(rows[0].n, 0, p.name)
    }
    const { rows } = await db.query(
      `SELECT DISTINCT org_id FROM bob.proj_metric_counts ORDER BY 1`)
    assert.deepEqual(rows.map((r) => r.org_id), [TENANT_A, TENANT_B])
  })
})

// ── P5 §8, objection 3 · one organization per customer box ─────────────────
// In a customer box the feeder runs for the box's own tenant. An event of any
// other tenant is route A and is never written, even when BOb holds a channel
// for it: that is what catches a feeder that picks the wrong tenant, since a
// self-set claim cannot (the claim and the row would be wrong together).
describe('P5 objection 3 · the feeder sends a foreign tenant to route A', () => {
  before(freshWorld)

  // Counted from the fixture, not from the feeder.
  const inWindow = (e) => e.event_time >= FROM && e.event_time < TO
  const foreign = FIXTURE.events.filter((e) => e['bzzz.tenant'] !== 'tenant-a' && inWindow(e))

  const rowsFor = async (orgId) => {
    let n = 0
    for (const p of await projections()) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM bob.${p.name} WHERE org_id = $1`, [orgId])
      n += rows[0].n
    }
    return n
  }

  test('without a box tenant, tenant B maps and writes (the guard is not vacuous)', async () => {
    assert.ok(foreign.length > 0, 'the fixture has no event of another tenant')
    await clearProjections()
    const r = await runFeeder(feeder, truth(), { from: FROM, to: TO })
    assert.equal(r.unmappedEvents, 0)
    assert.ok(await rowsFor(TENANT_B) > 0, 'tenant B wrote nothing, so nothing is proved')
  })

  test('boxed to tenant A: every tenant B event is route A, and nothing of B is written', async () => {
    await clearProjections()
    await runFeeder(feeder, truth(), { from: FROM, to: TO, orgIds: [TENANT_A] })
    const expected = await snapshot()
    await clearProjections()
    const r = await runFeeder(feeder, truth(), { from: FROM, to: TO, boxTenant: 'tenant-a' })
    assert.deepEqual([r.unmappedEvents, r.unresolvedAgentRefs], [foreign.length, 0])
    assert.deepEqual(Object.keys(r.written), [TENANT_A])
    assert.equal(await rowsFor(TENANT_B), 0, 'a foreign tenant was written')
    assert.deepEqual(await snapshot(), expected, 'the box tenant is written as it would be alone')
  })

  test('boxed to a tenant BOb does not hold: everything is route A, nothing is written', async () => {
    await clearProjections()
    const r = await runFeeder(feeder, truth(), { from: FROM, to: TO, boxTenant: 'tenant-z' })
    assert.equal(r.unmappedEvents, FIXTURE.events.filter(inWindow).length)
    assert.deepEqual(r.written, {})
    assert.equal(await rowsFor(TENANT_A) + await rowsFor(TENANT_B), 0)
  })
})
