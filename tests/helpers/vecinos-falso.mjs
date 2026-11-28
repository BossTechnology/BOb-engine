// A fake bzzz-vecinos for the tests: HTTPS with mutual TLS, serving the two
// views of task 3.7 as the real service answers them
// (Bzzz, vecinos/servicio/servidor.py and vistas.py, read on 2026-11-28):
//
//   GET /v1/bob/eventos?desde&hasta[&fuente]&limite[&cursor]
//   GET /v1/bob/marca_de_agua?dias&limite[&cursor]
//
// What it copies from the service, because the store would otherwise be tested
// against a friendlier server than the real one:
//   - a parameter that is not declared, repeated or ill-formed is 400
//     `parametro_invalido`; `tenant` is the box's, so asking for it is a 400;
//   - `desde` and `hasta` are ISO 8601 UTC on the five-minute grain;
//   - `limite` goes up to 500 (marca_de_agua: 100), 100 by default;
//   - the answer is {vista, columnas, filas, siguiente}, rows as arrays in the
//     order of `columnas`, `siguiente` an opaque cursor or null;
//   - a cursor is tied to the view and its parameters: another window's is 400
//     `cursor_invalido`;
//   - the client certificate must be signed by the vecinas' CA and its CN must be
//     an app; the rest is 401 or a closed handshake;
//   - ClickHouse's DateTime comes back as `YYYY-MM-DD hh:mm:ss.mmm`, UTC, no zone;
//   - `value` is 0 when the event had none (the ingestion view cannot tell).
// What it does not copy: the audit, the 20 s ceiling, the 4 MiB, the per-minute cap
// (a test scripts a 429 where it wants one).
//
// The certificates are made here, in a temporary directory, with openssl, and
// removed after: no key is committed.

import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sh = (args, cwd) => execFileSync('openssl', args, { cwd, stdio: 'pipe' })

function authority(dir, name) {
  sh(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`,
    '-subj', `/CN=${name}`, '-days', '2'], dir)
}
function leaf(dir, ca, name, cn, ext) {
  sh(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`], dir)
  writeFileSync(join(dir, `${name}.ext`), `${ext}\n`)
  sh(['x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`, '-CAcreateserial',
    '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.ext`], dir)
}

// The PEMs the tests need: the vecinas' CA, the server's pair, BOb's client pair,
// and a client pair from another CA, which the service must refuse.
export function makeCertificates() {
  const dir = mkdtempSync(join(tmpdir(), 'vecinos-falso-'))
  authority(dir, 'vecinas-ca')
  authority(dir, 'otra-ca')
  leaf(dir, 'vecinas-ca', 'servidor', 'localhost', 'subjectAltName=DNS:localhost,IP:127.0.0.1')
  leaf(dir, 'vecinas-ca', 'bob', 'bob', 'basicConstraints=CA:FALSE')
  leaf(dir, 'otra-ca', 'intruso', 'bob', 'basicConstraints=CA:FALSE')
  const pem = (n) => readFileSync(join(dir, n), 'utf8')
  const out = {
    ca: pem('vecinas-ca.pem'),
    server: { cert: pem('servidor.pem'), key: pem('servidor.key') },
    client: { cert: pem('bob.pem'), key: pem('bob.key') },
    intruder: { cert: pem('intruso.pem'), key: pem('intruso.key') },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  }
  return out
}

const pad = (n, w) => String(n).padStart(w, '0')
const chTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
const CAP = { eventos: 500, marca_de_agua: 100 }
const PARAMS = { eventos: ['desde', 'hasta', 'fuente', 'limite', 'cursor'], marca_de_agua: ['dias', 'limite', 'cursor'] }
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/

const COLUMNS = ['clave', 'timestamp', 'correlation_id', 'tenant', 'source', 'event_name', 'signal_class',
  'value', 'attributes', 'ingested_at', 'entity_id', 'entity_type', 'event_id']

// events: the feeder's event shape ({event_time, 'bzzz.tenant', source_key, correlation_id,
// event_name, attributes}), as the fixtures hold them. `value` is added as 0, as the view does.
export async function startFake({
  certs, events = [], sources = null, boxTenant = null, ingestedAfterMs = 1000, shuffle = false,
  orderBreak = null,
}) {
  const requests = []          // every request that got to HTTP: { view, query, path }
  const script = []            // behaviours consumed in order by matching requests
  const rows = () => events.map((e, i) => {
    const ms = new Date(e.event_time).getTime()
    const eventId = e.event_id ?? `ev-${pad(i, 8)}`
    return {
      ms, tenant: e['bzzz.tenant'], source: e.source_key,
      clave: `${pad(ms, 13)}|${eventId}`,
      cells: {
        timestamp: chTime(ms), correlation_id: e.correlation_id, tenant: e['bzzz.tenant'], source: e.source_key,
        event_name: e.event_name, signal_class: 'business', value: e.value ?? 0, attributes: e.attributes ?? {},
        ingested_at: chTime(ms + ingestedAfterMs), entity_id: e.entity_id ?? '', entity_type: e.entity_type ?? '',
        event_id: eventId,
      },
    }
  })

  const server = https.createServer({
    key: certs.server.key, cert: certs.server.cert, ca: certs.ca,
    requestCert: true, rejectUnauthorized: true,
  }, (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    const no = (status, error, detalle, headers) => send(status, { error, detalle }, headers)
    const cert = req.socket.getPeerCertificate()
    if (cert?.subject?.CN !== 'bob') return no(401, 'identidad_desconocida', 'ese CN no es una app')

    const url = new URL(req.url, 'https://x')
    const m = /^\/v1\/bob\/([a-z_]+)$/.exec(url.pathname)
    const view = m?.[1]
    if (!CAP[view]) return no(404, 'vista_desconocida', url.pathname)
    const query = {}
    for (const [k, v] of url.searchParams) {
      if (k in query) return no(400, 'parametro_invalido', `${k}: una sola vez`)
      if (!PARAMS[view].includes(k)) {
        return no(400, 'parametro_invalido', k === 'tenant' ? 'tenant: lo pone la caja, no se pide' : `${k}: la vista no tiene ese parametro`)
      }
      query[k] = v
    }
    requests.push({ view, query, path: req.url })

    // A scripted behaviour for this request, if one matches and is next.
    const i = script.findIndex((s) => (s.view ?? view) === view && (!s.when || s.when(query, requests.length)))
    if (i >= 0) {
      const s = script.splice(i, 1)[0]
      if (s.destroy) return req.socket.destroy()
      if (s.hang) return undefined
      if (s.status) return no(s.status, s.error ?? 'demasiadas_peticiones', 'scripted', s.headers)
    }

    const limite = query.limite === undefined ? 100 : Number(query.limite)
    if (!(Number.isInteger(limite) && limite >= 1 && limite <= CAP[view])) {
      return no(400, 'parametro_invalido', `limite: 1 a ${CAP[view]}`)
    }
    let tag
    let all
    if (view === 'eventos') {
      for (const k of ['desde', 'hasta']) {
        if (!ISO.test(query[k] ?? '')) return no(400, 'parametro_invalido', `${k}: tiene que ser AAAA-MM-DDThh:mm:ssZ`)
        if (new Date(query[k]).getTime() % 300_000) return no(400, 'parametro_invalido', `${k}: tiene que estar alineado a 300 s`)
      }
      const lo = new Date(query.desde).getTime()
      const hi = new Date(query.hasta).getTime()
      tag = `eventos|${query.desde}|${query.hasta}|${query.fuente ?? ''}`
      all = rows().filter((r) => r.ms >= lo && r.ms < hi && (boxTenant === null || r.tenant === boxTenant)
        && (!query.fuente || r.source === query.fuente))
        .sort((a, b) => (a.clave < b.clave ? -1 : 1))
        .map((r) => ({ key: r.clave, cells: [r.clave, ...COLUMNS.slice(1).map((c) => r.cells[c])] }))
    } else {
      const dias = query.dias === undefined ? 2 : Number(query.dias)
      if (!(Number.isInteger(dias) && dias >= 1 && dias <= 30)) return no(400, 'parametro_invalido', 'dias: 1 a 30')
      tag = `marca_de_agua|${dias}`
      const bySource = new Map()
      const list = sources ?? [...new Set(rows().filter((r) => boxTenant === null || r.tenant === boxTenant)
        .map((r) => r.source))].map((fuente) => ({ fuente }))
      for (const s of list) {
        const mine = rows().filter((r) => r.source === s.fuente)
        const ingerido = s.ingerido_hasta ?? (mine.length ? chTime(Math.max(...mine.map((r) => r.ms)) + ingestedAfterMs) : null)
        const evento = s.evento_hasta ?? (mine.length ? chTime(Math.max(...mine.map((r) => r.ms))) : null)
        if (ingerido) bySource.set(s.fuente, [s.fuente, ingerido, evento])
      }
      all = [...bySource.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((c) => ({ key: c[0], cells: c }))
    }

    // The cursor: opaque, tied to the view and its parameters.
    let from = 0
    if (query.cursor !== undefined) {
      let c
      try { c = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) } catch { c = null }
      if (!c || c.tag !== tag) return no(400, 'cursor_invalido', 'no es de esta vista y estos parametros')
      from = all.findIndex((r) => r.key > c.last)
      if (from < 0) from = all.length
    }
    const page = all.slice(from, from + limite)
    let siguiente = null
    if (from + limite < all.length) {
      siguiente = Buffer.from(JSON.stringify({ tag, last: page.at(-1).key })).toString('base64url')
    }
    let filas = page.map((r) => r.cells)
    if (shuffle && view === 'eventos') filas = [...filas].reverse()           // a view that breaks its order
    if (orderBreak && view === 'eventos' && filas.length > 1) filas = [...filas, filas[0]]   // a repeated row
    const columnas = view === 'eventos' ? COLUMNS : ['fuente', 'ingerido_hasta', 'evento_hasta']
    send(200, { vista: `v1/bob/${view}`, columnas, filas, siguiente })
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `https://localhost:${server.address().port}`
  return {
    url, requests, script,
    setEvents(next) { events = next },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }),
  }
}
