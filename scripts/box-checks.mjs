// The read-only checks a box runs after its migration step (P5 §6.2, "How it
// is checked after"), and the queries the suite runs for the same guards
// (P5 §6.3). One module, so the box runs exactly the SQL that CI has seen
// fail.
//
// Every function here only reads the catalog or `organizations`. None of them
// writes, sets a role or loads a fixture: a customer box is never a test
// database (§6.2: "The full suite never runs against a company box").

// The three roles of Handoff §4.3 (P5 §3.1). This is the set the guard expects,
// not the set it checks: the checked set is discovered from the catalog.
export const BOB_ROLES = ['bob_ai_ro', 'bob_app', 'bob_feeder']

// Supabase's own roles. The roles that hold a privilege in `bob` are found, not
// listed; this list only says which of the found roles are not BOb's to answer
// for. It fails closed: a role missing from it is reported, never passed, so a
// Supabase release that adds a role shows up as a red check for a human to
// read, not as a hole. Postgres's predefined `pg_*` roles are left out by
// prefix, as everywhere else in the suite.
export const SUPABASE_ROLES = new Set([
  'anon', 'authenticated', 'authenticator', 'dashboard_user', 'pgbouncer',
  'postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin',
  'supabase_etl_admin', 'supabase_functions_admin', 'supabase_privileged_role',
  'supabase_read_only_user', 'supabase_realtime_admin',
  'supabase_replication_admin', 'supabase_storage_admin',
])

// The extensions that let Postgres open a connection out (BZZ-3 Ruling 2).
export const EGRESS_EXTENSIONS = ['http', 'pg_net']

// Every role that holds a privilege in schema `bob`, with what it holds it
// through. "Holds" means: owns, or is granted (directly, or as a member of a
// role that is, inheriting or not) a privilege on the schema itself, on any
// relation, column, sequence or function in it, or through a default privilege
// set for it. PUBLIC is not a role and is left out here; F-19's PUBLIC checks
// cover it.
export async function rolesWithPrivilegeInBob(client, schema = 'bob') {
  const { rows } = await client.query(`
    WITH s AS (SELECT oid FROM pg_namespace WHERE nspname = $1),
    holder AS (
      SELECT n.nspowner AS owner, (aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner)))).grantee
        FROM pg_namespace n JOIN s ON s.oid = n.oid
      UNION ALL
      SELECT c.relowner, (aclexplode(coalesce(c.relacl, acldefault(
               (CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END)::"char", c.relowner)))).grantee
        FROM pg_class c JOIN s ON s.oid = c.relnamespace
      UNION ALL
      SELECT c.relowner, (aclexplode(a.attacl)).grantee
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN s ON s.oid = c.relnamespace
       WHERE a.attacl IS NOT NULL
      UNION ALL
      SELECT p.proowner, (aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))).grantee
        FROM pg_proc p JOIN s ON s.oid = p.pronamespace
      UNION ALL
      SELECT d.defaclrole, (aclexplode(d.defaclacl)).grantee
        FROM pg_default_acl d JOIN s ON s.oid = d.defaclnamespace
    ),
    grantee AS (
      SELECT grantee AS oid FROM holder WHERE grantee <> 0
      UNION SELECT owner FROM holder
    )
    SELECT r.rolname, r.rolcanlogin AS login, r.rolsuper AS superuser,
           r.rolbypassrls AS bypassrls,
           array_agg(DISTINCT g.oid::regrole::text ORDER BY g.oid::regrole::text) AS through
      FROM pg_roles r
      JOIN grantee g ON pg_has_role(r.oid, g.oid, 'MEMBER')
     WHERE r.rolname NOT LIKE 'pg\\_%'
     GROUP BY r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls
     ORDER BY r.rolname`, [schema])
  if (rows.length === 0) {
    // Every database holding `bob` has at least its owner. Nothing found means
    // the schema is missing or the query is wrong, never "no role".
    throw new Error(`no role holds anything in schema ${schema}: is it there?`)
  }
  return rows
}

// Guard "three roles, no more" (P5 §6.3). Returns findings; empty is green.
export async function threeRolesFindings(client) {
  const findings = []
  const found = await rolesWithPrivilegeInBob(client)
  const ours = found.filter((r) => !SUPABASE_ROLES.has(r.rolname))
  const names = ours.map((r) => r.rolname)
  for (const r of ours) {
    if (!BOB_ROLES.includes(r.rolname)) {
      findings.push(`${r.rolname}${r.login ? ' (LOGIN)' : ''} holds a privilege in bob through ${r.through.join(', ')}`)
    }
  }
  for (const role of BOB_ROLES) {
    if (!names.includes(role)) findings.push(`${role} holds nothing in bob, or does not exist`)
  }

  // P5 §3.2: every one of the three is NOSUPERUSER NOBYPASSRLS NOCREATEDB
  // NOCREATEROLE, and none can become a role that is not. Read from pg_roles,
  // not from the found set, so a role that lost every grant is still checked.
  const { rows: attrs } = await client.query(`
    SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
           ARRAY(SELECT o.rolname FROM pg_roles o
                  WHERE o.oid <> r.oid AND pg_has_role(r.oid, o.oid, 'MEMBER')
                  ORDER BY 1)::text[] AS can_become
      FROM pg_roles r WHERE r.rolname = ANY($1) ORDER BY 1`, [BOB_ROLES])
  for (const a of attrs) {
    for (const [col, word] of [['rolsuper', 'SUPERUSER'], ['rolbypassrls', 'BYPASSRLS'],
      ['rolcreatedb', 'CREATEDB'], ['rolcreaterole', 'CREATEROLE']]) {
      if (a[col]) findings.push(`${a.rolname} is ${word}`)
    }
    // A member of another role can SET ROLE to it. Any membership is a way out
    // of the grant matrix, whether the other role is privileged or not.
    for (const other of a.can_become) findings.push(`${a.rolname} can become ${other}`)
  }
  return findings
}

// The functions of the egress extensions, wherever they are installed, and
// whether each of the three can EXECUTE them. has_function_privilege counts
// PUBLIC, which is the point: Postgres gives a new function to PUBLIC, and an
// extension that does not revoke it is executable by everyone.
export async function egressFunctions(client) {
  const { rows } = await client.query(`
    SELECT e.extname, n.nspname AS schema, p.oid::regprocedure::text AS fn,
           ARRAY(SELECT r FROM unnest($2::text[]) r
                  WHERE has_function_privilege(r, p.oid, 'EXECUTE')
                    AND has_schema_privilege(r, n.oid, 'USAGE')
                  ORDER BY 1) AS executable_by,
           ARRAY(SELECT r FROM unnest($2::text[]) r
                  WHERE has_function_privilege(r, p.oid, 'EXECUTE')
                  ORDER BY 1) AS execute_granted_to
      FROM pg_extension e
      JOIN pg_depend d ON d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid
                      AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
      JOIN pg_proc p ON p.oid = d.objid
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE e.extname = ANY($1)
     ORDER BY 1, 3`, [EGRESS_EXTENSIONS, BOB_ROLES])
  return rows
}

// Guard "no egress from the database" (P5 §6.3). F-27, closed by (c) (Henry,
// 2026-11-21): neither egress extension may be installed, in any schema.
// Installing either one hands EXECUTE on every function to PUBLIC, so "not
// granted" never holds once installed; only "not installed" does, and lab-02
// has both available and neither installed. An install is a finding by
// itself, and so is a later one, which a revoke (b) would not have covered.
//
// The EXECUTE findings stay beside it, so a failing box says who could call
// what. Strict on purpose: EXECUTE alone is a finding, with or without USAGE
// on the schema, because USAGE is one GRANT away.
export async function egressFindings(client) {
  const installed = (await egressInstalled(client))
    .map((e) => `${e.extname} is installed (in ${e.schema}); no egress extension may be (F-27)`)
  const executable = (await egressFunctions(client))
    .filter((f) => f.execute_granted_to.length > 0)
    .map((f) => `${f.fn} (${f.extname}, in ${f.schema}) executable by ${f.execute_granted_to.join(', ')}`)
  return [...installed, ...executable]
}

// Which egress extensions are installed, and where. The box check prints it,
// so an empty egress result can be told apart from an empty install.
export async function egressInstalled(client) {
  const { rows } = await client.query(`
    SELECT e.extname, n.nspname AS schema FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = ANY($1) ORDER BY 1`, [EGRESS_EXTENSIONS])
  return rows
}

// Objection 3 of P5 §8, answered: one organization per customer box, and its
// slug is the box's `bzzz.tenant`. A box check, not a suite test: the suite's
// fixture holds two tenants on purpose.
export async function oneOrganizationFindings(client, boxTenant) {
  if (!boxTenant) return ['the box tenant (bzzz.tenant) was not given']
  const { rows } = await client.query(`
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'organizations' AND c.relkind IN ('r', 'p')
       AND n.nspname NOT LIKE 'pg\\_%'`)
  if (rows.length !== 1) return [`expected one organizations table, found ${rows.length}`]
  const { rows: orgs } = await client.query(
    `SELECT id::text, slug FROM ${rows[0].qualified} ORDER BY slug`)
  const findings = []
  if (orgs.length !== 1) {
    findings.push(`organizations holds ${orgs.length} rows, expected exactly 1`)
  }
  for (const o of orgs) {
    if (o.slug !== boxTenant) findings.push(`organization ${o.id} has slug ${o.slug}, the box tenant is ${boxTenant}`)
  }
  return findings
}

// P5 Q6 (a), review of PR #33: the feeder writes a row in
// bob.member_refs_runs per tenant per staging run. A tenant with no run, or
// whose newest run is older than `maxAgeHours`, is a warning: the ghost
// reconciliation would read zero staged refs and could not tell a stopped
// feeder from a quiet day. A warning, not a finding: a box just migrated has
// not run the feeder yet.
export async function stagingRunWarnings(client, { now = new Date(), maxAgeHours = 24 } = {}) {
  const { rows } = await client.query(`
    SELECT o.id::text AS org_id, o.slug, max(r.ran_at) AS last_run
      FROM bob.organizations o
      LEFT JOIN bob.member_refs_runs r ON r.org_id = o.id
     GROUP BY o.id, o.slug ORDER BY o.slug`)
  const bound = new Date(new Date(now).getTime() - maxAgeHours * 3_600_000)
  const warnings = []
  for (const r of rows) {
    if (!r.last_run) {
      warnings.push(`organization ${r.org_id} (${r.slug}) has no staging run in bob.member_refs_runs`)
    } else if (new Date(r.last_run) < bound) {
      warnings.push(`organization ${r.org_id} (${r.slug}): last staging run at ` +
        `${new Date(r.last_run).toISOString()}, older than ${maxAgeHours} h`)
    }
  }
  return warnings
}

// Who can sign in. bob-web answers 403 to an account with no row in bob.users or
// with active = false, so an organization with no active user is a box nobody
// can enter. A warning, not a failure: a box that was just migrated has no users
// until the operator runs scripts/provision-user.mjs.
export async function activeUserFindings(client, boxTenant) {
  if (!boxTenant) return ['the box tenant (bzzz.tenant) was not given']
  const { rows: [r] } = await client.query(`
    SELECT count(*) FILTER (WHERE u.active)::int AS active, count(u.id)::int AS total
      FROM bob.organizations o LEFT JOIN bob.users u ON u.org_id = o.id
     WHERE o.slug = $1`, [boxTenant])
  if (r.active > 0) return []
  return [`bob.users has no active user for ${boxTenant} (${r.total} rows): nobody can ` +
    'sign in, bob-web answers 403. Provision one with scripts/provision-user.mjs']
}

// P5 §4.3 · the bob-alone restore. The procedure drops `bob` with CASCADE and
// restores `pg_dump -n bob`. Anything outside `bob` that depends on `bob` goes
// with the CASCADE and is not in the dump, so no object in `bob` may depend on
// it: the restore would need it before `bob`'s tables exist. Read from
// pg_depend, never from a list. A rule, default, trigger, policy or constraint
// counts as its table, and a table's row type as the table. Objects owned by an
// extension and the system schemas are left out; a plpgsql body records no
// dependency and runs in time, which is why it can sit outside.
export async function restoreCycleFindings(client, schema = 'bob') {
  const { rows } = await client.query(`
    WITH RECURSIVE
    raw AS (
      SELECT d.classid, d.objid, d.refclassid, d.refobjid
        FROM pg_depend d WHERE d.deptype = 'n'
    ),
    norm AS (
      SELECT o.cls AS src_cls, o.oid AS src_oid, r.cls AS dst_cls, r.oid AS dst_oid
        FROM raw
        CROSS JOIN LATERAL (SELECT * FROM (VALUES
          (CASE WHEN raw.classid IN ('pg_rewrite'::regclass, 'pg_attrdef'::regclass,
                                     'pg_trigger'::regclass, 'pg_policy'::regclass)
                  OR (raw.classid = 'pg_constraint'::regclass
                      AND (SELECT conrelid FROM pg_constraint WHERE oid = raw.objid) <> 0)
                THEN 'pg_class'::regclass ELSE raw.classid END,
           CASE raw.classid
             WHEN 'pg_rewrite'::regclass THEN (SELECT ev_class FROM pg_rewrite WHERE oid = raw.objid)
             WHEN 'pg_attrdef'::regclass THEN (SELECT adrelid FROM pg_attrdef WHERE oid = raw.objid)
             WHEN 'pg_trigger'::regclass THEN (SELECT tgrelid FROM pg_trigger WHERE oid = raw.objid)
             WHEN 'pg_policy'::regclass THEN (SELECT polrelid FROM pg_policy WHERE oid = raw.objid)
             WHEN 'pg_constraint'::regclass THEN coalesce(nullif(
               (SELECT conrelid FROM pg_constraint WHERE oid = raw.objid), 0), raw.objid)
             ELSE raw.objid END)) v(cls, oid)) o
        CROSS JOIN LATERAL (SELECT * FROM (VALUES
          (CASE WHEN raw.refclassid = 'pg_type'::regclass
                  AND (SELECT typrelid FROM pg_type WHERE oid = raw.refobjid) <> 0
                THEN 'pg_class'::regclass ELSE raw.refclassid END,
           CASE WHEN raw.refclassid = 'pg_type'::regclass
                  AND (SELECT typrelid FROM pg_type WHERE oid = raw.refobjid) <> 0
                THEN (SELECT typrelid FROM pg_type WHERE oid = raw.refobjid)
                ELSE raw.refobjid END)) v(cls, oid)) r
       WHERE (o.cls, o.oid) IS DISTINCT FROM (r.cls, r.oid)
    ),
    node AS (
      SELECT n.cls, n.oid,
             CASE n.cls
               WHEN 'pg_class'::regclass THEN (SELECT relnamespace FROM pg_class WHERE oid = n.oid)
               WHEN 'pg_proc'::regclass  THEN (SELECT pronamespace FROM pg_proc WHERE oid = n.oid)
               WHEN 'pg_type'::regclass  THEN (SELECT typnamespace FROM pg_type WHERE oid = n.oid)
             END AS nsp,
             EXISTS (SELECT 1 FROM pg_depend e
                      WHERE e.classid = n.cls AND e.objid = n.oid AND e.deptype = 'e') AS in_ext
        FROM (SELECT src_cls, src_oid FROM norm UNION SELECT dst_cls, dst_oid FROM norm) n(cls, oid)
    ),
    crossing AS (
      SELECT e.src_cls, e.src_oid, e.dst_cls, e.dst_oid
        FROM norm e
        JOIN node s ON (s.cls, s.oid) = (e.src_cls, e.src_oid)
        JOIN node d ON (d.cls, d.oid) = (e.dst_cls, e.dst_oid)
       WHERE s.nsp = $1::regnamespace
         AND d.nsp IS NOT NULL AND d.nsp <> $1::regnamespace
         AND d.nsp NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
         AND NOT d.in_ext
    ),
    reach(start_cls, start_oid, cls, oid) AS (
      SELECT DISTINCT dst_cls, dst_oid, dst_cls, dst_oid FROM crossing
      UNION
      SELECT r.start_cls, r.start_oid, e.dst_cls, e.dst_oid
        FROM reach r JOIN norm e ON (e.src_cls, e.src_oid) = (r.cls, r.oid)
    )
    SELECT DISTINCT (SELECT type || ' ' || identity FROM pg_identify_object(c.src_cls, c.src_oid, 0)) AS inside,
                    (SELECT type || ' ' || identity FROM pg_identify_object(c.dst_cls, c.dst_oid, 0)) AS outside
      FROM crossing c
     WHERE EXISTS (SELECT 1 FROM reach r JOIN node n ON (n.cls, n.oid) = (r.cls, r.oid)
                    WHERE (r.start_cls, r.start_oid) = (c.dst_cls, c.dst_oid)
                      AND n.nsp = $1::regnamespace)
     ORDER BY 1, 2`, [schema])
  return rows.map((r) => `${r.inside} depends on ${r.outside}, which depends on ${schema}: ` +
    `the ${schema}-alone restore cannot create it`)
}
