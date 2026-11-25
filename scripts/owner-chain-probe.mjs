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
const saUrl = new URL(adminUrl); saUrl.username = 'supabase_admin'
const sa = new pg.Client({ connectionString: saUrl.toString() })
await sa.connect()
sa.on('notice', (n) => warnings.push(n.message))
for (const [who, client, file] of [['postgres', admin, prov], ['supabase_admin', sa, process.env.PROVISION_SA]]) {
  if (!file) continue
  console.log(`== provisioning, as ${who} (${file})`)
  // Statements end at a semicolon closing a line; the files hold no bodies.
  const statements = readFileSync(file, 'utf8').replace(/--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter(Boolean)
  for (const s of statements) {
    try {
      warnings.length = 0
      await client.query(s)
      const w = warnings.filter((m) => /privileges? (were|was) (not )?granted|no privileges/i.test(m))
      if (w.length) { failed = true; console.log(`FAIL ${s.split('\n')[0]}\n    warning: ${w.join('; ')}`) }
      else console.log(`ok   ${s.split('\n')[0]}`)
    } catch (e) { failed = true; console.log(`FAIL ${s.split('\n')[0]}\n    ${e.code} ${e.message}`) }
  }
}
await admin.query(`ALTER ROLE bob_migrador PASSWORD '${PASSWORD}'`)

const url = new URL(adminUrl)
url.username = 'bob_migrador'
url.password = PASSWORD
const owner = new pg.Client({ connectionString: url.toString() })
await owner.connect()
console.log('== the chain, as bob_migrador')
// What supabase_admin owns outside the system schemas, to hand over what a
// fallback creates, as a run that had passed would have left it.
const OWNED = `
  SELECT CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS kind,
         format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relowner = 'supabase_admin'::regrole AND c.relkind IN ('r','p','v','m')
     AND n.nspname IN ('public','bob')
  UNION ALL
  SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, p.oid::regprocedure::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proowner = 'supabase_admin'::regrole AND n.nspname IN ('public','bob')
  UNION ALL
  SELECT 'TYPE', format('%I.%I', n.nspname, t.typname) FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE t.typowner = 'supabase_admin'::regrole AND t.typtype IN ('e','d') AND n.nspname IN ('public','bob')
  UNION ALL
  SELECT 'SCHEMA', quote_ident(nspname) FROM pg_namespace
   WHERE nspowner = 'supabase_admin'::regrole AND nspname = 'bob'`
const stops = []
for (const f of readdirSync(dir).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort()) {
  const sql = readFileSync(`${dir}/${f}`, 'utf8')
  try {
    await owner.query(sql)
    await owner.query('ROLLBACK').catch(() => {}) // a file that left a transaction open
    console.log(`ok   ${f}`)
  } catch (e) {
    failed = true
    await owner.query('ROLLBACK').catch(() => {})
    stops.push(f)
    console.log(`STOP ${f}\n    ${e.code} ${e.message}${e.where ? `\n    at ${e.where.split('\n')[0]}` : ''}`)
    // Go on: supabase_admin applies it, and what it made goes to bob_migrador.
    const before = new Set((await sa.query(OWNED)).rows.map((r) => `${r.kind} ${r.name}`))
    try { await sa.query(sql) } catch (err) {
      await sa.query('ROLLBACK').catch(() => {})
      console.log(`    and supabase_admin cannot apply it either: ${err.code} ${err.message}; the probe ends here`)
      break
    }
    for (const r of (await sa.query(OWNED)).rows.filter((r) => !before.has(`${r.kind} ${r.name}`))) {
      await sa.query(`ALTER ${r.kind} ${r.name} OWNER TO bob_migrador`)
        .catch((err) => console.log(`    cannot hand ${r.kind} ${r.name} over: ${err.message}`))
    }
  }
}
console.log(`stopped at ${stops.length} migration(s): ${stops.join(', ') || 'none'}`)
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
await sa.end()
await admin.end()
process.exit(failed ? 1 : 0)
