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
const PUBLIC_FACING = new Set(['public', 'anon', 'authenticated'])

export async function structuralFindings(client) {
  const findings = []
  const tables = await tenantTables(client)

  // roles comes back as name[]; cast so the driver parses it as an array
  // rather than handing back the literal '{authenticated}'.
  const { rows: policies } = await client.query(`
    SELECT schemaname, tablename, policyname, roles::text[] AS roles, cmd, qual, with_check
      FROM pg_policies`)

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
// base table outside the proj_ names that bob_feeder can INSERT into and cannot
// SELECT from. The feeder drops rows there; bob_app consumes them. Today that
// is bob.member_refs_seen, and the suite asserts it is found.
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
       AND has_table_privilege('bob_feeder', c.oid, 'INSERT')
       AND NOT has_table_privilege('bob_feeder', c.oid, 'SELECT')
     ORDER BY 1`)
  return rows
}

// What each role holds on a staging table, and nothing more, on the table or
// on any column. `bob_grant_feeder_staging()` grants exactly this. A table
// that does not match is a finding; so is one without org_id, since the
// feeder writes it under a tenant's claim (F-22).
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
