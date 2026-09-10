# CLAUDE.md

Guidance for Claude when working in this repository.

> **Repo root is `BOb-engine/`.** The parent `bob/` directory on disk also holds `bob-web/` (the demo, repository Bob-New) and other projects. Those are **not** part of this repository and should not be read, edited, or staged from here. If a task concerns them, say so explicitly.

## Commit and PR rules

**No AI attribution anywhere.** Applies to every artifact that leaves this machine:

- Never add `Co-Authored-By: Claude <noreply@anthropic.com>` or any `Co-Authored-By` trailer naming an AI tool.
- Never add "Generated with Claude Code", "Made with AI", or any similar footer, badge, or sign-off.
- Never mention Claude, Anthropic, ChatGPT, Copilot, "AI-generated", "LLM", or "assistant" in: commit messages, branch names, PR titles, PR descriptions, issue titles or comments, release notes, changelog entries, or code comments.
- Write every commit as the repo author would. Imperative subject, `scope(area): summary` prefix, no emoji, no filler.
- **Commit language: English**, matching existing history (`feat(db+ci): import BOb v1 Slices 0, 1 and 1b from Bob-New`).

## Sensitive data — never commit

This repository is public.

**Never stage:**
- `.env` or any variant.
- Supabase service-role keys, JWT secrets, database passwords, webhook signing secrets.
- Production dumps, or seed/fixture files containing real customer names, emails, phones, or account identifiers.
- Exports from production, screenshots showing real records, or logs with real payloads.
- Anything under `Documentation/` other than `contract-amendments.md`. The folder is ignored for that reason.

**Migrations (`supabase/migrations/`):**
- Schema, RLS policies, grants and functions are fine.
- Never hardcode a service-role key, a real tenant UUID, or seed rows with real people.

**Rules of thumb:**
- Every example value must be obviously fake: `user@example.com`, `Cliente Demo`.
- If a doc needs a real payload to be useful, keep the shape and redact the values.
- Never run `git add -A` or `git add .`. Stage explicit paths so nothing rides along.
- If unsure whether a file is sensitive, do not stage it — ask first.

## Commands

```bash
pnpm install
supabase start                 # local stack, needs Docker
supabase db reset --no-seed    # apply the full migration chain
pnpm test                      # whole suite, serially
pnpm run test:tenancy          # ID-10 to ID-12
pnpm run test:availability     # FR-20 to FR-23
```

## Architecture

**BOb-engine** is the BOb v1 build. Today it is the database layer only: the Supabase migration chain and the acceptance suite that verifies it. There is no application layer yet.

```
supabase/
  config.toml
  migrations/        # append-only chain
  tests/fixtures/    # two-tenant fixture, Slice 1 roster
tests/               # node:test acceptance suite
  helpers/           # connection, advisory lock, RLS discovery
.github/workflows/ci.yml
Documentation/contract-amendments.md   # the handover artifact between build sessions
```

### Conventions

- Migrations are append-only. Never edit one that has run anywhere shared.
- Tests run serially against one database. Keep `--test-concurrency=1` and the advisory lock in `tests/helpers/db.mjs`: parallel files deadlock, and node reports the casualties as cancelled, not failed.
- Discover, do not enumerate. A guard that lists tables, files or directories by hand acquires a hole the moment someone forgets to extend the list. The tenancy tests discover their tables from `information_schema`; follow that pattern.
- Product names are precise and case-sensitive, in schema values too. `tests/naming.test.mjs` enforces it.
- Record every finding, amendment or contract change in `Documentation/contract-amendments.md` in the same change.
