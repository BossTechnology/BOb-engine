// Task 3.7 · the HTTPS truth store against a fake bzzz-vecinos (mTLS, the two
// views of Wednesday). No database: what the store does with the wire.
//
// Each guard here was seen failing on purpose before it was trusted; the table
// is in contract-amendments.md, "Task 3.7 · The vecinos adapter".

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { VecinosTruthStore, VecinosError, MemberRefsNotAvailable, parseTime } from '../feeder/vecinos-truth-store.mjs'
import { project } from '../feeder/reference-feeder.mjs'
import { makeCertificates, startFake } from './helpers/vecinos-falso.mjs'

let certs
before(() => { certs = makeCertificates() })
after(() => certs?.remove())

const T0 = Date.parse('2026-11-18T00:00:00Z')
const ev = (ms, extra = {}) => ({
  event_time: new Date(ms).toISOString(), 'bzzz.tenant': 'tenant-a', source_key: 'tenant-a.whatsapp',
  correlation_id: `c${ms}`, event_name: 'turn', attributes: { side: 'customer', turn_id: `t${ms}` }, ...extra,
})
// n events a minute apart from `start`
const run = (n, start = T0 + 3_600_000, extra = {}) => Array.from({ length: n }, (_, i) => ev(start + i * 60_000, extra))

const noSleep = () => { const waits = []; return { waits, sleep: async (ms) => { waits.push(ms) } } }

async function withFake(opts, fn) {
  const fake = await startFake({ certs, ...opts })
  const stores = []
  const make = (o = {}) => {
    const s = new VecinosTruthStore({
      baseUrl: fake.url, ca: certs.ca, cert: certs.client.cert, key: certs.client.key,
      tenant: 'tenant-a', retryBaseMs: 1, ...o,
    })
    stores.push(s)
    return s
  }
  try { return await fn({ fake, make }) } finally { stores.forEach((s) => s.close()); await fake.close() }
}

const FROM = '2026-11-18T00:00:00Z'
const TO = '2026-11-19T00:00:00Z'

describe('mutual TLS', () => {
  test('a store with BOb\'s client certificate reads', async () => {
    await withFake({ events: run(3) }, async ({ make }) => {
      assert.equal((await make().events({ from: FROM, to: TO })).length, 3)
    })
  })

  test('a certificate from another CA gets no rows', async () => {
    await withFake({ events: run(3) }, async ({ make, fake }) => {
      const store = make({ cert: certs.intruder.cert, key: certs.intruder.key, maxRetries: 0 })
      await assert.rejects(store.events({ from: FROM, to: TO }), VecinosError)
      assert.equal(fake.requests.length, 0, 'the handshake should have been refused before HTTP')
    })
  })

  test('the store refuses to be built without a client certificate, or without the CA', () => {
    const base = { baseUrl: 'https://localhost:1', ca: 'x', cert: 'x', key: 'x' }
    for (const missing of ['ca', 'cert', 'key']) {
      assert.throws(() => new VecinosTruthStore({ ...base, [missing]: '' }), /mutual TLS/)
    }
  })

  test('the store does not ask for a tenant: the box sets it', async () => {
    await withFake({ events: run(2) }, async ({ make, fake }) => {
      const s = make()
      await s.events({ from: FROM, to: TO })
      await s.watermark()
      for (const r of fake.requests) {
        assert.ok(!('tenant' in r.query), `${r.view} was asked for a tenant`)
        assert.ok(!('fuente' in r.query))
      }
    })
  })
})

describe('paging', () => {
  test('1 200 events are three pages of at most 500, each row once, in time order', async () => {
    await withFake({ events: run(1200) }, async ({ make, fake }) => {
      const got = await make().events({ from: FROM, to: TO })
      assert.equal(got.length, 1200)
      assert.equal(new Set(got.map((e) => e.clave)).size, 1200)
      assert.deepEqual(got.map((e) => e.event_time), [...got.map((e) => e.event_time)].sort())
      const reqs = fake.requests.filter((r) => r.view === 'eventos')
      assert.equal(reqs.length, 3)
      assert.deepEqual(reqs.map((r) => r.query.limite), ['500', '500', '500'])
      assert.deepEqual(reqs.map((r) => 'cursor' in r.query), [false, true, true])
    })
  })

  test('a page limit above 500 is refused when the store is built', () => {
    const base = { baseUrl: 'https://localhost:1', ca: 'x', cert: 'x', key: 'x' }
    assert.throws(() => new VecinosTruthStore({ ...base, pageLimit: 501 }), /pageLimit/)
    assert.throws(() => new VecinosTruthStore({ ...base, pageLimit: 0 }), /pageLimit/)
  })

  test('a smaller configured page is used', async () => {
    await withFake({ events: run(25) }, async ({ make, fake }) => {
      const got = await make({ pageLimit: 10 }).events({ from: FROM, to: TO })
      assert.equal(got.length, 25)
      assert.equal(fake.requests.length, 3)
    })
  })

  test('a service that gives the same cursor twice does not loop the store', { timeout: 20_000 }, async () => {
    await withFake({ events: run(30) }, async ({ make, fake }) => {
      const s = make({ pageLimit: 10 })
      const original = s._get.bind(s)
      s._get = async (view, params) => {
        const body = await original(view, params)
        return { ...body, siguiente: params.cursor ?? body.siguiente }   // page 2 repeats page 1's cursor
      }
      await assert.rejects(s.events({ from: FROM, to: TO }), (e) => e.code === 'cursor_loop')
      assert.ok(fake.requests.length <= 3)
    })
  })
})

describe('windows', () => {
  const day = (n) => new Date(T0 + n * 86_400_000).toISOString().replace('.000Z', 'Z')
  const windowsOf = (fake) => fake.requests.filter((r) => r.view === 'eventos')
    .filter((r) => !('cursor' in r.query)).map((r) => [r.query.desde, r.query.hasta])

  test('by default a three-day read is three windows of a day, contiguous', async () => {
    await withFake({ events: run(5) }, async ({ make, fake }) => {
      await make().events({ from: day(0), to: day(3) })
      assert.deepEqual(windowsOf(fake), [[day(0), day(1)], [day(1), day(2)], [day(2), day(3)]])
    })
  })

  test('the window is configuration, not a constant: six hours makes twelve windows', async () => {
    await withFake({ events: run(5) }, async ({ make, fake }) => {
      await make({ windowSeconds: 21_600 }).events({ from: day(0), to: day(3) })
      assert.equal(windowsOf(fake).length, 12)
      assert.deepEqual(windowsOf(fake)[0], [day(0), '2026-11-18T06:00:00Z'])
    })
  })

  test('the window must be a multiple of five minutes', () => {
    const base = { baseUrl: 'https://localhost:1', ca: 'x', cert: 'x', key: 'x' }
    assert.throws(() => new VecinosTruthStore({ ...base, windowSeconds: 3601 }), /multiple of 300/)
    assert.throws(() => new VecinosTruthStore({ ...base, windowSeconds: 0 }), /multiple of 300/)
  })

  test('a window the grain does not fit is rounded out and the rows outside [from, to) are dropped', async () => {
    // `to` is a watermark: 14:32:10 is not on the grain, and the service answers 400 to it.
    const at = (hms) => Date.parse(`2026-11-18T${hms}Z`)
    const events = [ev(at('14:00:30')), ev(at('14:03:00')), ev(at('14:32:09')), ev(at('14:32:10')), ev(at('14:34:00'))]
    await withFake({ events }, async ({ make, fake }) => {
      const got = await make().events({ from: '2026-11-18T14:01:10Z', to: '2026-11-18T14:32:10Z' })
      assert.deepEqual(got.map((e) => e.event_time), ['2026-11-18T14:03:00.000Z', '2026-11-18T14:32:09.000Z'])
      assert.deepEqual(windowsOf(fake), [['2026-11-18T14:00:00Z', '2026-11-18T14:35:00Z']])
    })
  })

  test('an empty window is an empty list, and from >= to asks nothing', async () => {
    await withFake({ events: [] }, async ({ make, fake }) => {
      assert.deepEqual(await make().events({ from: FROM, to: TO }), [])
      assert.deepEqual(await make().events({ from: TO, to: FROM }), [])
      assert.equal(fake.requests.length, 1)
    })
  })
})

describe('the event it hands the feeder', () => {
  test('has the shape of MemoryTruthStore\'s: event_time as a UTC instant, bzzz.tenant, source_key, attributes', async () => {
    await withFake({ events: [ev(T0 + 3_600_123, { attributes: { side: 'customer', 'miembro.id': 'm:a001' } })] }, async ({ make }) => {
      const [e] = await make().events({ from: FROM, to: TO })
      assert.equal(e.event_time, '2026-11-18T01:00:00.123Z')
      assert.equal(e['bzzz.tenant'], 'tenant-a')
      assert.equal(e.source_key, 'tenant-a.whatsapp')
      assert.equal(e.event_name, 'turn')
      assert.deepEqual(e.attributes, { side: 'customer', 'miembro.id': 'm:a001' })
    })
  })

  test('parseTime reads ClickHouse\'s zone-less UTC and refuses what is not a time', () => {
    assert.equal(parseTime('2026-11-18 01:00:00.123').toISOString(), '2026-11-18T01:00:00.123Z')
    assert.equal(parseTime('2026-11-18T01:00:00Z').toISOString(), '2026-11-18T01:00:00.000Z')
    for (const bad of ['', 'yesterday', 12345, null, '2026-13-45 99:00:00']) {
      assert.throws(() => parseTime(bad), VecinosError, String(bad))
    }
  })

  test('an answer without a column the feeder reads is an error, not a quiet gap', async () => {
    await withFake({ events: run(2) }, async ({ make }) => {
      const s = make()
      const original = s._get.bind(s)
      s._get = async (...a) => {
        const b = await original(...a)
        const i = b.columnas.indexOf('event_name')
        return { ...b, columnas: b.columnas.filter((_, j) => j !== i), filas: b.filas.map((f) => f.filter((_, j) => j !== i)) }
      }
      await assert.rejects(s.events({ from: FROM, to: TO }), (e) => e.code === 'shape' && /event_name/.test(e.message))
    })
  })

  // KNOWN LIMIT (BZZ-19, 27 Nov): `value` arrives as 0 when it was missing, and the
  // view cannot tell the two apart. The store passes what it got and never reads it.
  test('`value` 0 passes through as 0, and the feeder\'s projection does not depend on it', async () => {
    const withValue = [ev(T0 + 3_600_000, { value: 0 }), ev(T0 + 3_660_000, { value: 999 })]
    await withFake({ events: withValue }, async ({ make }) => {
      const got = await make().events({ from: FROM, to: TO })
      assert.deepEqual(got.map((e) => e.value), [0, 999])
      // Same events, values swapped: the projection is identical, so a 0 that was
      // "missing" cannot change a figure today. Whoever reads `value` must read the doc first.
      const maps = { channelByKey: new Map(), actorRows: new Map() }
      const watermark = new Date(TO)
      const a = project(got, maps, watermark, { from: FROM, to: TO })
      const b = project(got.map((e) => ({ ...e, value: 12345 })), maps, watermark, { from: FROM, to: TO })
      assert.deepEqual(a, b)
    })
  })
})

describe('order and repeats', () => {
  test('rows the view gave out of order come out in time order, and the break is reported', async () => {
    await withFake({ events: run(6), shuffle: true }, async ({ make }) => {
      const s = make()
      const got = await s.events({ from: FROM, to: TO })
      assert.deepEqual(got.map((e) => e.event_time), [...got.map((e) => e.event_time)].sort())
      assert.ok(s.report().anomalies.some((a) => a.kind === 'clave_out_of_order'))
    })
  })

  test('a row the view repeated is counted once, and reported', async () => {
    await withFake({ events: run(6), orderBreak: true }, async ({ make }) => {
      const s = make()
      const got = await s.events({ from: FROM, to: TO })
      assert.equal(got.length, 6)
      assert.ok(s.report().anomalies.some((a) => a.kind === 'repeated_clave' || a.kind === 'clave_out_of_order'))
    })
  })

  test('a view that keeps its order reports nothing', async () => {
    await withFake({ events: run(1200) }, async ({ make }) => {
      const s = make()
      await s.events({ from: FROM, to: TO })
      assert.deepEqual(s.report().anomalies, [])
    })
  })
})

describe('the watermark', () => {
  const sources = (...rows) => rows.map(([fuente, ingerido_hasta, evento_hasta]) => ({ fuente, ingerido_hasta, evento_hasta }))

  test('is the MINIMUM of ingerido_hasta across the sources, not the latest', async () => {
    const s3 = sources(['a.whatsapp', '2026-11-18 12:00:00.000', '2026-11-18 11:59:00.000'],
      ['a.voice', '2026-11-18 11:20:00.000', '2026-11-18 11:19:00.000'],
      ['a.web', '2026-11-18 12:30:00.000', '2026-11-18 12:29:00.000'])
    await withFake({ sources: s3 }, async ({ make }) => {
      assert.equal((await make().watermark()).toISOString(), '2026-11-18T11:20:00.000Z')
    })
  })

  test('one source is its own watermark', async () => {
    await withFake({ events: [ev(Date.parse('2026-11-18T10:00:00Z'))], ingestedAfterMs: 5_000 }, async ({ make }) => {
      assert.equal((await make().watermark()).toISOString(), '2026-11-18T10:00:05.000Z')
    })
  })

  test('is paged: 250 sources are three pages, and the minimum is over all of them', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      fuente: `s${String(i).padStart(3, '0')}`,
      ingerido_hasta: `2026-11-18 12:${String(10 + (i % 40)).padStart(2, '0')}:00.000`,
      evento_hasta: '2026-11-18 12:00:00.000',
    }))
    many[249].ingerido_hasta = '2026-11-18 09:00:00.000'      // the slowest is on the last page
    await withFake({ sources: many }, async ({ make, fake }) => {
      assert.equal((await make().watermark()).toISOString(), '2026-11-18T09:00:00.000Z')
      const reqs = fake.requests.filter((r) => r.view === 'marca_de_agua')
      assert.equal(reqs.length, 3)
      assert.ok(reqs.every((r) => Number(r.query.limite) <= 100), 'marca_de_agua pages up to 100')
    })
  })

  test('an expected source with no row is reported, and the minimum is over the rest', async () => {
    const s2 = sources(['a.whatsapp', '2026-11-18 12:00:00.000', '2026-11-18 12:00:00.000'])
    await withFake({ sources: s2 }, async ({ make }) => {
      const s = make({ sources: ['a.whatsapp', 'a.voice'] })
      assert.equal((await s.watermark()).toISOString(), '2026-11-18T12:00:00.000Z')
      const w = s.report().warnings
      assert.deepEqual(w.map((x) => [x.kind, x.source]), [['source_missing', 'a.voice']])
    })
  })

  test('a source in the box and in no channel is reported and does not hold the watermark back', async () => {
    const s2 = sources(['a.whatsapp', '2026-11-18 12:00:00.000', '2026-11-18 12:00:00.000'],
      ['a.stray', '2026-11-18 01:00:00.000', '2026-11-18 01:00:00.000'])
    await withFake({ sources: s2 }, async ({ make }) => {
      const s = make({ sources: ['a.whatsapp'] })
      assert.equal((await s.watermark()).toISOString(), '2026-11-18T12:00:00.000Z')
      assert.deepEqual(s.report().warnings.map((x) => [x.kind, x.source]), [['source_unexpected', 'a.stray']])
    })
  })

  test('with no row for any expected source there is no watermark: it throws, it does not guess', async () => {
    await withFake({ sources: [] }, async ({ make }) => {
      await assert.rejects(make({ sources: ['a.whatsapp'] }).watermark(), (e) => e.code === 'no_watermark')
      await assert.rejects(make().watermark(), (e) => e.code === 'no_watermark')
    })
  })
})

describe('a cut', () => {
  // Three pages. The connection dies on the third.
  // `when` runs once per request while the script is not empty: count the
  // requests that carry a cursor (page 2 is the first of them) and cut from page 3 on.
  const fromThirdPage = () => { let n = 0; return (q) => q.cursor !== undefined && ++n >= 2 }
  test('a dropped connection is retried with the SAME cursor: it costs one page, not the window', async () => {
    await withFake({ events: run(30) }, async ({ make, fake }) => {
      let n = 0
      fake.script.push({ destroy: true, when: (q) => q.cursor !== undefined && ++n === 2 })   // page 3, once
      const { sleep } = noSleep()
      const got = await make({ pageLimit: 10, sleep }).events({ from: FROM, to: TO })
      assert.equal(got.length, 30)
      assert.equal(new Set(got.map((e) => e.clave)).size, 30, 'no row twice')
      const cursors = fake.requests.map((r) => r.query.cursor).filter(Boolean)
      // page 2 once, page 3 twice (the cut and its retry), the same cursor both times
      assert.equal(cursors.length, 3)
      assert.equal(cursors[1], cursors[2])
      assert.equal(fake.requests.filter((r) => !r.query.cursor).length, 1, 'page 1 was not asked for again')
    })
  })

  test('when the retries run out the call fails whole: no partial list', async () => {
    await withFake({ events: run(30) }, async ({ make, fake }) => {
      const when = fromThirdPage()
      for (let i = 0; i < 10; i++) fake.script.push({ destroy: true, when })
      const s = make({ pageLimit: 10, maxRetries: 2, sleep: noSleep().sleep })
      await assert.rejects(s.events({ from: FROM, to: TO }), (e) => e instanceof VecinosError && e.code === 'network')
    })
  })

  test('the next call, with the service back, starts over from the first page and returns every row once', async () => {
    await withFake({ events: run(30) }, async ({ make, fake }) => {
      fake.script.push({ destroy: true, when: fromThirdPage() })   // one cut, and maxRetries is 0
      const s = make({ pageLimit: 10, maxRetries: 0, sleep: noSleep().sleep })
      await assert.rejects(s.events({ from: FROM, to: TO }))
      fake.requests.length = 0
      const got = await s.events({ from: FROM, to: TO })
      assert.equal(got.length, 30)
      assert.equal(new Set(got.map((e) => e.clave)).size, 30)
      assert.equal(fake.requests.filter((r) => !r.query.cursor).length, 1, 'it began at the first page: nothing was saved')
    })
  })
})

describe('429 and the other refusals', () => {
  test('a 429 is waited out for as long as Retry-After says, then the page is read', async () => {
    await withFake({ events: run(3) }, async ({ make, fake }) => {
      fake.script.push({ status: 429, headers: { 'retry-after': '2' } })
      const { waits, sleep } = noSleep()
      const got = await make({ sleep }).events({ from: FROM, to: TO })
      assert.equal(got.length, 3)
      assert.deepEqual(waits, [2000])
    })
  })

  test('a 429 without Retry-After backs off, doubling', async () => {
    await withFake({ events: run(3) }, async ({ make, fake }) => {
      for (let i = 0; i < 3; i++) fake.script.push({ status: 429 })
      const { waits, sleep } = noSleep()
      await make({ sleep, retryBaseMs: 100, maxRetries: 3 }).events({ from: FROM, to: TO })
      assert.deepEqual(waits, [100, 200, 400])
    })
  })

  test('a 429 that does not stop fails after maxRetries + 1 requests, saying 429 and the service\'s code', async () => {
    await withFake({ events: run(3) }, async ({ make, fake }) => {
      for (let i = 0; i < 10; i++) fake.script.push({ status: 429 })
      await assert.rejects(make({ sleep: noSleep().sleep, maxRetries: 2 }).events({ from: FROM, to: TO }),
        (e) => e.status === 429 && e.code === 'demasiadas_peticiones')
      assert.equal(fake.requests.length, 3)
    })
  })

  test('a 400 is not retried: the same request would be refused again', async () => {
    await withFake({ events: run(3) }, async ({ make, fake }) => {
      fake.script.push({ status: 400, error: 'parametro_invalido' })
      await assert.rejects(make({ sleep: noSleep().sleep }).events({ from: FROM, to: TO }),
        (e) => e.status === 400 && e.code === 'parametro_invalido')
      assert.equal(fake.requests.length, 1)
    })
  })

  test('a 503 is retried, a 502 and a 507 are not', async () => {
    await withFake({ events: run(3) }, async ({ make, fake }) => {
      fake.script.push({ status: 503, error: 'ocupado' })
      assert.equal((await make({ sleep: noSleep().sleep }).events({ from: FROM, to: TO })).length, 3)
      for (const status of [502, 507]) {
        fake.requests.length = 0
        fake.script.push({ status, error: 'x' })
        await assert.rejects(make({ sleep: noSleep().sleep }).events({ from: FROM, to: TO }), (e) => e.status === status)
        assert.equal(fake.requests.length, 1, `${status} was retried`)
      }
    })
  })
})

describe('a timeout', () => {
  test('a service that does not answer fails the call at the configured time, saying timeout', { timeout: 20_000 }, async () => {
    await withFake({ events: run(3) }, async ({ make, fake }) => {
      fake.script.push({ hang: true })
      const t = Date.now()
      await assert.rejects(make({ timeoutMs: 150, maxRetries: 0 }).events({ from: FROM, to: TO }),
        (e) => e.code === 'timeout')
      assert.ok(Date.now() - t < 2000, 'the store waited much longer than its timeout')
    })
  })

  test('a timeout is retried like a dropped connection, and the second attempt reads', { timeout: 20_000 }, async () => {
    await withFake({ events: run(3) }, async ({ make, fake }) => {
      fake.script.push({ hang: true })
      const got = await make({ timeoutMs: 150, maxRetries: 1, sleep: noSleep().sleep }).events({ from: FROM, to: TO })
      assert.equal(got.length, 3)
      assert.equal(fake.requests.length, 2)
    })
  })
})

describe('member_refs_seen', () => {
  test('is refused by name, never answered empty', async () => {
    const s = new VecinosTruthStore({ baseUrl: 'https://localhost:1', ca: 'x', cert: 'x', key: 'x' })
    await assert.rejects(s.memberRefsSeen({ source_keys: ['a'] }, { limit: 500, after: null }),
      (e) => e instanceof MemberRefsNotAvailable && /miembros_vistos/.test(e.message))
  })
})

describe('tenants', () => {
  // A box is one tenant. If a box were misconfigured and its view returned another
  // tenant's rows, the feeder in a customer box (boxTenant) counts them as
  // unmapped and writes nothing for them, even where BOb holds a channel for them.
  test('an event of another tenant, through the store, is route A and is not mapped', async () => {
    const other = ev(T0 + 3_600_000, { 'bzzz.tenant': 'tenant-b', source_key: 'tenant-b.chat' })
    await withFake({ events: [...run(2), other], boxTenant: null }, async ({ make }) => {
      const got = await make().events({ from: FROM, to: TO })
      assert.equal(got.length, 3, 'the store does not hide it: the feeder decides')
      const chan = (slug, key) => ({ org_id: `org-${slug}`, tenant_slug: slug, source_key: key, channel_id: `ch-${slug}`,
        capabilities: ['orga_conversation'], lag_seconds: 0, actor_types: [] })
      const maps = {
        channelByKey: new Map([['tenant-a\u0000tenant-a.whatsapp', chan('tenant-a', 'tenant-a.whatsapp')],
          ['tenant-b\u0000tenant-b.chat', chan('tenant-b', 'tenant-b.chat')]]),
        actorRows: new Map(),
      }
      const withBox = project(got, maps, new Date(TO), { from: FROM, to: TO, boxTenant: 'tenant-a' })
      assert.equal(withBox.counts.routeA, 1)
      assert.deepEqual(withBox.tenants.map((t) => t.orgId), ['org-tenant-a'])
      const without = project(got, maps, new Date(TO), { from: FROM, to: TO })
      assert.deepEqual(without.tenants.map((t) => t.orgId).sort(), ['org-tenant-a', 'org-tenant-b'])
    })
  })
})
