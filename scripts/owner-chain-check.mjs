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

// The install chain as postgres applies it, frozen. The 21 of these that
// bob_migrador cannot apply, and why, are in P5 §6.2 (measured from 746cf98 to
// 89e6f78). A file here never changes (append-only); a new one goes in B.
export const INSTALL_CHAIN = {
  '20260606115900_drop_legacy_singletenant.sql': '2392e5cc516d955d6894d498c4542abeddffe3365e20dfd3d72e6d5f7b57391e',
  '20260606120000_initial_schema.sql': '0f69c0e804c0a21becf248c229362eee03cfe17989c5c82b8852212e62a40456',
  '20260606120001_auth_custom_claims.sql': 'd40ff5f337bee36cab99a7099a4d29b06dcb8299635b56165c2daedfe1e39a4b',
  '20260606120002_realtime.sql': '809fefd8533b912aa29b732b8157e433be584757bb6aacb36e581bf96d751e31',
  '20260606120003_harden_functions.sql': '487e22ece951ebaf5af65219e61a6b1ed294e6c78832728fb577aa6b6d006d46',
  '20260729130000_v3_config_persistence.sql': '62812fd3000aa474d0bbd7bd0922dba97b558b1b0f2b6eafe9708d9506dbe3fa',
  '20260729150000_text_rule_responses.sql': '3034ec8ebbf215316922725c0d7c6066ae68756e11a74ee80563fe03255aeadb',
  '20260829120000_fix_reserved_role_claim.sql': '81ebe8e8eb941ce74f4baea03b5a9121403d7c2a02d0e9bf6e7ad12175949f5f',
  '20260830100000_autobotz_bindings.sql': 'd168ed48144f1132f77bf7273229ca3283c6a551836de592f5e059b1848a35e8',
  '20260902100000_autobotz_rename_and_align.sql': 'e2ffd79fbb9c33158991577b852a1fb172446e5b9208b13601bb73be3a6edc22',
  '20260902100100_organizations_slug_shape.sql': '039cdcabcf028c86570976bc2f8bfc67bb6541eeab9efb2b4c46eccdab400cf3',
  '20260902100200_channels_source_key.sql': '435617948b6889abcac2e84fdc7369982fe9351aa03a6194397a3a7ce6637ce6',
  '20260902100300_roles_and_grants.sql': 'cba70d480b9c846274e3cab6b03f1815ef65b81a08fe96eb279a149a5ebad252',
  '20260903100000_actors.sql': '491f8e2892201d6a4a00bdd5444c52b39e94a511d53d5b9a3f315d1b70d345aa',
  '20260903100100_channel_actor_mix.sql': '06dead947e37e79d1adc40f5631e4793382f2b4c7529803413806bab7d5beecc',
  '20260903100200_actor_skills_and_shifts.sql': '95c96ca677222c2068719a1eefd2d01e26d2d2892ba6880bcc7488f6eceb3dae',
  '20260903100300_availability.sql': '1bebd4f0f0592b15d055ef4129f99eea6b477fdf59a362c5edb390272b87ea40',
  '20260903100400_channel_type_website.sql': 'fd1b4d6abea25fce5fcefd36d7d5f0050bc12edf3e33c71a2af2c5c1e44ca2f7',
  '20261025100000_autobotz_validate_mutative.sql': 'd129890868707ee900b0d125fa84e6bf25ab646dafc57ea451020e5ff8072e66',
  '20261118100000_bob_schema.sql': '05aad7d6cf8bb305086d65d168b7ad5151a7b162b2e3000b7ae0d2fbc3223f95',
  '20261118100100_actor_refs_and_feeder_views.sql': 'f0415a1b779febddb6e1267f15b774e397661a98f2c09146603ccac18a512dd8',
  '20261118100200_projections.sql': 'd7890e32f6d8d70883de2edaf0493d5d427819c116584ce16353205f454f114f',
  '20261119100000_channel_capabilities_and_reports.sql': 'adaf605b0ffb1909ea09bb092fe298a35f97e377e531186f3eee7b0f56828222',
  '20261121100000_webhooks_to_autobotz.sql': 'b9e9c224e5e3b84d5943f8391b4cdf966d1e35f07ac3c9cba3439de99f76e07b',
  '20261121100100_registry_verification_and_scope.sql': '1085de09a5f982f1b3962314fcd5d43da5b28477133f5127582ec3c1f69c126b',
  '20261121100200_outbound_queue.sql': '39233ce161a272fff055644b736d92e6155a4d26ede0eac079ecdc51186adcae',
  '20261121100300_outbox_admission_needs_verification.sql': '30125b552cb16e30a81634ffc2b53421a01706fc3d4f870f3c34ed5de445ac3a',
  '20261121130000_users_bob_app_access.sql': 'bd306a5a0aa55db5dabf113171337c06c552b0d31acd5abedea72fdda3b69e82',
  '20261121140000_member_refs_seen.sql': '3f94659f85c1abba7553392439c2cea6060a698f9dc492add4159259bec0cf79',
  '20261121150000_audit_log_read_only_for_bob_app.sql': 'bca1071296299d274411211d771d176da1a7106bbea59d1e249dfca8d58a3361',
  '20261121160000_audit_log_read_only_for_members.sql': '4e554b82421cc875faa4bd20abe160173f474347abf14953b102294c1323bd4f',
  '20261121170000_revoke_truncate_from_app_roles.sql': 'cc90c7e2f152a25be456e41c8d400eb1bd92afd528cdf246395dbf7b9d6bf194',
  '20261121190000_outbox_drain_not_for_service_role.sql': '5cce8e05b714eb12b956e7d4f6a8b361a69d59b4037d3914de3cec0f705765a7',
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
// whose body reads bob runs as its owner, which may have lost bob to it.
const { rows: readers } = await admin.query(`
  SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
         has_schema_privilege(p.proowner, 'bob', 'USAGE') AS usage
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname <> 'bob' AND n.nspname NOT LIKE 'pg\\_%' AND p.prosrc ~ '\\mbob\\.' ORDER BY 1`)
for (const r of readers) {
  console.log(`     ${r.fn}: owner ${r.owner}${r.definer ? ', SECURITY DEFINER' : ''}, USAGE on bob: ${r.usage}`)
  if (r.definer && !r.usage) findings.push(`${r.fn} is SECURITY DEFINER, reads bob, and its owner ${r.owner} has no USAGE on bob after the hand-over`)
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
