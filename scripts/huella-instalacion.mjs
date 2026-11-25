#!/usr/bin/env node
// The digest Henry signs before anything that installs BOb on a box changes
// (O-3, P5 §6.2). It covers:
//   - every file under supabase/provision/ except supabase/provision/aprobaciones/,
//     where the signatures go (so adding one does not change what it signs);
//   - every path listed in supabase/provision/cubre-la-firma, which is itself
//     under supabase/provision/: the install scripts, this one, the check and
//     the workflow that verifies the signature.
// Each file counts by path and sha256 of its content, so a rename, an edit, an
// addition or a removal all change the digest.
//
//   node scripts/huella-instalacion.mjs [<rev>]
//       from this checkout's git objects, at <rev> (default HEAD): what is
//       committed, not the working tree.
//   node scripts/huella-instalacion.mjs --github <owner/repo> <sha>
//       from GitHub's API, with GH_TOKEN: how the signature workflow reads a
//       PR without checking it out.
//   node scripts/huella-instalacion.mjs --github <owner/repo> <sha> --file <path>
//       that one file's content on stdout; exit 3 when it does not exist.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const PROVISION = 'supabase/provision/'
export const APPROVALS = 'supabase/provision/aprobaciones/'
export const EXTRA = 'supabase/provision/cubre-la-firma'
export const NAMESPACE = 'bob-install-chain'

export function fromGit(rev = 'HEAD', cwd = process.cwd()) {
  const git = (...a) => execFileSync('git', a, { cwd, maxBuffer: 1 << 28 })
  let paths
  return {
    async paths() {
      paths ??= new Map(git('ls-tree', '-r', '-z', rev).toString().split('\0').filter(Boolean)
        .map((l) => { const [meta, path] = l.split('\t'); const [, type, sha] = meta.split(' '); return [path, type === 'blob' ? sha : null] })
        .filter(([, sha]) => sha))
      return paths
    },
    async read(path) { const sha = (await this.paths()).get(path); return sha ? git('cat-file', 'blob', sha) : null },
  }
}

export function fromGitHub(repo, sha) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('owner/repo and a full commit sha')
  const api = async (p) => {
    const r = await fetch(`https://api.github.com/repos/${repo}/${p}`, {
      headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    })
    if (!r.ok) throw new Error(`GitHub ${p}: HTTP ${r.status}`)
    return r.json()
  }
  let paths
  return {
    async paths() {
      if (!paths) {
        const t = await api(`git/trees/${sha}?recursive=1`)
        if (t.truncated) throw new Error('the tree is truncated: cannot see every file')
        paths = new Map(t.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]))
      }
      return paths
    },
    async read(path) {
      const blob = (await this.paths()).get(path)
      if (!blob) return null
      const b = await api(`git/blobs/${blob}`)
      return Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8')
    },
  }
}

export async function covered(src) {
  const all = [...(await src.paths()).keys()]
  const extra = ((await src.read(EXTRA))?.toString() ?? '').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  return [...new Set([...all.filter((p) => p.startsWith(PROVISION) && !p.startsWith(APPROVALS)), ...extra])].sort()
}

export async function digest(src) {
  const h = createHash('sha256')
  for (const p of await covered(src)) {
    const c = await src.read(p)
    h.update(`${p}\0${c === null ? 'absent' : createHash('sha256').update(c).digest('hex')}\n`)
  }
  return h.digest('hex')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2)
  const src = a[0] === '--github' ? fromGitHub(a[1], a[2]) : fromGit(a[0])
  const fileAt = a.indexOf('--file')
  if (fileAt >= 0) {
    const c = await src.read(a[fileAt + 1])
    if (c === null) process.exit(3)
    process.stdout.write(c)
  } else {
    console.log(await digest(src))
  }
}
