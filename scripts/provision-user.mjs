#!/usr/bin/env node
// Give a GoTrue account the right to sign in to a box: the one way a row in
// bob.users is made (Henry, 21 Nov). Signing up never makes one, and bob-web
// answers 403 to an account without one.
//
// Run by the operator with the migration owner's credential, never with the
// service role:
//
//   set -a; . /opt/bzzz/secrets/bob/migrador.env; set +a
//   BOX_DB_URL=… node scripts/provision-user.mjs --tenant <bzzz.tenant> \
//     --email person@example.com --role analyst            # dry: says what it would do
//   … the same with --ejecutar                              # does it
//   … --email person@example.com --desactivar --ejecutar    # active = false
//
// The account must already exist in the box's GoTrue; this does not create
// one. It finds it by email (case-insensitive), puts its id into bob.users in
// the organization whose slug is the tenant, with the role given. Run again, it
// updates the role (or deactivates). It refuses, and writes nothing, when the
// account or the organization is not found, when the row belongs to another
// organization, or when the role is not one a person holds.
//
// Everything happens in one transaction, so the dry run does the same work and
// rolls it back. It never prints the connection string.

import pg from 'pg'
import { pathToFileURL } from 'node:url'

// The roles a person holds. `service` and `demo` exist in the CHECK for other
// uses and are not given out by this script.
export const PERSON_ROLES = ['admin', 'analyst', 'viewer']

export async function provisionUser(client, {
  tenant, email, role, deactivate = false, execute = false,
} = {}) {
  if (!tenant) throw new Error('the box tenant (--tenant, bzzz.tenant) was not given')
  if (!email) throw new Error('--email was not given')
  if (!deactivate && !PERSON_ROLES.includes(role)) {
    throw new Error(`role must be one of ${PERSON_ROLES.join(', ')}; got ${role ?? 'nothing'}`)
  }

  await client.query('BEGIN')
  try {
    const { rows: orgs } = await client.query(
      'SELECT id::text FROM bob.organizations WHERE slug = $1', [tenant])
    if (orgs.length !== 1) throw new Error(`no organization has slug ${tenant}`)
    const org = orgs[0].id

    const { rows: accounts } = await client.query(
      'SELECT id::text, email FROM auth.users WHERE lower(email) = lower($1)', [email])
    if (accounts.length !== 1) {
      throw new Error(accounts.length
        ? `${accounts.length} GoTrue accounts have this email; resolve that first`
        : 'no GoTrue account has this email; create it in the box\'s identity stack first')
    }
    const account = accounts[0]

    const { rows: [existing] } = await client.query(
      'SELECT org_id::text, role, active FROM bob.users WHERE id = $1 FOR UPDATE', [account.id])
    if (existing && existing.org_id !== org) {
      throw new Error('this account already belongs to another organization; nothing changed')
    }

    let plan
    if (deactivate) {
      if (!existing) throw new Error('this account has no row in bob.users; nothing to deactivate')
      await client.query('UPDATE bob.users SET active = false WHERE id = $1', [account.id])
      plan = `update ${account.id}: active ${existing.active} -> false`
    } else if (existing) {
      await client.query('UPDATE bob.users SET role = $2, active = true WHERE id = $1',
        [account.id, role])
      plan = `update ${account.id}: role ${existing.role} -> ${role}, active ${existing.active} -> true`
    } else {
      await client.query(`INSERT INTO bob.users (id, org_id, email, role, active)
                          VALUES ($1, $2, $3, $4, true)`, [account.id, org, account.email, role])
      plan = `insert ${account.id} into ${tenant} as ${role}`
    }

    await client.query(execute ? 'COMMIT' : 'ROLLBACK')
    return { executed: execute, plan }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  }
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.BOX_DB_URL
  if (!url) {
    console.error('BOX_DB_URL is not set')
    process.exit(2)
  }
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const r = await provisionUser(client, {
      tenant: arg('--tenant') ?? process.env.BOX_TENANT,
      email: arg('--email'),
      role: arg('--role'),
      deactivate: process.argv.includes('--desactivar'),
      execute: process.argv.includes('--ejecutar'),
    })
    console.log(`${r.executed ? 'done' : 'dry run, nothing written'}: ${r.plan}`)
    if (!r.executed) console.log('run again with --ejecutar to do it')
  } catch (e) {
    console.error(`refused: ${e.message}`)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}
