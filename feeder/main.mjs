// The feeder's entry point: reads its configuration, builds the HTTPS truth
// store of task 3.7 and runs `runFeeder` against it. How it is invoked, what it
// reads and what it prints: feeder/README.md. Scheduling it belongs to the box's
// compose (Bob-New, deploy/caja), not to this repository.
//
//   node feeder/main.mjs                          the last BOB_FEEDER_LOOKBACK_SECONDS up to the watermark
//   node feeder/main.mjs --from ISO --to ISO      a window, or a rebuild: stepped, one transaction per tenant per step
//   node feeder/main.mjs --member-refs            also ask for member_refs_seen (not covered: reported, not fatal)
//
// Exit code: 0 the run completed; 1 a step failed (the line says where to resume);
// 2 the configuration is wrong. Warnings and anomalies do not change it: they are
// printed in the final report, because a quiet run and a run that noticed something
// must not look the same.
//
// It prints one JSON line per event to stdout, and never a credential: the files
// are named, the database URL is not echoed.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  VecinosTruthStore, VecinosError, DEFAULT_WINDOW_SECONDS, MAX_PAGE_LIMIT,
} from './vecinos-truth-store.mjs'
import {
  runFeeder, stageMemberRefs, readMaps, DEFAULT_CONTEXT_SECONDS, DEFAULT_FEEDER_VERSION,
} from './reference-feeder.mjs'

const FIVE_MINUTES_MS = 300_000
export class ConfigError extends Error {}

const int = (env, name, def, { min = 0, max = Infinity, multipleOf = 1 } = {}) => {
  const raw = env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max || n % multipleOf !== 0) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max === Infinity ? 'any' : max}` +
      `${multipleOf > 1 ? `, a multiple of ${multipleOf}` : ''}; got ${JSON.stringify(raw)}`)
  }
  return n
}

// Everything the entry point needs, from the environment and the files it names.
// `readText` is injected so a test does not need the files.
export function readConfig(env, readText = (p) => readFileSync(p, 'utf8')) {
  const need = (name) => {
    if (!env[name]) throw new ConfigError(`${name} is not set (see .env.example)`)
    return env[name]
  }
  const file = (name) => {
    const path = need(name)
    try { return readText(path) } catch (e) {
      throw new ConfigError(`${name}: cannot read ${path}: ${e.code ?? e.message}`)
    }
  }
  const url = need('BOB_VECINOS_URL')
  if (!/^https:\/\//.test(url)) throw new ConfigError('BOB_VECINOS_URL must be https:// : the service speaks mutual TLS')

  // The credential of bob_feeder: a file (a 600 file, P5 §3.4) wins over the variable.
  let dbUrl = env.BOB_FEEDER_DB_URL
  if (env.BOB_FEEDER_DB_URL_FILE) {
    try { dbUrl = readText(env.BOB_FEEDER_DB_URL_FILE).trim() } catch (e) {
      throw new ConfigError(`BOB_FEEDER_DB_URL_FILE: cannot read ${env.BOB_FEEDER_DB_URL_FILE}: ${e.code ?? e.message}`)
    }
  }
  if (!dbUrl) throw new ConfigError('BOB_FEEDER_DB_URL_FILE (or BOB_FEEDER_DB_URL) is not set (see .env.example)')

  return {
    // The box's own tenant. Required: it is what keeps another tenant's event out
    // of the projections (P5 §8, objection 3), so a run cannot start without it.
    tenant: need('BOB_VECINOS_TENANT'),
    sources: env.BOB_VECINOS_SOURCES ? env.BOB_VECINOS_SOURCES.split(',').map((s) => s.trim()).filter(Boolean) : null,
    dbUrl,
    store: {
      baseUrl: url,
      ca: file('BOB_VECINOS_CA_FILE'), cert: file('BOB_VECINOS_CERT_FILE'), key: file('BOB_VECINOS_KEY_FILE'),
      windowSeconds: int(env, 'BOB_VECINOS_WINDOW_SECONDS', DEFAULT_WINDOW_SECONDS, { min: 300, multipleOf: 300 }),
      pageLimit: int(env, 'BOB_VECINOS_PAGE_LIMIT', MAX_PAGE_LIMIT, { min: 1, max: MAX_PAGE_LIMIT }),
      watermarkDays: int(env, 'BOB_VECINOS_WATERMARK_DAYS', 2, { min: 1, max: 30 }),
      timeoutMs: int(env, 'BOB_VECINOS_TIMEOUT_MS', 30_000, { min: 1 }),
      maxRetries: int(env, 'BOB_VECINOS_MAX_RETRIES', 3, { min: 0, max: 20 }),
      retryBaseMs: int(env, 'BOB_VECINOS_RETRY_BASE_MS', 1_000, { min: 1 }),
    },
    feeder: {
      stepSeconds: int(env, 'BOB_FEEDER_STEP_SECONDS', 86_400, { min: 300, multipleOf: 300 }),
      lookbackSeconds: int(env, 'BOB_FEEDER_LOOKBACK_SECONDS', 86_400, { min: 300, multipleOf: 300 }),
      contextSeconds: int(env, 'BOB_FEEDER_CONTEXT_SECONDS', DEFAULT_CONTEXT_SECONDS, { min: 0 }),
      readAheadSeconds: env.BOB_FEEDER_READ_AHEAD_SECONDS ? int(env, 'BOB_FEEDER_READ_AHEAD_SECONDS', null, { min: 0 }) : null,
      version: env.BOB_FEEDER_VERSION || `${DEFAULT_FEEDER_VERSION}+vecinos`,
    },
  }
}

export function readArgs(argv) {
  const out = { from: null, to: null, memberRefs: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from' || a === '--to') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new ConfigError(`${a} needs a value`)
      out[a.slice(2)] = argv[++i]
    } else if (a === '--member-refs') out.memberRefs = true
    else throw new ConfigError(`unknown argument ${a}`)
  }
  if ((out.from === null) !== (out.to === null)) throw new ConfigError('--from and --to go together')
  for (const k of ['from', 'to']) {
    if (out[k] !== null) {
      const t = new Date(out[k]).getTime()
      if (Number.isNaN(t) || t % FIVE_MINUTES_MS !== 0) {
        throw new ConfigError(`--${k} ${out[k]} is not a time on a five-minute boundary`)
      }
    }
  }
  if (out.from !== null && !(new Date(out.to) > new Date(out.from))) throw new ConfigError('--from must be before --to')
  return out
}

// [from, to) cut in steps of `stepSeconds` from `from`, the last one shorter.
export function stepsOf(from, to, stepSeconds) {
  const out = []
  const end = new Date(to).getTime()
  for (let s = new Date(from).getTime(); s < end; s += stepSeconds * 1000) {
    out.push({ from: new Date(s).toISOString(), to: new Date(Math.min(s + stepSeconds * 1000, end)).toISOString() })
  }
  return out
}

// SR-2 says channels.source_key equals bzzz.source and nothing checks it: a
// source_key with no source returns nothing and looks like a quiet channel. This
// reads both sides. `sources`: what v1/bob/marca_de_agua lists; `channels`: BOb's
// channels of this tenant, with their declared lag (null when undeclared, O1).
export function checkSources({ sources, channels, now }) {
  const out = []
  const bySource = new Map(sources.map((s) => [s.source, s]))
  const keys = new Set(channels.map((c) => c.source_key))
  for (const c of channels) {
    const s = bySource.get(c.source_key)
    if (!s) {
      out.push({ kind: 'channel_without_source', source: c.source_key,
        message: `channel ${c.source_key} has no source in the box (or none with events in the last days): it reads as a quiet channel` })
      continue
    }
    // The declared lag is what seals; the watermark is what says it still holds.
    if (c.lag_seconds !== null && c.lag_seconds !== undefined &&
        s.ingestedUntil.getTime() < new Date(now).getTime() - c.lag_seconds * 1000) {
      out.push({ kind: 'source_stale', source: c.source_key,
        message: `source ${c.source_key} last ingested at ${s.ingestedUntil.toISOString()}, older than its declared lag of ${c.lag_seconds} s` })
    }
  }
  for (const s of sources) {
    if (!keys.has(s.source)) {
      out.push({ kind: 'source_without_channel', source: s.source,
        message: `source ${s.source} is in the box and in no channel of BOb: its events are not mapped` })
    }
  }
  return out
}

const floor5 = (ms) => Math.floor(ms / FIVE_MINUTES_MS) * FIVE_MINUTES_MS

// The run. `deps` is for the tests; the defaults are the real ones.
export async function run({ env = process.env, argv = process.argv.slice(2), deps = {} } = {}) {
  const log = deps.log ?? ((o) => process.stdout.write(`${JSON.stringify(o)}\n`))
  const now = deps.now ?? (() => new Date())
  let cfg; let args
  try {
    args = readArgs(argv)
    cfg = readConfig(env, deps.readText)
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    log({ event: 'config_error', message: e.message })
    return { exitCode: 2 }
  }

  const connect = deps.connect ?? (async (url) => {
    const { default: pg } = await import('pg')
    const c = new pg.Client({ connectionString: url })
    await c.connect()
    return c
  })
  const feeder = deps.runFeeder ?? runFeeder
  const stage = deps.stageMemberRefs ?? stageMemberRefs
  const makeStore = deps.makeStore ?? ((c) => new VecinosTruthStore(c))

  const db = await connect(cfg.dbUrl)
  let store
  try {
    // BOb's channels of this box: their source_keys are the sources the watermark is the minimum over.
    const maps = await (deps.readMaps ?? readMaps)(db)
    const channels = [...maps.channelByKey.values()].filter((c) => c.tenant_slug === cfg.tenant && c.source_key)
    if (channels.length === 0) {
      log({ event: 'no_channels', tenant: cfg.tenant,
        message: 'BOb has no channel with a source_key for this tenant: there is nothing to feed' })
      return { exitCode: 1 }
    }
    store = makeStore({ ...cfg.store, tenant: cfg.tenant,
      sources: cfg.sources ?? [...new Set(channels.map((c) => c.source_key))] })

    let from = args.from && new Date(args.from).toISOString()
    let to = args.to && new Date(args.to).toISOString()
    if (from === null) {
      // The ordinary run: the last lookback up to the watermark. A run that replays
      // a window is the same as one that fills it (§8.5), so it can overlap the last.
      const wm = await store.watermark()
      to = new Date(floor5(wm.getTime())).toISOString()
      from = new Date(new Date(to).getTime() - cfg.feeder.lookbackSeconds * 1000).toISOString()
    }
    const found = checkSources({ sources: await store.sourceWatermarks(), channels, now: now() })
    for (const w of found) log({ event: 'warning', ...w })

    const steps = stepsOf(from, to, cfg.feeder.stepSeconds)
    log({ event: 'start', tenant: cfg.tenant, from, to, steps: steps.length,
      windowSeconds: cfg.store.windowSeconds, stepSeconds: cfg.feeder.stepSeconds })
    const done = []
    for (const [i, step] of steps.entries()) {
      try {
        const r = await feeder(db, store, {
          from: step.from, to: step.to, boxTenant: cfg.tenant, feederVersion: cfg.feeder.version,
          contextSeconds: cfg.feeder.contextSeconds, readAheadSeconds: cfg.feeder.readAheadSeconds,
        })
        done.push({ ...step, unmappedEvents: r.unmappedEvents, unresolvedAgentRefs: r.unresolvedAgentRefs })
        log({ event: 'step_done', step: i + 1, of: steps.length, ...step,
          unmappedEvents: r.unmappedEvents, unresolvedAgentRefs: r.unresolvedAgentRefs,
          watermark: new Date(r.watermark).toISOString() })
      } catch (e) {
        // The steps before this one are committed (one transaction per tenant per step), and the
        // state of this one is untouched or whole. A replay of it is the same as its first run.
        log({ event: 'step_failed', step: i + 1, of: steps.length, ...step, code: e.code ?? null, message: e.message,
          resume: `--from ${step.from} --to ${to}` })
        log({ event: 'report', ok: false, ...store.report?.() })
        return { exitCode: 1, done }
      }
    }

    let memberRefs = 'skipped'
    if (args.memberRefs) {
      // Not covered by the two views of Wednesday: the store refuses, stageMemberRefs
      // catches it per tenant and says so. It does not stop the run.
      memberRefs = await stage(db, store, { from, to, boxTenant: cfg.tenant })
      for (const [orgId, r] of Object.entries(memberRefs)) {
        if (r.error) log({ event: 'member_refs_failed', orgId, staged: r.staged, error: r.error })
      }
    }
    log({ event: 'report', ok: true, steps: done.length, memberRefs, ...store.report?.() })
    return { exitCode: 0, done, memberRefs }
  } finally {
    store?.close?.()
    await db.end?.()
  }
}

// Run as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((r) => { process.exitCode = r.exitCode }).catch((e) => {
    // An error that is not the run's own (a bug, the database down): said, with a code.
    process.stdout.write(`${JSON.stringify({ event: 'fatal', code: e instanceof VecinosError ? e.code : null, message: e.message })}\n`)
    process.exitCode = 1
  })
}
