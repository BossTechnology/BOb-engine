# Contract amendments and findings

**Why this file exists.** A slice is complete when its acceptance criteria pass,
tenancy passes, the rebuild test passes, and **no contract was amended — or the
amendment is written down.**

BOb is the first application on BzzzBX. The real test is whether one projection
schema and one binding model serve both BOb and Momentum without amendment.
Every place BOb needs the contract changed is evidence about whether the
standard holds. Recorded here; not quietly worked around.

Two registers:

- **A-nn · Amendments** — the specification says one thing, the build does
  another, deliberately.
- **F-nn · Findings** — something is wrong or unresolved and no amendment fixes
  it yet.

---

## Slice 0 · Foundations

### A-01 · `organizations.slug` already exists

**Contract:** Implementation Handoff §4.2 writes
`ALTER TABLE organizations ADD COLUMN slug TEXT NOT NULL`.

**Repository:** the column has existed since `20260606120000_initial_schema.sql`
as `slug TEXT NOT NULL UNIQUE`.

**Amendment:** migration 2 adds only the shape constraint and the immutability
guarantee. The `ADD COLUMN` would fail.

**Weight:** low. The Handoff describes the target state and was written without
the repository open. Not evidence against the standard.

---

### A-02 · Slug immutability is gated on a marker BOb owns

**Contract:** Handoff §4.2 and Migration Order step 2 — the slug is immutable
"once telemetry has been emitted under it", enforced by trigger.

**Problem:** BOb cannot evaluate that condition. Whether telemetry exists is a
fact in the truth store, and the rule that generates the other five is that BOb
never queries the truth store. A Postgres trigger in Supabase has no path to the
answer.

**Amendment (D-18, ruled):** `organizations.telemetry_started_at`. NULL means no
telemetry as far as BOb has been told; once set, the slug freezes. The marker is
itself protected — it cannot be cleared or moved, or the gate would be a
formality.

**Weight: this is real evidence.** The contract states a condition in terms of
platform state that an application is forbidden from reading. Momentum will hit
the same wall on the same column. **The platform should say who sets this marker
and when**, rather than each application inventing its own.

---

### A-03 · `provider` is an open column, so R-01 removes a CHECK rather than correcting one

**Contract:** Decision Sheet R-01 says to correct `'bzzzbox'` to `'bzzzbx'` in
the CHECK and the DEFAULT. Data Model §3.4 defines `provider TEXT NOT NULL` with
no CHECK, commented `bzzzbx | customer | named integration`.

**Amendment (D-20, ruled):** the CHECK is removed, the DEFAULT is corrected. A
two-value enumeration would reject a customer's own RPA vendor, which §3.4
explicitly permits. The misspelling is now caught by
`tests/naming.test.mjs`, which is a stronger guard than the CHECK was — it
covers the whole repository rather than one column.

**Weight:** low, but note that the string is no longer protected by a database
constraint. If the naming test is ever deleted, nothing catches the next one.

---

### A-04 · `channels.lag_seconds` is nullable, amending Handoff §4.2

**Contract:** Handoff §4.2 specifies `lag_seconds INTEGER NOT NULL DEFAULT 0`.

**Amendment (D-25, ruled):** nullable, no default. NULL means **not declared**.

**Why the Handoff is wrong here.** Zero is not the absence of a declaration; it
is a declaration that the channel is live. A voice channel is not live — a
twelve-minute call produces its facts after it ends — so a zero default asserts
something about every channel that nobody has checked. This is the PR-10
absent-versus-zero trap one level down, in the column that decides whether a
threshold may evaluate against an open bucket (PR-7). Being wrong here fires
alerts on incomplete data.

**Obligation this creates on Slice 5.** The evaluator must refuse to evaluate an
open bucket for a channel whose lag is undeclared, rather than treating NULL as
zero. That is not enforced by the schema and must be enforced by the evaluator.

---

### A-05 · PR-4 is enforced on one path of two — UNBLOCKED, NOT CLOSED

**Contract:** PR-4 — BOb never writes a projection table, enforced by a Postgres
grant rather than convention.

**What shipped:** `bob_app`, `bob_feeder` and `bob_ai_ro` with correct grants,
and `bob_grant_projection()` applying the pattern to each projection table in
Slice 2 — including a revoke against `authenticated`, the role PostgREST
switches to. Without that revoke, Supabase's own default privileges would make
the grant on `bob_app` decorative.

**What is still not covered:** the service role, used across 25 route files. It
bypasses RLS and holds broad grants.

**N-04 is now CLOSED** — full stack on the VPS, direct Postgres connection. That
makes A-05 **fixable, and does not fix it.** Two things must happen, neither of
which belongs in a migration:

1. `bob_app` becomes a LOGIN role with a credential, and BOb's connection string
   uses it. A password cannot be invented in a migration.
2. The service-role read paths move to the user-scoped client, so
   `authenticated` is the effective role on every read.

**Scheduled for Slice 2**, alongside the schema move to `bob`.

**Do not record A-05 as closed until both are done.** The claim "PR-4 is
enforced by grant" is currently true of one path out of two, and a document
saying otherwise would describe a guarantee the database does not provide.

---

### F-02 · `/api/cron/cleanup` deletes across all tenants

Deletes from `audit_log` and `notification_log` by timestamp with no `org_id`
predicate, as the service role. Correct behaviour for a platform retention
sweep, but it is a cross-tenant DELETE and nothing says so. Moves to `pg_cron`
in Slice 5; the tenant dimension should be explicit when it does.

---

### F-03 · `/api/interactions/batch` takes the tenant from the caller

Inserts a caller-supplied array into `interactions` as the service role, behind
a shared service token. The `org_id` on each row is whatever the caller writes,
so a single leaked token writes to any tenant.

**Disposition:** superseded. `interactions` leaves BOb at Migration Order step
18 and returns as `proj_metric_counts`, written by the feeder with the tenant
fixed by parameter. Not fixed in Slice 0; recorded so the removal is deliberate.

---

### F-04 · `/api/metrics/snapshot` takes the tenant from the request body

Same shape as F-03: `body.org_id` behind a shared service token.

**Disposition:** superseded. `metric_snapshots` is replaced by the projection
layer in Slice 2.

---

### F-05 · ID-11 is only partially provable in Slice 0

Registry scope never crosses a tenant boundary. Provable now against
`autobotz.scope_kind`, which lands in migration 1, and against
`notification_channels` at the row level. `threshold_configs`, `anomaly_rules`
and `text_rules` do not gain `scope_kind` until Migration Order Phase C, so
full coverage completes in Slice 6.

---

### F-06 · `channel_actor_mix` does not exist in the repository

Handoff §4.1 lists it under Configuration and C-07 rules `present` load-bearing
for FR-11, UI-03 and PR-10. There is no such table in any migration. It is
needed by Slice 1 or Slice 2 and has no step in the Migration Order.

---

### F-07 · Existing AutoBotz bindings carry no BR-3 ruling

`autobotz.mutative` ships with no default, and the constraint enforcing it is
`NOT VALID` — enforced on every insert and update, exempting rows that predate
the migration. Those rows are unruled rather than defaulted to `false`, because
a default would assert something about them that nobody has checked.

```sql
SELECT id, label, type FROM autobotz WHERE mutative IS NULL;
-- once each is ruled:
ALTER TABLE autobotz VALIDATE CONSTRAINT autobotz_mutative_declared;
```

---

## Slice 1 · Actors and Availability

### A-06 · Migration Order step 5 is deleted

`interaction_actors` is not built (D-30 / Q14, ruled: the feeder's).

Handoff §4.1's state contract lists live state explicitly and does not include
it. It is not among the eight projection tables either. Its foreign key pointed
at `interactions`, which is dropped at step 18. Per-interaction grain is
truth-store grain.

**Weight: this is evidence.** It is the one place the Data Model and the
Handoff's state contract disagreed about *ownership* rather than about wiring.

---

### A-07 · Data Model §5.3 is superseded in full

It specifies a table BOb will not build. Follows from A-06.

---

### A-08 · `channel_actor_mix` created with no step in the Migration Order

Closes F-06. Listed in Handoff §4.1 under Configuration, ruled load-bearing by
C-07, and present in no migration. Built in Slice 1 rather than Slice 2 because
`buildHumanRoster()` scopes human availability to channels whose mix carries
humans, and FR-23's required explanation is read off this table. There is no
other source for it.

Per Q13 it carries `present` and nothing else. No `share`, `bias` or `weight`:
attribution reads the observed split from `proj_metric_counts`, and multiplying
an observed split by an assumed one double-counts.

---

### A-09 · `actor_shifts.status` drops `'live'`

D-26 / Q11, ruled: liveness is derived. A stored `'live'` beside `starts_at` and
`ends_at` is a second answer to a question the timestamps already answer, and
the two disagree the moment a shift ends with nothing to update the row.
Availability would report agents who went home — plausibly, with nothing looking
broken.

Removed for the same reason R-03 removed `'pending'`.

---

### A-10 · `actors` carries ASA instance counts

D-27 / Q12. Data Model §5.1 gives ASA rows only `build_version` and `provider`.
ASA availability sums live instances, so FR-21 could not be built as specified.
`instances_total` and `instances_live` added, constrained to ASA rows.

---

### F-08 · `channel_type` had no value for a website — CLOSED

The Product Document names a website as an ASA. The CHECK admitted bot,
whatsapp, voice, app, forms, email, social, retail, google, tickets, chat and
reddit, and nothing for the most common static surface a business has.

**Ruled (a): `website` added**, in `20260903100400_channel_type_website.sql`.

Folding it into `forms` or `app` was the alternative and it is worse than it
looks: FR-11 and UI-03 report per channel, so a website, a contact form and a
Google business listing collapsed into one bucket would be visible to a customer
as three surfaces reporting as one — with no way to separate them afterwards
without a data migration.

---

### F-09 · The test suite could report green while a third of it did not run

Found by inspection during Slice 1, not by a failure.

Every test file loads fixtures into the same database and fixture loading
deletes before it inserts. Under `node --test`'s default parallel file
execution, two files deadlock. Node reports the casualties as
`cancelledByParent`, **which does not increment the failure count** — the run
printed `# pass 43 # fail 0` while twenty-four assertions never executed.

A tenancy suite that goes quietly green while not running is the exact failure
ID-12 exists to prevent.

**Fixed at two levels.** The npm scripts and CI pass
`--test-concurrency=1`. Independently, `connect()` takes a session-scoped
advisory lock, so that anyone changing that flag later gets a slow suite rather
than a dishonest one. Verified: forced concurrency 8 now yields 67 tests,
0 cancelled.

---

### D-03 should be re-scoped on the Decision Sheet

It is written as blocking `interaction_actors.contribution`. That column now
never exists in BOb. D-03 becomes a projection-contract question — what
`proj_actor_metrics` carries beyond `handled_count` — to be answered with the
BzzzBX team rather than inside BOb. Still open, still blocking CF-12 and v1.1,
but currently filed against the wrong owner.

---

### D-02 scope extended

`actors.instances_live` is BOb's live state, but the truth about how many ASA
instances are running comes from a deployment registry. At connection something
must keep this column current or ASA availability freezes at its seeded value —
silently and plausibly, which is the FR-20 failure mode in different clothes.

---

## Slice 1b · Findings from applying Slices 0 and 1

All four found by the developer during application. Three are defects in what
was delivered.

### F-10 · The naming test skipped `public/`, where the misspelling lived

`tests/naming.test.mjs` excluded `public/` to avoid scanning build output.
`public/dashboard.html` carried `'bzzzbox'` six times — including at the payload
its backend bridge POSTs to `/api/config/autobotz`.

**This is worse than a missed occurrence.** A-03 removed the `provider` CHECK
constraint on the explicit argument that the naming test "covers the whole
repository rather than one column." It did not. A database constraint was
removed on the strength of a guard with a hole, and the hole was exactly where
the defect lived. Persisting a binding would have reintroduced R-01.

**Fixed.** `public` is scanned; build output is excluded by extension instead.
`.html` added to the scanned set. Verified by sabotage: reintroducing the string
turns the suite red.

---

### F-11 · A fourth consumer of the AutoBotz API was missed

The Slice 0 handoff named three route files as affected by the rename. There
were four consumers. `public/dashboard.html` has a live backend bridge that
sends `client_id`, `scope`, `ref` and `config`, sends no `mutative`, and reads
`row.client_id`, `row.scope`, `row.ref` and `row.verify_ts` back.

After the rename, create and update would have returned 400 on the BR-3 check
and the read path would have found nothing. **CI was green throughout**, because
the suite covered schema, tenancy and availability and nothing looked at
`public/`.

**Fixed** under ruling B(a): the bridge is aligned rather than disabled, because
it is the only working AutoBotz configuration path until Slice 6 builds the real
one.

**New permanent guard:** `tests/simulator-bridge.test.mjs` reads the actual
column list from the database and asserts the bridge names nothing that no
longer exists. The next rename fails there rather than at runtime.

---

### F-07 · Superseded — five bindings, not four, and none persisted

F-07 stated that four AutoBotz bindings carried no BR-3 ruling and gave a
`SELECT` to list them. **The table is empty.** There are five, they are `ab1`
through `ab5` seeded in `window._autoBotz`, and they had never been persisted.
The claim inferred database state from a migration comment rather than checking.

**Ruled and recorded in the seed:**

| | Type | `mutative` | Reason |
|---|---|---|---|
| ab1 · Auto-Scale Webhook | webhook | **true** | Scales infrastructure |
| ab2 · Incident Bridge | webhook | **true** | Creates an incident |
| ab3 · Checkout Flow Check | synthetics | **true** | See below |
| ab4 · CRM Case Opener | rpa | **true** | Opens a case |
| ab5 · Root-Cause Triage | agent | **false** | Analyses, changes nothing |

**ab3 is BR-3's own example and the ruling is deliberate.** The check walks the
checkout to completion, because a monitor that stops before payment does not
tell you payments work — and payment failures are the ones that cost money and
hide best. Every run therefore creates a real order. It ships with
`requires_approval` set.

**This is the first mutative binding in the example set**, which means the
fixture now exercises the harder path rather than the easy one.

**New in the interface:** the create form has a BR-3 control with no default,
and `addAB` refuses to create a binding without a ruling. `persistAB` refuses to
send one. The server-side constraint was already there; nothing upstream of it
asked the question.

---

### F-12 · `Documentation/` is gitignored, so the handover artifact was untracked

`.gitignore` excluded `Documentation/*` except `New/*.docx`. **This file** — the
one the new-session prompt instructs the next session to read from the
repository — was not tracked.

**Fixed:** an exception for `Documentation/contract-amendments.md`.

---

### D-31 · What does `mutative = true` cause BOb to do? — CLOSED in Slice 6 (see the end of this file)

BR-3 says BOb refuses to register a binding without a ruling. It does not say
what BOb does with the ruling once it has it.

This did not matter while every example binding was inert. ab3 is mutative and
attachable to a response rule, so it does now: a rule that runs the checkout
check when abandonment breaches would create one real order per firing.

`requires_approval`, `rate_limit_per_hour`, `concurrency_limit` and
`invocation_cap_daily` exist for this and nothing yet reads them.

**Blocks Slice 6, not Slice 2.** AutoBotz execution is out of v1 and the outbox
drains to a stub, so nothing fires today. The rule needs deciding before it can.

---

## Environment findings

**Postgres 17.6, not 15 or 16.** The suite passes on 15 and 17.6, so 16 is safe
by interpolation. The environment is Supabase Cloud while X-01 and X-03 specify
self-hosted on the VPS, so it is interim by definition. **Ruled: leave 17.6
alone; revisit the fleet pin when the first VPS instance is built.**
`config.toml` is unchanged.

**`package.json` was shipped as a full-file replacement** and would have
reverted dependency bumps already on `main` — `next` 16.3.3→16.2.6,
`@supabase/ssr` 0.12.5→0.5.2, `react` 19.2.8→19.2.4. It was merged instead, with
only the test scripts and `pg` taken. **The package should have shipped a patch
instruction, not a file.**

**N-08 has a concrete instance behind it.** One organization and five channels
exist in the hosted environment. System Flows §3 identifies configuration and
live state as the only data that cannot be rebuilt, and its backup has no named
owner. Migrations were correctly not applied there. **Ruled: the developer owns
the backups.** See *Rulings after the Slice 2 questions*.

**Three of the four CI actions still declared Node 20.** In run 34563860302 the
`supabase/setup-cli@v1` step printed "Node 20 is being deprecated. This workflow
is running with Node 24 by default" — the runner was overriding what the
actions declare. Once Node 20 is removed
from the runners, all four required checks depend on that override. Read from
each `action.yml` at the referenced major:

| Action | Was | Runtime | Now | Runtime |
|---|---|---|---|---|
| `actions/checkout` | v4 | node20 | v5 | node24 |
| `actions/setup-node` | v4 | node20 | v5 | node24 |
| `supabase/setup-cli` | v1 | node20 | v2 | composite, `oven-sh/setup-bun` on node24 |
| `pnpm/action-setup` | v6 | node24 | v6 | unchanged |

**Each bump is the lowest major on Node 24, so behavior stays the same.**
- `checkout` v5 changes only the runtime. v6 moves persisted credentials out of
  `.git/config`, which is not needed here.
- `setup-node` v5 turns on caching automatically when `package.json` has a
  `packageManager` field, and this one does. The jobs already set `cache: pnpm`
  explicitly, so nothing changes. `node-version` stays `'22'`.
- `setup-cli` v2 finds the CLI version in the lockfile only when `version` is
  omitted. The jobs keep `version: latest`. v3 would install the CLI from npm
  instead of GitHub releases and removes the `github-token` input. That is a
  change of source with no reason behind it, so v3 was not taken.
  *Superseded by F-16: the jobs no longer use `latest`.*

No job was renamed, so the four required status checks are unaffected. Every
action is still referenced by a moving major tag, not a commit SHA. That is
unchanged, and not ruled on.

---

## Repository split · BOb v1 moves to BOb-engine

BOb v1 is built as a new application in `BossTechnology/BOb-engine`.
`BossTechnology/Bob-New` remains the demo. This repository was imported from
`Bob-New@edd53ad` — Slices 0, 1 and 1b — with fresh history. The commits behind
each finding above are in Bob-New.

### Two guards retired, and why

**`tests/simulator-bridge.test.mjs` (F-11).** It guarded `public/dashboard.html`,
the demo's simulator, against the `autobotz` rename. The simulator stays in the
demo, and Bob-New's `main` never received the v1 migrations, so the demo's
bridge still matches the demo's schema. There is no bridge here to guard.

**`tests/service-role-inventory.test.mjs` and its allowlist (D-24).** They
inventoried the demo's route handlers that use the service client. This
repository has no route handlers. **A-05 therefore reduces to one step until an
application layer exists here:** `bob_app` becomes a login role with a
credential. Moving service-role reads to the user-scoped client has no code to
act on yet, and returns with the first route handler.

### CI

`Lint and build` is removed: there is nothing to lint or build until an
application exists. Four jobs remain, and all four should be required status
checks. The job returns with the application layer.

### Counts

The 74 tests in Bob-New become **67** here: the bridge guard's 3 and the
inventory's 4 stay behind. Slice 1c brings the suite to 70.

### Open — needs a ruling

- **The five AutoBotz bindings.** Ruled in Slice 1b, they were to be persisted
  through the demo's bridge and then `VALIDATE CONSTRAINT`. That path is not in
  this repository. **Ruled: a migration and a fixture here.** See *Rulings
  after the Slice 2 questions*.
- **Visibility.** This repository is public, and the build documents are marked
  internal. This file was already public on Bob-New's branch. **Ruled:
  public, deliberately.** See *Rulings after Slice 1c*.
- **References.** The handoffs and the Slice 2 session prompt name Bob-New. The
  next package, and the fresh repository zip, should come from BOb-engine.
  **Ruled: Slice 2 targets BOb-engine.** See *Rulings after Slice 1c*.

---

## Slice 1c · Two guards that did not guard

Both found by the developer while applying Slice 1b in Bob-New, and both share a
root cause with the defect they were built to fix. Applied here after the split,
adapted to this repository.

### F-13 · The naming test read the filesystem, not the repository

After F-10 removed the `public/` skip, the test walked the tree with
`readdirSync`, so it read **untracked** files. Archived material in a working
tree turned it red locally while CI, checking out a clean tree, stayed green. A
suite that is red locally and green on the branch is one people learn to ignore,
which is F-09 in different clothes.

**Fixed by discovery rather than enumeration:** `git ls-files`. If git is
unavailable, the test fails loudly rather than falling back to a walk.

**Two adaptations here:**
- `git ls-files` still lists a tracked file deleted locally but not yet staged,
  and reading it failed with `ENOENT` — red locally, green in CI, the same
  inversion. Those paths are subtracted with `git ls-files --deleted`.
- The package asserted that more than fifty files were scanned. This repository
  has fewer than forty, so the test now asserts that the discovery found files it
  cannot miss — `package.json` and the migrations — instead of a count that
  depends on the repository's size.

### F-14 · The bridge guard ran in no CI job

In Bob-New, `tests/simulator-bridge.test.mjs` entered only through the
`tests/*.test.mjs` glob in the `test` script, which no job called: visible
rather than blocking. The cause is the same as F-10 and F-13 — the workflow
enumerates test files by name, so anything new is orphaned by default.

The bridge guard stayed in the demo (see *Repository split*).
`tests/ci-coverage.test.mjs` is taken as delivered: it asserts that every test
file is invoked by some job, following `npm run` into `package.json`, which also
matches `pnpm run` by substring.

**Known limits, reported and not yet ruled on.** `ci-coverage` reads the
workflow with regular expressions, not as YAML. It reports a guard as covered
when its step is commented out, marked `continue-on-error: true` or `if: false`,
or moved to a job that is not a required check, and when any comment in the
workflow mentions `npm test`. It does not discover test files in subdirectories
or with other suffixes. Its check on itself fires only locally: if its own step
is removed, CI simply stops running it.

### The required-checks list

The package named five required checks. Here there are four: `Lint and build`
has no application to lint or build yet. `ci.yml` names the four, and
`ci-coverage` asserts that the comment exists. It does not yet assert that the
list matches the job names.

---

## CI · A step that asserted nothing

### F-15 · "Assert no migration was skipped" compared nothing

Found by inspection of the workflow, not by a failure. No migration has been
skipped so far: run 34527093909 on `main` applied 18 of 18.

The `migrations` job ended in a step named *Assert no migration was skipped*. It
ran `supabase db reset --no-seed` a second time and echoed a line. Nothing was
compared, and no test compared `supabase_migrations.schema_migrations` with the
files either.

**The CLI skips a migration without failing.** It applies a file from
`supabase/migrations/` only when the name matches `^([0-9]+)_(.*)\.sql$`, and
skips anything else with a warning on stderr. A `<timestamp>_init.sql` that
sorts first and predates 2021-12-09 is skipped as a legacy baseline.
Subdirectories are passed over with no output at all.

Reproduced locally on CLI 2.101.0 with three probes: a malformed name, an
`init` file and a file in a subdirectory. `supabase db reset --no-seed` exited
0, printed two warnings and said nothing about the third. None of the three
reached the database, and `schema_migrations` held the chain's 18. A misnamed
migration would have left the job green over a database that did not contain
it, and the other three jobs would have tested that database.

**Fixed by discovery rather than enumeration:**
`tests/migrations-applied.test.mjs`, run as the last step of the `migrations`
job, which now installs Node for it.

- Every `.sql` file under `supabase/migrations/`, subdirectories included, must
  have a name the CLI applies: `^[0-9]+_.+\.sql$`, not `init`, not nested. That
  is stricter than the CLI in two places, a version with no name and `init`
  wherever it sorts, because neither is ever intended.
- `schema_migrations` must hold exactly the versions on disk, in both
  directions.
- A second block proves both checks go red, on names built in memory, so the
  proof never writes into the chain.

It reads the directory rather than `git ls-files`, unlike the naming test
(F-13), because the CLI reads the directory. An untracked file there is applied
or skipped by every local reset, and the database half compares against what
that reset did.

The guard does not depend on the CLI's rules staying put. CI installs the CLI
at `latest`, and those rules were read at v2.101.0. A file a later CLI stops
applying shows up either as a name the naming half rejects or as a version
missing from `schema_migrations`; a name it starts accepting that the naming
half rejects still fails that half.

**The second reset is gone.** `supabase start` already applies the chain on a
fresh stack, so the job's first reset was the second application from empty and
the removed step the third. Its echo claimed idempotence, which no number of
resets can show: each one starts from an empty database. The step is replaced,
not renamed, and no job is renamed. All four job names are required status
checks.

**Duplicate versions are not the same gap.** The CLI records each migration
with a plain `INSERT` into a table keyed on `version`, so two files sharing one
fail the reset loudly. Read from the CLI source, not exercised.

**Verified by sabotage**, each case after a real `supabase db reset --no-seed`
that exited 0, on CLI 2.101.0:

- A malformed name, `2026-09-10_sabotage_probe.sql`. The naming half went red
  and named the file. The database half stayed green, as it should: a file with
  no version cannot be missing from `schema_migrations`, which is why the
  naming half exists.
- An `init` file that sorts first, `20210101000000_init.sql`. The CLI skipped
  it and both halves went red, the database half reporting `20210101000000` on
  disk and not applied.

With the probes removed and the database reset, the check is green again.

**Known limits.**
- Only the `migrations` job runs it. The other three reset their own database
  and do not check. A skipped migration blocks the build through that job, but
  the other jobs' results in the same run describe a database without it.
- It considers `.sql` files only, in any case. A migration saved under another
  extension is invisible to it and to the CLI alike.
- Locally, `pnpm test` goes red when the database is behind the files. That is
  deliberate, since every other result would be about a stale schema, and the
  message says to reset.
- The F-14 limits of `ci-coverage` apply to this step as to any other: commented
  out or marked `continue-on-error`, it would still read as covered.

**Counts.** The suite goes from 70 tests to 74: the two checks, and the two
that prove they go red.

---

## Branch protection · ID-12's other half

### `main` is protected

Configured by the account owner, who is the only account with admin on this
repository. Read back on 2026-09-15 through the branch API with a token that
has push and not admin:

- `protected: true`
- enforcement `everyone`, so the owner is not exempt either
- four required contexts, byte-identical to the four job names in `ci.yml`

**This is the half of ID-12 the workflow cannot assert about itself.** A
workflow can make a check visible; only this setting makes it blocking. It is
now set, and the four jobs are the gate.

**Every change enters through a pull request, and an approving review is
required.** Pull requests #2 and #3 each stayed blocked on *review required*
until the owner approved them. That was not the intent recorded when the rule
was drafted, which was to require no approvals and let the four checks be the
gate, with the developer merging his own work once they are green. Because the
owner is the only other account with write access, every pull request now waits
on one person.

**Open — needs a ruling.** Keep the approving review, or set it to zero. Both
are defensible. What is not defensible is leaving it as it is without anyone
having decided it.

**Ruled: no approving review.** See *Rulings after Slice 1c*.

**What a non-admin cannot read** is the rest of the rule: how many approvals,
whether stale reviews are dismissed, whether force pushes and deletions are
blocked. Only the owner can confirm those.

### The required-checks list is asserted against the jobs

Closes the gap left open under *Slice 1c · The required-checks list*: `ci.yml`
named the four checks and `ci-coverage` asserted only that the comment existed,
not that it matched the jobs.

`ci-coverage` now reads the names out of that comment and the `name:` of every
job, and fails when the two differ. The failure it prevents is a renamed job:
branch protection keeps the old name, no check ever reports under it, and every
pull request blocks waiting for something that will not arrive. The comment's
list is read without depending on its indentation, so reformatting it cannot
quietly empty the list and pass.

**Verified by sabotage.** Renaming a job turned only that test red, and so did
deleting one name from the comment. Each message prints both lists.

**Known limits.**
- It compares the comment with the workflow, not with GitHub. A workflow cannot
  read its own branch protection without admin credentials, so the list being
  right and the setting being right stay two separate facts. The setting was
  verified by hand, above, and nothing keeps it verified.
- Regular expressions, not YAML: the F-14 limits of `ci-coverage` still apply.
- The sentence above the list still says "ALL FOUR JOBS". A fifth job would be
  caught by this test only if it were also added to the list; the word is not
  checked.

**Counts.** The suite goes from 74 tests to 75. The `README.md` example carries
the new number.

---

## Rulings after Slice 1c

Four items left open above were ruled in the reply that closed Slice 1c.

**Visibility: public, deliberately.** That is how this work is meant to be
done. The rules on what may be committed here stay as they are: no
attribution, nothing sensitive staged, explicit paths only.

**No approving review on `main`.** The four required checks are the gate, to be
revisited when there is a second developer. Applying it is a change to the
branch rule that only the owner can make: the approval count goes to zero, and
the four required contexts and the absence of any bypass stay as they are.

**Postgres 17.6 stays.** This reconfirms the ruling under *Environment
findings*: `config.toml` stays at 15, and the fleet pin is revisited when the
first VPS instance is built.

**Slice 2 targets BOb-engine.** Its package comes from this repository, not
from Bob-New.

**Still open: the five AutoBotz bindings.** The path to persisting them depends
on the state of Bob-New after the split and on which Supabase project it points
at, both asked in the same reply. This repository's half of the second question
is settled: nothing in it points at a hosted project. No project reference is
tracked, the local checkout has never been linked, and CI only ever targets the
local stack at `127.0.0.1:54322`. Ruled since: see below.

---

## Rulings after the Slice 2 questions

The developer's answers to the eight questions asked before Slice 2. Three are
rulings; the rest are findings that bear on them.

### Bob-New never received the v1 chain

The Slices 0 and 1 pull request on Bob-New (#21, head `edd53ad`, the commit
this repository was imported from) was closed unmerged on 2026-09-10. Bob-New's
`main` ends at `20260830100000_autobotz_bindings.sql`: the pre-rename schema,
with `client_id` and no `mutative`. It has no workflow, only `dependabot.yml`,
and no test scripts. **`simulator-bridge` and `service-role-inventory` run
nowhere.** They exist only on the closed branch, last run green on 2026-09-10.

### Rulings

**One hosted Supabase project, and it is this repository's target.** Today only
the Bob-New demo is connected to it. This repository is not linked to it and no
migration has been applied there. **Applying this chain there breaks the demo's
bridge**, which still speaks the pre-rename schema: the F-11 failure, on the
live project. The bridge guard as a committed contract file should exist first.

**N-08: the developer owns the backups of the hosted project.** No migration
goes there before a backup exists.

**The five AutoBotz bindings: a migration and a fixture here.**
`VALIDATE CONSTRAINT autobotz_mutative_declared` ships as a plain migration in
this repository, and the five rulings under F-07 become a fixture. They cannot
be persisted in Bob-New, whose `main` has no `mutative` column. `NOT VALID`
exempts nothing anywhere: the hosted bindings table had 0 rows on 2026-09-06,
and a database built from this chain starts empty.

### Since: the thirteen-month TTL

**Ruled and applied.** Bzzz D39, signed 2026-10-12, sets `business_events` to
395 days on every box and supersedes D34.4. Read from `system.tables` on
2026-10-12: `toIntervalDay(395)` on the lab box from 21:34 UTC and on the
reference box from 21:31 UTC. The client box was scheduled for 2026-10-13. The
history starts 30 days before each box's date: what had already expired does
not come back.

---

## CI · A check that failed on GitHub's rate limit

### F-16 · `version: latest` made every required check depend on an unauthenticated API call

On 2026-10-11, run 38144661320 (pull request #5, a documentation-only change)
failed *Contracts, schema and naming* at the `supabase/setup-cli@v2` step:
"Failed to resolve latest Supabase CLI release: rate limit exceeded". The other
three jobs passed the same step in the same run, and the re-run passed. The
failure had nothing to do with the change under test.

**Cause, read from the action's `src/main.ts` at v2.** With `version: latest`
the action asks `api.github.com/repos/supabase/cli/releases/latest` for a tag,
and sends a token only if `github-token` is set. No job set it, so the request
was unauthenticated and shared the runner IP's 60-an-hour limit with whoever
else had that IP. Any of the four required checks could fail this way. With a
concrete version the action makes no API call at all: it downloads the release
archive directly.

**Two fixes weighed.**
- *Pass `github-token: ${{ github.token }}`.* The lookup is authenticated and
  moves to the repository's own limit, and the jobs keep tracking `latest`. It
  fixes the rate limit and nothing else. A new CLI release can still turn all
  four checks red on a pull request that did not cause it, and the four jobs of
  one run can resolve different versions if a release lands mid-run. It also
  depends on an input that v3 removes.
- *Pin a concrete version.* No lookup to fail, the same CLI in all four jobs,
  and a CLI change arrives as its own pull request. It works the same on v3,
  which installs a pinned version from npm. The cost is that someone has to
  bump it.

**Ruled by this change: pin.** `SUPABASE_CLI_VERSION: 2.120.0` is set once, in
the workflow-level `env` of `ci.yml`, and every setup-cli step reads it. 2.120.0
is what `latest` resolved to when this was written: the newest release,
published 2026-10-06, so the jobs test exactly what they tested before. No
token is passed, because with a pinned version the action never uses it.

Omitting `version` does not help. The action then looks for a `supabase`
dependency in the lockfile, and this repository has none, so it falls back to
`latest`. Adding `supabase` as a dev dependency would make the lockfile the one
place, but it puts a second CLI download into `pnpm install` for every job, for
a binary CI already gets from the action.

**How it gets bumped.** By hand, in a pull request that changes only that line
and records the new version here. The four checks are the test of the bump.
Nothing schedules it, and Dependabot does not read workflow `env` values. Bump
when a CLI fix is needed, or when the local stack should track a newer Postgres
image. The version on a developer's machine is not affected: locally it is
whatever `supabase --version` says, 2.119.0 on the machine this was written on.

**Guarded.** `ci-coverage` gains a test that the workflow env holds a concrete
`x.y.z` and that every `supabase/setup-cli` step, discovered rather than listed,
passes `version: ${{ env.SUPABASE_CLI_VERSION }}`. Verified by sabotage: setting
the env to `latest`, setting one step to `latest`, and removing one step's
`version` each turned that test red, and only that test.

**Known limits.**
- The F-14 limits apply: regular expressions, not YAML.
- The archive still comes from GitHub releases, and the Docker images from
  their registries. Those are downloads, not API calls, and are outside the
  limit that failed here. An outage of either still fails a check.

No job was renamed, so the four required status checks are unaffected.

**Counts.** The suite goes from 75 tests to 76. The `README.md` example carries
the new number.

---

## BR-3 · The mutative exemption is closed

### F-07 · Closed — VALIDATE ships as a migration, the rulings as a fixture

Ruled in BOB-4 (23 Oct 2026). The five rulings could not be persisted through
the demo's bridge: Bob-New's `main` is pre-rename, with no `mutative` column, and
the bridge is now disabled (BOB-4, ruling 1). They also cannot be persisted
anywhere by a migration without putting example rows in production. So the two
halves go where each belongs.

**Migration** `20261025100000_autobotz_validate_mutative.sql` runs
`ALTER TABLE autobotz VALIDATE CONSTRAINT autobotz_mutative_declared`, the step
20260902100000 named. Before it, a guard lists every row with
`mutative IS NULL` by id, label and type and stops. `VALIDATE` alone would fail
on such a row too, but only with the constraint's name. The migration never
rules on a row itself. Nothing is exempted today: the hosted bindings table held
0 rows on 6 Sep, and this chain starts empty.

**Fixture** `supabase/tests/fixtures/autobotz_br3.sql` holds `ab1` to `ab5` for
tenant A with the rulings in the table above, and `requires_approval` set on the
checkout check. Shape choices that are not rulings: provider follows the seed,
corrected to `bzzzbx`; `scope_kind` is `company` for all five, because the seed
gives `ab3` a scope (`aba`) outside the §3.4 set; `ab2`'s URL moves to a fake
host.

**Guarded** by `tests/autobotz-br3.test.mjs`, in the "Contracts, schema and
naming" job:
- the constraint is validated;
- the migration, run inside a rolled-back transaction over a reopened exemption,
  refuses an unruled row and names it, and validates once every row is ruled;
- a ruled binding cannot be set back to `NULL`;
- the fixture's label, type and ruling match the F-07 table in this file, read
  from here rather than copied into the test;
- the checkout check is mutative and requires approval.

The migration is found by the statement it executes, not by its file name.
Verified by sabotage: leaving the constraint `NOT VALID`, removing the guard, and
ruling `ab5` mutative in the fixture each turned exactly one test red.

No job was renamed, so the four required status checks are unaffected.

**Counts.** The suite goes from 76 tests to 82. The `README.md` example carries
the new number.

---

## Guards made to fail before Slice 2

Requested in BOB-7 (27 Oct 2026) as its own package ahead of the Slice 2
proposal: items (a) and (c) of the scope-map review, with what came cheaply
from (b), (e) and (f). Rule applied: a guard is not trusted until it has been
made to fail on purpose.

### F-17 · Tenancy discovery was pinned to `public`

`tenantTables()`, the policy read in `structuralFindings()`, PR-4's query and
the cross-tenant read all named the literal `'public'`. On main at `aed52ba`,
moving the 26 tenant tables to `bob` inside a transaction takes discovery from
26 tables to 0; every tenancy assertion then loops over nothing and passes. The
meta-tests did not notice, because their probes were created in `public`.

**Fixed.** Discovery spans every schema except `pg_*` and `information_schema`,
found by prefix, so a schema nobody has named yet is included by default. Tables
are carried schema-qualified, and policies are matched by schema and table.

**Floor.** `TENANCY_FLOOR` in `tests/helpers/db.mjs` names six tables the
tenancy tests and the fixture use. A new test fails when any of them is missing
from what discovery found. It is a lower bound, not the set: a table missing
from it is still discovered and checked.

**Probes in the target schema.** Every meta-test probe runs twice, in `public`
and in `bob`. A further meta-test moves every real tenant table to `bob` inside
a rolled-back transaction and asserts discovery returns the same set, none of it
in `public`, with no structural finding.

### F-18 · PR-4 found projections by name, and could not see partitions

PR-4 looked only at tables named `proj_%`, only at grants recorded in
`information_schema` for `anon`, `authenticated` and `bob_app`, and never asked
whether `bob_feeder` could write.

**Fixed.** A table is a projection if its name starts with `proj_`, if
`bob_feeder` holds a write grant on it, or if it is a partition, at any depth,
of one of those. Privileges are read with `has_table_privilege`, the check
Postgres itself makes, so grants to PUBLIC and grants inherited through a role
count. Each projection must give no write to PUBLIC, `anon`, `authenticated` or
`bob_app`, and must give `bob_feeder` SELECT, INSERT, UPDATE and DELETE.

**Partitions.** Postgres does not copy grants from a parent to a partition
created later, and in `public` Supabase's default privileges grant `anon` and
`authenticated` full rights on every new table. A meta-test passes a partitioned
parent through `bob_grant_projection()`, creates a month after it under a name
without the prefix, and asserts the month is reported and the parent is not. In
`bob` no default privileges apply, and the forgotten month is caught only by the
feeder check: the schema move removes the over-grant, not the need to grant.

Partitions also do not inherit RLS. A partition of a guarded `org_id` table is
readable across tenants when queried directly. `tenantTables()` includes
partitions, and a meta-test asserts one without RLS is reported.

**Still for Slice 2.** Whatever creates a partition calls
`bob_grant_projection()` on it and enables RLS on it. Asserting there are
exactly eight projections waits for the published contract to say which.

### F-19 · Three more hand-written lists

- **The aggregate-leak test** counted four named tables. It is now
  `aggregateLeakFindings()` over every discovered table: what a tenant counts
  must not exceed what it owns, counted outside RLS. A meta-test feeds it a
  policy that names `org_id` and still lets every row through, which the
  structural check accepts.
- **The fixture's DELETE list** named nine tables. `loadFixture()` now deletes
  the two organisations and lets the foreign keys cascade, then sweeps every
  discovered tenant table. The sweep matters: seven tables carry `org_id` with
  no foreign key to `organizations` (`audit_log`, `baselines`,
  `metric_snapshots`, `notification_log`, `patterns`, `rootcause_log`,
  `sentiment_readings`), all inherited from Bob-New, and the cascade cannot
  reach them.
- **Test discovery was one level deep.** `package.json` runs
  `'tests/**/*.test.mjs'`, quoted so that node expands it: `sh` has no
  globstar and would expand an unquoted `**` as a single level, skipping the
  top. `ci-coverage` reads `tests/` recursively, so a test file in a
  subdirectory that no CI job names fails the build.

**Not in this package.** The `bob_app` grants are still listed by hand in
`20260902100300_roles_and_grants.sql` and nothing checks them. Two absence
checks in `slice0-schema` (no `autobotz_bindings` table or policy) still look
only in `public`, and pass trivially after a move. Both ride with Slice 2.

### Verified by sabotage

Each change below was made alone to the helpers, the tenancy suites run, and the
file restored. Only the named tests went red.

| Sabotage | Red |
|---|---|
| Discovery pinned back to `public` | the four structural probes in `bob`, the aggregate probe in `bob`, the move rehearsal |
| Discovery looking in `bob` while the tables are in `public` | the floor; the aggregate test, which finds no tenant-B rows |
| Policies read from `public` only | the open-policy probe in `bob` |
| Partitions dropped from projection discovery | the late-partition probe, in both schemas |
| Partitions dropped from tenant discovery | the partition-without-RLS probe, in both schemas |
| Projections found by `proj_` only | the unprefixed-projection probe, in both schemas |
| PUBLIC left out of the check | the PUBLIC probe, in both schemas |
| Feeder write not checked | the starved-feeder probe in both schemas, and the late-partition probe in `bob` |
| Aggregate check back to the four named tables | the aggregate probe, in both schemas |

For (f), with a probe at `tests/zz-sub/zz-probe.test.mjs` that no job names:
`ci-coverage` as on main stays green; on this branch it fails and names the
file. Node's glob finds 9 files for `tests/*.test.mjs` and 10 for
`tests/**/*.test.mjs`.

No job was renamed, so the four required status checks are unaffected.

**Counts.** The suite goes from 82 tests to 100: the floor, and the tenancy
meta-tests from 4 to 21. The `README.md` example carries the new number.

### Branch protection, read back on 2026-10-28

The branch API reports `enforcement_level: non_admins` on `main`, so an admin
can merge past the four checks. It read `everyone` on 2026-09-15. The ruling is
the four checks enforced for everyone, admins included. Closing it needs "Do
not allow bypassing the above settings" on the `main` rule, which only an admin
can set.

Read back again on 2026-10-29, after the BossTechnology account set it:
`enforcement_level: everyone`, with the same four required contexts. Closed.

---

## Slice 5 · Cooldown and escalation

### D-05 · Closed — 30-minute cooldown, two-hour escalation, a 300-second floor

Ruled in BOB-9 (27 Oct 2026). Migration Order step 6a added in BOB-7 the same
day. Not built yet: it ships with Slice 5.

- **Cooldown:** one system default of 1800 seconds, overridable per threshold.
  Not per metric: there is no alert volume to tune five numbers from (C-09).
- **Key:** the composite subject, `evaluation_state.subject_key`. One problem on
  four channels produces four alerts. Recognising them as one incident is
  correlation, which v1 does not do.
- **Escalation:** severity rises once (RS-04) after 7200 seconds sustained. It
  is severity, not routing.
- **Defaults, not authored-with-no-default.** A wrong cooldown is noise, not an
  irreversible act, so the BR-3 precedent does not apply.
- **Recovery has no cooldown.**
- **Floor:** a CHECK refuses a cooldown below 300 seconds. Below one base
  bucket (C-13), pg_cron re-evaluates the same sealed bucket and a shorter
  cooldown is inert, not aggressive.
- **Step 6a:** `cooldown_seconds` and `escalation_after_seconds` on
  `threshold_configs`, defaults 1800 and 7200, CHECK `>= 300`.

Structural, not configuration: the floor (changing it means changing C-13 and
rebuilding the projections) and the key (changing it means changing how breach
state is tracked). Everything else is soft.

**Inherited obligation (A-04, D-25).** The evaluator refuses to evaluate an open
bucket for a channel whose `lag_seconds` is NULL. The schema cannot enforce it.
The fixture already carries an undeclared channel to test against
(`supabase/tests/fixtures/roster.sql:36`).

### Checked against the schema at `aed52ba` — open before step 6a is written

1. **A column DEFAULT does not move existing thresholds.** With
   `DEFAULT 1800`, every threshold created before a change of default stores
   1800 literally, and is then indistinguishable from one a customer set to
   1800 on purpose. Changing the default in one line moves only new thresholds.
   The alternative is the D-25 shape: nullable, NULL inherits the system
   default, and the default lives in one place.
2. **The floor covers only the cooldown.** An `escalation_after_seconds` below
   300 is inert for the same reason.
3. **Two threshold models coexist.** `notification_rules`
   (`20260606120000_initial_schema.sql:209`) has its own `suppression_min`
   (default 15) and `escalation_min` (default 30) at lines 229-230, no floor,
   and feeds `alerts`, which carries `acknowledged_at` (line 265).
   `threshold_configs` (`20260729130000_v3_config_persistence.sql:43`) feeds
   `alert_log` (line 94). `bob_app` holds grants on both
   (`20260902100300_roles_and_grants.sql:75-80`). Step 6a adds to one and
   leaves the other's defaults standing.
4. **Sustained or unacknowledged.** BOB-9 asked "after how long
   unacknowledged"; the ruling says two hours sustained. Read as: escalation
   does not depend on acknowledgement, so Slice 5 needs no acknowledgement
   column. `alert_log` has none today.
5. **Recovery followed by a re-breach inside the cooldown.** The re-breach is
   suppressed, so the last visible event is a recovery while the subject is
   breached: the mirror of the case uncooled recovery exists to avoid. Not
   ruled: whether a recovery ends the subject's cooldown.
6. **Granularity until Phase C.** `threshold_configs` is
   `UNIQUE(org_id, metric_id)` (line 53), so "per threshold" means per metric
   per organisation. Voice and WhatsApp share a cooldown until scope columns
   land (F-05). `evaluation_state` does not exist yet; Slice 5 creates it.

---

## Slice 2 · The projection read contract, drafted

Slice 2 opens by publishing the read contract (BOB-6, BOB-7 ruling (d)) before
any migration. Draft 0.2 is `docs/contracts/projection-contract.md`. It is a
draft until Henry signs it on BOB-6; no migration is written against it before
then.

**What it fixes from the package.** The eight names (Migration Order step 14),
the `proj_response_time` columns verbatim, C-11 to C-15, the five feeder
obligations, and `org_id UUID` as the tenant key with RLS on every table and
every partition.

### F-20 · Handoff §3.3 is cited for the projection columns and is not in the package

The Migration Order replaces `sketch BYTEA` "in Handoff §3.3", which places the
projection column lists there. No package received so far (Slices 0 and 1, 1b,
1c) contains it. Seven of the eight column lists in the draft are therefore
proposals, marked **[PROPOSED]**, and so are two of the three provenance
column names: step 14 requires three and names none, and the Build Brief names
only `feeder_version`.

**Disposition:** open. Either §3.3 is produced and the draft is checked against
it, or the published contract replaces it and §3.3 is recorded as superseded.

### Two choices in the draft that bear on the guards

- **The watermark travels on the rows** (`source_watermark`), read back as its
  maximum. A watermark table written by `bob_feeder` would be a projection to
  the F-18 guard, and "exactly eight" would fail.
- **`hist_scale` is not pinned to 4.** The Migration Order stores it per row so
  rows at an older scale can be down-scaled before merging. A `CHECK
  (hist_scale = 4)` would make that impossible.

### Carried into the Slice 2 migrations

From ESTADO and F-18/F-19, each to be seen failing before it is trusted:
`bob_grant_projection()` and RLS on every partition; exactly eight projections,
read from the contract file rather than copied into the test; a test over the
`bob_app` grants replacing the hand list in `20260902100300`; the two
`autobotz_bindings` absence checks in `slice0-schema` widened past `public`.

---

## Slice 2 · The projection read contract, 0.3

Draft 0.3 replaces 0.2 in `docs/contracts/projection-contract.md`. It is still a
draft: Henry signs it on BOB-6, and no migration is written before then.
Federico closed everything on his side on 10 Nov ("Write 0.3. Nothing is left
on Federico's side for the contract"). Every item below was checked against the
BOB-6 thread, and against BOB-10, BOB-12 and BOB-13 where they rule, before it
went into the draft.

### F-20 · Closed — Handoff §3.3 arrived, and it governs with five supersessions

§3.3 is section 3.3, "The tables", of `BOb_Implementation_Handoff_v1_2.docx`. It
was in the document set the whole time and never reached this build. It was
attached to BOB-6 on 10 Nov as `BOb_Handoff_3_3_The_Tables.md` (16,183 bytes,
md5 `eb89363d41da5c8e9f11df8c905d7f3c`, checked on download).

It is not committed here: it is reference material under the `Documentation/`
rule. The contract cites it by name and hash.

**Ruling (10 Nov):** §3.3 is authoritative for the column lists, except where a
later decision supersedes it. The supersessions are named, so that no stale part
ships unmarked:

| # | Where | Change |
|---|---|---|
| S1 | `proj_response_time` | C-15's OTel exponential histogram and `n`, `sum_ms`, `min_ms`, `max_ms` replace `sketch BYTEA`. Draft 0.2 already carried them |
| S2 | `proj_channel_health` | `latency_p50_ms` and `latency_p95_ms` are a defect, contradicting §3.3's own boxed note. They are replaced by the same histogram shape |
| S3 | `proj_channel_health` | `health_pct` dropped. Channel status is derived at read time as the worst breaching component |
| S4 | four tables | Columns from later rulings: `identity_rung_at_interaction` (D-12); abstained (A-09 as Relevo numbers it) and classifier-down counts; conversation-grain count-and-sum (D-15); `hist_scale` and `hist_offset` |
| S5 | prose | `actor_type`'s member value is `'user'`, as the schema has always said |

§3.3's "all six" is a miscount; there are eight. Federico's post counts "four
supersessions plus this fifth", with `health_pct` as the fifth. The table above
lists the same changes without relying on that count.

Seven [PROPOSED] column lists and the [PROPOSED] provenance names
(`computed_at`, `source_watermark`) are gone. The provenance names are §3.3's.

### Rulings written into 0.3

From BOB-6 unless stated otherwise.

- **D-12 (4 Nov).** A linkage rewrites a sealed bucket, by rebuild and never
  by patch. **Sealed means complete, not immutable.** The rebuild window is
  bounded by the linked identity's earliest interaction and by retention. It
  runs in the background, and alerts already fired are not re-evaluated.
- **Henry's catch on D-12, accepted 10 Nov as a defect in the ruling.** A rebuild
  from current identity state cannot recover the rung as it was. 0.3 names a
  dated linkage history and a rebuild test with a linkage inside the window.
- **D-03 (10 Nov).** A metric attributes to the actor that produced the event it
  counts. `handled_count` and `event_count` stop overlapping. `proj_actor_metrics`
  and CF-12 are unblocked.
- **`hallucinations` applies to all four actor types (10 Nov).** This reverses
  the ASA-only ruling of 5 Nov on BOB-12. It is stored as `hallucinations` and
  displayed as "Unfounded claims". It renders absent until D-29's knowledge
  notes give it a ground truth.
- **A-07 as Relevo numbers it (10 Nov).** "Who was affected" is a drill-through
  named in the contract, `affected_members(frame, filter)`, and not per-member
  projection rows. Members come back as rows and anonymous traffic as an
  interaction count: interactions, not visitors. D47 stays as signed. Henry's
  correction stands: for members, the ref is `attributes['miembro.id']`, not
  `entity_id`.
- **0.2 §11 Q1, Q2, Q8, Q9** closed with §3.3 and the Data Model. **Q10** closed
  with D-03 and A-07.
- **Q3.** A response-time window closes on the first turn from the other side,
  and consecutive same-side turns move its start. It is measured in both
  directions and attributed to whoever responded. It lands in the closing
  turn's bucket. It is **never merged across `actor_type`**, and that is a test,
  not a sentence. A gap is a response time or an abandonment, never both. There
  are three ways to detect an abandonment: explicit, superseded and idle. The
  idle bound is per channel.
- **Q4.** Liveness comes from the instrumentation heartbeat, declared per channel
  through `channel_capabilities`. No instrumentation means *not configured*
  (D-14's third state), which is different from not observed.
- **Q5.** Event time. The lateness bound is the channel's declared lag (D-25).
  Past the seal, a late event is a rebuild trigger.
- **Q6.** Unmapped events are emitted to the bus, not stored. A ninth table is
  ruled out because the event has no `org_id`, so the count of eight survives.
- **Q7.** The feeder creates each partition idempotently, in the function that
  grants it and enables RLS. That closes F-18's remaining half by
  construction. Nothing drops a partition before Slice 5, and **until then
  retention is not enforced**, which the contract now says outright.
- **`health_pct` (10 Nov).** Dropped. The ruling ends composing standard
  components into a stored percentage. For an API-mediated channel, health is
  the health of our integration. How many display states there are is a
  Slice 7 question.
- **BOB-10 (4 and 10 Nov).** `channel_capabilities (org_id, channel_id,
  capability)` is presence only and configuration, not projection. A guard
  asserts that no code path maps a channel type to capabilities.
- **BOB-12 (D-15).** The conversation grain lands in the bucket the conversation
  closed in. Resolution is closed without escalation for v1, with closing
  sentiment beside it, never blended. Coherence is deferred.
- **BOB-13 (10 Nov).** `actor_external_refs (org_id, actor_id, ref)`, `(org_id,
  ref)` UNIQUE, covers all four actor types. Agent refs are namespaced by the
  discovered `source_key`. An unmapped identifier never becomes an actor. The
  customer's own record is the authority for links, and BOb never infers one.

### The two homes the round left to us

Federico's last post names two items as "ours, not the contract's". 0.3 places
both, as proposals.

- **The per-channel idle bound.** It goes in `channels.idle_bound_seconds INTEGER`,
  nullable, no default, `CHECK (> 0)`, beside `lag_seconds`, and is exposed
  through `v_feeder_channel_map`.
  - Not in `channel_capabilities`: a number there is the `enabled` column C-16
    refused.
  - The feeder already reads per-channel declarations from that view, so it
    still reads exactly two things from BOb.
  - What NULL does is open (contract §11 Q11).
- **The never-merge-across-`actor_type` guard.** It is a Slice 2 guard in contract
  §10.
  - Structural half: `actor_type` is `NOT NULL` and part of
    `proj_response_time`'s key.
  - Behavioural half: every view or function discovered as reading
    `proj_response_time` returns `user` and `human` rows as separate
    distributions.
  - Slice 2 has no reader, so the behavioural half must not pass over nothing
    (contract §11 Q16).

### Where 0.3 departs from 0.2, and why

- **Columns follow §3.3:**
  - `proj_sentiment` uses `source IN ('orga','meca')` and `state` `s0`–`s4`,
    not four sources and five labels;
  - `proj_metric_counts` is keyed by `metric_id`, not by the
    `interactions`/`duration` columns 0.2 proposed;
  - `proj_channel_health` loses `events_received`/`events_rejected`.
- **`sealed` is stored**, as §3.3 has it, with a guard that it never disagrees
  with `source_watermark`. 0.2 derived it. Open as contract §11 Q1.
- **`proj_detections` and `proj_deliveries` are event-grained** in §3.3, with
  `correlation_id` on the row. So the grain CHECK and "no correlation_id in any
  projection" now apply to six tables. Open as contract §11 Q2.
- **No foreign key from `org_id` to `organizations`**, as in §3.3. 0.2's proposed
  cascade is withdrawn, and the F-19 sweep covers the fixture.
- **The partition function is `SECURITY DEFINER`.** `bob_feeder` owns no parent
  and cannot execute `bob_grant_projection()` (revoked from PUBLIC in
  `20260902100300`), so Q7's one function has to run as the owner. Proposed.

### Found while writing it — open on BOB-6

Sixteen questions are in contract §11. None reopens a ruling. Each is a place
where two sources disagree, or a ruling leaves a choice the contract has to
make. The ones that change a column, or would make code wrong:

- FR-22's average duration has no source in §3.3 (Q3).
- D-03 and Q3 attribute an abandonment differently, and a queue abandonment
  has no table (Q4).
- None of the six capabilities declares health, so "not configured" cannot be
  read from `channel_capabilities` yet (Q9).
- `error_rate` and `uptime_pct` are stored ratios (Q10).
- The bus that Q6 emits to is Slice 8 (Q12).
- Nobody may create a ghost member's actor (Q13).

**Letters that collide.** Relevo's A-07 and A-09 are not A-07 (Data Model §5.3)
and A-09 (`actor_shifts.status`) in this file. The contract says which it means
each time.

---

## Slice 2 · The projection read contract, 0.4

Draft 0.4 replaces 0.3 in `docs/contracts/projection-contract.md`, on the same
branch and PR. It is still a draft: Henry signs it on BOB-6, and no migration is
written before then. Federico closed all sixteen of 0.3's §11 questions on
11 Nov, Q4 at 06:08 and the other fifteen at 06:49, and wrote "Nothing is left
on Federico's side for this contract. Write 0.4". Every item below was checked
against those two posts before it went into the draft.

**One property runs through five of the answers.** A projection stores counts,
sums and distributions. It never stores a figure derived from them. That is the
reasoning that dropped the t-digest, `health_pct` and stored percentiles, now
reaching columns nobody had checked against it.

### Identifiers · the A-07 / A-09 collision, resolved

Federico left the numbering to this side. The rule: **this file is the register
of A-numbers, and a number here is permanent.** A ruling made on Relevo under a
number the register already uses is entered at the next free number, and cited
by that number from then on. A-10 is taken (`actors` carries ASA instance
counts). A-11 and A-12 are unused here and on Relevo (searched 11 Nov).

### A-11 · "Who was affected" is a drill-through named in the contract

Called A-07 on BOB-6. Raised 4 Nov and ruled 10 Nov:

- `affected_members(frame, filter)` returns members as rows and anonymous
  traffic as an interaction count.
- It is a named interface in the contract, not per-member projection rows.

Refined 11 Nov (Q15):

- The filter selects by `metric_id` through the feeder's own event mapping,
  plus optionally `actor_type` and `detection_id`, never `event_name`.
- It is a third deliverable of 3.7.
- A test asserts that member count plus anonymous count equals the cell's count.

Contract §7.3.

### A-12 · Abstained is counted, and is never a sentiment state

Called A-09 on BOB-6 (§3.3 supersession note 3). Ruled 10 Nov as a count beside
the five states. Moved on 11 Nov (Q6) to a `metric_id` in `proj_metric_counts`,
with `classifier_down` beside it. Contract §6.1.

### Rulings written into 0.4

- **Q4 · abandonment attributes to the side that owed the next turn.**
  - D-03's wording ("the actor holding the interaction when the customer left")
    is superseded. It named a bystander. Q3's attribution stands.
  - `abandoned_in_queue` is a second `metric_id`, always `user`. A constraint
    and a test assert the degenerate actor.
- **Q1 · `sealed` is stored**, because `lag_seconds` can change and a derived flag
  would un-seal history retroactively.
  - The guard moves to write time.
  - The sealing rule now includes the channel's declared lag. 0.3's guard
    ignored it.
- **Q2 · event grain confirmed** for `proj_detections` and `proj_deliveries`.
  C-11 is about ownership, not presence. `correlation_id` on `proj_deliveries` is
  the Slice 8 chain join and is recorded as deliberate.
- **Q16 · accepted.** The behavioural half reports `todo`, printed and counted in
  CI. The floor is part of A-05b's definition of done and lands in the first
  route handler's commit.
- **Q3 · duration is a second `measure`** in the duration table, which is renamed
  `proj_durations`. FR-22 gets a distribution. The never-merge guard extends to
  `measure`.
- **Q6 · `abstained` and `classifier_down` are `metric_id`s**, always `user`.
  Their `session_count` is the true denominator D-17's acceptance example needs.
- **Q7 · `closing_count`** sits on `proj_sentiment` beside `reading_count`. It is
  stored per state as counts, never a sum, for ORGA only.
- **Q8 · `proj_actor_metrics`.**
  - (a) The rung stays in the key, paired with `actor_type` by a constraint.
    `actor_type` is denormalised onto the row for that.
  - (b) `handled_count` is dropped in favour of a reserved `metric_id`.
  - (c) `metric_id` takes a CHECK.
- **Q10 · numerator and denominator.**
  - `error_n`/`request_n` and `uptime_seconds`/`observed_seconds` replace
    `error_rate` and `uptime_pct`.
  - `proj_channel_health` stores no derived figure.
  - The guard's grep gains `_rate` and `_pct`.
- **Q5 · an abandonment lands at the conversation's last activity**, for all
  three detections.
  - It usually arrives behind the seal, which is the rebuild path.
  - Lag shorter than the idle bound means constant rebuilds. Federico asked for
    a CHECK or at least a declared relationship.
- **Q9 · four health capabilities:** `health_latency`, `health_errors`,
  `health_uptime`, `health_disconnects`. Liveness comes from `health_uptime`.
- **Q11 · with no idle bound, refuse the metric, not the channel.** No
  `abandoned` rows are written, partial ones included, and it renders not
  configured.
- **Q12 · unmapped events are counted and returned, never stored**, until the bus
  in Slice 8. A test asserts zero against the fixture, after an injected
  unmappable event is seen to make it non-zero.
- **Q13 · the never-create rule splits by actor type.**
  - Unmapped agent and ASA refs are emitted, never created.
  - An unmapped member ref is a ghost, created by a BOb-side reconciliation as
    `bob_app`, never by the feeder. A guard restricts that path to `user`.
  - Ghost creation is a linkage event and triggers the rebuild.
- **Q14 · identity refs.**
  - `actors.external_ref` is dropped in Slice 2.
  - ASA refs are namespaced by the platform on the deployment record.
  - There is no source registry yet.
  - A guard forbids namespace literals in code.

### Choices 0.4 makes that the rulings left open

- **Rung for non-member actors** (Q8a: "the exact DDL is yours"):
  - the value is `'not_applicable'`;
  - `CHECK ((actor_type = 'user') = (rung <> 'not_applicable'))`;
  - a composite foreign key `(actor_id, actor_type)` to `actors`, which needs
    `UNIQUE (id, actor_type)` there.
- **The reserved metric** (Q8b) is named `handled`.
- **The degenerate actors** (Q4, Q6) and **ORGA-only `closing_count`** (Q7) are
  table CHECKs, each with a test that sees it refuse a bad row. The rulings asked
  for a test, and Q8 for a constraint rather than a convention, so both are
  carried.
- **Lag versus idle bound** (Q5) is a declared relationship, not a CHECK.
  - A CHECK forcing `lag_seconds >= idle_bound_seconds` would delay evaluation of
    every open bucket on the channel by the idle bound. On WhatsApp that is
    hours.
  - Slice 2 reports channels where the lag is below the bound.
- **The ASA namespace source** (Q14b) is `actors.provider`, the existing ASA-only
  column, as the candidate.

### Open after 0.4 — on BOB-6

Five, in contract §11. None reopens a ruling.

- **O1:** sealing on a channel whose lag is NULL.
- **O2:** which `actor_type` `interaction_duration` rows carry.
- **O3:** whether Q11's refusal reaches `abandoned_in_queue`.
- **O4:** where the ghost reconciliation reads unmapped member refs from, given
  that the feeder returns only a count in Slice 2.
- **O5:** the unit of the `affected_members` count equality (interactions or
  events).

---

## P5 · The application layer, inputs

Federico asked on BZZ-3 (10 Nov) for the whole application layer: the
projection schema, the three roles and their grants, and the migration
mechanism. The inputs are `docs/p5-application-layer.md`. The decision is a
BzzzBX one, numbered **D62** in the BzzzBX register (18 Nov; D60, first
promised for it on BZZ-19, was signed the same day for another decision), and
is unsigned. Nothing below writes a migration.

Reading the Slice 0 grants against the roles that will hold them turned up two
defects. Both were found by reading the migration, not by running it.

### F-21 · The feeder cannot read `v_feeder_channel_map`

`20260902100300` creates the view `WITH (security_invoker = true)` and grants
`bob_feeder` SELECT on the view alone. With an invoker view, Postgres checks
the base tables against the caller's privileges, so a read as `bob_feeder` is
refused on `channels`. Granting `channels` would not help: its RLS policy needs
an `org_id` claim, and the feeder needs the map across every tenant before it
knows the `org_id`. No test reads the view as `bob_feeder`.

**Proposed** (inputs §3.3): recreate both feeder views as definer views owned by
the migration owner, exposing only their named columns. Add a guard that reads
them as `bob_feeder` over the two-tenant fixture and is refused on the base
tables. **Disposition:** open, for the Slice 2 migrations.

### F-22 · The tenant policy refuses the feeder's writes

Contract §2 puts `org_id = (auth.jwt() ->> 'org_id')::uuid` on every
projection and partition. `bob_feeder` is `NOBYPASSRLS` and sets no claim, so
`WITH CHECK` refuses every insert.

**Proposed** (inputs §3.3): the feeder writes one tenant per transaction and
sets that tenant's claim with `set_config(…, true)`. The policy and the
contract stay as they are.
- `BYPASSRLS` is rejected: it removes the protection from the role that writes
  the most rows.
- A permissive policy for `bob_feeder` is rejected: it is what the tenancy
  suite's open-policy probe exists to catch.

A guard asserts that, holding tenant A's claim, a tenant B row is refused.
**Disposition:** open, for the Slice 2 migrations.

---

## Slice 2 · The projection read contract, 0.5

Draft 0.5 replaces 0.4 in `docs/contracts/projection-contract.md`. It is still
a draft: Henry signs it on BOB-6, and no migration is written before then.
Federico ruled O1 to O5 on 12 Nov (08:23), accepted the A-11/A-12 numbering and
the five choices 0.4 made, and asked for two things: §7.2 split into its two
routes, and the shape of the D-25 cut. Every item below was checked against that
post and against BOB-14's of 12 Nov (08:17).

### Rulings written into 0.5

- **O1 · NULL lag never seals.** Rows are still written and rendered; only
  sealing and evaluation stop. The channel is surfaced as "lag not declared",
  and Slice 2 reports a count of channels with NULL lag. Contract §4, §5.
- **O2 · `interaction_duration` is always `user`.** A conversation's length
  belongs to the conversation. Per-actor split would need a sum across
  `actor_type`, which the never-merge rule forbids. Third degenerate actor: a
  CHECK on `proj_durations` and a test. Per-actor held time, if wanted, is a new
  `measure`. Contract §6.3.
- **O3 · Q11's refusal does not reach `abandoned_in_queue`.** Queue abandonment
  is an explicit event and never reads the idle bound. Caveat: on Febor voice it
  is theory until the call-label problem resolves. Contract §9.2.
- **O4 · two routes, and the collision was in the ruling.** An unmapped event
  has no `org_id` (Q12 unchanged). An unresolved actor ref has one. The ghost
  reconciliation does its own windowed discovery as `bob_app`: no new table, no
  change to the feeder's grants, no dependence on the Slice 8 bus. Contract §7.2.
- **O5 · interactions on both sides.** The panel's "47 members" is distinct
  members, deliberately a different number from the one the test balances.
  Contract §7.3.
- **Accepted, no longer proposals:** `'not_applicable'` with the composite
  foreign key, `handled`, the table CHECKs for the degenerate actors and
  ORGA-only `closing_count`, lag versus idle bound as a declared relationship,
  `actors.provider` as the ASA namespace.

### Proposed in 0.5

- **§4.1 · the channel-lag section.** Voice at Febor is ~5–10 min end to end
  (1.5–6 min delivery and ~3.5 min Whisper, measured; the provider round trip,
  ~5 s median, is estimated and does not matter). It misses the 30-second
  watermark and the five-minute bucket with or without a provider. A voice
  channel's lag must cover the slowest leg behind any fact the eight tables
  read from it. Lag is declared from the measured tail, not the median.
- **§4.1 · the D-25 cut.** The cut is the seal. A customer turn still unlabelled
  when its bucket seals is counted as a new `metric_id`, `label_missing`
  (degenerate `user`). A label arriving after the cut is a late event and a
  rebuild. At seal, every customer turn is in exactly one of the five states,
  `abstained`, `classifier_down` or `label_missing`, and a guard asserts it.
  Three choices in it are open as C1–C3.
- **§7.3a · `member_refs_seen(frame)`.** What the reconciliation asks the truth
  store, as its own named interface. Open as O6 against `affected_members` with
  no filter.
- **§8.6 · two counts, not one.** The interim feeder returns unmapped events and
  unresolved agent and ASA refs separately. Unresolved member refs are in
  neither.

### Open after 0.5 — on BOB-6, as posted

- **C1:** where the cut sits (seal / second declaration / constant).
- **C2:** `label_missing` or folded into `classifier_down`.
- **C3:** a label after the cut rebuilds, or stays a failure.
- **O6:** `member_refs_seen` as its own interface, or `affected_members`
  without a filter.

### Ruled on 13 Nov — written into 0.5

Federico ruled all four on BOB-6 (13 Nov, 21:26) and accepted the two-count
proposal with one condition. He treated the 12 Nov 15:02 and 13 Nov 05:18 posts
as one round (same text). (a) on all four; where his reasons differ from the
draft's, his are the ones recorded, since the reason is what carries into the
next decision. The draft's own reasons are kept where they still hold.

- **C1 · the cut is the seal.** The draft argued "no new setting". The stronger
  reason: a per-channel `label_cutoff_seconds` makes a bucket complete for
  counts and incomplete for labels at once, so "sealed" means two things and
  every consumer must know which (two sources of truth about one fact, the
  defect `actors.external_ref` was dropped to avoid). It would also be two
  authored numbers per channel that must agree, with nothing asserting it. A
  channel whose labels need longer gets a longer declared lag. Cost, accepted:
  a classifier slower than the lag yields `label_missing` systematically until
  the lag is raised, a configuration error that shows in a product figure.
  (c) stays out on the idle-bound precedent. Contract §4.1.
- **C2 · `label_missing` is its own `metric_id`.** It follows from the 5 Nov
  finding that split `classifier_down` from `abstained`, one rung further out.
  Folding it into `classifier_down` asserts a cause nobody observed (the
  classifier, the drone, the relay, the merge step, or a link between them).
  The three absences have three owners: `abstained` tuning, `classifier_down`
  operations, `label_missing` plumbing. Contract §4.1, §6.1.
- **C3 · a label after the cut triggers a rebuild.** D-12's bounded rebuild
  already exists; (b) would store an arrival timestamp on every label and make
  the first reading final, so a classifier recovering from an outage would
  never repair its history. Alerts already fired stay, made a rule: un-firing
  is worse. Consequence stated: an alert can cite 12% while the panel reads 9%.
  The data to explain it exists (`computed_at` past the seal,
  `source_watermark`); no schema change. **Whether Slice 7 renders "this bucket
  was rebuilt after it sealed" is not decided here: it is one more input to
  D-33, which stays open.** Contract §4.1, §11.
- **O6 · `member_refs_seen(frame)`, its own interface.** The draft framed it as
  a fourth deliverable against reuse. The deciding factor is what
  `affected_members` is for: it sits on the reveal path (A-11/A-12, ID-04
  audit), and the reconciliation is an unattended scheduled job as `bob_app`.
  Not the same door; the narrow interface exposes less. Also: reuse would
  couple the two, and "no filter" does not scale from Febor's 482 members to
  eighty thousand. Cost: a fourth deliverable on 3.7. Contract §7.3a, §7.5.
- **Two counts until the bus · accepted, with an end condition.** O4 arriving
  at its consequence: the two routes are different failures with different
  owners, and one count re-merges them (the same objection as BOB-13's
  `pbx:h:…` against `pbx:42`). The condition: an interim shape must carry what
  changes when it ends, or it is correct-when-written. Written into §8.6: the
  interim ends when the Slice 8 bus accepts events from the feeder (X-10). In
  one change, under a new contract version, the feeder stops returning the
  counts and emits one event per failure (never both at once); the routes are
  two event kinds on the bus (shapes proposed); the §10 route guard is
  rewritten against the bus and seen failing first; the §11 interim row goes.
  Unchanged: member refs, the reconciliation, nothing stored, eight
  projections. Contract §8.6, §11.

`[PROPOSED]` markers removed for these: the cut's shape and the
`label_missing` name (§4.1), `member_refs_seen` (§7.2, §7.3a), the two counts
(§8.6). §10's "if C1–C3 stand" is gone. Markers that no ruling touched stay.

### Open after 0.5 — on BOB-6

- Nothing on Federico's side for 0.5.
- D-33 gains an input (C3); it stays open by design.
- Henry signs 0.5 on BOB-6. No migration before that.

## Slice 2 · The projection read contract, 0.5.1

Henry's review before signing (18 Nov). Read against the chain on `main`
(`roles_and_grants`, `actors`) and the 0.5 text. No ruling changes. Four
`[PROPOSED]` choices that no ruling touched each had a gap; they are tightened
and stay `[PROPOSED]`, tagged H1–H4, until the signature. The other four
markers (partition name, `latency_` prefix, the bus event shapes, the linkage
history table) stand as written.

- **H1 · the partition function refuses anything else (§3, §10).** It is
  `SECURITY DEFINER` and `bob_feeder` can call it. "Takes a parent from the
  eight and a month" said what it is for, not what it rejects: as written, any
  partitioned table could be handed to it and get a partition with the
  definer's grants. It now checks the parent by OID against the eight in `bob`,
  and the month as the first day of a UTC month, and raises otherwise. New
  guard, seen failing first.
- **H2 · "the measured tail" is p99 over seven days (§4.1).** Without a
  percentile, a window and an owner the rule could not be checked. The operator
  measures event time to arrival on the box; the figure, window and date are
  written beside `lag_seconds`. No measurement means no declared lag, and O1
  applies: an estimate is not a measurement.
- **H3 · the ghost window trails and overlaps (§7.2).** "Starts where the last
  run ended" needed a cursor, which "no new table" rules out, and a window
  starting exactly at the previous end misses a late member ref (voice, ~10
  min). Now each run covers `interval + L` (L = the tenant's largest declared
  lag); ghost creation is idempotent, so the overlap is free. A slower sweep
  over retention covers missed runs, raised lags and first runs. Its schedule
  and cost are open for 3.7 (§11); they do not block the signature.
- **H4 · `valid_to` is derived (§7.4).** `v_feeder_actor_map` listed
  `valid_to`; §9.4's `actor_ref_history` has `valid_from` only. The view derives
  it as the next `valid_from` of the same ref, NULL for the current row and for
  agent and ASA refs.

Also corrected here: the P5 section above said the decision "takes the next
free number"; it is D62.

### Open after 0.5.1

- H3's sweep: schedule and ClickHouse cost, for 3.7 on BOB-6.
- D-33 as after 0.5.
- Henry signs 0.5.1 on BOB-6. No migration before that.

---

## Slice 2 · The projection schema, built

Built against contract 0.5.1 as signed by Henry on Relevo task 6 (18 Nov),
branch `slice-2-projection-schema`. This is the first of two pull requests:
the schema, the partition function, the actor refs, the feeder views and every
§10 guard that needs no feeder. The reference feeder and the guards that need
rows it writes come in the second.

Three migrations:

- `20261118100000_bob_schema.sql`: the 27 tables and 2 views move from
  `public` to `bob`.
- `20261118100100_actor_refs_and_feeder_views.sql`: §9.2, §9.3, §9.4, §7.4,
  and the fix for F-21.
- `20261118100200_projections.sql`: the eight tables of §6 and
  `bob.proj_ensure_partition()` with H1's checks.

### Choices the contract left to the build

- **The functions stay in `public`.** GoTrue calls the access-token hook at the
  address in `config.toml`, and the suite and the application call the rest by
  name. Each function that reads a table gets `search_path = bob, public`. The
  two whose bodies named `public.users` (`handle_new_auth_user`,
  `custom_access_token_hook`) are recreated naming `bob.users`. The six
  availability functions had no pinned `search_path` and now have one.
- **Who reaches `bob`.** USAGE goes to the three roles, `authenticated` and
  `supabase_auth_admin`. `anon` and `service_role` get none (P5 inputs §3.2,
  §3.4). The table grants Supabase's defaults gave them in `public` are
  revoked on the moved tables, so a later USAGE grant cannot bring them back.
- **The tables are named in the move, and discovered in the guard.** A
  migration records what it did. The guard asserts that nothing is left in
  `public`.
- **`actor_ref_history` is append-only by trigger, not by grant.** Contract
  §10 asserts that `bob_app` holds SELECT, INSERT, UPDATE and DELETE on every
  non-projection. P5's matrix (proposed) withholds UPDATE and DELETE on the
  history instead. The contract wins over P5 where they differ, so the grant
  is uniform and a trigger refuses UPDATE, and any DELETE that is not a cascade
  from the organisation or the actor. The trigger also refuses a non-`user`
  actor (§9.4: members only). It binds every role, the owner included, which
  a grant does not.
- **`authenticated` gets on `actor_external_refs` and `actor_ref_history` what
  it has on every other configuration table.** Whether user reads go through
  PostgREST at all is A-05b's choice.
- **`v_feeder_actor_map` gives agent and ASA refs the rung `'not_applicable'`**,
  the value the feeder writes for them (§6.6 (a)). The feeder then holds no
  rule of its own about which actor types have a rung.
- **The partition function takes `(regclass, date)`.** A `date` has no zone,
  and the bounds are midnight UTC. A `timestamptz` does not resolve to it,
  because the cast to `date` is not implicit.
- **The partition name is `<parent>_yYYYYmMM`** (§3, `[PROPOSED]`).

### F-21 · Closed

Both feeder views are definer views (`security_invoker = false`), owned by the
migration owner. They expose their named columns and grant SELECT to
`bob_feeder` alone. Read as `bob_feeder`, both return rows from both fixture
tenants, and every other table and view in `bob` refuses it.

One more thing turned up: a definer view in `public` would have carried
Supabase's default `anon` and `service_role` grants. That would have handed the
cross-tenant channel map to the API's anonymous role. The grants are revoked
explicitly. A guard asserts that no role gains cross-tenant reach through
either view unless it could already read the tables behind it.

### F-22 · Closed in the schema; exercised by the feeder in the second PR

The policy is unchanged. As `bob_feeder`, holding tenant A's claim, a tenant A
row is accepted and a tenant B row is refused. With no claim, every write is
refused. A direct write to the partition is held to the same claim, because
the partition function gives every month its own policy.

### F-23 · The grain CHECK rounded — CLOSED in 0.5.2

§3 writes the CHECK as `extract(epoch FROM bucket_start)::bigint % 300 = 0`.
`extract` returns `numeric`, and the cast rounds. So `14:05:00.4` passes, and
becomes a second bucket next to `14:05:00` under the same primary key. The
migration takes the remainder of the exact epoch,
`extract(epoch FROM bucket_start) % 300 = 0`, which refuses it. On whole
seconds it accepts exactly what the contract's form accepts. A guard inserts
the fraction, and goes red against the contract's form (table below).
**Disposition:** accepted by Henry on 18 Nov and written into contract 0.5.2
§3.

### F-24 · §6.7 and §6.8 cannot be created as written — CLOSED in 0.5.2

`proj_detections` keys on `(org_id, detection_id)` and partitions by
`detected_at`. `proj_deliveries` keys on `(org_id, attempt_id)` and partitions
by `attempted_at`. Postgres requires the partition key in every primary key and
unique constraint of a partitioned table, so neither DDL runs. The options:

- **(a), built here, and accepted by Henry on 18 Nov.** Add the partition column to the
  key: `(org_id, detection_id, detected_at)` and
  `(org_id, attempt_id, attempted_at)`. Uniqueness then holds within a month,
  and a feeder that upserts on event time sees no difference.
- **(b)** Do not partition the two. That contradicts §3: all eight are
  partitioned, and retention is by partition.
- **(c)** Partition them with no primary key, and leave uniqueness to the
  feeder.

Henry accepted (a) with a condition, written into 0.5.2 as §8.7. An id's event
time never changes. If it did, (a) would hold two rows for one id. A guard
checks it (see "0.5.2" below).

### Found by the guards

- **`bob_app` held nothing on six tables inherited from Bob-New**:
  `baselines`, `interactions`, `metric_snapshots`, `patterns`,
  `rootcause_log` and `sentiment_readings`. The hand list in `20260902100300`
  had missed them since Slice 0. The discovered guard found them, and they are
  granted. The hand list stays in its migration, which is append-only, and the
  guard replaces it as the check.

### Verified by sabotage

Each defect below was applied alone to the database, these four files were run
(`slice2-schema`, `slice0-schema`, `tenancy`, `tenancy-meta`), and the defect
was undone. The red column lists what failed. No row came back with nothing red.

| Sabotage | Red |
|---|---|
| H1's two checks removed from the partition function | all five refusals: a ninth parent in `bob`, a same-named table in `public`, a configuration table, mid-month, last day of the month |
| The function skips `bob_grant_projection()` | run twice: one partition, granted, with RLS; a month of every projection passes PR-4; the `bob_app` grants |
| The function skips RLS and the policy | run twice; a month of every projection; a direct write to the partition is held to the claim |
| A projection renamed (a ninth name, one of the eight missing) | exactly eight, and every test that names that table |
| A table left in `public` | nothing BOb owns is left in `public` |
| `bob_app` loses DELETE on a configuration table | the `bob_app` grants |
| `bob_app` gains INSERT on a projection | the `bob_app` grants; PR-4 on the partitions; the tenancy suite's PR-4 test |
| The grain CHECK dropped | the grain CHECK is present; an off-boundary bucket is refused |
| The grain CHECK in the contract's `::bigint` form (F-23) | an off-boundary bucket is refused (the fraction) |
| A derived column, `error_rate` | no derived figures |
| `feeder_version` made nullable | provenance |
| `sealed` dropped | sealed is stored |
| A `tenant_slug` column | tenant key |
| `measure` taken out of the `proj_durations` key | never merged, structural |
| A view that reads `proj_durations` | never merged, behavioural: no longer `todo`, red until it is written |
| The degenerate-actor CHECK dropped | the four user-only metrics |
| The `interaction_duration` CHECK dropped | `interaction_duration` is user only (O2) |
| The closing-is-ORGA CHECK dropped | closing is ORGA |
| The rung-pairs CHECK dropped | rung pairs with type |
| The composite actor foreign key dropped | rung pairs with type (the type that differs from the actor's) |
| F-21 as found: the channel map back to an invoker view | as `bob_feeder`, both views return rows |
| A definer view granted to `authenticated` | no role but `bob_feeder` gains reach through the views |
| `bob_feeder` granted SELECT on `channels` | as `bob_feeder`, every other table refuses |
| F-22's rejected fix: a permissive policy for `bob_feeder` | tenant B refused under A's claim; no claim, refused |
| The history trigger disabled | the history is append-only, and members only |
| `valid_to` returned as NULL | the actor map derives `valid_to` (H4) |
| `autobotz_bindings` recreated in `bob` | pre-rename absence, now over every schema |

The two file guards, no namespace literal and no capability from channel type,
carry their own probes in the test file. Each probe shape must be reported,
and a source-key-built ref must not be.

### Not in this pull request

- **The reference feeder**, with the guards that need rows it writes:
  - sealed at write time;
  - every turn accounted at seal;
  - lag not declared, and the count of such channels;
  - unmapped is counted, by route (the two counts);
  - the ghost path through a `member_refs_seen` stand-in;
  - rebuild with linkage.
- **`affected_members` count equality.** It runs against 3.7's endpoint and
  waits for it.
- **`channel_capabilities` (§9.1) is not in the chain.** The guard against
  deriving capabilities from `channel_type` therefore has nothing in the
  schema to read yet. It reads every tracked file, with a probe, and will
  read the table's views and functions once they exist.
- **Where the p99 measurement of H2 is written** beside `lag_seconds` is not
  decided: a column or the operator's record. Nothing is added to the schema
  for it here.
- **The contract's status line** read "not published, not signed". 0.5.2
  corrects it.

**Counts.** The suite goes from 100 tests to 140: 139 pass and 1 is `todo`.
The `todo` is the behavioural half of the never-merge guard, as §10 requires.



## Slice 2 · The projection read contract, 0.5.2

Henry accepted both build findings from Slice 2's first pull request on 18 Nov
("Sí, acepto ambos"), relayed from the session he drives. 0.5.2 writes them
into the contract, in the same change as the migrations that already follow
them. No ruling changes.

- **F-24 → §6.7, §6.8.** The keys become `(org_id, detection_id, detected_at)`
  and `(org_id, attempt_id, attempted_at)`.
- **F-24's condition → §8.7, new.** For one id, the event time never changes.
  The feeder and 3.7 both owe it. A correction to an event's time is a new id.
- **F-23 → §3.** The grain CHECK is `extract(epoch FROM bucket_start) % 300 = 0`,
  with no cast.
- **§10 gains one row, and one row is extended.**
  - Event time is immutable (new).
  - Grain names the 14:00:00.4 case.
- **The status line** says what is true: 0.5.1 is signed, and 0.5.2 carries the
  two accepted corrections.

### The event-time guard, seen failing first

`eventTimeFindings()` in `tests/slice2-schema.test.mjs` groups each
event-grained projection by `(org_id, <id>)` and reports any group with more
than one time. The tables and their id columns are found from the primary key:
the key's columns, minus `org_id` and minus the partition column. They are not
listed.

| Sabotage | Red |
|---|---|
| The finding groups by the whole key, time included, so a second time is a second group | an id written with two times is reported, for both tables |
| The finding reads only `proj_detections` | the same test, for `proj_deliveries` |

The grain test now inserts 14:00:00.4 as well as 14:05:00.4. Under 0.5.1's
`::bigint` form 14:00:00.4 is accepted, and the test goes red on it. Under
0.5.2's form both are refused.

**Counts.** 140 → 142: 141 pass and 1 is `todo`.

### For 3.7

The keys, and the condition that comes with them, are what 3.7 implements
against. A draft note to Federico on Relevo task 6 is prepared for Henry, and
is not posted.

## Slice 2 · The reference feeder, built

The second pull request of Slice 2, against contract 0.5.2. It adds the
reference feeder (`feeder/reference-feeder.mjs`), an in-memory stand-in for the
truth store (`feeder/memory-truth-store.mjs`), the ghost reconciliation
(`reconciliation/ghosts.mjs`), one migration, and the §10 guards that need rows
the feeder wrote (`tests/slice2-feeder.test.mjs`).

What the reference feeder covers:
- §8's obligations over customer and business turns, ORGA labels, closes,
  detections and delivery attempts. It fills `proj_metric_counts`,
  `proj_sentiment`, `proj_actor_metrics`, `proj_detections` and
  `proj_deliveries`.
- It writes no `proj_durations`, `proj_channel_health` or `proj_rum_signals`
  rows. The fixture models no instrumentation for them, and the feeder writes
  no zeros it did not observe (§5).

How it works:
- One tenant per transaction, under that tenant's claim (F-22).
- Partitions through `bob.proj_ensure_partition`.
- Delete-and-refill of a five-minute-aligned window, so one code path serves
  the run, the replay and the rebuild (§8.5).
- `sealed` by the rule of §4; `label_missing` only at seal and only on
  channels declaring `orga_conversation` (§4.1).
- The two counts of §8.6 returned apart.
- §8.7 checked before the window is cleared, against everything stored for the
  tenant.

### F-25 · The feeder cannot see `orga_conversation` — CLOSED in 0.5.3

§4.1 writes `label_missing` only on a channel that declares `orga_conversation`
(§9.1). §7.4 gives the feeder exactly two views, and neither carries
capabilities. `channel_capabilities` was not in the migration chain at all.
Henry chose option (a), and the contract goes to 0.5.3 ("Opción (a), 0.5.3"):
- `bob.channel_capabilities` per §9.1, with RLS. SIUD goes to `bob_app` and
  `authenticated`.
- `v_feeder_channel_map` gains one column, `capabilities TEXT[]`. The column
  is the channel's capabilities, sorted. Still two views, still a definer view
  readable by `bob_feeder` alone (F-21).
- `tests/slice2-schema.test.mjs` asserts the new column list.

The other options put to Henry:
- (b) write `label_missing` everywhere and filter at read time. That writes a
  "zero" where §5 says "not configured".
- (c) defer the label cut.

§7.4 and §9.1 change in 0.5.3, in this pull request (the section below).

### F-26 · `bob_app` cannot name its tenant — accepted as a finding

The reconciliation runs as `bob_app` (§7.2), and needs the tenant's slug for
the `member_refs_seen` frame (§7.3a). `organizations` is readable under RLS by
`authenticated` and `supabase_auth_admin` only, so `bob_app` can neither list
tenants nor read a slug. That is right for a tenant-scoped credential.
- What was built: the reconciliation's scheduler hands it
  `(org_id, tenant_slug)`. It reads `channels` itself, under the claim.
- No grant was widened. Henry agreed that the reconciliation receives its
  list of `org_id`s from whoever schedules it.
- Who runs the scheduler, and from where it reads the tenant list, is a P5
  (D62) question.

### The declaration report

`bob.v_channel_declaration_gaps` is an invoker view, so each tenant sees its
own channels. It lists channels whose lag is not declared (O1: never sealed,
never evaluated) and channels whose lag is below their idle bound (§9.2). It
reports them and refuses nothing.

### Choices the contract left to the build

- **Conversation context.** A window that cuts through a conversation still
  needs the conversation's last ORGA state and its actors. The feeder reads
  24 hours before the window, and up to the watermark for labels that arrive
  after their turn. It keeps only the rows inside the window.
  - A conversation longer than 24 hours is the reference feeder's limit.
    3.7 keeps conversation state in the truth store.
- **The rung of a member** is taken at the member's turn, from the linkage
  history as of event time. The actor is the one the ref points to now
  (§6.6, D-12).
- **`handled`** is one per actor per interaction, at the close's bucket.
- **Ghost display ids** are `GH-` and twelve hex digits of a hash of
  `(org_id, ref)`. They are stable for a ref and carry nothing about the
  person.
- **Ghost creation and linkage return the window to rebuild**, aligned to five
  minutes, starting at the ref's first `valid_from`.
- **§8.7 is stricter than "reported".** The feeder refuses the run for that
  tenant, and the transaction rolls back.

### Verified by sabotage

Each case was applied to the feeder, to the reconciliation or to the database.
Then `tests/slice2-feeder.test.mjs` was run, and the change was undone.

| Sabotage | Red |
|---|---|
| Sealing ignores the declared lag | every bucketed row is sealed exactly when its channel lag and watermark say (**first run: nothing red**, see below) |
| NULL lag seals (O1 dropped) | the website writes rows and none of them is sealed |
| `label_missing` written before the seal | `label_missing` exists only at seal |
| An unlabelled turn is not counted as `label_missing` | the accounting adds up; the withheld label lands in `label_missing` |
| Label accounting written on every channel | no label accounting on a channel that does not expect labels (**first run: nothing red**, see below); `label_missing` on a channel with `orga_conversation`, never on one without |
| No label accounting even with `orga_conversation` | the accounting adds up; `label_missing` only at seal; `label_missing` on a channel with `orga_conversation`, never on one without; the withheld label |
| The two counts summed into one | an unmappable event moves route A only |
| An unresolved member ref counted in route B | zero against the fixture; the three injections |
| The rung taken from the current mapping, not event time | the rung stays as it was at event time |
| §8.7 check removed | an id that comes back with another time is refused |
| §8.7 check after the window delete | the same test: a rebuild could move an id inside its own window |
| F-22: every tenant written under the first tenant's claim | every insert runs under the claim of the tenant it writes, and the rest of the file |
| The watermark stamped as the time of the run | sealed at write time; provenance; replay; render identical |
| A replay inserts without clearing its window | replay; the injections; the late label; the linkage rebuild |
| A ghost created at rung `identified` | member refs only, all at rung ghost, never a non-user actor |
| The reconciliation creates a non-user actor | the same test, and the rest of the ghost path |
| The trailing window ignores the declared lag (H3) | the window trails by interval plus the largest declared lag |
| The declaration report drops undeclared lag | the declaration report names the channel, per tenant |

**Two guards were blind on their first run, and were rewritten.**
- *Sealed at write time* compared each row to the feeder's own `isSealed()`.
  It asked the feeder whether the feeder was right, so it passed any rule the
  feeder chose. It now writes §4's rule again in SQL.
- *`label_missing` only where labels are expected* looked at `label_missing`
  rows only. With the sabotage, voice got zero-valued `abstained` and
  `classifier_down` rows, and its one bucket was unsealed. The guard now
  refuses any label accounting, including orga sentiment, on a channel
  without `orga_conversation`.

### Found by the guards

- **The capability-from-type guard** (Relevo task 10) flagged this pull
  request's own migration. The comment on `channel_capabilities` named
  `channel_type` ("never mapped from channel_type"). The guard reads tracked
  files only, so it saw the migration once it was committed, and CI went red.
  The comment was reworded. A guard that matches on words cannot tell a
  derivation from a sentence that forbids one, and that is the trade it makes
  on purpose: a human looks.

### F-22, exercised

The feeder writes tenants A and B in separate transactions. A wrapper on its
connection asserts that every `INSERT` carries the `org_id` of the claim set in
that transaction. A run under one claim for both tenants is refused by RLS,
and the guard goes red.

### Not in this pull request

- The bus emission of the two counts (§8.6's end condition, Slice 8).
- The sweep's schedule, and its cost on ClickHouse (H3, for 3.7).
- `proj_durations`, `proj_channel_health` and `proj_rum_signals` rows: no
  fixture instrumentation.

**Counts.** 142 → 167: 166 pass and 1 is `todo`.

## Slice 2 · The projection read contract, 0.5.3

Henry chose option (a) for F-25 ("Opción (a), 0.5.3"), relayed from the
session he drives. 0.5.3 writes it into the contract, in the same change as the
migration that already follows it. No ruling changes.

- **F-25 → §7.4.** `v_feeder_channel_map` gains `capabilities TEXT[]`. It holds
  the channel's capabilities, sorted, and is empty when the channel declares
  none. The feeder still reads two views.
- **F-25 → §9.1.** `channel_capabilities` is created in Slice 2. `bob_app`
  writes it, under RLS by `org_id`.
- **§10.** The accounting row names both sides of the capability.

### The capability guard, seen failing on both sides

The fixture gains t9: an unlabelled customer turn on voice at 14:02. Voice
declares no `orga_conversation`, and its 900 s lag seals the 14:00 bucket at
14:20. Only the capability can keep `label_missing` out of it. On the other
side, t4 is unlabelled on WhatsApp, in a sealed bucket.

| Sabotage | Red |
|---|---|
| The feeder ignores the capability | `label_missing` on a channel with `orga_conversation`, never on one without (voice writes) |
| The feeder looks for a capability no channel declares | the same test (WhatsApp does not write), and the accounting guards |

**Counts.** 167: 166 pass and 1 is `todo`.

### For 3.7

The new column of `v_feeder_channel_map` is what 3.7 reads to know where
`label_missing` is written. A draft note to Federico on Relevo task 6 is
prepared for Henry, and is not posted.

## P5 · The role guards, built

The three guards of P5 §6.3 that Slice 2 did not build, and the two guards that
the answer to objection 3 (P5 §8) proposes. No migration and no contract change.
- `tests/p5-roles.test.mjs`: three roles and no more, `bob_ai_ro` reads views
  only, no egress, and the tests of the box check.
- `scripts/box-checks.mjs`: the queries. Shared by the suite and the box.
- `scripts/box-check.mjs`: the read-only check a customer box runs after its
  migration step (P5 §6.2).
- `feeder/reference-feeder.mjs`: the `boxTenant` option. Its guard is in
  `tests/slice2-feeder.test.mjs`.

### What each guard asserts

- **Three roles, no more.** Every role that holds anything in `bob` is found
  from the catalog: ownership, grants on the schema, relations, columns,
  sequences and functions, default privileges, and membership. Membership
  counts with or without INHERIT, because a member can SET ROLE. Leaving out
  `pg_*` and Supabase's own roles, what is found must be exactly `bob_app`,
  `bob_feeder` and `bob_ai_ro`. Equal, not a subset, so finding nothing is red.
  - The check covers NOLOGIN roles too. In the repository the three are
    NOLOGIN, so a check restricted to LOGIN roles would read an empty set. A
    LOGIN role is held to the same rule.
  - The three are NOSUPERUSER, NOBYPASSRLS, NOCREATEDB and NOCREATEROLE
    (§3.2), and none is a member of any other role.
  - Supabase's roles are a fixed list. It fails closed: a role missing from it
    is reported, never passed.
- **`bob_ai_ro` reads views only.** As `bob_ai_ro`, every base table and
  partition refuses SELECT and UPDATE, in every schema that is not a catalog.
  - The set of tables is checked first against every `org_id` table and the
    tenancy floor.
  - Writes on other columns, and INSERT, DELETE and TRUNCATE, are read from the
    catalog.
  - No `v_ai_*` view exists yet. The guard asserts that what `bob_ai_ro` can
    read equals the `v_ai_*` views. Today that set is empty, and with no views
    the role reads nothing at all, which is checked rather than assumed. When
    a view appears, it must be readable.
- **No egress.** Over the functions of `pg_net` and `http`, found by their
  extension dependency wherever they are installed: none of the three holds
  EXECUTE, PUBLIC included.
  - A second test installs both in a transaction that rolls back, `http` in
    an unexpected schema, and asserts that discovery finds both.
- **One organization per box.** `organizations` has exactly one row, and its
  `slug` is the box's `bzzz.tenant`.
  - Where it lives: in `scripts/box-check.mjs`, not in the suite, because the
    fixture holds two tenants on purpose.
  - P5 §6.2 already names "a read-only check against the box" after the
    migration step, as the migration owner, the one credential that can read
    `organizations` across RLS. The script runs in one `READ ONLY`
    transaction, and it also runs the two role guards that need no fixture.
  - The suite tests the check: it refuses the fixture, passes with one
    organization whose slug matches, and refuses a wrong slug, none, or no
    tenant given.
- **The feeder sends a foreign tenant to route A.** Run with `boxTenant`, every
  event of another `bzzz.tenant` is counted in route A and never mapped. That
  holds even when BOb holds a channel for that tenant. The box tenant's rows
  are identical to a run for it alone.
  - A run without `boxTenant` must write tenant B, so the test cannot pass
    against a fixture with nothing to refuse.

### F-27 · `pg_net` and `http` are executable by PUBLIC once installed — closed by (c)

P5 §3.2 says `pg_net` and `http` "are not granted to any of the three". Measured
on the local Supabase, which runs the same image as CI, by installing both in
a transaction that was rolled back:
- every function of both extensions is executable by PUBLIC, so all three
  roles can call them (12 in `pg_net`, 19 in `http`);
- schema `net` gives USAGE to PUBLIC, and `bob_ai_ro` can read `pg_net`'s
  tables.

Neither extension is installed locally or in CI, so the guard over what is
installed is green. What protects BOb today is "not installed", not "not
granted". Self-hosted Supabase installs `pg_net` for webhooks, and whether the
box has it has not been checked. The box check prints which egress extensions
are installed.

The installed case is in the suite as a `todo` that fails. The options put to
Henry:
- (a) leave it as it is: the guard covers what is installed, and the `todo`
  stays until there is a decision;
- (b) a migration that, where the extensions are installed, revokes EXECUTE
  from PUBLIC and grants it back to Supabase's roles only. A later install is
  not covered;
- (c) the guard requires that neither extension is installed.

**Decided** (Henry, 2026-11-20, relayed): **(a)**. The guard checks effective
EXECUTE, PUBLIC included, on `pg_net` and `http` wherever they are installed.
It runs in CI and in the box check. The rolled-back install probe stays in CI as
a `todo`. How F-27 closes, (b) or (c), stays open until it is known whether
`pg_net` is already on lab-02. The lab-02 rehearsal kit has to check that
(P5 §6.2).

### Verified by sabotage

Each change was applied to the database or to the code. The suite was run, and
the change was undone.

| Sabotage | Red |
|---|---|
| A LOGIN role with USAGE on `bob` | three roles, no more |
| `bob_app` BYPASSRLS | the same |
| `bob_feeder` a member of `service_role` | the same |
| A role holding only a default privilege in `bob` | the same |
| A role holding only a column grant | the same |
| The Supabase list widened to swallow every role | a fourth role is reported |
| Membership read as USAGE (a NOINHERIT member missed) | the same |
| `bob_ai_ro` SELECT on `channels` | every base table refuses SELECT; reads exactly the `v_ai_*` views |
| `bob_ai_ro` UPDATE on `alerts` | every base table refuses UPDATE (**first run: nothing red**, see below) |
| `bob_ai_ro` UPDATE on one column that is not the first | no write privilege on any column |
| `bob_ai_ro` INSERT on `alerts` | the same |
| A `v_ai_*` view `bob_ai_ro` cannot read | reads exactly the `v_ai_*` views (granted, it goes green) |
| Base-table discovery narrowed to `public` | the base tables found include every tenant table |
| `http` installed, committed | none of the three can execute, as installed |
| `pg_net` installed, committed | the same, and three `bob_ai_ro` tests (its tables) |
| The feeder ignores `boxTenant` | boxed to tenant A; boxed to a tenant BOb does not hold |
| `boxTenant` filters but does not count | the same |
| `boxTenant` not passed through to the projection | the same |
| The box check against the two-tenant database | exit 1: `organizations holds 2 rows` |

**One guard was blind on its first run, and was rewritten.** The UPDATE probe
wrote `SET c = c`. Reading `c` needs SELECT, so the probe was refused even with
UPDATE granted, and it passed. It now writes `SET c = DEFAULT WHERE false`,
which needs only the UPDATE grant. Because the probe touches one column per
table, a catalog check covers the other columns.

**Not seen failing.** If the egress filter ignored PUBLIC, nothing in CI would
go red, because nothing is installed there. That is F-27, and the `todo`
covers it until F-27 closes by (b) or (c).

**Counts.** 167 → 186: 184 pass and 2 are `todo`.


## Slice 3 · The absent-not-zero state, spec (proposed for 0.6)

Decided by Henry in the Slice 3 grill on 20 Nov (G1 to G15), from the thin
Performance matrix (Bob-New PR #29) read over the reference feeder's output.
The spec is `docs/slice-3-absent-not-zero.md`. **Nothing is built and the
contract stays at 0.5.3.** The seven changes below are proposed for 0.6. They
go to Federico on Relevo task 6, and the draft note is prepared for Henry and
is not posted. They are written into the contract when accepted, in the Slice 3
implementation PR.

### F-28 · §5, §8 · Liveness has two sources; the feeder writes the observed zero

The matrix showed no zero at all. §5 ties liveness to `health_uptime`, and no
channel declares it, so "not observed" and "observed, none" were both "no row".
- **Traffic**: an interaction with activity in the bucket is evidence of
  liveness for that bucket, for every capability the channel declares.
- **Probe**: Q9's `health_uptime` stays the source when there is no traffic.
- At seal, the feeder writes the zero: `proj_metric_counts` with
  `event_count = 0` and the bucket's `session_count`, and `proj_durations` with
  `n = 0`. Never on an undeclared capability, never without liveness.
- 3.7 owes it as much as the reference feeder does.

### F-29 · §9.1 · Three capabilities

Disambiguation, escalations and abandoned in queue had no capability, so they
could never render not configured. With F-28 they would have received zeros
that nobody observed. New: `disambiguation`, `escalation`, `queue`. Presence
only, declared per channel, never mapped from `channel_type`. The catalog goes
from ten capabilities to thirteen. Mapping them from `channel_actor_mix` was
refused: two actors present does not prove a handoff path.

### F-30 · §9.1 · The union becomes union plus coverage

"The drill-down reads the union of capabilities" let Voice leave the
label-failure total unannounced. The union now decides whether a row is shown.
The total sums only the observed cells and carries coverage: "n of m channels",
with each excluded channel and its state and reasons.

### F-31 · §5 · The cell vocabulary and where it lives

Six states, evaluated in order: `not_applicable`, `not_configured`, `pending`,
`not_observed`, `observed`, plus `off_shift` in the per-actor drill-down.
- An ordered list of reasons. `provisional` is a flag on `observed` (O1 keeps
  unsealed rows rendered).
- D-14's markers come first: `telemetry_started_at` (D-18) and
  `bob_source_key_unset()` (D-19, SR-2).
- The em dash serves both `not_observed` (D-14) and `off_shift` (Relevo task
  10), told apart by state, never by glyph.
- It lives in the database: `bob.v_cell_state`, `bob_cell_rollup()` and
  `v_ai_cell_state` for BObee. The application only paints.

D-14 is applied, not amended.

### F-32 · §5 · A declared-absent actor is an observed zero

FR-11 asks for exactly 0 when an actor is absent from every selected channel,
and UI-03 asks every zero to explain itself. A `present = false` row in
`channel_actor_mix` gives `observed` 0 with `actor_not_present`. An undeclared
mix gives `not_configured` with `mix_not_declared`, which is the PR-10 split
FR-23 already uses.

### F-33 · §6.1 · Three metrics never attribute to `user`

Resolved, disambiguation and escalations attribute to whoever did them, and
§6.1 did not forbid the customer. The cells are `not_applicable` under `user`,
and a guard fails if the feeder ever writes such a row.

### F-34 · §7.2 · AREP ref resolution is open

"Inherits the ASA shape when it exists" leaves how an AREP ref resolves
unwritten. Slice 3 needs nothing more: AREP cells follow the same rules, and
the matrix shows the column only when some selected channel declares AREP
present. Named as open, outside Slice 3.

---

## P5 · The lab-02 rehearsal kit, built

P5 §6.2 owes two things before the first window: the rehearsal on lab-02, and a
written procedure for a migration that fails. Objection 2 settled the procedure
(fix forward; otherwise restore `bob` alone and rebuild). Objection 5 set the
rehearsal on lab-02, and objection 6 moved the migration credential to a file
of its own. This change builds the kit. Henry runs it; nothing here has run on
a box.

- `scripts/ensayo-migracion-lab.sh`, with `--dry-run`, `--ejecutar` and
  `--deshacer`. It refuses any host that is not `bzzz-lab-02`, a CLI that is
  not the one CI pins, a credential file not at mode 600, and a box that
  already has `bob`.
- `docs/p5-failed-migration-procedure.md`, the procedure.
- `scripts/ensayo-migracion-lab/probar-local.sh`, which runs the kit end to end
  on a disposable copy of lab-02's identity stack (the same Postgres and
  GoTrue digests as Bzzz `compose/l6-supabase.yml`), and sees each check fail.
- Bzzz `scripts/backup.sh` gains `bob.sql.gz`, a dump of `bob` without
  `proj_*` data, checked against the live counts. That is its own pull request
  in Bzzz.

### Measured on the box's image (`supabase/postgres:17.6.1.136`, CLI 2.120.0)

- **The CLI runs each migration file as one transaction.** A rigged file
  without `BEGIN … COMMIT`, among the nine old unwrapped ones, created a table
  and then raised. Afterwards the table did not exist, and the version was not
  recorded. A rigged file wrapped in `BEGIN … COMMIT` behaved the same.
  The files before the failing one stayed applied and recorded, and nothing
  after it ran. P5 §6.2's worry about the nine unwrapped files does not arise
  with this CLI. The kit checks it on every run, because another CLI version
  could differ.
- **`auth` is untouched** by every push, by the drop and by the restore of
  `bob`. The kit compares a hash of `auth`'s shape and rows at every step.
- **`DROP SCHEMA bob CASCADE` reaches nothing outside `bob`.** 44 objects, all
  in `bob`. BOb's functions in `public` survive it. The trigger on
  `auth.users` survives it too. While `bob` is gone, creating a portal account
  fails, because that trigger writes `bob.users`.
- **`bob.sql.gz` restores `bob` exactly**, as `supabase_admin` in one
  transaction: owners, grants, default privileges, the two definer views, the
  `SECURITY DEFINER` functions, policies, triggers, constraints, indexes,
  sequences, comments and every row outside `proj_*`. The publication
  membership is the exception (F-36).
- **The reference feeder rebuilds the projections identically**, row for row,
  `computed_at` aside.

### F-35 · `GRANT <role> TO current_user` terminates the server on the box's image — finding

On `17.6.1.136`, with `supautils` loaded, `GRANT bob_feeder TO current_user`
run as `postgres` ends every connection, and the server goes through recovery.
Naming the role (`GRANT bob_feeder TO postgres`) works. The CI image (15.x)
does not crash.

- Where it matters: `tests/slice2-feeder.test.mjs` and `tests/p5-roles.test.mjs`
  use `TO current_user`. Neither runs on a box (§6.2), so CI is not affected.
  The kit's Node helper names the role.
- On a box it would take down the portal's logins with it. The procedure lists
  it under "never done".
- Not changed here: the suite. If the CI image moves to 17.x, those tests will
  need to name the role.

### F-36 · `pg_dump -n bob` does not carry the publication membership — finding

`bob.alerts`, `bob.anomalies`, `bob.metric_snapshots` and
`bob.sentiment_readings` are in `supabase_realtime`. `pg_dump -n bob` writes no
`ALTER PUBLICATION … ADD TABLE`. After a restore the tables are back, but
Realtime no longer sees them, and nothing reports an error.

- The fix, in both places: Bzzz `backup.sh` writes `bob_publicaciones.txt`
  beside the dump, and the procedure adds the membership back from it. The kit
  does the same, and its fingerprint covers publication membership.
- Seen failing: with the membership not added back, the fingerprint differs.

### F-37 · CI applies the chain on Postgres 15, and the boxes run 17.6 — finding

`supabase/config.toml` and CI use `major_version = 15`. lab-02 runs
`supabase/postgres:17.6.1.136`. Measured: the whole chain applies cleanly on
17.6, and on that image the migration role `postgres` is not a superuser, has
CREATEROLE and has BYPASSRLS. F-35 is a difference between the two that CI
cannot see. Moving CI to 17.x is not part of this change; it is for Henry to
decide.

### What the kit records, and how each check was seen failing

The bench (`probar-local.sh`) runs the kit against the local copy, then once
per sabotage, and undoes each run with `--deshacer`.

| Sabotage (`ENSAYO_P5_SABOTAJE`, local only) | Red |
|---|---|
| The rigged unwrapped file does not fail | the push exits non-zero |
| A table left behind in `public` | the wrapped rigged file left nothing |
| The restore skips the data | every configuration and live-state row comes back |
| A definer view made `security_invoker` after the restore | the fingerprint of `bob` is identical |
| `proj_ensure_partition` made `SECURITY INVOKER` | the same |
| The publication membership not added back | the same |
| The projections not rebuilt | the rebuilt projections equal those before |
| A fourth LOGIN role with USAGE on `bob` | box check: three roles, no more |

The refusals each exit 2: a CLI that is not CI's, a credential file at 644, a
wrong password, `--objetivo lab-02` on another host, a sabotage switch outside
`local`, and `--ejecutar` on a box that already has `bob`. The bench also
checks that the migration password appears in no evidence file.

**F-27 on lab-02.** The kit records, read-only, whether `pg_net` or `http`
is installed or only available, in which schema, and how many of each one's
functions PUBLIC can execute. It does so in preflight (also on `--dry-run`)
and after the chain, and installs nothing. It also
runs `scripts/box-check.mjs`. On the rehearsal box no tenant is provisioned,
so "one organization" fails on purpose; the kit counts only the role guard and
the egress guard.

**Not rehearsed.** Removing the `schema_migrations` rows of versions newer than
the dump (procedure §4.4), recreating `bob.users` rows for accounts made after
the dump (§4.5), and a fix-forward migration with `--include-all` (§3). The
procedure marks each one.


## Slice 3 · The spec's review, corrections (proposed for 0.6)

PR #27 merged on 20 Nov before its review was addressed. The review
(PR #27, comment of 20 Nov) found two blocking contract gaps, four design gaps
and one wording point. The two blocking gaps are corrected in the spec and
here. The rest are questions R3 to R7 for Henry, in the spec's §11. Nothing is
built, and the contract stays at 0.5.3.

### F-28, corrected · Metrics with a precondition get no zero

As written, F-28 would have written `event_count = 0` in two cases where
nothing could be measured:
- `hallucinations` on a channel that declares `hallucination` but has no
  ground truth (D-29);
- `abandoned` on a channel whose `idle_bound_seconds` is NULL.

That breaks §5. `v_cell_state` would mask them, but `bob_app` and
`authenticated` read the tables directly, so the exclusion belongs in the write
rule. The list is explicit and closed:
- `hallucinations` gets no zero, ever, under F-28. The feeder cannot see the
  ground truth through its two views.
- `abandoned` gets no row while the bound is NULL, which is §9.2 as it stands.

A guard compares the feeder's list with the catalog's preconditioned metrics.
The label failures stay under §4.1.

### F-38 · §7.4 · The feeder learns which actor types are present

A zero row carries an `actor_type`, and the feeder cannot see
`channel_actor_mix`. `v_feeder_channel_map` (migration `20261119100000`)
exposes the lag, the idle bound and the capabilities, and §7.4 limits the
feeder to two views.

**Proposed:**
- the view gains `actor_types TEXT[]`: the channel's mix rows with
  `present = true`, sorted, and empty when none is declared present;
- zeros are written only for those actor types, and only for applicable pairs
  (§6.1 with F-33);
- degenerate metrics write `user` only;
- a declared-absent actor gets no row: its observed 0 comes from the mix.

This is F-25's pattern, and the feeder still reads two views. Fixing the actors
per metric was refused, because it writes zeros for actors nobody declared.

### F-31, reworded · D-14 is extended

F-31 said "D-14 is applied, not amended". It is extended. D-14's three states
become six (`not_applicable`, `pending` and `off_shift` are added), and F-31
should be signed as a change to D-14.

### Decided by Henry on 21 Nov (spec §11)

All five were decided with the recommended option:
- **R3:** `pending` on a no-row cell follows today's lag. This is accepted and
  written down. §4's rule protects stored history, and a cell with no row
  stores nothing. A test raises a lag and asserts that only the cells inside
  the new window change.
- **R4:** the mechanism is a set-returning function,
  `bob_cell_state(org, channels[], from, to)`. It is invoker, under RLS. It
  replaces the view `v_cell_state`, which would have enumerated thirteen
  months.
- **R5 → F-39 · §9.1, §6.3:** `interaction_duration` requires `resolution`.
  It lands at the close, and `resolution` declares that a close exists.
- **R6:** `v_ai_cell_state` is a definer view, owned by the migration owner
  and granted to `bob_ai_ro` alone. It reads the function for the current day,
  filters explicitly on the caller's `org_id` claim, and never exposes
  `display_name`. The tenancy suite and the P5 guard cover it. This is the
  shape of F-21.
- **R7:** `no_channels_selected` becomes `not_applicable`, with its own
  reason. This changes G9.

### Second read of the spec, 21 Nov

Four mistakes in the spec itself, corrected. No contract change, and nothing
for 3.7.
- **A declared-absent actor would have rendered as `not_observed`.** It has no
  row, and none is written (F-38). The no-row steps came before it, so they
  took it. It is now step 3, before `pending` and `not_observed`. FR-11 is
  tested in sealed and unsealed buckets.
- **`mix_not_declared` would have hidden the label failures.** Those rows are
  written for `user` whatever the mix says (§4.1). The reason no longer
  reaches the degenerate metrics: the customer is present in every
  conversation.
- **`pg_depend` does not see inside a plpgsql function.** With R4 the
  mechanism is a function, so the single-implementation tests would have had
  nothing to read. The functions use SQL-standard bodies (`BEGIN ATOMIC`,
  Postgres 14 and later), and a guard checks it.
- **Two leftovers from the view:** the rollup's signature, and UI-03's
  "the whole view".

### The 0.6 notice already posted

The notice on Relevo task 6 (20 Nov) carries F-28 as first written and says
D-14's markers come first without saying D-14 is extended. The correction
(F-28 corrected, F-38, F-39, F-31 reworded) was posted there on 21 Nov, by
Henry's order.

---

## P5 · Q6 reopened: the feeder runs the ghost reconciliation

Henry, 2026-11-21: «El feeder». The ghost reconciliation asks the truth store
(ClickHouse) for `member_refs_seen` (`reconciliation/ghosts.mjs`), and P5 §5.2
keeps the BOb application off `bzzz-data`. So the 19 Nov answer to Q6, a timer
in the BOb container, could not read what it reconciles. The feeder container
already reads ClickHouse and runs it instead. This changes a P5 answer. D62
is still unsigned.

### F-40 · The feeder cannot run the reconciliation as built without a new grant — finding

- As built on `main` (`742aa37`), the reconciliation runs as `bob_app`, one
  tenant per transaction under the `org_id` claim. It reads `channels` and
  `actor_external_refs`, inserts into `actors`, `actor_external_refs` and
  `actor_ref_history`, and deletes the `actors` row it made when it loses a
  race. `linkMemberRef` updates `actor_external_refs`.
- `bob_feeder` holds none of that, by design: Q13 (11 Nov) says the feeder
  never creates an actor, and P5 §3.2 gives it no grant on `channels` or
  `actors`.
- **No grant was widened, and no code or migration changed.** The options
  put to Henry, in P5 §7, Q6:
  - **(a) recommended:** the feeder writes `member_refs_seen` into a new `bob`
    table (INSERT only, under the tenant's claim), and `bob_app` reconciles
    from it in the BOb container. Q13 stands. One table, one INSERT grant, one
    migration, and an amendment to contract §7.2 and §7.3a;
  - **(b)** a `SECURITY DEFINER` function the feeder calls. It needs no table
    grant, but it reverses Q13 in substance;
  - **(c)** the feeder container also holds `bob_app`. It needs no grant, but it
    is a second reader of `bob/app.env` (P5 §4);
  - **(d)** widen `bob_feeder` on the actor tables and `channels`. It reverses
    Q13.
- **Answered** (Henry, 2026-11-21): «Go with (a)». Not built yet. Building it
  needs the table, its INSERT grant to `bob_feeder`, the migration, the change
  to `reconciliation/ghosts.mjs` (read the table, not `truth.memberRefsSeen`),
  the feeder's write, and the contract amendment to §7.2 and §7.3a.

## P5 · Q6 (a), built: the feeder stages the member refs, `bob_app` makes the ghosts

Henry, 2026-11-21: «Go with (a)» (F-40; P5 §7, Q6). Built on branch
`p5-q6a-staged-member-refs`, on top of PR #29, not merged and not applied to
any box. D62 is still unsigned.

What was built:
- `supabase/migrations/20261121140000_member_refs_seen.sql`: the table
  `bob.member_refs_seen` (`org_id`, `channel_id`, `ref`, `first_seen`,
  `last_seen`, `window_from`, `window_to`, `staged_at`), RLS by the `org_id`
  claim as on every tenant table, and the grant helper
  `bob_grant_feeder_staging()`. INSERT for `bob_feeder`, SELECT and DELETE for
  `bob_app`, nothing for anyone else. `channels` gains `UNIQUE (id, org_id)`
  so the staged row's channel key carries its tenant.
- `feeder/reference-feeder.mjs`, `stageMemberRefs`: for each channel BOb maps,
  it asks the truth store for `member_refs_seen` over `[from, to)`, leaves out
  the refs `v_feeder_actor_map` already maps, and stages the rest. One tenant
  per transaction under its claim (F-22). It honours `boxTenant` (objection
  3). A replayed window stages nothing twice.
- `reconciliation/ghosts.mjs`: reads the table instead of
  `truth.memberRefsSeen`, still as `bob_app`, one tenant per transaction. It
  consumes the staged rows in its window with one `DELETE … RETURNING`, so a
  failed run leaves them staged. The guard stays: member refs only, rung
  `ghost`, never a non-`user` actor, the refs BOb knows subtracted. The
  trailing window of H3 stays, and the sweep keeps the 395-day retention
  window (C-14). The sweep also deletes staged rows last seen before
  retention, with no ghost. The functions no longer take a truth store, and
  the tenant is `{ orgId }`: the slug was only for the truth store's frame.

### F-41 · Contract §7.2 and §7.3a: the reconciliation's window comes from `bob.member_refs_seen` — proposed

- **§7.2** said the reconciliation "runs as `bob_app` … it asks the truth
  store which member refs were seen in the window", with "no new table" and
  "no change to the feeder's grants". Under Q6 (a) the feeder asks, and
  stages; `bob_app` reads the window from the table and deletes what it
  consumed. One new table, and one new grant: INSERT for `bob_feeder` on it.
- **§7.3a.** The frame, the output and the paging are unchanged. The caller is
  the feeder, with its read-only ClickHouse role, not the BOb application. For
  3.7 the deliverable is the same; who calls it is not.
- **§7.4.** Unchanged: the feeder reads exactly two views. It writes the
  staging table and cannot read it.
- **§10.** A new guard row, "Staged refs", and the ghost path row now reads
  through the table.
- Written into `docs/contracts/projection-contract.md` marked
  **[PROPOSED, F-41]**, with the replaced text struck through. The version
  stays 0.5.3 until it is accepted. Sent to Federico on Relevo task 6 on
  21 Nov, by Henry's order, with the question on the window CHECK; the turn
  is his. It went up twice by mistake (13:31 and 13:32, identical), and a
  short note there says to read the first.

### How the guards find the table

- **By its grants, not its name.** A feeder staging table is a base table,
  outside the `proj_` names, that `bob_feeder` can write (after the review:
  INSERT, UPDATE, DELETE or TRUNCATE) and cannot SELECT from (`feederStagingTables()` in `tests/helpers/rls.mjs`). Every one
  found is held to exactly INSERT for `bob_feeder`, SELECT and DELETE for
  `bob_app`, and nothing for `bob_ai_ro`, `anon`, `authenticated`,
  `service_role` or PUBLIC, on the table and on every column
  (`stagingGrantFindings()`). It must carry `org_id`.
- **PR-4's discovery** took any table the feeder can write as a projection.
  It now leaves out a table the feeder cannot read; a `proj_` table stays a
  projection by name whatever its grants. Granting the feeder SELECT on the
  staging table turns it back into a projection, and PR-4 reports it.
- **Q13.** An INSERT grant on `actors` to `bob_feeder` makes `actors` look
  like a staging table, and the staging rule reports it, since `bob_app`
  holds INSERT and UPDATE there.
- **`bob_app` grants (§10).** The discovered staging tables are the third
  kind: SELECT and DELETE.
- **Tenancy (ID-10).** The leak checks read every tenant table as
  `authenticated`. A table `authenticated` cannot read cannot leak to it, and
  reading it would only raise, so the checks leave such tables out. A new
  test pins that set to the staging tables: a table that loses its grant by
  accident appears there instead of vanishing from the leak checks.
- **"The feeder reads nothing else" (F-21)** is unchanged, and passes: an
  INSERT grant gives no read.

### Seen failing

Each guard was seen red before it was trusted. Measured on the local
Supabase, one sabotage at a time, each reverted before the next. A run is
the five files that touch the table: `p5-q6-member-refs`, `slice2-schema`,
`slice2-feeder`, `tenancy` and `p5-roles`. The column says what went red.

| Sabotage | Red |
|---|---|
| None (the baseline) | nothing (the F-27 `todo` only) |
| Before the migration: the table does not exist | every test in `p5-q6-member-refs` |
| `bob_feeder` SELECT on the table | found as staging; SELECT is refused; exactly eight (it became a projection) |
| `bob_feeder` UPDATE | every staging table holds exactly its grants; UPDATE is refused |
| `bob_feeder` DELETE | the same; DELETE is refused |
| The policy ignores the claim (`USING (true)`) | a tenant B row refused; no claim refused; `bob_app` sees and deletes its own tenant only; every `org_id` table has a tenant-scoped policy (ID-10) |
| The channel key without `org_id` | a tenant A row naming a tenant B channel is refused |
| `authenticated` SELECT | exact grants; `authenticated` refused; the API-unreadable set is the staging tables (ID-10) |
| `bob_app` INSERT | exact grants; `bob_app` INSERT refused; `bob_app` grants (§10) |
| `bob_feeder` INSERT on `actors` (Q13) | exact grants (`actors` reported); `bob_app` grants (§10); the API-unreadable set |
| `bob_feeder` loses INSERT | found as staging, and every test that writes as the feeder |
| Another tenant table unreadable to `authenticated` (`channels`) | the API-unreadable set is the staging tables, and only those (ID-10) |
| The reconciliation reads the rows and does not delete them | the ghost path, four tests: what it consumed is still staged |
| No retention clamp | the sweep makes a ghost for a ref past retention; the trailing window |
| The reconciliation ignores its trailing window | the trailing window (H3); the sweep |
| The feeder stages refs it already maps | it leaves out the refs it maps; the ghost path; the claim and box tests |
| The feeder ignores `boxTenant` when staging | boxed to tenant A, nothing of tenant B is staged |
| PR-4's discovery without the staging exception | not a projection; exactly eight; partitions granted; `bob_app` grants; provenance; PR-4 (tenancy) |

One test was wrong on its first run and was corrected, not loosened. "PUBLIC
given SELECT" expected the staging rule to report it. A grant to PUBLIC is a
grant to `bob_feeder` too, so the table stops being staging and becomes a
projection by its grants, and PR-4 reports `bob_app` holding DELETE on it.
The test now asserts that.

Where it ran: `supabase db reset --no-seed` and `pnpm test` on the local
stack, after rebasing onto `main` (`9b900a1`): 264 tests, 261 pass, 0 fail,
3 `todo`. The full chain was also reset on a second, separate local stack
before the rebase. Nothing was run against any box.

### Review of PR #33 — fixed on the same branch

Two reviews, one from the peer session and three points from Henry («Send
them to fix»). Every fix landed test first, and every new guard was seen red.

- **Discovery (high).** A staging table was a table the feeder could INSERT
  into and not read. A DELETE on `actors` fell through both discoveries. Now
  any write counts (INSERT, UPDATE, DELETE or TRUNCATE, on the table or a
  column), and the staging rule reports the extra privilege.
- **Grantees (medium).** `stagingGrantFindings()` read the roles it named.
  It now also reads every grantee from the table's and its columns' ACLs, and
  a role it does not know is a finding.
- **Ref shape (medium).** `ref` is held to `^m:.` and 256 characters by a
  CHECK, and `isMemberRef()` in `reconciliation/ghosts.mjs` checks it again
  before a ghost is made.
- **A run leaves a mark (low).** `bob.member_refs_runs`, a second staging
  table: one row per tenant per run, even with nothing staged, in the same
  transaction as the last batch. `stagingRunWarnings()` in
  `scripts/box-checks.mjs` warns on a tenant with no run or an old one, and
  `box-check.mjs` prints it as a warning that does not fail the check
  (`--staging-max-age-hours`, default 24).
- **A test that could not fail (low).** "A second run creates nothing" now
  stages a known ref by hand and asserts the reconciliation creates nothing
  and consumes it.
- **Expiry before the early return (low).** The sweep now expires by
  retention even for a tenant with no channel. Unreachable today: the channel
  key cascades, and `source_key` is NOT NULL. No test, said so here.
- **Per-tenant errors.** One tenant's failure is returned as `error` on that
  tenant, without a run row, and the others stage.
- **Cadence (Henry).** Contract §7.2 now says the feeder stages the trailing
  window at least as often as `bob_app` reconciles. A row staged later than
  that waits for the sweep: a delay, not a loss. A test stages one behind the
  window and sees the frequent run leave it and the sweep take it.
- **Sweep size (Henry).** `stageMemberRefs` writes as it reads, `batchSize`
  rows per transaction (2,000 by default), each under the claim. The counts it
  returns are unchanged.
- **`service_role` (Henry).** `bob_grant_feeder_staging()` had EXECUTE
  revoked from PUBLIC, `anon` and `authenticated` only. `service_role` is
  added. The migration had not run anywhere shared (it is not on `main`), so
  it was edited in place. A test reads the function's ACL and accepts its
  owner alone.

**For Federico, not changed.** The table refuses a row whose `first_seen` is
before the window asked for or whose `last_seen` is at or after its end. That
holds if §7.3a's `member_refs_seen` reports first and last seen *within* the
frame. If ClickHouse reports them over all time, every such tenant's staging
fails (and is reported, without stopping the others). Which it is decides
whether the CHECK stays. To ask on Relevo task 6 with the F-41 notice.

Seen failing, after the review (shared local stack, one at a time, each
reverted):

| Sabotage | Red |
|---|---|
| Tests written, code not yet changed | 13: discovery finds both tables; DELETE on `actors`, UPDATE (`actor_id`) on `actor_external_refs`, TRUNCATE on `actor_ref_history`; an unknown role's table and column grants; the ref CHECK; `isMemberRef`; the three run-row and warning tests; a run row per tenant; per-tenant isolation |
| `service_role` given EXECUTE on the helper | the helper is executable by its owner alone |
| The feeder writes in one transaction | more refs than one batch are written in several transactions |
| The frequent run ignores its trailing window | the late-staged ref waits for the sweep; H3; the sweep; the known-ref test; the batch test |
| The reconciliation trusts any staged ref | the reconciliation's own check agrees with the table's |
| The feeder writes no run row | one run row per tenant per run; the batch test; F-22 |
| One tenant's failure stops the rest | a failing tenant is reported and the other stages |

Where it ran: `supabase db reset --no-seed` and `pnpm test` on the shared
local stack: 279 tests, 276 pass, 0 fail, 3 `todo`. Nothing was run against
any box.

---

## Slice 6 · Registries and the outbox, built

Three migrations, `20261121100000` to `20261121100200`, and
`tests/slice6-registries-outbox.test.mjs`. RS-30 to RS-35 are cited by ID only:
the Behavioural Rules document is internal and this repository is public.

### D-31 · Closed — what BOb writes, and when it refuses to write

Settled in the scope map and built here. BOb never executes and never holds a
customer credential; it writes an intention to `bob.outbound_queue` and
something else transmits it.
- **Limits at write time.** `rate_limit_per_hour` (rolling hour),
  `invocation_cap_daily` (rolling 24 hours) and `concurrency_limit` (written and
  not yet drained) are checked when the intention is inserted, under a lock on
  the binding. With ten an hour, the eleventh is refused. The intention's time
  is the database's, so it cannot be backdated out of the window.
- **Approval.** A binding with `requires_approval` gets its intention written
  `awaiting_approval`. Nothing drains that state and nothing leaves it.
  Approving one is not in v1.
- **A limit before attaching.** An Action response cannot attach a mutative
  binding that declares neither `rate_limit_per_hour` nor
  `invocation_cap_daily`, and an attached binding cannot lose its limit.
  `concurrency_limit` does not count: it bounds how many run at once, not how
  many there are.
- **The causing alert.** `alert_log_id` is NOT NULL and keyed by organization.

### Choices the build made — for Henry

1. **Moved webhooks are ruled on the refusing side.** BR-3 never asked these
   entries whether they change the world. They move `mutative = true`,
   `requires_approval = true`, with the reason in `verify_msg`. The migration
   rules on nothing in the other direction. Nothing moves on the chain as it
   starts.
2. **The move stops and names rows** for a webhook entry without exactly one
   address, for an Alert or Alarm response that sends to a webhook, and for an
   Action response that does not name exactly one webhook of its own
   organization.
3. **Exempt attachments.** A moved webhook attached before migration 2 has no
   limit. It is exempt from the attach rule, the same way the BR-3 constraint
   exempted rows that came before it, and migration 3 refuses an intention for
   it anyway. The query that lists them is in migration 2.
4. **A failed verification is a `warning`** in `alert_log` (`alert_type
   'verification_failed'`, `autobotz_id` set). RS-25 asks that an execution
   failure be as prominent as a threshold breach; this is a verification
   failure, and the severity is open.
5. **The freshness window is 30 days**, one function
   (`bob_autobotz_freshness_window()`), taken from the original migration's
   comment.
6. **The stub drain runs as `bob_app`**, under the box's single claim. Which
   role the real transmitter holds is a P5 question, not a fourth role.
7. **`proj_deliveries.outbound_id` still has no foreign key.** The outcome
   joins the outbox by value, and the read-back test joins it.

### ID-11 completes (F-05)

`threshold_configs`, `anomaly_rules` and `text_rules` gain `scope_kind`
(default `company`) and `scope_ref`. The tenancy test discovers every table
with `scope_kind`, has a floor of four, requires each to be a tenant table, and
needs tenant B to own a company-scoped row in each. The two-tenant fixture gains
one row per tenant in the three tables.

### Not testable until execution exists

The outbox drains to a stub (`outbox/stub-drainer.mjs`), the stub reports a
`delivery_attempt` event, and the reference feeder writes it to
`proj_deliveries`, read back as `bob_app`. That a drained intention reaches a
real provider and its outcome returns is a `todo` in the suite, stated rather
than claimed. Execution must not be switched on before the emission slice.

### Consumer impact

`response_rules.webhook_url`, `webhook_method` and `webhook_payload` are
dropped, and `notification_channels` refuses `type = 'webhook'`. Any client
that wrote those columns or that type needs to follow (the F-11 lesson). Bob-New
is outside this repository and was not changed.

### `supabase test db`

The bare command fails on `main` too: it runs `supabase/tests/fixtures/*.sql`
as pgTAP and finds no plan. pgTAP now lives in `supabase/tests/database/`, and
CI runs `supabase test db supabase/tests/database`.

### Verified by sabotage

Each change was applied to the database, or to a copy of the code, then the
suite was run and the change undone.

| Sabotage | Red |
|---|---|
| The rate check removed from admission | the eleventh is refused; no backdating |
| Approval ignored on admission | written awaiting approval; the read-back |
| The drain takes `awaiting_approval`, transition guard off | the same, and "moves once" |
| The RS-32 trigger off | four RS-32 cases |
| The RS-33 trigger off | both RS-33 cases, and RS-35 (the failure changes no table) |
| Stale never derived | RS-30 (both), RS-31 |
| The attach-limit trigger off | attached only with a limit |
| The picker not security-invoker | RS-34 (shows another tenant) |
| The outbox without RLS | ID-10 structural (discovered, no new code) |
| Scope discovery pinned to `public` | ID-11 discovery floor |
| The move forgets inline webhooks | the replayed move |
| A column `api_token` | the credential guard (a test of its own) |

**One guard was wrong on its first run.** The credential pattern took `token`
anywhere and reported `bobee_conversations.token_count`. Now it matches `token`
only at the end of a name. And the cross-tenant attach probe was
refused by the limit rule before the tenant key could refuse it. It now gives
tenant B's binding a limit first, so only the key is left to refuse.

**Caught in CI by an existing guard.** The stub built its ids as
`` `stub:${id}` ``, which slice2-schema's namespace-literal guard refuses.
Locally the guard ran before the stub was tracked, so it never saw the file. The
stub now uses the intention's id with no namespace.

**Counts.** 186 → 221: 218 pass and 3 are `todo`. pgTAP: 9. After the review below: 230, 227 pass, 3 `todo`.

---

## Slice 6 · An independent review of the pull request, applied

The three Slice 6 migrations were edited in place, not appended to. They have
run nowhere shared (the local stack only), so the append-only rule does not
apply yet. Each fix went test first, and each new guard was seen failing.

### Fixed

1. **No DELETE on the outbox.** `bob_app` and `authenticated` held DELETE on
   `outbound_queue`. Deleting an intention gave its binding room under its
   limit again and lost the trace from intention to alert. Both lose DELETE and
   TRUNCATE. A guard discovers every table that keys `alert_log` and refuses
   DELETE and TRUNCATE to the application's roles. The F-19 grants test now
   expects SELECT, INSERT and UPDATE on those tables.
2. **Only `bob_app` updates an intention.** `authenticated` could
   `SET state = 'drained'` directly, which made the drain's REVOKE meaningless.
   UPDATE is now `bob_app`'s alone, and the "moves once" test runs as `bob_app`.
3. **Only Verify writes a verdict (RS-30, RS-31).**
   - `verify_state`, `verified_at` and `verify_msg` are no longer writable by
     `bob_app` or `authenticated`: INSERT and UPDATE are granted per column,
     without those three.
   - A binding is born unverified, whatever an INSERT says.
   - A verification time in the future is refused. Dated ten years ahead, a
     binding would never go stale.
   - `bob_autobotz_record_verification()` no longer takes a time. It stamps
     `clock_timestamp()`, runs SECURITY DEFINER, and scopes itself to the
     caller's claim.
   - A column added to `autobotz` later gets no grant until a migration gives
     it one.
   - The F-19 grants test now reads INSERT and UPDATE per column.
4. **The statement's clock.** Admission stamps `created_at`, and measures the
   hour and the 24 hours, with `clock_timestamp()`, and the drain stamps
   `drained_at` the same way. Under `now()`, a long transaction dated its
   intentions at its own start.
5. **No write skew between attaching and removing a limit.** The attach
   trigger takes `FOR SHARE` on the binding before it checks. The order is the
   fix: the review asked for the lock, and taking it after the check would
   still lose the race.
6. **Concurrency, tested.** Two `bob_app` connections: with a limit of one an
   hour, the second of two concurrent intentions is refused. An attach and a
   limit removal cannot both win. The "one transaction" test now checks the
   file's statements (BEGIN first, COMMIT last, nothing else), and a replay
   that fails at its last step leaves no binding and no repointed response.

### Verified by sabotage, after the review

| Sabotage | Red |
|---|---|
| DELETE on the outbox to `bob_app` | the trace guard; F-19 |
| UPDATE on the outbox to `authenticated` | the trace guard; drain directly as a tenant |
| UPDATE (`verify_state`) to `authenticated` | the verdict-column guard; claiming a verification directly |
| INSERT not forced to unverified | the state and its time cannot disagree |
| A future verification time allowed | the same |
| Admission stamping `now()` | the clock is the statement's |
| Admission without `FOR UPDATE` on the binding | the concurrent limit of one |
| The attach trigger without `FOR SHARE` | attach and limit removal cannot both win |
| Verify not scoped to the claim | cannot reach another tenant's binding |
| A `COMMIT; BEGIN;` inside the move | the file is one transaction |

### Questions for Henry (from the review, not changed)

- **An Action with an inline `webhook_url` and another organization's id in
  `channel_ids`.** The move counts the inline one as the single webhook and
  leaves the foreign id in `channel_ids`. Should it refuse instead?
- **RS-32 and scope.** Changing `scope_kind` or `scope_ref` does not invalidate
  a verification, because scope says where a binding applies, not what it
  invokes. Is that the reading?
- **The stub drains before it reports.** `drained` is committed before any
  `delivery_attempt` exists, so if the stub dies in between, an intention is
  drained with no outcome. The real transmitter will have to answer this.
  Should the outbox carry a claimed state?
- **Admission does not look at `verify_state`.** An unverified, failed or stale
  binding still gets intentions. Should one need to be verified, and fresh?

**Counts.** 221 → 230: 227 pass and 3 are `todo`. pgTAP: 9.


## Slice 6 · Henry's rulings on the review, 21 Nov

PR #26 merged (`d86eb08`) with all four checks green. Henry answered the four
questions and two of the seven build choices:

- **Admission needs a verified, fresh binding — ruled (a), built.** Migration
  `20261121100300` replaces `bob_outbox_admit()`: a binding that was never
  verified, failed its last verification, or is stale gets no intention. The
  state is the derived one (RS-31), read with the statement's clock. An edit
  that invalidates a verification (RS-32) stops new intentions until Verify
  passes again. Intentions already written are not touched. Seen failing first
  (the two new tests accepted the intention before the migration).
- **A claimed state in the outbox — deferred to P5.** The stub still marks
  `drained` before the `delivery_attempt` exists. The real transmitter answers
  this; it stays open here.
- **Severity of a failed verification — stays `warning`** (build choice 4). It
  is a verification failure, not an execution failure; RS-25 covers execution.
- **Inline webhook with a foreign id in `channel_ids`, and RS-32 and scope —
  kept as built.** Henry did not ask to change either.
- **Merge** authorized by Henry, done at the reviewed head.

Consumer impact: Bob-New, or anything that writes intentions, must call Verify
and get `ok` before the first intention, and again after any edit to the binding.

**Counts.** 230 → 232: 229 pass and 3 are `todo`. pgTAP: 9.


## Who may sign in to a box · bob.users for bob_app

bob-web in a box answers 403 to a GoTrue account with no row in `bob.users`, or
with `active = false` (Henry, 21 Nov: "no row, 403"; Bob-New PR #30). Until now
`bob_app` held table grants on `bob.users` and no policy reached it (P-1 of that
PR), so every read came back empty and nobody could have signed in.

Henry's rulings, 21 Nov:

- **bob_app reads its organization's users and stamps `last_login_at`.** Nothing
  else: no insert, no delete, no change to role, `active`, email, name or
  organization. Migration `20261121130000`, policies `app_reads_org_users` and
  `app_stamps_org_login`, both by the claim's `org_id`.
- **The signup trigger goes.** `on_auth_user_created` copied `org_id`, `role` and
  `full_name` from a new account's `raw_user_meta_data`, which the person signing
  up writes. Anyone who could sign up could pick an organization and `admin`, and
  "no row, 403" would never fire. Dropped with its function. Existing accounts
  and rows are untouched.
- **Provisioning is a script the operator runs**, `scripts/provision-user.mjs`,
  with the migration owner's credential (`bob/migrador.env`), never the service
  role. It finds the GoTrue account by email, which must already exist; puts its
  id into the organization whose slug is the tenant, as `admin`, `analyst` or
  `viewer`; is dry unless given `--ejecutar`; and can `--desactivar`. It
  refuses, and writes nothing, for an unknown account or tenant, a row in
  another organization, or another role.
- **The box check warns** (does not fail) when the organization has no active
  user: a box just migrated has none until someone is provisioned.

### F-42 · §10 · bob_app's grants on bob.users — contract change

§10 gives `bob_app` SELECT, INSERT, UPDATE and DELETE on every non-projection
tenant table. `bob.users` is now the exception: SELECT, and UPDATE of
`last_login_at` only, because who may sign in is the operator's to write. The
§10 grants test names it (`SIGN_IN` in `tests/slice2-schema.test.mjs`).

### F-43 · bob.audit_log · bob_app is granted writes that RLS refuses — closed, revoked

`audit_log`'s only policy is `org_audit_read`, FOR SELECT. `bob_app` holds
INSERT, UPDATE and DELETE on it (§10), and RLS refuses all three. Not changed
here. To rule on: revoke the writes (an audit log nobody in the app writes or
edits), or add an INSERT policy for `bob_app` (the app appends, never edits).

### The guard that would have caught it

`structuralFindings` now also reports a tenant table that `bob_app` is granted
and that no policy reaches: for SELECT, per command (an UPDATE policy does not
let a read through, and an empty read is how sign-in broke); for writes, any
policy reaching the role. Discovered from the catalog, not listed. A `bob_app`
policy must constrain `org_id` like a public-facing one. A new test reads every
discovered tenant table as `bob_app` under one tenant's claim and finds no other
tenant's rows. F-43 is why writes are checked more loosely: per command,
`audit_log` would be red today.

### Verified by sabotage

| Sabotage | Seen red |
|---|---|
| Drop `app_reads_org_users` | the users read test; the structural guard (only after it checked SELECT per command: the UPDATE policy had hidden the gap) |
| `app_reads_org_users` `USING (true)` | the structural guard; the cross-tenant read as `bob_app` |
| Grant `bob_app` INSERT and UPDATE (role) | the "cannot create or change" test |
| Put the signup trigger back | both signing-up tests |
| Silence the box warning | the box warning test |
| Commit on a dry run | the dry-run test |
| A table granted to `bob_app` with only an `authenticated` policy; a `bob_app` policy `USING (true)` | the two new meta probes, in `public` and in `bob` |

**Counts.** Node: 9 new tests in `tests/users-access.test.mjs`, 1 in
`tests/tenancy.test.mjs`, 4 meta probes. pgTAP: 6 new (15 in all).


## F-43 · closed: bob_app reads audit_log and writes nothing

Ruled by Henry on 21 Nov: revoke. Migration `20261121150000` revokes INSERT,
UPDATE, DELETE and TRUNCATE on `bob.audit_log` from `bob_app`, which keeps
SELECT. The initial schema meant this from the start: its only policy is
`org_audit_read`, FOR SELECT, and nobody in the application writes the trail.

- **§10 again.** `audit_log` joins `bob.users` as a named exception in the
  grants test (`READ_ONLY`, SELECT only).
- **The guard now checks writes per command too.** With F-43 closed, nothing
  needs the looser rule: a write granted to `bob_app` with no policy for that
  command (or ALL) is reported, like a read. New meta probe: an INSERT granted
  with only a SELECT policy, in `public` and in `bob`.
- **Seen failing first.** Before the migration, the new probe and pgTAP's
  "bob_app writes nothing to bob.audit_log" both failed. The green run is CI's:
  the shared local stack (`bob-v1`) had been removed by the time the migration
  was written, and no other stack was touched.
- `authenticated` still holds table-level writes on `audit_log` that RLS
  refuses. Not changed here.


## F-43 · second half: members write nothing to audit_log either

Ruled by Henry on 21 Nov. Migration `20261121160000` revokes INSERT, UPDATE,
DELETE and TRUNCATE on `bob.audit_log` from `authenticated` (Supabase's default
grants), which keeps SELECT under `org_audit_read`. pgTAP's
`audit_log_read_only` gains the case; it failed before the migration and passed
after, on the shared local stack (18 of 18).

Looking for the same pattern turned up two more and one larger thing, none
changed here:

- `authenticated` also holds INSERT, UPDATE and DELETE that RLS refuses on
  `bob.users` (only SELECT policies; F-42 made `bob_app`'s side exact, not this
  one) and on `bob.baselines` (deny-all on purpose).

### F-44 · `authenticated` holds TRUNCATE on 26 tables in `bob` — closed, revoked

TRUNCATE does not go through row-level security. `authenticated` holds it on 26
tables in `bob`, among them `organizations`, `users`, `actors`, `alert_log` and
`interactions` (Supabase's default grants, carried by the move to `bob`). It is
not reachable today: PostgREST never issues TRUNCATE. Anything that ever runs
SQL as `authenticated` (an invoker function with dynamic SQL, a direct
connection) could empty every tenant's rows in one statement, which ID-10 calls
a defect whether or not a path exists yet. `anon` holds it on none.

To rule on: revoke TRUNCATE from `authenticated` on all of `bob` (and the
default privileges that hand it out), with a discovered guard that no
application-facing role holds TRUNCATE on a tenant table.


## F-44 · closed: no role the application runs as can TRUNCATE

Ruled by Henry on 21 Nov: revoke, and stop handing it out. Migration
`20261121170000`:

- revokes TRUNCATE on every table in `bob` from PUBLIC, `anon`,
  `authenticated`, `bob_app`, `bob_feeder` and `bob_ai_ro`. Only
  `authenticated` held it (26 tables, no partitions); every other privilege is
  untouched;
- stops the migration owner's default privileges in `public` from giving
  TRUNCATE to `anon` and `authenticated`, which is where the 26 got it.

Two discovered guards in `tests/tenancy.test.mjs` (helpers in `rls.mjs`):

- no role in `NEVER_TRUNCATES` holds TRUNCATE on any table carrying `org_id`,
  in any schema, partitions included, read with `has_table_privilege` (PUBLIC
  and role membership count);
- the migration owner's default privileges hand TRUNCATE to none of them, in
  `public` and in any schema that holds a tenant table. Supabase's own schemas
  (`storage` keeps such a default) hold no tenant table and are left alone.

Seen failing: both guards before the migration (the 26 tables; the default in
`public`); the meta probes, in `public` and in `bob`, for a granted TRUNCATE and
a default one (in `public` the probe also shows `anon` getting it by default);
and, after the migration, three sabotages: TRUNCATE back on `users` for
`authenticated`, TRUNCATE on `actors` to PUBLIC, and the `public` default back.
pgTAP 18 of 18 on the shared local stack; the suite's clean run is CI's.


## F-47 · restoring `bob` alone dropped what depends on it outside `bob` — closed in the procedure

Found running the P5 lab-02 rehearsal kit locally on `main` (`a5bfc7f`) on
21 Nov: 2 of its 36 checks failed. `DROP SCHEMA bob CASCADE` also drops every
object outside `bob` that depends on a `bob` object, and `pg_dump -n bob` does
not carry it back. On `main` that was `public.bob_outbox_drain(integer)`
(Slice 6), which `RETURNS SETOF bob.outbound_queue`: after the restore it was
gone, and the fingerprint of `public` differed. The procedure's line
"BOb's functions in `public` survive it, because they reference `bob` by name
and not by type" stopped being true with Slice 6. PR #40 (Slice 3) adds five
more, written with `BEGIN ATOMIC` so that `pg_depend` sees them on purpose.

Ruled by Henry on 21 Nov: fix the procedure, not the functions («En el
procedimiento»). Done:

- `scripts/bob-dependientes.sh`, used by the procedure (§4.3) and by the kit.
  Before the drop it finds the dependents in `pg_depend`, transitively from
  every relation, type and function in `bob`, discovered, not listed, and
  saves their definitions from the box itself: `pg_dump --schema-only` of
  their schemas, filtered with `pg_restore -L` to each object's CREATE, owner,
  grants and comments. After `bob.sql.gz` it puts them back in one
  transaction. Recreated as the superuser, a function also picked up the
  default privileges of `public` (EXECUTE for `anon`, `authenticated` and
  `service_role`), which pg_dump's grants do not undo, since they only state
  the difference from the built-in default; seen on the first run. So the
  file resets each object's ACL to that default before the dumped grants. It knows functions and views; anything else (`otro|…`: a
  trigger, a policy, a default) stops it, to be decided by hand.
- The kit saves them before the drop, checks that the CASCADE takes outside
  `bob` exactly what was saved, puts them back, and the fingerprint must be
  identical. A new sabotage, `sin-dependientes`, skips the put-back and sees
  the fingerprint check fail.
- The procedure's §4.2, §4.3 and §4.5 no longer describe the
  `on_auth_user_created` trigger, which 20261121130000 dropped: `bob.users` is
  written only by `scripts/provision-user.mjs`.
- While reading the fingerprint: `service_role` held EXECUTE on
  `bob_outbox_drain`, from Supabase's default privileges in `public`.
  `service_role` bypasses RLS, so it could drain every organization's queue.
  Migration `20261121190000` revokes it, and a discovered guard in
  `tests/slice6-registries-outbox.test.mjs` says that of the roles that are
  not superusers and do not own it, only `bob_app` can call it.

Measured on the local bench (same digests as lab-02, CLI 2.120.0):
- the kit, 40 checks, all as expected; the fingerprint of `public` identical
  after the restore, `bob_outbox_drain` with `{postgres, bob_app}` only;
- the bench, 21 cases, all matching, among them the new `sin-dependientes`
  sabotage, which fails the fingerprint check;
- with PR #40 merged on top (throwaway, not pushed): the script finds and
  saves the five dependents (`bob_outbox_drain` and Slice 3's
  `bob_cell_state`, `bob_cell_rollup`, `bob_actor_cell_state`,
  `bob_ai_cell_state`), but **the restore of `bob.sql.gz` fails**:
  `bob.v_ai_cell_state` selects from `public.bob_ai_cell_state()`, which
  reads `bob` tables. The view lives in `bob` and the function outside it,
  so the bob-only dump cannot be restored before the function exists, and
  the function cannot be created before `bob`'s tables do. It is the only
  object in `bob` that depends on a function outside it.

Ruled by Henry on 21 Nov: both in `bob`, in PR #40. The cycle runs through
`public.bob_cell_state` too (`bob_ai_cell_state` calls it), so every Slice 3
function that reads `bob` moves into `bob`, and the dump carries them. Pure
helpers that read nothing in `bob` may stay in `public`. PR #40 adds a
discovered guard: no object in `bob` depends on an object outside `bob` that
depends on `bob`. Until PR #40 lands that way, the rehearsal on lab-02 is
run from a `main` without it.

Limit: Postgres lists at most 100 objects in the CASCADE's notice. The kit's
count check would fail past that, loudly, not silently.

## P5 · the rehearsal on lab-02 — run

Run on bzzz-lab-02 on 21 Nov, on Henry's authorization, from BOb-engine
`5e5b9be` (after F-47, before Slice 3), CLI 2.120.0, box image
`supabase/postgres:17.6.1.136`. `--dry-run`: 5 checks, all as expected, 33
migrations to push. `--ejecutar`: 41 checks, all as expected. The two rigged
migrations left nothing, `schema_migrations` stopped just before each, F-15
held at the end, the CASCADE took outside `bob` exactly the one dependent saved
(`public.bob_outbox_drain`), the fingerprint of `bob` and `public` was
identical after the restore, the projections were rebuilt row for row,
`auth.users` (5 accounts) was untouched from start to finish, and box-check
passed. BOb's chain stays applied on lab-02, without synthetic data.

F-27: on lab-02 `http` and `pg_net` are available and not installed, before
and after the chain.

Found on the box: the kit compared inventories with `comm`, which wants the
shell's collation, while the inventory comes in the database's. On lab-02
(`en_US.UTF-8`) `comm` warned that its input was not sorted. Today's listing
was right (105 lines either way), but `--deshacer` reads the same comparison
to decide what to drop. Both sides are now sorted bytewise before `comm`.

The Bzzz side: lab-02 runs Bzzz `main` at `ec8a17c`, without bzzz#365. The
new `backup.sh` was run once without installing it, from `main` at `945859b`:
it exits 0 and its manifest says `postgres:bob tablas=33 filas=0
publicaciones=4 archivo=bob.sql.gz`, the 33 tables matching what is live. The
nightly backup is still the installed one. Deploying Bzzz `main` there is
separate: its plan brings up `compose/l7-bob.yml`, which needs a bob-web
image lab-02 does not have.

---

*Boss.Technology · BOb v1 · Internal only*

## F-27 · closed by (c): no egress extension may be installed

lab-02's rehearsal showed `http` and `pg_net` available and not installed,
before and after the chain. With that known, Henry closed F-27 by (c) on 21
Nov, over (b): a revoke from PUBLIC would not cover a later install.

- `egressFindings` (`scripts/box-checks.mjs`) reports each installed egress
  extension, in any schema, as a finding of its own ("pg_net is installed (in
  net); no egress extension may be (F-27)"), and still reports every function
  the three can EXECUTE beside it. The same function runs in CI
  (`tests/p5-roles.test.mjs`) and in `scripts/box-check.mjs`, so a box with
  either one installed fails "no egress from the database". The rehearsal kit
  reads that line, so it fails too.
- The probe that installs both and rolls back (pg_net in `net`, http in a
  schema nobody would guess) was a `todo`. It is now the seen-red test: it
  asserts both installs are reported. The suite's `todo` count drops by one.
- **Seen red:** with the install findings removed, that probe fails; restored,
  it passes. On the chain, with nothing installed, the guard is green.
- **Run.** Own local stack (port 61322, not the shared one), `db reset
  --no-seed` over `main`'s chain: `pnpm test` 302 tests, 300 pass, 0 fail,
  2 `todo`; pgTAP 18 of 18.
- Nothing is uninstalled or revoked by a migration. If a box ever needs one of
  them (self-hosted Supabase installs `pg_net` for webhooks), that is a new
  decision, not a guard to relax.
- **Measured on lab-02 only.** On model-01 and Febor it is not known whether
  either extension is installed. Their first window runs the box check, and a
  red "no egress from the database" there is a finding to rule on before going
  on, not something to uninstall in the window.

## F-27 · the egress guard fails closed (review of PR #44)

An independent review found, high: the guard that closed F-27 named two
extensions, `http` and `pg_net`, so `dblink`, `postgres_fdw`, `wrappers` or an
untrusted language opened a way out and "no egress from the database" still
read ok. It enumerated what is dangerous instead of failing on what is not
known.

- `egressFindings` (`scripts/box-checks.mjs`) now fails on any installed
  extension outside `APPROVED_EXTENSIONS`, on any row in `pg_foreign_server`,
  and on any untrusted language other than `c` and `internal`. CI and
  `scripts/box-check.mjs` run the same function. `EGRESS_EXTENSIONS` remains
  only to list who could EXECUTE what; the verdict does not read it.
- **Where the approved list comes from.** `SELECT extname FROM pg_extension`
  after `supabase db reset --no-seed` of `main`'s chain, on
  `public.ecr.aws/supabase/postgres:15.19.0.002` (CLI 2.119.0):
  `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`.
  No migration creates an extension, so all five are the image's. The same
  catalog had no foreign server and no untrusted language but `c` and
  `internal`. CI (CLI 2.120.0, a full `supabase start`) asserts the same.
- **Seen red.** Four probes, each installing for real and rolling back, fail
  against the guard as merged in #44 and pass now: `dblink`; `fuzzystrmatch`
  (an extension nobody would name); a `postgres_fdw` foreign server; an
  untrusted language, which needs a superuser and so runs as the local
  stack's `supabase_admin`.
- **Run.** Own local stack (port 61322), `db reset --no-seed` over `main`'s
  chain: `pnpm test` 306 tests, 304 pass, 0 fail, 2 `todo`; pgTAP 18 of 18;
  `box-check` ok on egress. The rehearsal kit was not run.
- **Not covered:** what a superuser can do without installing anything
  (`COPY … TO PROGRAM`, a C function loaded by hand), and what an approved
  extension could do.
- **Likely red on model-01 and Febor** (noted for PR #46, since merged). F-27 above records
  that self-hosted Supabase installs `pg_net` for webhooks, and only lab-02
  was measured. A box built that way fails this check, and a self-hosted image
  may install others outside the five (`pg_graphql`, `pgsodium`, `pgjwt` are
  possible; none was measured). Read `SELECT extname FROM pg_extension` on
  each box before relying on this check there. lab-02's full list is not
  recorded either, only `http` and `pg_net`, so its recorded green predates
  this guard. Adding an extension to the list is Henry's decision per
  extension, per box, before that box's window.

### Second review of PR #47, applied

Relayed by the session that owns the release, 23 Nov. Nothing high.

- **Medium · the rehearsal kit.** `scripts/ensayo-migracion-lab.sh` still
  read the egress line as "over what is installed" and its header spoke only
  of `pg_net` and `http`. The header, the step-6 label and its comment now say
  the check fails closed, and that a box with an extension outside the five
  is red on purpose, the run with it: lab-02's 41/41 predates this guard and
  its full list was never recorded, so a rerun there may be red until each
  extension is ruled on. The kit now records every installed extension, at
  the start and after the chain. Not run: there is no lab-02 window here.
- **Medium · the text.** P5 §3.2 said the five were "the Supabase image"'s.
  They are the local CLI image's; self-hosted installs `pg_net`. §3.2 now says
  so, with the expected red on model-01 and Febor and that each extension per
  box is Henry's call before its window. The §6.3 matrix row for this guard
  states what it asserts now.
- **Low · box-check.mjs end to end.** No test ran the script. One now does,
  as the operator would, against a scratch database on the same cluster
  (`bob_box_check_e2e`, created and dropped by the test) holding the least a
  box has, so every other check is green: exit 0, then `fuzzystrmatch`
  installed, `FAIL  no egress from the database` and exit 1. The suite's own
  database could not serve, its two tenants make "one organization" fail.
  Seen red: with egress findings left out of the exit code, it fails on
  `0 !== 1`; restored, it passes.
- **Low · noted.** The check reads only the database it connects to:
  `pg_extension` and `pg_foreign_server` are per database, so an extension in
  another database of the same cluster is not seen. BOb's boxes hold one.

## O-3 · the chain applied by its own owner — measured, not decided

D77 (Henry, 24 Nov) puts BOb beside the box's apps, on the box's database and
GoTrue, with one schema per neighbour app, and its §2.8 names the owner
`bob_migrador`. Objection O-3: the chain is applied today by `postgres`, which
can touch every schema, `auth` included. Measured in CI on PR #48, a Supabase
stack started with no migration: `bob_migrador` applies 12 of the 33 files and
stops at 21. Five causes, none cleared by a grant D77 allows: creating in
`public` (17 files), the trigger on `auth.users`, the `supabase_realtime`
publication, `CREATE ROLE` and `CREATE SCHEMA IF NOT EXISTS`. And the one grant
that is needed outside `bob`, USAGE on `auth`, only `supabase_admin` can give,
not `postgres`. The table, `bob.sql`'s measured content and the guard are in
P5 §6.2, "Applied by `bob_migrador`". The guard is
`scripts/owner-chain-check.mjs`, a required check, seen red twice before green.
Open for Henry: a baseline for new boxes, or `postgres` until one exists.
