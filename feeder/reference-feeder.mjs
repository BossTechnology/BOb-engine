// The reference feeder. Projection contract 0.5.2 §8, written small enough to
// read in one sitting, so that the contract's obligations are exercised against
// a real database before 3.7 implements them against ClickHouse.
//
// It holds the bob_feeder credential (P5 inputs §3.1): the connection it is
// given must already be bob_feeder. It reads BOb through the two views of §7.4
// and nothing else, and writes the projections one tenant per transaction,
// under that tenant's claim (F-22).
//
// What it covers. The obligations of §8, over the event kinds in
// event-mapping.mjs: customer and business turns, ORGA labels, conversation
// closes, detections and delivery attempts. That fills proj_metric_counts,
// proj_sentiment, proj_actor_metrics, proj_detections and proj_deliveries.
// Durations, channel health and RUM need instrumentation the fixture does not
// model; the reference feeder writes none of their rows rather than invent
// zeros it did not observe (§5).

import {
  MEMBER_REF, kindOf, LABEL_STATES, LABEL_FAILURES, CLOSE_METRIC,
} from './event-mapping.mjs'

export const DEFAULT_FEEDER_VERSION = 'reference-feeder/0.1'
const BUCKET_MS = 300_000

// How far before the window the feeder reads to know a conversation's state
// (its last ORGA label, its actors) when the window cuts through it. A
// conversation longer than this is the reference feeder's limit, not the
// contract's: 3.7 keeps conversation state in the truth store.
export const DEFAULT_CONTEXT_SECONDS = 86_400

export class EventTimeConflict extends Error {}

const bucketOf = (t) => new Date(Math.floor(new Date(t).getTime() / BUCKET_MS) * BUCKET_MS)
const monthOf = (t) => {
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}
const iso = (t) => new Date(t).toISOString()

// §4: sealed only when the bucket's end plus the channel's declared lag is
// behind the watermark. NULL lag never seals (O1).
export function isSealed(bucketStart, lagSeconds, watermark) {
  if (lagSeconds === null || lagSeconds === undefined) return false
  return new Date(bucketStart).getTime() + BUCKET_MS + lagSeconds * 1000 <=
    new Date(watermark).getTime()
}

// ── What the feeder reads from BOb: exactly two views (§7.4) ────────────────
export async function readMaps(db) {
  const { rows: channels } = await db.query('SELECT * FROM bob.v_feeder_channel_map')
  const { rows: actors } = await db.query('SELECT * FROM bob.v_feeder_actor_map')
  const channelByKey = new Map(channels.map((c) => [`${c.tenant_slug}\u0000${c.source_key}`, c]))
  const actorRows = new Map()
  for (const a of actors) {
    const k = `${a.org_id}\u0000${a.ref}`
    if (!actorRows.has(k)) actorRows.set(k, [])
    actorRows.get(k).push(a)
  }
  for (const list of actorRows.values()) {
    list.sort((x, y) => (x.valid_from ?? 0) - (y.valid_from ?? 0))
  }
  return { channelByKey, actorRows }
}

// The actor a ref points to now, and the rung it had at `at` (§6.6, §9.4).
// Agent and ASA refs have no dates and the rung 'not_applicable'.
export function resolveRef(maps, orgId, ref, at) {
  const rows = maps.actorRows.get(`${orgId}\u0000${ref}`)
  if (!rows) return null
  if (rows[0].valid_from === null) {
    return { actorId: rows[0].actor_id, actorType: rows[0].actor_type, rung: 'not_applicable' }
  }
  const t = new Date(at).getTime()
  const current = rows.find((r) => r.valid_to === null)
  const then = rows.filter((r) => r.valid_from.getTime() <= t).at(-1)
  if (!current || !then) return null
  return { actorId: current.actor_id, actorType: current.actor_type, rung: then.identity_rung }
}

// ── The computation, per tenant ─────────────────────────────────────────────
function emptyTenant(orgId) {
  return {
    orgId,
    metric: new Map(), sentiment: new Map(), actor: new Map(),
    detections: [], deliveries: [],
  }
}

function bump(map, key, base, field, by = 1) {
  if (!map.has(key)) map.set(key, { ...base })
  map.get(key)[field] += by
}

// `events` may reach before the window (conversation context) and past it
// (labels that arrive after their turn); only events inside [from, to) are
// counted, and only rows inside it are kept by the caller.
//
// `boxTenant` is the box's own `bzzz.tenant` (P5 §8, objection 3: one
// organization per customer box). When it is set, an event of any other tenant
// is counted in route A and never mapped, even if BOb happens to hold a channel
// for it: a feeder that picks the wrong tenant cannot write it under the
// right-looking claim.
export function project(events, maps, watermark, { from, to, boxTenant = null }) {
  const counts = { routeA: 0, routeB: 0 }
  const lo = new Date(from).getTime(); const hi = new Date(to).getTime()
  const inWindow = (e) => { const t = new Date(e.event_time).getTime(); return t >= lo && t < hi }
  const tenants = new Map()
  const labels = new Map()   // `${org}|${turn_id}` -> label attributes
  const convs = new Map()    // `${org}|${channel}|${correlation_id}` -> conversation

  const mapped = []
  for (const e of events) {
    if (boxTenant !== null && e['bzzz.tenant'] !== boxTenant) {
      if (inWindow(e)) counts.routeA++
      continue
    }
    const ch = maps.channelByKey.get(`${e['bzzz.tenant']}\u0000${e.source_key}`)
    if (!ch) { if (inWindow(e)) counts.routeA++; continue }   // §7.2 route A
    if (!tenants.has(ch.org_id)) tenants.set(ch.org_id, emptyTenant(ch.org_id))
    mapped.push({ e, ch })
    if (kindOf(e) === 'label') labels.set(`${ch.org_id}|${e.attributes.turn_id}`, e.attributes)
  }

  for (const { e, ch } of mapped) {
    const T = tenants.get(ch.org_id)
    const kind = kindOf(e)
    const ckey = `${ch.org_id}|${ch.channel_id}|${e.correlation_id}`
    if (!convs.has(ckey)) convs.set(ckey, { actors: new Map(), lastState: null })
    const conv = convs.get(ckey)

    if (kind === 'business_turn' || kind === 'close') {
      const who = resolveRef(maps, ch.org_id, e.attributes['actor.ref'], e.event_time)
      if (!who) { if (inWindow(e)) counts.routeB++ }       // §7.2 route B, agent or ASA
      else conv.actors.set(who.actorId, who)
    }

    if (kind === 'customer_turn') {
      const member = e.attributes[MEMBER_REF]
        ? resolveRef(maps, ch.org_id, e.attributes[MEMBER_REF], e.event_time) : null
      // An unresolved member is projected without an actor row and reported in
      // neither count: the ghost reconciliation owns it (§7.2, §7.3a).
      if (member && !conv.actors.has(member.actorId)) conv.actors.set(member.actorId, member)
      if (!ch.capabilities.includes('orga_conversation')) continue
      const b = iso(bucketOf(e.event_time))
      const label = labels.get(`${ch.org_id}|${e.attributes.turn_id}`)
      const turns = `${ch.channel_id}|${b}`
      bump(T.metric, `turns|${turns}`, { channel: ch, bucket: b, n: 0, unlabeled: 0 }, 'n')
      if (label && LABEL_STATES.has(label['orga.state'])) {
        bump(T.sentiment, `${turns}|${label['orga.state']}`,
          { channel: ch, bucket: b, state: label['orga.state'], reading: 0, closing: 0 }, 'reading')
        conv.lastState = label['orga.state']
      } else if (label && LABEL_FAILURES.has(label['orga.outcome'])) {
        bump(T.metric, `${label['orga.outcome']}|${turns}`,
          { channel: ch, bucket: b, metric: label['orga.outcome'], actorType: 'user', n: 0 }, 'n')
      } else {
        T.metric.get(`turns|${turns}`).unlabeled++
      }
    }

    if (kind === 'close') {
      const b = iso(bucketOf(e.event_time))
      const metric = CLOSE_METRIC[e.attributes.outcome]
      const type = e.attributes['actor.type']
      bump(T.metric, `closes|${ch.channel_id}|${b}`, { channel: ch, bucket: b, n: 0 }, 'n')
      bump(T.metric, `${metric}|${type}|${ch.channel_id}|${b}`,
        { channel: ch, bucket: b, metric, actorType: type, n: 0 }, 'n')
      if (conv.lastState && ch.capabilities.includes('orga_conversation')) {
        bump(T.sentiment, `${ch.channel_id}|${b}|${conv.lastState}`,
          { channel: ch, bucket: b, state: conv.lastState, reading: 0, closing: 0 }, 'closing')
      }
      // A member keeps the rung it had at its turn (§6.6, D-12); agents and
      // ASAs carry 'not_applicable'. One `handled` per actor per interaction.
      const who = resolveRef(maps, ch.org_id, e.attributes['actor.ref'], e.event_time)
      for (const a of conv.actors.values()) {
        bump(T.actor, `handled|${a.actorId}|${a.rung}|${ch.channel_id}|${b}`,
          { channel: ch, bucket: b, actor: a, rung: a.rung, metric: 'handled', n: 0 }, 'n')
      }
      if (who) {
        bump(T.actor, `${metric}|${who.actorId}|${who.rung}|${ch.channel_id}|${b}`,
          { channel: ch, bucket: b, actor: who, rung: who.rung, metric, n: 0 }, 'n')
      }
    }

    if (kind === 'detection') {
      T.detections.push({
        detection_id: e.attributes.detection_id, channel_id: ch.channel_id,
        detection: e.attributes.detection, detected_at: iso(e.event_time),
        confidence: e.attributes.confidence ?? null, correlation_id: e.correlation_id,
      })
    }

    if (kind === 'delivery') {
      T.deliveries.push({
        attempt_id: e.attributes.attempt_id, outbound_id: e.attributes.outbound_id,
        correlation_id: e.correlation_id, kind: e.attributes.kind,
        provider: e.attributes.provider, attempted_at: iso(e.event_time),
        outcome: e.attributes.outcome, attempt: e.attributes.attempt ?? 1,
      })
    }
  }

  return { counts, tenants: [...tenants.values()].map((T) => rowsOf(T, watermark)) }
}

// Turn the tallies into the rows of the projections.
function rowsOf(T, watermark) {
  const sealed = (ch, b) => isSealed(b, ch.lag_seconds, watermark)
  const metricRows = []
  const closes = new Map()
  const turns = new Map()
  for (const [k, v] of T.metric) {
    if (k.startsWith('closes|')) closes.set(`${v.channel.channel_id}|${v.bucket}`, v.n)
    if (k.startsWith('turns|')) turns.set(`${v.channel.channel_id}|${v.bucket}`, v)
  }
  const failure = new Map()
  for (const [k, v] of T.metric) {
    if (k.startsWith('closes|') || k.startsWith('turns|')) continue
    const cb = `${v.channel.channel_id}|${v.bucket}`
    if (LABEL_FAILURES.has(v.metric)) { failure.set(`${cb}|${v.metric}`, v.n); continue }
    metricRows.push({ ...v, session: closes.get(cb) ?? 0 })
  }
  // §6.1, §4.1: on a channel that expects labels, every bucket with customer
  // turns carries the two observed failure counts, with the true denominator.
  // label_missing exists only at seal: before it, an unlabelled turn is lag.
  for (const [cb, t] of turns) {
    for (const m of LABEL_FAILURES) {
      metricRows.push({ channel: t.channel, bucket: t.bucket, metric: m, actorType: 'user',
        n: failure.get(`${cb}|${m}`) ?? 0, session: t.n })
    }
    if (sealed(t.channel, t.bucket)) {
      metricRows.push({ channel: t.channel, bucket: t.bucket, metric: 'label_missing',
        actorType: 'user', n: t.unlabeled, session: t.n })
    }
  }

  return {
    orgId: T.orgId,
    proj_metric_counts: metricRows.map((r) => ({
      channel_id: r.channel.channel_id, actor_type: r.actorType, metric_id: r.metric,
      bucket_start: r.bucket, event_count: r.n, session_count: r.session,
      sealed: sealed(r.channel, r.bucket),
    })),
    proj_sentiment: [...T.sentiment.values()].map((r) => ({
      channel_id: r.channel.channel_id, source: 'orga', state: r.state,
      bucket_start: r.bucket, reading_count: r.reading, closing_count: r.closing,
      sealed: sealed(r.channel, r.bucket),
    })),
    proj_actor_metrics: [...T.actor.values()].map((r) => ({
      actor_id: r.actor.actorId, actor_type: r.actor.actorType,
      channel_id: r.channel.channel_id, metric_id: r.metric,
      identity_rung_at_interaction: r.rung, bucket_start: r.bucket, event_count: r.n,
      sealed: sealed(r.channel, r.bucket),
    })),
    proj_detections: T.detections,
    proj_deliveries: T.deliveries,
  }
}

// ── Writing ─────────────────────────────────────────────────────────────────
const TIME_COLUMN = {
  proj_metric_counts: 'bucket_start', proj_sentiment: 'bucket_start',
  proj_durations: 'bucket_start', proj_channel_health: 'bucket_start',
  proj_rum_signals: 'bucket_start', proj_actor_metrics: 'bucket_start',
  proj_detections: 'detected_at', proj_deliveries: 'attempted_at',
}
const EVENT_ID = { proj_detections: 'detection_id', proj_deliveries: 'attempt_id' }

async function insertRow(db, table, row) {
  const cols = Object.keys(row)
  const params = cols.map((_, i) => `$${i + 1}`)
  await db.query(
    `INSERT INTO bob.${table} (${cols.join(', ')}) VALUES (${params.join(', ')})`,
    cols.map((c) => row[c]))
}

// §8.7: an id keeps its event time. Within the batch, and against everything
// already stored for the tenant, inside the window or not.
async function assertEventTimes(db, orgId, table, rows) {
  const id = EVENT_ID[table]; const tc = TIME_COLUMN[table]
  const seen = new Map()
  for (const r of rows) {
    if (seen.has(r[id]) && seen.get(r[id]) !== r[tc]) {
      throw new EventTimeConflict(`${table}: ${r[id]} arrives at ${seen.get(r[id])} and ${r[tc]}`)
    }
    seen.set(r[id], r[tc])
  }
  if (!rows.length) return
  const { rows: clash } = await db.query(
    `SELECT ${id} AS id, ${tc} AS at FROM bob.${table}
      WHERE org_id = $1 AND ${id} = ANY($2::text[])`, [orgId, [...seen.keys()]])
  for (const c of clash) {
    if (iso(c.at) !== seen.get(c.id)) {
      throw new EventTimeConflict(`${table}: ${c.id} is stored at ${iso(c.at)}, arrives at ${seen.get(c.id)}`)
    }
  }
}

// One tenant, one transaction, that tenant's claim (F-22). Delete the window
// and refill it (§8.5): the same code is the run, the replay and the rebuild.
async function writeTenant(db, t, { from, to, watermark, feederVersion }) {
  await db.query('BEGIN')
  try {
    await db.query('SELECT set_config($1, $2, true)',
      ['request.jwt.claims', JSON.stringify({ org_id: t.orgId })])

    // Before the delete, so a rebuild cannot move an id inside its own window.
    for (const table of Object.keys(EVENT_ID)) await assertEventTimes(db, t.orgId, table, t[table] ?? [])

    for (const table of Object.keys(TIME_COLUMN)) {
      await db.query(
        `DELETE FROM bob.${table} WHERE org_id = $1 AND ${TIME_COLUMN[table]} >= $2
            AND ${TIME_COLUMN[table]} < $3`, [t.orgId, iso(from), iso(to)])
    }

    const written = {}
    for (const table of Object.keys(TIME_COLUMN)) {
      const rows = t[table] ?? []
      const months = new Set(rows.map((r) => monthOf(r[TIME_COLUMN[table]])))
      for (const m of months) {
        await db.query('SELECT bob.proj_ensure_partition($1::regclass, $2::date)', [`bob.${table}`, m])
      }
      for (const r of rows) {
        await insertRow(db, table, {
          org_id: t.orgId, ...r,
          source_watermark: iso(watermark), feeder_version: feederVersion,
        })
      }
      written[table] = rows.length
    }
    await db.query('COMMIT')
    return written
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  }
}

// Run (or rebuild) the window [from, to) for every tenant, or for `orgIds`.
// In a customer box it runs with `boxTenant`, the box's `bzzz.tenant`.
// Returns the two counts of §8.6, never one sum, and what it wrote.
export async function runFeeder(db, truth, {
  from, to, orgIds = null, feederVersion = DEFAULT_FEEDER_VERSION,
  contextSeconds = DEFAULT_CONTEXT_SECONDS, boxTenant = null,
} = {}) {
  for (const t of [from, to]) {
    if (new Date(t).getTime() % BUCKET_MS !== 0) {
      throw new Error(`window bound ${iso(t)} is not on a five-minute boundary`)
    }
  }
  const maps = await readMaps(db)
  const watermark = truth.watermark()
  const readFrom = new Date(new Date(from).getTime() - contextSeconds * 1000)
  const readTo = new Date(Math.max(new Date(to).getTime(), watermark.getTime()))
  const { counts, tenants } = project(truth.events({ from: readFrom, to: readTo }), maps,
    watermark, { from, to, boxTenant })
  const lo = new Date(from).getTime(); const hi = new Date(to).getTime()
  for (const t of tenants) {
    for (const table of Object.keys(TIME_COLUMN)) {
      if (!t[table]) continue
      t[table] = t[table].filter((r) => {
        const at = new Date(r[TIME_COLUMN[table]]).getTime()
        return at >= lo && at < hi
      })
    }
  }

  const written = {}
  for (const t of tenants) {
    if (orgIds && !orgIds.includes(t.orgId)) continue
    written[t.orgId] = await writeTenant(db, t, { from, to, watermark, feederVersion })
  }
  // A tenant with nothing in the window still has its window cleared on a
  // rebuild, so a removed fact does not survive it.
  for (const orgId of orgIds ?? []) {
    if (!written[orgId]) {
      written[orgId] = await writeTenant(db, { orgId }, { from, to, watermark, feederVersion })
    }
  }
  return { unmappedEvents: counts.routeA, unresolvedAgentRefs: counts.routeB, watermark, written }
}
