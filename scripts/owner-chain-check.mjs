#!/usr/bin/env node
// O-3 (D77 §2.8). Henry, 2026-11-24: «postgres una vez, luego migrador». A box
// gets BOb through scripts/instalar-bob.sh: the install chain pushed by
// postgres, the provisioning (the hand-over of bob to bob_migrador by
// supabase_admin), and every other migration pushed by bob_migrador. CI runs
// that script on a Supabase stack started with no migration, then this check
// on what it left (CI job "Chain applies as bob_migrador (O-3)"):
//
//   ADMIN_URL=postgresql://postgres:…@host:port/postgres CHAIN_DIR=<dir> \
//   MIGRADOR_PASSWORD=… node scripts/owner-chain-check.mjs
//
// A. The install chain, the closed list in install-chain.sha256: each file is
//    present and unchanged, and every migration file (the CLI's rule: digits,
//    an underscore, .sql) is recorded as applied.
// P. The provisioning applied once more, statement by statement: it must be
//    idempotent, and a GRANT that only warns is a finding. Then nothing in bob
//    is left to anyone but bob_migrador, and no SECURITY DEFINER function
//    lost what it uses: one outside bob that reads bob, or one in bob that
//    calls a function outside it.
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
const PROVISION = 'supabase/provision/alta-ci.sql'
const PROVISION_SA = 'supabase/provision/alta-ci-supabase-admin.sql'
const PASSWORD = process.env.MIGRADOR_PASSWORD
if (!PASSWORD) { console.error('MIGRADOR_PASSWORD is required'); process.exit(2) }
const findings = []
const as = (user, password) => { const u = new URL(adminUrl); u.username = user; if (password) u.password = password; return u.toString() }

const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect()
const sa = new pg.Client({ connectionString: as('supabase_admin') }); await sa.connect()
const warnings = []
for (const c of [admin, sa]) c.on('notice', (n) => warnings.push(n.message))

// The CLI's own rule for a migration file: digits, an underscore, .sql.
const files = readdirSync(dir).filter((f) => /^[0-9]+_.*\.sql$/.test(f)).sort()
const sha = (f) => createHash('sha256').update(readFileSync(`${dir}/${f}`)).digest('hex')

// supabase/provision/bob.sql is Bzzz's config/supabase/vecinas/bob.sql, byte for
// byte (bzzz#450 at 7429eec, P5 §6.2). A change goes to both, and here.
const BZZZ_BOB_SQL = { commit: '7429eec', sha256: 'ad9adf91d370fc008b4134c9a7d60646310f4b4560433655e677c1892b3f2605' }
{
  const h = createHash('sha256').update(readFileSync('supabase/provision/bob.sql')).digest('hex')
  if (h !== BZZZ_BOB_SQL.sha256) findings.push(`supabase/provision/bob.sql (sha256 ${h}) is not Bzzz's config/supabase/vecinas/bob.sql at ${BZZZ_BOB_SQL.commit}: keep the two identical`)
}

// ── A · the install chain, and what was applied ────────────────────────────
console.log('== A · the install chain')
for (const [f, h] of Object.entries(INSTALL_CHAIN)) {
  if (!files.includes(f)) { findings.push(`${f}, in the install chain, is missing`); continue }
  if (sha(f) !== h) findings.push(`${f}, in the install chain, was edited (sha256 ${sha(f)}): the install chain is frozen, a change goes in a new migration`)
}
// Two histories. The CLI's, shared by every neighbour, holds the install chain
// and nothing else: postgres pushed it. bob.schema_migrations, bob_migrador's,
// holds every later file: instalar-bob.sh resto records each one there, in the
// transaction that applies it.
const { rows: cli } = await admin.query('SELECT version FROM supabase_migrations.schema_migrations')
const cliSet = new Set(cli.map((r) => r.version))
const chainVersions = new Set(Object.keys(INSTALL_CHAIN).map((f) => f.split('_')[0]))
const bobHistory = new pg.Client({ connectionString: as('bob_migrador', PASSWORD) }); await bobHistory.connect()
const { rows: own } = await bobHistory.query(`SELECT version FROM bob.schema_migrations`).catch((e) => {
  findings.push(`bob.schema_migrations cannot be read as bob_migrador (${e.code}): instalar-bob.sh resto did not run`); return { rows: [] } })
await bobHistory.end()
const ownSet = new Set(own.map((r) => r.version))
for (const f of files) {
  const v = f.split('_')[0]
  if (chainVersions.has(v) ? !cliSet.has(v) : !ownSet.has(v)) {
    findings.push(`${f} is not recorded as applied in ${chainVersions.has(v) ? "the CLI's history" : 'bob.schema_migrations'}: scripts/instalar-bob.sh did not get it in`)
  }
}
for (const v of cliSet) if (!chainVersions.has(v)) findings.push(`version ${v} is in the CLI's history and not in the install chain: only the chain goes there`)
for (const v of ownSet) if (chainVersions.has(v)) findings.push(`version ${v} of the install chain is in bob.schema_migrations: the chain is recorded by the CLI`)
{
  // bob_migrador's history is its own: nobody else holds a privilege on it.
  const { rows } = await admin.query(`
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = to_regclass('bob.schema_migrations') AND a.grantee <> 'bob_migrador'::regrole`)
  for (const r of rows) findings.push(`${r.grantee} holds a privilege on bob.schema_migrations: it is bob_migrador's alone`)
}
console.log(`     ${files.length} migration file(s), ${chainVersions.size} in the install chain, ${cliSet.size} in the CLI's history, ${ownSet.size} in bob.schema_migrations`)

// ── P · the provisioning ───────────────────────────────────────────────────
// One statement at a time; a semicolon at a line end splits, except inside $$.
function statements(file) {
  const out = []; let cur = []; let inBody = false
  // \ir <file> is inlined, as psql does, relative to the including file.
  const lines = readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    const m = l.match(/^\\ir\s+(\S+)/)
    return m ? readFileSync(`${file.replace(/[^/]*$/, '')}${m[1]}`, 'utf8').split('\n') : [l]
  })
  for (const line of lines) {
    if (!inBody && /^\s*--/.test(line)) continue
    cur.push(line)
    if ((line.match(/\$\$/g) ?? []).length % 2) inBody = !inBody
    if (!inBody && /;\s*$/.test(line)) { out.push(cur.join('\n').trim()); cur = [] }
  }
  if (cur.join('').trim()) out.push(cur.join('\n').trim())
  return out.filter(Boolean)
}
const NOT_GRANTED = /no privileges were granted|not all privileges were granted|privileges? (were|was) not granted|no privileges could be revoked|not all privileges could be revoked/i
for (const round of [2]) {
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

// What the hand-over changes for SECURITY DEFINER code, which runs as its
// owner. A function's search_path, from its SET clause, counts: a name it
// leaves unqualified resolves through it.
const PATH = (p) => `coalesce((SELECT string_to_array(replace(replace(substr(c, 13), ' ', ''), '"', ''), ',')
                                 FROM unnest(${p}.proconfig) c WHERE c LIKE 'search_path=%'), ARRAY[]::text[])`
// Outside bob, still postgres's: one that reads bob must keep what it reads.
const { rows: readers } = await admin.query(`
  WITH f AS (SELECT p.*, ${PATH('p')} AS path FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname <> 'bob' AND n.nspname NOT LIKE 'pg\\_%')
  SELECT f.oid::regprocedure::text AS fn, pg_get_userbyid(f.proowner) AS owner, f.prosecdef AS definer,
         has_schema_privilege(f.proowner, 'bob', 'USAGE') AS usage,
         (SELECT string_agg(format('%s %s', c.relname,
                   coalesce((SELECT string_agg(x, ',' ORDER BY x) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) x
                              WHERE has_table_privilege(f.proowner, c.oid, x)), 'none')), '; ' ORDER BY c.relname)
            FROM pg_class c WHERE c.relnamespace = 'bob'::regnamespace AND c.relkind IN ('r','p','v','m')
             AND (f.prosrc ~ ('\\mbob\\.' || c.relname || '\\M')
                  OR ('bob' = ANY (f.path) AND f.prosrc ~ ('(^|[^.\\w])' || c.relname || '\\M')))) AS tables
    FROM f WHERE f.prosrc ~ '\\mbob\\.' OR 'bob' = ANY (f.path) ORDER BY 1`)
for (const r of readers) {
  console.log(`     ${r.fn}: owner ${r.owner}${r.definer ? ', SECURITY DEFINER' : ''}, USAGE on bob: ${r.usage}; ${r.tables ?? 'no bob table named'}`)
  if (!r.definer) continue
  if (!r.usage) findings.push(`${r.fn} is SECURITY DEFINER, reads bob, and its owner ${r.owner} has no USAGE on bob after the hand-over`)
  for (const t of (r.tables ?? '').split('; ').filter((t) => t.endsWith(' none'))) {
    findings.push(`${r.fn} is SECURITY DEFINER and its owner ${r.owner} has no privilege on bob.${t.split(' ')[0]} after the hand-over`)
  }
}
// In bob, now bob_migrador's: one that calls a function outside bob must be
// able to execute it, or it fails at run time (42501), not at migration time.
async function definerCallsOut(client) {
  const { rows } = await client.query(`
    WITH d AS (SELECT p.*, ${PATH('p')} AS path FROM pg_proc p
                WHERE p.pronamespace = 'bob'::regnamespace AND p.prosecdef)
    SELECT DISTINCT d.oid::regprocedure::text AS fn, q.oid::regprocedure::text AS callee, pg_get_userbyid(d.proowner) AS owner
      FROM d JOIN pg_proc q ON q.pronamespace <> 'bob'::regnamespace
      JOIN pg_namespace qn ON qn.oid = q.pronamespace
     WHERE qn.nspname NOT IN ('pg_catalog', 'information_schema')
       AND (d.prosrc ~* ('\\m' || qn.nspname || '\\.' || q.proname || '\\s*\\(')
            OR (qn.nspname = ANY (d.path) AND d.prosrc ~* ('(^|[^.\\w])' || q.proname || '\\s*\\(')))
       AND NOT has_function_privilege(d.proowner, q.oid, 'EXECUTE')
     ORDER BY 1, 2`)
  return rows
}
for (const r of await definerCallsOut(admin)) {
  findings.push(`${r.fn} is SECURITY DEFINER, runs as ${r.owner}, and calls ${r.callee}, which ${r.owner} cannot execute`)
}

const owner = new pg.Client({ connectionString: as('bob_migrador', PASSWORD) }); await owner.connect()
const PG16 = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) >= 160000

// ── F · the footprint ──────────────────────────────────────────────────────
const EXPECTED_FOOTPRINT = [
  'attributes: login, nosuperuser, nobypassrls, nocreatedb, nocreaterole, noreplication',
  'database postgres: CONNECT, TEMPORARY',
  'member of: (none)',
  'privilege on schema auth',
  'schema auth: USAGE',
  'schema bob: owner',
  'schema public: USAGE',
]
// On Postgres 16 and later, a CREATEROLE role that creates another is granted
// ADMIN on it, with neither INHERIT nor SET (createrole_self_grant unset): so
// postgres administers bob_migrador, and sets its password, without acting as
// it. Measured on 17 in CI. Anything more is a finding.
EXPECTED_FOOTPRINT.push(PG16 ? 'members: postgres (admin only)' : 'members: (none)')
// bob.sql's EXECUTE on the PR-4 helper, named as the catalog names it.
const { rows: [helper] } = await admin.query(`
  SELECT (pg_identify_object('pg_proc'::regclass, 'public.bob_grant_projection(regclass)'::regprocedure, 0)).identity AS id`)
EXPECTED_FOOTPRINT.push(`privilege on function ${helper.id}`)
EXPECTED_FOOTPRINT.sort()
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
  // From Postgres 16 a membership carries ADMIN, INHERIT and SET apart.
  const opts = PG16 ? `|| CASE WHEN admin_option AND NOT inherit_option AND NOT set_option THEN ' (admin only)'
                              ELSE format(' (admin %s, inherit %s, set %s)', admin_option, inherit_option, set_option) END` : ''
  const { rows: [m] } = await client.query(`
    SELECT (SELECT string_agg(pg_get_userbyid(roleid) ${opts}, ', ' ORDER BY 1) FROM pg_auth_members WHERE member = 'bob_migrador'::regrole) AS of,
           (SELECT string_agg(pg_get_userbyid(member) ${opts}, ', ' ORDER BY 1) FROM pg_auth_members WHERE roleid = 'bob_migrador'::regrole) AS members`)
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
  ['a new month of a projection is created (bob.proj_ensure_partition, as the feeder calls it)',
    await applies(`SELECT bob.proj_ensure_partition('bob.proj_metric_counts'::regclass, '2099-01-01')`)],
]
// The definer guard sees a call bob_migrador cannot make.
await sa.query('BEGIN')
await sa.query('REVOKE EXECUTE ON FUNCTION public.bob_grant_projection(regclass) FROM bob_migrador')
const lost = await definerCallsOut(sa)
await sa.query('ROLLBACK')
checks.push(['a definer function in bob calling a function outside it without EXECUTE is seen',
  lost.some((r) => r.fn.startsWith('bob.proj_ensure_partition(') && r.callee.startsWith('bob_grant_projection('))])
// Default privileges. One with no schema is the role's own, outside bob, and
// shows. One in schema bob does not: that is what bob opens, pending (P5 §6.2).
await owner.query('BEGIN')
await owner.query('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO anon')
checks.push(['a default privilege of bob_migrador outside bob is seen', (await footprint(owner)).some((l) => !EXPECTED_FOOTPRINT.includes(l))])
await owner.query('ROLLBACK')
await owner.query('BEGIN')
await owner.query('ALTER DEFAULT PRIVILEGES IN SCHEMA bob GRANT SELECT ON TABLES TO anon')
console.log(`     measured: a default privilege in schema bob ${(await footprint(owner)).some((l) => !EXPECTED_FOOTPRINT.includes(l)) ? 'shows' : 'does not show'} in the footprint`)
await owner.query('ROLLBACK')
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
