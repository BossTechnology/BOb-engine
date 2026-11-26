// O-3 (P5 §6.2): what installs BOb on a box changes only with Henry's
// signature, made with a security key that must be touched, over the pair
// base → new of the digest of the whole tree; and a box installs only that
// tree, written from git objects into a directory of root's. Everything is in
// scripts/firma-instalacion.sh; this runs it with no database.
//
//   - the digest moves with the content, mode or presence of any file, a new
//     migration included, and with nothing else: not an approval, not the
//     working tree, the index or .gitattributes; symlinks, submodules and odd
//     paths are refused anywhere;
//   - the verifier refuses: no key, a key that is not a security key (even one
//     that did sign), no verify-required, no-touch-required, cert-authority,
//     no namespace, an unlisted signer;
//   - a security key's signature (emulated in software, tests/helpers/sk.mjs):
//     a line with verify-required verifies when the signature is touched and
//     user verified (UV); without UV, without the touch, with a flag set after
//     signing, without verify-required on the line, another namespace, another
//     option or a principal that is a pattern, it is refused;
//   - the box (caja-prueba: the same code, not as root, any listed key, a
//     directory for /opt/bob) runs the committed tree and nothing of the
//     checkout (not a modified file, a skip-worktree file, a corrupt index or
//     an fsmonitor hook), with a clean environment, and moves its state only
//     after an install that ends well and only from where it stands: a new
//     unsigned migration, a replayed approval, a missing state, signers or a
//     root writable by others are refused before anything runs;
//   - the repository: no key yet (Henry adds his), CODEOWNERS over all of it,
//     the approval workflow running from main on the right events.
// Not measured here: a signature by a physical key or the Secure Enclave
// (that a person touched it), and caja as root on a box (Henry's first
// signature and install are those measurements).

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { REPO_ROOT, DB_URL } from './helpers/db.mjs'
import { skKey, UP, UV } from './helpers/sk.mjs'

const F = join(REPO_ROOT, 'scripts/firma-instalacion.sh')
const A = 'supabase/provision/aprobaciones'
const NS = 'bob-install-chain'
const run = (args, opts = {}) => spawnSync('bash', [F, ...args], { encoding: 'utf8', ...opts })
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)))

const STUB = [
  '#!/bin/sh',
  '# test stub: records where it ran, with what',
  '[ -n "$BOB_FIRMA_VERIFICADA" ] || exit 9',
  'printf "%s\\n%s\\n%s\\n%s\\n%s\\n" "$(pwd)" "$BOB_FIRMA_VERIFICADA" "${FOO-unset}" "$(cat marca.txt)" "${POSTGRES_HOST-unset}" > "$HOME/ran"',
  '[ ! -f falla ] || exit 3',
  '# cadena from the empty base: what caja handed over; then, like instalar-bob.sh,',
  '# refuse before the mark ($HOME/rehusa), or write it and fail after ($HOME/falla).',
  'printf "%s|%s|%s\\n" "${BOB_BASE_VACIA-}" "${BOB_EN_CURSO-}" "${BOB_EN_CURSO_PAR-}" > "$HOME/vacia"',
  '[ ! -f "$HOME/rehusa" ] || exit 1',
  '[ -z "${BOB_EN_CURSO-}" ] || printf "%s\\n" "$BOB_EN_CURSO_PAR" > "$BOB_EN_CURSO"',
  '[ ! -f "$HOME/falla" ] || exit 3',
  '',
].join('\n')

function repo() {
  const d = tmp('huella-')
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' }).toString().trim()
  git('init', '-q'); git('config', 'user.email', 'ci@example.com'); git('config', 'user.name', 'CI')
  const put = (p, c) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), c) }
  put('supabase/provision/bob.sql', 'select 1;\n')
  put('supabase/migrations/20250101000000_a.sql', 'select 1;\n')
  put('scripts/instalar-bob.sh', STUB)
  put('marca.txt', 'committed\n')
  const commit = (add = true) => { if (add) git('add', '-A'); git('commit', '-q', '-m', 'x', '--allow-empty'); return git('rev-parse', 'HEAD') }
  const huella = (rev = 'HEAD') => { const r = run(['huella', rev, d]); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  return { d, git, put, rm: (p) => rmSync(join(d, p), { recursive: true }), commit, huella }
}

describe('the digest', () => {
  test('moves with every file of the tree and nothing else', () => {
    const r = repo()
    const d0 = r.huella(r.commit())
    assert.match(d0, /^[0-9a-f]{64}$/)
    assert.equal(r.huella(), d0, 'deterministic')
    const same = (what) => { r.commit(); assert.equal(r.huella(), d0, what) }
    const moves = (what) => { const before = r.huella(); r.commit(); assert.notEqual(r.huella(), before, what) }
    r.put(`${A}/x.aprobacion`, 'a'); same('an approval does not change what it approves')
    r.put('supabase/migrations/29990101000000_atk.sql', 'GRANT ALL ON ALL TABLES IN SCHEMA bob TO anon;\n')
    moves('a new migration counts (sixth review)')
    r.put('README.md', 'x\n'); moves('any file counts')
    chmodSync(join(r.d, 'marca.txt'), 0o755); moves('the mode counts')
    r.rm('README.md'); moves('a removed file counts')
    rmSync(r.d, { recursive: true })
  })

  test('reads git objects only: not the working tree, the index or .gitattributes', () => {
    const r = repo(); r.put('crlf.sql', 'a\nb\n'); r.commit()
    const d0 = r.huella()
    r.put('.gitattributes', '* text eol=crlf\n'); r.git('config', 'core.autocrlf', 'true'); r.commit()
    const lista = run(['huella', 'HEAD', r.d, '--lista']).stdout
    assert.match(lista, new RegExp(`^100644 crlf\\.sql ${sha256('a\nb\n')}$`, 'm'), 'the bytes are the blob\'s, not converted')
    assert.notEqual(r.huella(), d0, '.gitattributes itself is a file of the tree')
    const d1 = r.huella()
    r.put('marca.txt', 'evil\n'); assert.equal(r.huella(), d1, 'a modified working file is not read')
    writeFileSync(join(r.d, '.git/index'), 'garbage'); assert.equal(r.huella(), d1, 'a corrupt index is not read')
    rmSync(r.d, { recursive: true })
  })

  const refused = (name, change, why) => test(name, () => {
    const r = repo(); r.commit(); r.commit(change(r) !== 'staged')
    const out = run(['huella', 'HEAD', r.d])
    assert.equal(out.status, 1, out.stdout); assert.match(out.stderr, why)
    rmSync(r.d, { recursive: true })
  })
  refused('a symlink anywhere', (r) => symlinkSync('/etc/passwd', join(r.d, 'docs-link')), /mode 120000/)
  refused('a submodule anywhere', (r) => { r.git('update-index', '--add', '--cacheinfo', `160000,${r.git('rev-parse', 'HEAD')},vendor/sub`); return 'staged' }, /mode 160000/)
  refused('a path outside [A-Za-z0-9_./-]', (r) => r.put('a b.sql', '\n'), /outside/)
})

describe('the signed text', () => {
  test('is the pair base → new, exactly', () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    assert.equal(run(['mensaje', a, b]).stdout, `bob-install-chain 1\nbase ${a}\nnueva ${b}\n`)
    assert.equal(run(['mensaje', a, 'x']).status, 1)
  })
})

const keys = tmp('llave-')
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ci', '-f', join(keys, 'k')])
const PUB = readFileSync(join(keys, 'k.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
const sign = (file) => execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', join(keys, 'k'), '-n', 'bob-install-chain', file])

describe('the verifier refuses', () => {
  const d = tmp('firma-')
  writeFileSync(join(d, 'm'), run(['mensaje', 'a'.repeat(64), 'b'.repeat(64)]).stdout); sign(join(d, 'm'))
  const sk = 'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t'
  const refused = (name, signers, why) => test(name, () => {
    writeFileSync(join(d, 'signers'), signers)
    const r = run(['verificar', join(d, 'signers'), join(d, 'm'), join(d, 'm.sig')])
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, why)
  })
  refused('a signers file with no key', '# empty\n', /holds no key/)
  refused('a key that is not a security key, even when it signed', `henry namespaces="bob-install-chain",verify-required ${PUB}\n`, /not a security key/)
  refused('a security key without verify-required', `henry namespaces="bob-install-chain" ${sk}\n`, /verify-required/)
  refused('a security key marked no-touch-required', `henry namespaces="bob-install-chain",verify-required,no-touch-required ${sk}\n`, /no-touch-required/)
  refused('a cert-authority', `henry cert-authority,namespaces="bob-install-chain",verify-required ${sk}\n`, /cert-authority/)
  refused('a security key not bound to the namespace', `henry ${sk}\n`, /namespaces/)
  refused('a signature by a key that is not listed', `henry namespaces="bob-install-chain",verify-required ${sk}\n`, /no key|does not verify|not by a security key/)
})

// A security key emulated in software (tests/helpers/sk.mjs): real sk
// signatures, with the authenticator flags the test chooses. Measured on
// OpenSSH 10.3 and 10.6p2: ssh-keygen refuses verify-required in an
// allowed_signers file, and accepts an sk signature with neither flag set, so
// the script checks both flags itself.
describe('a security key\'s signature', () => {
  const d = tmp('firma-sk-')
  const msg = run(['mensaje', 'a'.repeat(64), 'b'.repeat(64)]).stdout
  writeFileSync(join(d, 'm'), msg)
  const line = (k, opts = 'namespaces="bob-install-chain",verify-required', who = 'henry') => `${who} ${opts} ${k.line}\n`
  const check = (signers, sig) => {
    writeFileSync(join(d, 'signers'), signers); writeFileSync(join(d, 'm.sig'), sig)
    return run(['verificar', join(d, 'signers'), join(d, 'm'), join(d, 'm.sig')])
  }
  const ok = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Good "bob-install-chain" signature for henry with (ECDSA|ED25519)-SK key/) }
  const no = (r, why) => { assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, why) }
  const setFlags = (armored, flags) => {
    const b = Buffer.from(armored.split('\n').filter((l) => l && !l.startsWith('-----')).join(''), 'base64')
    b[b.length - 5] = flags
    return `-----BEGIN SSH SIGNATURE-----\n${b.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END SSH SIGNATURE-----\n`
  }

  for (const kind of ['ecdsa', 'ed25519']) {
    const k = skKey(kind)
    test(`${kind}: a line with verify-required, touched and verified, verifies`, () => ok(check(line(k), k.sign(msg))))
    test(`${kind}: touched but not verified (no PIN or biometric) is refused`, () => no(check(line(k), k.sign(msg, NS, UP)), /user verified|UV/))
    test(`${kind}: verified but not touched is refused`, () => no(check(line(k), k.sign(msg, NS, UV)), /touch|user present|UP/))
    test(`${kind}: neither flag is refused`, () => no(check(line(k), k.sign(msg, NS, 0)), /user verified|UV|touch/))
    test(`${kind}: the flags are signed: setting UV afterwards breaks the signature`, () => no(check(line(k), setFlags(k.sign(msg, NS, UP), UP | UV)), /does not verify|no key/))
    test(`${kind}: a line without verify-required is refused, even with a good signature`, () => no(check(line(k, 'namespaces="bob-install-chain"'), k.sign(msg)), /verify-required/))
  }
  const k = skKey('ecdsa')
  test('another namespace in the signature is refused', () => no(check(line(k), k.sign(msg, 'file')), /not in namespace bob-install-chain/))
  test('an option ssh-keygen would honour but BOb does not use is refused', () => no(check(line(k, 'namespaces="bob-install-chain",verify-required,valid-before="29990101"'), k.sign(msg)), /option/))
  test('a principal that is a pattern is refused', () => no(check(line(k, undefined, 'henry,*'), k.sign(msg)), /principal/))
  test('the signature must be by the key of a line with verify-required', () => {
    const other = skKey('ecdsa')
    no(check(line(k) + line(other, 'namespaces="bob-install-chain"', 'otro'), other.sign(msg)), /verify-required/)
  })
  test('an option * is refused, even with a file named verify-required where the script runs (no glob)', () => {
    writeFileSync(join(d, 'verify-required'), ''); writeFileSync(join(d, 'signers'), line(k, 'namespaces="bob-install-chain",verify-required,*')); writeFileSync(join(d, 'm.sig'), k.sign(msg))
    const r = run(['verificar', join(d, 'signers'), join(d, 'm'), join(d, 'm.sig')], { cwd: d })
    rmSync(join(d, 'verify-required'))
    no(r, /option \*/)
  })
  test('a signature whose reserved field is not empty is refused', () => no(check(line(k), k.sign(msg, NS, UP | UV, 1, 'x')), /reserved/))
  test('armored text that is not base64 says so', () => no(check(line(k), '-----BEGIN SSH SIGNATURE-----\nAAAA=\nAAA\n-----END SSH SIGNATURE-----\n'), /not base64/))
  test('a signature file that is not one armored sshsig is refused', () => {
    const s = k.sign(msg)
    no(check(line(k), s + s), /signature/)
    no(check(line(k), s.replace('SSH SIGNATURE', 'SSH SIGNATUR')), /signature/)
  })
})

describe('on a box', () => {
  // A box: <raiz> stands for /opt/bob. Its state is `prev`; the repository
  // holds an approval prev → digest, signed by the test key.
  const box = ({ prev = 'a'.repeat(64), signers = `ci namespaces="bob-install-chain" ${PUB}\n`, revocadas = '# none\n', migrador = true, cli = false } = {}) => {
    const r = repo()
    // cli: the tree pins a supabase CLI and <raiz>/bin (the box's /opt/bob/bin) has it, so cadena reaches instalar-bob.sh.
    if (cli) r.put('.github/workflows/ci.yml', 'env:\n  SUPABASE_CLI_VERSION: 9.9.9\n')
    r.commit()
    const raiz = tmp('raiz-'); chmodSync(raiz, 0o755)
    if (cli) { mkdirSync(join(raiz, 'bin'), { mode: 0o755 }); writeFileSync(join(raiz, 'bin/supabase'), '#!/bin/sh\n# test stub\necho 9.9.9\n'); chmodSync(join(raiz, 'bin/supabase'), 0o755) }
    writeFileSync(join(raiz, 'firmantes_instalacion'), signers); chmodSync(join(raiz, 'firmantes_instalacion'), 0o644)
    if (prev) { writeFileSync(join(raiz, 'instalacion-firmada'), prev + '\n'); chmodSync(join(raiz, 'instalacion-firmada'), 0o644) }
    if (migrador) {
      mkdirSync(join(raiz, 'secrets'), { mode: 0o700 })
      writeFileSync(join(raiz, 'secrets/migrador.env'), 'MIGRADOR_USUARIO=bob_migrador\nMIGRADOR_HOST=127.0.0.1\nMIGRADOR_RED=bzzz-data\n'); chmodSync(join(raiz, 'secrets/migrador.env'), 0o600)
    }
    if (revocadas !== null) { writeFileSync(join(raiz, 'aprobaciones-revocadas'), revocadas); chmodSync(join(raiz, 'aprobaciones-revocadas'), 0o644) }
    const approve = (base, nueva = r.huella()) => {
      const a = `${A}/${base}-${nueva}.aprobacion`
      r.put(a, run(['mensaje', base, nueva]).stdout); sign(join(r.d, a)); return r.commit()
    }
    const caja = (commit = r.git('rev-parse', 'HEAD'), { env = {}, args = [], input = 'instalo\n', step = 'resto' } = {}) => {
      rmSync(join(raiz, 'ran'), { force: true })
      const out = run(['caja-prueba', raiz, r.d, commit, step, ...args], { env: { ...process.env, FOO: '1', POSTGRES_HOST: 'from-env', ...env }, input })
      const ran = existsSync(join(raiz, 'ran')) ? readFileSync(join(raiz, 'ran'), 'utf8').split('\n') : null
      return { out, ran, state: existsSync(join(raiz, 'instalacion-firmada')) ? readFileSync(join(raiz, 'instalacion-firmada'), 'utf8').trim() : null }
    }
    const done = () => { rmSync(r.d, { recursive: true }); rmSync(raiz, { recursive: true }) }
    return { r, raiz, approve, caja, done }
  }
  const refusedBefore = (res, why) => {
    assert.equal(res.out.status, 1, res.out.stdout + res.out.stderr); assert.match(res.out.stderr, why)
    assert.equal(res.ran, null, 'nothing ran')
  }

  test('runs the signed tree from a directory of its own, with a clean environment, then moves its state', () => {
    const b = box(); const d = b.r.huella(); b.approve('a'.repeat(64))
    const res = b.caja()
    assert.equal(res.out.status, 0, res.out.stdout + res.out.stderr)
    assert.ok(res.ran[0].startsWith(join(b.raiz, 'trabajo.')), `ran from ${res.ran[0]}, not from the checkout`)
    assert.equal(res.ran[1], d); assert.equal(res.ran[2], 'unset', 'the caller\'s environment does not reach it'); assert.equal(res.ran[3], 'committed')
    assert.equal(res.ran[4], 'unset', 'a connection setting in the environment does not reach it either')
    assert.match(res.out.stdout, new RegExp(`commit +${b.r.git('rev-parse', 'HEAD')}\\nbase +a{64} \\(this box\\)\\nnueva +${d}`), 'Henry sees the commit and the pair')
    assert.equal(res.state, d, 'the box now stands at the new digest')
    assert.deepEqual(readdirSync(b.raiz).filter((f) => f.startsWith('trabajo.')), [], 'the directory is removed')
    const again = b.caja(); assert.equal(again.out.status, 0, again.out.stderr); assert.equal(again.state, d, 'running it again is accepted')
    b.done()
  })

  test('a new migration with no new approval is refused (sixth review)', () => {
    const b = box(); const d = b.r.huella(); b.approve('a'.repeat(64))
    assert.equal(b.caja().state, d)
    b.r.put('supabase/migrations/29990101000000_atk.sql', 'GRANT ALL ON ALL TABLES IN SCHEMA bob TO anon;\n'); b.r.commit()
    const res = b.caja(); refusedBefore(res, /no approval from/); assert.equal(res.state, d)
    b.done()
  })

  test('nothing of the checkout runs: a modified file, skip-worktree, a corrupt index, an fsmonitor hook', () => {
    const b = box(); const c = b.approve('a'.repeat(64))
    b.r.put('marca.txt', 'evil\n')
    b.r.put('scripts/instalar-bob.sh', '#!/bin/sh\necho evil > "$HOME/ran"\n')
    b.r.git('update-index', '--skip-worktree', 'scripts/instalar-bob.sh')
    writeFileSync(join(b.r.d, 'hook.sh'), `#!/bin/sh\ntouch ${join(b.raiz, 'fsmonitor-ran')}\n`); chmodSync(join(b.r.d, 'hook.sh'), 0o755)
    b.r.git('config', 'core.fsmonitor', join(b.r.d, 'hook.sh'))
    writeFileSync(join(b.r.d, '.git/index'), 'garbage')
    const res = b.caja(c)
    assert.equal(res.out.status, 0, res.out.stdout + res.out.stderr)
    assert.equal(res.ran[3], 'committed', 'the committed tree ran')
    assert.equal(existsSync(join(b.raiz, 'fsmonitor-ran')), false, 'the fsmonitor hook never ran')
    b.done()
  })

  test('a failed install leaves the state where it was', () => {
    const b = box(); b.r.put('falla', '1'); b.r.commit(); b.approve('a'.repeat(64))
    const res = b.caja()
    assert.equal(res.out.status, 1); assert.match(res.out.stderr, /stays at a{64}/); assert.equal(res.state, 'a'.repeat(64))
    b.done()
  })

  test('an approval from another state is refused (replay)', () => {
    const b = box({ prev: 'c'.repeat(64) }); b.approve('a'.repeat(64))
    const res = b.caja(); refusedBefore(res, /no approval from c{64}/); assert.equal(res.state, 'c'.repeat(64))
    b.done()
  })

  test('an approval whose text is not its pair is refused', () => {
    const b = box(); const d = b.r.huella()
    const a = `${A}/${'a'.repeat(64)}-${d}.aprobacion`
    b.r.put(a, run(['mensaje', 'b'.repeat(64), d]).stdout); sign(join(b.r.d, a)); b.r.commit()
    refusedBefore(b.caja(), /is not the text of/)
    b.done()
  })

  test('a signature by a key that is not listed is refused', () => {
    const b = box({ signers: `ci namespaces="bob-install-chain" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq5k0Bz3VnFz7Xb1pZtXv9P3k5Q2wTn3hQyJ0c8bQ7d\n` })
    b.approve('a'.repeat(64)); refusedBefore(b.caja(), /no key|does not verify/)
    b.done()
  })

  test('no state file: refused, Henry writes it first', () => {
    const b = box({ prev: null }); b.approve('a'.repeat(64)); refusedBefore(b.caja(), /instalacion-firmada does not exist/); b.done()
  })
  test('signers writable by others: refused', () => {
    const b = box(); b.approve('a'.repeat(64)); chmodSync(join(b.raiz, 'firmantes_instalacion'), 0o664)
    refusedBefore(b.caja(), /writable by others/); b.done()
  })
  test('a root directory writable by others: refused', () => {
    const b = box(); b.approve('a'.repeat(64)); chmodSync(b.raiz, 0o777)
    refusedBefore(b.caja(), /writable by others/); b.done()
  })
  test('connection settings go as arguments, each checked', () => {
    const b = box(); b.approve('a'.repeat(64))
    refusedBefore(b.caja(undefined, { args: ['POSTGRES_HOST=db.example.com'] }), /not loopback nor in .*hosts-permitidos/)
    writeFileSync(join(b.raiz, 'hosts-permitidos'), '# the database container\ndb.example.com\n'); chmodSync(join(b.raiz, 'hosts-permitidos'), 0o644)
    const okr = b.caja(undefined, { args: ['POSTGRES_HOST=db.example.com'] })
    assert.equal(okr.out.status, 0, okr.out.stderr); assert.equal(okr.ran[4], 'db.example.com')
    const shown = okr.out.stdout.split('== Again:')
    assert.equal(shown.length, 2, 'the commit and the pair are shown again after the log')
    for (const part of shown) {
      assert.match(part, /settings +POSTGRES_HOST=db\.example\.com/, 'Henry sees the settings')
      assert.match(part, /sends passwords to postgres@db\.example\.com:5432/)
    }
    chmodSync(join(b.raiz, 'hosts-permitidos'), 0o666)
    refusedBefore(b.caja(undefined, { args: ['POSTGRES_HOST=db.example.com'] }), /writable by others/)
    refusedBefore(b.caja(undefined, { args: ['POSTGRES_HOST=x;touch /tmp/p'] }), /POSTGRES_HOST refused/)
    refusedBefore(b.caja(undefined, { args: ['POSTGRES_HOST=-oProxyCommand'] }), /POSTGRES_HOST refused/)
    refusedBefore(b.caja(undefined, { args: ['BASH_ENV=/tmp/x'] }), /unknown setting/)
    const env = join(b.raiz, 'pg.env'); writeFileSync(env, 'POSTGRES_PASSWORD=x\n'); chmodSync(env, 0o666)
    refusedBefore(b.caja(undefined, { args: [`POSTGRES_ENV=${env}`] }), /writable by others/)
    chmodSync(env, 0o644)
    refusedBefore(b.caja(undefined, { args: [`POSTGRES_ENV=${env}`] }), /readable by a group or others/)
    chmodSync(join(b.raiz, 'secrets/migrador.env'), 0o640)
    refusedBefore(b.caja(), /readable by a group or others/)
    b.done()
  })
  test('not confirmed with «instalo»: nothing runs', () => {
    const b = box(); b.approve('a'.repeat(64))
    const res = b.caja(undefined, { input: 'yes\n' }); refusedBefore(res, /not confirmed/); assert.equal(res.state, 'a'.repeat(64))
    b.done()
  })
  test('a revoked digest or pair: refused', () => {
    const b1 = box(); const d1 = b1.r.huella(); b1.approve('a'.repeat(64))
    writeFileSync(join(b1.raiz, 'aprobaciones-revocadas'), `${d1}  # PR rejected\n`)
    refusedBefore(b1.caja(), /revoked/); b1.done()
    const b2 = box(); const d2 = b2.r.huella(); b2.approve('a'.repeat(64))
    writeFileSync(join(b2.raiz, 'aprobaciones-revocadas'), `${'a'.repeat(64)}-${d2}\n`)
    refusedBefore(b2.caja(), /revoked/); b2.done()
  })
  test('resto with no migrador file: refused; the screen shows MIGRADOR_RED', () => {
    const b = box(); b.approve('a'.repeat(64))
    const res = b.caja(); assert.equal(res.out.status, 0, res.out.stderr)
    assert.match(res.out.stdout, / bob_migrador@127\.0\.0\.1:5432 \(from .*MIGRADOR_RED=bzzz-data\)/)
    b.done()
    const c = box({ migrador: false }); c.approve('a'.repeat(64)); refusedBefore(c.caja(), /migrador\.env does not exist/); c.done()
  })
  test('no revocation list: refused, Henry makes it (empty) first', () => {
    const b = box({ revocadas: null }); b.approve('a'.repeat(64)); refusedBefore(b.caja(), /aprobaciones-revocadas does not exist/); b.done()
  })
  test('an approval kept on the box, outside the tree, is accepted; one writable by others is not', () => {
    const b = box(); const d = b.r.huella()
    const dir = join(b.raiz, 'aprobaciones'); mkdirSync(dir, { mode: 0o755 })
    const a = join(dir, `${'a'.repeat(64)}-${d}.aprobacion`)
    writeFileSync(a, run(['mensaje', 'a'.repeat(64), d]).stdout); sign(a); chmodSync(a, 0o644); chmodSync(a + '.sig', 0o644)
    const res = b.caja(); assert.equal(res.out.status, 0, res.out.stderr); assert.match(res.out.stdout, /approval in .*aprobaciones/)
    writeFileSync(join(b.raiz, 'instalacion-firmada'), 'a'.repeat(64) + '\n')
    chmodSync(a, 0o666); refusedBefore(b.caja(), /writable by others/)
    b.done()
  })
  // The empty base (Henry, «Defined empty base»): a box with no BOb stands at
  // VACIA, and its first install is signed from it. Only cadena runs from it,
  // and instalar-bob.sh checks the database (tests/install-empty-base.test.mjs).
  const VACIA = createHash('sha256').update('').digest('hex')
  test('the empty base is sha256 of nothing, and no tree has it', () => {
    assert.equal(run(['vacia']).stdout.trim(), VACIA)
    const r = repo(); r.commit(); assert.notEqual(r.huella(), VACIA); rmSync(r.d, { recursive: true })
  })
  test('from the empty base, resto is refused before anything runs', () => {
    const b = box({ prev: VACIA }); b.approve(VACIA)
    refusedBefore(b.caja(undefined, { step: 'resto' }), /empty base.*cadena/); b.done()
  })
  test('from the empty base, cadena passes the signature check with an approval from it', () => {
    const b = box({ prev: VACIA }); b.approve(VACIA)
    const res = b.caja(undefined, { step: 'cadena' })
    // caja-prueba has no supabase CLI on its fixed PATH: it stops at the pin, after the approval.
    refusedBefore(res, /supabase CLI/); b.done()
  })
  test('a box records the pair it reached its state with', () => {
    const b = box(); const d = b.r.huella(); b.approve('a'.repeat(64))
    assert.equal(b.caja().out.status, 0)
    assert.equal(readFileSync(join(b.raiz, 'instalacion-aprobacion'), 'utf8').trim(), `${'a'.repeat(64)}-${d}`); b.done()
  })
  // Review of #54, (1): with the empty base, every version has its VACIA-d.
  // Running d again accepts only the pair the box reached d with, so a box
  // whose state is written as d by hand does not install, whatever the order.
  for (const x of ['f'.repeat(64), '1'.repeat(64)]) {
    test(`a box at ${x[0]}…: d written by hand into the state does not install, with X-d revoked and VACIA-d present`, () => {
      const b = box({ prev: x }); const d = b.r.huella()
      b.approve(VACIA); b.approve(x)
      writeFileSync(join(b.raiz, 'aprobaciones-revocadas'), `${x}-${d}\n`)
      refusedBefore(b.caja(), /revoked/)
      writeFileSync(join(b.raiz, 'instalacion-firmada'), d + '\n')
      // No record: only d → d would run it, and Henry signed none.
      refusedBefore(b.caja(), /no approval from/)
      writeFileSync(join(b.raiz, 'instalacion-aprobacion'), `${x}-${'0'.repeat(64)}\n`); chmodSync(join(b.raiz, 'instalacion-aprobacion'), 0o644)
      refusedBefore(b.caja(), /does not end at/)
      b.done()
    })
  }
  test('running d again verifies the recorded pair again: revoked since, it is refused', () => {
    const b = box(); const d = b.r.huella(); b.approve('a'.repeat(64))
    assert.equal(b.caja().out.status, 0)
    writeFileSync(join(b.raiz, 'aprobaciones-revocadas'), `${'a'.repeat(64)}-${d}\n`)
    refusedBefore(b.caja(), /revoked/); b.done()
  })
  // Re-review of #54: instalacion-en-curso is instalar-bob.sh's (BOB_EN_CURSO),
  // written only after its check passed; caja never writes it, and binds it
  // to VACIA-<digest>. These reach instalar-bob.sh on cadena (the tree's stub,
  // which writes the mark where the real one does: after the check).
  const st = (b, f) => existsSync(join(b.raiz, f)) ? readFileSync(join(b.raiz, f), 'utf8').trim() : null
  const put = (b, f, c) => { writeFileSync(join(b.raiz, f), c + '\n'); chmodSync(join(b.raiz, f), 0o644) }
  test('cadena from the empty base reaches instalar-bob.sh with the mark it may write: VACIA-<digest>, fresh', () => {
    const b = box({ prev: VACIA, cli: true }); const d = b.r.huella(); b.approve(VACIA)
    const res = b.caja(undefined, { step: 'cadena' })
    assert.equal(res.out.status, 0, res.out.stdout + res.out.stderr)
    assert.equal(st(b, 'vacia'), `1|${join(b.raiz, 'instalacion-en-curso')}|${VACIA}-${d}`)
    assert.equal(res.state, d); assert.equal(st(b, 'instalacion-aprobacion'), `${VACIA}-${d}`)
    assert.equal(st(b, 'instalacion-en-curso'), null, 'the mark is removed once the state moved'); b.done()
  })
  test('a check that refuses (or a database that cannot be reached) leaves no mark: the next run checks fresh again', () => {
    const b = box({ prev: VACIA, cli: true }); b.approve(VACIA); put(b, 'rehusa', 'x')
    for (const _ of [1, 2]) {
      const res = b.caja(undefined, { step: 'cadena' })
      assert.equal(res.out.status, 1); assert.match(res.out.stderr, /cadena failed/)
      assert.equal(st(b, 'vacia').split('|')[0], '1', 'fresh, not reanuda')
      assert.equal(st(b, 'instalacion-en-curso'), null, 'caja wrote no mark'); assert.equal(res.state, VACIA)
    }
    b.done()
  })
  test('a cadena that fails after the check passed is retried as reanuda, to the same digest, and ends well', () => {
    const b = box({ prev: VACIA, cli: true }); const d = b.r.huella(); b.approve(VACIA); put(b, 'falla', 'x')
    assert.equal(b.caja(undefined, { step: 'cadena' }).out.status, 1)
    assert.equal(st(b, 'instalacion-en-curso'), `${VACIA}-${d}`); assert.equal(st(b, 'instalacion-firmada'), VACIA)
    assert.equal(b.caja(undefined, { step: 'cadena' }).out.status, 1); assert.equal(st(b, 'vacia').split('|')[0], 'reanuda')
    rmSync(join(b.raiz, 'falla'))
    const ok = b.caja(undefined, { step: 'cadena' }); assert.equal(ok.out.status, 0, ok.out.stderr)
    assert.equal(st(b, 'vacia').split('|')[0], 'reanuda'); assert.equal(ok.state, d); assert.equal(st(b, 'instalacion-en-curso'), null); b.done()
  })
  test('a mark for another digest: refused before anything runs (a retry installs the same commit)', () => {
    const b = box({ prev: VACIA, cli: true }); b.approve(VACIA); put(b, 'instalacion-en-curso', `${VACIA}-${'b'.repeat(64)}`)
    refusedBefore(b.caja(undefined, { step: 'cadena' }), /not a cadena from the empty base to [0-9a-f]{64}/); b.done()
  })
  test('a mark that is not a cadena from the empty base: refused', () => {
    const b = box({ prev: VACIA }); b.approve(VACIA); put(b, 'instalacion-en-curso', `${'a'.repeat(64)}-${'b'.repeat(64)}`)
    refusedBefore(b.caja(undefined, { step: 'cadena' }), /not a cadena from the empty base/); b.done()
  })
  test('a mark on a box that is not at the empty base, and that is not a finished cadena to it: refused', () => {
    const b = box(); b.approve('a'.repeat(64)); put(b, 'instalacion-en-curso', `${VACIA}-${'b'.repeat(64)}`)
    refusedBefore(b.caja(), /en-curso exists, but this box is not at the empty base/); b.done()
  })
  test('a crash between moving the state and removing the mark does not leave the box stuck', () => {
    const b = box({ prev: VACIA, cli: true }); const d = b.r.huella(); b.approve(VACIA)
    put(b, 'instalacion-firmada', d); put(b, 'instalacion-aprobacion', `${VACIA}-${d}`); put(b, 'instalacion-en-curso', `${VACIA}-${d}`)
    const res = b.caja()
    assert.equal(res.out.status, 0, res.out.stdout + res.out.stderr); assert.match(res.out.stdout, /ended well: removing/)
    assert.equal(st(b, 'instalacion-en-curso'), null); assert.equal(res.state, d)
    // A crash one step earlier (the record written, the state not): still at the empty base, retried as reanuda.
    const c = box({ prev: VACIA, cli: true }); const e = c.r.huella(); c.approve(VACIA)
    put(c, 'instalacion-aprobacion', `${VACIA}-${e}`); put(c, 'instalacion-en-curso', `${VACIA}-${e}`)
    assert.equal(c.caja(undefined, { step: 'cadena' }).out.status, 0); assert.equal(st(c, 'vacia').split('|')[0], 'reanuda')
    b.done(); c.done()
  })
  // Fix 3: a box that stands at d with no record (it was installed before
  // instalacion-aprobacion existed, say lab-02 doing resto) runs d again only
  // with an approval d → d that Henry signed; nothing written by hand.
  test('a box at d with no record: an approval d → d runs it again, and is recorded', () => {
    const b = box(); const d = b.r.huella(); put(b, 'instalacion-firmada', d)
    const none = b.caja(); refusedBefore(none, /no approval from/); assert.match(none.out.stdout, /no record .*only an approval [0-9a-f]{64} → [0-9a-f]{64} runs it again/)
    b.approve('a'.repeat(64)); refusedBefore(b.caja(), /no approval from/)
    b.approve(d)
    const res = b.caja(); assert.equal(res.out.status, 0, res.out.stdout + res.out.stderr)
    assert.equal(st(b, 'instalacion-aprobacion'), `${d}-${d}`); b.done()
  })
  test('a commit that is not a full sha: refused', () => {
    const b = box(); b.approve('a'.repeat(64)); refusedBefore(b.caja('HEAD'), /full sha/); b.done()
  })
  test('a program not root\'s along its whole path: refused', () => {
    const d = tmp('prog-'); writeFileSync(join(d, 'psql'), '#!/bin/sh\n'); chmodSync(join(d, 'psql'), 0o755)
    const r = run(['herramienta', join(d, 'psql')]); assert.equal(r.status, 1); assert.match(r.stderr, /not owned by uid 0/)
    assert.equal(run(['herramienta', '/bin/sh']).status, 0, 'a system program is accepted')
    const dr = run(['herramienta', d]); assert.equal(dr.status, 1, 'a directory on the PATH not root\'s is refused')
    // Whether this machine's /usr/bin passes is the machine's business (GitHub's
    // runner links tools it does not let root own); say it, do not assert it.
    const sys = run(['herramienta', '/usr/bin']); console.log(`# herramienta /usr/bin here: ${(sys.stdout + sys.stderr).trim()}`)
    assert.ok([0, 1].includes(sys.status), `the check ends cleanly (exit ${sys.status})`)
    rmSync(d, { recursive: true })
  })
  test('caja proper needs root', () => {
    const r = run(['caja', '/x', '0'.repeat(40), 'resto'])
    assert.equal(r.status, 1); assert.match(r.stderr, /run as root/)
  })
})

describe('the repository', () => {
  test('the signers file holds no key until Henry adds his, and only security keys with verify-required', () => {
    const lines = readFileSync(join(REPO_ROOT, 'supabase/provision/firmantes_instalacion'), 'utf8')
      .split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
    for (const l of lines) assert.match(l, /^\S+ namespaces="bob-install-chain",verify-required sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com \S+/, l)
  })
  test('the digest of this commit is computable, and CODEOWNERS covers all of it', () => {
    const r = run(['huella', 'HEAD', REPO_ROOT, '--lista'])
    assert.equal(r.status, 0, r.stderr)
    for (const p of ['scripts/instalar-bob.sh', 'scripts/firma-instalacion.sh', 'supabase/config.toml', 'package.json', 'supabase/migrations/']) {
      assert.ok(r.stdout.includes(` ${p}`), `${p} is not covered`)
    }
    assert.match(readFileSync(join(REPO_ROOT, '.github/CODEOWNERS'), 'utf8'), /^\*\s+@hdgarzon$/m)
  })
  test('the signature workflow is informative: it runs from main, never checks out the PR, never fails', () => {
    const w = readFileSync(join(REPO_ROOT, '.github/workflows/install-approval.yml'), 'utf8')
    assert.match(w, /^on:\n {2}pull_request_target:\n {4}types: \[opened, synchronize, reopened, edited\]/m)
    assert.match(w, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/)
    assert.match(w, /name: Install signature, informative \(O-3\)/)
    assert.doesNotMatch(w, /exit 1/)
    assert.doesNotMatch(w, /pull_request\.head\.(ref|repo)|github\.head_ref|actions\/setup-node|pnpm|npm /)
    assert.match(w, /permissions:\n {2}contents: read\n {2}pull-requests: read\n\n/)
    assert.match(w, /f=scripts\/firma-instalacion\.sh\n/)
    assert.match(w, /aprobaciones\/\$base-\$new\.aprobacion/)
    assert.match(w, /"\$f" verificar supabase\/provision\/firmantes_instalacion /)
  })
})

// The empty base (Henry, «Defined empty base»; scripts/firma-instalacion.sh
// VACIA): a box where BOb was never installed holds it, and caja runs cadena
// from it with BOB_BASE_VACIA=1 (or =reanuda, the retry of a cadena that did
// not end well). instalar-bob.sh must then refuse a database with any trace of
// BOb, so a box with the chain applied cannot claim the empty base and skip
// the review of where it stands.
//
// This runs instalar-bob.sh cadena against the suite's database (the whole
// chain applied) and against scratch databases made here and dropped after.
// Nothing is pushed: `supabase` on PATH is a stub that only records it was
// reached. GITHUB_ACTIONS=true and INSTALAR_SIN_FIRMA=ci are set so the script
// runs outside a signed tree, as in CI's own job; on that path only,
// INSTALAR_PRUEBA_DB points the checks at a scratch database.
// Roles are the cluster's, not a database's: the suite's cluster has BOb's
// roles, so a fresh check here always finds them. Not measured here: a fresh
// check that passes, on a cluster with no BOb at all (the first install from
// the empty base is that measurement).
describe('the empty base, against the database', () => {
  const url = new URL(DB_URL)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'base-vacia-')))
  writeFileSync(join(dir, 'postgres.env'), `POSTGRES_PASSWORD=${decodeURIComponent(url.password)}\n`); chmodSync(join(dir, 'postgres.env'), 0o600)
  const bin = join(dir, 'bin'); mkdirSync(bin)
  // Test stub for the supabase CLI: records that cadena reached the push.
  writeFileSync(join(bin, 'supabase'), `#!/bin/sh\n# test stub, never the real CLI\necho "$*" > "${join(dir, 'pushed')}"\n`); chmodSync(join(bin, 'supabase'), 0o755)

  const versions = readdirSync(join(REPO_ROOT, 'supabase/migrations')).map((f) => f.match(/^(\d{14})_.*\.sql$/)?.[1]).filter(Boolean)
  const chain = readFileSync(join(REPO_ROOT, 'supabase/provision/install-chain.sha256'), 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/)[1].slice(0, 14))
  const afterChain = versions.find((v) => !chain.includes(v))

  const cadena = (env) => {
    spawnSync('rm', ['-f', join(dir, 'pushed')])
    const r = spawnSync('bash', [join(REPO_ROOT, 'scripts/instalar-bob.sh'), 'cadena'], {
      cwd: REPO_ROOT, encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: dir, LANG: 'C',
        INSTALAR_SIN_FIRMA: 'ci', GITHUB_ACTIONS: 'true', SUDO: '',
        POSTGRES_ENV: join(dir, 'postgres.env'), POSTGRES_HOST: url.hostname, POSTGRES_PORT: url.port || '5432',
        // instalar-bob.sh writes its pgpass on tmpfs: /dev/shm on Linux; a private directory on macOS.
        ...(process.platform === 'linux' ? {} : { XDG_RUNTIME_DIR: dir }),
        ...env,
      },
    })
    return { ...r, pushed: existsSync(join(dir, 'pushed')) }
  }
  const refused = (r, ...why) => {
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /claims the empty base .*but its database already holds BOb/)
    for (const w of why) assert.match(r.stderr, w)
    assert.equal(r.pushed, false, 'nothing was pushed')
  }
  const passed = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); assert.ok(r.pushed, 'cadena reached the push') }

  // A scratch database, as postgres: dropped when the file ends.
  const admin = new pg.Client({ connectionString: DB_URL })
  const made = []
  async function scratch(sql = '') {
    const name = `bob_vacia_${process.pid}_${made.length}`
    await admin.query(`CREATE DATABASE ${name}`); made.push(name)
    const u = new URL(DB_URL); u.pathname = `/${name}`
    const c = new pg.Client({ connectionString: u.toString() }); await c.connect()
    if (sql) await c.query(sql)
    await c.end()
    return name
  }
  const history = (...vs) => `CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY);
    INSERT INTO supabase_migrations.schema_migrations VALUES ${vs.map((v) => `('${v}')`).join(', ')};`
  let role = null
  after(async () => {
    for (const n of made) await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`).catch((e) => console.error(`could not drop ${n}: ${e.message}`))
    if (role) await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  })
  before(() => admin.connect())

  test('control: without the empty base, the harness reaches the push', () => passed(cadena({})))

  test('the suite\'s database, the chain applied: refused before the push, with what it found', () => {
    refused(cadena({ BOB_BASE_VACIA: '1' }), /role bob_app/, /schema bob/, /By kind: .*\b[1-9][0-9]* history\b/, /[1-9][0-9]* function/)
  })

  test('an empty database finds only the cluster\'s roles: nothing in the database itself', async () => {
    const r = cadena({ BOB_BASE_VACIA: '1', INSTALAR_PRUEBA_DB: await scratch() })
    refused(r, /role bob_app/)
    const found = r.stderr.split('\n').filter((l) => l.startsWith('  '))
    assert.ok(found.every((l) => l.startsWith('  role ')), found.join('\n'))
  })

  test('schema bob renamed and the history emptied: still found, by the names BOb creates', async () => {
    const db = await scratch(`CREATE SCHEMA bob_v1; CREATE TABLE bob_v1.proj_metric_counts (x int); CREATE TABLE bob_v1.actors (x int);
      CREATE FUNCTION public.custom_access_token_hook(e jsonb) RETURNS jsonb LANGUAGE sql AS 'SELECT e'; ${history()}`.replace('VALUES ;', 'SELECT 1 WHERE false;'))
    refused(cadena({ BOB_BASE_VACIA: '1', INSTALAR_PRUEBA_DB: db }), /relation bob_v1\.proj_metric_counts/, /relation bob_v1\.actors/, /function public\.custom_access_token_hook/)
  })

  test('a retry after a partial cadena: what the chain leaves is accepted', async () => {
    const db = await scratch(`CREATE SCHEMA bob; CREATE TABLE bob.actors (x int); ${history(chain[0], chain[1])}`)
    passed(cadena({ BOB_BASE_VACIA: 'reanuda', INSTALAR_PRUEBA_DB: db }))
  })

  // The mark (BOB_EN_CURSO) is written after the check passes, and only then.
  const mark = join(dir, 'raiz', 'instalacion-en-curso'); mkdirSync(join(dir, 'raiz'))
  const par = `${createHash('sha256').update('').digest('hex')}-${'d'.repeat(64)}`
  const marked = () => existsSync(mark) ? readFileSync(mark, 'utf8').trim() : null
  test('the mark: written once the check passed, with exactly the pair caja gave', async () => {
    rmSync(mark, { force: true })
    const db = await scratch(`CREATE SCHEMA bob; CREATE TABLE bob.actors (x int); ${history(chain[0])}`)
    passed(cadena({ BOB_BASE_VACIA: 'reanuda', INSTALAR_PRUEBA_DB: db, BOB_EN_CURSO: mark, BOB_EN_CURSO_PAR: par }))
    assert.equal(marked(), par)
  })
  test('the mark: not written when the check refuses', () => {
    rmSync(mark, { force: true })
    refused(cadena({ BOB_BASE_VACIA: '1', BOB_EN_CURSO: mark, BOB_EN_CURSO_PAR: par }))
    assert.equal(marked(), null)
  })
  test('the mark: a path or pair that is not caja\'s is refused before the push', async () => {
    const db = await scratch(history(chain[0]))
    for (const [p, v] of [[join(dir, 'raiz', 'otro'), par], [mark, `${'a'.repeat(64)}`], [mark, `${par}\nx`]]) {
      rmSync(mark, { force: true })
      const r = cadena({ BOB_BASE_VACIA: 'reanuda', INSTALAR_PRUEBA_DB: db, BOB_EN_CURSO: p, BOB_EN_CURSO_PAR: v })
      assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /not caja's/); assert.equal(r.pushed, false); assert.equal(marked(), null)
    }
  })
  test('names a migration gives by RENAME TO, and BOb\'s indexes, are found too', async () => {
    const db = await scratch(`CREATE SCHEMA otro; CREATE TABLE otro.autobotz (x int); CREATE TABLE public.vecina (x int);
      CREATE INDEX idx_ab_due ON public.vecina (x); ${history()}`.replace('VALUES ;', 'SELECT 1 WHERE false;'))
    refused(cadena({ BOB_BASE_VACIA: '1', INSTALAR_PRUEBA_DB: db }), /relation otro\.autobotz/, /relation public\.idx_ab_due/)
  })

  test('a retry with a migration after the chain in the history: refused', async () => {
    const db = await scratch(history(chain[0], afterChain))
    refused(cadena({ BOB_BASE_VACIA: 'reanuda', INSTALAR_PRUEBA_DB: db }), new RegExp(`history outside the install chain ${afterChain}`))
  })

  test('a retry where resto ran: refused', async () => {
    const db = await scratch(`CREATE SCHEMA bob; CREATE TABLE bob.schema_migrations (version text);`)
    refused(cadena({ BOB_BASE_VACIA: 'reanuda', INSTALAR_PRUEBA_DB: db }), /resto ran/)
  })

  test('a retry with a bob_* role that can log in (an old credential): refused', async () => {
    role = `bob_prueba_${process.pid}`
    await admin.query(`CREATE ROLE ${role} LOGIN`)
    refused(cadena({ BOB_BASE_VACIA: 'reanuda', INSTALAR_PRUEBA_DB: await scratch() }), new RegExp(`role that can log in ${role}`))
    await admin.query(`DROP ROLE ${role}`); role = null
  })
})
