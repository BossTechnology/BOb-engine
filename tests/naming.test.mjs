// Product names are precise and case-sensitive, in schema values too.
//
// 'bzzzbox' reached a CHECK constraint and a DEFAULT and stayed there. This is
// the cheapest possible guard against the next one, and it is permanent.
//
// The correcting migration is exempt: it contains the misspelling by necessity,
// because it is the migration that removes it.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, extname } from 'node:path'
import { REPO_ROOT } from './helpers/db.mjs'

// This guard has now been wrong three times.
//
// First it skipped `public/`, and public/dashboard.html carried 'bzzzbox' six
// times — while D-20 had removed the provider CHECK on the argument that this
// test covered the whole repository.
//
// Then, with the skip removed, it walked the filesystem and read UNTRACKED
// files: archived material in a working tree turned it red locally while CI
// stayed green. A suite that is red locally and green on the branch is one
// people learn to ignore, which is F-09 wearing different clothes.
//
// Then `git ls-files` listed a tracked file that had been deleted locally but
// not yet staged, and reading it failed — the same inversion again.
//
// The fix is the one used for the tenancy tables: do not enumerate, DISCOVER.
// `git ls-files`, minus what the working tree has deleted, is exactly "what is
// in the repository" — no directory to forget, no untracked file to trip over.
const SCAN_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql', '.json', '.md',
  '.yml', '.yaml', '.toml', '.css', '.html',
])

// Files that must contain a forbidden spelling in order to do their job.
//
// The 20260830 migration is applied history: it is what was actually deployed,
// and rewriting it would make the chain stop matching production. The 20260902
// migration is the correction and necessarily names what it corrects. Neither
// is a live use of the misspelling — the value in the database after the chain
// runs is 'bzzzbx', which is what the schema tests assert.
const EXEMPT = new Set([
  'supabase/migrations/20260830100000_autobotz_bindings.sql',
  'supabase/migrations/20260902100000_autobotz_rename_and_align.sql',
  'tests/naming.test.mjs',
  'Documentation/contract-amendments.md',
])

const FORBIDDEN = [
  { pattern: /bzzzbox/gi,    correct: 'BzzzBX / bzzzbx' },
  { pattern: /\bBuzzBox\b/gi, correct: 'BzzzBX' },
  { pattern: /\bBOB\b/g,      correct: 'BOb' },
  { pattern: /\bChassis\b/gi, correct: 'CHASS1S' },
  { pattern: /\bBobee\b/g,    correct: 'BObee' },
  { pattern: /\bAutobotz\b/g, correct: 'AutoBotz' },
  { pattern: /\bAutocomm\b/g, correct: 'AutoComm' },
]

// Git is the source of truth. If it is unavailable this FAILS rather than
// falling back to a filesystem walk — a guard that silently degrades to a
// weaker check is the same defect in a third costume.
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    })
  } catch (e) {
    throw new Error(
      'This test asserts what is in the REPOSITORY and needs a git checkout. ' +
      'It will not fall back to walking the filesystem, because that reads ' +
      'untracked files and produces a red suite locally against a green one ' +
      'in CI. Run it from a git working tree. Original error: ' + e.message)
  }
}

const paths = (out) => out.split('\0').filter(Boolean)

function trackedFiles() {
  const deleted = new Set(paths(git(['ls-files', '-z', '--deleted'])))
  return paths(git(['ls-files', '-z']))
    .filter((f) => !deleted.has(f) && SCAN_EXT.has(extname(f)))
}

describe('product naming is case-sensitive, including in schema values', () => {
  test('no forbidden spelling appears anywhere in the repository', () => {
    const hits = []
    const files = trackedFiles()

    // A guard that scans nothing passes. Assert the discovery found files it
    // cannot miss, rather than a count that depends on the repository's size.
    assert.ok(
      files.includes('package.json') &&
        files.some((f) => f.startsWith('supabase/migrations/') && f.endsWith('.sql')),
      `discovery returned ${files.length} files without package.json or a ` +
      'migration — the discovery is broken, not the repository')

    for (const rel of files) {
      if (EXEMPT.has(rel)) continue

      const lines = readFileSync(join(REPO_ROOT, rel), 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const { pattern, correct } of FORBIDDEN) {
          pattern.lastIndex = 0
          const m = pattern.exec(line)
          if (m) hits.push(`${rel}:${i + 1}  "${m[0]}" — should be ${correct}`)
        }
      })
    }

    assert.deepEqual(hits, [], `forbidden spellings:\n  ${hits.join('\n  ')}`)
  })
})
