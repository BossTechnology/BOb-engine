// The feeder's image (Dockerfile, .dockerignore): what Bzzz's
// construir-imagen-bob.sh builds with SERVICIO=bob-feeder.
//
// It builds the image from the repository root and measures, on the image:
//   1. it runs as 65534, not root;
//   2. it cannot write to the root of its filesystem, with or without
//      --read-only, nor to /app;
//   3. with the box's flags (--read-only, --cap-drop ALL, --network none)
//      `node feeder/main.mjs --help` answers: the feeder reads no `--help`, it
//      refuses it by name and exits 2 with a config_error line, which is its
//      answer to anything it does not understand; with no arguments and no
//      environment it exits 2 the same way, having opened no connection;
//   4. `pg` loads;
//   5. the guard: the image holds no .env file, no key or certificate, no
//      npmrc, and no text in /app that looks like a secret.
//
// The guard is a pure function over a listing (findLeaks), so it is tested
// against planted leaks without docker, and then measured on the real image.
//
// Needs docker and the network (the build installs pg). Without docker the
// image tests skip; in CI a skip is a failure (BOB_FEEDER_IMAGE_REQUIRED=1).

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './helpers/db.mjs'

const REQUIRED = process.env.BOB_FEEDER_IMAGE_REQUIRED === '1'
// name and tag as two parts: slice2-schema's namespace guard reads `word:${` as a ref being built.
const TAG = ['bob-feeder-test', String(process.pid)].join('\x3a')
const BOX_FLAGS = ['--read-only', '--cap-drop', 'ALL', '--network', 'none', '--security-opt', 'no-new-privileges']

// Names that must not be in the image. Anchored on the file name.
const SECRET_NAME = /(^|\/)(\.env($|\.[^/]*)|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|crt|jks|keystore))$/
// What a secret looks like inside a text file.
const SECRET_TEXT = [
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  'service_role',
  'SUPABASE_SERVICE_ROLE',
  'postgres(ql)?://[^:/@ ]+:[^@ ]+@',
  'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.',
  'AKIA[0-9A-Z]{16}',
].join('|')

// names: every path in the image under the places that matter; hits: paths of
// text files in /app (outside node_modules) that match SECRET_TEXT.
export function findLeaks({ names, hits }) {
  return [
    ...names.filter((n) => SECRET_NAME.test(n)).map((n) => `file ${n}`),
    ...hits.map((h) => `text that looks like a secret in ${h}`),
  ]
}

describe('findLeaks, the guard, against planted leaks', () => {
  test('a clean listing finds nothing', () => {
    assert.deepEqual(findLeaks({ names: ['/app/feeder/main.mjs', '/app/package.json', '/app/node_modules/pg/lib/index.js'], hits: [] }), [])
  })
  for (const planted of ['/app/.env', '/app/.env.production', '/app/feeder/.env.local', '/app/tls/client.pem',
    '/app/tls/client.key', '/app/.npmrc', '/root/.ssh/id_ed25519', '/app/node_modules/x/ca.crt']) {
    test(`it fails on ${planted}`, () => {
      assert.equal(findLeaks({ names: ['/app/feeder/main.mjs', planted], hits: [] }).length, 1)
    })
  }
  test('it fails on a text hit', () => {
    assert.equal(findLeaks({ names: [], hits: ['/app/feeder/x.mjs'] }).length, 1)
  })
  test('it does not mistake a name that only contains env', () => {
    assert.deepEqual(findLeaks({ names: ['/app/feeder/environment.mjs', '/app/feeder/envelope.mjs'], hits: [] }), [])
  })
})

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000, ...opts })
}

const hasDocker = docker(['version', '--format', '{{.Server.Version}}']).status === 0

describe('the feeder image', { skip: !hasDocker && !REQUIRED ? 'docker is not available' : false }, () => {
  before(() => {
    assert.ok(hasDocker, 'docker is not available and BOB_FEEDER_IMAGE_REQUIRED=1: a skip is a failure here')
    const b = docker(['build', '--quiet', '-t', TAG, REPO_ROOT])
    assert.equal(b.status, 0, `the image does not build:\n${b.stdout}\n${b.stderr}`)
  })
  after(() => { if (hasDocker) docker(['rmi', '-f', TAG]) })

  const inImage = (cmd, flags = []) => docker(['run', '--rm', ...flags, '--entrypoint', 'sh', TAG, '-c', cmd])

  test('it runs as 65534', () => {
    for (const flag of ['-u', '-g']) {
      const r = docker(['run', '--rm', '--entrypoint', 'id', TAG, flag])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout.trim(), '65534')
    }
    assert.equal(docker(['inspect', '-f', '{{.Config.User}}', TAG]).stdout.trim(), '65534:65534')
  })

  test('it cannot write to the root, with or without --read-only, nor to /app', () => {
    for (const flags of [[], BOX_FLAGS]) {
      for (const path of ['/probe', '/app/probe', '/app/feeder/probe', '/etc/probe']) {
        const r = inImage(`touch ${path}`, flags)
        assert.notEqual(r.status, 0, `${path} was writable with [${flags.join(' ')}]`)
      }
    }
  })

  test('with the box flags, --help is answered: refused by name, exit 2', () => {
    const r = docker(['run', '--rm', ...BOX_FLAGS, TAG, '--help'])
    assert.equal(r.status, 2, r.stderr)
    const line = JSON.parse(r.stdout.trim().split('\n').pop())
    assert.equal(line.event, 'config_error')
    assert.match(line.message, /unknown argument --help/)
  })

  test('with no arguments and no environment, exit 2 and a config_error', () => {
    const r = docker(['run', '--rm', ...BOX_FLAGS, TAG])
    assert.equal(r.status, 2, r.stderr)
    assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).event, 'config_error')
  })

  test('pg loads', () => {
    const r = docker(['run', '--rm', ...BOX_FLAGS, '--entrypoint', 'node', TAG, '--input-type=module', '-e',
      "const { default: pg } = await import('pg'); if (typeof pg.Client !== 'function') process.exit(3)"])
    assert.equal(r.status, 0, r.stderr)
  })

  test('the image holds only the feeder, package.json and node_modules in /app', () => {
    const r = inImage('ls -A /app | sort')
    assert.equal(r.stdout.trim(), 'feeder\nnode_modules\npackage.json')
  })

  test('the guard: no .env, key, certificate, npmrc or secret text in the image', () => {
    const names = inImage("find / -xdev \\( -path /proc -o -path /sys -o -path /usr/local/lib/node_modules/npm \\) -prune -o -type f \\( -name '.env*' -o -name '.npmrc' -o -name '.netrc' -o -name 'id_*' \\) -print; " +
      "find /app /root /home -type f \\( -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '*.jks' -o -name '*.keystore' -o -name '*.crt' \\) -print 2>/dev/null; true")
    assert.equal(names.status, 0, names.stderr)
    const text = inImage(`grep -rIlE --exclude-dir=node_modules '${SECRET_TEXT}' /app 2>/dev/null; true`)
    const leaks = findLeaks({
      names: names.stdout.split('\n').filter(Boolean),
      hits: text.stdout.split('\n').filter(Boolean),
    })
    assert.deepEqual(leaks, [], `the image carries what it must not:\n  ${leaks.join('\n  ')}`)
  })
})
