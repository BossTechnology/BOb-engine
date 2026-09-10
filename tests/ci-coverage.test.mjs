// Every test file must be invoked by a CI job.
//
// `tests/simulator-bridge.test.mjs` shipped as a permanent guard "so the next
// rename fails here rather than at runtime in a file nobody opened" — and no CI
// job ran it. It was visible rather than blocking, which is exactly the
// distinction ID-12 draws for tenancy.
//
// The cause is the same one behind the naming test's two failures: the workflow
// ENUMERATES test files by name, so anything new is orphaned by default. The
// tenancy tests discover their tables from information_schema and are immune.
// This does the same for the workflow — a new test file is covered or the build
// fails, without anyone remembering to extend a list.
//
// It asserts itself, which is the point: if this file is ever dropped from CI,
// nothing else notices.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/db.mjs'

const WORKFLOW = join(REPO_ROOT, '.github/workflows/ci.yml')

// Test files that deliberately do not run in CI. Empty, and it should stay
// that way — an entry here is a guard someone has switched off.
const NOT_IN_CI = new Set([])

function testFiles() {
  return readdirSync(join(REPO_ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => `tests/${f}`)
    .sort()
}

// What the workflow actually runs, following `npm run <script>` into
// package.json so a script rename cannot silently orphan a file.
function filesCoveredByCI() {
  const yml = readFileSync(WORKFLOW, 'utf8')
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const scripts = pkg.scripts || {}

  const commands = []

  // Direct invocations in the workflow.
  for (const m of yml.matchAll(/run:\s*(.+)/g)) commands.push(m[1])

  // Resolve npm scripts named by the workflow, including bare `npm test`.
  for (const m of yml.matchAll(/npm (?:run )?([a-z0-9:_-]+)/g)) {
    const name = m[1] === 'test' ? 'test' : m[1]
    if (scripts[name]) commands.push(scripts[name])
  }

  const joined = commands.join('\n')

  // A glob over the directory covers everything in it.
  if (/tests\/\*\.test\.mjs/.test(joined)) return new Set(testFiles())

  return new Set([...joined.matchAll(/tests\/[a-z0-9._-]+\.test\.mjs/g)]
    .map((m) => m[0]))
}

describe('the build runs every guard it contains', () => {
  test('no test file is orphaned from CI', () => {
    const covered = filesCoveredByCI()
    const orphaned = testFiles()
      .filter((f) => !covered.has(f) && !NOT_IN_CI.has(f))

    assert.deepEqual(
      orphaned, [],
      'these test files run in no CI job, so they are visible rather than ' +
      'blocking:\n  ' + orphaned.join('\n  ') +
      '\n\nAdd them to .github/workflows/ci.yml, or to NOT_IN_CI with a reason.',
    )
  })

  test('the workflow names no test file that does not exist', () => {
    const present = new Set(testFiles())
    const stale = [...filesCoveredByCI()].filter((f) => !present.has(f))
    assert.deepEqual(
      stale, [],
      'CI invokes test files that are not there — a job that silently runs ' +
      `nothing:\n  ${stale.join('\n  ')}`,
    )
  })

  // ID-12's other half. The workflow can make a check visible; only branch
  // protection makes it blocking, and a workflow cannot set that for itself.
  test('the required checks are named where a human can find them', () => {
    const yml = readFileSync(WORKFLOW, 'utf8')
    assert.match(yml, /required status check/i,
      'ci.yml does not say which jobs must be required in branch protection, ' +
      'so the one step a workflow cannot perform for itself is undocumented')
  })
})
