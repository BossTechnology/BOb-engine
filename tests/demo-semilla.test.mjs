// The demo seed (scripts/demo): invented data so bob-web's screens show
// something in a lab box. It must never run anywhere else, never write as the
// service role, and never reach the install chain that goes to a customer box.
//
// Three layers, each seen failing before it was trusted:
//   - the wrapper refuses without an explicit lab destination (no database);
//   - the wrapper, run for real against the suite's database, refuses it: it
//     holds more than one organization, which no lab box does (G3);
//   - the SQL, run by node inside one transaction that is always rolled back,
//     over a database emptied to one lab organization: every guard, the seed,
//     running it twice, and the removal.
// And a static layer: nothing under supabase/ or in the install scripts names
// the seed, and its files carry no identifier that looks real.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { connect, loadFixture, DB_URL, REPO_ROOT } from './helpers/db.mjs'

const DEMO = join(REPO_ROOT, 'scripts/demo')
const WRAPPER = join(DEMO, 'bob-demo.sh')
const MARK = 'bob-demo/1'
const sql = (f) => readFileSync(join(DEMO, f), 'utf8')

// libpq's environment for the suite's database, with no password on argv.
function pgEnv(extra = {}) {
  const u = new URL(DB_URL)
  return {
    ...process.env,
    PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) || 'postgres',
    ...extra,
  }
}

function wrapper(args, env = pgEnv()) {
  return spawnSync('bash', [WRAPPER, ...args], { env, encoding: 'utf8' })
}

describe('the wrapper refuses without a lab destination', () => {
  test('no --caja', () => {
    const r = wrapper(['--tenant', 'lab-demo', '--ejecutar'])
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /falta --caja/)
  })

  test('a destination that is not a lab box', () => {
    for (const caja of ['produccion', 'model-01', 'LAB-02', 'lab-02 ']) {
      const r = wrapper(['--caja', caja, '--tenant', 'lab-demo', '--ejecutar'])
      assert.equal(r.status, 2, `${caja}: ${r.stderr}`)
      assert.match(r.stderr, /no es una caja de laboratorio/)
    }
  })

  test('--caja lab-02 on a machine that is not lab-02', { skip: /lab-02/.test(hostname()) }, () => {
    const r = wrapper(['--caja', 'lab-02', '--tenant', 'lab-demo', '--ejecutar'])
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /solo corre en lab-02/)
  })

  test('--caja local against a host that is not loopback', () => {
    const r = wrapper(['--caja', 'local', '--tenant', 'lab-demo', '--ejecutar'],
      pgEnv({ PGHOST: '10.0.0.5' }))
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /no es de loopback/)
  })

  test('--caja local through PGHOSTADDR or a service file', () => {
    for (const extra of [{ PGHOSTADDR: '10.0.0.5' }, { PGSERVICE: 'otra' }]) {
      const r = wrapper(['--caja', 'local', '--tenant', 'lab-demo'], pgEnv(extra))
      assert.equal(r.status, 2, `${JSON.stringify(extra)}: ${r.stderr}`)
    }
  })

  test('a tenant or a zone that could carry SQL', () => {
    for (const args of [['--tenant', "x'; DROP SCHEMA bob; --"], ['--tenant', 'lab-demo', '--zona', "UTC'"]]) {
      const r = wrapper(['--caja', 'local', ...args])
      assert.equal(r.status, 2, r.stderr)
    }
  })
})

describe('the wrapper, run for real, refuses the suite database (G3)', () => {
  let db
  before(async () => {
    db = await connect()
    await loadFixture(db)
  })
  after(async () => { await db?.end() })

  test('two organizations: exit 1, nothing written', async () => {
    const { rows: [{ n: orgs }] } = await db.query('SELECT count(*)::int AS n FROM bob.organizations')
    assert.ok(orgs > 1, 'the fixture holds more than one organization')
    const r = wrapper(['--caja', 'local', '--tenant', 'tenant-a', '--ejecutar'])
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /G3: la base tiene \d+ organizaciones/)
    const { rows: [{ n }] } = await db.query(
      "SELECT count(*)::int AS n FROM bob.channels WHERE source_key LIKE 'demo-%'")
    assert.equal(n, 0)
  })
})

describe('the SQL, in a transaction over one lab organization', () => {
  let db
  const run = async ({ caja = 'local', tenant = 'lab-demo', accion = 'sembrar' } = {}, ...files) => {
    await db.query(
      `SELECT set_config('bob_demo.caja', $1, true), set_config('bob_demo.tenant', $2, true),
              set_config('bob_demo.accion', $3, true)`, [caja, tenant, accion])
    for (const f of files) await db.query(sql(f))
  }
  // A case that must fail runs under a savepoint, so the transaction lives on.
  const refused = async (re, fn) => {
    await db.query('SAVEPOINT caso')
    try {
      await assert.rejects(fn, re)
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT caso')
    }
  }
  const count = async (q, params = []) => (await db.query(q, params)).rows[0].n
  const markedRows = () => count(`
    SELECT ((SELECT count(*) FROM bob.proj_metric_counts WHERE feeder_version = $1)
         + (SELECT count(*) FROM bob.proj_durations WHERE feeder_version = $1)
         + (SELECT count(*) FROM bob.proj_sentiment WHERE feeder_version = $1)
         + (SELECT count(*) FROM bob.proj_channel_health WHERE feeder_version = $1)
         + (SELECT count(*) FROM bob.proj_rum_signals WHERE feeder_version = $1)
         + (SELECT count(*) FROM bob.proj_actor_metrics WHERE feeder_version = $1)
         + (SELECT count(*) FROM bob.proj_detections WHERE feeder_version = $1))::int AS n`, [MARK])
  const demoChannels = () => count(
    "SELECT count(*)::int AS n FROM bob.channels WHERE source_key LIKE 'demo-%'")
  const demoActors = () => count(
    "SELECT count(*)::int AS n FROM bob.actors WHERE display_id LIKE 'demo-%'")

  before(async () => {
    db = await connect()
    await db.query('BEGIN')
    // An empty box with one lab organization: every projection (found, not
    // listed) and every organization go, inside this transaction only.
    const { rows: parted } = await db.query(`
      SELECT format('%I.%I', n.nspname, c.relname) AS t
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'bob' AND c.relkind = 'p' AND NOT c.relispartition`)
    await db.query('SET LOCAL client_min_messages = warning')
    await db.query(`TRUNCATE bob.organizations, ${parted.map((p) => p.t).join(', ')} CASCADE`)
    await db.query(
      `INSERT INTO bob.organizations (name, slug, telemetry_started_at, settings)
       VALUES ('Laboratorio Demo', 'lab-demo', now() - interval '60 days', '{"bob_demo_caja": "local"}')`)
    // As on a box: the connecting role is not a member of the two app roles.
    for (const r of ['bob_app', 'bob_feeder']) {
      const { rows: [m] } = await db.query("SELECT pg_has_role(current_user, $1, 'MEMBER') AS m", [r])
      if (m.m) await db.query(`REVOKE ${r} FROM ${(await db.query('SELECT current_user AS u')).rows[0].u}`)
    }
  })
  after(async () => {
    await db?.query('ROLLBACK')
    await db?.end()
  })

  test('G1: a destination that is not a lab box', async () => {
    await refused(/G1/, () => run({ caja: 'produccion' }, 'guardas.sql'))
  })

  test('G2: no action, or no tenant', async () => {
    await refused(/G2/, () => run({ accion: 'borrar' }, 'guardas.sql'))
    await refused(/G2/, () => run({ tenant: '' }, 'guardas.sql'))
  })

  test('G3: the organization is not the tenant given', async () => {
    await refused(/G3: la organización de la caja no es otra/, () => run({ tenant: 'otra' }, 'guardas.sql'))
  })

  test('G3: a second organization', async () => {
    await refused(/G3: la base tiene 2 organizaciones/, async () => {
      await db.query("INSERT INTO bob.organizations (name, slug) VALUES ('Otra Demo', 'otra-demo')")
      await run({}, 'guardas.sql')
    })
  })

  test('G8: the database does not say it is this lab box', async () => {
    // The flag alone passed G1; a customer box has no mark.
    await refused(/G8/, async () => {
      await db.query("UPDATE bob.organizations SET settings = '{}'")
      await run({}, 'guardas.sql')
    })
    // The mark of another lab box.
    await refused(/G8: la base no está marcada como la caja de laboratorio local/, async () => {
      await db.query(`UPDATE bob.organizations SET settings = '{"bob_demo_caja": "lab-02"}'`)
      await run({}, 'guardas.sql')
    })
    // And lab-02 declared against a database marked local.
    await refused(/G8/, () => run({ caja: 'lab-02' }, 'guardas.sql'))
  })

  test('G4: a role that reads under RLS cannot run the guard', async () => {
    await refused(/G4/, async () => {
      await db.query('GRANT bob_app TO postgres')
      await db.query('SET LOCAL ROLE bob_app')
      await run({}, 'guardas.sql')
    })
  })

  test('the seed and the removal refuse to run without the guard', async () => {
    await refused(/solo después de guardas.sql/, () => run({}, 'semilla.sql'))
    await refused(/solo después de guardas.sql/, () => run({ accion: 'quitar' }, 'quitar.sql'))
  })

  test('every write in the seed and the removal runs as bob_app or bob_feeder', () => {
    for (const f of ['semilla.sql', 'quitar.sql']) {
      let role = null
      for (const line of sql(f).split('\n')) {
        if (/^\s*--/.test(line)) continue
        const set = line.match(/^SET LOCAL ROLE (\w+);/)
        if (set) role = set[1]
        if (/^RESET ROLE;/.test(line)) role = null
        if (/^\s*(INSERT INTO|DELETE FROM|UPDATE|EXECUTE format\('DELETE)/.test(line)) {
          assert.ok(['bob_app', 'bob_feeder'].includes(role), `${f}: «${line.trim()}» runs as ${role}`)
        }
      }
      assert.equal(role, null, `${f} ends with its role reset`)
    }
  })

  test('the seed: five channels, nine actors, 28 days, every row marked', async () => {
    await run({}, 'guardas.sql', 'semilla.sql', 'devolver.sql')
    assert.equal(await demoChannels(), 5)
    assert.equal(await demoActors(), 9)
    assert.deepEqual(
      (await db.query("SELECT channel_type FROM bob.channels WHERE source_key LIKE 'demo-%' ORDER BY display_order")).rows.map((r) => r.channel_type),
      ['voice', 'whatsapp', 'website', 'website', 'forms']);
    assert.ok(await markedRows() > 100000, 'a medium business over four weeks')
    assert.equal(await count(
      'SELECT count(*)::int AS n FROM bob.proj_metric_counts WHERE feeder_version IS DISTINCT FROM $1', [MARK]), 0)
    const days = await count(
      'SELECT count(DISTINCT date_trunc(\'day\', bucket_start))::int AS n FROM bob.proj_metric_counts')
    assert.ok(days >= 28, `${days} days`)
    // The borrowed membership went back.
    for (const r of ['bob_app', 'bob_feeder']) {
      const { rows: [m] } = await db.query("SELECT pg_has_role(current_user, $1, 'MEMBER') AS m", [r])
      assert.equal(m.m, false, `${r} membership returned`)
    }
  })

  test('bob-web reads it as bob_app: the cells are observed and carry values', async () => {
    await db.query("SELECT set_config('request.jwt.claims', json_build_object('org_id', id)::text, true) FROM bob.organizations")
    await db.query('GRANT bob_app TO postgres')
    await db.query('SET LOCAL ROLE bob_app')
    const { rows } = await db.query(`
      SELECT metric, actor_type, state, value, reasons
        FROM bob.bob_cell_rollup((SELECT id FROM bob.organizations),
                                 ARRAY(SELECT id FROM bob.channels),
                                 now() - interval '1 day', now())`)
    await db.query('RESET ROLE')
    await db.query('REVOKE bob_app FROM postgres')
    const cell = (m, a) => rows.find((r) => r.metric === m && r.actor_type === a)
    // Everything v1 can measure, on Rendimiento, Interacciones and Calidad.
    for (const [m, a] of [['resolved', 'asa'], ['resolved', 'human'], ['abandoned', 'user'],
      ['response_time', 'asa'], ['response_time', 'human'], ['response_time', 'user'],
      ['disambiguation', 'asa'], ['disambiguation', 'human'], ['escalations', 'asa'],
      ['escalations', 'human'], ['abandoned_in_queue', 'user'], ['abstained', 'user'],
      ['label_missing', 'user'], ['interaction_duration', 'user'],
      ['orga', null], ['meca', null], ['health_uptime', null]]) {
      assert.equal(cell(m, a)?.state, 'observed', `${m}/${a}`)
      assert.ok(Number(cell(m, a).value) > 0, `${m}/${a} has a value`)
    }
    // A written zero: the classifier was up.
    assert.equal(cell('classifier_down', 'user')?.state, 'observed')
    assert.equal(Number(cell('classifier_down', 'user').value), 0)
    // What v1 cannot measure stays not configured, for its own reason.
    assert.ok(cell('hallucinations', 'asa').reasons.includes('no_ground_truth'))
    assert.ok(cell('response_quality', 'asa').reasons.includes('no_definition:D-15'))
  })

  test('every capability or declaration a bob-web row asks for is declared on some demo channel', async () => {
    // lib/bob/matrix.ts and screens.ts in bob-web: the row is red,
    // «capacidad X: no configurado en la selección», when no selected channel has it.
    for (const cap of ['response_time', 'resolution', 'hallucination', 'orga_conversation', 'meca_rum']) {
      assert.ok(await count(`
        SELECT count(*)::int AS n FROM bob.channel_capabilities k JOIN bob.channels c ON c.id = k.channel_id
         WHERE c.source_key LIKE 'demo-%' AND k.capability = $1`, [cap]) > 0, cap)
    }
    assert.equal(await count(
      "SELECT count(*)::int AS n FROM bob.channels WHERE source_key LIKE 'demo-%' AND (idle_bound_seconds IS NULL OR lag_seconds IS NULL)"), 0)
    assert.equal(await count(`
      SELECT count(*)::int AS n FROM bob.channels c
       WHERE c.source_key LIKE 'demo-%'
         AND (SELECT count(*) FROM bob.channel_actor_mix m WHERE m.channel_id = c.id) <> 4`), 0)
  })

  test('running it twice leaves one seed', async () => {
    const before = await count("SELECT count(*)::int AS n FROM bob.channel_capabilities")
    await run({}, 'guardas.sql', 'semilla.sql', 'devolver.sql')
    assert.equal(await demoChannels(), 5)
    assert.equal(await demoActors(), 9)
    assert.equal(await count('SELECT count(*)::int AS n FROM bob.channel_capabilities'), before)
    assert.equal(await count(
      'SELECT count(DISTINCT source_watermark)::int AS n FROM bob.proj_metric_counts'), 1)
  })

  test('G6: a projection row the seed did not write stops a new seed', async () => {
    await refused(/G6: la base ya tiene datos que no son de la semilla: bob.proj_metric_counts \(1\)/, async () => {
      await db.query(`
        INSERT INTO bob.proj_metric_counts (org_id, channel_id, actor_type, metric_id, bucket_start,
               event_count, session_count, sealed, source_watermark, feeder_version)
        SELECT org_id, id, 'user', 'label_missing', date_bin('5 minutes', now(), '1970-01-01Z') - interval '1 hour',
               1, 1, true, now(), 'reference-feeder/0.1'
          FROM bob.channels WHERE source_key = 'demo-pbx'`)
      await run({}, 'guardas.sql')
    })
  })

  test('G7: a channel with a seed name and no mark', async () => {
    await refused(/G7/, async () => {
      await db.query("UPDATE bob.channels SET config = '{}' WHERE source_key = 'demo-pbx'")
      await run({}, 'guardas.sql')
    })
  })

  test('G7: a seed ref held by an actor that is not the seed\'s', async () => {
    await refused(/G7: una ref demo/, async () => {
      await db.query("DELETE FROM bob.actor_external_refs WHERE ref = 'demo-asistente'")
      await db.query(`
        WITH a AS (INSERT INTO bob.actors (org_id, actor_type, display_id, display_name)
                   SELECT id, 'human', 'agente-real', 'Persona Demo' FROM bob.organizations RETURNING org_id, id)
        INSERT INTO bob.actor_external_refs (org_id, actor_id, ref) SELECT org_id, id, 'demo-asistente' FROM a`)
      await run({}, 'guardas.sql')
    })
  })

  test('G9: the removal refuses when rows it did not write hang off its actors or channels', async () => {
    const cases = [
      [/G9: .*bob\.actor_shifts\.actor_id \(1\)/, `
        INSERT INTO bob.actor_shifts (org_id, actor_id, starts_at, ends_at)
        SELECT org_id, id, now(), now() + interval '8 hours' FROM bob.actors WHERE display_id = 'demo-agente-01'`],
      [/G9: .*bob\.actor_channel_skills/, `
        INSERT INTO bob.actor_channel_skills (org_id, actor_id, channel_id)
        SELECT a.org_id, a.id, c.id FROM bob.actors a, bob.channels c
         WHERE a.display_id = 'demo-agente-01' AND c.source_key = 'demo-pbx'`],
    ]
    for (const [re, insert] of cases) {
      await refused(re, async () => {
        await db.query(insert)
        await run({ accion: 'quitar' }, 'guardas.sql', 'quitar.sql')
      })
    }
  })

  test('the removal stops when a row it did not write points at a seed channel', async () => {
    await refused(/G9: .*bob\.proj_metric_counts\.channel_id \(1\)/, async () => {
      await db.query(`
        INSERT INTO bob.proj_metric_counts (org_id, channel_id, actor_type, metric_id, bucket_start,
               event_count, session_count, sealed, source_watermark, feeder_version)
        SELECT org_id, id, 'user', 'label_missing', date_bin('5 minutes', now(), '1970-01-01Z') - interval '1 hour',
               1, 1, true, now(), 'reference-feeder/0.1'
          FROM bob.channels WHERE source_key = 'demo-pbx'`)
      await run({ accion: 'quitar' }, 'guardas.sql', 'quitar.sql')
    })
  })

  test('the removal takes every marked row and nothing else', async () => {
    await run({ accion: 'quitar' }, 'guardas.sql', 'quitar.sql', 'devolver.sql')
    assert.equal(await markedRows(), 0)
    assert.equal(await demoChannels(), 0)
    assert.equal(await demoActors(), 0)
    assert.equal(await count("SELECT count(*)::int AS n FROM bob.actor_external_refs WHERE ref LIKE 'demo-%'"), 0)
    assert.equal(await count('SELECT count(*)::int AS n FROM bob.organizations'), 1)
  })
})

describe('nothing of the seed reaches the install chain', () => {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .stdout.split('\0').filter(Boolean)

  test('no file under supabase/ and no install script names it', () => {
    const named = tracked
      .filter((f) => f.startsWith('supabase/') || /^scripts\/(instalar-bob|firma-instalacion|firmar-instalacion|ensayo-migracion-lab)/.test(f))
      .filter((f) => /bob-demo|scripts\/demo/.test(readFileSync(join(REPO_ROOT, f), 'utf8')))
    assert.deepEqual(named, [])
  })

  test('the install chain lists migrations only', () => {
    const chain = readFileSync(join(REPO_ROOT, 'supabase/provision/install-chain.sha256'), 'utf8')
    for (const line of chain.split('\n').filter((l) => /^[0-9a-f]{64}/.test(l))) {
      assert.match(line, /^[0-9a-f]{64} {2}\d{14}_[a-z0-9_]+\.sql$/, line)
    }
  })

  test('its files carry no identifier that could be real', () => {
    for (const f of readdirSync(DEMO)) {
      const text = readFileSync(join(DEMO, f), 'utf8')
      assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, `${f}: a uuid`)
      for (const m of text.matchAll(/[\w.+-]+@([\w-]+\.[\w.]+)/g)) {
        assert.equal(m[1], 'example.com', `${f}: ${m[0]}`)
      }
      for (const m of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
        assert.equal(m[0], '127.0.0.1', `${f}: an IP address other than loopback`)
      }
      assert.doesNotMatch(text, /\+\d{1,3}[ -]?\d{3}[ -]?\d{3}[ -]?\d{4}|\(\d{3}\) ?\d{3}-\d{4}/, `${f}: a phone number`)
    }
  })
})
