// Structural tenancy checks, written as functions that RETURN findings rather
// than assert inline.
//
// That shape is deliberate: ID-12 requires the suite to be build-blocking, and
// the only honest way to show a suite blocks is to prove it can go red. The
// meta-test creates a deliberately broken table, calls these same functions,
// and asserts they report it. A green suite that cannot go red is not a suite.

import { tenantTables } from './db.mjs'

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
              OR EXISTS (
                SELECT 1 FROM aclexplode(c.relacl) a
                 WHERE a.grantee = 'bob_feeder'::regrole
                   AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')))
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
