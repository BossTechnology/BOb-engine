#!/usr/bin/env node
// The read-only check a customer box runs after its migration step (P5 §6.2,
// "How it is checked after"). Run by the operator, with the migration owner's
// connection string, right after `supabase db push`:
//
//   BOX_DB_URL=… node scripts/box-check.mjs --tenant <bzzz.tenant>
//
// It checks, in one READ ONLY transaction that is rolled back:
//   - one organization per box, and its slug is the box's bzzz.tenant
//     (P5 §8, objection 3);
//   - three roles and no more (P5 §6.3);
//   - no egress from the database (P5 §6.3), and which egress extensions are
//     installed, so an empty result is not mistaken for a check that ran;
//   - a warning, which does not fail the check, when the organization has no
//     active user in bob.users: nobody could sign in (bob-web answers 403).
//
// It writes nothing, sets no role and loads no fixture. It exits 0 when every
// check is green and 1 otherwise. It never prints the connection string.
//
// Why here and not in the suite: the suite's fixture holds two tenants on
// purpose, so the one-organization rule is false in CI by design. The suite
// tests this script's checks instead (tests/p5-roles.test.mjs), including that
// the one-organization check refuses the two-tenant fixture.

import pg from 'pg'
import {
  oneOrganizationFindings, threeRolesFindings, egressFindings, egressInstalled,
  activeUserFindings,
} from './box-checks.mjs'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

const url = process.env.BOX_DB_URL
const tenant = arg('--tenant') ?? process.env.BOX_TENANT
if (!url) {
  console.error('BOX_DB_URL is not set')
  process.exit(2)
}

const client = new pg.Client({ connectionString: url })
await client.connect()
let failed = false
try {
  await client.query('BEGIN TRANSACTION READ ONLY')
  const checks = [
    ['one organization, slug = bzzz.tenant', () => oneOrganizationFindings(client, tenant)],
    ['three roles, no more', () => threeRolesFindings(client)],
    ['no egress from the database', () => egressFindings(client)],
  ]
  for (const [name, run] of checks) {
    const findings = await run()
    console.log(`${findings.length ? 'FAIL' : 'ok  '}  ${name}`)
    for (const f of findings) console.log(`      ${f}`)
    failed ||= findings.length > 0
  }
  const warnings = await activeUserFindings(client, tenant)
  console.log(`${warnings.length ? 'WARN' : 'ok  '}  someone can sign in`)
  for (const w of warnings) console.log(`      ${w}`)
  const installed = await egressInstalled(client)
  console.log(`      egress extensions installed: ${installed.length
    ? installed.map((e) => `${e.extname} (${e.schema})`).join(', ') : 'none'}`)
} finally {
  await client.query('ROLLBACK').catch(() => {})
  await client.end()
}
process.exit(failed ? 1 : 0)
