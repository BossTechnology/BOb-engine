#!/usr/bin/env node
// O-3 (D77 §2.8): BOb's chain applied by its own owner, bob_migrador, not by
// postgres, over a Supabase database with no BOb in it. The CI job "Chain
// applies as bob_migrador (O-3)" runs it on a stack started with no migration.
//
//   ADMIN_URL=postgresql://postgres:…@host:port/postgres CHAIN_DIR=<dir> \
//   node scripts/owner-chain-check.mjs
//
// 1. Provisioning, as D77 has it: supabase/provision/bob-vecina.sql applied by
//    postgres, and the one grant postgres cannot make (USAGE on auth) applied
//    by supabase_admin from bob-vecina-supabase-admin.sql. Each statement on
//    its own; one that fails, or a GRANT that only warns, is a finding.
// 2. bob_migrador applies the chain, each migration as written. The ones that
//    cannot apply under that provisioning are listed in KNOWN_STOPS with the
//    reason, as measured; the chain was written for postgres and lab-02 has it
//    applied, so those files do not change (append-only). A stop not in the
//    list, or a listed one that now applies, fails: every migration added from
//    here on must apply as bob_migrador. Past a known stop, supabase_admin
//    applies the file and hands what it made to bob_migrador, so the rest of
//    the chain is measured as it would run.
// 3. bob_migrador's footprint: its role attributes, its memberships, and every
//    schema privilege it holds outside bob must be exactly what step 1 gives.
// 4. Self-checks, every run, each rolled back: a migration that creates in
//    public, or alters auth, is refused to bob_migrador while one in bob is
//    not; and an extra grant to bob_migrador is seen by step 3.
// Exits 1 on any finding. It changes the database it is pointed at, so it is
// for a disposable stack only, never a box.

import pg from 'pg'
import { readFileSync, readdirSync } from 'node:fs'

// Measured on CI, run of 746cf98 onwards (see P5 §6.2). The remedy for each is
// in the same section: none is a grant D77 allows.
export const KNOWN_STOPS = {
  '20260606120000_initial_schema.sql':
    'creates in public, before the move to bob; also a trigger on auth.users, owned by supabase_auth_admin',
  '20260606120001_auth_custom_claims.sql':
    'creates in public, before the move to bob (custom_access_token_hook, which GoTrue calls by that name)',
  '20260606120002_realtime.sql':
    'adds tables to supabase_realtime, a publication postgres owns and the neighbours share',
  '20260729130000_v3_config_persistence.sql':
    'creates in public, before the move to bob',
  '20260729150000_text_rule_responses.sql':
    'creates in public, before the move to bob',
  '20260829120000_fix_reserved_role_claim.sql':
    'replaces public.custom_access_token_hook',
  '20260830100000_autobotz_bindings.sql':
    'creates in public, before the move to bob',
  '20260902100000_autobotz_rename_and_align.sql':
    'creates in public, before the move to bob',
  '20260902100100_organizations_slug_shape.sql':
    'creates in public, before the move to bob',
  '20260902100200_channels_source_key.sql':
    'creates in public, before the move to bob',
  '20260902100300_roles_and_grants.sql':
    'CREATE ROLE, which checks CREATEROLE before it sees the role already exists',
  '20260903100000_actors.sql':
    'creates in public, before the move to bob',
  '20260903100100_channel_actor_mix.sql':
    'creates in public, before the move to bob',
  '20260903100200_actor_skills_and_shifts.sql':
    'creates in public, before the move to bob',
  '20260903100300_availability.sql':
    'creates in public, before the move to bob',
  '20261118100000_bob_schema.sql':
    'CREATE SCHEMA IF NOT EXISTS bob, which checks CREATE on the database before it sees the schema',
  '20261121100100_registry_verification_and_scope.sql':
    'creates functions in public (public.bob_autobotz_*)',
  '20261121100200_outbound_queue.sql':
    'creates functions in public (public.bob_outbox_*)',
  '20261121100300_outbox_admission_needs_verification.sql':
    'replaces public.bob_outbox_admit',
  '20261121130000_users_bob_app_access.sql':
    'drops a trigger on auth.users, which only its owner may',
  '20261121140000_member_refs_seen.sql':
    'creates a function in public (public.bob_grant_feeder_staging)',
}

const adminUrl = process.env.ADMIN_URL
const dir = process.env.CHAIN_DIR
if (!adminUrl || !dir) { console.error('ADMIN_URL and CHAIN_DIR are required'); process.exit(2) }
const PROVISION = 'supabase/provision/bob-vecina.sql'
const PROVISION_SA = 'supabase/provision/bob-vecina-supabase-admin.sql'
const PASSWORD = 'bob_migrador-local-test'
const findings = []
const as = (user, password) => { const u = new URL(adminUrl); u.username = user; if (password) u.password = password; return u.toString() }

const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect()
const sa = new pg.Client({ connectionString: as('supabase_admin') }); await sa.connect()
const warnings = []
for (const c of [admin, sa]) c.on('notice', (n) => warnings.push(n.message))

// ── 1 · provisioning ──────────────────────────────────────────────────────
const statements = (file) => readFileSync(file, 'utf8').replace(/--.*$/gm, '').split(/;\s*$/m)
  .map((s) => s.trim()).filter(Boolean)
for (const [who, client, file] of [['postgres', admin, PROVISION], ['supabase_admin', sa, PROVISION_SA]]) {
  console.log(`== provisioning, as ${who} (${file})`)
  for (const s of statements(file)) {
    const line = s.split('\n')[0]
    try {
      warnings.length = 0
      await client.query(s)
      const w = warnings.filter((m) => /no privileges|privileges? (were|was) not granted/i.test(m))
      if (w.length) { findings.push(`${who} could not grant: ${line} (${w.join('; ')})`); console.log(`FAIL ${line}\n    ${w.join('; ')}`) }
      else console.log(`ok   ${line}`)
    } catch (e) { findings.push(`${who} could not run: ${line} (${e.message})`); console.log(`FAIL ${line}\n    ${e.code} ${e.message}`) }
  }
}
await admin.query(`ALTER ROLE bob_migrador PASSWORD '${PASSWORD}'`)

// ── 3 · the footprint, defined here so the self-check can reuse it ────────
const EXPECTED_FOOTPRINT = [
  'attributes: login, nosuperuser, nobypassrls, nocreatedb, nocreaterole',
  'database postgres: CONNECT, TEMPORARY',
  'member of: (none)',
  'schema auth: USAGE',
  'schema bob: owner',
  'schema public: USAGE',
]
async function footprint(client) {
  const { rows: [r] } = await client.query(`
    SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'bob_migrador'`)
  const out = [`attributes: ${r.rolcanlogin ? 'login' : 'nologin'}, ${r.rolsuper ? 'superuser' : 'nosuperuser'}, ` +
    `${r.rolbypassrls ? 'bypassrls' : 'nobypassrls'}, ${r.rolcreatedb ? 'createdb' : 'nocreatedb'}, ${r.rolcreaterole ? 'createrole' : 'nocreaterole'}`]
  const { rows: [d] } = await client.query(`
    SELECT string_agg(p, ', ' ORDER BY p) AS privs FROM unnest(ARRAY['CONNECT','CREATE','TEMPORARY']) p
     WHERE has_database_privilege('bob_migrador', current_database(), p)`)
  out.push(`database ${(await client.query('SELECT current_database() AS db')).rows[0].db}: ${d.privs ?? '(none)'}`)
  const { rows: [m] } = await client.query(`
    SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) AS roles FROM pg_auth_members a
      JOIN pg_roles r ON r.oid = a.roleid WHERE a.member = 'bob_migrador'::regrole`)
  out.push(`member of: ${m.roles ?? '(none)'}`)
  const { rows } = await client.query(`
    SELECT n.nspname, n.nspowner = 'bob_migrador'::regrole AS owner,
           string_agg(p, ', ' ORDER BY p) FILTER (WHERE has_schema_privilege('bob_migrador', n.oid, p)) AS privs
      FROM pg_namespace n, unnest(ARRAY['CREATE','USAGE']) p
     WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
     GROUP BY 1, 2 ORDER BY 1`)
  for (const s of rows) {
    if (s.owner) out.push(`schema ${s.nspname}: owner`)
    else if (s.privs) out.push(`schema ${s.nspname}: ${s.privs}`)
  }
  return out
}

// ── 2 · the chain ─────────────────────────────────────────────────────────
const owner = new pg.Client({ connectionString: as('bob_migrador', PASSWORD) }); await owner.connect()
const OWNED = `
  SELECT CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS kind,
         format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relowner = 'supabase_admin'::regrole AND c.relkind IN ('r','p','v','m') AND n.nspname IN ('public','bob')
  UNION ALL
  SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, p.oid::regprocedure::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proowner = 'supabase_admin'::regrole AND n.nspname IN ('public','bob')
  UNION ALL
  SELECT 'TYPE', format('%I.%I', n.nspname, t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE t.typowner = 'supabase_admin'::regrole AND t.typtype IN ('e','d') AND n.nspname IN ('public','bob')`
console.log('== the chain, as bob_migrador')
const stops = {}
for (const f of readdirSync(dir).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort()) {
  const sql = readFileSync(`${dir}/${f}`, 'utf8')
  try {
    await owner.query(sql)
    await owner.query('ROLLBACK').catch(() => {})
    console.log(`ok   ${f}`)
  } catch (e) {
    await owner.query('ROLLBACK').catch(() => {})
    stops[f] = `${e.code} ${e.message}`
    console.log(`STOP ${f}\n    ${e.code} ${e.message}${e.where ? `\n    at ${e.where.split('\n')[0]}` : ''}`)
    const before = new Set((await sa.query(OWNED)).rows.map((r) => `${r.kind} ${r.name}`))
    try { await sa.query(sql) } catch (err) {
      await sa.query('ROLLBACK').catch(() => {})
      findings.push(`${f}: supabase_admin cannot apply it either (${err.message}); the rest of the chain was not measured`)
      break
    }
    for (const r of (await sa.query(OWNED)).rows.filter((r) => !before.has(`${r.kind} ${r.name}`))) {
      await sa.query(`ALTER ${r.kind} ${r.name} OWNER TO bob_migrador`)
        .catch((err) => findings.push(`${f}: cannot hand ${r.kind} ${r.name} to bob_migrador (${err.message})`))
    }
  }
}
for (const f of Object.keys(stops)) {
  if (!(f in KNOWN_STOPS)) findings.push(`${f} does not apply as bob_migrador: ${stops[f]}. A new migration must apply under the provisioning of D77 (bob-vecina.sql), touching nothing outside bob`)
}
for (const f of Object.keys(KNOWN_STOPS)) {
  if (!(f in stops)) findings.push(`${f} is listed in KNOWN_STOPS and now applies as bob_migrador: take it off the list`)
}

// ── 3 · the footprint ─────────────────────────────────────────────────────
console.log('== bob_migrador outside bob')
const actual = await footprint(admin)
for (const l of actual) console.log(`     ${l}`)
const extra = actual.filter((l) => !EXPECTED_FOOTPRINT.includes(l))
const missing = EXPECTED_FOOTPRINT.filter((l) => !actual.includes(l))
for (const l of extra) findings.push(`bob_migrador holds what D77 does not give it: ${l}`)
for (const l of missing) findings.push(`bob_migrador lacks what the provisioning gives it: ${l}`)

// ── 4 · self-checks ───────────────────────────────────────────────────────
console.log('== self-checks')
async function refused(sql) {
  await owner.query('BEGIN')
  try { await owner.query(sql); return false } catch { return true } finally { await owner.query('ROLLBACK') }
}
const checks = [
  ['a migration that creates in public is refused', await refused('CREATE TABLE public.o3_selfcheck (id int)')],
  ['a migration that alters auth is refused', await refused('ALTER TABLE auth.users ADD COLUMN o3_selfcheck int')],
  ['a migration that creates a schema is refused', await refused('CREATE SCHEMA o3_selfcheck')],
  ['a migration in bob is not refused', !(await refused('CREATE TABLE bob.o3_selfcheck (id int)'))],
]
await admin.query('BEGIN')
await admin.query('GRANT CREATE ON SCHEMA extensions TO bob_migrador')
const sabotaged = await footprint(admin)
await admin.query('ROLLBACK')
checks.push(['an extra grant to bob_migrador is seen', sabotaged.some((l) => !EXPECTED_FOOTPRINT.includes(l))])
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) findings.push(`self-check failed: ${name}`)
}

await owner.end(); await sa.end(); await admin.end()
console.log(findings.length ? `\n${findings.length} finding(s):\n- ${findings.join('\n- ')}` : '\nno findings')
process.exit(findings.length ? 1 : 0)
