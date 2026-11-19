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

export function kindOf(e) {
  switch (e.event_name) {
    case 'turn':
      return e.attributes?.side === 'customer' ? 'customer_turn' : 'business_turn'
    case 'orga_label': return 'label'
    case 'conversation_close': return 'close'
    case 'detection': return 'detection'
    case 'delivery_attempt': return 'delivery'
    default: return 'other'
  }
}
