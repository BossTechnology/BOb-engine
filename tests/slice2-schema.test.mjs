// Slice 2 · the projection schema, against projection contract 0.5.1 §10.
//
// The guards that need no feeder. Each was seen failing on purpose before it
// was trusted; the table is in contract-amendments.md, "Slice 2 · The
// projection schema, built". The guards that need rows written by the
// reference feeder (sealed at write time, every turn accounted, lag not
// declared, unmapped by route, the ghost path, rebuild with linkage) ride with
// the feeder.
//
// Everything that creates something does so inside a transaction and rolls
// back, so no partition, row or grant outlives the test that made it.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  connect, loadFixture, loadRoster, tenantTables, REPO_ROOT, TENANT_A, TENANT_B,
} from './helpers/db.mjs'
import {
  projectionTables, projectionGrantFindings, structuralFindings, feederStagingTables,
} from './helpers/rls.mjs'

let db

before(async () => {
  db = await connect()
  await loadFixture(db)
  await loadRoster(db)
})
after(async () => { await db?.end() })

const CHANNEL_A = 'aaaaaaaa-2222-4000-8000-000000000001'   // WhatsApp, tenant A
const CHANNEL_B = 'bbbbbbbb-2222-4000-8000-000000000002'   // Voice, tenant B
const MONTH = '2026-11-01'
const BUCKET = '2026-11-18 14:05:00+00'

// The eight names, read from §6 of the contract itself, not copied here: the
// test and the contract cannot drift apart without this file going red.
function contractProjectionNames() {
  const text = readFileSync(resolve(REPO_ROOT, 'docs/contracts/projection-contract.md'), 'utf8')
  const start = text.indexOf('## 6 · The eight tables')
  const end = text.indexOf('**Columns:', start)
  assert.ok(start >= 0 && end > start, 'contract §6 not found where the guard reads it')
  return [...text.slice(start, end).matchAll(/^- `(proj_[a-z_]+)`$/gm)].map((m) => m[1]).sort()
}

async function inTx(fn) {
  await db.query('BEGIN')
  try { return await fn() } finally { await db.query('ROLLBACK') }
}

// Become one of the three roles inside the caller's transaction. The migration
// owner is not a member of them, so membership is granted here and rolls back
// with everything else. `orgId` sets the claim the tenant policy reads (F-22).
async function becomeRole(role, orgId) {
  await db.query(`GRANT ${role} TO current_user`)
  if (orgId) {
    await db.query('SELECT set_config($1, $2, true)',
      ['request.jwt.claims', JSON.stringify({ org_id: orgId })])
  }
  await db.query(`SET LOCAL ROLE ${role}`)
}

// Run `sql` and return the SQLSTATE it raised, or null. Inside a savepoint, so
// the caller's transaction survives the error.
async function refusal(sql, params = []) {
  await db.query('SAVEPOINT probe')
  try {
    await db.query(sql, params)
    await db.query('RELEASE SAVEPOINT probe')
    return null
  } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT probe')
    return e.code || e.message
  }
}

async function ensurePartition(parent, month = MONTH) {
  const { rows: [{ oid }] } = await db.query(
    'SELECT bob.proj_ensure_partition($1::regclass, $2::date)::oid AS oid', [parent, month])
  const { rows } = await db.query(`
    SELECT format('%I.%I', n.nspname, c.relname) AS p
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = $1`, [oid])
  return rows[0].p
}

async function parents() {
  return (await projectionTables(db)).filter((t) => !t.is_partition)
}

async function columns(qualified) {
  const { rows } = await db.query(`
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS not_null
      FROM pg_attribute a
     WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
  [qualified])
  return rows
}

describe('§10 · exactly eight, in schema bob', () => {
  test('the non-partition projections are the eight names of contract §6', async () => {
    const named = contractProjectionNames()
    assert.equal(named.length, 8, `contract §6 lists ${named.length} names, not eight`)
    const found = (await parents()).map((t) => t.qualified).sort()
    assert.deepEqual(found, named.map((n) => `bob.${n}`))
  })

  test('nothing BOb owns is left in public', async () => {
    const { rows } = await db.query(`
      SELECT c.relname, c.relkind FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`)
    assert.deepEqual(rows, [], 'tables or views still in public after the move')
  })
})

describe('§3 · the partition function (H1)', () => {
  test('run twice for one month: one partition, granted, with RLS', async () => {
    await inTx(async () => {
      const first = await ensurePartition('bob.proj_metric_counts')
      const second = await ensurePartition('bob.proj_metric_counts')
      assert.equal(first, 'bob.proj_metric_counts_y2026m11')
      assert.equal(second, first)

      const { rows } = await db.query(`
        SELECT c.relname, c.relrowsecurity,
               (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
               pg_get_expr(c.relpartbound, c.oid) AS bound
          FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'bob.proj_metric_counts'::regclass`)
      assert.equal(rows.length, 1, 'a second call created a second partition')
      assert.ok(rows[0].relrowsecurity, 'the partition has no RLS')
      assert.equal(rows[0].policies, 1)
      assert.match(rows[0].bound, /2026-11-01 00:00:00\+00.*2026-12-01 00:00:00\+00/)

      const findings = (await projectionGrantFindings(db))
        .filter((f) => f.table === 'proj_metric_counts_y2026m11')
      assert.deepEqual(findings, [])
    })
  })

  test('bob_feeder can execute it, and no other role can', async () => {
    const { rows } = await db.query(`
      SELECT r.rolname
        FROM pg_roles r
       WHERE has_function_privilege(r.oid,
               'bob.proj_ensure_partition(regclass, date)', 'EXECUTE')
         AND NOT r.rolsuper
         AND r.oid <> (SELECT proowner FROM pg_proc
                        WHERE oid = 'bob.proj_ensure_partition(regclass, date)'::regprocedure)
       ORDER BY 1`)
    assert.deepEqual(rows.map((r) => r.rolname), ['bob_feeder'])

    const { rows: def } = await db.query(`
      SELECT prosecdef FROM pg_proc
       WHERE oid = 'bob.proj_ensure_partition(regclass, date)'::regprocedure`)
    assert.ok(def[0].prosecdef, 'the function is not SECURITY DEFINER')
  })

  test('bob_feeder, holding no grant on the parent, creates its month', async () => {
    await inTx(async () => {
      await becomeRole('bob_feeder')
      assert.equal(await ensurePartition('bob.proj_sentiment'), 'bob.proj_sentiment_y2026m11')
    })
  })

  // H1. Each case must raise, and must leave the catalog as it found it.
  const refused = [
    ['a partitioned table outside the eight, in bob', async () => {
      await db.query(`CREATE TABLE bob.proj_ninth (org_id UUID NOT NULL,
        bucket_start TIMESTAMPTZ NOT NULL) PARTITION BY RANGE (bucket_start)`)
      return ['bob.proj_ninth', MONTH]
    }],
    ['a same-named table in another schema', async () => {
      await db.query(`CREATE TABLE public.proj_metric_counts (org_id UUID NOT NULL,
        bucket_start TIMESTAMPTZ NOT NULL) PARTITION BY RANGE (bucket_start)`)
      return ['public.proj_metric_counts', MONTH]
    }],
    ['a configuration table', async () => ['bob.channels', MONTH]],
    ['a date in the middle of a month', async () => ['bob.proj_metric_counts', '2026-11-18']],
    ['the last day of a month', async () => ['bob.proj_metric_counts', '2026-11-30']],
  ]
  for (const [name, setup] of refused) {
    test(`refuses ${name}, and creates nothing`, async () => {
      await inTx(async () => {
        const [parent, month] = await setup()
        const count = async () => (await db.query(
          'SELECT count(*)::int AS n FROM pg_class')).rows[0].n
        const before = await count()
        await becomeRole('bob_feeder')
        const code = await refusal(
          'SELECT bob.proj_ensure_partition($1::regclass, $2::date)', [parent, month])
        await db.query('RESET ROLE')
        assert.equal(code, '22023', `${name} was accepted`)
        assert.equal(await count(), before, `${name} left something behind`)
      })
    })
  }
})

describe('§10 · partitions granted and guarded', () => {
  test('a month of every projection passes PR-4 and the tenancy checks', async () => {
    await inTx(async () => {
      for (const p of await parents()) await ensurePartition(p.qualified)
      const partitions = (await projectionTables(db)).filter((t) => t.is_partition)
      assert.equal(partitions.length, 8, 'one month of each of the eight')

      assert.deepEqual(await projectionGrantFindings(db), [])

      const tenant = await tenantTables(db)
      for (const p of partitions) {
        const t = tenant.find((x) => x.qualified === p.qualified)
        assert.ok(t, `${p.qualified} is not found by tenant discovery`)
        assert.ok(t.rls_enabled, `${p.qualified} has no RLS`)
        assert.ok(t.policy_count > 0, `${p.qualified} has no policy`)
      }
      assert.deepEqual(await structuralFindings(db), [])
    })
  })
})

const SIGN_IN = new Set(['bob.users'])
// F-43: the audit trail is written outside the application (its policy is
// FOR SELECT only); bob_app reads it and writes nothing.
// Slice 5: breach state is written by bob_evaluate alone, as the migration
// owner (spec §6, §9); bob_app reads it.
const READ_ONLY = new Set(['bob.audit_log', 'bob.evaluation_state'])

describe('§10 · bob_app grants, found rather than listed', () => {
  // P5 Q6 (a): a feeder staging table, found by its grants, is the third
  // kind. bob_app reads what the feeder staged and deletes what it consumed.
  test('non-projections: SELECT, INSERT, UPDATE, DELETE. Projections: SELECT only. Staging: SELECT, DELETE', async () => {
    await inTx(async () => {
      for (const p of await parents()) await ensurePartition(p.qualified)
      const projections = new Set((await projectionTables(db)).map((t) => t.qualified))
      const { rows: keyed } = await db.query(`
        SELECT DISTINCT format('%I.%I', n.nspname, c.relname) AS qualified
          FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE k.contype = 'f' AND k.confrelid = 'bob.alert_log'::regclass`)
      const keysAlert = new Set(keyed.map((k) => k.qualified))
      const staging = new Set((await feederStagingTables(db)).map((t) => t.qualified))
      assert.ok(staging.has('bob.member_refs_seen'), 'the staging discovery found nothing')
      const problems = []
      for (const t of await tenantTables(db)) {
        const { rows } = await db.query(`
          SELECT p, CASE WHEN p IN ('INSERT', 'UPDATE')
                         THEN has_any_column_privilege('bob_app', $1::regclass, p)
                         ELSE has_table_privilege('bob_app', $1::regclass, p) END AS held
            FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`, [t.qualified])
        const held = new Set(rows.filter((r) => r.held).map((r) => r.p))
        // Slice 6: a table that keys an alert keeps its rows (the trace from
        // action to alert), so bob_app does not delete from it. Found by key,
        // as in slice6-registries-outbox.test.mjs. INSERT and UPDATE may be
        // column grants (autobotz keeps its verdict columns for Verify).
        // P5 Q6 (a): a feeder staging table, found by its grants, is read and
        // consumed: SELECT and DELETE.
        // F-42: bob.users says who may sign in, and only the operator's
        // provisioning writes it. bob_app reads it and stamps last_login_at.
        const want = projections.has(t.qualified) || READ_ONLY.has(t.qualified) ? ['SELECT']
          : staging.has(t.qualified) ? ['SELECT', 'DELETE']
          : SIGN_IN.has(t.qualified) ? ['SELECT', 'UPDATE']
          : keysAlert.has(t.qualified) ? ['SELECT', 'INSERT', 'UPDATE']
          : ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
        const got = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].filter((p) => held.has(p))
        if (got.join() !== want.join()) problems.push(`${t.qualified}: ${got.join(',') || 'none'}`)
      }
      assert.deepEqual(problems, [], 'bob_app grants differ from contract §10')
    })
  })
})

describe('§10 · the shape of every projection', () => {
  test('grain: every projection with bucket_start carries the alignment CHECK', async () => {
    for (const p of await parents()) {
      if (!(await columns(p.qualified)).some((c) => c.name === 'bucket_start')) continue
      const { rows } = await db.query(`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = $1::regclass AND contype = 'c'`, [p.qualified])
      assert.ok(rows.some((r) => /bucket_start/.test(r.def) && /% \(?300\)?/.test(r.def)),
        `${p.qualified} has no bucket-alignment CHECK`)
    }
  })

  test('grain: a bucket off the five-minute boundary is refused, a fraction included', async () => {
    await inTx(async () => {
      await ensurePartition('bob.proj_rum_signals')
      // 14:00:00.4 is F-23: 0.5.1's `::bigint` form rounded it onto 14:00.
      for (const at of ['2026-11-18 14:03:00+00', '2026-11-18 14:00:00.4+00',
        '2026-11-18 14:05:00.4+00']) {
        const code = await refusal(`
          INSERT INTO bob.proj_rum_signals (org_id, channel_id, signal, bucket_start,
            source_watermark, feeder_version)
          VALUES ($1, $2, 'rage_click', $3, now(), 'test')`, [TENANT_A, CHANNEL_A, at])
        assert.equal(code, '23514', `bucket ${at} was accepted`)
      }
    })
  })

  test('no derived figures: no column named like a percentile, ratio or average', async () => {
    const derived = /(^|_)(p\d+|percentile|median|avg|mean|health_pct)(_|$)|_rate$|_pct$/
    for (const p of await parents()) {
      const bad = (await columns(p.qualified)).map((c) => c.name).filter((n) => derived.test(n))
      assert.deepEqual(bad, [], `${p.qualified} stores a derived figure`)
    }
  })

  test('provenance: computed_at, source_watermark, feeder_version, NOT NULL', async () => {
    for (const p of await parents()) {
      const cols = await columns(p.qualified)
      for (const [name, type] of [['computed_at', 'timestamp with time zone'],
        ['source_watermark', 'timestamp with time zone'], ['feeder_version', 'text']]) {
        const c = cols.find((x) => x.name === name)
        assert.ok(c, `${p.qualified} lacks ${name}`)
        assert.equal(c.type, type, `${p.qualified}.${name}`)
        assert.ok(c.not_null, `${p.qualified}.${name} is nullable`)
      }
    }
  })

  test('sealed: on every bucketed projection, stored and NOT NULL', async () => {
    for (const p of await parents()) {
      const cols = await columns(p.qualified)
      if (!cols.some((c) => c.name === 'bucket_start')) continue
      const s = cols.find((c) => c.name === 'sealed')
      assert.ok(s && s.type === 'boolean' && s.not_null, `${p.qualified} has no stored sealed`)
    }
  })

  test('tenant key: org_id UUID NOT NULL, and no slug column', async () => {
    for (const p of await parents()) {
      const cols = await columns(p.qualified)
      const org = cols.find((c) => c.name === 'org_id')
      assert.ok(org && org.type === 'uuid' && org.not_null, `${p.qualified} org_id`)
      assert.deepEqual(cols.filter((c) => /slug|tenant/.test(c.name)).map((c) => c.name), [],
        `${p.qualified} carries the slug`)
    }
  })
})

// Structural now; behavioural once something reads proj_durations. Until a
// reader exists the behavioural half reports `todo`, which node prints and
// counts. It never reports pass (Q16).
async function durationReaders() {
  const { rows } = await db.query(`
    SELECT DISTINCT r.ev_class::regclass::text AS reader
      FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
     WHERE d.classid = 'pg_rewrite'::regclass
       AND d.refobjid = 'bob.proj_durations'::regclass
       AND r.ev_class <> 'bob.proj_durations'::regclass
    UNION
    SELECT p.oid::regprocedure::text FROM pg_proc p
     WHERE p.prosrc ~ 'proj_durations'
       -- names the eight to refuse the rest; reads none of them
       AND p.oid <> 'bob.proj_ensure_partition(regclass, date)'::regprocedure`)
  return rows.map((r) => r.reader)
}

describe('§10 · never merged across actor_type or measure', () => {
  test('structural: actor_type and measure are NOT NULL and in the primary key', async () => {
    const { rows } = await db.query(`
      SELECT a.attname, a.attnotnull FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'bob.proj_durations'::regclass AND i.indisprimary`)
    for (const col of ['actor_type', 'measure']) {
      const c = rows.find((r) => r.attname === col)
      assert.ok(c, `${col} is not in the primary key`)
      assert.ok(c.attnotnull, `${col} is nullable`)
    }
  })

  test('behavioural: every reader of proj_durations returns separate distributions', async (t) => {
    const readers = await durationReaders()
    if (readers.length === 0) {
      t.todo('no view or function reads proj_durations yet; the floor lands with A-05b')
      return
    }
    assert.fail(`readers found (${readers.join(', ')}): write the behavioural half over ` +
      'a fixture with user and human rows and both measures in one channel and bucket')
  })
})

describe('§10 · constraints the rows must keep', () => {
  async function insert(sql, params) {
    return refusal(sql, params)
  }
  const provenance = `now(), 'test'`

  test('degenerate actor: the four user-only metrics refuse every other actor_type', async () => {
    await inTx(async () => {
      await ensurePartition('bob.proj_metric_counts')
      for (const m of ['abandoned_in_queue', 'abstained', 'classifier_down', 'label_missing']) {
        assert.equal(await insert(`
          INSERT INTO bob.proj_metric_counts (org_id, channel_id, actor_type, metric_id,
            bucket_start, source_watermark, feeder_version)
          VALUES ($1, $2, 'human', $3, $4, ${provenance})`, [TENANT_A, CHANNEL_A, m, BUCKET]),
        '23514', `${m} accepted a human`)
        assert.equal(await insert(`
          INSERT INTO bob.proj_metric_counts (org_id, channel_id, actor_type, metric_id,
            bucket_start, source_watermark, feeder_version)
          VALUES ($1, $2, 'user', $3, $4, ${provenance})`, [TENANT_A, CHANNEL_A, m, BUCKET]),
        null, `${m} refused a user`)
      }
    })
  })

  test('degenerate actor: interaction_duration refuses every actor_type but user (O2)', async () => {
    await inTx(async () => {
      await ensurePartition('bob.proj_durations')
      const sql = `
        INSERT INTO bob.proj_durations (org_id, channel_id, actor_type, measure,
          bucket_start, n, sum_ms, hist_offset, source_watermark, feeder_version)
        VALUES ($1, $2, $3, $4, $5, 1, 1000, 0, ${provenance})`
      assert.equal(await insert(sql, [TENANT_A, CHANNEL_A, 'asa', 'interaction_duration', BUCKET]), '23514')
      assert.equal(await insert(sql, [TENANT_A, CHANNEL_A, 'user', 'interaction_duration', BUCKET]), null)
      assert.equal(await insert(sql, [TENANT_A, CHANNEL_A, 'asa', 'response_time', BUCKET]), null)
    })
  })

  test('closing is ORGA: a meca row with closing_count > 0 is refused', async () => {
    await inTx(async () => {
      await ensurePartition('bob.proj_sentiment')
      const sql = `
        INSERT INTO bob.proj_sentiment (org_id, channel_id, source, state, bucket_start,
          reading_count, closing_count, source_watermark, feeder_version)
        VALUES ($1, $2, $3, 's2', $4, 3, $5, ${provenance})`
      assert.equal(await insert(sql, [TENANT_A, CHANNEL_A, 'meca', BUCKET, 1]), '23514')
      assert.equal(await insert(sql, [TENANT_A, CHANNEL_A, 'meca', BUCKET, 0]), null)
      assert.equal(await insert(sql, [TENANT_A, CHANNEL_A, 'orga', BUCKET, 1]), null)
    })
  })

  test('rung pairs with type, and the type is the actor\'s own', async () => {
    await inTx(async () => {
      await ensurePartition('bob.proj_actor_metrics')
      const { rows: [agent] } = await db.query(
        `SELECT id FROM actors WHERE org_id = $1 AND actor_type = 'human' LIMIT 1`, [TENANT_A])
      const { rows: [member] } = await db.query(`
        INSERT INTO actors (org_id, actor_type, display_id, identity_rung)
        VALUES ($1, 'user', 'MBR-TEST-1', 'ghost') RETURNING id`, [TENANT_A])
      const sql = `
        INSERT INTO bob.proj_actor_metrics (org_id, actor_id, actor_type, channel_id,
          metric_id, identity_rung_at_interaction, bucket_start, source_watermark, feeder_version)
        VALUES ($1, $2, $3, $4, 'handled', $5, $6, ${provenance})`
      const cases = [
        ['a user row with not_applicable', member.id, 'user', 'not_applicable', '23514'],
        ['a human row with a rung', agent.id, 'human', 'identified', '23514'],
        ['a type that differs from the actor\'s', agent.id, 'user', 'ghost', '23503'],
        ['a user row with its rung', member.id, 'user', 'ghost', null],
        ['a human row with not_applicable', agent.id, 'human', 'not_applicable', null],
      ]
      for (const [name, actor, type, rung, want] of cases) {
        assert.equal(await insert(sql, [TENANT_A, actor, type, CHANNEL_A, rung, BUCKET]),
          want, name)
      }
    })
  })
})

// §8.7 (0.5.2, F-24's condition). The event-grained keys carry the event time,
// so an id that came back with another time would be a second row, not an
// update. Tables and id columns are found from the catalog: an event-grained
// projection is one without bucket_start; its id is its primary key minus
// org_id and minus the partition column.
async function eventTimeFindings() {
  const { rows: tables } = await db.query(`
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified,
           (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum = pt.partattrs[0])::text AS time_col,
           ARRAY(SELECT a.attname FROM pg_index i
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                  WHERE i.indrelid = c.oid AND i.indisprimary
                    AND a.attnum <> pt.partattrs[0] AND a.attname <> 'org_id'
                  ORDER BY a.attnum)::text[] AS id_cols
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
     WHERE c.relname LIKE 'proj\\_%' AND NOT c.relispartition
       AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                          AND a.attname = 'bucket_start' AND NOT a.attisdropped)
     ORDER BY 1`)
  assert.equal(tables.length, 2, 'expected the two event-grained projections')
  const findings = []
  for (const t of tables) {
    const ids = t.id_cols.map((c) => `"${c}"`).join(', ')
    const { rows } = await db.query(`
      SELECT org_id, ${ids}, count(DISTINCT "${t.time_col}")::int AS times
        FROM ${t.qualified} GROUP BY org_id, ${ids}
      HAVING count(DISTINCT "${t.time_col}") > 1`)
    for (const r of rows) findings.push(`${t.qualified}: ${t.id_cols.map((c) => r[c]).join(',')} at ${r.times} times`)
  }
  return findings
}

describe('§8.7 · an event-grained id keeps its event time', () => {
  test('no detection or delivery id appears with two times', async () => {
    assert.deepEqual(await eventTimeFindings(), [])
  })

  test('an id written with two times is reported, for both tables', async () => {
    await inTx(async () => {
      for (const p of ['bob.proj_detections', 'bob.proj_deliveries']) {
        await ensurePartition(p, '2026-11-01')
        await ensurePartition(p, '2026-12-01')
      }
      for (const at of ['2026-11-30 23:59:00+00', '2026-12-01 00:01:00+00']) {
        await db.query(`INSERT INTO bob.proj_detections (org_id, detection_id, detection,
          detected_at, correlation_id, source_watermark, feeder_version)
          VALUES ($1, 'det-1', 'spike', $2, 'corr-1', now(), 'test')`, [TENANT_A, at])
        await db.query(`INSERT INTO bob.proj_deliveries (org_id, attempt_id, outbound_id,
          correlation_id, kind, provider, attempted_at, outcome, source_watermark, feeder_version)
          VALUES ($1, 'att-1', gen_random_uuid(), 'corr-1', 'autocomm', 'email', $2,
                  'delivered', now(), 'test')`, [TENANT_A, at])
      }
      const found = await eventTimeFindings()
      assert.ok(found.some((f) => f.startsWith('bob.proj_detections: det-1')), found.join('\n'))
      assert.ok(found.some((f) => f.startsWith('bob.proj_deliveries: att-1')), found.join('\n'))
    })
  })
})

describe('F-21 · the feeder reads its two views, and nothing else', () => {
  test('as bob_feeder, both views return rows from both tenants', async () => {
    await inTx(async () => {
      const { rows: [member] } = await db.query(`
        INSERT INTO actors (org_id, actor_type, display_id, identity_rung)
        VALUES ($1, 'user', 'MBR-F21', 'ghost') RETURNING id`, [TENANT_B])
      await db.query(`INSERT INTO actor_ref_history (org_id, ref, actor_id, identity_rung, valid_from)
        VALUES ($1, 'm:f21', $2, 'ghost', now())`, [TENANT_B, member.id])
      const { rows: [agent] } = await db.query(
        `SELECT id FROM actors WHERE org_id = $1 AND actor_type = 'human' LIMIT 1`, [TENANT_A])
      await db.query(`INSERT INTO actor_external_refs (org_id, actor_id, ref)
        VALUES ($1, $2, 'tenant-a.whatsapp:4711')`, [TENANT_A, agent.id])

      await becomeRole('bob_feeder')
      const channels = await db.query('SELECT DISTINCT org_id::text FROM bob.v_feeder_channel_map')
      assert.deepEqual(channels.rows.map((r) => r.org_id).sort(), [TENANT_A, TENANT_B])
      const cols = Object.keys((await db.query('SELECT * FROM bob.v_feeder_channel_map LIMIT 1')).rows[0])
      assert.deepEqual(cols, ['channel_id', 'org_id', 'tenant_slug', 'source_key',
        'lag_seconds', 'adapter_kind', 'idle_bound_seconds', 'capabilities', 'actor_types'])
      const actors = await db.query('SELECT DISTINCT org_id::text FROM bob.v_feeder_actor_map')
      assert.deepEqual(actors.rows.map((r) => r.org_id).sort(), [TENANT_A, TENANT_B])
    })
  })

  test('as bob_feeder, every other table and view refuses SELECT', async () => {
    await inTx(async () => {
      const { rows } = await db.query(`
        SELECT format('%I.%I', n.nspname, c.relname) AS qualified
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'bob' AND c.relkind IN ('r', 'v', 'm')
           AND NOT c.relispartition
           AND c.relname NOT IN ('v_feeder_channel_map', 'v_feeder_actor_map')
           AND c.relname NOT LIKE 'proj\\_%'`)
      assert.ok(rows.length > 20, 'discovery found too few tables to mean anything')
      await becomeRole('bob_feeder')
      const readable = []
      for (const r of rows) {
        if (await refusal(`SELECT 1 FROM ${r.qualified} LIMIT 1`) === null) readable.push(r.qualified)
      }
      assert.deepEqual(readable, [], 'bob_feeder reads configuration beyond its two views')
    })
  })

  // A definer view hands the owner's reach to whoever reads it. The finding is
  // a role that reads a view without being able to read the tables behind it
  // (pg_read_all_data and Supabase's own read-all roles gain nothing from it).
  test('no role but bob_feeder gains cross-tenant reach through the definer views', async () => {
    const { rows } = await db.query(`
      SELECT r.rolname, v AS view FROM pg_roles r,
             unnest(ARRAY['bob.v_feeder_channel_map','bob.v_feeder_actor_map']) v
       WHERE has_table_privilege(r.oid, v::regclass, 'SELECT')
         AND NOT (has_table_privilege(r.oid, 'bob.channels', 'SELECT')
                  AND has_table_privilege(r.oid, 'bob.actor_ref_history', 'SELECT')
                  AND (r.rolbypassrls OR r.rolsuper))
         AND r.rolname <> 'bob_feeder'
         -- Postgres's predefined groups cannot log in; their members are
         -- checked here in their own right.
         AND r.rolname NOT LIKE 'pg\\_%'
       ORDER BY 1, 2`)
    assert.deepEqual(rows, [], 'a definer view hands cross-tenant reach to another role')
  })
})

describe('F-22 · the feeder writes one tenant per transaction, under its claim', () => {
  const sql = `
    INSERT INTO bob.proj_metric_counts (org_id, channel_id, actor_type, metric_id,
      bucket_start, event_count, session_count, source_watermark, feeder_version)
    VALUES ($1, $2, 'user', 'resolved', $3, 1, 1, now(), 'test')`

  test('holding tenant A\'s claim, a tenant A row is accepted and a tenant B row refused', async () => {
    await inTx(async () => {
      await ensurePartition('bob.proj_metric_counts')
      await becomeRole('bob_feeder', TENANT_A)
      assert.equal(await refusal(sql, [TENANT_A, CHANNEL_A, BUCKET]), null)
      assert.equal(await refusal(sql, [TENANT_B, CHANNEL_B, BUCKET]), '42501')
    })
  })

  test('with no claim, every write is refused', async () => {
    await inTx(async () => {
      await ensurePartition('bob.proj_metric_counts')
      await becomeRole('bob_feeder')
      assert.equal(await refusal(sql, [TENANT_A, CHANNEL_A, BUCKET]), '42501')
    })
  })

  test('a direct write to the partition is held to the same claim', async () => {
    await inTx(async () => {
      const part = await ensurePartition('bob.proj_metric_counts')
      await becomeRole('bob_feeder', TENANT_A)
      assert.equal(await refusal(sql.replace('bob.proj_metric_counts', part),
        [TENANT_B, CHANNEL_B, BUCKET]), '42501')
    })
  })
})

describe('§9.3, §9.4, §7.4 · refs, their history, and the actor map', () => {
  // The equality of §9.4, as a query returning what disagrees.
  async function refHistoryFindings() {
    const { rows } = await db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (org_id, ref) org_id, ref, actor_id
          FROM actor_ref_history ORDER BY org_id, ref, valid_from DESC
      ), current_members AS (
        SELECT r.org_id, r.ref, r.actor_id FROM actor_external_refs r
          JOIN actors a ON a.id = r.actor_id WHERE a.actor_type = 'user'
      )
      SELECT coalesce(l.ref, c.ref) AS ref FROM latest l
        FULL JOIN current_members c ON c.org_id = l.org_id AND c.ref = l.ref
       WHERE l.actor_id IS DISTINCT FROM c.actor_id`)
    return rows.map((r) => r.ref)
  }

  test('for every member ref, the current state equals the latest history row', async () => {
    assert.deepEqual(await refHistoryFindings(), [])
  })

  test('the equality check sees a ref whose history points elsewhere', async () => {
    await inTx(async () => {
      const mk = async (d) => (await db.query(`INSERT INTO actors (org_id, actor_type,
        display_id, identity_rung) VALUES ($1, 'user', $2, 'ghost') RETURNING id`, [TENANT_A, d])).rows[0].id
      const ghost = await mk('MBR-G'); const merged = await mk('MBR-M')
      await db.query(`INSERT INTO actor_ref_history VALUES
        ($1, 'm:eq', $2, 'ghost', '2026-11-01'), ($1, 'm:eq', $3, 'ghost', '2026-11-10')`,
      [TENANT_A, ghost, merged])
      await db.query(`INSERT INTO actor_external_refs (org_id, actor_id, ref)
        VALUES ($1, $2, 'm:eq')`, [TENANT_A, ghost])
      assert.deepEqual(await refHistoryFindings(), ['m:eq'])
    })
  })

  test('the history is append-only, and members only', async () => {
    await inTx(async () => {
      const { rows: [m] } = await db.query(`INSERT INTO actors (org_id, actor_type, display_id,
        identity_rung) VALUES ($1, 'user', 'MBR-AO', 'ghost') RETURNING id`, [TENANT_A])
      const { rows: [agent] } = await db.query(
        `SELECT id FROM actors WHERE org_id = $1 AND actor_type = 'human' LIMIT 1`, [TENANT_A])
      await becomeRole('bob_app', TENANT_A)
      assert.equal(await refusal(`INSERT INTO actor_ref_history VALUES
        ($1, 'm:ao', $2, 'ghost', '2026-11-01')`, [TENANT_A, m.id]), null)
      assert.equal(await refusal(
        `UPDATE actor_ref_history SET identity_rung = 'identified' WHERE ref = 'm:ao'`), '23514')
      assert.equal(await refusal(`DELETE FROM actor_ref_history WHERE ref = 'm:ao'`), '23514')
      assert.equal(await refusal(`INSERT INTO actor_ref_history VALUES
        ($1, 'x:ao', $2, 'identified', '2026-11-01')`, [TENANT_A, agent.id]), '23514',
      'an agent ref entered the history')
    })
  })

  test('removing the actor takes its history with it', async () => {
    await inTx(async () => {
      const { rows: [m] } = await db.query(`INSERT INTO actors (org_id, actor_type, display_id,
        identity_rung) VALUES ($1, 'user', 'MBR-CASCADE', 'ghost') RETURNING id`, [TENANT_A])
      await db.query(`INSERT INTO actor_ref_history VALUES ($1, 'm:c', $2, 'ghost', now())`,
        [TENANT_A, m.id])
      assert.equal(await refusal('DELETE FROM actors WHERE id = $1', [m.id]), null)
    })
  })

  test('v_feeder_actor_map derives valid_to; agent refs carry no dates (H4)', async () => {
    await inTx(async () => {
      const mk = async (d, rung) => (await db.query(`INSERT INTO actors (org_id, actor_type,
        display_id, identity_rung) VALUES ($1, 'user', $2, $3) RETURNING id`,
      [TENANT_A, d, rung])).rows[0].id
      const ghost = await mk('MBR-H4G', 'ghost'); const known = await mk('MBR-H4I', 'identified')
      await db.query(`INSERT INTO actor_ref_history VALUES
        ($1, 'm:h4', $2, 'ghost',      '2026-11-01 00:00:00+00'),
        ($1, 'm:h4', $3, 'identified', '2026-11-10 00:00:00+00')`, [TENANT_A, ghost, known])
      const { rows: [agent] } = await db.query(
        `SELECT id FROM actors WHERE org_id = $1 AND actor_type = 'human' LIMIT 1`, [TENANT_A])
      await db.query(`INSERT INTO actor_external_refs (org_id, actor_id, ref)
        VALUES ($1, $2, 'tenant-a.whatsapp:h4')`, [TENANT_A, agent.id])

      await becomeRole('bob_feeder')
      const { rows } = await db.query(`
        SELECT ref, actor_type, identity_rung, valid_from, valid_to FROM bob.v_feeder_actor_map
         WHERE org_id = $1 AND ref IN ('m:h4', 'tenant-a.whatsapp:h4')
         ORDER BY ref, valid_from`, [TENANT_A])
      assert.equal(rows.length, 3)
      assert.equal(rows[0].identity_rung, 'ghost')
      assert.equal(rows[0].valid_to.toISOString(), '2026-11-10T00:00:00.000Z')
      assert.equal(rows[1].identity_rung, 'identified')
      assert.equal(rows[1].valid_to, null)
      assert.deepEqual([rows[2].actor_type, rows[2].identity_rung, rows[2].valid_from, rows[2].valid_to],
        ['human', 'not_applicable', null, null])
      const cols = Object.keys(rows[0])
      assert.ok(!cols.some((c) => /display/.test(c)), 'the feeder sees a name')
    })
  })

  test('actors.external_ref is gone, and (id, actor_type) is unique', async () => {
    const cols = await columns('bob.actors')
    assert.ok(!cols.some((c) => c.name === 'external_ref'), 'two sources of truth for one ref')
    const { rows } = await db.query(`
      SELECT 1 FROM pg_constraint WHERE conrelid = 'bob.actors'::regclass
         AND contype IN ('u','p') AND pg_get_constraintdef(oid) = 'UNIQUE (id, actor_type)'`)
    assert.equal(rows.length, 1)
  })
})

// Tracked files, as the naming test reads them: the repository, not the disk.
function trackedCode() {
  return execFileSync('git', ['ls-files', '*.sql', '*.mjs', '*.js', '*.ts', '*.json'],
    { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => !f.endsWith('pnpm-lock.yaml'))
}

// A ref built in code with its namespace written in: 'pbx:' || id,
// `whatsapp:${id}`, 'asa-platform:' + id. Namespaces come from
// channels.source_key or the deployment record, never from a literal (Q14).
// `m:` is not a namespace in that sense: the member ref is computed by D47's
// rule, and §7.2 writes it as a prefix of the hash. It is matched too, but only
// where code builds one; the computation lands with the miembro.id work.
const NAMESPACE_LITERAL =
  /(['"`])[a-z][a-z0-9_.-]*:\1\s*(\|\||\+)|`[a-z][a-z0-9_.-]*:\$\{|\bconcat\(\s*'[a-z][a-z0-9_.-]*:'/i

// Slice 3 §3: a cell's reason carries its argument after a colon
// (`capability_not_declared:queue`, `no_definition:D-15`). That is a reason
// code, not a ref. Named here by hand, so a new prefix turns this guard red
// until someone looks at it.
const REASON_PREFIXES = ['capability_not_declared', 'no_definition']
const REASON_LITERAL = new RegExp(`(['"\`])(${REASON_PREFIXES.join('|')}):\\1\\s*(\\|\\||\\+)`, 'g')

function namespaceLiteralFindings(files, read) {
  const findings = []
  for (const f of files) {
    if (f === 'tests/slice2-schema.test.mjs') continue   // this guard's own pattern
    read(f).split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('--') || line.trimStart().startsWith('//')) return
      if (NAMESPACE_LITERAL.test(line.replace(REASON_LITERAL, ''))) findings.push(`${f}:${i + 1}: ${line.trim()}`)
    })
  }
  return findings
}

// A statement that names both channel_capabilities and channel_type is deriving
// one from the other, or is close enough that a human must look (Relevo task 10).
function capabilityFromTypeFindings(files, read) {
  const findings = []
  for (const f of files) {
    if (f === 'tests/slice2-schema.test.mjs') continue
    const text = read(f).replace(/--[^\n]*|\/\/[^\n]*/g, '')
    text.split(';').forEach((stmt) => {
      if (/channel_capabilities/.test(stmt) && /channel_type/.test(stmt)) {
        findings.push(`${f}: ${stmt.trim().slice(0, 120)}`)
      }
    })
  }
  return findings
}

describe('§10 · nothing typed that must be declared', () => {
  const read = (f) => readFileSync(resolve(REPO_ROOT, f), 'utf8')

  test('no code path builds a ref with a literal namespace', () => {
    assert.deepEqual(namespaceLiteralFindings(trackedCode(), read), [])
  })

  test('the namespace guard sees each shape it claims to', () => {
    const probes = {
      'a.sql': `SELECT 'pbx:' || ext FROM calls`,
      'b.mjs': 'const ref = `whatsapp:${id}`',
      'c.mjs': "const ref = 'asa-platform:' + deployment",
      'd.sql': "SELECT concat('ycloud:', phone)",
      'ok.mjs': 'const ref = `${channel.source_key}:${id}`',
      'reason.sql': `SELECT 'capability_not_declared:' || cap FROM caps`,
      'e.sql': `SELECT 'capability_not_declared:' || cap, 'pbx:' || ext FROM caps`,
    }
    const found = namespaceLiteralFindings(Object.keys(probes), (f) => probes[f])
    assert.deepEqual(found.map((x) => x.split(':')[0]), ['a.sql', 'b.mjs', 'c.mjs', 'd.sql', 'e.sql'])
  })

  test('no code path, view, function or seed derives capabilities from channel_type', async () => {
    assert.deepEqual(capabilityFromTypeFindings(trackedCode(), read), [])
    const { rows } = await db.query(`
      SELECT v.oid::regclass::text AS obj FROM pg_class v
       WHERE v.relkind IN ('v','m')
         AND pg_get_viewdef(v.oid) ~ 'channel_capabilities'
         AND pg_get_viewdef(v.oid) ~ 'channel_type'
      UNION ALL
      -- A BEGIN ATOMIC body (Slice 3) leaves prosrc empty and lives in
      -- prosqlbody, so the definition is read whole.
      SELECT p.oid::regprocedure::text FROM pg_proc p
       WHERE p.prokind IN ('f', 'p')
         AND p.pronamespace NOT IN (SELECT oid FROM pg_namespace
                                     WHERE nspname LIKE 'pg\\_%' OR nspname = 'information_schema')
         AND pg_get_functiondef(p.oid) ~ 'channel_capabilities'
         AND pg_get_functiondef(p.oid) ~ 'channel_type'`)
    assert.deepEqual(rows, [])
  })

  test('the capability guard sees a derivation', () => {
    const probes = {
      'seed.sql': `INSERT INTO channel_capabilities (org_id, channel_id, capability)
        SELECT org_id, id, 'meca_rum' FROM channels WHERE channel_type = 'website';`,
    }
    assert.equal(capabilityFromTypeFindings(Object.keys(probes), (f) => probes[f]).length, 1)
  })
})
