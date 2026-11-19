// A truth store held in memory: the stand-in for BzzzBX's ClickHouse that the
// reference feeder and the ghost reconciliation run against before 3.7 exists.
//
// It answers exactly what the contract lets BOb ask, and nothing else:
//   - events(window)          what the feeder reads (a scheduled query, System
//                             Flows §3), by event time;
//   - watermark()             how far the truth store is complete (§4);
//   - memberRefsSeen(frame)   §7.3a: distinct member refs in a frame, with
//                             first and last seen, paged. Pseudonyms only, no
//                             correlation_id, no counts.
//
// An event has the shape of a business event: event_time, `bzzz.tenant` (the
// slug), source_key, correlation_id, event_name, attributes. The member ref
// travels in attributes['miembro.id'] (D47), never in entity_id.

const MEMBER = 'miembro.id'

export class MemoryTruthStore {
  constructor({ events = [], watermark }) {
    this._events = events.map((e) => ({ ...e, attributes: { ...(e.attributes ?? {}) } }))
    this._watermark = new Date(watermark)
  }

  // Tests add late facts the way the truth store would receive them.
  add(...events) { for (const e of events) this._events.push(structuredClone(e)) }
  setWatermark(at) { this._watermark = new Date(at) }

  watermark() { return this._watermark }

  // Events with from <= event_time < to, in event-time order.
  events({ from, to }) {
    const lo = new Date(from).getTime()
    const hi = new Date(to).getTime()
    return this._events
      .filter((e) => {
        const t = new Date(e.event_time).getTime()
        return t >= lo && t < hi
      })
      .sort((a, b) => new Date(a.event_time) - new Date(b.event_time))
      .map((e) => structuredClone(e))
  }

  // §7.3a. frame = { tenant_slug, source_keys, from, to }; page = { limit, after }.
  memberRefsSeen(frame, { limit = 500, after = null } = {}) {
    const keys = new Set(frame.source_keys)
    const seen = new Map()
    for (const e of this.events(frame)) {
      const ref = e.attributes[MEMBER]
      if (!ref || e['bzzz.tenant'] !== frame.tenant_slug || !keys.has(e.source_key)) continue
      const t = new Date(e.event_time)
      const s = seen.get(ref)
      if (!s) seen.set(ref, { external_ref: ref, first_seen: t, last_seen: t })
      else s.last_seen = t
    }
    const rows = [...seen.values()]
      .sort((a, b) => (a.external_ref < b.external_ref ? -1 : 1))
      .filter((r) => after === null || r.external_ref > after)
    const page = rows.slice(0, limit)
    return { rows: page, next: rows.length > limit ? page.at(-1).external_ref : null }
  }
}
