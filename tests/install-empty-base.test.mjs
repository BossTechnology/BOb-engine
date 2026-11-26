// The empty base (Henry, «Defined empty base»; scripts/firma-instalacion.sh
// VACIA): a box where BOb was never installed holds it, and caja runs cadena
// from it with BOB_BASE_VACIA=1. instalar-bob.sh must then refuse a database
// that already holds BOb, so a box with the chain applied cannot claim the
// empty base and skip the review of where it stands.
//
// This runs instalar-bob.sh cadena against the suite's database, which holds
// the whole chain. Nothing is pushed: `supabase` on PATH is a stub (below)
// that only records it was reached. GITHUB_ACTIONS=true and
// INSTALAR_SIN_FIRMA=ci are set here so the script runs outside a signed
// tree, as in CI's own job; the check under test runs either way.
// Not measured here: a database with no BOb, where the check must pass. The
// suite has no empty database; the first install from the empty base (a
// rehearsal, then model-01 or Febor) is that measurement.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT, DB_URL } from './helpers/db.mjs'

const url = new URL(DB_URL)
const d = realpathSync(mkdtempSync(join(tmpdir(), 'base-vacia-')))
writeFileSync(join(d, 'postgres.env'), `POSTGRES_PASSWORD=${decodeURIComponent(url.password)}\n`); chmodSync(join(d, 'postgres.env'), 0o600)
const bin = join(d, 'bin')
spawnSync('mkdir', [bin])
// Test stub for the supabase CLI: records that cadena reached the push.
writeFileSync(join(bin, 'supabase'), `#!/bin/sh\n# test stub, never the real CLI\necho "$*" > "${join(d, 'pushed')}"\n`); chmodSync(join(bin, 'supabase'), 0o755)

const cadena = (env) => {
  spawnSync('rm', ['-f', join(d, 'pushed')])
  const r = spawnSync('bash', [join(REPO_ROOT, 'scripts/instalar-bob.sh'), 'cadena'], {
    cwd: REPO_ROOT, encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: d, LANG: 'C',
      INSTALAR_SIN_FIRMA: 'ci', GITHUB_ACTIONS: 'true', SUDO: '',
      POSTGRES_ENV: join(d, 'postgres.env'), POSTGRES_HOST: url.hostname, POSTGRES_PORT: url.port || '5432',
      // instalar-bob.sh writes its pgpass on tmpfs: /dev/shm on Linux; a private directory on macOS.
      ...(process.platform === 'linux' ? {} : { XDG_RUNTIME_DIR: d }),
      ...env,
    },
  })
  return { ...r, pushed: existsSync(join(d, 'pushed')) }
}

test('the stub is reached without the empty base (control: the harness pushes)', () => {
  const r = cadena({})
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(r.pushed, 'cadena reached supabase db push')
})

test('a database with the chain applied cannot claim the empty base: refused before the push', () => {
  const r = cadena({ BOB_BASE_VACIA: '1' })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /claims the empty base \(no BOb\), but its database already holds BOb/)
  assert.match(r.stderr, /[1-9][0-9]* of BOb's migrations in the CLI's history/)
  assert.equal(r.pushed, false, 'nothing was pushed')
})
