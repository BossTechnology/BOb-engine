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
  connect, tenantTables, tenantRootTables, TENANCY_FLOOR, TENANT_A, TENANT_B,
} from './helpers/db.mjs'
import {
  structuralFindings, projectionGrantFindings, aggregateLeakFindings,
  truncateFindings, truncateDefaultFindings, constrainsTenant,
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

    // bob-web runs as bob_app. A table granted to it with every policy aimed
    // at another role answers it with nothing, silently: in the box, bob.users
    // read empty and nobody could sign in.
    test(`a table granted to bob_app that no policy reaches is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_app_unreached (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL);
        ALTER TABLE $S.meta_probe_app_unreached ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "members_only" ON $S.meta_probe_app_unreached
          FOR SELECT TO authenticated USING (org_id = (auth.jwt() ->> 'org_id')::uuid);
        GRANT SELECT ON $S.meta_probe_app_unreached TO bob_app;`, async () => {
        const findings = await structuralFindings(db)
        const hit = findings.find((f) => f.table === 'meta_probe_app_unreached')
        assert.ok(hit, 'a table bob_app is granted and no policy reaches went unreported')
        assert.match(hit.finding, /bob_app/)
      })
    })

    // F-46. A table keyed by its own id, which org_id points to, carries no
    // org_id, so a discovery by column never saw it: bob_app held SELECT on
    // bob.organizations and read its own organization as empty. The child
    // table is what marks the probe as a tenant root; it is guarded, so the
    // only finding expected is the root's.
    test(`a table keyed by id, granted to bob_app with no policy reaching it, is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_root (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT);
        ALTER TABLE $S.meta_probe_root ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "members_read_own" ON $S.meta_probe_root
          FOR SELECT TO authenticated USING (id = (auth.jwt() ->> 'org_id')::uuid);
        GRANT SELECT ON $S.meta_probe_root TO bob_app;
        CREATE TABLE $S.meta_probe_root_child (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL REFERENCES $S.meta_probe_root (id));
        ALTER TABLE $S.meta_probe_root_child ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "tenant" ON $S.meta_probe_root_child
          FOR SELECT TO authenticated USING (org_id = (auth.jwt() ->> 'org_id')::uuid);`,
      async () => {
        const roots = await tenantRootTables(db)
        assert.ok(roots.some((t) => t.qualified === `${s}.meta_probe_root` && t.tenant_keys.includes('id')),
          `the table org_id points to was not discovered: ${JSON.stringify(roots.map((t) => t.qualified))}`)
        const findings = await structuralFindings(db)
        const hit = findings.find((f) => f.table === 'meta_probe_root')
        assert.ok(hit, 'a table keyed by id that bob_app is granted and no policy reaches went unreported')
        assert.match(hit.finding, /bob_app is granted SELECT but no SELECT policy reaches it/)
      })
    })

    test(`a bob_app policy on a table keyed by id that does not constrain id is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_root_open (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
        ALTER TABLE $S.meta_probe_root_open ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "app_any_claim" ON $S.meta_probe_root_open
          FOR SELECT TO bob_app USING ((auth.jwt() ->> 'org_id') IS NOT NULL);
        CREATE TABLE $S.meta_probe_root_open_child (
          org_id UUID NOT NULL REFERENCES $S.meta_probe_root_open (id));`, async () => {
        const findings = await structuralFindings(db)
        const hit = findings.find((f) => f.table === 'meta_probe_root_open')
        assert.ok(hit, 'a policy reachable by bob_app that ignores id went unreported')
        assert.match(hit.finding, /does not constrain id/)
      })
    })

    // No expression is not a tenant-scoped one. It refuses every row, and
    // the reach check would read it as a policy that reaches the grant.
    test(`a bob_app policy with no expression at all is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_empty_policy (org_id UUID NOT NULL);
        ALTER TABLE $S.meta_probe_empty_policy ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "app_nothing" ON $S.meta_probe_empty_policy FOR SELECT TO bob_app;
        GRANT SELECT ON $S.meta_probe_empty_policy TO bob_app;`, async () => {
        const findings = await structuralFindings(db)
        assert.ok(findings.some((f) => f.table === 'meta_probe_empty_policy' &&
          /does not constrain org_id/.test(f.finding)), 'a policy with no expression went unreported')
      })
    })

    // bob_feeder writes the projections under each tenant's claim (F-22). A
    // grant it holds that no policy reaches fails every time, like bob_app's.
    test(`a table granted to bob_feeder that no policy reaches is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_feeder_unreached (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL);
        ALTER TABLE $S.meta_probe_feeder_unreached ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "members_only" ON $S.meta_probe_feeder_unreached
          FOR SELECT TO authenticated USING (org_id = (auth.jwt() ->> 'org_id')::uuid);
        GRANT SELECT, INSERT ON $S.meta_probe_feeder_unreached TO bob_feeder;`, async () => {
        const hits = (await structuralFindings(db)).filter((f) => f.table === 'meta_probe_feeder_unreached')
        assert.ok(hits.some((f) => /^bob_feeder is granted INSERT/.test(f.finding)),
          `a bob_feeder grant no policy reaches went unreported: ${JSON.stringify(hits)}`)
      })
    })

    // Review of PR #43. Naming the key is not constraining it: a subquery
    // over another table's `id` names `id` and lets every row through.
    test(`a bob_app policy keyed by a subquery over u.id is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_root_subq (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
        ALTER TABLE $S.meta_probe_root_subq ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "app_via_users" ON $S.meta_probe_root_subq FOR SELECT TO bob_app
          USING (EXISTS (SELECT 1 FROM bob.users u WHERE u.id = auth.uid()));
        GRANT SELECT ON $S.meta_probe_root_subq TO bob_app;
        CREATE TABLE $S.meta_probe_root_subq_child (
          org_id UUID NOT NULL REFERENCES $S.meta_probe_root_subq (id));`, async () => {
        const findings = await structuralFindings(db)
        const hit = findings.find((f) => f.table === 'meta_probe_root_subq')
        assert.ok(hit, 'a policy that only names u.id in a subquery passed for constraining id')
        assert.match(hit.finding, /does not constrain id to the org_id claim/)
      })
    })

    // A foreign key may reference any unique key, not only the primary key.
    test(`a root that org_id reaches through a unique slug is discovered and checked (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_root_slug (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          slug TEXT NOT NULL UNIQUE);
        ALTER TABLE $S.meta_probe_root_slug ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "members" ON $S.meta_probe_root_slug FOR SELECT TO authenticated
          USING (id = (auth.jwt() ->> 'org_id')::uuid);
        GRANT SELECT ON $S.meta_probe_root_slug TO bob_app;
        CREATE TABLE $S.meta_probe_root_slug_child (
          org_id TEXT NOT NULL REFERENCES $S.meta_probe_root_slug (slug));`, async () => {
        const roots = await tenantRootTables(db)
        const root = roots.find((t) => t.qualified === `${s}.meta_probe_root_slug`)
        assert.ok(root, 'a root reached through a unique, non-primary key was not discovered')
        assert.deepEqual(root.tenant_keys, ['slug'])
        assert.ok((await structuralFindings(db)).some((f) => f.table === 'meta_probe_root_slug' &&
          /bob_app is granted SELECT/.test(f.finding)), 'the slug-keyed root went unchecked')
      })
    })

    // A composite foreign key that carries org_id among its columns.
    test(`a root that org_id reaches through a composite key is discovered and checked (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_root_pair (
          id UUID NOT NULL, region TEXT NOT NULL, PRIMARY KEY (region, id));
        ALTER TABLE $S.meta_probe_root_pair ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "members" ON $S.meta_probe_root_pair FOR SELECT TO authenticated
          USING (id = (auth.jwt() ->> 'org_id')::uuid);
        GRANT SELECT ON $S.meta_probe_root_pair TO bob_app;
        CREATE TABLE $S.meta_probe_root_pair_child (
          region TEXT NOT NULL, org_id UUID NOT NULL,
          FOREIGN KEY (region, org_id) REFERENCES $S.meta_probe_root_pair (region, id));`, async () => {
        const root = (await tenantRootTables(db)).find((t) => t.qualified === `${s}.meta_probe_root_pair`)
        assert.ok(root, 'a root reached through a composite foreign key was not discovered')
        assert.deepEqual(root.tenant_keys, ['id'], 'the tenant key is the column org_id lands on')
        assert.ok((await structuralFindings(db)).some((f) => f.table === 'meta_probe_root_pair' &&
          /bob_app is granted SELECT/.test(f.finding)), 'the composite-keyed root went unchecked')
      })
    })

    test(`TRUNCATE on a table keyed by id, granted to an application role, is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_root_truncate (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
        CREATE TABLE $S.meta_probe_root_truncate_child (
          org_id UUID NOT NULL REFERENCES $S.meta_probe_root_truncate (id));
        GRANT TRUNCATE ON $S.meta_probe_root_truncate TO bob_app;`, async () => {
        const hits = (await truncateFindings(db)).filter((f) => f.table === 'meta_probe_root_truncate')
        assert.ok(hits.some((f) => /^bob_app holds TRUNCATE/.test(f.finding)),
          'TRUNCATE for bob_app on a tenant root went unreported')
      })
    })

    test(`an aggregate over a table keyed by id that crosses the boundary is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_root_count (id UUID PRIMARY KEY);
        ALTER TABLE $S.meta_probe_root_count ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "names_id" ON $S.meta_probe_root_count
          FOR SELECT TO authenticated USING (id IS NOT NULL);
        GRANT USAGE ON SCHEMA $S TO authenticated;
        GRANT SELECT ON $S.meta_probe_root_count TO authenticated;
        INSERT INTO $S.meta_probe_root_count (id) VALUES ('${TENANT_A}'), ('${TENANT_B}');
        CREATE TABLE $S.meta_probe_root_count_child (
          org_id UUID NOT NULL REFERENCES $S.meta_probe_root_count (id));`, async () => {
        const { findings } = await aggregateLeakFindings(db, TENANT_A, TENANT_B)
        assert.ok(findings.some((f) => f.table === 'meta_probe_root_count'),
          'a count over a tenant root that reached the other tenant went unreported')
      })
    })

    // A write granted with only a read policy: refused by RLS, every time.
    test(`a write granted to bob_app with only a SELECT policy is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_app_write (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL);
        ALTER TABLE $S.meta_probe_app_write ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "read_only" ON $S.meta_probe_app_write
          FOR SELECT USING (org_id = (auth.jwt() ->> 'org_id')::uuid);
        GRANT SELECT, INSERT ON $S.meta_probe_app_write TO bob_app;`, async () => {
        const findings = await structuralFindings(db)
        const hit = findings.find((f) => f.table === 'meta_probe_app_write')
        assert.ok(hit, 'an INSERT granted to bob_app that no INSERT policy reaches went unreported')
        assert.match(hit.finding, /INSERT/)
      })
    })

    test(`a bob_app policy that does not constrain org_id is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_app_open (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL);
        ALTER TABLE $S.meta_probe_app_open ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "app_wide_open" ON $S.meta_probe_app_open
          FOR SELECT TO bob_app USING (true);`, async () => {
        const findings = await structuralFindings(db)
        const hit = findings.find((f) => f.table === 'meta_probe_app_open')
        assert.ok(hit, 'a policy reachable by bob_app that ignores org_id went unreported')
        assert.match(hit.finding, /does not constrain org_id/)
      })
    })

    test(`TRUNCATE on a tenant table, granted to an application role, is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_truncate (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL);
        ALTER TABLE $S.meta_probe_truncate ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "tenant" ON $S.meta_probe_truncate FOR ALL
          USING (org_id = (auth.jwt() ->> 'org_id')::uuid);
        GRANT TRUNCATE ON $S.meta_probe_truncate TO authenticated;`, async () => {
        // In public, Supabase's default privileges also hand it to anon.
        const hits = (await truncateFindings(db)).filter((f) => f.table === 'meta_probe_truncate')
        assert.ok(hits.some((f) => /^authenticated holds TRUNCATE/.test(f.finding)),
          'TRUNCATE for authenticated on a tenant table went unreported')
      })
    })

    test(`a default privilege handing out TRUNCATE is reported (in ${s})`, async () => {
      await probe(s, `
        CREATE TABLE $S.meta_probe_default_truncate (org_id UUID NOT NULL);
        ALTER DEFAULT PRIVILEGES IN SCHEMA $S GRANT TRUNCATE ON TABLES TO bob_app;`, async () => {
        const findings = await truncateDefaultFindings(db)
        assert.ok(findings.some((f) => f.startsWith(`tables ${s} creates hand TRUNCATE to bob_app`)),
          `a default TRUNCATE in ${s} went unreported: ${JSON.stringify(findings)}`)
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

  // The expressions themselves, without the catalog: what counts as
  // constraining the tenant key and what only names it (review of PR #43).
  test('a policy constrains the tenant only by comparing its key with the org_id claim', () => {
    const C = "((auth.jwt() ->> 'org_id'::text))::uuid"
    const cases = [
      [`(org_id = ${C})`, ['org_id'], true],
      [`(id = ${C})`, ['id'], true],
      [`((user_id = auth.uid()) AND (org_id = ${C}))`, ['org_id'], true],
      [`(${C} = id)`, ['id'], true],
      ['(id IS NOT NULL)', ['id'], false],
      ["((auth.jwt() ->> 'id'::text) IS NOT NULL)", ['id'], false],
      ['(EXISTS ( SELECT 1 FROM users u WHERE (u.id = auth.uid())))', ['id'], false],
      [`(EXISTS ( SELECT 1 FROM users u WHERE (u.id = ${C})))`, ['id'], false],
      [`((id = ${C}) OR true)`, ['id'], false],
      [`(NOT (id = ${C}))`, ['id'], false],
      [`(o.id = ${C})`, ['id'], false],
      [`(org_id = ${C})`, ['id'], false],
      ['true', ['org_id'], false],
      // Holding the comparison is not being bound by it: each of these
      // contains it word for word and still lets another tenant's row through.
      [`CASE WHEN (id = ${C}) THEN true ELSE true END`, ['id'], false],
      [`COALESCE((id = ${C}), true)`, ['id'], false],
      [`((id = ${C}) IS NOT TRUE)`, ['id'], false],
      [`((id = ${C}) IS FALSE)`, ['id'], false],
      [`((id = ${C}) = false)`, ['id'], false],
      // A bracket or an AND inside a literal or a quoted name is text.
      [`((name = ') AND (id = ${C.replaceAll("'", "''")}) AND ('::text))`, ['id'], false],
      [`((name = ')'::text) AND (id = ${C}))`, ['id'], true],
      [`((a AND (id = ${C})) AND b)`, ['id'], true],
      [`("Tenant Id" = ${C})`, ['Tenant Id'], true],
      // The key is a name, never a pattern.
      [`(id = ${C})`, ['i.'], false],
      [`(id = ${C})`, ['(id'], false],
    ]
    for (const [expr, keys, want] of cases) {
      assert.equal(constrainsTenant(expr, keys), want, `${expr} with key ${keys}`)
    }
  })

  // org_id with no foreign key says nothing about which table holds the
  // tenants. If none of them had one, discovery would find no root, and the
  // check fails closed rather than reading an empty set as clean.
  test('with no foreign key on any org_id, the missing tenant root is reported', async () => {
    await db.query('BEGIN')
    try {
      const { rows } = await db.query(`
        SELECT DISTINCT f.conrelid::regclass::text AS rel, f.conname
          FROM pg_constraint f
          JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attname = 'org_id'
                             AND a.attnum = ANY (f.conkey)
         WHERE f.contype = 'f' AND f.conparentid = 0`)
      assert.ok(rows.length > 0, 'no foreign key on org_id to drop, so this proves nothing')
      for (const r of rows) await db.query(`ALTER TABLE ${r.rel} DROP CONSTRAINT "${r.conname}"`)
      assert.deepEqual(await tenantRootTables(db), [])
      assert.ok((await structuralFindings(db)).some((f) => f.table === '(tenant root)'),
        'tables carry org_id, no root was found, and the check said nothing')
    } finally {
      await db.query('ROLLBACK')
    }
  })

  // `otherRows` is what shows the aggregate check had something to leak. The
  // other tenant's own organization row always exists, so counting it there
  // would keep that floor green over empty tables.
  test("the other tenant's organization row alone is nothing to leak", async () => {
    await db.query('BEGIN')
    try {
      const { rows: [other] } = await db.query(`
        INSERT INTO bob.organizations (name, slug)
        VALUES ('Cliente Demo', 'cliente-demo-vacio') RETURNING id`)
      const { otherRows } = await aggregateLeakFindings(db, TENANT_A, other.id)
      assert.equal(otherRows, 0, 'an empty tenant counted as something that could leak')
    } finally {
      await db.query('ROLLBACK')
    }
  })

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
