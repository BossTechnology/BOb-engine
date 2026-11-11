# BOb v1 · The application layer (P5) — inputs

**Status: INPUTS, not a decision. Nothing here is signed.** Prepared on
2026-11-11 for the P5 question on Relevo task BZZ-3 (Federico, 10 Nov: "the
whole application layer: the projection schema, the three roles and their
grants, and the migration mechanism").

The decision itself is a BzzzBX decision. It takes the next free number in the
BzzzBX register when it is signed. The route plan called it D39\*, and D39
went to retention. Henry signs it. This file is what it is written from.

**What it does not do.** It writes no migration, creates no role and touches no
database. Slice 2's migrations still wait for the projection contract to be
signed on Relevo task 6. This file must not be read as permission to start them.

**Markers.**
- **[DECIDED]**: a signed decision or a ruling already states this. The
  source is named next to it. This file does not reopen it.
- **[PROPOSED]**: a choice these inputs make that no ruling states. It stands
  only if the decision adopts it.
- **[OPEN]**: a question the decision has to answer. They are listed in §7.
- **[FINDING]**: something wrong in what is on `main` today, found while
  writing this. It is recorded in `Documentation/contract-amendments.md`.

**Sources.**
- `docs/contracts/projection-contract.md`, draft 0.4 (PR #15, merged as
  `be12e2d`).
- `supabase/migrations/20260902100300_roles_and_grants.sql`: Handoff §4.3, the
  three-role split.
- `Documentation/contract-amendments.md`: A-05, N-04, N-08, F-18, F-19, and the
  rulings after Slice 1c and after the Slice 2 questions.
- Relevo task 6, Federico's official replies of 23 Oct, 5, 10 and 11 Nov.
- Relevo task BZZ-3: Federico's replies of 23 Oct and 10 Nov, and Henry's
  replies of 26 Oct and 10 Nov.
- BzzzBX repository, read-only, at `origin/main` on 2026-11-11:
  - `docs/PLAN_ruta_bzzzbx_etapas_0_a_5.md`: §3.5, §3.6, stage 3, tasks 5.3 and
    5.9. This plan is unsigned.
  - `compose/l6-supabase.yml` and `config/supabase/`.
  - `docs/INSUMOS_D50_mcp_de_solo_lectura_en_la_caja.md`: unsigned.
  - `PROJECT_STATE.md`: D16, D20, D31.

---

## 1 · Decided and proposed, at a glance

| Item | State | Where |
|---|---|---|
| The projection schema is the contract, 0.4 | **[DECIDED]** in content, unsigned as a file. Federico: "Nothing is left on Federico's side for this contract" (Relevo task 6, 11 Nov). O1 to O5 are open | §2 |
| The three roles are `bob_app`, `bob_feeder` and `bob_ai_ro` | **[PROPOSED]** reading. The roles exist; that these are the "three roles" P5 means is the reading to confirm | §3 |
| PR-4: BOb never writes a projection, enforced by grant | **[DECIDED]** (Handoff §4.3; A-05) | §3.2 |
| One writer, `bob_feeder`; it reads exactly two views from BOb | **[DECIDED]** (contract §1, §7.4) | §3.2 |
| The feeder never creates an actor; ghosts are created by BOb as `bob_app` | **[DECIDED]** (Relevo task 6 Q13, 11 Nov) | §3.2 |
| `bob_ai_ro` reads named `v_ai_*` views and nothing else | **[DECIDED]** (IR-1) | §3.2 |
| One service holds the read-only role, and the MCP reads through that service | **[DECIDED]** (BZZ-3, Federico accepted it on 10 Nov) | §3.4 |
| No runtime component holds the service role or the migration owner's credential | **[PROPOSED]** | §3.4 |
| Secrets are files at mode 600, not Vault | **[DECIDED]** (D31; Federico: "No push on Vault", BZZ-3, 10 Nov) | §4 |
| BOb's Postgres is the box's `supabase-db`, schema `bob` | **[PROPOSED]**, following N-04 and the schema move to `bob` | §5.1 |
| Migrations live in BOb-engine, are append-only, and are tested from an empty database in CI | **[DECIDED]** (repository conventions; F-15) | §6.1 |
| The box applies them with the same CLI CI uses, lab first | **[PROPOSED]** | §6.2 |
| Two defects in the feeder's access as built | **[FINDING]** F-21, F-22 | §3.3 |

---

## 2 · The projection schema

The schema is `docs/contracts/projection-contract.md`, draft 0.4. These inputs
copy none of it. If this file and the contract ever disagree, the contract
wins.

**[DECIDED]**, Relevo task 6, 23 Oct, and every ruling since:

- **What BOb holds.** Eight tables in schema `bob`:
  - `proj_metric_counts`
  - `proj_sentiment`
  - `proj_durations`
  - `proj_channel_health`
  - `proj_rum_signals`
  - `proj_actor_metrics`
  - `proj_detections`
  - `proj_deliveries`

  Six are bucketed at five minutes, UTC-aligned (C-13). Two are event-grained.
  All are partitioned monthly, with thirteen months of retention (C-14).
  `org_id` is the tenant key, and RLS is on every table and every partition.
- **What BzzzBX delivers** (task 3.7). Three things that do not merge:
  - the rows of those eight tables;
  - the evidence packages by `correlation_id` and `entity_id`;
  - `affected_members(frame, filter)`.
- **One property.** A projection stores counts, sums and distributions, never a
  figure derived from them.

**Status.** Federico closed all sixteen of 0.3's questions on 11 Nov. Five gaps
are open in contract §11 (O1 to O5). None of them changes a role or a grant.
The contract is signed by Henry on Relevo task 6, and then published there.

**What P5 adds to the contract.** Nothing to its content. It answers where the
eight tables live (§5.1), who may touch them (§3), and how they get there (§6).

---

## 3 · The three roles and their grants

### 3.1 Which three

The P5 question names "the three roles", and so does `INSUMOS_D29` §7. The
route plan (§D39) asks who requested them and what they are. The roles that
exist are the three of Handoff §4.3. They were created in Slice 0, in
`20260902100300_roles_and_grants.sql`, as `NOLOGIN` groups:

| Role | Purpose (from its `COMMENT ON ROLE`) | Who holds the credential **[PROPOSED]** | Route-plan name |
|---|---|---|---|
| `bob_app` | The application. Reads and writes configuration and live state; read-only on projections. PR-4 | The BOb application, one container in the box | `bzzz/apps` |
| `bob_feeder` | The feeder. Writes projections. No read on configuration | The feeder: the reference feeder, or 3.7, the same credential either way (contract §1) | not in Plan v2 §9.2 |
| `bob_ai_ro` | The reasoning tier. Read-only on named `v_ai_*` views and nothing else. IR-1 | The inference service, task 5.3 | `bzzz/supabase-ro` |

**[PROPOSED]** These are the three. The plan's `supabase-ro` ("SELECT only on
named views", task 3.5) is `bob_ai_ro` under another name. The plan's role for
the applications is `bob_app`. The feeder is the one the plan does not name,
because the plan was written before the contract existed. **[OPEN]** §7 Q1.

`anon`, `authenticated`, `service_role` and the migration owner are Supabase's
own. They are not among the three, but §3.2 states what each may do here.

### 3.2 The grant matrix

Every LOGIN role is `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`. The
migration owner is the only role that owns objects or bypasses RLS.

| Object | `bob_app` | `bob_feeder` | `bob_ai_ro` | `authenticated` | `anon` / PUBLIC |
|---|---|---|---|---|---|
| Configuration and live state (every `org_id` table that is not a projection) | SELECT, INSERT, UPDATE, DELETE | none | none | A-05b's choice (§3.3) | none |
| The eight projections and every partition | SELECT | SELECT, INSERT, UPDATE, DELETE | none | SELECT | none |
| `actors` | SELECT, INSERT, UPDATE, DELETE (ghost reconciliation) | none (reads through the view) | none | A-05b's choice | none |
| `actor_external_refs`, `actor_ref_history` (Slice 2) | SELECT, INSERT, UPDATE (`actor_ref_history` takes INSERT only) | none | none | none | none |
| `v_feeder_channel_map` | none | SELECT | none | none | none |
| `v_feeder_actor_map` (Slice 2) | none | SELECT | none | none | none |
| `v_ai_*` views (none exist yet) | none | none | SELECT | none | none |
| `v_roster` | SELECT | none | none | none | none |
| Partition function (contract §3) | none | EXECUTE | none | none | none |
| `bob_grant_projection()` | none | none | none | none | none |
| The truth store (ClickHouse) | only through `affected_members` and the evidence packages, never directly | read-only ClickHouse role (task 3.6) | its own ClickHouse access, per task 5.3 | none | none |

Each entry and its source:

- **PR-4** **[DECIDED]** (Handoff §4.3, A-05): `bob_app` and `authenticated`
  read projections and cannot write them. `bob_grant_projection()` already
  applies this per table, revoking from `anon` and `authenticated` the write
  that Supabase's default privileges give them in `public`.
- **The feeder's reads** **[DECIDED]** (Handoff §4.3, contract §7.4): exactly
  two views, and anything more is a finding about the contract. It holds no
  grant on `channels`, `organizations` or `actors`.
- **The feeder never creates an actor** **[DECIDED]** (Relevo task 6 Q13, 11 Nov). The
  BOb-side reconciliation that creates ghosts runs as `bob_app`, from member
  refs only, with a guard (contract §10).
- **The partition function** **[DECIDED]** (contract §3; 0.2 Q7, ruled 10 Nov):
  `SECURITY DEFINER`, owned by the migration owner, EXECUTE granted to
  `bob_feeder` alone.
- **`bob_ai_ro`** **[DECIDED]** (IR-1): named views only. The route plan's
  test is the same ("fails on an `UPDATE` and on reading a table that is not a
  view").
- **Configuration grants found, not listed** **[DECIDED]** (contract §10, F-19).
  `bob_app`'s grants on non-projections are asserted over every discovered
  `org_id` table. That replaces the hand list in `20260902100300`.
- **`actor_external_refs` and `actor_ref_history`** **[PROPOSED]**, following
  contract §9.3–§9.4. The history is append-only, so `bob_app` gets no UPDATE or
  DELETE on it. The grant enforces that.
- **No network from Postgres** **[PROPOSED]**, following BZZ-3 Ruling 2.
  `pg_net` and `http` are not granted to any of the three, so no trigger in
  BOb's database can notify a customer outside Node-RED.

### 3.3 How each role meets RLS

Every tenant policy reads `org_id = (auth.jwt() ->> 'org_id')::uuid`.
`auth.jwt()` reads the `request.jwt.claims` setting. A role connecting directly
(N-04) has no claim unless it sets one. Reading the migrations against the
roles turned up two defects. Both were found by reading, not by running
anything.

**[FINDING] F-21 · The feeder cannot read its own view.**
`v_feeder_channel_map` is created `WITH (security_invoker = true)`. Postgres
then checks the base tables against the invoker's privileges, and `bob_feeder`
holds SELECT on the view only, not on `channels` or `organizations`. Read as
`bob_feeder`, it is refused. Even with those grants, `channels` RLS would show
it no rows. The feeder also needs the map across every tenant, before it knows
which `org_id` an event belongs to. No test reads the view as `bob_feeder`,
which is why the suite is green.

- **Proposed fix:** recreate both feeder views as definer views
  (`security_invoker = false`), owned by the migration owner, exposing only
  their named columns. That is exactly the boundary Handoff §4.3 describes: a
  named view, so the feeder never holds a grant on the tables.
- **Proposed guard:** read each view as `bob_feeder` over the two-tenant
  fixture, and assert rows from both tenants and refusal on the base tables.

**[FINDING] F-22 · The policy that guards projections also refuses the feeder's
writes.** Contract §2 puts the tenant policy on every projection and partition.
`bob_feeder` is `NOBYPASSRLS` and sets no claim, so its `WITH CHECK` fails and
every insert is refused.

- **Proposed fix:** the feeder writes **one tenant per transaction** and opens
  each with `set_config('request.jwt.claims', '{"org_id":"…"}', true)`. The
  policy stays the one every table uses, so the contract does not change. A
  feeder bug that tags a row with the wrong `org_id` is refused by the database
  instead of landing under another tenant.
- **Rejected alternatives:**
  - `BYPASSRLS` on `bob_feeder` turns that protection off for the role that
    writes the most rows.
  - A permissive `TO bob_feeder USING (true)` policy is exactly what the
    open-policy probe in the tenancy suite exists to catch.
- **Proposed guard:** as `bob_feeder`, with the claim for tenant A, inserting a
  row for tenant B is refused.

**`bob_app`** **[PROPOSED]**. The same mechanism. A request handler sets the
claim from the user's verified JWT. Background work, such as the ghost
reconciliation, iterates per tenant and sets each one. Whether user reads run as
`bob_app` with the user's claim, or as `authenticated` through PostgREST, is
A-05b's choice with the first route handler. It does not change the matrix.

**`bob_ai_ro`** **[PROPOSED]**. The inference service scopes every request to
one tenant (task 5.9: "scope by token, tenant and role") and sets that claim.
The `v_ai_*` views are invoker views, so RLS applies through them.

### 3.4 What no running component holds

**[PROPOSED]**, and stated as a rule so a guard can check it:

- **The service role.** In the box, `SERVICE_ROLE_KEY` is used today only by two
  operator scripts against GoTrue's admin API (`crear-usuario-portal.sh`,
  `invitar-portal.sh`). It stays that way:
  - no BOb container, feeder or MCP is given it;
  - A-05's service-role paths do not come back in BOb v1.
- **The migration owner's credential.** It is used by the migration step of
  §6.2 and by nothing that runs continuously.
- **The MCP** holds no Postgres credential at all **[DECIDED]**. Federico
  accepted on 10 Nov (BZZ-3) that one service holds the read-only role and the
  MCP reads through it. The unsigned D50 inputs have the MCP reading ClickHouse
  with the portal's JWT. Either way it is never `bob_ai_ro` directly, never
  `bob_app`, and never the service role.

---

## 4 · Secrets

**[DECIDED]** Secrets are files at mode 600 under `/opt/bzzz/secrets/`, not
Vault. The reasons:

- D31 puts connector secrets there so that no service depends on Vault being
  unsealed after a reboot.
- Federico, 10 Nov (BZZ-3): "No push on Vault. D31's reasoning is sound." The
  Security Guide is softened rather than the build changed.

So the Vault paths `bzzz/supabase`, `bzzz/supabase-ro` and `bzzz/apps` of Plan
v2 §9.2 are **not created**. The decision records that deviation, as plan §3.5
asks.

| Plan v2 §9.2 path | Credential | File **[PROPOSED]** | Read by |
|---|---|---|---|
| `bzzz/supabase` | Migration owner, `JWT_SECRET`, `SERVICE_ROLE_KEY` | `/opt/bzzz/secrets/supabase.env` (exists) | The migration step (§6.2), the database container and operator scripts |
| `bzzz/supabase-ro` | `bob_ai_ro` login | `/opt/bzzz/secrets/bob/ai-ro.env` | The inference service |
| `bzzz/apps` | `bob_app` login | `/opt/bzzz/secrets/bob/app.env` | The BOb container |
| none (new) | `bob_feeder` login | `/opt/bzzz/secrets/bob/feeder.env` | The feeder |

- **One credential per file, and one reader per file.** Rotation follows
  `docs/OPERACION_rotacion_secretos.md`.
- **The LOGIN step.** A role becomes LOGIN and gets its password when the box is
  provisioned, not in a migration. A migration cannot invent a password
  (`20260902100300`, A-05).

---

## 5 · Where it runs

### 5.1 BOb's database

**[DECIDED]** N-04: full stack on the VPS, with a direct Postgres connection.
X-01 and X-03 specify self-hosted. Postgres 17.6 stays, and the fleet pin is
revisited when the first VPS instance is built.

**[PROPOSED]** "The VPS" is the company's box (D31.1, one box per company).
BOb's tables go in the box's existing `supabase-db`, in schema `bob`, beside
GoTrue's `auth`. There is no second Postgres. The reasons:

- **The pieces are already there.** The box's GoTrue issues the JWT that BOb's
  `org_id` claim rides on, and `supabase-db` already sits on `bzzz-app` and never
  on `bzzz-edge` (task 3.3).
- **A direct connection fits only inside the box.** BOb would reach Postgres on
  `bzzz-app` and never across the internet. So BOb's application runs in the box
  too, which is stage 4 and D41\*'s question. Until then, no production BOb
  connects to the box.
- **The tenancy model is already settled.** Relevo task 7, ruling (d) made `org_id` the
  tenant key. Runbook §7.3's `tenants` and `app_entities` (task 3.4) are not
  built for BOb. BOb's `organizations`, with `slug` = `bzzz.tenant` (A-01,
  A-02), plays that part. **[OPEN]** §7 Q2.

**[DECIDED]** In the meantime, the one hosted Supabase project is this
repository's target (rulings after the Slice 2 questions). That target is
interim by definition. No migration goes there before a backup exists (N-08),
and applying the chain there breaks the demo's bridge until that bridge has its
contract file. **[OPEN]** §7 Q3: what the hosted project is once the box
carries BOb.

### 5.2 Networks **[PROPOSED]**

| Component | `bzzz-app` (Postgres) | `bzzz-data` (ClickHouse) | `bzzz-edge` |
|---|---|---|---|
| `supabase-db` | yes | no | never |
| BOb application | yes | no | through Traefik only |
| Feeder | yes | yes, read-only role | no |
| Inference service | yes, `bob_ai_ro` | yes (task 5.7) | through Traefik only |

---

## 6 · The migration mechanism

### 6.1 Where migrations live, and how they are tested — **[DECIDED]**

- **BOb's schema:** `supabase/migrations/` in BOb-engine, and only there.
  - Append-only. Never edit one that has run anywhere shared.
  - The ClickHouse side of the contract (3.6, 3.7) lives in BzzzBX's
    `config/clickhouse/`, under D20's expand → flip → contract.
- **Every change is applied from an empty database in CI.** Four required
  checks, no bypass (branch protection, read back on 2026-10-28).
  `schema_migrations` must hold exactly the files' versions (F-15).
- **Every guard is seen failing before it is trusted,** and recorded in
  `contract-amendments.md`.
- **Order:**
  - No Slice 2 migration before the contract is signed on Relevo task 6.
  - Slice 2's migrations bring the contract §10 guards and the role guards in
    §6.3.

### 6.2 How the box applies them — **[PROPOSED]**

| Question | Proposal |
|---|---|
| What is applied | A BOb-engine commit on `main` with four green checks. The box pins the commit SHA, the way it pins images (D4, D9), and reports it in its manifest (task 3.11) |
| With what | The Supabase CLI at the version CI pins (`SUPABASE_CLI_VERSION`, today 2.120.0): `supabase db push --db-url …` against `supabase-db` on `bzzz-app`. It writes `supabase_migrations.schema_migrations` exactly as CI's reset does, so the same F-15 check reads the box |
| As whom | The migration owner (`postgres` in the Supabase image), from `/opt/bzzz/secrets/supabase.env`. It owns every object, which the `SECURITY DEFINER` functions and definer views need |
| From where | A step in `scripts/actualizar.sh`, after the database and before any service that uses the new schema. That follows BzzzBX's rule of migration before code, as with the centro's 009 |
| Who runs it | Henry, in a maintenance window with notice to the company (CLAUDE.md: production is Henry's). Never an agent, and never a running service |
| How it is tried first | `supabase db push --dry-run` on `bzzz-lab-02`, then the real apply there, then `bzzz-model-01`, then the company boxes. This is plan §3.6's `--plan` habit, and D16's rule that tests run on another machine, never on a second copy |
| How it is checked after | A read-only check against the box: the applied versions equal the pinned commit's files, and the role guards of §6.3 that need no fixture. The full suite never runs against a company box: it loads and deletes a fixture |
| If it fails | The push stops at the failing file. Files already applied stay applied and recorded, and the rest wait. Every migration since `20260902100000` wraps its work in `BEGIN … COMMIT`, and new ones must, so a failed file leaves nothing half-done. Nine older files do not; they have all run in CI from an empty database, and they would run once on a new box. Nothing is rolled back by hand: the fix is a new migration (append-only) |

### 6.3 Guards the roles add — **[PROPOSED]**

These are in addition to contract §10. Each one is seen failing first.

| Guard | Asserts |
|---|---|
| Three roles, no more | The only non-Supabase LOGIN roles with any privilege in `bob` are `bob_app`, `bob_feeder` and `bob_ai_ro`. None is SUPERUSER or BYPASSRLS |
| Feeder views readable | As `bob_feeder`, both feeder views return rows for both fixture tenants, and the base tables refuse (F-21) |
| Feeder scoped by claim | As `bob_feeder` with tenant A's claim, a tenant B row is refused (F-22) |
| Feeder reads nothing else | As `bob_feeder`, every non-projection table and every view other than the two refuses SELECT |
| `bob_ai_ro` reads views only | As `bob_ai_ro`, UPDATE is refused, and any base table refuses SELECT (route-plan test, IR-1) |
| History is append-only | As `bob_app`, UPDATE and DELETE on `actor_ref_history` are refused |
| No egress from the database | None of the three holds EXECUTE on any function of the `pg_net` or `http` extensions, wherever they are installed |

---

## 7 · What the decision has to answer

Three questions for Federico, and two for Henry. None reopens a ruling.

1. **Q1 · Are these the three roles?** `bob_app`, `bob_feeder` and `bob_ai_ro`,
   from Handoff §4.3, with `bzzz/supabase-ro` being `bob_ai_ro`. The route plan
   asks who requested "the three roles" (`INSUMOS_D29` §7). If something else
   was meant, the matrix in §3.2 changes.
2. **Q2 · Is runbook §7.3's tenancy model superseded for BOb?** BOb's
   `organizations` and `org_id` (Relevo task 7, ruling (d)) instead of `tenants` and
   `app_entities`, in the box's `supabase-db`, schema `bob`.
3. **Q3 · The hosted project.** Does it stay as BOb's development target once a
   box carries BOb, or does it go back to being only the demo's?
4. **For Henry · the feeder's home.** Which process holds `bob_feeder` first:
   the reference feeder or 3.7. The contract says the credential is the same
   either way, and the decision only needs to say which one gets the file.
5. **For Henry · the numbering.** The decision takes the next free number in the
   BzzzBX register when it is signed.

**Not in P5.** These belong to other decisions:

- the box sizing with the application layer (D38\*);
- PostgREST and Studio in the box (task 3.1);
- the evidence packages' ClickHouse shape (3.7, against the contract);
- the centro's phases 3 and 4 (D40\*, D41\*);
- the MCP (D50).
