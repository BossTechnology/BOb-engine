// The ghost reconciliation. Projection contract 0.5.2 §7.2 and §7.3a.
//
// It runs as bob_app, one tenant per transaction under that tenant's claim. It
// asks the truth store which member refs were seen in a trailing window
// (member_refs_seen), subtracts the refs BOb already knows, and creates a ghost
// for each one left: a `user` actor at rung `ghost`, its ref, and the first row
// of its linkage history. It never creates any other kind of actor, and keeps
// no cursor (H3).
//
// Its scheduler hands it the tenant: (org_id, tenant_slug). bob_app cannot
// enumerate organizations or read their slugs under RLS, which is right for a
// tenant-scoped credential; the finding is recorded in contract-amendments.md.

import { createHash } from 'node:crypto'

export const RETENTION_DAYS = 395   // C-14
const PAGE = 500

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

async function reconcileWindow(db, truth, { orgId, tenantSlug }, windowOf) {
  return withTenant(db, orgId, async () => {
    const { rows: channels } = await db.query(
      `SELECT source_key, lag_seconds FROM bob.channels
        WHERE org_id = $1 AND source_key IS NOT NULL`, [orgId])
    if (!channels.length) return { created: [], window: null }
    const largestLag = Math.max(0, ...channels.map((c) => c.lag_seconds ?? 0))
    const window = windowOf(largestLag)

    const frame = { tenant_slug: tenantSlug, source_keys: channels.map((c) => c.source_key), ...window }
    const seen = []
    let after = null
    do {
      const page = await truth.memberRefsSeen(frame, { limit: PAGE, after })
      seen.push(...page.rows)
      after = page.next
    } while (after !== null)
    if (!seen.length) return { created: [], window }

    const { rows: known } = await db.query(
      'SELECT ref FROM bob.actor_external_refs WHERE org_id = $1 AND ref = ANY($2::text[])',
      [orgId, seen.map((s) => s.external_ref)])
    const knownRefs = new Set(known.map((k) => k.ref))

    const created = []
    for (const s of seen) {
      if (knownRefs.has(s.external_ref)) continue
      const { rows: [actor] } = await db.query(
        `INSERT INTO bob.actors (org_id, actor_type, display_id, identity_rung)
         VALUES ($1, 'user', $2, 'ghost') RETURNING id`,
        [orgId, ghostDisplayId(orgId, s.external_ref)])
      // Idempotent on (org_id, ref): a concurrent run that got there first wins.
      const { rowCount } = await db.query(
        `INSERT INTO bob.actor_external_refs (org_id, actor_id, ref) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, ref) DO NOTHING`, [orgId, actor.id, s.external_ref])
      if (!rowCount) { await db.query('DELETE FROM bob.actors WHERE id = $1', [actor.id]); continue }
      await db.query(
        `INSERT INTO bob.actor_ref_history (org_id, ref, actor_id, identity_rung, valid_from)
         VALUES ($1, $2, $3, 'ghost', $4)`, [orgId, s.external_ref, actor.id, s.first_seen])
      created.push({ ref: s.external_ref, actorId: actor.id, firstSeen: s.first_seen })
    }
    return { created, window }
  })
}

// Ghost creation is a linkage event (§7.2): it returns the window to rebuild,
// [earliest first_seen among the new ghosts, now), or null when it made none.
function rebuildWindow(created, now) {
  if (!created.length) return null
  const earliest = Math.min(...created.map((c) => new Date(c.firstSeen).getTime()))
  return { from: new Date(Math.floor(earliest / 300_000) * 300_000), to: new Date(now) }
}

export async function reconcileGhosts(db, truth, tenant, { now, intervalSeconds }) {
  const { created, window } = await reconcileWindow(db, truth, tenant,
    (lag) => trailingWindow(now, intervalSeconds, lag))
  return { created, window, rebuild: rebuildWindow(created, now) }
}

// The slower sweep over the whole retention window (H3).
export async function sweepGhosts(db, truth, tenant, { now }) {
  const to = new Date(now)
  const from = new Date(to.getTime() - RETENTION_DAYS * 86_400_000)
  const { created, window } = await reconcileWindow(db, truth, tenant, () => ({ from, to }))
  return { created, window, rebuild: rebuildWindow(created, now) }
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
