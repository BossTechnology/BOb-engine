// The ghost reconciliation. Projection contract 0.5.2 §7.2 and §7.3a, as
// amended by F-41 (P5 Q6 (a), Henry, 2026-11-21).
//
// It runs as bob_app, one tenant per transaction under that tenant's claim, in
// the BOb container. It reads no truth store: the feeder container asks
// ClickHouse for member_refs_seen and stages what it sees in
// bob.member_refs_seen (feeder/reference-feeder.mjs, stageMemberRefs). Here
// the staged rows inside a trailing window are consumed (deleted, in the same
// transaction), the refs BOb already knows are subtracted, and a ghost is
// created for each one left: a `user` actor at rung `ghost`, its ref, and the
// first row of its linkage history. It never creates any other kind of actor,
// and keeps no cursor (H3). If the transaction fails, the rows it consumed are
// still staged for the next run.
//
// Its scheduler hands it the tenant, { orgId }: one organization per box (P5
// objection 3). bob_app cannot enumerate organizations under RLS, which is
// right for a tenant-scoped credential; the finding is recorded in
// contract-amendments.md (F-26).

import { createHash } from 'node:crypto'

export const RETENTION_DAYS = 395   // C-14

// A display id for a ghost. Derived from the ref, so the same ref always gets
// the same id, and nothing about the person is in it (§5.1 of the data model).
export function ghostDisplayId(orgId, ref) {
  return 'GH-' + createHash('sha256').update(`${orgId}\u0000${ref}`).digest('hex').slice(0, 12).toUpperCase()
}

async function withTenant(db, orgId, fn) {
  await db.query('BEGIN')
  try {
    await db.query('SELECT set_config($1, $2, true)',
      ['request.jwt.claims', JSON.stringify({ org_id: orgId })])
    const out = await fn()
    await db.query('COMMIT')
    return out
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  }
}

// [now − (interval + L), now], L the tenant's largest declared lag (H3).
export function trailingWindow(now, intervalSeconds, largestLagSeconds) {
  const to = new Date(now)
  return { from: new Date(to.getTime() - (intervalSeconds + largestLagSeconds) * 1000), to }
}

// Never reach past retention (C-14): a ref last seen before it is gone from
// the truth store, and a ghost for it would have nothing to project.
function clampToRetention(window, now) {
  const floor = new Date(new Date(now).getTime() - RETENTION_DAYS * 86_400_000)
  return { from: window.from < floor ? floor : window.from, to: window.to }
}

async function reconcileWindow(db, { orgId }, now, windowOf, { expire = false } = {}) {
  if (!orgId) throw new Error('reconcile needs the tenant: { orgId }')
  return withTenant(db, orgId, async () => {
    const { rows: channels } = await db.query(
      `SELECT lag_seconds FROM bob.channels
        WHERE org_id = $1 AND source_key IS NOT NULL`, [orgId])
    if (!channels.length) return { created: [], window: null, expired: 0 }
    const largestLag = Math.max(0, ...channels.map((c) => c.lag_seconds ?? 0))
    const window = clampToRetention(windowOf(largestLag), now)

    // Past retention: removed, never reconciled. Only the sweep does this, so
    // the frequent run touches nothing outside its window.
    let expired = 0
    if (expire) {
      ({ rowCount: expired } = await db.query(
        'DELETE FROM bob.member_refs_seen WHERE org_id = $1 AND last_seen < $2',
        [orgId, window.from]))
    }

    // Consumed: every staged row of the tenant seen inside the window. A
    // concurrent run waits on these rows and then finds them gone.
    const { rows: staged } = await db.query(
      `DELETE FROM bob.member_refs_seen
        WHERE org_id = $1 AND last_seen >= $2 AND first_seen <= $3
       RETURNING ref, first_seen`, [orgId, window.from, window.to])
    if (!staged.length) return { created: [], window, expired }

    const firstSeen = new Map()
    for (const s of staged) {
      const t = new Date(s.first_seen)
      if (!firstSeen.has(s.ref) || t < firstSeen.get(s.ref)) firstSeen.set(s.ref, t)
    }
    const seen = [...firstSeen.keys()].sort()

    const { rows: known } = await db.query(
      'SELECT ref FROM bob.actor_external_refs WHERE org_id = $1 AND ref = ANY($2::text[])',
      [orgId, seen])
    const knownRefs = new Set(known.map((k) => k.ref))

    const created = []
    for (const ref of seen) {
      if (knownRefs.has(ref)) continue
      const { rows: [actor] } = await db.query(
        `INSERT INTO bob.actors (org_id, actor_type, display_id, identity_rung)
         VALUES ($1, 'user', $2, 'ghost') RETURNING id`,
        [orgId, ghostDisplayId(orgId, ref)])
      // Idempotent on (org_id, ref): a concurrent run that got there first wins.
      const { rowCount } = await db.query(
        `INSERT INTO bob.actor_external_refs (org_id, actor_id, ref) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, ref) DO NOTHING`, [orgId, actor.id, ref])
      if (!rowCount) { await db.query('DELETE FROM bob.actors WHERE id = $1', [actor.id]); continue }
      await db.query(
        `INSERT INTO bob.actor_ref_history (org_id, ref, actor_id, identity_rung, valid_from)
         VALUES ($1, $2, $3, 'ghost', $4)`, [orgId, ref, actor.id, firstSeen.get(ref)])
      created.push({ ref, actorId: actor.id, firstSeen: firstSeen.get(ref) })
    }
    return { created, window, expired }
  })
}

// Ghost creation is a linkage event (§7.2): it returns the window to rebuild,
// [earliest first_seen among the new ghosts, now), or null when it made none.
function rebuildWindow(created, now) {
  if (!created.length) return null
  const earliest = Math.min(...created.map((c) => new Date(c.firstSeen).getTime()))
  return { from: new Date(Math.floor(earliest / 300_000) * 300_000), to: new Date(now) }
}

export async function reconcileGhosts(db, tenant, { now, intervalSeconds }) {
  const { created, window } = await reconcileWindow(db, tenant, now,
    (lag) => trailingWindow(now, intervalSeconds, lag))
  return { created, window, rebuild: rebuildWindow(created, now) }
}

// The slower sweep over the whole retention window (H3). It also removes the
// staged rows that fell out of retention before anything consumed them.
export async function sweepGhosts(db, tenant, { now }) {
  const to = new Date(now)
  const from = new Date(to.getTime() - RETENTION_DAYS * 86_400_000)
  const { created, window, expired } = await reconcileWindow(db, tenant, now,
    () => ({ from, to }), { expire: true })
  return { created, window, expired, rebuild: rebuildWindow(created, now) }
}

// A linkage (D-12): the ref now points at another member, from `at`. Appends
// to the history and repoints the ref; never rewrites the past. Returns the
// window to rebuild. Runs as bob_app under the tenant's claim.
export async function linkMemberRef(db, { orgId, ref, actorId, rung, at, now }) {
  return withTenant(db, orgId, async () => {
    await db.query(
      `INSERT INTO bob.actor_ref_history (org_id, ref, actor_id, identity_rung, valid_from)
       VALUES ($1, $2, $3, $4, $5)`, [orgId, ref, actorId, rung, at])
    await db.query(
      'UPDATE bob.actor_external_refs SET actor_id = $3 WHERE org_id = $1 AND ref = $2',
      [orgId, ref, actorId])
    const { rows: [first] } = await db.query(
      'SELECT min(valid_from) AS t FROM bob.actor_ref_history WHERE org_id = $1 AND ref = $2',
      [orgId, ref])
    const t = new Date(first.t).getTime()
    return { from: new Date(Math.floor(t / 300_000) * 300_000), to: new Date(now) }
  })
}
