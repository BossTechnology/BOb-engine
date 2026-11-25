#!/usr/bin/env node
// O-3 (D77 §2.8). Henry, 2026-11-24: «postgres una vez, luego migrador». The
// install chain is applied once by postgres; every later migration is applied
// by bob_migrador and must apply as it, inside bob. This check reproduces that
// path on a Supabase stack started with no migration (CI job "Chain applies as
// bob_migrador (O-3)"):
//
//   ADMIN_URL=postgresql://postgres:…@host:port/postgres CHAIN_DIR=<dir> \
//   node scripts/owner-chain-check.mjs
//
// A. The install chain, a closed list of files with their sha256: each must be
//    present and unchanged, and postgres applies them, as on a box.
// P. The provisioning: supabase/provision/bob-vecina.sql as postgres, then
//    bob-vecina-supabase-admin.sql as supabase_admin (D77 77.21 and 77.22),
//    which hands schema bob and everything in it to bob_migrador. Applied twice,
//    since lab-02 gets it over an existing bob. A statement that fails, or a
//    GRANT that only warns, is a finding.
// B. Every other migration the CLI would apply, as bob_migrador alone. A stop
//    is a finding.
// F. bob_migrador's footprint outside bob, discovered from the catalogs: role
//    attributes, memberships both ways, and every object it owns or holds a
//    privilege on, in any database, must be exactly what P gives it.
// S. Self-checks, each rolled back.
// Exits 1 on any finding. It changes the database it is pointed at, so it is
// for a disposable stack only, never a box.

import pg from 'pg'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

// The install chain as postgres applies it, frozen, in
// supabase/provision/install-chain.sha256. The 21 of these that bob_migrador
// cannot apply, and why, are in P5 §6.2 (measured from 746cf98 to 89e6f78). A
// file there never changes (append-only); a new one goes in B.
const INSTALL_LIST = 'supabase/provision/install-chain.sha256'
export const INSTALL_CHAIN = Object.fromEntries(readFileSync(INSTALL_LIST, 'utf8').split('\n')
  .filter((l) => l && !l.startsWith('#')).map((l) => { const [h, f] = l.trim().split(/\s+/); return [f, h] }))

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

// The CLI's own rule for a migration file: digits, an underscore, .sql.
const files = readdirSync(dir).filter((f) => /^[0-9]+_.*\.sql$/.test(f)).sort()
const sha = (f) => createHash('sha256').update(readFileSync(`${dir}/${f}`)).digest('hex')

// ── A · the install chain, as postgres ─────────────────────────────────────
console.log('== A · the install chain, as postgres')
for (const [f, h] of Object.entries(INSTALL_CHAIN)) {
  if (!files.includes(f)) { findings.push(`${f}, in the install chain, is missing`); continue }
  if (sha(f) !== h) findings.push(`${f}, in the install chain, was edited (sha256 ${sha(f)}): the install chain is frozen, a change goes in a new migration`)
}
for (const f of files.filter((f) => f in INSTALL_CHAIN)) {
  try { await admin.query(readFileSync(`${dir}/${f}`, 'utf8')); console.log(`ok   ${f}`) } catch (e) {
    await admin.query('ROLLBACK').catch(() => {})
    findings.push(`${f}: postgres cannot apply it (${e.code} ${e.message}); the rest was not measured`)
    console.log(`STOP ${f}\n    ${e.code} ${e.message}`)
    break
  }
}

// ── P · the provisioning ───────────────────────────────────────────────────
// One statement at a time; a semicolon at a line end splits, except inside $$.
function statements(file) {
  const out = []; let cur = []; let inBody = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!inBody && /^\s*--/.test(line)) continue
    cur.push(line)
    if ((line.match(/\$\$/g) ?? []).length % 2) inBody = !inBody
    if (!inBody && /;\s*$/.test(line)) { out.push(cur.join('\n').trim()); cur = [] }
  }
  if (cur.join('').trim()) out.push(cur.join('\n').trim())
  return out.filter(Boolean)
}
const NOT_GRANTED = /no privileges were granted|not all privileges were granted|privileges? (were|was) not granted|no privileges could be revoked|not all privileges could be revoked/i
for (const round of [1, 2]) {
  for (const [who, client, file] of [['postgres', admin, PROVISION], ['supabase_admin', sa, PROVISION_SA]]) {
    console.log(`== P${round} · provisioning, as ${who} (${file})`)
    for (const s of statements(file)) {
      const line = s.split('\n')[0]
      try {
        warnings.length = 0
        await client.query(s)
        const w = warnings.filter((m) => NOT_GRANTED.test(m))
        if (w.length) { findings.push(`${who} could not grant: ${line} (${w.join('; ')})`); console.log(`FAIL ${line}\n    ${w.join('; ')}`) }
        else console.log(`ok   ${line}`)
      } catch (e) { findings.push(`${who} could not run (round ${round}): ${line} (${e.message})`); console.log(`FAIL ${line}\n    ${e.code} ${e.message}`) }
    }
  }
}
await admin.query(`ALTER ROLE bob_migrador PASSWORD '${PASSWORD}'`)

// Nothing in bob is left to anyone but bob_migrador.
const { rows: notHanded } = await admin.query(`
  SELECT pg_describe_object(classid, objid, objsubid) AS what, pg_get_userbyid(owner) AS owner FROM (
    SELECT 'pg_class'::regclass AS classid, c.oid AS objid, 0 AS objsubid, c.relowner AS owner
      FROM pg_class c WHERE c.relnamespace = 'bob'::regnamespace
    UNION ALL SELECT 'pg_proc'::regclass, p.oid, 0, p.proowner FROM pg_proc p WHERE p.pronamespace = 'bob'::regnamespace
    UNION ALL SELECT 'pg_type'::regclass, t.oid, 0, t.typowner FROM pg_type t WHERE t.typnamespace = 'bob'::regnamespace
    UNION ALL SELECT 'pg_namespace'::regclass, n.oid, 0, n.nspowner FROM pg_namespace n WHERE n.nspname = 'bob'
  ) o WHERE owner <> 'bob_migrador'::regrole`)
for (const r of notHanded) findings.push(`after the hand-over, ${r.what} is still ${r.owner}'s`)
console.log(`== hand-over: ${notHanded.length} object(s) in bob not bob_migrador's`)

// What the hand-over changes for code outside bob: a SECURITY DEFINER function
// whose body reads bob runs as its owner, which no longer owns bob's tables.
const { rows: readers } = await admin.query(`
  SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
         has_schema_privilege(p.proowner, 'bob', 'USAGE') AS usage,
         (SELECT string_agg(format('%s %s', c.relname,
                   coalesce((SELECT string_agg(x, ',' ORDER BY x) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) x
                              WHERE has_table_privilege(p.proowner, c.oid, x)), 'none')), '; ' ORDER BY c.relname)
            FROM pg_class c WHERE c.relnamespace = 'bob'::regnamespace AND c.relkind IN ('r','p','v','m')
             AND p.prosrc ~ ('\\mbob\\.' || c.relname || '\\M')) AS tables
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname <> 'bob' AND n.nspname NOT LIKE 'pg\\_%' AND p.prosrc ~ '\\mbob\\.' ORDER BY 1`)
for (const r of readers) {
  console.log(`     ${r.fn}: owner ${r.owner}${r.definer ? ', SECURITY DEFINER' : ''}, USAGE on bob: ${r.usage}; ${r.tables ?? 'no bob table named'}`)
  if (!r.definer) continue
  if (!r.usage) findings.push(`${r.fn} is SECURITY DEFINER, reads bob, and its owner ${r.owner} has no USAGE on bob after the hand-over`)
  for (const t of (r.tables ?? '').split('; ').filter((t) => t.endsWith(' none'))) {
    findings.push(`${r.fn} is SECURITY DEFINER and its owner ${r.owner} has no privilege on bob.${t.split(' ')[0]} after the hand-over`)
  }
}

// ── B · every later migration, as bob_migrador alone ───────────────────────
const owner = new pg.Client({ connectionString: as('bob_migrador', PASSWORD) }); await owner.connect()
const later = files.filter((f) => !(f in INSTALL_CHAIN))
console.log(`== B · every migration outside the install chain, as bob_migrador alone (${later.length})`)
for (const f of later) {
  try {
    await owner.query(readFileSync(`${dir}/${f}`, 'utf8'))
    console.log(`ok   ${f}`)
  } catch (e) {
    await owner.query('ROLLBACK').catch(() => {})
    console.log(`STOP ${f}\n    ${e.code} ${e.message}`)
    findings.push(`${f} does not apply as bob_migrador: ${e.code} ${e.message}. Every migration outside the install chain must, touching nothing outside bob (P5 §6.2)`)
    break
  }
}

// ── F · the footprint ──────────────────────────────────────────────────────
const EXPECTED_FOOTPRINT = [
  'attributes: login, nosuperuser, nobypassrls, nocreatedb, nocreaterole, noreplication',
  'database postgres: CONNECT, TEMPORARY',
  'member of: (none)',
  'members: (none)',
  'privilege on schema auth',
  'schema auth: USAGE',
  'schema bob: owner',
  'schema public: USAGE',
]
async function footprint(client) {
  const { rows: [r] } = await client.query(`
    SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = 'bob_migrador'`)
  const out = [`attributes: ${r.rolcanlogin ? 'login' : 'nologin'}, ${r.rolsuper ? 'superuser' : 'nosuperuser'}, ` +
    `${r.rolbypassrls ? 'bypassrls' : 'nobypassrls'}, ${r.rolcreatedb ? 'createdb' : 'nocreatedb'}, ` +
    `${r.rolcreaterole ? 'createrole' : 'nocreaterole'}, ${r.rolreplication ? 'replication' : 'noreplication'}`]
  const { rows: [d] } = await client.query(`
    SELECT string_agg(p, ', ' ORDER BY p) AS privs FROM unnest(ARRAY['CONNECT','CREATE','TEMPORARY']) p
     WHERE has_database_privilege('bob_migrador', current_database(), p)`)
  out.push(`database ${(await client.query('SELECT current_database() AS db')).rows[0].db}: ${d.privs ?? '(none)'}`)
  const { rows: [m] } = await client.query(`
    SELECT (SELECT string_agg(pg_get_userbyid(roleid), ', ' ORDER BY 1) FROM pg_auth_members WHERE member = 'bob_migrador'::regrole) AS of,
           (SELECT string_agg(pg_get_userbyid(member), ', ' ORDER BY 1) FROM pg_auth_members WHERE roleid = 'bob_migrador'::regrole) AS members`)
  out.push(`member of: ${m.of ?? '(none)'}`, `members: ${m.members ?? '(none)'}`)
  // Every object, in any database, that bob_migrador owns, holds a privilege
  // on, or is named in a policy of: pg_shdepend records them all.
  const { rows: deps } = await client.query(`
    SELECT s.deptype, s.dbid, d.datname,
           CASE WHEN s.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                THEN (pg_identify_object(s.classid, s.objid, s.objsubid)).type END AS type,
           CASE WHEN s.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                THEN (pg_identify_object(s.classid, s.objid, s.objsubid)).schema END AS schema,
           CASE WHEN s.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                THEN (pg_identify_object(s.classid, s.objid, s.objsubid)).identity END AS identity
      FROM pg_shdepend s LEFT JOIN pg_database d ON d.oid = s.dbid
     WHERE s.refclassid = 'pg_authid'::regclass AND s.refobjid = 'bob_migrador'::regrole`)
  const kind = { o: 'owner of', a: 'privilege on', r: 'named in policy', i: 'initial privilege on' }
  for (const x of deps) {
    if (x.type === null) { out.push(`${kind[x.deptype] ?? x.deptype} an object in database ${x.datname}`); continue }
    if (x.schema === 'bob' || (x.type === 'schema' && x.identity === 'bob')) continue
    out.push(`${kind[x.deptype] ?? x.deptype} ${x.type} ${x.identity}`)
  }
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
  return [...new Set(out)].sort()
}
console.log('== F · bob_migrador outside bob')
const actual = await footprint(admin)
for (const l of actual) console.log(`     ${l}`)
for (const l of actual.filter((l) => !EXPECTED_FOOTPRINT.includes(l))) findings.push(`bob_migrador holds what D77 does not give it: ${l}`)
for (const l of EXPECTED_FOOTPRINT.filter((l) => !actual.includes(l))) findings.push(`bob_migrador lacks what the provisioning gives it: ${l}`)

// ── S · self-checks ────────────────────────────────────────────────────────
console.log('== S · self-checks')
async function attempt(sql) {
  await owner.query('BEGIN')
  try { await owner.query(sql); return 'ok' } catch (e) { return e.code } finally { await owner.query('ROLLBACK') }
}
const DENIED = new Set(['42501'])   // insufficient_privilege, not a typo or a missing object
const refused = async (sql) => DENIED.has(await attempt(sql))
const applies = async (sql) => (await attempt(sql)) === 'ok'
const { rows: [someView] } = await admin.query(`SELECT format('%I.%I', schemaname, viewname) AS v, definition FROM pg_views WHERE schemaname = 'bob' ORDER BY 1 LIMIT 1`)
const checks = [
  ['creating in public is refused', await refused('CREATE TABLE public.o3_selfcheck (id int)')],
  ['altering auth is refused', await refused('ALTER TABLE auth.users ADD COLUMN o3_selfcheck int')],
  ['creating a schema is refused', await refused('CREATE SCHEMA o3_selfcheck')],
  ['changing what BOb left in public is refused', await refused('ALTER FUNCTION public.cap_alert_log() SET search_path = public')],
  ['dropping what BOb left in public is refused', await refused('DROP FUNCTION public.bob_source_key_unset(text)')],
  ['adding to the publication is refused', await refused('CREATE TABLE bob.o3_selfcheck_pub (id int PRIMARY KEY); ALTER PUBLICATION supabase_realtime ADD TABLE bob.o3_selfcheck_pub')],
  ['creating in bob applies', await applies('CREATE TABLE bob.o3_selfcheck (id int)')],
  ['altering a table the install chain made in bob applies', await applies('ALTER TABLE bob.organizations ADD COLUMN o3_selfcheck int')],
  ['a policy on a table the install chain made in bob applies', await applies(`CREATE POLICY o3_selfcheck ON bob.organizations FOR SELECT TO bob_app USING (false)`)],
  ['replacing a view the install chain made in bob applies', !!someView && await applies(`CREATE OR REPLACE VIEW ${someView.v} AS ${someView.definition}`)],
  ['revoking on a table in bob applies', await applies('REVOKE ALL ON bob.organizations FROM anon')],
]
// An extra privilege of each kind shows in the footprint.
for (const [name, client, sql] of [
  ['a schema privilege', admin, 'GRANT CREATE ON SCHEMA extensions TO bob_migrador'],
  ['a privilege on an object outside bob', sa, 'GRANT SELECT ON auth.users TO bob_migrador'],
  ['a function privilege outside bob', admin, 'GRANT EXECUTE ON FUNCTION public.cap_alert_log() TO bob_migrador'],
  ['a role that is a member of bob_migrador', sa, 'GRANT bob_migrador TO authenticated'],
  ['a role bob_migrador is a member of', sa, 'GRANT authenticated TO bob_migrador'],
  ['an attribute', sa, 'ALTER ROLE bob_migrador REPLICATION'],
]) {
  await client.query('BEGIN')
  let seen = false
  try { await client.query(sql); seen = (await footprint(client)).some((l) => !EXPECTED_FOOTPRINT.includes(l)) }
  catch (e) { console.log(`     (${sql}: ${e.message})`) }
  finally { await client.query('ROLLBACK') }
  checks.push([`${name} given to bob_migrador is seen`, seen])
}
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) findings.push(`self-check failed: ${name}`)
}

await owner.end(); await sa.end(); await admin.end()
console.log(findings.length ? `\n${findings.length} finding(s):\n- ${findings.join('\n- ')}` : '\nno findings')
process.exit(findings.length ? 1 : 0)
