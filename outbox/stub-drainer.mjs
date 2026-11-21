// The stub the outbox drains to (Slice 6).
//
// BOb writes an intention and never executes it: it holds no customer
// credential and calls no provider. Something else transmits. Until that exists
// this stub stands in for it, and does the two things a transmitter does that
// BOb can observe:
//   - it takes queued intentions off the outbox (public.bob_outbox_drain), which
//     never returns one awaiting approval;
//   - it reports each attempt as a `delivery_attempt` business event, the shape
//     BzzzBX would carry, so the outcome reaches BOb the real way: truth store,
//     reference feeder, proj_deliveries.
//
// So when execution arrives, nothing in BOb changes: the transmitter replaces
// this file, and the outcome still comes back through the projection.
//
// It runs as bob_app under one organization's claim, as the reconciliation does
// (F-26: the box has one organization). It reports every attempt delivered,
// because it attempts nothing; a stub that invented failures would be testing
// itself.
//
// The source_key the event travels under is the caller's: an intention belongs
// to an alert, not to a channel, and which source key BzzzBX reports delivery
// under is the transmitter's to decide.

export const STUB_PROVIDER = 'stub'

export async function drainToStub(db, { orgId, tenantSlug, sourceKey, limit = 100 }) {
  if (!orgId || !tenantSlug || !sourceKey) {
    throw new Error('drainToStub needs orgId, tenantSlug and sourceKey')
  }
  await db.query('BEGIN')
  let drained
  try {
    await db.query('SELECT set_config($1, $2, true)',
      ['request.jwt.claims', JSON.stringify({ org_id: orgId })])
    ;({ rows: drained } = await db.query('SELECT * FROM public.bob_outbox_drain($1)', [limit]))
    await db.query('COMMIT')
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  }
  return drained.map((q) => ({
    event_time: new Date(q.drained_at).toISOString(),
    'bzzz.tenant': tenantSlug,
    source_key: sourceKey,
    // Inherited where the intention carries one; otherwise the intention's own
    // id, with no namespace written into it (slice2-schema guards that shape).
    // BOb mints none (C-11).
    correlation_id: q.correlation_id ?? q.id,
    event_name: 'delivery_attempt',
    attributes: {
      attempt_id: `${q.id}-1`,
      outbound_id: q.id,
      kind: 'autobotz',
      provider: STUB_PROVIDER,
      outcome: 'delivered',
      attempt: 1,
    },
  }))
}
