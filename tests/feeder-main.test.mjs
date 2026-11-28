// Task 3.7 · the feeder's entry point (feeder/main.mjs): configuration, arguments,
// steps, what it passes to runFeeder, what it reports. No database, no network:
// the store, the feeder and the connection are stubs, so what is tested is what the
// entry point decides.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readConfig, readArgs, stepsOf, checkSources, run, ConfigError } from '../feeder/main.mjs'
import { REPO_ROOT } from './helpers/db.mjs'

const SECRET = 'postgres://bob_feeder:hunter2-not-a-real-password@db:5432/postgres'
const FILES = {
  '/s/ca.pem': 'CA', '/s/bob.pem': 'CERT', '/s/bob.key': 'KEY', '/s/feeder-db-url': `${SECRET}\n`,
}
const readText = (p) => { if (p in FILES) return FILES[p]; const e = new Error('nope'); e.code = 'ENOENT'; throw e }
const ENV = {
  BOB_VECINOS_URL: 'https://bzzz-vecinos:8443', BOB_VECINOS_TENANT: 'febor',
  BOB_VECINOS_CA_FILE: '/s/ca.pem', BOB_VECINOS_CERT_FILE: '/s/bob.pem', BOB_VECINOS_KEY_FILE: '/s/bob.key',
  BOB_FEEDER_DB_URL_FILE: '/s/feeder-db-url',
}

describe('configuration', () => {
  test('a complete environment reads, and the defaults are the ones the docs name', () => {
    const c = readConfig(ENV, readText)
    assert.equal(c.tenant, 'febor')
    assert.equal(c.store.windowSeconds, 86_400)
    assert.equal(c.store.pageLimit, 500)
    assert.equal(c.store.watermarkDays, 2)
    assert.equal(c.store.maxRetries, 3)
    assert.equal(c.feeder.stepSeconds, 86_400)
    assert.equal(c.feeder.readAheadSeconds, null)
    assert.equal(c.dbUrl, SECRET, 'the URL is read from the file and trimmed')
    assert.deepEqual([c.store.ca, c.store.cert, c.store.key], ['CA', 'CERT', 'KEY'])
  })

  test('each of these missing is a ConfigError that names it', () => {
    for (const name of ['BOB_VECINOS_URL', 'BOB_VECINOS_TENANT', 'BOB_VECINOS_CA_FILE', 'BOB_VECINOS_CERT_FILE',
      'BOB_VECINOS_KEY_FILE', 'BOB_FEEDER_DB_URL_FILE']) {
      const env = { ...ENV }; delete env[name]
      assert.throws(() => readConfig(env, readText), (e) => e instanceof ConfigError && e.message.includes(name), name)
    }
  })

  test('the window is configuration: a value from the environment is used, and a bad one is refused', () => {
    assert.equal(readConfig({ ...ENV, BOB_VECINOS_WINDOW_SECONDS: '21600' }, readText).store.windowSeconds, 21_600)
    for (const bad of ['3601', '0', '-300', 'a day', '1.5']) {
      assert.throws(() => readConfig({ ...ENV, BOB_VECINOS_WINDOW_SECONDS: bad }, readText), ConfigError, bad)
    }
  })

  test('a page above 500, a plain-http URL and an unreadable certificate are refused', () => {
    assert.throws(() => readConfig({ ...ENV, BOB_VECINOS_PAGE_LIMIT: '501' }, readText), ConfigError)
    assert.throws(() => readConfig({ ...ENV, BOB_VECINOS_URL: 'http://bzzz-vecinos:8080' }, readText), /https/)
    assert.throws(() => readConfig({ ...ENV, BOB_VECINOS_KEY_FILE: '/s/missing.key' }, readText), /missing\.key/)
  })

  test('the database URL can come from the variable; the file wins when both are set', () => {
    const env = { ...ENV }; delete env.BOB_FEEDER_DB_URL_FILE
    assert.equal(readConfig({ ...env, BOB_FEEDER_DB_URL: 'postgres://x' }, readText).dbUrl, 'postgres://x')
    assert.equal(readConfig({ ...ENV, BOB_FEEDER_DB_URL: 'postgres://x' }, readText).dbUrl, SECRET)
  })
})

describe('arguments and steps', () => {
  test('--from and --to go together, on the five-minute grain, in order', () => {
    assert.deepEqual(readArgs([]), { from: null, to: null, memberRefs: false })
    assert.deepEqual(readArgs(['--from', '2026-11-01T00:00:00Z', '--to', '2026-11-03T00:00:00Z', '--member-refs']),
      { from: '2026-11-01T00:00:00Z', to: '2026-11-03T00:00:00Z', memberRefs: true })
    for (const bad of [['--from', '2026-11-01T00:00:00Z'], ['--to', '2026-11-01T00:00:00Z'],
      ['--from', '2026-11-01T00:03:00Z', '--to', '2026-11-02T00:00:00Z'],
      ['--from', '2026-11-02T00:00:00Z', '--to', '2026-11-01T00:00:00Z'], ['--nope'], ['--from']]) {
      assert.throws(() => readArgs(bad), ConfigError, bad.join(' '))
    }
  })

  test('a rebuild is cut in steps from `from`, the last one shorter, with no gap and no overlap', () => {
    const s = stepsOf('2026-11-01T00:00:00Z', '2026-11-03T12:00:00Z', 86_400)
    assert.deepEqual(s.map((x) => [x.from, x.to]), [
      ['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'],
      ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z'],
      ['2026-11-03T00:00:00.000Z', '2026-11-03T12:00:00.000Z']])
  })
})

describe('checkSources: SR-2 says source_key = source, and nothing checked it', () => {
  const at = (iso) => new Date(iso)
  const ch = (source_key, lag_seconds = 600) => ({ source_key, lag_seconds })
  const src = (source, iso) => ({ source, ingestedUntil: at(iso) })
  const NOW = '2026-11-30T12:00:00Z'

  test('a channel with no source, a source with no channel', () => {
    const r = checkSources({ sources: [src('febor.web', '2026-11-30T11:59:00Z'), src('febor.stray', '2026-11-30T11:59:00Z')],
      channels: [ch('febor.web'), ch('febor.whatsap')], now: NOW })
    assert.deepEqual(r.map((x) => [x.kind, x.source]).sort(),
      [['channel_without_source', 'febor.whatsap'], ['source_without_channel', 'febor.stray']])
  })

  test('a source whose newest arrival is older than its channel\'s declared lag is reported', () => {
    const r = checkSources({ sources: [src('febor.web', '2026-11-30T11:40:00Z')], channels: [ch('febor.web', 600)], now: NOW })
    assert.deepEqual(r.map((x) => x.kind), ['source_stale'])
  })

  test('a lag that is not declared (NULL, O1) is not judged; a source inside its lag is quiet', () => {
    assert.deepEqual(checkSources({ sources: [src('a', '2020-01-01T00:00:00Z')], channels: [ch('a', null)], now: NOW }), [])
    assert.deepEqual(checkSources({ sources: [src('a', '2026-11-30T11:55:00Z')], channels: [ch('a', 600)], now: NOW }), [])
  })
})

// ── run ─────────────────────────────────────────────────────────────────────
const CHANNEL = { tenant_slug: 'febor', source_key: 'febor.web', org_id: 'org-1', channel_id: 'ch-1', lag_seconds: 600 }
function harness({ failAtStep = null, channels = [CHANNEL], stageResult = { 'org-1': { staged: 0, mapped: 0, error: 'memberRefsSeen is not available: miembros_vistos' } } } = {}) {
  const logs = []; const calls = { feeder: [], stage: [], made: null, ended: false, stored: { closed: false } }
  const store = {
    watermark: async () => new Date('2026-11-30T10:07:30Z'),
    sourceWatermarks: async () => [{ source: 'febor.web', ingestedUntil: new Date('2026-11-30T10:07:30Z') }],
    report: () => ({ requests: 3, warnings: [], anomalies: [] }),
    close: () => { calls.stored.closed = true },
  }
  const deps = {
    log: (o) => logs.push(o), readText, now: () => new Date('2026-11-30T10:10:00Z'),
    connect: async () => ({ end: async () => { calls.ended = true } }),
    readMaps: async () => ({ channelByKey: new Map(channels.map((c) => [c.source_key, c])) }),
    makeStore: (cfg) => { calls.made = cfg; return store },
    runFeeder: async (_db, _store, opts) => {
      calls.feeder.push(opts)
      if (failAtStep === calls.feeder.length) throw Object.assign(new Error('boom'), { code: 'timeout' })
      return { unmappedEvents: 2, unresolvedAgentRefs: 1, watermark: new Date('2026-11-30T10:07:30Z'), written: {} }
    },
    stageMemberRefs: async (...a) => { calls.stage.push(a); return stageResult },
  }
  return { logs, calls, deps }
}

describe('run', () => {
  test('an ordinary run: the lookback up to the watermark on the grain, as the box\'s tenant', async () => {
    const h = harness()
    const r = await run({ env: ENV, argv: [], deps: h.deps })
    assert.equal(r.exitCode, 0)
    assert.equal(h.calls.feeder.length, 1)
    assert.equal(h.calls.feeder[0].to, '2026-11-30T10:05:00.000Z')
    assert.equal(h.calls.feeder[0].from, '2026-11-29T10:05:00.000Z')
    assert.equal(h.calls.feeder[0].boxTenant, 'febor', 'without boxTenant another tenant\'s event could be mapped')
  })

  test('the store is built with the sources of BOb\'s channels, and closed', async () => {
    const h = harness()
    await run({ env: ENV, argv: [], deps: h.deps })
    assert.deepEqual(h.calls.made.sources, ['febor.web'])
    assert.equal(h.calls.made.tenant, 'febor')
    assert.ok(h.calls.stored.closed && h.calls.ended)
  })

  test('BOB_VECINOS_SOURCES overrides them', async () => {
    const h = harness()
    await run({ env: { ...ENV, BOB_VECINOS_SOURCES: 'a, b' }, argv: [], deps: h.deps })
    assert.deepEqual(h.calls.made.sources, ['a', 'b'])
  })

  test('a rebuild is stepped, and the knobs reach runFeeder', async () => {
    const h = harness()
    const env = { ...ENV, BOB_FEEDER_READ_AHEAD_SECONDS: '3600', BOB_FEEDER_CONTEXT_SECONDS: '7200' }
    const r = await run({ env, argv: ['--from', '2026-11-01T00:00:00Z', '--to', '2026-11-04T00:00:00Z'], deps: h.deps })
    assert.equal(r.exitCode, 0)
    assert.equal(h.calls.feeder.length, 3)
    assert.deepEqual(h.calls.feeder.map((c) => c.readAheadSeconds), [3600, 3600, 3600])
    assert.deepEqual(h.calls.feeder.map((c) => c.contextSeconds), [7200, 7200, 7200])
  })

  test('an interrupted rebuild says where to resume, and stops: the steps before it are committed', async () => {
    const h = harness({ failAtStep: 2 })
    const r = await run({ env: ENV, argv: ['--from', '2026-11-01T00:00:00Z', '--to', '2026-11-04T00:00:00Z'], deps: h.deps })
    assert.equal(r.exitCode, 1)
    assert.equal(h.calls.feeder.length, 2, 'the third step must not run after the second failed')
    const failed = h.logs.find((l) => l.event === 'step_failed')
    assert.equal(failed.step, 2)
    assert.equal(failed.code, 'timeout')
    assert.equal(failed.resume, '--from 2026-11-02T00:00:00.000Z --to 2026-11-04T00:00:00.000Z')
    assert.equal(h.logs.filter((l) => l.event === 'step_done').length, 1)
    assert.ok(h.calls.stored.closed && h.calls.ended, 'it closes what it opened even when it fails')
  })

  test('member refs are not staged unless asked; asked, the refusal is reported and the run still succeeds', async () => {
    const h = harness()
    assert.equal((await run({ env: ENV, argv: [], deps: h.deps })).exitCode, 0)
    assert.equal(h.calls.stage.length, 0)
    const g = harness()
    const r = await run({ env: ENV, argv: ['--member-refs'], deps: g.deps })
    assert.equal(r.exitCode, 0)
    assert.equal(g.calls.stage.length, 1)
    assert.equal(g.calls.stage[0][2].boxTenant, 'febor')
    const bad = g.logs.find((l) => l.event === 'member_refs_failed')
    assert.match(bad.error, /memberRefsSeen/)
    assert.equal(bad.orgId, 'org-1')
  })

  test('with no channel for the tenant it does not run: there is nothing to feed, and it says so', async () => {
    const h = harness({ channels: [{ ...CHANNEL, tenant_slug: 'someone-else' }] })
    const r = await run({ env: ENV, argv: [], deps: h.deps })
    assert.equal(r.exitCode, 1)
    assert.equal(h.calls.feeder.length, 0)
    assert.ok(h.logs.some((l) => l.event === 'no_channels'))
  })

  test('a wrong configuration exits 2 before it touches anything', async () => {
    const h = harness()
    const env = { ...ENV }; delete env.BOB_VECINOS_TENANT
    const r = await run({ env, argv: [], deps: h.deps })
    assert.equal(r.exitCode, 2)
    assert.equal(h.calls.made, null)
  })

  test('warnings are printed, and the unmapped counts reach the report line', async () => {
    const h = harness({ channels: [CHANNEL, { ...CHANNEL, source_key: 'febor.voice', channel_id: 'ch-2' }] })
    await run({ env: ENV, argv: [], deps: h.deps })
    assert.ok(h.logs.some((l) => l.event === 'warning' && l.kind === 'channel_without_source' && l.source === 'febor.voice'))
    assert.equal(h.logs.find((l) => l.event === 'step_done').unmappedEvents, 2)
  })

  test('no log line carries a credential', async () => {
    for (const failAtStep of [null, 1]) {
      const h = harness({ failAtStep })
      await run({ env: ENV, argv: ['--member-refs'], deps: h.deps })
      const text = JSON.stringify(h.logs)
      for (const secret of ['hunter2', SECRET, 'KEY', 'CERT']) assert.ok(!text.includes(secret), secret)
    }
  })
})

describe('the documented environment', () => {
  // .env.example is the definition (CLAUDE.md): every variable the entry point reads is in it.
  test('.env.example names every BOB_VECINOS_* and BOB_FEEDER_* variable main.mjs reads', () => {
    const code = readFileSync(resolve(REPO_ROOT, 'feeder/main.mjs'), 'utf8')
    const read = [...new Set([...code.matchAll(/\b(BOB_(?:VECINOS|FEEDER)_[A-Z_]+)\b/g)].map((m) => m[1]))]
    assert.ok(read.length >= 15, `found only ${read.length} variables in main.mjs`)
    const doc = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8')
    for (const v of read) assert.match(doc, new RegExp(`^#?\\s*${v}=`, 'm'), `${v} is not in .env.example`)
  })
})
