// Task 3.7 · the reference feeder against the HTTPS store, on a database.
//
// The claim of 3.7 is "a second implementation behind the same interface": the
// projections the feeder writes from the store that reads `bzzz-vecinos` must be
// the ones it writes from MemoryTruthStore, row for row. The events are the
// Slice 2 fixture, served by the fake service (tests/helpers/vecinos-falso.mjs).
// The feeder runs as bob_feeder, as in slice2-feeder.test.mjs.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  connect, connectAs, loadFixture, loadRoster, loadFeederWorld, REPO_ROOT, TENANT_A, TENANT_B,
} from './helpers/db.mjs'
import { MemoryTruthStore } from '../feeder/memory-truth-store.mjs'
import { VecinosTruthStore } from '../feeder/vecinos-truth-store.mjs'
import { runFeeder } from '../feeder/reference-feeder.mjs'
import { makeCertificates, startFake } from './helpers/vecinos-falso.mjs'

const FIXTURE = JSON.parse(readFileSync(resolve(REPO_ROOT, 'supabase/tests/fixtures/feeder_events.json'), 'utf8'))
const FROM = '2026-11-18T14:00:00Z'
const TO = '2026-11-18T14:30:00Z'
const TENANTS = [TENANT_A, TENANT_B]
// Every source of the fixture is complete up to the fixture's watermark.
const SOURCES = [...new Set(FIXTURE.events.map((e) => e.source_key))].sort().map((fuente) => ({
  fuente, ingerido_hasta: '2026-11-18 14:30:00.000', evento_hasta: '2026-11-18 14:29:00.000',
}))

let db, feeder, certs, fake
async function freshWorld() {
  await loadFixture(db); await loadRoster(db); await loadFeederWorld(db)
}
before(async () => {
  certs = makeCertificates()
  db = await connect()
  await freshWorld()
  await db.query('GRANT bob_feeder, bob_app TO current_user')
  feeder = await connectAs('bob_feeder')
  fake = await startFake({ certs, events: FIXTURE.events, sources: SOURCES })
})
after(async () => {
  await fake?.close()
  await feeder?.end()
  await db?.query('REVOKE bob_feeder, bob_app FROM current_user')
  await db?.end()
  certs?.remove()
})

const vecinos = (o = {}) => new VecinosTruthStore({
  baseUrl: fake.url, ca: certs.ca, cert: certs.client.cert, key: certs.client.key, tenant: 'tenant-a', ...o,
})

async function projections() {
  const { rows } = await db.query(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'bob' AND c.relkind = 'p' AND c.relname LIKE 'proj\\_%' ORDER BY 1`)
  assert.equal(rows.length, 8, 'the eight projections were not found')
  return rows.map((r) => r.name)
}
async function clearProjections() {
  for (const p of await projections()) await db.query(`DELETE FROM bob.${p} WHERE org_id = ANY($1::uuid[])`, [TENANTS])
}
async function snapshot() {
  const out = {}
  for (const p of await projections()) {
    const { rows } = await db.query(
      `SELECT to_jsonb(t) - 'computed_at' AS r FROM bob.${p} t
        WHERE org_id = ANY($1::uuid[]) ORDER BY (to_jsonb(t) - 'computed_at')::text`, [TENANTS])
    out[p] = rows.map((x) => x.r)
  }
  return out
}
const total = (snap) => Object.values(snap).reduce((n, rows) => n + rows.length, 0)

describe('the HTTPS store is a second implementation behind the same interface', () => {
  let reference
  before(async () => {
    await freshWorld(); await clearProjections()
    await runFeeder(feeder, new MemoryTruthStore({ events: FIXTURE.events, watermark: FIXTURE.watermark }), { from: FROM, to: TO })
    reference = await snapshot()
  })

  test('the reference run wrote something in every projection the fixture feeds', () => {
    assert.ok(total(reference) > 20, `only ${total(reference)} rows: the comparison would prove little`)
  })

  test('through bzzz-vecinos it writes the same rows, watermark included', async () => {
    await clearProjections()
    const store = vecinos()
    const r = await runFeeder(feeder, store, { from: FROM, to: TO })
    store.close()
    assert.equal(r.watermark.toISOString(), '2026-11-18T14:30:00.000Z')
    assert.deepEqual(await snapshot(), reference)
  })

  test('with windows of five minutes and pages of three rows it writes the same rows', async () => {
    await clearProjections()
    const store = vecinos({ windowSeconds: 300, pageLimit: 3 })
    await runFeeder(feeder, store, { from: FROM, to: TO })
    assert.ok(store.report().pages > 10, 'the small windows and pages were not exercised')
    store.close()
    assert.deepEqual(await snapshot(), reference)
  })

  test('a rebuild in two steps writes the same rows as one run', async () => {
    await clearProjections()
    const store = vecinos()
    await runFeeder(feeder, store, { from: FROM, to: '2026-11-18T14:15:00Z' })
    await runFeeder(feeder, store, { from: '2026-11-18T14:15:00Z', to: TO })
    store.close()
    assert.deepEqual(await snapshot(), reference)
  })

  test('a replay of a step changes nothing: an interrupted rebuild resumes by running its step again', async () => {
    const store = vecinos()
    await runFeeder(feeder, store, { from: FROM, to: TO })
    store.close()
    assert.deepEqual(await snapshot(), reference)
  })
})

describe('tenants', () => {
  test('the box\'s tenant alone: the other tenant\'s events, which this fake box also serves, write nothing', async () => {
    await freshWorld(); await clearProjections()
    const store = vecinos()
    const r = await runFeeder(feeder, store, { from: FROM, to: TO, boxTenant: 'tenant-a' })
    store.close()
    const snap = await snapshot()
    assert.ok(total(snap) > 0)
    for (const [table, rows] of Object.entries(snap)) {
      assert.ok(rows.every((x) => x.org_id === TENANT_A), `${table} holds a row of another tenant`)
    }
    assert.ok(r.unmappedEvents > 0, 'tenant-b\'s events should have been counted as unmapped')
  })

  test('without boxTenant the same box writes both: the guard is the option', async () => {
    await clearProjections()
    const store = vecinos()
    await runFeeder(feeder, store, { from: FROM, to: TO })
    store.close()
    const snap = await snapshot()
    assert.ok(Object.values(snap).some((rows) => rows.some((x) => x.org_id === TENANT_B)))
  })
})
