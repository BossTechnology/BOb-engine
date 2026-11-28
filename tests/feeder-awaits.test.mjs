// The feeder against a truth store that answers later.
//
// MemoryTruthStore answers at once, so runFeeder never needed to wait for it.
// The store of 3.7 reads over HTTPS: watermark() and events() return promises.
// runFeeder called both without `await` (reference-feeder.mjs, runFeeder), so
// against a store that answers later it read a Promise as a Date and as a list.
// No database here: a stub answers the two feeder views, and the channel map is
// empty, so nothing is written and the run reports what it counted.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runFeeder, stageMemberRefs } from '../feeder/reference-feeder.mjs'

const FROM = '2026-11-18T14:00:00Z'
const TO = '2026-11-18T14:30:00Z'

// bob_feeder's two views, empty: every event is unmapped (route A).
const stubDb = (channels = []) => ({
  async query(sql) {
    if (/v_feeder_channel_map/.test(sql)) return { rows: channels }
    if (/v_feeder_actor_map/.test(sql)) return { rows: [] }
    throw new Error(`the stub db was asked for something else: ${sql}`)
  },
})

// Answers on a later tick, as a socket does.
const later = (v) => new Promise((resolve) => setTimeout(() => resolve(v), 5))

class SlowStore {
  constructor(events, watermark) { this._e = events; this._w = new Date(watermark); this.asked = [] }
  async watermark() { return later(this._w) }
  async events(range) { this.asked.push(range); return later(this._e) }
}

const ev = (at, source_key) => ({
  event_time: at, 'bzzz.tenant': 'tenant-a', source_key, correlation_id: 'c1',
  event_name: 'turn', attributes: { side: 'customer', turn_id: 't1' },
})

describe('runFeeder waits for the truth store', () => {
  test('the watermark it reports is the Date the store resolved to, not a Promise', async () => {
    const store = new SlowStore([ev('2026-11-18T14:02:00Z', 'tenant-a.nowhere')], '2026-11-18T14:30:00Z')
    const r = await runFeeder(stubDb(), store, { from: FROM, to: TO })
    assert.ok(r.watermark instanceof Date, `watermark is ${Object.prototype.toString.call(r.watermark)}`)
    assert.equal(r.watermark.toISOString(), '2026-11-18T14:30:00.000Z')
  })

  test('it projects the events the store resolved to: an unmapped one is counted', async () => {
    const store = new SlowStore([ev('2026-11-18T14:02:00Z', 'tenant-a.nowhere')], '2026-11-18T14:30:00Z')
    const r = await runFeeder(stubDb(), store, { from: FROM, to: TO })
    assert.equal(r.unmappedEvents, 1)
  })

  test('it asks for the window and the context before it, up to the watermark', async () => {
    const store = new SlowStore([], '2026-11-18T14:45:00Z')
    await runFeeder(stubDb(), store, { from: FROM, to: TO, contextSeconds: 3600 })
    assert.equal(store.asked.length, 1)
    assert.equal(new Date(store.asked[0].from).toISOString(), '2026-11-18T13:00:00.000Z')
    assert.equal(new Date(store.asked[0].to).toISOString(), '2026-11-18T14:45:00.000Z')
  })
})

// readAheadSeconds. Without it the feeder reads every run up to the watermark so
// that a label arriving after its turn is seen. A rebuild of an old day then
// reads everything since: a 395-day rebuild by day would read the same months
// again and again. With it the read stops `readAheadSeconds` past the window.
describe('runFeeder readAheadSeconds', () => {
  const old = (readAheadSeconds) => {
    const store = new SlowStore([], '2026-11-25T00:00:00Z')
    return runFeeder(stubDb(), store, { from: FROM, to: TO, contextSeconds: 0, readAheadSeconds })
      .then(() => new Date(store.asked[0].to).toISOString())
  }
  test('unset, it reads up to the watermark (the reference behaviour)', async () => {
    assert.equal(await old(undefined), '2026-11-25T00:00:00.000Z')
  })
  test('set, it reads that far past the window and no further', async () => {
    assert.equal(await old(3600), '2026-11-18T15:30:00.000Z')
  })
  test('set, it never reads less than the window, even if the watermark is behind it', async () => {
    const store = new SlowStore([], '2026-11-18T14:10:00Z')
    await runFeeder(stubDb(), store, { from: FROM, to: TO, contextSeconds: 0, readAheadSeconds: 3600 })
    assert.equal(new Date(store.asked[0].to).toISOString(), '2026-11-18T14:30:00.000Z')
  })
})

// Slice 3.7 does not cover member_refs_seen with the two views of Wednesday.
describe('memberRefsSeen on the HTTPS store', () => {
  test('stageMemberRefs reports the refusal per tenant and does not throw', async () => {
    const { VecinosTruthStore, MemberRefsNotAvailable } = await import('../feeder/vecinos-truth-store.mjs')
    const store = new VecinosTruthStore({
      baseUrl: 'https://127.0.0.1:1', tenant: 'tenant-a', ca: 'x', cert: 'x', key: 'x',
    })
    await assert.rejects(store.memberRefsSeen({}, {}), MemberRefsNotAvailable)
    const channel = { org_id: 'org-1', tenant_slug: 'tenant-a', source_key: 'tenant-a.whatsapp',
      channel_id: 'ch-1', capabilities: [] }
    const out = await stageMemberRefs(stubDb([channel]), store, { from: FROM, to: TO })
    assert.deepEqual(Object.keys(out), ['org-1'])
    assert.equal(out['org-1'].staged, 0)
    assert.match(out['org-1'].error, /memberRefsSeen/)
    assert.match(out['org-1'].error, /miembros_vistos/)
  })
})
