#!/usr/bin/env node
// O-3 (D77): apply the migration chain as bob_migrador, not as postgres, on a
// database that has Supabase and no BOb yet, and report every place it stops.
//
//   ADMIN_URL=postgresql://postgres:…@host:port/postgres \
//   CHAIN_DIR=<dir of migrations> [PROVISION=<sql postgres runs first>] \
//   node scripts/owner-chain-probe.mjs
//
// For each migration, in order, as bob_migrador, in its own transaction. When
// one fails, the failure is recorded, postgres applies that migration instead,
// and whatever it created is handed to bob_migrador, as a run that had passed
// would have left it. So one run lists every blocker, not only the first.
// Diagnostic: it changes the database it is pointed at. Never a customer box.

import pg from 'pg'
import { readFileSync, readdirSync } from 'node:fs'

const adminUrl = process.env.ADMIN_URL
const dir = process.env.CHAIN_DIR
if (!adminUrl || !dir) { console.error('ADMIN_URL and CHAIN_DIR are required'); process.exit(2) }
const PASSWORD = 'bob_migrador-local-test'

const admin = new pg.Client({ connectionString: adminUrl })
await admin.connect()
await admin.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bob_migrador') THEN
    CREATE ROLE bob_migrador LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF; END $$`)
await admin.query(`ALTER ROLE bob_migrador PASSWORD '${PASSWORD}'`)
if (process.env.PROVISION) await admin.query(readFileSync(process.env.PROVISION, 'utf8'))

const url = new URL(adminUrl)
url.username = 'bob_migrador'
url.password = PASSWORD
const owner = new pg.Client({ connectionString: url.toString() })
await owner.connect()

// What postgres owns outside the system schemas, to hand over what a fallback creates.
const OWNED = `
  SELECT 'TABLE' AS kind, format('%I.%I', n.nspname, c.relname) AS name, c.relkind::text AS sub
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relowner = 'postgres'::regrole AND c.relkind IN ('r','p','v','m','S','f')
     AND n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'FUNCTION', p.oid::regprocedure::text, p.prokind::text FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proowner = 'postgres'::regrole AND n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'TYPE', format('%I.%I', n.nspname, t.typname), t.typtype::text FROM pg_type t
   JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE t.typowner = 'postgres'::regrole AND t.typtype IN ('e','d','c') AND t.typrelid = 0
     AND n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'SCHEMA', quote_ident(nspname), '' FROM pg_namespace
   WHERE nspowner = 'postgres'::regrole AND nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`
const key = (r) => `${r.kind} ${r.name}`

const blockers = []
let applied = 0
for (const f of readdirSync(dir).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort()) {
  const sql = readFileSync(`${dir}/${f}`, 'utf8')
  try {
    await owner.query('BEGIN'); await owner.query(sql); await owner.query('COMMIT'); applied++
    console.log(`ok   ${f}`)
  } catch (e) {
    await owner.query('ROLLBACK')
    const b = { migration: f, code: e.code, message: e.message, where: (e.where || '').split('\n')[0] }
    blockers.push(b)
    console.log(`STOP ${f}\n    ${b.code} ${b.message}${b.where ? `\n    at ${b.where}` : ''}`)
    const before = new Set((await admin.query(OWNED)).rows.map(key))
    await admin.query('BEGIN')
    try { await admin.query(sql) } catch (err) {
      await admin.query('ROLLBACK')
      console.log(`    and postgres cannot apply it either: ${err.code} ${err.message}; the probe ends here`)
      break
    }
    const fresh = (await admin.query(OWNED)).rows.filter((r) => !before.has(key(r)))
    for (const r of fresh) {
      const kind = r.kind === 'TABLE'
        ? ({ v: 'VIEW', m: 'MATERIALIZED VIEW', S: 'SEQUENCE', f: 'FOREIGN TABLE' }[r.sub] || 'TABLE')
        : r.kind === 'FUNCTION' ? (r.sub === 'p' ? 'PROCEDURE' : 'FUNCTION') : r.kind
      if (r.kind === 'TABLE' && r.sub === 'S') continue // owned sequences follow their table
      await admin.query(`ALTER ${kind} ${r.name} OWNER TO bob_migrador`).catch((err) => {
        blockers.push({ migration: f, code: 'handover', message: `${kind} ${r.name}: ${err.message}`, where: '' })
      })
    }
    await admin.query('COMMIT')
  }
}
await owner.end(); await admin.end()

console.log(`applied as bob_migrador: ${applied}; stopped: ${new Set(blockers.map((b) => b.migration)).size}`)
for (const b of blockers) console.log(`- ${b.migration}\n    ${b.code} ${b.message}${b.where ? `\n    at ${b.where}` : ''}`)
