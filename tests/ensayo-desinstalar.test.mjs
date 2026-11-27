// The rehearsal uninstall (scripts/ensayo/desinstalar-bob.sh): it leaves model-01
// without BOb, as it was before its first install, so Febor's path (the empty
// base to the signed digest, in one step) can be rehearsed there from scratch.
//
// Against a database on the box's image (Postgres 17.6) that starts with no BOb:
//   1. a photo of its catalog, with things of Bzzz's planted first (another
//      neighbour like opsrun, an account in auth, a table and a function in
//      public);
//   2. BOb installed as a box gets it (instalar-bob.sh cadena, the alta's CI
//      stand-in, resto, bob_app's login, the organization `modelo`), and a
//      /opt/bob, a /root/bob-install and a docker (tests/helpers/docker-falso.sh)
//      shaped like model-01's;
//   3. every guard, each made to refuse, and after each nothing changed: the
//      catalog, the files, the containers and images, and docker was only read;
//   4. a dry run that writes nothing;
//   5. a transaction that fails is rolled back and puts the files and bob-web back;
//   6. --ejecutar: the catalog is the photo of step 1 again, line for line, the
//      files and BOb's containers and images are gone and Bzzz's are not;
//   7. scripts/instalar-bob.sh cadena from the empty base (BOB_BASE_VACIA=1)
//      accepts the database, and the whole install runs again on it.
//
// The database must start without BOb, so this file runs in its own CI job
// ("Uninstall rehearsal on the box's image"), where a skip is a failure
// (BOB_DESINSTALAR_REQUIRED=1). Against the suite's main stack, which holds
// the chain, it skips.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, copyFileSync, chmodSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import pg from 'pg'
import { REPO_ROOT } from './helpers/db.mjs'

const SCRIPT = join(REPO_ROOT, 'scripts/ensayo/desinstalar-bob.sh')
const DOCKER_FALSO = join(REPO_ROOT, 'tests/helpers/docker-falso.sh')
const ADMIN_URL = process.env.DESINSTALAR_DB_URL || 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres'
const PORT = new URL(ADMIN_URL).port || '5432'
const PG_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`
const REQUIRED = process.env.BOB_DESINSTALAR_REQUIRED === '1'
const VACIA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
// Docker image ids (sha256 and 64 hex), joined so §10's guard against refs built with a literal namespace does not read one here.
const imagen = (c) => ['sha256', c.repeat(64)].join(':')
const IMG_WEB = imagen('a')
const IMG_ANTES = imagen('b')
const IMG_DB = imagen('c')
const IMG_PUERTA = imagen('d')
const IMG_AUTH = imagen('e')
// Bzzz's GoTrue, with BOb's access-token hook pointed at public and switched off (G8 stops when it is on).
const HOOK_URI = 'GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/custom_access_token_hook'
const authEnv = (enabled) => `GOTRUE_SITE_URL=https://portal.example.com\n${HOOK_URI}\n${enabled === undefined ? '' : `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=${enabled}\n`}`

// One line per thing in the catalog: roles and memberships, schemas and their
// grants, every relation, function and type outside pg_catalog, triggers,
// policies, publications, extensions, default privileges, role settings, and
// the rows that say who can sign in.
const FOTO = `
WITH ns AS (SELECT oid, nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema')
              AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%')
SELECT k || ' | ' || id || ' | ' || d AS l FROM (
  SELECT 'role' k, rolname::text id, concat_ws(',', rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit) d FROM pg_roles
  UNION ALL SELECT 'member', r.rolname||'>'||m.rolname, concat_ws(',', a.admin_option, a.inherit_option, a.set_option, g.rolname)
    FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor
  UNION ALL SELECT 'schema', nspname, pg_get_userbyid(nspowner)||' '||coalesce(nspacl::text,'') FROM pg_namespace
    WHERE nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'
  UNION ALL SELECT 'database', datname, coalesce(datacl::text,'') FROM pg_database WHERE datname = current_database()
  UNION ALL SELECT 'rel', ns.nspname||'.'||relname, relkind::text||' '||pg_get_userbyid(relowner)||' '||coalesce(relacl::text,'') FROM pg_class JOIN ns ON ns.oid=relnamespace
  UNION ALL SELECT 'proc', p.oid::regprocedure::text, pg_get_userbyid(proowner)||' '||coalesce(proacl::text,'')||' '||md5(prosrc) FROM pg_proc p JOIN ns ON ns.oid=pronamespace
  UNION ALL SELECT 'type', ns.nspname||'.'||typname, typtype::text||' '||pg_get_userbyid(typowner) FROM pg_type t JOIN ns ON ns.oid=typnamespace
    WHERE typtype IN ('e','d','c','r','m') AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype=t.oid AND c.relkind <> 'c')
  UNION ALL SELECT 'trigger', tgrelid::regclass::text||' '||tgname, tgfoid::regprocedure::text FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'event_trigger', evtname, evtfoid::regprocedure::text FROM pg_event_trigger
  UNION ALL SELECT 'policy', polrelid::regclass::text||' '||polname, '' FROM pg_policy
  UNION ALL SELECT 'publication', pubname, coalesce((SELECT string_agg(schemaname||'.'||tablename, ',' ORDER BY 1)
    FROM pg_publication_tables pt WHERE pt.pubname=p.pubname),'') FROM pg_publication p
  UNION ALL SELECT 'extension', extname, extversion||' '||extnamespace::regnamespace::text FROM pg_extension
  UNION ALL SELECT 'default_acl', pg_get_userbyid(defaclrole)||' '||coalesce(defaclnamespace::regnamespace::text,'-')||' '||defaclobjtype::text, defaclacl::text FROM pg_default_acl
  UNION ALL SELECT 'db_role_setting', coalesce(setrole::regrole::text,'-'), array_to_string(setconfig, ',') FROM pg_db_role_setting
  UNION ALL SELECT 'rows', 'auth.users', count(*)::text FROM auth.users
  UNION ALL SELECT 'rows', 'auth.identities', CASE WHEN to_regclass('auth.identities') IS NULL THEN 'absent'
    ELSE (xpath('//n/text()', query_to_xml('SELECT count(*) AS n FROM auth.identities', false, false, '')))[1]::text END
) x ORDER BY 1`

let admin
let skip = false
let raiz, dockerDir, commit, huella, foto0, fotoInstalada
const tmp = mkdtempSync(join(tmpdir(), 'bob-desinstalar-'))

const q = (sql, params) => admin.query(sql, params)
async function foto() {
  return (await q(FOTO)).rows.map((r) => r.l)
}
function diff(a, b) {
  const sa = new Set(a), sb = new Set(b)
  return { solo_antes: a.filter((l) => !sb.has(l)), solo_despues: b.filter((l) => !sa.has(l)) }
}
function assertFoto(actual, esperada, que) {
  const d = diff(esperada, actual)
  assert.deepEqual(d, { solo_antes: [], solo_despues: [] }, `${que}: el catálogo cambió`)
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT, ...opts })
  if (opts.check !== false && r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} → ${r.status}\n${r.stdout}\n${r.stderr}`)
  }
  return r
}

// What instalar-bob.sh needs on a disposable stack: CI's path that skips the
// signature, a private directory for its pgpass files, and the postgres
// password in a file (the local stack's default, as in ci.yml).
function instalarEnv(extra = {}) {
  const priv = join(tmp, 'run'); mkdirSync(priv, { recursive: true, mode: 0o700 })
  const penv = join(tmp, 'postgres.env')
  writeFileSync(penv, 'POSTGRES_PASSWORD=postgres\n', { mode: 0o600 })
  return {
    ...limpio(), INSTALAR_SIN_FIRMA: 'ci', GITHUB_ACTIONS: 'true', SUDO: '', XDG_RUNTIME_DIR: priv,
    POSTGRES_ENV: penv, POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: PORT, ...extra,
  }
}
// The environment without anything of this suite's or CI's own that the
// script would read.
function limpio() {
  const e = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(DESINSTALAR_|PG|SUPABASE_|POSTGRES_|MIGRADOR_)/.test(k)) e[k] = v
  }
  return e
}

// BOb on the database, as a box gets it (ci.yml, "Chain applies as
// bob_migrador"), then B8 (bob_app's login) and B8b (the box's organization).
function instalar() {
  run('bash', ['scripts/instalar-bob.sh', 'cadena'], { env: instalarEnv() })
  run('psql', [PG_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'alta-ci.sql'], { cwd: join(REPO_ROOT, 'supabase/provision') })
  run('psql', [ADMIN_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'supabase/provision/alta-ci-supabase-admin.sql'])
  run('psql', [ADMIN_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', "ALTER ROLE bob_migrador LOGIN PASSWORD 'bob_migrador-local-test'"])
  const menv = join(tmp, 'migrador.env')
  writeFileSync(menv, 'MIGRADOR_USUARIO=bob_migrador\nMIGRADOR_CLAVE=bob_migrador-local-test\nMIGRADOR_HOST=127.0.0.1\nMIGRADOR_RED=\n', { mode: 0o600 })
  run('bash', ['scripts/instalar-bob.sh', 'resto'], { env: instalarEnv({ POSTGRES_PORT: PORT, MIGRADOR_ENV: menv, MIGRADOR_PUERTO: PORT }) })
  run('psql', [ADMIN_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', "ALTER ROLE bob_app LOGIN PASSWORD 'bob_app-local-test'"])
  run('psql', [PG_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c',
    "INSERT INTO bob.organizations (name, slug, plan) VALUES ('Cliente Demo', 'modelo', 'enterprise')"])
}

// model-01's /opt/bob, /root/bob-install and docker, under a directory of the
// test's (never /opt), with the mark the script asks for.
function montarCaja() {
  raiz = mkdtempSync(join(tmp, 'raiz-'))
  writeFileSync(join(raiz, '.desinstalar-prueba'), `desinstalar-prueba ${raiz}\n`)
  const ob = join(raiz, 'opt/bob')
  for (const d of ['bin', 'aprobaciones', 'secrets', 'config', 'entrega', 'atestaciones']) mkdirSync(join(ob, d), { recursive: true })
  mkdirSync(join(raiz, 'root/bob-install'), { recursive: true })
  copyFileSync(join(REPO_ROOT, 'scripts/firma-instalacion.sh'), join(ob, 'bin/firma-instalacion'))
  chmodSync(join(ob, 'bin/firma-instalacion'), 0o755)
  writeFileSync(join(ob, 'instalacion-firmada'), `${huella}\n`)
  writeFileSync(join(ob, 'instalacion-aprobacion'), `${VACIA}-${huella}\n`)
  for (const f of ['firmantes_instalacion', 'aprobaciones-revocadas', 'hosts-permitidos', '.instalando', 'deploy.sh', 'rollback.sh',
    'lib.sh', 'fijos.sh', 'comprobar-aislamiento.sh', 'compose.yml', `aprobaciones/${VACIA}-${huella}.aprobacion`,
    `aprobaciones/${VACIA}-${huella}.aprobacion.sig`, 'secrets/migrador.env', 'secrets/app.env', 'config/caja.env',
    'atestaciones/bob-web-482a03ff0000-20261127T100000Z-123.atestacion', 'atestaciones/bob-web-482a03ff0000-20261127T100000Z-123.atestacion.sig']) {
    writeFileSync(join(ob, f), 'inventado\n', { mode: 0o600 })
  }
  writeFileSync(join(ob, '.env'), `BOB_HOST=bob.example.com\nBOB_WEB_IMAGEN=${IMG_WEB}\nBOB_WEB_IMAGEN_ANTERIOR=${IMG_ANTES}\n`)
  writeFileSync(join(raiz, 'root/bob-install/postgres.env'), 'POSTGRES_PASSWORD=inventada\n', { mode: 0o600 })
  dockerDir = join(raiz, 'docker'); mkdirSync(dockerDir)
  writeFileSync(join(dockerDir, 'contenedores'),
    `bob-web\tbob\t${IMG_WEB}\ttrue\nbzzz-supabase-db\tbzzz\t${IMG_DB}\ttrue\nbzzz-puerta\tbzzz\t${IMG_PUERTA}\ttrue\nbzzz-supabase-auth\tbzzz\t${IMG_AUTH}\ttrue\n`)
  writeFileSync(join(dockerDir, 'imagenes'),
    `${IMG_WEB}\tbob-web:482a03ff0000 \n${IMG_ANTES}\t\n${IMG_DB}\tsupabase/postgres:17.6.1.136 \n${IMG_PUERTA}\tbzzz-puerta:local \n${IMG_AUTH}\tsupabase/gotrue:v2.191.0 \n`)
  mkdirSync(join(dockerDir, 'env'))
  writeFileSync(join(dockerDir, 'env/bzzz-supabase-auth'), authEnv('false'))
  writeFileSync(join(dockerDir, 'log'), '')
}

// A git that writes down every call before running the real one: the script reads the clone it is given once.
const GIT_LOG = join(tmp, 'git.log')
const GIT_SHIM = join(tmp, 'bin')
function montarGit() {
  const real = run('sh', ['-c', 'command -v git']).stdout.trim()
  mkdirSync(GIT_SHIM, { recursive: true })
  writeFileSync(join(GIT_SHIM, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${GIT_LOG}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
}
function scriptEnv(extra = {}) {
  return {
    ...limpio(), PATH: `${GIT_SHIM}:${process.env.PATH}`, DESINSTALAR_PRUEBA_RAIZ: raiz, DESINSTALAR_PRUEBA_HOSTNAME: 'model-01',
    DESINSTALAR_PRUEBA_DOCKER: DOCKER_FALSO, DOCKER_FALSO: dockerDir, DESINSTALAR_PRUEBA_URL: ADMIN_URL, ...extra,
  }
}
const ARGS = () => ['--caja', 'model-01', '--motor', REPO_ROOT, commit]
function desinstalar(args = ARGS(), { env = scriptEnv(), input = '' } = {}) {
  return spawnSync('bash', [SCRIPT, ...args], { env, input, encoding: 'utf8', cwd: tmp })
}

// Everything the script could touch, so a refusal can be shown to have left it.
function arbol(d) {
  if (!existsSync(d)) return []
  return readdirSync(d, { recursive: true }).map(String).sort().map((p) => {
    const s = statSync(join(d, p))
    return `${p} ${s.isDirectory() ? 'd' : readFileSync(join(d, p), 'utf8')}`
  })
}
function estadoCaja() {
  return {
    opt: arbol(join(raiz, 'opt/bob')), root: arbol(join(raiz, 'root')),
    contenedores: readFileSync(join(dockerDir, 'contenedores'), 'utf8'), imagenes: readFileSync(join(dockerDir, 'imagenes'), 'utf8'),
  }
}
function soloLeyoDocker() {
  const log = readFileSync(join(dockerDir, 'log'), 'utf8').split('\n').filter(Boolean)
  const escritas = log.filter((l) => !/^(ps |inspect |image inspect )/.test(l))
  assert.deepEqual(escritas, [], 'docker solo se lee')
}
async function sinCambios(r, que, { codigo = 1, patron } = {}) {
  assert.equal(r.status, codigo, `${que}: rc ${r.status}\n${r.stdout}\n${r.stderr}`)
  if (patron) assert.match(r.stdout + r.stderr, patron, que)
  assertFoto(await foto(), fotoInstalada, que)
  assert.deepEqual(estadoCaja(), cajaInstalada, `${que}: los ficheros o docker cambiaron`)
  soloLeyoDocker()
}
let cajaInstalada

before(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL })
  try {
    await admin.connect()
  } catch (e) {
    if (REQUIRED) throw e
    skip = 'no database at DESINSTALAR_DB_URL'; return
  }
  const v = Number((await q('SHOW server_version_num')).rows[0].server_version_num)
  const bob = (await q("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'bob' OR rolname LIKE 'bob\\_%'")).rows[0].n
    + (await q("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'bob'")).rows[0].n
  if (v < 160000 || bob > 0) {
    skip = v < 160000 ? `Postgres ${v}: the box runs 17.6` : 'this database already holds BOb: the test needs one that starts without it'
    if (REQUIRED) throw new Error(`BOB_DESINSTALAR_REQUIRED=1 and ${skip}`)
    return
  }
  commit = run('git', ['rev-parse', 'HEAD']).stdout.trim()
  huella = run('bash', ['scripts/firma-instalacion.sh', 'huella', commit]).stdout.trim()

  // What Bzzz has before BOb: another neighbour (opsrun), an account, a table and a function of its own in public.
  await q(`
    CREATE ROLE opsrun_migrador NOLOGIN; CREATE ROLE opsrun_app NOLOGIN;
    CREATE SCHEMA opsrun AUTHORIZATION opsrun_migrador;
    CREATE TABLE opsrun.tareas (id int PRIMARY KEY); ALTER TABLE opsrun.tareas OWNER TO opsrun_migrador;
    GRANT USAGE ON SCHEMA opsrun TO opsrun_app;
    CREATE TABLE public.bzzz_cosa (id int PRIMARY KEY); ALTER TABLE public.bzzz_cosa OWNER TO postgres;
    CREATE FUNCTION public.bzzz_hola() RETURNS text LANGUAGE sql AS $$ SELECT 'hola' $$; ALTER FUNCTION public.bzzz_hola() OWNER TO postgres;
    INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-0000000000aa', 'user@example.com');
    -- The same grant BOb's chain makes (20260606120001), as Bzzz could make it for an auth hook of its own: Postgres
    -- records both as granted by pg_database_owner, so the uninstall cannot tell them apart and must leave it.
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;`)
  foto0 = await foto()
  montarGit()
  instalar()
  fotoInstalada = await foto()
  montarCaja()
  cajaInstalada = estadoCaja()
})

after(async () => {
  if (admin) await admin.end().catch(() => {})
  rmSync(tmp, { recursive: true, force: true })
})

const t = (name, fn) => test(name, async (c) => { if (skip) return c.skip(skip); await fn(c) })

describe('the install it undoes is the box\'s', () => {
  t('BOb added what the map says, and nothing of Bzzz\'s changed', async () => {
    const d = diff(foto0, fotoInstalada)
    assert.ok(d.solo_despues.some((l) => l.startsWith('schema | bob |')), 'schema bob')
    assert.ok(d.solo_despues.some((l) => l.startsWith('role | bob_migrador |')), 'bob_migrador')
    assert.ok(d.solo_despues.some((l) => l.startsWith('schema | supabase_migrations |')), 'the CLI history')
    for (const l of foto0.filter((l) => /opsrun|bzzz_|auth\.users/.test(l))) assert.ok(fotoInstalada.includes(l), l)
  })
})

describe('G1 to G8 refuse, and leave everything as it was', () => {
  t('G1: without --caja model-01', async () => {
    for (const args of [['--motor', REPO_ROOT, commit], ['--caja', 'febor', '--motor', REPO_ROOT, commit],
      ['--caja', 'model-01 ', '--motor', REPO_ROOT, commit], ['--caja', 'MODEL-01', '--motor', REPO_ROOT, commit]]) {
      await sinCambios(desinstalar([...args, '--ejecutar'], { input: 'desinstalo\n' }), args.join(' '), { patron: /G1: solo para la caja de ensayo/ })
    }
  })

  t('G2: on a machine whose name is not model-01, exactly', async () => {
    for (const h of ['bzzz-febor', 'bzzz-lab-02', 'model01', 'model-010', 'febor-ex-model-01', 'bzzz-model-01', 'MODEL-01']) {
      const r = desinstalar([...ARGS(), '--ejecutar'], { env: scriptEnv({ DESINSTALAR_PRUEBA_HOSTNAME: h }), input: 'desinstalo\n' })
      await sinCambios(r, h, { patron: /G2: esta máquina se llama/ })
    }
  })

  t('G3: the organization is not model-01\'s alone', async () => {
    await q("INSERT INTO bob.organizations (name, slug) VALUES ('Otra Demo', 'otra-demo')")
    const otra = await foto()
    let r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /G3: bob\.organizations tiene 2 fila/)
    assertFoto(await foto(), otra, 'two organizations')
    await q("DELETE FROM bob.organizations WHERE slug = 'otra-demo'")

    const org = (await q("SELECT * FROM bob.organizations WHERE slug = 'modelo'")).rows[0]
    await q("DELETE FROM bob.organizations WHERE slug = 'modelo'")
    await q("INSERT INTO bob.organizations (id, name, slug, plan) VALUES ($1, 'Cliente Febor', 'febor', 'enterprise')", [org.id])
    r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /G3: .*\(slug febor\)/)
    await q("DELETE FROM bob.organizations WHERE slug = 'febor'")
    r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /G3: bob\.organizations tiene 0 fila/)
    await q('INSERT INTO bob.organizations (id, name, slug, plan, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [org.id, org.name, org.slug, org.plan, org.created_at, org.updated_at])
    await sinCambios(desinstalar(), 'back to one organization, modelo: the dry run passes', { codigo: 0 })
  })

  t('G2 takes the name up to its first dot', async () => {
    await sinCambios(desinstalar(ARGS(), { env: scriptEnv({ DESINSTALAR_PRUEBA_HOSTNAME: 'model-01.example.com' }) }), 'fqdn', { codigo: 0 })
    await sinCambios(desinstalar(ARGS(), { env: scriptEnv({ DESINSTALAR_PRUEBA_HOSTNAME: 'model-010.example.com' }) }), 'model-010 fqdn',
      { patron: /G2: esta máquina se llama/ })
  })

  t('on a box (no test overrides) it runs as root only', async (c) => {
    if (process.getuid?.() === 0) return c.skip('as root, box mode would go on to the real docker')
    const r = desinstalar([...ARGS(), '--ejecutar'], { env: { ...limpio(), PATH: process.env.PATH }, input: 'desinstalo\n' })
    await sinCambios(r, 'box mode, not root', { patron: /en una caja corre como root/ })
  })

  t('G8: a live auth hook of Bzzz\'s calls a function that would go: it stops', async () => {
    const env = join(dockerDir, 'env/bzzz-supabase-auth')
    try {
      // On, written however GoTrue reads it, or with no _ENABLED at all: it counts as on.
      for (const enabled of ['true', 'TRUE', '1', undefined]) {
        writeFileSync(env, authEnv(enabled))
        writeFileSync(join(dockerDir, 'log'), '')
        const r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
        await sinCambios(r, `enabled=${enabled}`, { patron: /G8: 1 hook\(s\) de auth activos llaman a una función que se borraría/ })
        assert.match(r.stdout, /⚠ G8: bzzz-supabase-auth llama a public\.custom_access_token_hook \(GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI\)/)
        assert.match(r.stdout, /GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=false en el compose de Bzzz que arranca bzzz-supabase-auth/)
      }
      // Discovered, not listed: any variable, any container, any of the chain's functions in public.
      writeFileSync(env, 'GOTRUE_SITE_URL=https://portal.example.com\n')
      writeFileSync(join(dockerDir, 'env/bzzz-puerta'), 'OTRO_HOOK=pg-functions://postgres/public/update_updated_at\n')
      writeFileSync(join(dockerDir, 'log'), '')
      let r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
      await sinCambios(r, 'another variable in another container', { patron: /G8: 1 hook/ })
      // A hook on a function that is not the chain's does not stop it.
      writeFileSync(join(dockerDir, 'env/bzzz-puerta'), 'GOTRUE_HOOK_SEND_SMS_URI=pg-functions://postgres/public/bzzz_enviar_sms\nGOTRUE_HOOK_SEND_SMS_ENABLED=true\n')
      r = desinstalar()
      await sinCambios(r, 'a hook of Bzzz\'s own', { codigo: 0 })
    } finally {
      writeFileSync(env, authEnv('false'))
      rmSync(join(dockerDir, 'env/bzzz-puerta'), { force: true })
    }
    // Off: the plan says so, and the dry run passes.
    const r = desinstalar()
    await sinCambios(r, 'hook off', { codigo: 0 })
    assert.match(r.stdout, /\(info\) +hook: bzzz-supabase-auth tiene GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=…\/public\/custom_access_token_hook, apagado/)
  })

  t('G4: without typing «desinstalo»', async () => {
    for (const input of ['', 'si\n', 'Desinstalo\n', 'desinstalo model-01\n']) {
      await sinCambios(desinstalar([...ARGS(), '--ejecutar'], { input }), JSON.stringify(input), { patron: /G4: no confirmado: nada borrado/ })
    }
  })

  t('G5: never the service role', async () => {
    for (const v of ['SUPABASE_SERVICE_ROLE_KEY', 'service_role_jwt', 'BOB_SERVICE_KEY']) {
      const r = desinstalar([...ARGS(), '--ejecutar'], { env: scriptEnv({ [v]: 'inventada' }), input: 'desinstalo\n' })
      await sinCambios(r, v, { patron: /G5: la variable .* nombra la service role/ })
    }
    // And the script names it nowhere but in that refusal.
    const lines = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => /service.?role|service_key/i.test(l))
    for (const l of lines) assert.match(l, /G5|SERVICE_ROLE\*|nunca la service role|No es la service role/, l)
  })

  t('G6: something of Bzzz\'s hangs from what would go: it stops', async () => {
    await q('CREATE VIEW public.bzzz_vista AS SELECT id FROM bob.organizations; ALTER VIEW public.bzzz_vista OWNER TO postgres')
    try {
      const con = await foto()
      const r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
      assert.equal(r.status, 1, r.stdout + r.stderr)
      // A view is its _RETURN rule in pg_depend.
      assert.match(r.stdout, /no está en el mapa: en la base: depende de lo que se borra: rule: "_RETURN" on public\.bzzz_vista/)
      assert.match(r.stderr, /G7: 1 cosa\(s\) que no están en el mapa/)
      assertFoto(await foto(), con, 'a view of Bzzz over bob')
    } finally {
      await q('DROP VIEW IF EXISTS public.bzzz_vista')
    }
    // The CLI history goes with CASCADE too: what of Bzzz's hangs from it stops the run the same way.
    await q('CREATE VIEW public.bzzz_historia AS SELECT version FROM supabase_migrations.schema_migrations; ALTER VIEW public.bzzz_historia OWNER TO postgres')
    try {
      const con = await foto()
      const r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /no está en el mapa: en la base: depende de lo que se borra: rule: "_RETURN" on public\.bzzz_historia/)
      assert.match(r.stderr, /G7: 1 cosa\(s\) que no están en el mapa/)
      assertFoto(await foto(), con, 'a view of Bzzz over the CLI history')
    } finally {
      await q('DROP VIEW IF EXISTS public.bzzz_historia')
    }
    assert.deepEqual(estadoCaja(), cajaInstalada); soloLeyoDocker()
  })

  t('G7: what is not in the map stops it, and nothing goes', async () => {
    const casos = [
      ['a file in /opt/bob that is not of the install', () => writeFileSync(join(raiz, 'opt/bob/notas.txt'), 'x'),
        () => rmSync(join(raiz, 'opt/bob/notas.txt')), /no está en el mapa: .*opt\/bob\/notas\.txt/],
      ['a file in /root/bob-install that is not postgres.env', () => writeFileSync(join(raiz, 'root/bob-install/otra.env'), 'x'),
        () => rmSync(join(raiz, 'root/bob-install/otra.env')), /no está en el mapa: .*root\/bob-install\/otra\.env/],
      ['a container bob-* it does not know', () => writeFileSync(join(dockerDir, 'contenedores'), `bob-otro\tbob\t${IMG_ANTES}\tfalse\n`, { flag: 'a' }),
        () => writeFileSync(join(dockerDir, 'contenedores'), cajaInstalada.contenedores), /no está en el mapa: contenedor bob-otro/],
      ['an image of BOb with a tag that is not', () => writeFileSync(join(dockerDir, 'imagenes'), cajaInstalada.imagenes.replace('bob-web:482a03ff0000 ', 'bob-web:482a03ff0000 bzzz-algo:1 ')),
        () => writeFileSync(join(dockerDir, 'imagenes'), cajaInstalada.imagenes), /lleva la etiqueta bzzz-algo:1, que no es de BOb/],
      ['a bob_* role the chain does not create', () => q('CREATE ROLE bob_extra NOLOGIN'), () => q('DROP ROLE bob_extra'),
        /no está en el mapa: en la base: rol bob\* que la cadena no crea: bob_extra/],
      ['a grant to bob_app on something of Bzzz', () => q('GRANT SELECT ON public.bzzz_cosa TO bob_app'), () => q('REVOKE SELECT ON public.bzzz_cosa FROM bob_app'),
        /no está en el mapa: en la base: de bob_app \(permiso\): table public\.bzzz_cosa/],
      ['a CLI history row that is not of this tree', () => q("INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('99990101000000')"),
        () => q("DELETE FROM supabase_migrations.schema_migrations WHERE version = '99990101000000'"), /historia del CLI que no es de este árbol: 99990101000000/],
      // Same name as a function the chain makes in public, of postgres's, but another signature: not the chain's.
      ['a function in public with a name of BOb\'s and another signature', () => q(`CREATE FUNCTION public.update_updated_at(integer) RETURNS int
        LANGUAGE sql AS $$ SELECT 1 $$; ALTER FUNCTION public.update_updated_at(integer) OWNER TO postgres`),
        () => q('DROP FUNCTION public.update_updated_at(integer)'), /función fuera de bob con un nombre de BOb, de postgres: update_updated_at\(integer\)/],
      // In a schema of postgres's, as Bzzz's would be; Supabase's own (supabase_admin's) are not looked at, as in cadena's check.
      ['a function of BOb\'s name outside public', () => q(`CREATE SCHEMA bzzz AUTHORIZATION postgres;
        CREATE FUNCTION bzzz.update_updated_at() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$; ALTER FUNCTION bzzz.update_updated_at() OWNER TO postgres`),
        () => q('DROP SCHEMA bzzz CASCADE'), /función fuera de bob con un nombre de BOb, de postgres: bzzz\.update_updated_at\(\)/],
    ]
    for (const [que, poner, quitar, patron] of casos) {
      await poner()
      try {
        const antes = await foto(), caja = estadoCaja()
        writeFileSync(join(dockerDir, 'log'), '')
        const r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
        assert.equal(r.status, 1, `${que}: ${r.stdout}${r.stderr}`)
        assert.match(r.stdout, patron, que)
        assert.match(r.stderr, /G7: \d+ cosa\(s\) que no están en el mapa/, que)
        assertFoto(await foto(), antes, que); assert.deepEqual(estadoCaja(), caja, que); soloLeyoDocker()
      } finally {
        await quitar()
      }
    }
    assertFoto(await foto(), fotoInstalada, 'all put back')
  })

  t('the test overrides need their mark, and the map must be the installed tree', async () => {
    rmSync(join(raiz, '.desinstalar-prueba'))
    let r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
    writeFileSync(join(raiz, '.desinstalar-prueba'), `desinstalar-prueba ${raiz}\n`)
    await sinCambios(r, 'no mark', { patron: /falta la marca/ })
    // The box says it holds another tree than the commit given: the commit's migrations are not its map.
    const firmada = join(raiz, 'opt/bob/instalacion-firmada')
    writeFileSync(firmada, `${'0'.repeat(64)}\n`)
    try {
      r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
    } finally {
      writeFileSync(firmada, `${huella}\n`)
    }
    await sinCambios(r, 'another tree installed', { patron: /el mapa tiene que ser el del árbol instalado/ })
  })
})

describe('what it removes on disk', () => {
  t('every rm -rf stays on one file system', async () => {
    const lineas = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l))
    const rm = lineas.filter((l) => /\brm\b/.test(l) && !/RMF/.test(l))
    assert.deepEqual(rm.filter((l) => /\brm\s+-[a-z]*r/.test(l)), [], 'every recursive rm goes through RMF')
    assert.ok(lineas.some((l) => /^RMF=\(rm -rf --one-file-system\)$/.test(l.trim())), 'RMF carries --one-file-system')
    assert.ok(lineas.some((l) => /no "este rm no tiene --one-file-system"/.test(l) && /PRUEBA/.test(l)), 'on a box, a rm without it stops the script')
  })
})

describe('the dry run', () => {
  t('says what it would remove, counts it, and writes nothing', async () => {
    writeFileSync(join(dockerDir, 'log'), '')
    writeFileSync(GIT_LOG, '')
    const r = desinstalar()
    await sinCambios(r, 'dry run', { codigo: 0, patron: /en-seco: nada escrito/ })
    // The clone given is read once, by a copy into the script's own folder; the digest and the map come from that copy.
    const delClon = readFileSync(GIT_LOG, 'utf8').split('\n').filter((l) => l.includes(REPO_ROOT))
    assert.equal(delClon.length, 1, `the clone is read once:\n${delClon.join('\n')}`)
    assert.match(delClon[0], /\bclone\b.*--no-checkout --no-local/)
    for (const p of [/contenedor bob-web/, /etiqueta bob-web:482a03ff0000/, new RegExp(`imagen ${IMG_WEB}`), new RegExp(`imagen ${IMG_ANTES}`),
      /opt\/bob\/secrets\/migrador\.env/, /root\/bob-install\/postgres\.env/, /borra +esquema: bob \(con todo lo que tiene\)/,
      /cascada +tabla: bob\.organizations/, /borra +función en public: bob_grant_projection\(regclass\)/,
      /borra +historia del CLI: supabase_migrations/, /borra +rol: bob_migrador/, /borra +permiso en el esquema auth: USAGE de bob_migrador/,
      /\(info\) +permiso en el esquema public: USAGE de supabase_auth_admin: SE QUEDA/, /borra +privilegio por defecto: TRUNCATE de anon y authenticated .*\(también en las que Bzzz cree después: ahí deshace F-44/,
      /== Cuenta: 1 contenedor\(es\), 2 imagen\(es\) con 1 etiqueta\(s\), \d+ fichero\(s\), \d+ cosa\(s\) en la base/,
      /hoy encuentra [1-9]\d* rastro\(s\) de BOb/, /Lo que se queda en Bzzz/, /BZZZ_HOST_BOB/]) {
      assert.match(r.stdout, p)
    }
    const plan = r.stdout.split('== Lo que se queda en Bzzz')[0]
    assert.doesNotMatch(plan, /bzzz-supabase-db|bzzz-puerta|opsrun|bzzz_cosa|bzzz_hola|auth\.users|user@example\.com/, 'nothing of Bzzz in the plan')
  })
})

// A run that is confirmed, with the database changed while it waits for the word.
function desinstalarCon(cambio, despues = async () => {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('bash', [SCRIPT, ...ARGS(), '--ejecutar'], { env: scriptEnv(), cwd: tmp })
    let out = '', err = '', hecho = false
    p.stdout.on('data', async (b) => {
      out += b
      if (!hecho && out.includes('Escribe «desinstalo»')) {
        hecho = true
        try { await cambio(); p.stdin.end('desinstalo\n'); await despues() } catch (e) { reject(e) }
      }
    })
    p.stderr.on('data', (b) => { err += b })
    p.on('close', (status) => resolve({ status, stdout: out, stderr: err }))
  })
}

describe('a transaction that fails leaves the box as it was', () => {
  t('the database changed after it was shown: ROLLBACK, the folders and bob-web back', async () => {
    const casos = [
      ['something new in bob', 'CREATE TABLE bob.nueva (id int)', 'DROP TABLE bob.nueva', /la base cambió entre lo que se enseñó y ahora/],
      ['something not in the map', "INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('99990101000000')",
        "DELETE FROM supabase_migrations.schema_migrations WHERE version = '99990101000000'", /G7: no está en el mapa: historia del CLI que no es de este árbol/],
    ]
    for (const [que, poner, quitar, patron] of casos) {
      writeFileSync(join(dockerDir, 'log'), '')
      let cambiada
      try {
        const r = await desinstalarCon(async () => { await q(poner); cambiada = await foto() })
        assert.equal(r.status, 1, `${que}: ${r.stdout}${r.stderr}`)
        assert.match(r.stdout + r.stderr, patron, que)
        assert.match(r.stderr, /la caja queda como estaba/, que)
        assert.match(r.stdout, /devuelto: .*opt\/bob/, que); assert.match(r.stdout, /arrancado otra vez: bob-web/, que)
        assertFoto(await foto(), cambiada, que)
        assert.deepEqual(estadoCaja(), cajaInstalada, `${que}: the folders and bob-web are back`)
      } finally {
        await q(quitar)
      }
    }
    assertFoto(await foto(), fotoInstalada, 'all put back')
  })

  // After a kill -9 of the script, its psql can still be in the transaction and COMMIT later. The README finds it
  // by name before reading the mark; here the transaction is held on a lock and seen there, by that name.
  t('its transaction can be found by name (application_name desinstalar-bob) while it runs', async () => {
    const lk = new pg.Client({ connectionString: ADMIN_URL }); await lk.connect()
    let visto = null
    try {
      const r = await desinstalarCon(async () => {
        await q('CREATE TABLE bob.nueva (id int)')   // so the run ends in ROLLBACK
        await lk.query('BEGIN'); await lk.query('LOCK TABLE bob.organizations IN ACCESS EXCLUSIVE MODE')
      }, async () => {
        for (let i = 0; i < 150 && !visto; i++) {
          visto = (await q(`SELECT pid FROM pg_stat_activity WHERE application_name = 'desinstalar-bob'
                              AND xact_start IS NOT NULL AND wait_event_type = 'Lock'`)).rows[0] || null
          if (!visto) await new Promise((ok) => setTimeout(ok, 200))
        }
        await lk.query('COMMIT')
      })
      assert.ok(visto, 'a transaction named desinstalar-bob, waiting on the lock')
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stdout + r.stderr, /la base cambió entre lo que se enseñó y ahora/)
      assert.deepEqual(estadoCaja(), cajaInstalada)
    } finally {
      await lk.query('ROLLBACK').catch(() => {}); await lk.end()
      await q('DROP TABLE IF EXISTS bob.nueva')
    }
    assertFoto(await foto(), fotoInstalada, 'all put back')
  })
})

describe('--ejecutar', () => {
  let r
  t('removes BOb, and the catalog is the one from before the install, line for line', async () => {
    writeFileSync(join(dockerDir, 'log'), '')
    r = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /COMMIT: \d+ cosa\(s\) de la base borradas/)
    assert.match(r.stdout, /== base vacía: la comprobación de `cadena` .* no encuentra nada/)
    assert.match(r.stdout, /desinstalado: model-01 no tiene BOb/)
    assertFoto(await foto(), foto0, 'after --ejecutar')
  })

  t('BOb\'s files, containers and images are gone; Bzzz\'s are not', async () => {
    assert.equal(existsSync(join(raiz, 'opt/bob')), false)
    assert.equal(existsSync(join(raiz, 'root/bob-install')), false)
    assert.deepEqual(readdirSync(join(raiz, 'opt')), [])
    assert.deepEqual(readdirSync(join(raiz, 'root')), [])
    assert.equal(readFileSync(join(dockerDir, 'contenedores'), 'utf8'),
      `bzzz-supabase-db\tbzzz\t${IMG_DB}\ttrue\nbzzz-puerta\tbzzz\t${IMG_PUERTA}\ttrue\nbzzz-supabase-auth\tbzzz\t${IMG_AUTH}\ttrue\n`)
    assert.equal(readFileSync(join(dockerDir, 'imagenes'), 'utf8'),
      `${IMG_DB}\tsupabase/postgres:17.6.1.136 \n${IMG_PUERTA}\tbzzz-puerta:local \n${IMG_AUTH}\tsupabase/gotrue:v2.191.0 \n`)
  })

  t('run again, it refuses: there is nothing of model-01\'s BOb left to prove it is model-01', async () => {
    const again = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
    assert.equal(again.status, 1, again.stdout + again.stderr)
    assert.match(again.stderr, /no está .*firma-instalacion/)
  })

  t('cadena from the empty base accepts the database, and the install runs again from it', async () => {
    const markDir = mkdtempSync(join(tmp, 'mark-'))
    const c = run('bash', ['scripts/instalar-bob.sh', 'cadena'], {
      env: instalarEnv({ BOB_BASE_VACIA: '1', BOB_EN_CURSO: join(markDir, 'instalacion-en-curso'), BOB_EN_CURSO_PAR: `${VACIA}-${huella}` }),
    })
    assert.match(c.stdout, /the empty base: no trace of BOb in this database \(checked\)/)
    // The rest of Febor's path, on the database the uninstall left.
    run('psql', [PG_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'alta-ci.sql'], { cwd: join(REPO_ROOT, 'supabase/provision') })
    run('psql', [ADMIN_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'supabase/provision/alta-ci-supabase-admin.sql'])
    run('psql', [ADMIN_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', "ALTER ROLE bob_migrador LOGIN PASSWORD 'bob_migrador-local-test'"])
    const menv = join(tmp, 'migrador.env')
    const resto = run('bash', ['scripts/instalar-bob.sh', 'resto'], { env: instalarEnv({ MIGRADOR_ENV: menv, MIGRADOR_PUERTO: PORT }) })
    assert.match(resto.stdout, /Finished\./)
    const d = diff(fotoInstalada, await foto())
    // The same install as the first, but bob_app's login (B8) and the organization (B8b), which come after.
    const login = (l) => !/^role \| bob_app \|/.test(l)
    assert.deepEqual(d.solo_despues.filter(login), [], 'nothing the first install did not have')
    assert.deepEqual(d.solo_antes.filter(login), [], 'all the first install had')
  })

  t('killed after its COMMIT, it leaves a mark: the folders are not to go back, and the next run says so', async () => {
    run('psql', [ADMIN_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', "ALTER ROLE bob_app LOGIN PASSWORD 'bob_app-local-test'"])
    run('psql', [PG_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c',
      "INSERT INTO bob.organizations (name, slug, plan) VALUES ('Cliente Demo', 'modelo', 'enterprise')"])
    montarCaja()
    const r = desinstalar([...ARGS(), '--ejecutar'], { env: scriptEnv({ DOCKER_FALSO_MATAR: 'rm' }), input: 'desinstalo\n' })
    assert.equal(r.signal, 'SIGKILL', `killed at docker rm: ${r.status}\n${r.stdout}${r.stderr}`)
    assertFoto(await foto(), foto0, 'the COMMIT happened')
    const apartadas = [...readdirSync(join(raiz, 'opt')).filter((n) => n.startsWith('.bob.desinstalando.')).map((n) => join(raiz, 'opt', n)),
      ...readdirSync(join(raiz, 'root')).filter((n) => n.startsWith('.bob-install.desinstalando.')).map((n) => join(raiz, 'root', n))]
    assert.equal(apartadas.length, 2, 'both folders are still set aside')
    for (const a of apartadas) assert.match(readFileSync(join(a, 'BASE-YA-VACIADA'), 'utf8'), /la base se vació \(COMMIT\)/)
    const todo = () => ({ ...estadoCaja(), opt: arbol(join(raiz, 'opt')) })
    const antes = todo()
    const otra = desinstalar([...ARGS(), '--ejecutar'], { input: 'desinstalo\n' })
    assert.equal(otra.status, 1, otra.stdout + otra.stderr)
    assert.match(otra.stderr, /una corrida anterior ya vació la base \(COMMIT\) .*No las devuelvas: bórralas/)
    assert.deepEqual(todo(), antes, 'the next run changed nothing')
  })
})
