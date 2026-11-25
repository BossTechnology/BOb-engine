#!/usr/bin/env node
// Step 3 of O-3 (P5 §6.2): apply BOb's migrations after the install chain, as
// bob_migrador. scripts/instalar-bob.sh resto runs it; run it only through
// that script.
//
//   node scripts/aplicar-migraciones.mjs <file.sql>…     in the order given
//
// The connection comes from the environment, as libpq takes it: PGHOST,
// PGPORT, PGUSER, and PGPASSFILE for the password (never PGPASSWORD, never an
// argument). PGDATABASE defaults to postgres.
//
// Not psql: psql reads a backslash as a metacommand (\! runs a shell) wherever
// its own lexer says, and no guard in front of it can follow that lexer. Here
// a file is sent as one simple-protocol query, which runs SQL and nothing
// else, and a file holding a backslash anywhere is refused before it is sent.
//
// History. bob.schema_migrations, bob_migrador's own table, made here when it
// is missing. Not the CLI's supabase_migrations.schema_migrations, which every
// neighbour shares: write access there would let bob_migrador record versions
// for anyone (bzzz#450 review). Each file, its row in that table and one
// COMMIT go in one transaction on one connection: a file that fails leaves
// nothing applied and nothing recorded.
//
// A file that ends the transaction itself (COMMIT, END, ROLLBACK, however it is
// written) is caught. A random value is set LOCAL before the file runs and read
// back after it: if it is gone, the transaction it belonged to is over, the
// file is not recorded, and the run fails. The session is read-only by default,
// so after such an end nothing more of the file can write. What the file ran
// before its own COMMIT is committed; that is said in the failure.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import pg from 'pg'

const files = process.argv.slice(2)
if (!process.env.PGPASSFILE) { console.error('PGPASSFILE is required'); process.exit(2) }
if (process.env.PGPASSWORD) { console.error('PGPASSWORD is set: the password goes in PGPASSFILE only'); process.exit(2) }

// A file that is BEGIN; … COMMIT; as its first and last lines has those two
// blanked: the transaction is this script's. Anything else is left as written.
function body(text) {
  const lines = text.split('\n')
  const bare = (l) => l.replace(/--.*$/, '').trim()
  const first = lines.findIndex((l) => bare(l) !== '')
  const last = lines.findLastIndex((l) => bare(l) !== '')
  if (first >= 0 && first < last && /^BEGIN\s*;$/i.test(bare(lines[first])) && /^COMMIT\s*;$/i.test(bare(lines[last]))) {
    lines[first] = ''; lines[last] = ''
  }
  return lines.join('\n')
}

const client = new pg.Client({ database: process.env.PGDATABASE || 'postgres', application_name: 'instalar-bob resto' })
await client.connect()
client.on('notice', (n) => console.log(`     ${n.severity}: ${n.message}`))
const { rows: [{ me }] } = await client.query('SELECT current_user AS me')

await client.query('SET default_transaction_read_only = on')
await client.query('BEGIN READ WRITE')
await client.query(`
  CREATE TABLE IF NOT EXISTS bob.schema_migrations (
    version    text PRIMARY KEY CHECK (version ~ '^[0-9]+$'),
    name       text NOT NULL,
    sha256     text NOT NULL,
    statements text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by name NOT NULL DEFAULT current_user)`)
await client.query(`COMMENT ON TABLE bob.schema_migrations IS
  'BOb''s migrations after the install chain, applied by bob_migrador (instalar-bob.sh resto, O-3). The install chain is in supabase_migrations.schema_migrations.'`)
// Default privileges in bob could hand it to the application roles: it is
// bob_migrador's alone.
await client.query(`
  DO $$ DECLARE g oid; BEGIN
    FOR g IN SELECT DISTINCT a.grantee FROM pg_class c, aclexplode(c.relacl) a
              WHERE c.oid = 'bob.schema_migrations'::regclass AND a.grantee <> c.relowner LOOP
      EXECUTE format('REVOKE ALL ON bob.schema_migrations FROM %s', CASE WHEN g = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g)) END);
    END LOOP;
  END $$`)
await client.query('COMMIT')

const { rows } = await client.query('SELECT version FROM bob.schema_migrations')
const done = new Set(rows.map((r) => r.version))
let applied = 0
for (const path of files) {
  const f = basename(path)
  const m = /^([0-9]+)_(.*)\.sql$/.exec(f)
  if (!m) { console.error(`${f}: not a migration file name (digits, an underscore, .sql)`); process.exit(1) }
  const [, version, name] = m
  if (done.has(version)) continue
  const text = readFileSync(path, 'utf8')
  const at = text.indexOf('\\')
  if (at >= 0) {
    const line = text.slice(0, at).split('\n').length
    console.error(`${f} refused, nothing applied: line ${line} holds a backslash. None is allowed in a file resto applies, not even in a string; write E'\\n' as chr(10).`)
    process.exit(1)
  }
  const nonce = randomBytes(16).toString('hex')
  console.log(`Applying ${f} as ${me}`)
  try {
    await client.query('BEGIN READ WRITE')
    await client.query(`SELECT set_config('bob.instalar', $1, true)`, [nonce])
    await client.query(body(text))
    const { rows: [s] } = await client.query(`SELECT current_setting('bob.instalar', true) AS n`)
    if (s.n !== nonce) {
      throw new Error('the file ended the transaction itself (a COMMIT, END or ROLLBACK in it). Not recorded. What it ran before that end may be committed; nothing after it wrote, the session being read-only by default.')
    }
    await client.query('INSERT INTO bob.schema_migrations (version, name, sha256, statements) VALUES ($1, $2, $3, $4)',
      [version, name, createHash('sha256').update(text).digest('hex'), text])
    await client.query('COMMIT')
    applied++
  } catch (e) {
    // Still inside this script's transaction, any query is refused (25P02) and
    // the ROLLBACK undoes it all. A query that runs means the file ended it.
    const ended = await client.query(`SELECT current_setting('bob.instalar', true) AS n`)
      .then((r) => r.rows[0].n !== nonce, () => false)
    await client.query('ROLLBACK').catch(() => {})
    console.error(`${f} failed: ${e.message}${e.code ? ` (${e.code})` : ''}`)
    if (ended) console.error(`${f} ended the transaction itself before failing: what it ran before that end may be committed. Not recorded.`)
    await client.end()
    process.exit(1)
  }
}
await client.end()
console.log(`${applied} applied, ${files.length - applied} already recorded.`)
