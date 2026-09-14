// No migration is skipped.
//
// The CLI applies a file in supabase/migrations/ only when its name matches
// ^([0-9]+)_(.*)\.sql$. Anything else it skips with a warning on stderr, and
// `supabase db reset` still exits 0. It can also skip a `<timestamp>_init.sql`
// as a legacy baseline, and it passes over subdirectories without a word.
//
// The CI step named "Assert no migration was skipped" ran the reset a second
// time and compared nothing, so a misnamed migration would have left the job
// green over a database that did not contain it. F-15.
//
// This reads the directory, not git, unlike the naming test: the CLI reads the
// directory, so an untracked file there is applied or skipped by every local
// reset, and the database half compares against what that reset did.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { connect, REPO_ROOT } from './helpers/db.mjs'

const MIGRATIONS = join(REPO_ROOT, 'supabase/migrations')

// The CLI's own pattern, from pkg/migration/file.go. It decides whether a file
// is applied at all, and which version is recorded for it.
const CLI_PATTERN = /^([0-9]+)_(.*)\.sql$/

// Every file under the directory with a .sql extension in any case. Directories
// are walked precisely because the CLI does not walk them.
function sqlFiles() {
  return readdirSync(MIGRATIONS, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && extname(d.name).toLowerCase() === '.sql')
    .map((d) => relative(MIGRATIONS, join(d.parentPath, d.name)))
    .sort()
}

// Why a file would not be applied as named, or null. Stricter than the CLI in
// two places: a version with no name, and `init` wherever it sorts.
function namingFinding(file) {
  if (file.includes(sep)) return 'is in a subdirectory, which the CLI never reads'
  const m = CLI_PATTERN.exec(file)
  if (!m) return 'does not match ^[0-9]+_.+\\.sql$, so the CLI skips it and exits 0'
  if (m[2] === '') return 'has a version and no name'
  if (m[2] === 'init') return 'is named init, which the CLI can skip as a legacy baseline'
  return null
}

function version(file) {
  return CLI_PATTERN.exec(basename(file))?.[1] ?? null
}

function versionDrift(onDisk, applied) {
  const disk = new Set(onDisk)
  const db = new Set(applied)
  return {
    onDiskNotApplied: [...disk].filter((v) => !db.has(v)).sort(),
    appliedNotOnDisk: [...db].filter((v) => !disk.has(v)).sort(),
  }
}

describe('no migration is skipped', () => {
  test('every .sql file in supabase/migrations/ has a name the CLI applies', () => {
    const files = sqlFiles()

    // A guard that finds nothing passes, and the chain is never empty.
    assert.ok(files.length > 0,
      `no .sql file found under ${MIGRATIONS} — the discovery is broken, not the chain`)

    const findings = files
      .map((f) => [f, namingFinding(f)])
      .filter(([, why]) => why)
      .map(([f, why]) => `supabase/migrations/${f} ${why}`)

    assert.deepEqual(findings, [],
      `migration files the CLI will not apply:\n  ${findings.join('\n  ')}`)
  })

  test('schema_migrations holds exactly the versions on disk', async () => {
    const onDisk = sqlFiles().map(version).filter(Boolean)
    const db = await connect()
    try {
      const { rows } = await db.query(
        'SELECT version FROM supabase_migrations.schema_migrations')
      const drift = versionDrift(onDisk, rows.map((r) => r.version))

      assert.deepEqual(drift, { onDiskNotApplied: [], appliedNotOnDisk: [] },
        'the database does not hold the chain on disk. After adding, renaming or ' +
        'removing a migration locally, run `supabase db reset --no-seed` first.\n' +
        JSON.stringify(drift, null, 2))
    } finally {
      await db.end()
    }
  })
})

// Proof that both checks can go red, on inputs built in memory, so the proof
// never writes into the chain. A guard that cannot fail blocks nothing.
describe('the migration guard detects what it claims to detect', () => {
  test('every name the CLI would not apply is reported, and only those', () => {
    const skipped = [
      '2026-01-01_dashed_version.sql',
      'add_actors.sql',
      '20260101000001_upper_case.SQL',
      '20260101000002_.sql',
      '20210101000000_init.sql',
      join('archive', '20260101000003_filed_away.sql'),
    ]
    const applied = ['20260101000000_actors.sql']

    assert.deepEqual(
      [...applied, ...skipped].filter((f) => namingFinding(f)),
      skipped)
  })

  test('a version on one side only is reported, in both directions', () => {
    assert.deepEqual(
      versionDrift(['20260101000000', '20260101000001'], ['20260101000000', '20260101000002']),
      { onDiskNotApplied: ['20260101000001'], appliedNotOnDisk: ['20260101000002'] })
  })
})
