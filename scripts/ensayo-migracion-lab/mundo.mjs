// The synthetic world the lab-02 rehearsal restores and rebuilds (P5 §8,
// objection 2). Run by scripts/ensayo-migracion-lab.sh, never on its own.
//
//   node mundo.mjs cargar        load the two-tenant fixture, the roster and the
//                                feeder's world: every value invented
//   node mundo.mjs alimentar     run the reference feeder as bob_feeder over the
//                                fixture's window, from the in-memory truth
//                                store that stands in for ClickHouse until 3.7
//   node mundo.mjs proyecciones  one line per projection table: rows and the
//                                md5 of its rows minus computed_at
//   node mundo.mjs limpiar       remove both fixture tenants, projections first
//
// The connection comes from SUPABASE_DB_URL with no password in it; node-postgres
// takes the password from PGPASSWORD, so it never sits on a command line.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  REPO_ROOT, TENANT_A, TENANT_B, connect, connectAs, clearTenants,
  loadFixture, loadRoster, loadFeederWorld,
} from '../../tests/helpers/db.mjs'
import { runFeeder } from '../../feeder/reference-feeder.mjs'
import { MemoryTruthStore } from '../../feeder/memory-truth-store.mjs'

const FIXTURE = JSON.parse(readFileSync(
  resolve(REPO_ROOT, 'supabase/tests/fixtures/feeder_events.json'), 'utf8'))
const FROM = '2026-11-18T14:00:00Z'
const TO = '2026-11-18T14:30:00Z'
const TENANTS = [TENANT_A, TENANT_B]

async function projectionTables(db) {
  const { rows } = await db.query(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'bob' AND c.relkind = 'p' AND c.relname LIKE 'proj\\_%' ORDER BY 1`)
  return rows.map((r) => r.name)
}

const mode = process.argv[2]
const db = await connect()
try {
  if (mode === 'cargar') {
    await loadFixture(db)
    await loadRoster(db)
    await loadFeederWorld(db)
  } else if (mode === 'alimentar') {
    // The role is named, never written `current_user`: on the box's image
    // (supabase/postgres 17.6.1.136, supautils loaded) `GRANT <role> TO
    // current_user` terminates the server, every connection with it. Measured
    // locally on 2026-11-20 (F-27). CI's 15.x image does not crash.
    const { rows: [{ me }] } = await db.query('SELECT quote_ident(current_user) AS me')
    await db.query(`GRANT bob_feeder TO ${me}`)
    const feeder = await connectAs('bob_feeder')
    try {
      const truth = new MemoryTruthStore({ events: FIXTURE.events, watermark: FIXTURE.watermark })
      const r = await runFeeder(feeder, truth, { from: FROM, to: TO })
      console.log(`tenants=${Object.keys(r.written).length} unmapped=${r.unmappedEvents} unresolved=${r.unresolvedAgentRefs}`)
    } finally {
      await feeder.end()
      await db.query(`REVOKE bob_feeder FROM ${me}`)
    }
  } else if (mode === 'proyecciones') {
    for (const t of await projectionTables(db)) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n,
                md5(coalesce(string_agg((to_jsonb(x) - 'computed_at')::text, '|'
                    ORDER BY (to_jsonb(x) - 'computed_at')::text), '')) AS h
           FROM bob.${t} x WHERE org_id = ANY($1::uuid[])`, [TENANTS])
      console.log(`${t} filas=${rows[0].n} md5=${rows[0].h}`)
    }
  } else if (mode === 'limpiar') {
    await db.query('BEGIN')
    await clearTenants(db)
    await db.query('COMMIT')
  } else {
    throw new Error(`modo desconocido: ${mode}`)
  }
} finally {
  await db.end()
}
