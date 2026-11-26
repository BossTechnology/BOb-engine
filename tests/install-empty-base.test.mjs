// The empty base (Henry, «Defined empty base»; scripts/firma-instalacion.sh
// VACIA): a box where BOb was never installed holds it, and caja runs cadena
// from it with BOB_BASE_VACIA=1 (or =reanuda, the retry of a cadena that did
// not end well). instalar-bob.sh must then refuse a database with any trace of
// BOb, so a box with the chain applied cannot claim the empty base and skip
// the review of where it stands.
//
// This runs instalar-bob.sh cadena against the suite's database (the whole
// chain applied) and against scratch databases made here and dropped after.
// Nothing is pushed: `supabase` on PATH is a stub that only records it was
// reached. GITHUB_ACTIONS=true and INSTALAR_SIN_FIRMA=ci are set so the script
// runs outside a signed tree, as in CI's own job; on that path only,
// INSTALAR_PRUEBA_DB points the checks at a scratch database.
// Roles are the cluster's, not a database's: the suite's cluster has BOb's
// roles, so a fresh check here always finds them. Not measured here: a fresh
// check that passes, on a cluster with no BOb at all (the first install from
// the empty base is that measurement).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, realpathSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { REPO_ROOT, DB_URL } from './helpers/db.mjs'

const url = new URL(DB_URL)
const d = realpathSync(mkdtempSync(join(tmpdir(), 'base-vacia-')))
writeFileSync(join(d, 'postgres.env'), `POSTGRES_PASSWORD=${decodeURIComponent(url.password)}\n`); chmodSync(join(d, 'postgres.env'), 0o600)
const bin = join(d, 'bin'); mkdirSync(bin)
// Test stub for the supabase CLI: records that cadena reached the push.
writeFileSync(join(bin, 'supabase'), `#!/bin/sh\n# test stub, never the real CLI\necho "$*" > "${join(d, 'pushed')}"\n`); chmodSync(join(bin, 'supabase'), 0o755)

const versions = readdirSync(join(REPO_ROOT, 'supabase/migrations')).map((f) => f.match(/^(\d{14})_.*\.sql$/)?.[1]).filter(Boolean)
const chain = readFileSync(join(REPO_ROOT, 'supabase/provision/install-chain.sha256'), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/)[1].slice(0, 14))
const afterChain = versions.find((v) => !chain.includes(v))

const cadena = (env) => {
  spawnSync('rm', ['-f', join(d, 'pushed')])
  const r = spawnSync('bash', [join(REPO_ROOT, 'scripts/instalar-bob.sh'), 'cadena'], {
    cwd: REPO_ROOT, encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: d, LANG: 'C',
      INSTALAR_SIN_FIRMA: 'ci', GITHUB_ACTIONS: 'true', SUDO: '',
      POSTGRES_ENV: join(d, 'postgres.env'), POSTGRES_HOST: url.hostname, POSTGRES_PORT: url.port || '5432',
      // instalar-bob.sh writes its pgpass on tmpfs: /dev/shm on Linux; a private directory on macOS.
      ...(process.platform === 'linux' ? {} : { XDG_RUNTIME_DIR: d }),
      ...env,
    },
  })
  return { ...r, pushed: existsSync(join(d, 'pushed')) }
}
const refused = (r, ...why) => {
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /claims the empty base .*but its database already holds BOb/)
  for (const w of why) assert.match(r.stderr, w)
  assert.equal(r.pushed, false, 'nothing was pushed')
}
const passed = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); assert.ok(r.pushed, 'cadena reached the push') }

// A scratch database, as postgres: dropped when the file ends.
const admin = new pg.Client({ connectionString: DB_URL })
const made = []
async function scratch(sql = '') {
  const name = `bob_vacia_${process.pid}_${made.length}`
  await admin.query(`CREATE DATABASE ${name}`); made.push(name)
  const u = new URL(DB_URL); u.pathname = `/${name}`
  const c = new pg.Client({ connectionString: u.toString() }); await c.connect()
  if (sql) await c.query(sql)
  await c.end()
  return name
}
const history = (...vs) => `CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY);
  INSERT INTO supabase_migrations.schema_migrations VALUES ${vs.map((v) => `('${v}')`).join(', ')};`
let role = null
after(async () => {
  for (const n of made) await admin.query(`DROP DATABASE IF EXISTS ${n}`)
  if (role) await admin.query(`DROP ROLE IF EXISTS ${role}`)
  await admin.end()
})
await admin.connect()

test('control: without the empty base, the harness reaches the push', () => passed(cadena({})))

test('the suite\'s database, the chain applied: refused before the push, with what it found', () => {
  refused(cadena({ BOB_BASE_VACIA: '1' }), /role bob_app/, /schema bob/, /By kind: .*\b[1-9][0-9]* history\b/, /[1-9][0-9]* function/)
})

test('an empty database finds only the cluster\'s roles: nothing in the database itself', async () => {
  const r = cadena({ BOB_BASE_VACIA: '1', INSTALAR_PRUEBA_DB: await scratch() })
  refused(r, /role bob_app/)
  const found = r.stderr.split('\n').filter((l) => l.startsWith('  '))
  assert.ok(found.every((l) => l.startsWith('  role ')), found.join('\n'))
})

test('schema bob renamed and the history emptied: still found, by the names BOb creates', async () => {
  const db = await scratch(`CREATE SCHEMA bob_v1; CREATE TABLE bob_v1.proj_metric_counts (x int); CREATE TABLE bob_v1.actors (x int);
    CREATE FUNCTION public.custom_access_token_hook(e jsonb) RETURNS jsonb LANGUAGE sql AS 'SELECT e'; ${history()}`.replace('VALUES ;', 'SELECT 1 WHERE false;'))
  refused(cadena({ BOB_BASE_VACIA: '1', INSTALAR_PRUEBA_DB: db }), /relation bob_v1\.proj_metric_counts/, /relation bob_v1\.actors/, /function public\.custom_access_token_hook/)
})

test('a retry after a partial cadena: what the chain leaves is accepted', async () => {
  const db = await scratch(`CREATE SCHEMA bob; CREATE TABLE bob.actors (x int); ${history(chain[0], chain[1])}`)
  passed(cadena({ BOB_BASE_VACIA: 'reanuda', INSTALAR_PRUEBA_DB: db }))
})

test('a retry with a migration after the chain in the history: refused', async () => {
  const db = await scratch(history(chain[0], afterChain))
  refused(cadena({ BOB_BASE_VACIA: 'reanuda', INSTALAR_PRUEBA_DB: db }), new RegExp(`history outside the install chain ${afterChain}`))
})

test('a retry where resto ran: refused', async () => {
  const db = await scratch(`CREATE SCHEMA bob; CREATE TABLE bob.schema_migrations (version text);`)
  refused(cadena({ BOB_BASE_VACIA: 'reanuda', INSTALAR_PRUEBA_DB: db }), /resto ran/)
})

test('a retry with a bob_* role that can log in (an old credential): refused', async () => {
  role = `bob_prueba_${process.pid}`
  await admin.query(`CREATE ROLE ${role} LOGIN`)
  refused(cadena({ BOB_BASE_VACIA: 'reanuda', INSTALAR_PRUEBA_DB: await scratch() }), new RegExp(`role that can log in ${role}`))
  await admin.query(`DROP ROLE ${role}`); role = null
})
