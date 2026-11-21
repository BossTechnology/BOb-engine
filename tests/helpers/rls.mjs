// Structural tenancy checks, written as functions that RETURN findings rather
// than assert inline.
//
// That shape is deliberate: ID-12 requires the suite to be build-blocking, and
// the only honest way to show a suite blocks is to prove it can go red. The
// meta-test creates a deliberately broken table, calls these same functions,
// and asserts they report it. A green suite that cannot go red is not a suite.

import { tenantTables, becomeTenant } from './db.mjs'

// Tables where RLS is enabled with NO policy on purpose — deny-all, server-side
// only, service role bypasses. Stated intent, not oversight. Anything else with
// zero policies is a finding.
export const DELIBERATE_DENY_ALL = new Set(['baselines'])

// Roles whose policies must be tenant-scoped. supabase_auth_admin holds
// USING (true) policies so that token issuance can read users and
// organizations; that is legitimate and is not a tenancy hole, because the role
// is not reachable from the API.
// bob_app is in the set too: in a box, bob-web runs as bob_app under the box's
// claim, so a bob_app policy that ignores org_id is the same hole.
const PUBLIC_FACING = new Set(['public', 'anon', 'authenticated', 'bob_app'])

// The roles the application runs as. A tenant table one of them is granted, and
// that no policy reaches, answers it with nothing and says nothing: bob.users
// read empty to bob_app, so nobody could sign in to a box. Deny-all tables are
// exempt, because answering nothing is what they are for.
const APP_ROLES = ['bob_app']

export async function structuralFindings(client) {
  const findings = []
  const tables = await tenantTables(client)

  // roles comes back as name[]; cast so the driver parses it as an array
  // rather than handing back the literal '{authenticated}'.
  const { rows: policies } = await client.query(`
    SELECT schemaname, tablename, policyname, roles::text[] AS roles, cmd, qual, with_check
      FROM pg_policies`)

  const { rows: granted } = await client.query(`
    SELECT r.rolname AS role, format('%I.%I', n.nspname, c.relname) AS qualified,
           p.priv AS privilege
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (SELECT unnest($1::text[]) AS rolname) r
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
     WHERE c.relkind IN ('r', 'p')
       AND CASE WHEN p.priv = 'DELETE' THEN has_table_privilege(r.rolname, c.oid, p.priv)
                ELSE has_any_column_privilege(r.rolname, c.oid, p.priv) END`, [APP_ROLES])

  for (const t of tables) {
    if (!t.rls_enabled) {
      findings.push({
        table: t.table_name,
        rule: 'ID-10',
        finding: 'carries org_id but row-level security is not enabled',
      })
      continue
    }

    if (t.policy_count === 0 && !DELIBERATE_DENY_ALL.has(t.table_name)) {
      findings.push({
        table: t.table_name,
        rule: 'ID-10',
        finding:
          'row-level security is enabled with no policy. Deny-all may be ' +
          'correct — if so, add it to DELIBERATE_DENY_ALL so the intent is ' +
          'stated rather than inferred',
      })
    }

    const own = policies.filter(
      (p) => p.schemaname === t.table_schema && p.tablename === t.table_name)

    if (!DELIBERATE_DENY_ALL.has(t.table_name)) {
      // A read is checked per command: an UPDATE policy does not let a SELECT
      // through, and a read that silently comes back empty is how sign-in
      // broke. A write is refused loudly or touches nothing; any policy that
      // reaches the role is enough for it here.
      for (const g of granted.filter((g) => g.qualified === t.qualified)) {
        const reached = own.some((p) =>
          (g.privilege !== 'SELECT' || p.cmd === 'ALL' || p.cmd === 'SELECT') &&
          (p.roles || []).map(String).some((r) => r === 'public' || r === g.role))
        if (!reached) {
          findings.push({
            table: t.table_name,
            rule: 'ID-10',
            finding: `${g.role} is granted ${g.privilege} but no policy reaches it for ` +
              `${g.privilege === 'SELECT' ? 'SELECT' : 'any command'}, so it silently gets ` +
              'nothing. Add a tenant-scoped policy for it, or revoke the grant',
          })
        }
      }
    }
    for (const p of own) {
      const roles = (p.roles || []).map(String)
      if (!roles.some((r) => PUBLIC_FACING.has(r))) continue

      const expressions = [p.qual, p.with_check].filter(Boolean).join(' ')
      if (!expressions.includes('org_id')) {
        findings.push({
          table: t.table_name,
          rule: 'ID-10',
          finding:
            `policy "${p.policyname}" is reachable by ${roles.join(', ')} ` +
            'but its expression does not constrain org_id',
        })
      }
    }
  }

  return findings
}

// ID-10 for aggregates. A count that leaks a magnitude has leaked, and the rule
// names aggregates for that reason. Every discovered table, not a list: Slice
// 2's projections are exactly the aggregates. What `tenant` counts must not
// exceed the rows it owns, counted outside RLS.
//
// The caller holds a transaction. The tenant's role is taken inside a
// savepoint and given back, so the meta-test can call this over a probe it has
// not rolled back yet.
export async function aggregateLeakFindings(client, tenant, other) {
  const hidden = new Set((await tenantTablesUnreadableByApi(client)).map((t) => t.qualified))
  const tables = (await tenantTables(client)).filter((t) => !hidden.has(t.qualified))
  const owns = new Map()
  let otherRows = 0
  for (const t of tables) {
    const { rows } = await client.query(
      `SELECT count(*) FILTER (WHERE org_id = $1)::int AS own,
              count(*) FILTER (WHERE org_id = $2)::int AS other
         FROM ${t.qualified}`, [tenant, other])
    owns.set(t.qualified, rows[0].own)
    otherRows += rows[0].other
  }

  const findings = []
  await client.query('SAVEPOINT aggregate_leak')
  try {
    await becomeTenant(client, tenant)
    for (const t of tables) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t.qualified}`)
      if (rows[0].n > owns.get(t.qualified)) {
        findings.push({
          table: t.table_name,
          rule: 'ID-10',
          finding: `count(*) returns ${rows[0].n} to a tenant that owns ` +
            `${owns.get(t.qualified)} rows`,
        })
      }
    }
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT aggregate_leak')
  }
  return { otherRows, findings }
}

// PR-4, asserted rather than assumed. Vacuous until Slice 2 creates the eight
// projection tables, and load-bearing from the moment it does not.
//
// A projection is found three ways, in any schema, and any one is enough:
//   - its name starts with proj_;
//   - bob_feeder holds a write grant on it, because writing projections is the
//     feeder's only job, so a table it writes is a projection whatever its name;
//   - it is a partition, at any depth, of one of the above. Postgres does not
//     copy grants from a parent to a partition created later, and in `public`
//     Supabase's default privileges hand every new table to anon and
//     authenticated. Thirteen months across eight tables is about a hundred of
//     them, so the partitions are checked, not only the parents.
//
// One exception, found the same way: a table bob_feeder can insert into but
// cannot read is a feeder staging table (P5 Q6 (a)), not a projection. A
// projection the feeder cannot read is still caught: its proj_ name keeps it
// here, and a staging table is held to an exact grant set of its own.
//
// Privileges are read with has_table_privilege, which is what Postgres
// enforces: a grant to PUBLIC, or one inherited through a role, counts.
const NEVER_WRITES = ['public', 'anon', 'authenticated', 'bob_app']
const WRITE = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']
const FEEDER_NEEDS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']

export async function projectionTables(client) {
  const { rows } = await client.query(`
    WITH RECURSIVE named AS (
      SELECT c.oid
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT LIKE 'pg\\_%'
         AND n.nspname <> 'information_schema'
         AND c.relkind IN ('r', 'p')
         AND (c.relname LIKE 'proj\\_%'
              OR (EXISTS (
                    SELECT 1 FROM aclexplode(c.relacl) a
                     WHERE a.grantee = 'bob_feeder'::regrole
                       AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE'))
                  -- A feeder staging table (P5 Q6 (a)) is not a projection:
                  -- the feeder inserts into it and cannot read it. It is held
                  -- to its own rule by stagingGrantFindings below.
                  AND has_table_privilege('bob_feeder', c.oid, 'SELECT')))
    ), lineage AS (
      SELECT oid FROM named
      UNION
      SELECT i.inhrelid FROM pg_inherits i JOIN lineage l ON i.inhparent = l.oid
    )
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified,
           c.relname AS table_name,
           c.relispartition AS is_partition,
           c.oid::text AS oid
      FROM lineage l
      JOIN pg_class c ON c.oid = l.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     ORDER BY 1`)
  return rows
}

export async function projectionGrantFindings(client) {
  const findings = []
  for (const t of await projectionTables(client)) {
    const { rows } = await client.query(`
      SELECT r AS role, p AS privilege,
             has_table_privilege(r, $1::oid, p) AS held
        FROM unnest($2::text[]) r, unnest($3::text[]) p
      UNION ALL
      SELECT 'bob_feeder', p, has_table_privilege('bob_feeder', $1::oid, p)
        FROM unnest($4::text[]) p`,
      [t.oid, NEVER_WRITES, WRITE, FEEDER_NEEDS])

    const kind = t.is_partition ? 'a partition of a projection' : 'a projection table'
    for (const r of rows) {
      if (r.role !== 'bob_feeder' && r.held) {
        findings.push({
          table: t.table_name,
          rule: 'PR-4',
          finding:
            `${r.role} holds ${r.privilege} on ${kind}. BOb never writes a ` +
            'projection. Pass the table through bob_grant_projection() where ' +
            'it is created, partitions included',
        })
      }
      if (r.role === 'bob_feeder' && !r.held) {
        findings.push({
          table: t.table_name,
          rule: 'PR-4',
          finding:
            `bob_feeder lacks ${r.privilege} on ${kind}. A projection the ` +
            'feeder cannot write is as broken as one the application can. ' +
            'Pass it through bob_grant_projection()',
        })
      }
    }
  }
  return findings
}

// P5 Q6 (a) · feeder staging tables. Found by their grants, in any schema: a
// base table outside the proj_ names that bob_feeder can write in any way
// (INSERT, UPDATE, DELETE or TRUNCATE, on the table or on a column) and
// cannot SELECT from. The feeder drops rows there; bob_app consumes them.
// Today that is bob.member_refs_seen and bob.member_refs_runs, and the suite
// asserts both are found.
//
// Any write, not INSERT alone (review of PR #33): a write the feeder holds
// without SELECT is not a projection either, so with INSERT alone here a
// DELETE on `actors` fell through both discoveries. It lands here, and the
// staging rule reports the privilege it should not hold.
export async function feederStagingTables(client) {
  const { rows } = await client.query(`
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified,
           c.relname AS table_name, c.oid::text AS oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT LIKE 'pg\\_%'
       AND n.nspname <> 'information_schema'
       AND c.relkind IN ('r', 'p')
       AND c.relname NOT LIKE 'proj\\_%'
       AND (has_table_privilege('bob_feeder', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
            OR has_any_column_privilege('bob_feeder', c.oid, 'INSERT, UPDATE'))
       AND NOT has_table_privilege('bob_feeder', c.oid, 'SELECT')
     ORDER BY 1`)
  return rows
}

// What each role holds on a staging table, and nothing more, on the table or
// on any column. `bob_grant_feeder_staging()` grants exactly this. A table
// that does not match is a finding; so is one without org_id, since the
// feeder writes it under a tenant's claim (F-22). The roles below are checked
// by name, and every other grantee is discovered from the table's and its
// columns' ACLs: any role not named here that holds anything is a finding.
export const STAGING_GRANTS = {
  bob_feeder: ['INSERT'],
  bob_app: ['SELECT', 'DELETE'],
  bob_ai_ro: [],
  anon: [],
  authenticated: [],
  service_role: [],
  public: [],
}
const ALL_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
const COLUMN_PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'])

export async function stagingGrantFindings(client) {
  const findings = []
  const tenant = new Set((await tenantTables(client)).map((t) => t.qualified))
  for (const t of await feederStagingTables(client)) {
    const { rows: grantees } = await client.query(`
      SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'public'
                           ELSE pg_get_userbyid(a.grantee) END AS role, a.privilege_type
        FROM pg_class c, aclexplode(c.relacl) a
       WHERE c.oid = $1::oid AND a.grantee <> c.relowner
      UNION
      SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'public'
                           ELSE pg_get_userbyid(a.grantee) END, a.privilege_type
        FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid,
             aclexplode(at.attacl) a
       WHERE at.attrelid = $1::oid AND at.attacl IS NOT NULL AND a.grantee <> c.relowner
       ORDER BY 1, 2`, [t.oid])
    const unknown = new Map()
    for (const g of grantees) {
      if (g.role in STAGING_GRANTS) continue
      if (!unknown.has(g.role)) unknown.set(g.role, [])
      unknown.get(g.role).push(g.privilege_type)
    }
    for (const [role, privileges] of unknown) {
      findings.push({ table: t.table_name, rule: 'P5 Q6',
        finding: `${role} holds ${privileges.join(', ')} on a feeder staging table, and is ` +
          'no role it may grant to. Pass the table through bob_grant_feeder_staging()' })
    }
    if (!tenant.has(t.qualified)) {
      findings.push({ table: t.table_name, rule: 'P5 Q6',
        finding: 'is a feeder staging table without org_id, so no claim holds its rows to a tenant' })
    }
    for (const [role, want] of Object.entries(STAGING_GRANTS)) {
      const { rows } = await client.query(`
        SELECT p,
               CASE WHEN p = ANY($4::text[])
                    THEN has_any_column_privilege($1, $2::oid, p)
                    ELSE has_table_privilege($1, $2::oid, p) END AS held
          FROM unnest($3::text[]) p`,
      [role, t.oid, ALL_PRIVILEGES, [...COLUMN_PRIVILEGES]])
      const got = rows.filter((r) => r.held).map((r) => r.p)
      if (got.join() !== want.join()) {
        findings.push({ table: t.table_name, rule: 'P5 Q6',
          finding: `${role} holds ${got.join(', ') || 'nothing'} on a feeder staging table; ` +
            `it must hold ${want.join(', ') || 'nothing'}. Pass the table through ` +
            'bob_grant_feeder_staging()' })
      }
    }
  }
  return findings
}

// Tenant tables `authenticated` cannot read at all. They cannot leak to it, so
// the leak checks that read as `authenticated` leave them out; the tenancy
// suite asserts this set is the staging tables and nothing else, so the
// exclusion cannot hide a table that lost its grant by accident.
export async function tenantTablesUnreadableByApi(client) {
  const out = []
  for (const t of await tenantTables(client)) {
    const { rows: [r] } = await client.query(
      "SELECT has_table_privilege('authenticated', $1::regclass, 'SELECT') AS ok", [t.qualified])
    if (!r.ok) out.push(t)
  }
  return out
}
