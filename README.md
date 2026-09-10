# BOb-engine

BOb v1, the interaction observability framework, built as a new application.
The demo dashboard stays in [BossTechnology/Bob-New](https://github.com/BossTechnology/Bob-New).

This repository currently holds the database layer and its acceptance suite: the
migration chain, row-level security, the availability functions, and the tests
that verify them. There is no application layer yet.

## Requirements

- Node.js 22
- pnpm 12 — `packageManager` in `package.json` pins the exact version
- Docker, running
- Supabase CLI

## Run the suite

```bash
pnpm install
supabase start
supabase db reset --no-seed
pnpm test
```

Read all four summary lines. A `cancelled` count above zero means tests did not
run, and it does not increment `fail`:

```
# tests 67
# pass 67
# fail 0
# cancelled 0
```

CI also runs two subsets: `pnpm run test:tenancy` and `pnpm run test:availability`.

## Layout

| Path | Contents |
|---|---|
| `supabase/migrations/` | The migration chain. Append-only. |
| `supabase/tests/fixtures/` | The two-tenant fixture and the Slice 1 roster |
| `tests/` | Acceptance suite on `node:test`, one database, run serially |
| `.github/workflows/ci.yml` | Four jobs, each meant to be a required status check |
| `Documentation/contract-amendments.md` | Every finding and amendment with its reasoning. Read it before changing anything. |

## Origin

Imported from Bob-New at `edd53ad` (Slices 0, 1 and 1b). The detailed history of
those slices lives in Bob-New.
