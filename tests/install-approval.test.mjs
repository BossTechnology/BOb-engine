// O-3 (P5 §6.2): what installs BOb on a box changes only with Henry's
// signature, made with a security key that must be touched, over the pair
// base → new of a digest; and a box installs only what that signature covers.
// scripts/firma-instalacion.sh does all of it; this runs it with no database.
//
//   - the digest moves with the content, mode or presence of every covered
//     file and with nothing else; an approval does not move it; a symlink, a
//     submodule or a directory listed in cubre-la-firma is refused;
//   - the verifier refuses: no key, a key that is not a security key (even one
//     that did sign), no-touch-required, no namespace, an unlisted signer;
//   - on a box: a checkout that is not exactly a commit, one with no approval,
//     an approval for another digest, signers not root's, are all refused
//     before anything runs;
//   - the repository: no key yet (Henry adds his), every covered path under
//     CODEOWNERS, the approval workflow running from main on the right events.
// Not measured here: a good signature by a real security key (it needs the key
// and a touch; Henry's first signature is the measurement).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/db.mjs'

const F = join(REPO_ROOT, 'scripts/firma-instalacion.sh')
const EXTRA = 'supabase/provision/cubre-la-firma'
const run = (args, opts = {}) => spawnSync('bash', [F, ...args], { encoding: 'utf8', ...opts })

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'huella-'))
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' }).toString().trim()
  git('init', '-q'); git('config', 'user.email', 'ci@example.com'); git('config', 'user.name', 'CI')
  const put = (p, c) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), c) }
  put('supabase/provision/bob.sql', 'select 1;\n')
  put(EXTRA, '# covered\nscripts/instalar.sh\npackage.json\n')
  put('scripts/instalar.sh', 'echo a\n')
  put('scripts/other.sh', 'echo b\n')
  const commit = (add = true) => { if (add) git('add', '-A'); git('commit', '-q', '-m', 'x', '--allow-empty'); return git('rev-parse', 'HEAD') }
  const huella = (rev) => { const r = run(['huella', rev, d]); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  return { d, git, put, rm: (p) => rmSync(join(d, p), { recursive: true }), commit, huella }
}

describe('the digest', () => {
  test('moves with every covered file and nothing else', () => {
    const r = repo()
    const d0 = r.huella(r.commit())
    assert.match(d0, /^[0-9a-f]{64}$/)
    assert.equal(r.huella('HEAD'), d0, 'deterministic')
    const lista = run(['huella', 'HEAD', r.d, '--lista']).stdout
    assert.match(lista, /^absent package\.json -$/m, 'a listed file that does not exist counts as absent')

    const same = (what) => { r.commit(); assert.equal(r.huella('HEAD'), d0, what) }
    const moves = (what) => { const before = r.huella('HEAD'); r.commit(); assert.notEqual(r.huella('HEAD'), before, what) }
    r.put('supabase/provision/aprobaciones/x.aprobacion', 'a'); same('an approval does not change what it approves')
    r.put('scripts/other.sh', 'echo c\n'); same('a file outside the cover does not count')

    r.put('scripts/instalar.sh', 'echo z\n'); moves('a listed script counts')
    r.put('package.json', '{}\n'); moves('a listed file appearing counts')
    chmodSync(join(r.d, 'scripts/instalar.sh'), 0o755); moves('the mode counts')
    r.put('supabase/provision/new.sql', '\n'); moves('a new file under supabase/provision/ counts')
    r.put('lib/node_modules/pg/index.js', 'x\n'); moves('a tracked node_modules/ file anywhere counts')
    r.rm('scripts/instalar.sh'); moves('a removed listed file counts')
    r.put(EXTRA, '# covered\npackage.json\n'); moves('dropping a path from the list counts')
    rmSync(r.d, { recursive: true })
  })

  const refused = (name, change, why) => test(name, () => {
    const r = repo(); r.commit(); r.commit(change(r) !== 'staged')
    const out = run(['huella', 'HEAD', r.d])
    assert.equal(out.status, 1, out.stdout); assert.match(out.stderr, why)
    rmSync(r.d, { recursive: true })
  })
  refused('a symlink under supabase/provision/', (r) => symlinkSync('/etc/passwd', join(r.d, 'supabase/provision/l.sql')), /mode 120000/)
  refused('a submodule under supabase/provision/', (r) => { r.git('update-index', '--add', '--cacheinfo', `160000,${r.git('rev-parse', 'HEAD')},supabase/provision/sub`); return 'staged' }, /mode 160000/)
  refused('a directory listed in cubre-la-firma', (r) => { r.put('scripts/x/a.sh', '\n'); r.put(EXTRA, 'scripts/x\n') }, /lists a directory/)
  refused('a symlink listed in cubre-la-firma', (r) => { symlinkSync('instalar.sh', join(r.d, 'scripts/l.sh')); r.put(EXTRA, 'scripts/l.sh\n') }, /mode 120000/)
})

describe('the signed text', () => {
  test('is the pair base → new, exactly', () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    assert.equal(run(['mensaje', a, b]).stdout, `bob-install-chain 1\nbase ${a}\nnueva ${b}\n`)
    assert.equal(run(['mensaje', a, 'x']).status, 1)
  })
})

describe('the verifier refuses', () => {
  const d = mkdtempSync(join(tmpdir(), 'firma-'))
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ci', '-f', join(d, 'k')])
  const pub = readFileSync(join(d, 'k.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
  writeFileSync(join(d, 'm'), run(['mensaje', 'a'.repeat(64), 'b'.repeat(64)]).stdout)
  execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', join(d, 'k'), '-n', 'bob-install-chain', join(d, 'm')])
  const sk = 'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t'
  const refused = (name, signers, why) => test(name, () => {
    writeFileSync(join(d, 'signers'), signers)
    const r = run(['verificar', join(d, 'signers'), join(d, 'm'), join(d, 'm.sig')])
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, why)
  })
  refused('a signers file with no key', '# empty\n', /holds no key/)
  refused('a key that is not a security key, even when it signed', `henry namespaces="bob-install-chain" ${pub}\n`, /not a security key/)
  refused('a security key marked no-touch-required', `henry namespaces="bob-install-chain",no-touch-required ${sk}\n`, /no-touch-required/)
  refused('a security key not bound to the namespace', `henry ${sk}\n`, /namespaces/)
  refused('a signature by a key that is not listed', `henry namespaces="bob-install-chain" ${sk}\n`, /no key|does not verify/)
})

describe('on a box, nothing runs without the approval', () => {
  const box = (prep) => {
    const r = repo(); r.put('scripts/instalar-bob.sh', '#!/bin/sh\ntouch "$(dirname "$0")/../RAN"\n'); r.commit(); prep(r)
    const out = run(['caja', r.d, 'resto'], { env: { ...process.env, SUDO: 'false' } })
    const ran = spawnSync('test', ['-e', join(r.d, 'RAN')]).status === 0
    rmSync(r.d, { recursive: true })
    return { out, ran }
  }
  const refused = (name, prep, why) => test(name, () => {
    const { out, ran } = box(prep)
    assert.equal(out.status, 1, out.stdout + out.stderr); assert.match(out.stderr, why); assert.equal(ran, false)
  })
  refused('a checkout with a file not committed', (r) => r.put('node_modules/pg/index.js', 'x'), /not exactly a commit/)
  refused('a checkout with a modified file', (r) => r.put('scripts/instalar.sh', 'echo evil\n'), /not exactly a commit/)
  refused('a commit with no approval', () => {}, /no approval/)
  refused('an approval for another digest', (r) => {
    r.put(`supabase/provision/aprobaciones/${r.huella('HEAD')}.aprobacion`, run(['mensaje', 'a'.repeat(64), 'b'.repeat(64)]).stdout)
    r.put(`supabase/provision/aprobaciones/${r.huella('HEAD')}.aprobacion.sig`, 'x'); r.commit()
  }, /not for digest/)
  refused('signers that are not root\'s', (r) => {
    const h = r.huella('HEAD')
    r.put(`supabase/provision/aprobaciones/${h}.aprobacion`, run(['mensaje', 'a'.repeat(64), h]).stdout)
    r.put(`supabase/provision/aprobaciones/${h}.aprobacion.sig`, 'x'); r.commit()
  }, /not root's|does not exist/)
})

describe('the repository', () => {
  test('the signers file holds no key until Henry adds his, and only security keys', () => {
    const lines = readFileSync(join(REPO_ROOT, 'supabase/provision/firmantes_instalacion'), 'utf8')
      .split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
    for (const l of lines) assert.match(l, /^\S+ namespaces="bob-install-chain"\S* sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com \S+/, l)
  })
  test('the digest of this commit is computable, and every covered path is under CODEOWNERS', () => {
    const r = run(['huella', 'HEAD', REPO_ROOT, '--lista'])
    assert.equal(r.status, 0, r.stderr)
    const owners = readFileSync(join(REPO_ROOT, '.github/CODEOWNERS'), 'utf8').split('\n')
      .filter((l) => l.startsWith('/')).map((l) => l.split(/\s+/)[0].slice(1))
    for (const p of r.stdout.trim().split('\n').map((l) => l.split(' ')[1])) {
      assert.ok(owners.some((o) => o.endsWith('/') ? p.startsWith(o) : p === o), `${p} is covered by the signature and not by CODEOWNERS`)
    }
    for (const p of ['scripts/instalar-bob.sh', 'scripts/firma-instalacion.sh', 'supabase/config.toml', 'package.json', 'pnpm-lock.yaml']) {
      assert.match(r.stdout, new RegExp(` ${p.replace('.', '\\.')} `), `${p} is not covered`)
    }
  })
  test('the approval workflow runs from main, on base changes too, and never checks out the PR', () => {
    const w = readFileSync(join(REPO_ROOT, '.github/workflows/install-approval.yml'), 'utf8')
    assert.match(w, /^on:\n {2}pull_request_target:\n {4}types: \[opened, synchronize, reopened, edited\]/m)
    assert.match(w, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/)
    assert.match(w, /\[ "\$BASE_REF" = main \]/)
    assert.doesNotMatch(w, /pull_request\.head\.(ref|repo)|github\.head_ref|actions\/setup-node|pnpm|npm /)
    assert.match(w, /permissions:\n {2}contents: read\n {2}pull-requests: read\n\n/)
    assert.match(w, /f=scripts\/firma-instalacion\.sh\n/)
    assert.match(w, /"\$f" verificar supabase\/provision\/firmantes_instalacion /)
  })
})
