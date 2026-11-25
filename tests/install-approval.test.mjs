// O-3 (P5 §6.2): what installs BOb on a box changes only with Henry's
// signature, made with a security key that must be touched, over a digest of
// supabase/provision/ and what supabase/provision/cubre-la-firma lists.
//
// What runs here, with no database:
//   - the digest moves with every covered file and with nothing else, and
//     adding a signature does not move it;
//   - the verifier refuses: no key, a key that is not a security key, a
//     security key marked no-touch-required or not bound to the namespace,
//     and a signature by a key that is not listed;
//   - the repository: the signers file holds no key yet (Henry adds his), every
//     path the signature covers exists and is under CODEOWNERS, and the
//     approval workflow runs from main and never checks out the PR.
// Not measured here: a good signature by a real security key. That needs the
// key and a touch; the first one Henry makes is the measurement.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/db.mjs'
import { fromGit, digest, covered, EXTRA } from '../scripts/huella-instalacion.mjs'

const VERIFY = join(REPO_ROOT, 'scripts/verificar-firma-instalacion.sh')

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'huella-'))
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.email', 'ci@example.com'); git('config', 'user.name', 'CI')
  const put = (p, c) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), c) }
  put('supabase/provision/bob.sql', 'select 1;\n')
  put(EXTRA, '# covered\nscripts/instalar.sh\n')
  put('scripts/instalar.sh', 'echo a\n')
  put('scripts/other.sh', 'echo b\n')
  const commit = () => { git('add', '-A'); git('commit', '-q', '-m', 'x', '--allow-empty'); return git('rev-parse', 'HEAD').toString().trim() }
  return { d, put, rm: (p) => rmSync(join(d, p)), commit }
}

describe('the digest', () => {
  test('moves with every covered file and nothing else', async () => {
    const r = repo()
    const at = async (rev) => digest(fromGit(rev, r.d))
    const c0 = r.commit(); const d0 = await at(c0)
    assert.equal(await at(c0), d0, 'deterministic')
    assert.deepEqual(await covered(fromGit(c0, r.d)), ['scripts/instalar.sh', 'supabase/provision/bob.sql', EXTRA])

    r.put('supabase/provision/aprobaciones/x.sig', 'sig'); const c1 = r.commit()
    assert.equal(await at(c1), d0, 'a signature does not change what it signs')
    r.put('scripts/other.sh', 'echo c\n'); const c2 = r.commit()
    assert.equal(await at(c2), d0, 'a file outside the cover does not count')

    r.put('scripts/instalar.sh', 'echo z\n'); const c3 = r.commit()
    assert.notEqual(await at(c3), d0, 'a listed script counts')
    r.put('supabase/provision/new.sql', '\n'); const c4 = r.commit()
    assert.notEqual(await at(c4), await at(c3), 'a new file under supabase/provision/ counts')
    r.rm('scripts/instalar.sh'); const c5 = r.commit()
    assert.notEqual(await at(c5), await at(c4), 'a removed listed file counts')
    r.put(EXTRA, '# covered\n'); const c6 = r.commit()
    assert.notEqual(await at(c6), await at(c5), 'dropping a path from the list counts')
    rmSync(r.d, { recursive: true })
  })
})

describe('the verifier refuses', () => {
  const d = mkdtempSync(join(tmpdir(), 'firma-'))
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ci', '-f', join(d, 'k')])
  const pub = readFileSync(join(d, 'k.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
  const dg = 'a'.repeat(64)
  const sig = join(d, 'm.sig')
  writeFileSync(join(d, 'm'), `${dg}\n`)
  execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', join(d, 'k'), '-n', 'bob-install-chain', join(d, 'm')])
  const verify = (signers) => {
    writeFileSync(join(d, 'signers'), signers)
    return spawnSync('bash', [VERIFY, join(d, 'signers'), dg, sig], { encoding: 'utf8' })
  }
  const refused = (name, signers, why) => test(name, () => {
    const r = verify(signers)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, why)
  })
  refused('a signers file with no key', '# empty\n', /holds no key/)
  refused('a key that is not a security key, even when it signed', `henry namespaces="bob-install-chain" ${pub}\n`, /not a security key/)
  refused('a security key marked no-touch-required',
    'henry namespaces="bob-install-chain",no-touch-required sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t\n', /no-touch-required/)
  refused('a security key not bound to the namespace',
    'henry sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t\n', /namespaces/)
  refused('a signature by a key that is not listed',
    'henry namespaces="bob-install-chain" sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t\n', /no key|does not verify/)
})

describe('the repository', () => {
  test('the signers file holds no key until Henry adds his', () => {
    const lines = readFileSync(join(REPO_ROOT, 'supabase/provision/firmantes_instalacion'), 'utf8')
      .split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
    for (const l of lines) assert.match(l, /^\S+ namespaces="bob-install-chain"\S* sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com \S+/, l)
  })
  test('every path the signature covers exists and is under CODEOWNERS', () => {
    const owners = readFileSync(join(REPO_ROOT, '.github/CODEOWNERS'), 'utf8').split('\n')
      .filter((l) => l.startsWith('/')).map((l) => l.split(/\s+/)[0].slice(1))
    const listed = readFileSync(join(REPO_ROOT, EXTRA), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    assert.ok(owners.includes('supabase/provision/'))
    for (const p of listed) {
      assert.ok(existsSync(join(REPO_ROOT, p)), `${p} is listed and missing`)
      assert.ok(owners.some((o) => o.endsWith('/') ? p.startsWith(o) : p === o), `${p} is covered by the signature and not by CODEOWNERS`)
    }
  })
  test('the approval workflow runs from main and never checks out the PR', () => {
    const w = readFileSync(join(REPO_ROOT, '.github/workflows/install-approval.yml'), 'utf8')
    assert.match(w, /^on:\n {2}pull_request_target:/m)
    assert.match(w, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/)
    assert.doesNotMatch(w, /pull_request\.head\.(ref|repo)|github\.head_ref/)
    assert.match(w, /permissions:\n {2}contents: read\n {2}pull-requests: read\n\n/)
    assert.match(w, /verificar-firma-instalacion\.sh supabase\/provision\/firmantes_instalacion/)
  })
})
