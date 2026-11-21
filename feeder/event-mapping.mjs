// The feeder's own event mapping (§8.6 says metric_id is resolved through it).
// Which business event is which kind, and which attribute values the
// projections accept. Kept apart from the feeder so the rules read as a table.

// D47: the member ref travels in attributes, never in entity_id.
export const MEMBER_REF = 'miembro.id'

// §6.2: the five ORGA states.
export const LABEL_STATES = new Set(['s0', 's1', 's2', 's3', 's4'])

// §6.1: the two failures the classifier reports itself. The third absence,
// label_missing, is never reported: the feeder writes it at seal (§4.1, C2).
export const LABEL_FAILURES = new Set(['abstained', 'classifier_down'])

// §6.1: what a close means. v1 reads `resolved` as closed without escalation.
export const CLOSE_METRIC = { resolved: 'resolved', escalated: 'escalations' }

// ── F-28, F-38 · the observed zero, written at seal (Slice 3 spec §5) ───────
// For each metric the feeder can write a zero for: the projection, the
// capability that must be declared, and the actor types that can produce it.
// The feeder reads two views and cannot see bob.cell_catalog, so it carries
// this copy; tests/slice3-cell-state.test.mjs compares it with the catalog,
// both ways. The label failures are not here: §4.1 writes their zeros, and
// F-28 does not touch them.
//
// `capability: null` means the metric has no capability of its own, only a
// precondition (abandoned, §9.2). `degenerate` metrics belong to the
// conversation: `user` only, whatever the mix says (F-38).
const ALL = ['user', 'asa', 'human', 'arep']
export const ZERO_RULES = {
  resolved:             { table: 'proj_metric_counts', capability: 'resolution',     actors: ['asa', 'human', 'arep'] },
  abandoned:            { table: 'proj_metric_counts', capability: null,             actors: ALL },
  disambiguation:       { table: 'proj_metric_counts', capability: 'disambiguation', actors: ['asa', 'human', 'arep'] },
  escalations:          { table: 'proj_metric_counts', capability: 'escalation',     actors: ['asa', 'human', 'arep'] },
  hallucinations:       { table: 'proj_metric_counts', capability: 'hallucination',  actors: ALL },
  abandoned_in_queue:   { table: 'proj_metric_counts', capability: 'queue',          actors: ['user'], degenerate: true },
  response_time:        { table: 'proj_durations',     capability: 'response_time',  actors: ALL },
  interaction_duration: { table: 'proj_durations',     capability: 'resolution',     actors: ['user'], degenerate: true },
}

// F-28 · the zero is written only for a metric the feeder counts. A zero for
// a metric with no counting path would be a zero nobody observed: an
// abandonment the feeder cannot see would still read as "observed, none".
// The reference feeder counts resolved and escalations at the close, response
// time from the turns, and interaction duration at the close. It has no idle
// detection, no disambiguation event and no queue event, so abandoned,
// disambiguation and abandoned_in_queue get no row at all and render
// not_observed. A metric joins this set in the same change that gives it a
// counting path; tests/slice3-cell-state.test.mjs sees each one counted above
// zero from the fixture, and no row for the others. 3.7 owes the same rule.
export const MEASURED = new Set(['resolved', 'escalations', 'response_time', 'interaction_duration'])

// F-28, corrected · the closed list of metrics whose measurement has a
// precondition beyond the capability. A metric that gains one joins it in the
// same change; the guard compares it with the catalog's `precondition`.
//   ground_truth   hallucinations: no zero, ever. The feeder cannot see whether
//                  a ground truth exists (D-29) through its two views.
//   idle_bound     abandoned: no row while idle_bound_seconds is NULL (§9.2).
export const ZERO_PRECONDITIONS = {
  hallucinations: 'ground_truth',
  abandoned: 'idle_bound',
}

// The kinds of event that are an interaction's activity: a bucket that has one
// has traffic (F-28's first source of liveness).
export const TRAFFIC_KINDS = new Set(['customer_turn', 'business_turn', 'close'])

export function kindOf(e) {
  switch (e.event_name) {
    case 'turn':
      return e.attributes?.side === 'customer' ? 'customer_turn' : 'business_turn'
    case 'orga_label': return 'label'
    case 'conversation_close': return 'close'
    case 'detection': return 'detection'
    case 'delivery_attempt': return 'delivery'
    // §6.4, §5: an uptime probe emitting on a timer, the second source of
    // liveness (F-28). attributes: uptime_seconds, observed_seconds.
    case 'uptime_probe': return 'probe'
    default: return 'other'
  }
}
