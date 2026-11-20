# BOb-engine

BOb v1, the interaction observability framework, built as a new application.
The demo dashboard stays in [BossTechnology/Bob-New](https://github.com/BossTechnology/Bob-New).

This repository currently holds the database layer and its acceptance suite: the
migration chain (schema `bob`, including the eight projections of Slice 2),
row-level security, the availability functions, and the tests that verify them,
plus the Slice 2 reference feeder and ghost reconciliation that exercise the
projection contract against an in-memory truth store. There is no application layer yet.

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
# tests 186
# pass 184
# fail 0
# cancelled 0
# todo 2
```

The two `todo`s are counted on purpose and never reported as a pass:
- contract §10's never-merge guard: its behavioural half has no reader of
  `proj_durations` to test until the first route handler (A-05b);
- F-27: installed, `pg_net` and `http` are executable by all three roles,
  through PUBLIC. It waits on Henry's decision (P5 §6.3).

CI also runs two subsets: `pnpm run test:tenancy` and `pnpm run test:availability`.

## Layout

| Path | Contents |
|---|---|
| `supabase/migrations/` | The migration chain. Append-only. |
| `supabase/tests/fixtures/` | The two-tenant fixture, the Slice 1 roster, and the feeder's world and events |
| `feeder/` | The reference feeder (contract §8) and the in-memory truth store it reads |
| `reconciliation/` | The ghost reconciliation (contract §7.2) and member linkage |
| `scripts/box-check.mjs` | The read-only check a customer box runs after its migration step (P5 §6.2): one organization, three roles, no egress |
| `tests/` | Acceptance suite on `node:test`, one database, run serially |
| `.github/workflows/ci.yml` | Four jobs, each meant to be a required status check |
| `Documentation/contract-amendments.md` | Every finding and amendment with its reasoning. Read it before changing anything. |

## Origin

Imported from Bob-New at `edd53ad` (Slices 0, 1 and 1b). The detailed history of
those slices lives in Bob-New.
