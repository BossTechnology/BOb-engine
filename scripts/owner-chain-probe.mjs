#!/usr/bin/env node
// O-3 (D77): apply the migration chain as bob_migrador, not as postgres, over
// a Supabase database with no BOb in it.
//
//   ADMIN_URL=postgresql://postgres:…@host:port/postgres CHAIN_DIR=<dir> \
//   PROVISION=supabase/provision/bob-vecina.sql node scripts/owner-chain-probe.mjs
//
// 1. postgres applies PROVISION, one statement at a time; a statement postgres
//    cannot run is reported (it could not go in bob.sql as written).
// 2. bob_migrador applies the chain, each migration in its own transaction,
//    and stops at the first one it cannot apply.
// 3. What bob_migrador owns, and may do, outside `bob` once it is done.
// Exits 1 if anything stopped. It changes the database it points at: never a
// customer box.

import pg from 'pg'
import { readFileSync, readdirSync } from 'node:fs'

const adminUrl = process.env.ADMIN_URL
const dir = process.env.CHAIN_DIR
const prov = process.env.PROVISION
if (!adminUrl || !dir || !prov) { console.error('ADMIN_URL, CHAIN_DIR and PROVISION are required'); process.exit(2) }
const PASSWORD = 'bob_migrador-local-test'
let failed = false

const admin = new pg.Client({ connectionString: adminUrl })
await admin.connect()
console.log('== what postgres may grant on what the chain touches')
const { rows: can } = await admin.query(`
  SELECT 'schema ' || s AS obj, p, has_schema_privilege('postgres', s, p || ' WITH GRANT OPTION') AS grantable
    FROM unnest(ARRAY['auth','public','extensions']) s, unnest(ARRAY['USAGE','CREATE']) p
  UNION ALL
  SELECT 'table auth.users', p, has_table_privilege('postgres', 'auth.users', p || ' WITH GRANT OPTION')
    FROM unnest(ARRAY['SELECT','TRIGGER','REFERENCES']) p
  UNION ALL
  SELECT 'function ' || f, 'EXECUTE', has_function_privilege('postgres', f, 'EXECUTE WITH GRANT OPTION')
    FROM unnest(ARRAY['auth.jwt()','auth.uid()']) f`)
for (const r of can) console.log(`${r.grantable ? 'can ' : 'cannot'} grant ${r.p} on ${r.obj}`)
const { rows: [own] } = await admin.query(`SELECT
  (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'auth') AS auth,
  (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public') AS public,
  (SELECT relowner::regrole::text FROM pg_class WHERE oid = 'auth.users'::regclass) AS users,
  (SELECT pubowner::regrole::text FROM pg_publication WHERE pubname = 'supabase_realtime') AS pub`)
console.log(`owners: schema auth ${own.auth}, schema public ${own.public}, auth.users ${own.users}, supabase_realtime ${own.pub}`)
// A GRANT without the grant option only warns; it is reported as a failure here.
const warnings = []
admin.on('notice', (n) => warnings.push(n.message))
console.log('== provisioning, as postgres')
// Statements end at a semicolon closing a line; the file holds no bodies.
const statements = readFileSync(prov, 'utf8').replace(/--.*$/gm, '').split(/;\s*$/m)
  .map((s) => s.trim()).filter(Boolean)
for (const s of statements) {
  try {
    warnings.length = 0
    await admin.query(s)
    const w = warnings.filter((m) => /privileges? (were|was) (not )?granted|no privileges/i.test(m))
    if (w.length) { failed = true; console.log(`FAIL ${s.split('\n')[0]}\n    warning: ${w.join('; ')}`) }
    else console.log(`ok   ${s.split('\n')[0]}`)
  }
  catch (e) { failed = true; console.log(`FAIL ${s.split('\n')[0]}\n    ${e.code} ${e.message}`) }
}
await admin.query(`ALTER ROLE bob_migrador PASSWORD '${PASSWORD}'`)

const url = new URL(adminUrl)
url.username = 'bob_migrador'
url.password = PASSWORD
const owner = new pg.Client({ connectionString: url.toString() })
await owner.connect()
console.log('== the chain, as bob_migrador')
for (const f of readdirSync(dir).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort()) {
  try {
    await owner.query(readFileSync(`${dir}/${f}`, 'utf8'))
    await owner.query('ROLLBACK').catch(() => {}) // a file that left a transaction open
    console.log(`ok   ${f}`)
  } catch (e) {
    failed = true
    await owner.query('ROLLBACK').catch(() => {})
    console.log(`STOP ${f}\n    ${e.code} ${e.message}${e.where ? `\n    at ${e.where.split('\n')[0]}` : ''}`)
    break
  }
}
await owner.end()

console.log('== what bob_migrador holds outside bob')
const { rows: owns } = await admin.query(`
  SELECT n.nspname || '.' || c.relname AS obj, c.relkind::text AS kind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relowner = 'bob_migrador'::regrole AND n.nspname <> 'bob' AND c.relkind <> 'S'
  UNION ALL
  SELECT p.oid::regprocedure::text, 'function' FROM pg_proc p
   WHERE p.proowner = 'bob_migrador'::regrole
     AND p.pronamespace <> (SELECT oid FROM pg_namespace WHERE nspname = 'bob')
  UNION ALL
  SELECT 'publication ' || pubname, 'publication' FROM pg_publication WHERE pubowner = 'bob_migrador'::regrole
  ORDER BY 1`)
for (const r of owns) console.log(`owns ${r.kind} ${r.obj}`)
const { rows: privs } = await admin.query(`
  SELECT n.nspname, string_agg(p, ',') AS privs FROM pg_namespace n,
         unnest(ARRAY['USAGE','CREATE']) p
   WHERE n.nspname NOT IN ('bob') AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
     AND has_schema_privilege('bob_migrador', n.oid, p)
   GROUP BY 1 ORDER BY 1`)
for (const r of privs) console.log(`may  ${r.privs} on schema ${r.nspname}`)
await admin.end()
process.exit(failed ? 1 : 0)
