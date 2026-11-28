// The truth store of task 3.7: the second implementation of the interface that
// MemoryTruthStore defines, reading through `bzzz-vecinos` instead of memory.
//
// `bzzz-vecinos` is the box's read service for its neighbour applications:
// `GET /v1/<app>/<view>?<parameters>` over HTTPS with mutual TLS, no SQL, a
// cursor that is opaque and signed (Bzzz, docs/OPERACION_vecinos.md §1, §5).
// This store speaks to two of its views, the two Wednesday needs:
//
//   v1/bob/eventos        the rows. Window [desde, hasta) by EVENT time, aligned
//                         to five minutes, paged by one key (`clave`), `limite`
//                         up to 500.
//   v1/bob/marca_de_agua  per source: the latest ingested_at and the latest
//                         event time, over the last `dias` days.
//
// The interface the feeder uses (reference-feeder.mjs):
//   watermark()            how far the truth store is complete (§4)
//   events({from, to})     the events with from <= event_time < to
//   memberRefsSeen(...)    NOT covered: see MemberRefsNotAvailable
//
// What it decides, in the open:
//   - The window. `events()` cuts [from, to) into windows of `windowSeconds`
//     (configuration, never a constant: Febor's density is not the bench's) and
//     pages each one. A window of ninety days in one query fails on the reader's
//     memory (docs/OPERACION_vecinos.md §5.1); one day fits.
//   - The watermark. Per source, `ingerido_hasta` (the latest ingested_at). The
//     store's watermark is the MINIMUM across the sources: the slowest one is
//     what makes a bucket complete. The watermark does not decide when to seal,
//     the channel's declared lag does; it is what lets the feeder check that
//     the declaration still holds, so a source that is expected and missing, or
//     one that was not expected, is reported (`report().warnings`), not left out
//     in silence.
//   - Order. The feeder's response-time rule depends on the order of events. The
//     store sorts what it collects by (event_time, clave) and does not rely on the
//     order of the view; it counts where the view broke its own order
//     (`report().anomalies`), which is the open question to Federico.
//   - Retry. 429 and 503, and a connection that dies or times out, are retried
//     with a wait (Retry-After if the service sends one) up to `maxRetries`, and
//     the retry asks for the SAME page again with the same cursor, so a cut costs
//     one page, not the window. What is not retried is reported, with the
//     service's own `error` code.
//
// Known limits, stated where a reader will meet them:
//   - `value` arrives as 0 when it was missing: that is how the ingestion view
//     stores it, and the view cannot tell the two apart (BZZ-19, Henry 27 Nov,
//     accepted by Federico 28 Nov as a known limit). The store passes `value`
//     through as it came and never reads it. The feeder does not read it either.
//     Whoever first reads a zero from `value` is looking at "0 or absent".
//   - A cursor lives as long as the call: it is not saved anywhere. A call that
//     fails after its retries starts over from the first page of its window when
//     it is made again. See docs/p5-application-layer.md §5.2 and feeder/README.md
//     for what that means for an interrupted rebuild.
//   - Nothing here tells test events from real ones: nobody has decided where
//     that is marked.

import https from 'node:https'
import { readFileSync } from 'node:fs'

const FIVE_MINUTES_MS = 300_000
export const DEFAULT_WINDOW_SECONDS = 86_400
export const MAX_PAGE_LIMIT = 500
const WATERMARK_PAGE_LIMIT = 100

export class VecinosError extends Error {
  constructor(code, message, { status = null, detail = null } = {}) {
    super(message)
    this.name = 'VecinosError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

// §7.3a is `v1/bob/miembros_vistos`, which Wednesday does not use (ghost
// creation on Febor is blocked by the E.164 precondition). Calling it is an
// error that says so, never an empty answer: an empty list would read as "no
// member was seen".
export class MemberRefsNotAvailable extends VecinosError {
  constructor() {
    super('member_refs_not_available',
      'memberRefsSeen is not available on the vecinos store: v1/bob/miembros_vistos is not wired ' +
      '(it waits for the E.164 cutover that unblocks ghost creation). Nothing was read and nothing is staged.')
    this.name = 'MemberRefsNotAvailable'
  }
}

const alignDown = (ms) => Math.floor(ms / FIVE_MINUTES_MS) * FIVE_MINUTES_MS
const alignUp = (ms) => Math.ceil(ms / FIVE_MINUTES_MS) * FIVE_MINUTES_MS
const isoZ = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

// ClickHouse answers DateTime in UTC without a zone: `2026-11-24 10:05:00.123`.
// Anything with a zone is taken as it is. A value that is not a time is an error:
// a wrong time would put an event in the wrong bucket without any failure.
export function parseTime(v, what = 'time') {
  if (typeof v !== 'string') throw new VecinosError('shape', `${what}: not a string: ${JSON.stringify(v)}`)
  const s = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v
  const t = new Date(s)
  if (!/^\d{4}-\d\d-\d\dT/.test(s) || Number.isNaN(t.getTime())) {
    throw new VecinosError('shape', `${what}: not a time: ${JSON.stringify(v)}`)
  }
  return t
}

const REQUIRED_EVENT_COLUMNS = ['clave', 'timestamp', 'correlation_id', 'tenant', 'source', 'event_name', 'attributes']
const REQUIRED_WATERMARK_COLUMNS = ['fuente', 'ingerido_hasta', 'evento_hasta']

export class VecinosTruthStore {
  // baseUrl   https://host:port of bzzz-vecinos
  // ca, cert, key   PEM text (the CA of the vecinas, BOb's client certificate)
  // tenant    the box's own `bzzz.tenant`; the store does not send it (the box
  //           sets it) and drops nothing by it: runFeeder's boxTenant is what
  //           refuses another tenant's event, and the entry point sets it.
  // sources   optional: the `source`s the box's channels use. The watermark is
  //           the minimum over these; a missing one is reported.
  constructor({
    baseUrl, ca, cert, key, tenant = null, sources = null,
    windowSeconds = DEFAULT_WINDOW_SECONDS, pageLimit = MAX_PAGE_LIMIT,
    watermarkDays = 2, timeoutMs = 30_000, maxRetries = 3, retryBaseMs = 1_000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    if (!baseUrl) throw new Error('VecinosTruthStore needs baseUrl')
    for (const [n, v] of Object.entries({ ca, cert, key })) {
      if (!v) throw new Error(`VecinosTruthStore needs ${n}: the service requires mutual TLS`)
    }
    if (!(Number.isInteger(windowSeconds) && windowSeconds > 0 && windowSeconds % 300 === 0)) {
      throw new Error(`windowSeconds must be a positive multiple of 300 (five minutes), got ${windowSeconds}`)
    }
    if (!(Number.isInteger(pageLimit) && pageLimit >= 1 && pageLimit <= MAX_PAGE_LIMIT)) {
      throw new Error(`pageLimit must be 1 to ${MAX_PAGE_LIMIT}, got ${pageLimit}`)
    }
    if (!(Number.isInteger(watermarkDays) && watermarkDays >= 1 && watermarkDays <= 30)) {
      throw new Error(`watermarkDays must be 1 to 30, got ${watermarkDays}`)
    }
    this.baseUrl = new URL(baseUrl)
    this.tenant = tenant
    this.sources = sources ? [...sources] : null
    this.windowSeconds = windowSeconds
    this.pageLimit = pageLimit
    this.watermarkDays = watermarkDays
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.retryBaseMs = retryBaseMs
    this._sleep = sleep
    this._agent = new https.Agent({ ca, cert, key, keepAlive: true, rejectUnauthorized: true })
    this._report = { requests: 0, retries: 0, pages: 0, windows: 0, anomalies: [], warnings: [] }
  }

  close() { this._agent.destroy() }

  // What the store saw, for the entry point to print. Cleared by `resetReport`.
  report() { return structuredClone(this._report) }
  resetReport() {
    this._report = { requests: 0, retries: 0, pages: 0, windows: 0, anomalies: [], warnings: [] }
  }

  // §7.3a, not covered by the two views.
  async memberRefsSeen() { throw new MemberRefsNotAvailable() }

  // ── watermark ────────────────────────────────────────────────────────────
  // The minimum of `ingerido_hasta` across the sources. `sourceWatermarks()` is
  // the per-source reading, for whoever wants to compare it with a channel's lag.
  async watermark() {
    const rows = await this.sourceWatermarks()
    const expected = this.sources
    if (expected) {
      for (const s of expected) {
        if (!rows.some((r) => r.source === s)) {
          this._warn('source_missing', s,
            `source ${s} is expected and v1/bob/marca_de_agua has no row for it in the last ${this.watermarkDays} days`)
        }
      }
      for (const r of rows) {
        if (!expected.includes(r.source)) {
          this._warn('source_unexpected', r.source,
            `source ${r.source} is in the box and in no channel: its rows are not mapped`)
        }
      }
    }
    const counted = expected ? rows.filter((r) => expected.includes(r.source)) : rows
    if (counted.length === 0) {
      throw new VecinosError('no_watermark',
        'v1/bob/marca_de_agua has no row for any expected source: the store cannot say how far it is complete')
    }
    return new Date(Math.min(...counted.map((r) => r.ingestedUntil.getTime())))
  }

  async sourceWatermarks() {
    const out = []
    // marca_de_agua pages up to 100 rows (max_filas of the view), not 500.
    await this._pages('marca_de_agua', { dias: String(this.watermarkDays) }, REQUIRED_WATERMARK_COLUMNS,
      Math.min(this.pageLimit, WATERMARK_PAGE_LIMIT), (row) => out.push({
        source: row.fuente,
        ingestedUntil: parseTime(row.ingerido_hasta, 'ingerido_hasta'),
        eventUntil: parseTime(row.evento_hasta, 'evento_hasta'),
      }))
    return out
  }

  // ── events ───────────────────────────────────────────────────────────────
  // from <= event_time < to. The service wants windows on the five-minute
  // grain, and `to` is often a watermark that is not on it: the windows cover
  // [alignDown(from), alignUp(to)) and what falls outside [from, to) is dropped.
  async events({ from, to }) {
    const lo = new Date(from).getTime()
    const hi = new Date(to).getTime()
    if (Number.isNaN(lo) || Number.isNaN(hi)) throw new Error('events({from, to}) needs two times')
    if (hi <= lo) return []
    const step = this.windowSeconds * 1000
    const seen = new Set()
    const events = []
    for (let start = alignDown(lo); start < alignUp(hi); start += step) {
      const end = Math.min(start + step, alignUp(hi))
      this._report.windows++
      let last = null
      await this._pages('eventos', { desde: isoZ(start), hasta: isoZ(end) }, REQUIRED_EVENT_COLUMNS,
        this.pageLimit, (row) => {
        // The view promises ascending `clave`, one row per clave. It is read, not trusted.
        if (last !== null && row.clave <= last) {
          this._report.anomalies.push({ kind: row.clave === last ? 'repeated_clave' : 'clave_out_of_order',
            clave: row.clave, after: last })
        }
        last = row.clave
        if (seen.has(row.clave)) return        // a repeat would count twice
        seen.add(row.clave)
        const e = this._toEvent(row)
        const t = new Date(e.event_time).getTime()
        if (t >= lo && t < hi) events.push(e)
      })
    }
    // The feeder reads in the order it is given. Do not rely on the view's.
    events.sort((a, b) => (a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1
      : a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0))
    return events
  }

  _toEvent(r) {
    let attributes = r.attributes
    if (typeof attributes === 'string') {
      try { attributes = JSON.parse(attributes) } catch { /* below */ }
    }
    if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
      throw new VecinosError('shape', `attributes of ${r.clave} is not an object`)
    }
    return {
      // The shape of a business event, as MemoryTruthStore holds it:
      event_time: parseTime(r.timestamp, 'timestamp').toISOString(),
      'bzzz.tenant': r.tenant,
      source_key: r.source,              // SR-2: channels.source_key = bzzz.source
      correlation_id: r.correlation_id,
      event_name: r.event_name,
      attributes,
      // What else the view carries, passed through and not read by the feeder:
      clave: r.clave,
      event_id: r.event_id ?? null,
      entity_id: r.entity_id ?? null,
      entity_type: r.entity_type ?? null,
      signal_class: r.signal_class ?? null,
      value: r.value ?? null,            // 0 may mean "missing": see the header
      ingested_at: r.ingested_at ? parseTime(r.ingested_at, 'ingested_at').toISOString() : null,
    }
  }

  // ── paging ───────────────────────────────────────────────────────────────
  // Every page of one view call, each row handed to `onRow` as an object built
  // from the response's own `columnas`. The cursor is the service's, opaque.
  async _pages(view, params, required, limit, onRow) {
    let cursor = null
    for (;;) {
      const body = await this._get(view, { ...params, limite: String(limit), ...(cursor ? { cursor } : {}) })
      const cols = body?.columnas
      if (!Array.isArray(cols) || !Array.isArray(body.filas)) {
        throw new VecinosError('shape', `${view}: the answer has no columnas and filas`)
      }
      for (const c of required) {
        if (!cols.includes(c)) throw new VecinosError('shape', `${view}: the answer has no column ${c}`)
      }
      this._report.pages++
      for (const fila of body.filas) {
        const row = {}
        cols.forEach((c, i) => { row[c] = fila[i] })
        onRow(row)
      }
      const next = body.siguiente ?? null
      if (next === null) return
      if (typeof next !== 'string' || next === cursor) {
        throw new VecinosError('cursor_loop', `${view}: the service gave the same cursor twice: this would not end`)
      }
      cursor = next
    }
  }

  _warn(kind, source, message) {
    if (!this._report.warnings.some((w) => w.kind === kind && w.source === source)) {
      this._report.warnings.push({ kind, source, message })
    }
  }

  // One GET with its retries. Each attempt is the same request, so a retry of a
  // page is the same page.
  async _get(view, params) {
    const path = `/v1/bob/${view}?${new URLSearchParams(params)}`
    let attempt = 0
    for (;;) {
      this._report.requests++
      let failure
      try {
        const res = await this._request(path)
        if (res.status === 200) return res.json
        failure = this._failure(view, res)
        if (!failure.retry) throw failure.error
      } catch (e) {
        if (e instanceof VecinosError && !e.retryable) throw e
        // A socket error or a timeout: the service may be back in a moment.
        const error = e instanceof VecinosError ? e
          : new VecinosError('network', `${view}: ${e.code ?? e.message}`)
        failure = { error, retry: true, waitMs: null }
      }
      if (attempt >= this.maxRetries) throw failure.error
      attempt++
      this._report.retries++
      await this._sleep(failure.waitMs ?? this.retryBaseMs * 2 ** (attempt - 1))
    }
  }

  _failure(view, res) {
    const code = res.json?.error ?? 'http_error'
    const error = new VecinosError(code, `${view}: ${res.status} ${code}${res.json?.detalle ? `: ${res.json.detalle}` : ''}`,
      { status: res.status, detail: res.json?.detalle ?? null })
    const retry = res.status === 429 || res.status === 503
    const ra = Number(res.headers['retry-after'])
    return { error, retry, waitMs: retry && Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null }
  }

  _request(path) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        agent: this._agent, method: 'GET', hostname: this.baseUrl.hostname,
        port: this.baseUrl.port || 443, path, headers: { accept: 'application/json' },
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(text) } catch { /* not JSON: left null */ }
          if (res.statusCode === 200 && json === null) {
            return reject(new VecinosError('shape', `${path.split('?')[0]}: a 200 that is not JSON`))
          }
          resolve({ status: res.statusCode, headers: res.headers, json })
        })
      })
      // The whole request, not the gap between bytes: the service itself cuts at 20 s.
      const timer = setTimeout(() => {
        const e = new VecinosError('timeout', `${path.split('?')[0]}: no answer in ${this.timeoutMs} ms`)
        e.retryable = true
        req.destroy(e)
      }, this.timeoutMs)
      req.on('close', () => clearTimeout(timer))
      req.on('error', reject)
      req.end()
    })
  }
}

// What the entry point reads from files and the environment to build the store.
export function readPem(path, what) {
  try { return readFileSync(path, 'utf8') } catch (e) {
    throw new Error(`${what}: cannot read ${path}: ${e.code ?? e.message}`)
  }
}
