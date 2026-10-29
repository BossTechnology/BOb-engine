// ID-12 — a tenancy failure is a build-blocking defect, not a bug.
//
// Two halves. The workflow makes the suite blocking; this file proves the suite
// can go red. A green suite that cannot go red is not a suite, and a
// build-blocking check that always passes blocks nothing.
//
// Every case creates its defect inside a transaction and rolls back, so the
// suite never leaves a broken table behind for a later test to trip over.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  connect, tenantTables, TENANCY_FLOOR, TENANT_A, TENANT_B,
} from './helpers/db.mjs'
import {
  structuralFindings, projectionGrantFindings, aggregateLeakFindings,
} from './helpers/rls.mjs'

let db

before(async () => { db = await connect() })
after(async () => { await db?.end() })

// Every probe runs in `public` and in `bob`, the schema Slice 2 moves the
// tables to. A probe created only in `public` cannot tell a discovery that
// follows the tables from one pinned to 'public' — which is how the suite
// would have gone hollow on the move with every test still green.
const SCHEMAS = ['public', 'bob']

// Create the defect inside a transaction, run the check, roll back.
async function probe(schema, ddl, check) {
  await db.query('BEGIN')
  try {
    await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await db.query(ddl.replaceAll('$S', schema))
    return await check()
  } finally {
    await db.query('ROLLBACK')
  }
}

describe('ID-12 · the tenancy suite detects what it claims to detect', () => {
  for (const s of SCHEMAS) {
    test(`a table with org_id and no RLS is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_no_rls (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL)`, async () => {
        const findings = await structuralFindings(db)
        const hit = findings.find((f) => f.table === 'meta_probe_no_rls')

        assert.ok(hit, 'a table carrying org_id without RLS went unreported')
        assert.match(hit.finding, /row-level security is not enabled/)
      })
    })

    test(`a table with RLS but no policy is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_no_policy (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL);
        ALTER TABLE $S.meta_probe_no_policy ENABLE ROW LEVEL SECURITY;`, async () => {
        const findings = await structuralFindings(db)
        assert.ok(
          findings.some((f) => f.table === 'meta_probe_no_policy'),
          'RLS enabled with no policy went unreported',
        )
      })
    })

    // The subtle one. RLS on, a policy present, and the policy does not
    // actually constrain the tenant — which looks correct in every listing.
    test(`a policy that does not constrain org_id is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_open_policy (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL);
        ALTER TABLE $S.meta_probe_open_policy ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "wide_open" ON $S.meta_probe_open_policy
          FOR ALL TO authenticated USING (true);`, async () => {
        const findings = await structuralFindings(db)
        const hit = findings.find((f) => f.table === 'meta_probe_open_policy')

        assert.ok(hit, 'a policy reachable by authenticated that ignores org_id went unreported')
        assert.match(hit.finding, /does not constrain org_id/)
      })
    })

    // A partition does not inherit its parent's RLS. Read directly, it
    // returns every tenant's rows, however tight the parent's policy is.
    test(`a partition without RLS is reported, even under a guarded parent (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_parted (
          org_id UUID NOT NULL,
          bucket_start TIMESTAMPTZ NOT NULL) PARTITION BY RANGE (bucket_start);
        ALTER TABLE $S.meta_probe_parted ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "tenant" ON $S.meta_probe_parted
          FOR ALL TO authenticated
          USING (org_id = (auth.jwt() ->> 'org_id')::uuid);
        CREATE TABLE $S.meta_probe_parted_2026_11 PARTITION OF $S.meta_probe_parted
          FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');`, async () => {
        const findings = await structuralFindings(db)
        assert.ok(
          findings.some((f) => f.table === 'meta_probe_parted_2026_11' &&
            /row-level security is not enabled/.test(f.finding)),
          'a partition readable without RLS went unreported',
        )
      })
    })

    // A policy that names org_id and still lets every row through. The
    // structural check reads the expression and is satisfied; only counting
    // what the tenant sees against what it owns shows the leak.
    test(`an aggregate that crosses the boundary is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_aggregate (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL);
        ALTER TABLE $S.meta_probe_aggregate ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "names_org_id" ON $S.meta_probe_aggregate
          FOR SELECT TO authenticated USING (org_id IS NOT NULL);
        GRANT USAGE ON SCHEMA $S TO authenticated;
        GRANT SELECT ON $S.meta_probe_aggregate TO authenticated;
        INSERT INTO $S.meta_probe_aggregate (org_id)
          VALUES ('${TENANT_A}'), ('${TENANT_B}');`, async () => {
        const { findings } = await aggregateLeakFindings(db, TENANT_A, TENANT_B)
        assert.ok(
          findings.some((f) => f.table === 'meta_probe_aggregate'),
          'a count that reached the other tenant went unreported',
        )
      })
    })

    test(`a projection table writable by the application is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.proj_meta_probe (
          org_id UUID NOT NULL,
          bucket_start TIMESTAMPTZ NOT NULL);
        GRANT INSERT ON $S.proj_meta_probe TO authenticated;`, async () => {
        const findings = await projectionGrantFindings(db)
        assert.ok(
          findings.some((f) => f.table === 'proj_meta_probe' &&
            /authenticated holds INSERT/.test(f.finding)),
          'PR-4 violation on a projection table went unreported',
        )
      })
    })

    // Not named proj_. The feeder writes it, so it is a projection.
    test(`a projection without the proj_ prefix is still checked (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_feed (
          org_id UUID NOT NULL,
          bucket_start TIMESTAMPTZ NOT NULL);
        GRANT SELECT, INSERT, UPDATE, DELETE ON $S.meta_probe_feed TO bob_feeder;
        GRANT UPDATE ON $S.meta_probe_feed TO bob_app;`, async () => {
        const findings = await projectionGrantFindings(db)
        assert.ok(
          findings.some((f) => f.table === 'meta_probe_feed' &&
            /bob_app holds UPDATE/.test(f.finding)),
          'a projection escaped PR-4 because of its name',
        )
      })
    })

    test(`a projection writable through PUBLIC is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.proj_meta_probe_public (
          org_id UUID NOT NULL,
          bucket_start TIMESTAMPTZ NOT NULL);
        SELECT public.bob_grant_projection('$S.proj_meta_probe_public');
        GRANT DELETE ON $S.proj_meta_probe_public TO PUBLIC;`, async () => {
        const findings = await projectionGrantFindings(db)
        assert.ok(
          findings.some((f) => f.table === 'proj_meta_probe_public' &&
            /public holds DELETE/.test(f.finding)),
          'a write grant to PUBLIC on a projection went unreported',
        )
      })
    })

    test(`a projection the feeder cannot write is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.proj_meta_probe_starved (
          org_id UUID NOT NULL,
          bucket_start TIMESTAMPTZ NOT NULL);
        SELECT public.bob_grant_projection('$S.proj_meta_probe_starved');
        REVOKE INSERT ON $S.proj_meta_probe_starved FROM bob_feeder;`, async () => {
        const findings = await projectionGrantFindings(db)
        assert.ok(
          findings.some((f) => f.table === 'proj_meta_probe_starved' &&
            /bob_feeder lacks INSERT/.test(f.finding)),
          'a projection the feeder cannot write went unreported',
        )
      })
    })

    // Grants are not copied from a parent to a partition created after it.
    // The partition carries no proj_ prefix, so only its lineage marks it.
    test(`a partition created after bob_grant_projection() is checked (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.proj_meta_probe_parted (
          org_id UUID NOT NULL,
          bucket_start TIMESTAMPTZ NOT NULL) PARTITION BY RANGE (bucket_start);
        SELECT public.bob_grant_projection('$S.proj_meta_probe_parted');
        CREATE TABLE $S.meta_probe_month_2026_11 PARTITION OF $S.proj_meta_probe_parted
          FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');`, async () => {
        const findings = await projectionGrantFindings(db)
        const onPartition = findings.filter((f) => f.table === 'meta_probe_month_2026_11')
        const onParent = findings.filter((f) => f.table === 'proj_meta_probe_parted')

        assert.deepEqual(onParent, [], 'the granted parent itself was reported')
        assert.ok(
          onPartition.some((f) => /partition of a projection/.test(f.finding)),
          'a partition that missed bob_grant_projection() went unreported',
        )
      })
    })
  }

  // The schema move itself, rehearsed. Every tenant table goes to `bob` and
  // discovery has to follow it: the same set, now all outside `public`, and
  // the policies still matched to their tables.
  test('moving the tenant tables to bob does not hide them from discovery', async () => {
    const before = await tenantTables(db)
    assert.ok(TENANCY_FLOOR.every((n) => before.some((t) => t.table_name === n)),
      'the floor is not met before the move, so this rehearsal proves nothing')

    await db.query('BEGIN')
    try {
      await db.query('CREATE SCHEMA IF NOT EXISTS bob')
      for (const t of before.filter((t) => t.table_schema === 'public')) {
        await db.query(`ALTER TABLE ${t.qualified} SET SCHEMA bob`)
      }

      const after = await tenantTables(db)
      assert.deepEqual(
        after.map((t) => t.table_name).sort(),
        before.map((t) => t.table_name).sort(),
        'discovery lost or gained tables when they moved schema')
      assert.deepEqual(
        after.filter((t) => t.table_schema === 'public').map((t) => t.table_name), [],
        'tables still reported in public after the move')
      assert.deepEqual(await structuralFindings(db), [],
        'the moved tables lost their policies in the eyes of the check')
    } finally {
      await db.query('ROLLBACK')
    }
  })
})
