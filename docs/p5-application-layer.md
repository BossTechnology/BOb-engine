# BOb v1 · The application layer (P5) — inputs

**Status: the inputs of D62, signed by Henry on 2026-11-25 «con todo lo
propuesto» (BzzzBX `docs/decisions/D62_capa_de_aplicacion_de_bob.md`,
bzzz#457).** Where this file and D77 (BOb v1 beside the box, signed
2026-11-24) differ, D77 governs: D62 says so. Prepared on
2026-11-11 for the P5 question on Relevo task BZZ-3 (Federico, 10 Nov: "the
whole application layer: the projection schema, the three roles and their
grants, and the migration mechanism"). Updated on 2026-11-18 with Federico's
answers to Q1–Q3 and Henry's answers to his two questions (Relevo BZZ-19,
18 Nov). The answers settle the inputs; they do not sign P5.

Updated again on 2026-11-19, after Slice 2 merged (PR #20 and PR #21, contract
0.5.3), to bring the state, the grant matrix and the migration count up to what
is on `main`. That pass also recorded F-26, which Slice 2 handed to P5 (§7,
Q6), and the seven objections from the devil's-advocate review that comes
before the signature (§8). Henry answered Q6 and all seven objections the
same day; his answers are recorded under each one. What is left before the
signature is the lab-02 rehearsal (§8, objection 5).

Updated on 2026-11-21: **Henry changed his answer to Q6.** The 19 Nov answer
put the ghost reconciliation in the BOb container. The reconciliation asks the
truth store (ClickHouse) for `member_refs_seen`, and §5.2 keeps the BOb
application off `bzzz-data`. Henry: «El feeder». The feeder container runs it,
because it already reads ClickHouse. As built, the reconciliation writes
`actors` as `bob_app`, and `bob_feeder` holds no grant there. So the move
reopens a grant question (§7, Q6; F-40). Henry chose option (a) the same
day: the feeder writes the refs it sees to a table in `bob`, and `bob_app`
reconciles from it. This changes a P5 answer.

The decision itself is a BzzzBX decision: **D62** in the BzzzBX register. The
route plan called it D39\*, and D39 went to retention. Henry signed it on
2026-11-25 (bzzz#457), and this file is what it was written from.

- *2026-11-18 · numbering.* BZZ-19 gave P5 the number D60. D60 was signed in
  Bzzz the same day for something else (the batch at the root of SendGrid), so
  Henry reassigned P5 to D62.

**What it does not do.** It writes no migration, creates no role and touches no
database. Slice 2's migrations were built against the projection contract,
not against P5. The contract was signed at 0.5.1 on Relevo task 6, and 0.5.2
and 0.5.3 add what Henry accepted while it was built (F-23 to F-25). They are
on `main`, in the repository and in CI only. No box has them. This file must
not be read as permission to apply them to any box.

**Markers.**
- **[DECIDED]**: a signed decision or a ruling already states this. The
  source is named next to it. This file does not reopen it.
- **[PROPOSED]**: a choice these inputs make that no ruling states. It stands
  only if the decision adopts it.
- **[OPEN]**: a question the decision has to answer. They are listed in §7
  and §8. As of 2026-11-19, all are answered: Q1–Q6 and the seven
  objections of §8.
  - *2026-11-21:* Henry answered Q6 again («El feeder»), and chose how the
    same day: option (a) of §7, Q6.
- **[FINDING]**: something wrong in what is on `main` today, found while
  writing this. It is recorded in `Documentation/contract-amendments.md`.

**Sources.**
- `docs/contracts/projection-contract.md`: draft 0.4 (PR #15, merged as
  `be12e2d`) when these inputs were written. On 2026-11-19 it is 0.5.3, on
  `main` at `c4ebf1d`.
- `supabase/migrations/` and `tests/` on `main` at `c4ebf1d` (Slice 2
  merged), for the 2026-11-19 pass.
- `supabase/migrations/20260902100300_roles_and_grants.sql`: Handoff §4.3, the
  three-role split.
- `Documentation/contract-amendments.md`: A-05, N-04, N-08, F-18, F-19, and the
  rulings after Slice 1c and after the Slice 2 questions.
- Relevo task 6, Federico's official replies of 23 Oct, 5, 10 and 11 Nov.
- Relevo task BZZ-3: Federico's replies of 23 Oct and 10 Nov, his answers to
  Q1–Q3 (Q1 on 12 Nov), his acceptance of Q3 in the form of 15 Nov rather than
  that of 12 Nov, and Henry's replies of 26 Oct and 10 Nov.
- Relevo task BZZ-19: Henry's replies of 18 Nov (the feeder's home, the
  numbering).
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
| The projection schema is the contract, 0.5.3 | **[DECIDED]** Signed at 0.5.1 by Henry on Relevo task 6, 18 Nov (PR #17). 0.5.2 (F-23, F-24, §8.7) and 0.5.3 (F-25, `channel_capabilities`) were accepted by Henry while Slice 2 was built and notified to Federico on task 6. Slice 2 is on `main` (PR #20, PR #21) | §2 |
| The three roles are `bob_app`, `bob_feeder` and `bob_ai_ro`, as Handoff §4.3 defines them | **[DECIDED]** (Federico, 12 Nov, Q1) | §3 |
| The reference feeder holds `bob_feeder` first; 3.7 takes the same credential later | **[DECIDED]** (Henry, BZZ-19, 18 Nov) | §3.1 |
| `organizations` / `org_id` replace runbook §7.3's `tenants` / `app_entities` for BOb; `organizations.slug` = `bzzz.tenant` | **[DECIDED]** (Federico, Q2) | §5.1 |
| Development runs on a local Supabase pinned to the box's images and CI's CLI; lab-02 is the integration and rehearsal target; the hosted project is the demo's again and never hosts BOb | **[DECIDED]** (Q3 in its 15 Nov form, accepted by Federico on BZZ-3) | §5.1, §6.2 |
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
| A rehearsed failed migration on lab-02 and a written procedure, before the first window (not before the signature) | **[DECIDED]** as a condition (Federico) | §6.2 |
| Two defects in the feeder's access as built | **[FINDING]** F-21, F-22. Fixed in Slice 2 (PR #20) and run against a database by the reference feeder (PR #21); each guard seen failing | §3.3 |
| Who schedules the ghost reconciliation, and where it reads the tenant list | ~~**[DECIDED]** (Henry, 19 Nov) the BOb container, with the box's single `org_id` and slug from provisioning (F-26)~~ **[DECIDED]** (Henry, 2026-11-21): «El feeder», the feeder container, which already reads what the box knows (through `bzzz-vecinos` since D77, 77.3; §5.2). How: option (a), Henry, 2026-11-21: the feeder writes `member_refs_seen` to a `bob` table, and `bob_app` reconciles from it (F-40) | §7, Q6 |
| The seven objections of the devil's-advocate review | **[DECIDED]** (Henry, 19 Nov), all seven answered. The lab-02 rehearsal comes before the signature | §8 |

---

## 2 · The projection schema

The schema is `docs/contracts/projection-contract.md`, 0.5.3. These inputs
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

**Status (2026-11-19).** Henry signed the contract at 0.5.1 on Relevo task 6
on 18 Nov (PR #17, `5e2966d`). Then Slice 2 was built against it, and three
places could not be built as written. Henry accepted the fixes, which are
0.5.2 (F-23, F-24, §8.7) and 0.5.3 (F-25). Federico was notified on task 6.
Both Slice 2 PRs are merged (PR #20 `9fbd367`, PR #21 `c4ebf1d`). H3's sweep
question is open with Federico for 3.7. It changes no role or grant.

**What P5 adds to the contract.** Nothing to its content. It answers where the
eight tables live (§5.1), who may touch them (§3), and how they get there (§6).

---

## 3 · The three roles and their grants

### 3.1 Which three

The P5 question names "the three roles", and so does `INSUMOS_D29` §7. The
route plan (§D39) asks who requested them and what they are. The roles that
exist are the three of Handoff §4.3. They were created in Slice 0, in
`20260902100300_roles_and_grants.sql`, as `NOLOGIN` groups:

| Role | Purpose (from its `COMMENT ON ROLE`) | Who holds the credential | Route-plan name |
|---|---|---|---|
| `bob_app` | The application. Reads and writes configuration and live state; read-only on projections. PR-4 | **[PROPOSED]** The BOb application, one container beside the box (`bob-web`, D77; §5.2) | `bzzz/apps` |
| `bob_feeder` | The feeder. Writes projections. No read on configuration | **[DECIDED]** The reference feeder first; 3.7 takes the same credential later (contract §1). Henry, BZZ-19, 18 Nov | not in Plan v2 §9.2 |
| `bob_ai_ro` | The reasoning tier. Read-only on named `v_ai_*` views and nothing else. IR-1 | **[PROPOSED]** The inference service, task 5.3 | `bzzz/supabase-ro` |

**[DECIDED]** (Federico, 12 Nov, Q1) These are the three, as Handoff §4.3
defines them. The plan's `supabase-ro` ("SELECT only on named views", task 3.5)
is `bob_ai_ro` under another name. The plan's role for the applications is
`bob_app`. The feeder is the one the plan does not name, because the plan was
written before the contract existed.

**Why the reference feeder first** (Henry, BZZ-19). It can be run against the
local Supabase (§5.1) before 3.7 exists. So F-21 and F-22 are exercised against
a database, not only read, and 3.7 inherits a credential whose access has
already been exercised.

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
| `actor_external_refs`, `actor_ref_history` (Slice 2) | As built: SELECT, INSERT, UPDATE, DELETE. `actor_ref_history` is append-only by trigger, not by grant (see below) | none | none | As built: SELECT, INSERT, UPDATE, DELETE, under RLS (A-05b's choice) | none |
| `channel_capabilities` (Slice 2, 0.5.3) | SELECT, INSERT, UPDATE, DELETE | none (reads the column on its view) | none | SELECT, INSERT, UPDATE, DELETE, under RLS | none |
| `v_channel_declaration_gaps` (Slice 2) | SELECT | none | none | SELECT | none |
| `member_refs_seen` (Q6 (a), F-41) | SELECT, DELETE (the ghost reconciliation consumes what was staged) | INSERT only, under the tenant's claim | none | none | none |
| `member_refs_runs` (Q6 (a), F-41, review of PR #33) | SELECT, DELETE | INSERT only, one row per tenant per staging run | none | none | none |
| `v_feeder_channel_map` (with `capabilities`, 0.5.3) | none | SELECT | none | none | none |
| `v_feeder_actor_map` (Slice 2) | none | SELECT | none | none | none |
| `v_ai_*` views (none exist yet) | none | none | SELECT | none | none |
| `v_roster` | SELECT | none | none | none | none |
| Partition function (contract §3) | none | EXECUTE | none | none | none |
| `bob_grant_projection()` | none | none | none | none | none |
| `bob_grant_feeder_staging()` (Q6 (a)) | none (EXECUTE revoked from PUBLIC, `anon`, `authenticated` and `service_role`; the migration owner alone) | none | none | none | none |
| The truth store (ClickHouse) | only through `affected_members` and the evidence packages, never directly | ~~read-only ClickHouse role (task 3.6)~~ none (D77, 77.3): it reads through `bzzz-vecinos`, which holds `bob_lector` | its own ClickHouse access, per task 5.3 | none | none |

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
  - *2026-11-21 (Q6, F-40):* Henry moved the reconciliation to the feeder
    container, and chose option (a) of Q6. This ruling stands as written.
    The matrix gains one row when (a) is built: the new table, INSERT for
    `bob_feeder`, SELECT and DELETE for `bob_app`.
  - *Built (branch `p5-q6a-staged-member-refs`, F-41):* the row is
    `member_refs_seen`, in migration `20261121140000`. Its grants come from
    one helper, `bob_grant_feeder_staging()`. The suite finds a staging table
    by its grants (the feeder can insert into it and cannot read it), not by
    name, and holds each one to exactly this row. An INSERT grant on `actors`
    to the feeder would make `actors` look like a staging table, and that
    guard refuses it (Q13). The feeder still reads exactly its two views.
  - *Review of PR #33:* a staging table is now any table the feeder can
    write in any way (INSERT, UPDATE, DELETE, TRUNCATE, on the table or a
    column) and cannot read, so a DELETE on `actors` is caught too; every
    grantee is read from the ACLs, and an unknown one is a finding. A second
    staging table, `member_refs_runs`, records each run. The feeder stages
    the trailing window at least as often as `bob_app` reconciles (contract
    §7.2, F-41).
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
  - *2026-11-19 · as built.* Slice 2 granted both tables in full to `bob_app`
    and `authenticated`, following F-19's rule (full grants on every `org_id`
    non-projection). A trigger keeps the history append-only: UPDATE and
    DELETE are refused with `23514`, and the guard was seen failing. The
    effect is the one proposed. The mechanism is different, and the decision
    should state which one it adopts.
- **`channel_capabilities`** (Slice 2, contract 0.5.3, F-25). `bob_app` writes
  it under RLS by `org_id`. The feeder never reads the table, only the
  `capabilities` column of `v_feeder_channel_map`. That keeps its two views.
- **No network from Postgres** **[PROPOSED]**, following BZZ-3 Ruling 2.
  ~~`pg_net` and `http` are not granted to any of the three, so no trigger in
  BOb's database can notify a customer outside Node-RED.~~ Corrected
  2026-11-20 (F-27): no grant to the three keeps them out only while neither
  extension is installed. Installed, both are executable by PUBLIC. What holds
  today is that neither is installed, and the guard of §6.3 checks effective
  EXECUTE, PUBLIC included.
  - **[FINDING] F-27 · 2026-11-20 · "Not granted" does not hold once they are
    installed.** Measured on the local Supabase, the image CI uses, by
    installing both in a transaction that was rolled back:
    - every function of `pg_net` (in `net`) and of `http` (wherever it is
      installed) is executable by PUBLIC, and so by all three roles;
    - `net` gives USAGE to PUBLIC, and `pg_net`'s tables are readable by
      `bob_ai_ro`.
    Today neither extension is installed locally or in CI. What protects BOb is
    "not installed", not "not granted". Whether the box's `supabase-db` has
    `pg_net` (self-hosted Supabase installs it for webhooks) has not been
    checked. The box check prints which egress extensions are installed.
    - **Decided** (Henry, 2026-11-20): (a). The guard checks effective EXECUTE
      over whatever is installed, in CI and in the box check. A probe that
      installs both and rolls back stays in CI as a `todo`. Whether F-27 is
      closed by a migration that revokes from PUBLIC (b) or by requiring
      neither to be installed (c) waits on whether `pg_net` is on lab-02. The
      lab-02 rehearsal kit checks that.
    - **Closed by (c)** (Henry, 2026-11-21). lab-02 has both available and
      neither installed, before and after the chain. The guard of §6.3 now
      fails if either is installed, in any schema, in CI and in the box check;
      the installed probe is a test that sees it fail, no longer a `todo`.
      **Measured on lab-02 only.** On model-01 and Febor it is not known
      whether either is installed. Their first window's box check tells; a red
      there is a finding to rule on before going on, not an uninstall in the
      window.
    - **Corrected 2026-11-22 (review of PR #44).** "No egress" was more than
      that guard checked: `dblink`, `postgres_fdw`, `wrappers` or an untrusted
      language open a connection out, and it stayed green. The guard now fails
      closed on three things: an installed extension outside
      `APPROVED_EXTENSIONS` (the five the local CLI image installs), any row in
      `pg_foreign_server`, and any untrusted language other than `c` and
      `internal`. It does not see what a superuser can do without installing
      anything (`COPY … TO PROGRAM`, a C function loaded by hand), nor what an
      approved extension could do, nor any database but the one it connects
      to (`pg_extension` is per database).
    - **Expected red on model-01 and Febor.** The list is the local CLI
      image's, not a box's. Self-hosted Supabase installs `pg_net` for
      webhooks, so this check fails there, and the rehearsal kit's step 6 with
      it. What to do with each extension found on each box (approve it here,
      or uninstall it) is Henry's decision, taken before that box's window.

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

**When F-21 and F-22 are fixed.** ~~Behind another signature. The fixes travel
with Slice 2's migrations, and those wait for the projection contract 0.5
(PR #17, open) to be signed on Relevo task 6.~~

- *2026-11-19.* Both fixes are built:
  - F-21 recreated the feeder views as definer views (PR #20).
  - F-22 makes the feeder write one tenant per transaction under that
    tenant's claim (PR #20).
- The reference feeder holds `bob_feeder` and ran both against a database
  (PR #21). Each guard was seen failing first (`contract-amendments.md`).
- That happened in the repository and in CI only. No box has them.

**`bob_app`** **[PROPOSED]**. The same mechanism. A request handler sets the
claim from the user's verified JWT. Background work, such as the ghost
reconciliation, iterates per tenant and sets each one. Whether user reads run as
`bob_app` with the user's claim, or as `authenticated` through PostgREST, is
A-05b's choice with the first route handler. It does not change the matrix.

**`bob_ai_ro`** **[PROPOSED]**. The inference service scopes every request to
one tenant (task 5.9: "scope by token, tenant and role") and sets that claim.
The `v_ai_*` views are **definer** views (Slice 3, R6; contract 0.6): `bob_ai_ro`
reads no table, so RLS cannot hold them. Each view filters on the caller's
`org_id` claim itself, and the tenancy suite proves it for every `v_ai_*` view
(`tests/tenancy.test.mjs`, R6).

**The claim is the whole boundary, and any session can set it** (review of
PR #40, I-1). `auth.jwt()` reads the GUCs `request.jwt.claim` and
`request.jwt.claims`, and any role can set them, even inside a SELECT with
`set_config`. Measured on #40 (`cca541e`): `bob_ai_ro` with tenant A's claim
that then sets tenant B's reads B's 918 cells, and the singular
`request.jwt.claim` wins over `request.jwt.claims`. It cannot be used today,
because `bob_ai_ro` is NOLOGIN with CONNECTION LIMIT 0. **Condition for giving
`bob_ai_ro` LOGIN (tasks 5.7 and 5.9):**
- the inference service never lets the model compose SQL. It runs a fixed set
  of queries over the `v_ai_*` views, and the model's output never reaches the
  SQL text;
- it sets the claim with `set_config('request.jwt.claims', …, true)`, so the
  claim lasts one transaction, once per transaction, from the tenant of the
  request's token;
- it clears `request.jwt.claim` (the singular) in the same transaction, because
  `auth.jwt()` prefers it.

Until those three hold, `bob_ai_ro` stays NOLOGIN, CONNECTION LIMIT 0.

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
| `bzzz/supabase` | `JWT_SECRET`, `SERVICE_ROLE_KEY`, the database superuser | `/opt/bzzz/secrets/supabase.env` (exists) | The database and auth containers and the operator scripts. Not the migration step (§8, objection 6) |
| none (new) | BOb's migration owner | `/opt/bob/secrets/migrador.env` | The migration step of §6.2, and nothing else |
| `bzzz/supabase-ro` | `bob_ai_ro` login | `/opt/bob/secrets/ai-ro.env` | The inference service |
| `bzzz/apps` | `bob_app` login | `/opt/bob/secrets/app.env` | The BOb container |
| none (new) | `bob_feeder` login | `/opt/bob/secrets/feeder.env` | The reference feeder first, then 3.7 (§3.1). From 2026-11-21 its container also runs the ghost reconciliation's read of `member_refs_seen` (Q6), through `bzzz-vecinos` since D77 (§5.2) |

- *2026-11-21 (Q6):* Henry moved the ghost reconciliation to the feeder
  container («El feeder»), and chose option (a) of §7, Q6, so the feeder
  container reads `feeder.env` alone. Under (a), (b) and (d) it reads `feeder.env`
  alone, and `app.env` keeps the BOb container as its only reader. Under (c)
  the feeder container would also read `app.env`, a second reader, which the
  rule below forbids.
- **One credential per file, and one reader per file.** Rotation follows
  `docs/OPERACION_rotacion_secretos.md`.
- **The LOGIN step.** A role becomes LOGIN and gets its password when the box is
  provisioned, not in a migration. A migration cannot invent a password
  (`20260902100300`, A-05).
  `bob_ai_ro` gets LOGIN only once the inference service meets the claim
  conditions of §3.3 (I-1).

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
- **A direct connection fits only on the box's machine.** BOb reaches Postgres
  on its own `internal` network with the box, `bzzz-vecina-bob`, and never on
  `bzzz-app` or across the internet. So BOb's application runs beside the box,
  from `/opt/bob/` (D77; §5.2).
  - *Before D77, this bullet read:* «So BOb's application runs in the box
    too, which is stage 4 and D41\*'s question. Until then, no production BOb
    connects to the box.» Rewritten per D77 (Henry, 2026-11-25): under D77,
    production BOb runs beside the box (`/opt/bob`) and reaches `supabase-db`
    over `bzzz-vecina-bob`, never across the internet.
- **The tenancy model is already settled.** Relevo task 7, ruling (d) made `org_id` the
  tenant key. **[DECIDED]** (Federico, Q2): for BOb, `organizations` and
  `org_id` replace runbook §7.3's `tenants` and `app_entities` (task 3.4),
  which are not built for BOb. `organizations.slug` stays equal to
  `bzzz.tenant` (A-01, A-02).

**[DECIDED]** Q3, in its 15 Nov form, which Federico accepted on BZZ-3 (not the
form of 12 Nov). Where BOb's schema runs before and beside the boxes:

- **Development** runs against a local Supabase, pinned to the box's images and
  to the CLI version CI pins (§6.2).
- **lab-02** (`bzzz-lab-02`) is the integration and rehearsal target. Every
  migration chain is applied there before `bzzz-model-01` and before any
  company box.
- **The hosted project** goes back to being the demo's. It never hosts BOb.
  This replaces the earlier ruling, after the Slice 2 questions, that made it
  this repository's interim target; N-08's backup condition for applying there
  no longer arises.

The reasons:

- Rehearsals and development on the same machine would interfere with each
  other, and silently.
- The box's Supabase is identity only, so it is not a place to develop
  against.

### 5.2 Networks — **[DECIDED]** (D77)

**D77** (BOb v1 beside the box, signed 2026-11-24; 77.3, 77.5, 77.8) moved
BOb's application and feeder **beside the box**, not into it. Both run from
BOb's own compose in `/opt/bob/`, outside Bzzz, as two containers: `bob-web`
(the application) and `bob-feeder` (the feeder). The database (`bob` in the
box's `supabase-db`) and GoTrue stay the box's (§5.1). The feeder reads what
BzzzBX knows through **`bzzz-vecinos`**, the box's read service for its
neighbour applications (the same one as OPR-6), and never joins `bzzz-data`.
The chain is applied by its own owner role, `bob_migrador` (D77 §2.8, 77.17;
O-3, 77.21; §6.2), after `postgres` installs it once. The running containers
connect as the three roles of §3, `bob_app` (`bob-web`) and `bob_feeder`
(`bob-feeder`), with `bob_ai_ro` for the inference service; none holds the
service role or `bob_migrador`'s credential (§3.4).

| Component | `bzzz-vecina-bob` (`internal`) | `bzzz-app` | `bzzz-data` (ClickHouse) | `bzzz-edge` |
|---|---|---|---|---|
| `supabase-db` (the box's) | yes | yes | no | never |
| `supabase-auth`, GoTrue (the box's) | yes | yes | no | yes |
| `bzzz-vecinos` (the box's) | yes | — | no: it reads ClickHouse with `bob_lector` on its own `internal` network, `bzzz-vecinos`, which only ClickHouse shares (77.23) | — |
| BOb application (`bob-web`) | yes | never | never | yes, through the box's gate (Traefik) only |
| Feeder (`bob-feeder`) | yes | never | never, it reads through `bzzz-vecinos` | no, and no Traefik labels |

- `bzzz-vecina-bob` is BOb's own `internal` network with the box (77.5).
  Only `supabase-db`, `supabase-auth`, `bzzz-vecinos` and BOb's containers are
  in it. No container of BOb is in `bzzz-app` or `bzzz-data` (D77 insumos
  §2.2, V1 and V4). `pg_hba` is set per network (77.13).
- The inference service (`bob_ai_ro`, task 5.7) is not placed by D77. Its row
  of the earlier table (`bzzz-app`, `bzzz-data`, `bzzz-edge` through Traefik)
  is not carried here, and is decided with it.
- What changes for Q6 (F-40, F-41): only where the feeder gets
  `member_refs_seen`, now from `bzzz-vecinos`. It still writes
  `bob.member_refs_seen` as `bob_feeder`, and `bob_app` reconciles from it.
- *Before D77 (2026-11-21, Q6, F-40):* this table had BOb's application and
  the feeder on `bzzz-app`, and the feeder on `bzzz-data` with a read-only
  ClickHouse role. That table is why Q6 moved the ClickHouse read to the
  feeder («El feeder»).

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
  - No Slice 2 migration before the contract is signed on Relevo task 6. Done:
    signed at 0.5.1 on 18 Nov, and Slice 2 was merged after that.
  - Slice 2's migrations bring the contract §10 guards and the role guards in
    §6.3. Four of the seven are built; §6.3 says which.

### 6.2 How the box applies them — **[PROPOSED]**

| Question | Proposal |
|---|---|
| What is applied | A BOb-engine commit on `main` with four green checks. The box pins the commit SHA, the way it pins images (D4, D9), and reports it in its manifest (task 3.11) |
| With what | `scripts/instalar-bob.sh` (O-3, below): the install chain with the Supabase CLI at the version CI pins (`SUPABASE_CLI_VERSION`, today 2.120.0), `supabase db push --db-url …` as `postgres` against `supabase-db` on `bzzz-app`, the provisioning, then every later migration with `psql` as `bob_migrador`, recorded by `postgres`. Every version lands in `supabase_migrations.schema_migrations`, as with CI's reset, so the same F-15 check reads the box |
| As whom | The migration owner, from `/opt/bob/secrets/migrador.env`, its own file (§8, objection 6). It owns every object, which the `SECURITY DEFINER` functions and definer views need. D77 §2.8 names it `bob_migrador` (LOGIN, NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE, no CREATE on the database), with what lies outside `bob` in Bzzz `config/supabase/vecinas/bob.sql`, applied by `postgres`. **Decided 2026-11-24 (O-3), Henry: «postgres una vez, luego migrador».** `postgres` applies the install chain once, when BOb is installed on a box; Bzzz's alta (bzzz#450) hands `bob` to `bob_migrador`; every other migration is applied by `bob_migrador`. See "Applied by `bob_migrador`" below |
| From where | A step in `scripts/actualizar.sh`, after the database and before any service that uses the new schema. That follows BzzzBX's rule of migration before code, as with the centro's 009 |
| Who runs it | Henry, in a maintenance window with notice to the company (CLAUDE.md: production is Henry's). Never an agent, and never a running service |
| How it is tried first | Development runs on a local Supabase pinned to the box's images and to CI's CLI version (§5.1, Q3 **[DECIDED]**). Then `supabase db push --dry-run` on `bzzz-lab-02`, the real apply there, then `bzzz-model-01`, then the company boxes. lab-02 is where every chain is applied first. This is plan §3.6's `--plan` habit, and D16's rule that tests run on another machine, never on a second copy |
| How it is checked after | A read-only check against the box: the applied versions equal the pinned commit's files, and the role guards of §6.3 that need no fixture. The full suite never runs against a company box: it loads and deletes a fixture |
| If it fails | See below. Nothing is rolled back by hand |

- *2026-11-21 (Q6, F-40):* moving the ghost reconciliation to the feeder
  container changes no row of this table. But options (a), (b) and (d) of
  §7, Q6 each need a new migration (a table, a function or a grant). It goes
  through this step, lab-02 first, like any other. Option (c) needs none.

**Applied by `bob_migrador` (O-3, D77 §2.8) — decided 2026-11-24.** Henry,
in the Relevo chat: «postgres una vez, luego migrador». The install chain, the
33 files listed with their sha256 in `supabase/provision/install-chain.sha256`,
is applied once by `postgres` when BOb is installed on a box. Then the
provisioning hands `bob` to `bob_migrador`, and every other migration is
applied by `bob_migrador` and must apply as it, inside `bob`. The install chain
is frozen: append-only, and a change to one of its files is a finding.

Why `postgres` keeps the install chain: measured from `746cf98` to `89e6f78`,
`bob_migrador` applies 12 of those 33 files and stops at 21, for the reasons
below. They stay as they are.

| Stop | Files | Clears with a grant in `bob.sql`? | Remedy |
|---|---|---|---|
| Creates in `public` (tables before the move to `bob`, and functions after it: `bob_autobotz_*`, `bob_outbox_*`, `bob_grant_feeder_staging`, `custom_access_token_hook`, …) | 17: `20260606120000` to `20261121140000` | Only `CREATE ON SCHEMA public`, which `postgres` can give, and D77 does not allow: BOb would own objects in a schema it shares. With that grant, `bob_migrador` ends owning 24 functions in `public` (25 objects outside `bob` in all) | Change the chain. A new box needs a chain that never creates outside `bob` (a baseline, below), and a forward migration moves the functions still in `public` into `bob`. `custom_access_token_hook` is called by GoTrue by name, so moving it also changes the box's GoTrue hook setting |
| Trigger on `auth.users` (`on_auth_user_created`, made in `…120000`, dropped in `…130000`) | `20260606120000`, `20261121130000` | No. `postgres` cannot grant TRIGGER on `auth.users` (owner `supabase_auth_admin`); `supabase_admin` can, but dropping it needs the owner | Change: the end state has no trigger, so a baseline never makes one |
| `ALTER PUBLICATION supabase_realtime ADD TABLE` | `20260606120002` | No. The publication is `postgres`'s and the neighbours share it; giving it to `bob_migrador` also fails (it would need CREATE on the database) | Change: the baseline leaves the publication alone. If bob-web needs Realtime on a `bob` table (not measured), `postgres` adds it in the same window, after the push |
| `CREATE ROLE bob_app …` | `20260902100300` | No. `bob.sql` creates the three roles, but `CREATE ROLE` checks CREATEROLE before it sees the role exists, and `COMMENT ON ROLE` needs it too | Change: the baseline expects the roles, made by `bob.sql` |
| `CREATE SCHEMA IF NOT EXISTS bob` | `20261118100000` | No. `bob.sql` creates `bob` for `bob_migrador`, but the statement checks CREATE on the database first | Change: the baseline expects the schema |

**The procedure on a box.** Henry runs it in a window, in this order. Steps 1
and 3 run only through root's copy of `scripts/firma-instalacion.sh`, on the
commit Henry names, from a tree written out of git objects into a directory of
root's (below, "What installs BOb"), never from the checkout:

No password goes on a command line, into shell history, or into a container's
environment. `instalar-bob.sh`, run as root from that tree, reads `postgres`'s
from the file named by `POSTGRES_ENV` (key `POSTGRES_PASSWORD`) and
`bob_migrador`'s from the alta's file, each by key, never sourced. It writes each to a pgpass
file, mode 600, in a private directory on tmpfs (`$XDG_RUNTIME_DIR` or
`/dev/shm`), removed on exit. With neither, the script stops rather than write
a password to disk. `POSTGRES_HOST` and `POSTGRES_PORT` say
where; the URL given to the CLI carries no password.

1. `sudo /opt/bob/bin/firma-instalacion caja <repo> <commit> cadena POSTGRES_ENV=…`. Pushes, as `postgres`, only
   the files in `install-chain.sha256`, each checked against its hash, with
   `supabase db push --include-all` from a work directory. On lab-02, where
   they are applied, this is a no-op. `--include-all` covers a history that
   lacks one of them.
2. Bzzz's alta, `scripts/generar-secretos-vecina.sh bob` with
   `config/supabase/vecinas/bob.conf` (bzzz#450, D77 77.17 to 77.22). **What
   counts on a box is that alta.** `supabase/provision/` in BOb-engine only
   imitates it for CI. Measured on `supabase/postgres:17.6.1.136`, `postgres`
   does it all in one transaction:
   - `bob_migrador` (NOLOGIN, CONNECTION LIMIT 1, none of the other
     attributes);
   - the application roles with their connection limits;
   - schema `bob`, and `bob.sql`;
   - the hand-over of everything in `bob` that is `postgres`'s.

   To do this, `postgres` takes two temporary permissions, `GRANT
   bob_migrador TO postgres WITH INHERIT FALSE, SET TRUE` and CREATE on the
   database for `bob_migrador`, and revokes both before the COMMIT. That
   works because on Postgres 16+ the creator of a role holds ADMIN on it.
   `supabase_admin` only grants USAGE on `auth` (77.22) and sets LOGIN and the
   password. The alta needs schema `bob` from step 1 to hand it over.
3. `sudo /opt/bob/bin/firma-instalacion caja <repo> <commit> resto POSTGRES_ENV=…`. `bob_migrador`'s
   connection comes from the alta's file, `/opt/bob/secrets/migrador.env`
   (`MIGRADOR_USUARIO`, `MIGRADOR_CLAVE`, `MIGRADOR_HOST`, `MIGRADOR_RED`). The
   script reads only those keys and never prints them. With
   `MIGRADOR_RED`, step 3 runs on that network, the one `bob_migrador` may
   connect from (77.13). The script creates no role or
   schema and never sets a password: the alta does.

   Every other migration, in order, is applied by `psql -c`, one call per
   file, with no node and no pnpm on the box (fifth review: `pg` in
   `node_modules`, a `preinstall` in `package.json`, would have run code no
   signature covered). A `-c` string goes to the server as one simple query:
   psql runs no metacommand and interpolates no variable in it unless it
   starts with a backslash (measured in CI: `SELECT 1; \! touch …` does not
   run the shell). With `MIGRADOR_RED`, that psql runs in the box's own
   Postgres image, read from the running container, on that network. Each
   file:
   - holding a backslash or a NUL byte anywhere, or a name outside
     `[A-Za-z0-9_.-]`, or more than 120000 bytes, is refused before it is
     sent;
   - goes with its row in `bob.schema_migrations` (its sha256) and one
     `COMMIT`, in one transaction, on one connection. A file that fails
     leaves nothing applied and nothing recorded. A file written as
     `BEGIN; … COMMIT;` on its first and last lines has those two blanked;
   - is checked after it runs: a random value set LOCAL before it must still
     be there. **This detects and reports; it does not prevent.** A file that
     ends the transaction (`COMMIT`, `END`, `ROLLBACK`, however quoted) is
     caught, not recorded, and the run fails; what it ran before that end
     stays committed. The session is read-only by default, so nothing after
     that end writes unless the file itself turns writing back on. A file
     written to dodge the check on purpose (saving the value at session
     level, then `COMMIT; BEGIN`) is not caught. That buys nothing:
     `bob_migrador` already holds every right such a file would use, and the
     file is in a signed, reviewed commit.

   **History.** `bob.schema_migrations`, owned by `bob_migrador` and made by
   the first run, holds every file after the install chain: version, name,
   its sha256, when and by whom. Nobody else holds a privilege on it.
   The CLI's `supabase_migrations.schema_migrations` holds the install chain
   and nothing else. It is shared by every neighbour: write access there would
   let `bob_migrador` record versions for anyone, and its primary key would
   tell which exist (fourth review). So `cadena` run again finds its history
   matching and does nothing (measured in CI). Not `supabase db push` as
   `bob_migrador`: the CLI creates and alters that table and stops with 42501
   (measured, run 45630458545).

   CI feeds `resto` sample files after the check:
   - a bare one and a wrapped one apply and are recorded, the record holding
     the file's sha256;
   - one failing on its second statement leaves neither its first statement
     nor a record;
   - `\!` between two `/* $$ */` comments, or between two `'$$'` strings, is
     refused and never runs;
   - `SELECT '--'; COMMIT;`, `/* -- */ COMMIT;`, `END;`, `END WORK;`,
     `ROLLBACK;`, and a `COMMIT` as the last statement are each caught and not
     recorded, and nothing after them writes;
   - `resto` and `cadena` run again change nothing.

CI runs the same three steps. Step 2 is a stand-in for the alta:
`supabase/provision/alta-ci.sql` as `postgres` and `alta-ci-supabase-admin.sql`
as `supabase_admin`, then LOGIN and the password, then a `migrador.env` like
the alta's. **`supabase/provision/bob.sql` is the content of Bzzz's
`config/supabase/vecinas/bob.sql`, and the two are kept identical**: a change
goes to both. Today it holds one grant, the PR-4 EXECUTE below.
`alta-ci.sql` includes it at the point where #450 reads it. The job runs on the
box's image,
`supabase/postgres:17.6.1.136`, pinned through `supabase/.temp/postgres-version`
and checked from the running container, not on CI's 15. The stand-in keeps
#450's names (`bob_migrador`, schema `bob`, `bob_app:10`, `bob_feeder:4`,
`bob_ai_ro:0`), its order and its transaction.

**What `bob.sql` holds.** It is Bzzz's `config/supabase/vecinas/bob.sql`
(bzzz#450 at `7429eec`), and `supabase/provision/bob.sql` is a byte-for-byte
copy. The O-3 check pins its sha256 (`ad9adf91…2605`) and fails if the copy
changes. A change goes to both and to the pinned hash. It holds one grant:
`GRANT EXECUTE ON
FUNCTION public.bob_grant_projection(regclass) TO bob_migrador`, inside a
`DO` that checks `to_regprocedure` first, because on a new box the function
does not exist until the chain is applied. `bob.conf` declares it as
`FUERA=bob_migrador|function|public.bob_grant_projection(pg_catalog.regclass)|EXECUTE`.
The alta applies it as `postgres`, after the two temporary permissions are
revoked, and so does the stand-in.

Why the grant is needed: `bob.proj_ensure_partition` is SECURITY DEFINER and,
after the hand-over, runs as `bob_migrador`. It calls that helper (PR-4), which
is `postgres`'s, with EXECUTE revoked from PUBLIC. Without the grant, the
feeder fails with 42501 on the first new month (seen red in CI). The grant
goes when the helper moves into `bob`, with the forward migration below.

The footprint of `bob_migrador` outside `bob` must be exactly:
- LOGIN and none of the other attributes, replication included;
- CONNECT and TEMPORARY on the database;
- no role it is a member of;
- as members: `postgres`, with ADMIN only, neither INHERIT nor SET. On
  Postgres 16+ the creator of a role gets that row, and #450's V14 admits it
  in that exact form. On 15 it would be none.
- two privilege entries outside `bob`: schema `auth`, and the PR-4 helper;
- USAGE on `auth` and on `public`.

It reads from `pg_shdepend` every object, in any database, that the role owns,
holds a privilege on, or is named in a policy of. So a grant of any kind
outside `bob` shows, and so does a default privilege, with or without a
schema (measured).

SECURITY DEFINER code runs as its owner. The check fails in either case:
- a function outside `bob`, still `postgres`'s, loses USAGE on `bob` or every
  privilege on a `bob` table it names;
- a function in `bob`, now `bob_migrador`'s, calls a function outside `bob`
  that `bob_migrador` cannot execute.

A name counts whether it is qualified or left to the function's own
`search_path`. Not seen: a name built at run time with `EXECUTE format(…)`.
Measured on 17.6.1.136 (and, before the alignment with #450, on 15):
- Nothing in `bob` is left to another owner.
- Of the functions outside `bob` that name it, one is SECURITY DEFINER,
  `public.bob_autobotz_record_verification`, and keeps what it reads.
- `bob.proj_ensure_partition` creates a new month as `bob_migrador`.

Not measured: what the hand-over changes for the other SECURITY DEFINER
functions in `bob` on a box with data, beyond what they call. What `bob` opens
to `anon`, `authenticated` or PUBLIC is still pending; nothing here watches it.

A box installs only what Henry signed (B2; Henry, «Firma con llave que pide
toque»). **He signs when he installs on the box** (Henry, «Al instalar en la
caja»), not on each PR: the box always demands the signature, and the CI check
is informative only. Everything is in one self-contained script,
`scripts/firma-instalacion.sh` (`huella`, `mensaje`, `verificar`, `caja`).

**What the signature covers: the whole tree.** A digest computed from git
objects, never the working tree, the index or `.gitattributes`: one line per
file, `mode path sha256` of the blob's bytes, sorted, then the sha256 of the
lines. Every file of the commit counts except
`supabase/provision/aprobaciones/`: migrations, scripts,
`supabase/config.toml`, `package.json`, docs, everything (sixth review: a list
left `supabase/migrations/` out). A symlink, a submodule, or a path outside
`[A-Za-z0-9_./-]` or with a `..`, `.` or `.git` component is refused.

**What Henry signs: the pair.**

```
bob-install-chain 1
base <digest of what the box runs>
nueva <digest of what it will run>
```

as `<base>-<nueva>.aprobacion` and its `.sig`. Signing the pair means an old
signature cannot bring back a state already left: a box only moves from where
it stands.

**How Henry signs, at install time.** On his machine, from a clean checkout
of `main`, with the key at hand:

```
scripts/firmar-instalacion.sh <commit-to-install> --base <commit-the-box-runs>
```

It runs `main`'s `firma-instalacion.sh` on both commits as git objects, shows
the log and the whole diff between them (no external diff, no textconv), asks
for `firmo`, and signs the pair with `ssh-keygen -Y sign -n bob-install-chain`
(the touch and the PIN). It writes the two files into a new directory under
`$TMPDIR` (never the checkout) and commits nothing. Henry copies them to the box's `/opt/bob/aprobaciones/`, as
root. An approval may also be committed under `supabase/provision/aprobaciones/`;
the box reads either. The namespace is its own: **this key is not the one in
Bzzz's `config/bob/firmantes_imagen`**.

**On the box: the protection.** Once, as root, from a commit Henry has
reviewed:

```
sudo install -d -o root -g root -m 755 /opt/bob /opt/bob/bin /opt/bob/aprobaciones
sudo install -o root -g root -m 755 scripts/firma-instalacion.sh /opt/bob/bin/firma-instalacion
sudo install -o root -g root -m 644 supabase/provision/firmantes_instalacion /opt/bob/firmantes_instalacion
sudo install -o root -g root -m 644 /dev/null /opt/bob/aprobaciones-revocadas
printf '%s\n' <IP of bzzz-supabase-db on bzzz-app> bzzz-supabase-db | sudo tee /opt/bob/hosts-permitidos
echo <digest> | sudo tee /opt/bob/instalacion-firmada && sudo chmod 644 /opt/bob/instalacion-firmada   # no BOb yet: /opt/bob/bin/firma-instalacion vacia | sudo tee …
sudo install -d -o root -g root -m 700 /root/bob-install
sudo install -o root -g root -m 600 /dev/null /root/bob-install/postgres.env   # then write POSTGRES_PASSWORD=… in it
```

`instalacion-firmada` holds the digest of what the box runs today
(`scripts/firma-instalacion.sh huella <that commit>`), or the empty base on a
box with no BOb (below). It is root's word, not a signature: write the digest
the box really stands at. `caja` writes two more files, never written by hand:
`instalacion-aprobacion`, the pair `<base>-<digest>` the box reached its state
with (running the same digest again, as `resto` after `cadena`, accepts that
pair alone, verified again), and `instalacion-en-curso`, a `cadena` from the
empty base that has not ended well.

- **The empty base (H4, BossTechnology/BOb-engine#54).** On a box that runs
  no BOb yet, there is no commit to take the digest of. Henry decided «Defined
  empty base» (2026-11-25). Such a box stands at the empty base,
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. It is
  the sha256 of nothing (`scripts/firma-instalacion.sh vacia`), and no tree's
  digest can be that value. `<digest>` above is that value, and Henry signs
  the first install from it: `scripts/firmar-instalacion.sh <commit> --base
  vacia`. It is the only state a box may claim without a signature, so it is
  checked. From it, `caja` runs only `cadena`. `instalar-bob.sh cadena` then
  refuses, before anything is pushed, a database with any trace of BOb, found
  from the tree: a version of one of its migrations in the CLI's history, a
  role `bob` or `bob_*`, schema `bob` with anything in it or a schema owned by
  a `bob_*` role, or a relation, function or type named as one that BOb's
  migrations create, in any schema not owned by `supabase_admin` (so a renamed
  schema, or BOb's legacy objects in `public`, are found). If that `cadena`
  fails halfway, its retry, signed from the empty base too, accepts what a
  partial chain leaves and nothing more: history inside the install chain
  only, no `bob.schema_migrations`, no `bob_*` role that can log in. A box with the chain
  applied (lab-02) never uses it: its `instalacion-firmada` holds the digest it
  stands at, and Henry signs from there. **Not yet measured** on a database
  with no BOb: the first install from the empty base is that measurement.
- **How root on the host reaches the database (B3).** `bzzz-supabase-db`
  publishes no port, and its container name does not resolve on the host. So
  `POSTGRES_HOST` is its IP on `bzzz-app`:

  ```
  docker inspect -f '{{(index .NetworkSettings.Networks "bzzz-app").IPAddress}}' bzzz-supabase-db
  ```

  Both that IP and `bzzz-supabase-db` (the alta's `MIGRADOR_HOST`) go in
  `hosts-permitidos`. **Not yet measured through `firma-instalacion`**: it is
  measured at the lab-02 rehearsal. The IP can change when the container is
  recreated, so read it again before each install.
- **The `postgres` password file (B2) lives outside `/opt/bob/secrets/`.**
  Bob-New's `deploy.sh` (`deploy/caja/lib.sh`, the `secrets/` check) refuses
  any root-owned file in `secrets/` other than `migrador.env`. The proposed
  location is `/root/bob-install/postgres.env`: directory 700, file 600, both
  root's, with one key, `POSTGRES_PASSWORD`.

**Before an install (H5).** `firma-instalacion caja` needs, on the box:
- to be run **through `sudo` from Henry's own user**, not from a root shell:
  it reads `SUDO_UID` and refuses without it;
- the **Supabase CLI at the version CI pins** (2.120.0 today) on its fixed
  `PATH` (`/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin`), for
  `cadena`;
- **psql 16 or newer** under `/usr/lib/postgresql/<v>/bin/` (it takes the
  newest there, not Debian's `/usr/bin/psql` wrapper; 16 for
  `PGREQUIREAUTH`), plus **`git`, `setpriv` and `flock`**;
- a **tmpfs** (`$XDG_RUNTIME_DIR` or `/dev/shm`) for the password files, or
  `instalar-bob.sh` stops rather than write them to disk;
- the commit as its **full 40-character SHA** (`git rev-parse HEAD`). **Never give this
command `SETENV` or `env_keep` in sudoers**: the connection settings go as
arguments. Every install:

```
sudo /opt/bob/bin/firma-instalacion caja <repo> <commit> cadena POSTGRES_ENV=/root/bob-install/postgres.env POSTGRES_HOST=<that IP>
sudo /opt/bob/bin/firma-instalacion caja <repo> <commit> resto  POSTGRES_ENV=/root/bob-install/postgres.env POSTGRES_HOST=<that IP>
```

It:
1. re-runs itself under `env -i` and `bash -p`, with a fixed `PATH` (system
   directories first) and `HOME=/root`, and only `POSTGRES_ENV`,
   `POSTGRES_HOST`, `POSTGRES_PORT`, `MIGRADOR_ENV` and `MIGRADOR_PUERTO`,
   given as `VAR=value` arguments, each checked (a path, a host not starting
   with `-`, a port); any other is refused. Root sends a password only to
   loopback or to a host listed in `/opt/bob/hosts-permitidos` (root's; the
   database's container name, for one): `POSTGRES_HOST`, and `MIGRADOR_HOST`
   from the alta's file, are checked by `caja` and again by `instalar-bob.sh`.
   `psql` runs with `PGREQUIREAUTH=scram-sha-256` (libpq 16+), so it refuses a
   server that does not ask for SCRAM. It does not act for `cadena`'s
   `supabase db push`, whose driver does not read it, nor for the psql in the
   database's container with `MIGRADOR_RED`, whose libpq is 15; the host check
   still applies to both. `resto` needs the alta's file (`MIGRADOR_ENV`) to
   exist, and a connection file must be readable by root only (600);
2. refuses unless these are root's and writable by nobody else: `/opt`,
   `/opt/bob`, `/opt/bob/bin`, itself, the signers file, the revocation list,
   the state file, `/opt/bob/aprobaciones/` and each approval in it, and the
   connection files along their whole path. Nothing it may run is listed by
   hand: every directory of the fixed `PATH` and `git --exec-path` must be
   root's along its whole path, every file in it root's and writable by no
   group or other, and every link in it root's hop by hop, each hop along its
   whole path (`/usr/bin/awk → /etc/alternatives/awk → /usr/bin/mawk`). psql
   is called by its real binary, the newest `/usr/lib/postgresql/<v>/bin/psql`,
   checked with its directory, not through Debian's `pg_wrapper` (a perl script
   loading modules from outside the `PATH`). Not checked: shared libraries, the
   loader, and what an interpreter loads. Nor what runs before any check:
   `sudo` itself and the `#!/bin/bash -p` that starts this script;
3. takes a lock (`flock` on `/opt/bob/.instalando`) and removes work
   directories an interrupted run left;
4. fetches the commit by its sha into a new repository of root's, with
   `transfer.fsckObjects` and `git-upload-pack` running as the caller
   (`setpriv`, from `SUDO_UID`), and writes its tree byte for byte from the
   blobs into a directory of root's, 700. Nothing reads the checkout's working
   tree, index, attributes, hooks or fsmonitor;
5. needs `<this box's state>-<digest>.aprobacion` (or, when the box already
   stands at the digest, any approval of it) holding exactly that pair, not
   revoked, signed by a key in `/opt/bob/firmantes_instalacion`;
6. for `cadena`, needs the `supabase` CLI to be the version CI pins
   (`SUPABASE_CLI_VERSION`, read from the signed tree);
7. shows the commit, the pair, the settings and where it sends passwords,
   then the commit's log (non-printing characters removed), then the commit,
   the pair and the settings again, and installs only if Henry, at a
   terminal, types `instalo`. That is a last look, not proof that Henry is
   there: the barrier is the signature;
8. runs `instalar-bob.sh` from that directory, as root, and only if it ends
   well writes the new digest as the box's state. The directory is removed.

`instalar-bob.sh` refuses unless it runs as root in `/opt/bob/trabajo.*/arbol`,
root's, with `BOB_FIRMA_VERIFICADA` set; only CI skips that, on a stack it
throws away.

**Withdrawing an approval.** A signed approval cannot be taken back from
wherever it was copied. The stop is `/opt/bob/aprobaciones-revocadas` (root's) lists digests or
`<base>-<nueva>` pairs, one per line, `#` for comments; an approval of a listed
digest or pair is refused. When a signed change is abandoned, Henry adds it
there on every box.

**The verifier**, the same in CI and on the box, accepts only
`sk-ssh-ed25519@openssh.com` or `sk-ecdsa-sha2-nistp256@openssh.com` keys
bound to `namespaces="bob-install-chain"`, with `verify-required`, never
`no-touch-required` and never `cert-authority`; the verify output must name an
`-SK` key. No key, or any doubt, fails. `sk-` does not prove hardware, and
FIDO attestation is not verified here; to keep that proof, generate the key
with `ssh-keygen -t ed25519-sk -O verify-required -O write-attestation=<file>`.

**CI: informative.** `.github/workflows/install-approval.yml`, job "Install
signature, informative (O-3)", runs from `main` on `pull_request_target`,
reads the PR as git objects only, and says whether the PR's tree carries an
approval from `main`'s digest and whether it verifies. It always passes and is
never required: ordinary PRs need no key.

**Bootstrap: Henry's key.** Henry's public key goes in
`supabase/provision/firmantes_instalacion` **in #48 itself**, from his own
machine:

```
henry namespaces="bob-install-chain",verify-required sk-ssh-ed25519@openssh.com AAAA…
```

He checks the fingerprint (`ssh-keygen -lf`) against the one the physical key
shows when it signs. Each box takes its copy at bootstrap; a later key change
is a new copy installed by root.

Measured without a database (`tests/install-approval.test.mjs`), with
`caja-prueba`: the same code as `caja`, never as root, with a directory for
`/opt/bob`, any listed key accepted, the system `PATH` only, and no lock, no
`setpriv` and no check of the machine's programs (tested apart, with
`herramienta`; on GitHub's runner `psql`'s directory is writable by others, and
`caja` would refuse it). Measured: the digest's cover and refusals; the verifier's refusals;
the box runs the committed tree from its own directory with a clean
environment and the settings given as arguments; it refuses a new unsigned
migration, a replayed or revoked approval, a wrong text, an unlisted signer,
no confirmation, a missing state or revocation list, writable signers, root,
approvals or connection files, an odd setting; a program not root's is
refused; the state moves only after success; a modified file,
`skip-worktree`, a corrupt index and an fsmonitor hook change nothing. Not
measured: a real security key, `caja` as root on a box, `setpriv` and
`flock`. Henry's first install is that measurement.

`.github/CODEOWNERS` puts the whole repository under Henry. **Making
code-owner review required is Henry's setting in branch protection.**

The guard: the CI job "Chain applies as bob_migrador (O-3)", on
`supabase/postgres:17.6.1.136`, **still to be made a required check by
Henry**; it is the only O-3 check to require. Today `main` requires the other
four. They fail if:
- `instalar-bob.sh` stops: an install file is edited, `postgres` cannot push
  the chain, the provisioning fails, or a later migration does not apply as
  `bob_migrador`, whatever its date;
- a migration file (the CLI's rule: digits, an underscore, `.sql`) is not
  recorded as applied;
- the provisioning, applied once more, fails or only warns;
- after the hand-over, anything in `bob` is not `bob_migrador`'s;
- a SECURITY DEFINER function lost what it uses;
- the footprint is not exactly the one above.

Each run also checks, as `bob_migrador`, that these are refused:
- creating in `public`, or a schema;
- altering or dropping a function BOb left in `public`;
- altering `auth`;
- adding to `supabase_realtime`.

And that these apply:
- creating in `bob`;
- altering a table, adding a policy and replacing a view the install chain
  made there;
- a REVOKE;
- a new month through `bob.proj_ensure_partition`.

And that each of these is seen: a definer in `bob` that lost EXECUTE outside
it; a default privilege; an extra schema privilege; a privilege on a table or
a function outside `bob`; a membership either way; an attribute.

Seen red:
- with the stops list empty (21 findings);
- with one extra grant and a migration creating `public.o3_sabotage`;
- in phase B, with a new migration altering `public.cap_alert_log()`;
- with an install file edited, a new migration dated inside the install chain
  altering `public.cap_alert_log()`, and `GRANT SELECT ON auth.users` in the
  provisioning (run 45548002703): exactly 3 findings;
- with the PR-4 EXECUTE dropped from the provisioning, on 15 and 17 (run
  45635387478): three findings, all about that grant. These are the definer
  guard, the footprint, and the new month that cannot be created;
- with a new migration altering `public.cap_alert_log()`, on 15 and 17 (run
  45637041182): `instalar-bob.sh` stops with `must be owner of function
  public.cap_alert_log`.

Each sabotage was reverted.

Pending, no date: a baseline migration that does not leave `bob`, reproducing
today's end state, after 0.6. Until it exists, a new box gets the install
chain from `postgres`. The forward migration that moves the remaining
functions out of `public` goes with it.

**If a migration fails mid-chain.** What these inputs say today is read, not
measured:

- The push stops at the failing file. Files already applied stay applied and
  recorded, and the rest wait.
- Every migration since `20260902100000` wraps its work in `BEGIN … COMMIT`,
  and new ones must, so a failed file should leave nothing half-done. That
  comes from reading the files; no run has shown it.
- Nine older files (`20260606115900` to `20260830100000`) are not wrapped. On
  a new box they run first. They have all run in CI from an empty database.
  The count is read from the files on `main` on 2026-11-18: nineteen
  migrations, ten wrapped, nine not.
  - *2026-11-19:* twenty-three on `main` at `c4ebf1d`, fourteen wrapped and
    nine not. The four new ones are Slice 2's, and all are wrapped.

**[DECIDED]** as a condition (Federico): **before the first maintenance
window, not before the signature**, two things exist.

1. **A rehearsal on lab-02.** A dump is taken first. Then a chain is applied
   with one migration rigged to fail in the middle of it. The rehearsal
   records:
   - what `supabase_migrations.schema_migrations` says afterwards;
   - which objects exist;
   - whether the failing file left anything behind.
   - *2026-11-20 (F-27):* whether `pg_net` or `http` is installed on lab-02, by
     running `scripts/box-check.mjs`, which prints both.
2. **A written procedure for when it happens.** There are two ways forward:
   - **Go forward with a fix:** a new migration (append-only), applied by the
     same step.
   - ~~**`restore.sh`:** it returns the whole database, identity accounts
     included. That cost is why the choice between the two is written down
     beforehand and is not worked out during a window.~~
   - **[FINDING] 2026-11-19.** That line was wrong, read against Bzzz
     `scripts/restore.sh` and `scripts/backup.sh` on `main`:
     - `restore.sh --restaurar` restores ClickHouse (`bzzz.*`) only. For the
       portal's identity it prints "restaurar a mano", following
       `docs/OPERACION_restaurar_identidad.md`. A restore over an initialised
       `auth` schema leaves `auth.users` created and empty, measured on
       2026-09-07.
     - `backup.sh` dumps all of `supabase-db`'s `postgres` database nightly
       and verifies only the `auth.users` count. Any `bob` schema would ride
       in that dump unverified.
     - Today no automated path restores Postgres in the box. What replaces
       this line is §8, objection 2, as answered.

*2026-11-20, built, not yet run on lab-02.* Item 1 is
`scripts/ensayo-migracion-lab.sh`, and item 2 is
`docs/p5-failed-migration-procedure.md`. Both were run end to end against a
local copy of lab-02's identity stack. What they measured is in
`Documentation/contract-amendments.md` ("P5 · The lab-02 rehearsal kit"):
- with CLI 2.120.0 a failing file leaves nothing behind, wrapped or not;
- F-35: `GRANT … TO current_user` terminates the server on the box's image;
- F-36: `pg_dump -n bob` loses the publication membership;
- F-37: CI runs Postgres 15 and the box runs 17.6.

The lab-02 run was done on `bzzz-lab-02` on 2026-11-21, with BOb-engine
`5e5b9be`: 41 checks, all as expected (BzzzBX
`evidence/ENSAYO/2026-11-21_ensayo_p5_bzzz-lab-02.md`, bzzz#393). D62 62.8
records it.

### 6.3 Guards the roles add — **[PROPOSED]**

These are in addition to contract §10. Each one is seen failing first. P5
declares them, with the F-21 and F-22 fixes. Slice 2 built four of them, and
the other three were built on 2026-11-20. The third column says where each one stands.

| Guard | Asserts | State on 2026-11-19 |
|---|---|---|
| Three roles, no more | The only non-Supabase LOGIN roles with any privilege in `bob` are `bob_app`, `bob_feeder` and `bob_ai_ro`. None is SUPERUSER or BYPASSRLS | Built (2026-11-20, `tests/p5-roles.test.mjs`). Discovered from the catalog, LOGIN or not, through ownership, grants, column grants, default privileges and membership. Also checks the three are not CREATEDB or CREATEROLE (§3.2), and none can become another role. Runs in the box check |
| Feeder views readable | As `bob_feeder`, both feeder views return rows for both fixture tenants, and the base tables refuse (F-21) | Built (PR #20) |
| Feeder scoped by claim | As `bob_feeder` with tenant A's claim, a tenant B row is refused (F-22) | Built (PR #20, PR #21) |
| Feeder reads nothing else | As `bob_feeder`, every non-projection table and every view other than the two refuses SELECT | Built (PR #20) |
| `bob_ai_ro` reads views only | As `bob_ai_ro`, UPDATE is refused, and any base table refuses SELECT (route-plan test, IR-1) | Built (2026-11-20). There are no `v_ai_*` views yet, so the guard asserts `bob_ai_ro` reads exactly the `v_ai_*` views, which today is none |
| History is append-only | As `bob_app`, UPDATE and DELETE on `actor_ref_history` are refused | Built, by trigger (§3.2) |
| No egress from the database | No installed extension outside the approved five, no foreign server, no untrusted language but `c` and `internal`; and none of the three holds EXECUTE on a function of a known egress extension (`dblink`, `http`, `pg_net`, `postgres_fdw`, `wrappers`), wherever installed | Built over what is installed (2026-11-20), and green because neither is installed. **[FINDING] F-27:** installing either one gives PUBLIC EXECUTE, so all three can call them. Henry chose (a) on 2026-11-20, then closed it by (c) on 2026-11-21, after lab-02 showed neither installed: the guard also fails if either extension is installed, in any schema, in CI and in the box check. Corrected 2026-11-22 to fail closed: any extension outside the approved five, any foreign server, any untrusted language but `c` and `internal` |

---

## 7 · What the decision has to answer

Three questions for Federico, and three for Henry. None reopened a ruling.
Q1–Q5 were answered by 2026-11-18. Q6 came from Slice 2 on 2026-11-19 and was
answered the same day. Henry changed that answer on 2026-11-21, which reopens
how it is built (Q6 below). D62 was signed on 2026-11-25 (bzzz#457).

1. **Q1 · Are these the three roles?** `bob_app`, `bob_feeder` and `bob_ai_ro`,
   from Handoff §4.3, with `bzzz/supabase-ro` being `bob_ai_ro`. The route plan
   asks who requested "the three roles" (`INSUMOS_D29` §7).
   **Answered** (Federico, 12 Nov): yes, the three as Handoff §4.3 defines
   them. The matrix in §3.2 stands.
2. **Q2 · Is runbook §7.3's tenancy model superseded for BOb?** BOb's
   `organizations` and `org_id` (Relevo task 7, ruling (d)) instead of `tenants` and
   `app_entities`, in the box's `supabase-db`, schema `bob`.
   **Answered** (Federico): yes. `organizations.slug` stays equal to
   `bzzz.tenant` (§5.1).
3. **Q3 · The hosted project.** Does it stay as BOb's development target once a
   box carries BOb, or does it go back to being only the demo's?
   **Answered** in its 15 Nov form, accepted by Federico on BZZ-3, not the
   12 Nov form: development on a local Supabase pinned to the box's images and
   CI's CLI; lab-02 as the integration and rehearsal target; the hosted project
   is the demo's and never hosts BOb (§5.1, §6.2).
4. **For Henry · the feeder's home.** Which process holds `bob_feeder` first:
   the reference feeder or 3.7.
   **Answered** (Henry, BZZ-19, 18 Nov): the **reference feeder**. It can run
   against the local Supabase before 3.7 exists, so F-21 and F-22 are run
   against a database and not only read. 3.7 takes the same credential
   afterwards (contract §1).
5. **For Henry · the numbering.**
   **Answered** (Henry, 18 Nov): **D62**.
   - *2026-11-18:* BZZ-19 had said D60. D60 was signed in Bzzz that day for
     another matter (the batch at the root of SendGrid), and Henry reassigned
     P5 to D62.
6. **For Henry · F-26, who schedules the ghost reconciliation.**
   The reconciliation runs as `bob_app` (contract §7.2). It needs each
   tenant's `org_id` and slug, and `bob_app` cannot list tenants under RLS.
   That is correct for a tenant-scoped credential. What Slice 2 built: the
   scheduler hands it `(org_id, tenant_slug)`, and no grant was widened. Henry
   agreed to this on 18 Nov. P5 has to say:
   - which process runs the scheduler;
   - where it runs;
   - with what credential it reads the tenant list.
   It cannot be `bob_app` (RLS) or the service role (§3.4).
   ~~**Answered** (Henry, 2026-11-19): **(a) the BOb container.**~~
   Superseded on 2026-11-21 (below). The 19 Nov reasoning is kept as it was
   written. Its first bullet still stands, since the box has one tenant.
   - Objection 3 settled one organization per customer box, so the box
     already knows its only tenant. Its `org_id` and slug are fixed when the
     box is provisioned. Nothing has to list organizations from the
     database.
   - A timer inside the BOb application runs the reconciliation as
     `bob_app`, under that `org_id`'s claim.
   - The `org_id` and slug reach it as box configuration, written at
     provisioning. They are not secrets, so they live in a configuration
     file, not in `bob/app.env`.
   - No new credential and no widened grant. If the container is not
     running, neither is the reconciliation, and nobody is there to see the
     ghosts either.
   - The rejected option was a host timer (systemd or cron). It would be one
     more process reading `bob/app.env`, which breaks §4's one reader per
     file.

   **Answered again** (Henry, 2026-11-21): **«El feeder».**
   - The reconciliation asks the truth store for `member_refs_seen`
     (`reconciliation/ghosts.mjs`, `truth.memberRefsSeen`). The truth store is
     ClickHouse, and §5.2 keeps the BOb application off `bzzz-data`. So the
     19 Nov answer could not read what it reconciles.
   - The feeder container already reads ClickHouse, with its read-only
     role (task 3.6). It runs the reconciliation, not the BOb container.

   **[FINDING] F-40 · as built, the feeder cannot run it without a new
   grant.** Read against `main` (`742aa37`):
   - `reconciliation/ghosts.mjs` runs as `bob_app`, one tenant per
     transaction under the `org_id` claim. It reads `channels`
     (`source_key`, `lag_seconds`) and `actor_external_refs`. It inserts
     into `actors`, `actor_external_refs` and `actor_ref_history`. It
     deletes the `actors` row it made when it loses a race. `linkMemberRef`
     updates `actor_external_refs`.
   - `bob_feeder` holds none of that: SELECT on the two feeder views, the
     projections, and EXECUTE on the partition function (§3.2;
     `20261118100100`, `20261119100000`, `20261118100200`).
   - Q13 (11 Nov): the feeder never creates an actor.

   Nothing was widened. Four options were put to Henry.
   **Answered** (Henry, 2026-11-21): **«Go with (a)».**
   - **(a) Recommended. The feeder reads, `bob_app` writes.** The feeder
     container reads `member_refs_seen` from ClickHouse and writes it to a
     new table in `bob` (for example `bob.member_refs_seen`: `org_id`,
     `channel_id`, `ref`, window). It writes one tenant per transaction under
     that tenant's claim, as F-22 does. RLS by `org_id`, INSERT only for
     `bob_feeder`, SELECT and DELETE for `bob_app`. It can leave out refs
     that `v_feeder_actor_map`, which it already reads, already maps. The
     BOb container's timer reconciles from that table as `bob_app`, as on
     19 Nov, reading nothing from ClickHouse.
     - *Why:* the half that needs ClickHouse is in the feeder, as Henry
       ruled. The half that creates actors stays `bob_app`, so Q13, PR-4 and
       §4 stand as written.
     - *Cost:* one table, one INSERT grant to `bob_feeder` on that table
       only, one migration, and a contract amendment (§7.2 and §7.3a, the
       window's source). The reconciliation's tests keep their shape: the
       table stands in for `truth.memberRefsSeen`.
   - **(b) A definer function the feeder calls.** A `SECURITY DEFINER`
     function, owned by the migration owner, with EXECUTE to `bob_feeder`
     alone, does the reconciliation, guard included. The partition function
     is the precedent (contract §3).
     - *Why:* the whole reconciliation runs in the feeder container, with no
       grant on any table.
     - *Against:* the feeder then creates actors, through the function. That
       reverses Q13 in substance and needs Federico's ruling. The guard moves
       from JavaScript into SQL. Not recommended unless (a)'s extra table is
       unwanted.
   - **(c) The feeder container also holds `bob_app`.** It runs today's code
     unchanged, as `bob_app`.
     - *Why:* no grant and no migration.
     - *Against:* a second reader of `bob/app.env`, the exact reason the host
       timer was rejected on 19 Nov (§4). Two roles in one process also blurs
       the guard that the feeder holds `bob_feeder` and nothing else. Not
       recommended.
   - **(d) Widen `bob_feeder`.** INSERT, UPDATE and DELETE on `actors`,
     `actor_external_refs` and `actor_ref_history`, and SELECT on
     `channels`.
     - *Against:* it reverses Q13 and the §3.2 entry that the feeder holds no
       grant on `channels` or `actors`. The §6.3 guard "Feeder reads nothing
       else" would have to change. Not recommended.
   - Under (a), that guard stands as built: an INSERT grant gives no read.

   **Built** (branch `p5-q6a-staged-member-refs`, F-41, not merged, not
   applied to any box): `bob.member_refs_seen` with RLS by `org_id`, INSERT
   for `bob_feeder`, SELECT and DELETE for `bob_app`; the reference feeder's
   `stageMemberRefs`; and `reconciliation/ghosts.mjs` reading the table, still
   as `bob_app`, with the trailing window of H3 and the 395-day sweep. The
   contract amendment to §7.2 and §7.3a is proposed with it.
   After the review of PR #33: refs held to `m:` and 256 characters, one
   run row per tenant per staging run (`bob.member_refs_runs`) and a box-check
   warning when it is old, staging in batches with each tenant isolated, and
   the cadence rule: the feeder stages the trailing window at least as often
   as `bob_app` reconciles; a row staged later waits for the sweep.

**What stands between these inputs and the signature.**

- **Before signing:**
  - The devil's-advocate review on P5. It was run on 2026-11-19, and its seven
    objections are in §8.
  - Henry's answers to §8 and to Q6, all given on 2026-11-19.
  - *2026-11-21:* Henry's choice among Q6's options (a) to (d), after he
    moved the reconciliation to the feeder. Given the same day: (a). Building
    it (the table, its grant, the migration and the contract amendment of
    §7.2 and §7.3a) comes after, and goes through §6.2 like any migration.
    Built on branch `p5-q6a-staged-member-refs` (F-41); the migration reaches
    a box only through §6.2, lab-02 first.
- **Before signing as well** (Henry, 2026-11-19, §8 objection 5): the
  failed-migration rehearsal on lab-02, including a restore of `bob` alone,
  and the written procedure (§6.2).
- ~~**Behind another signature:** the F-21 and F-22 fixes and the §6.3 guards
  travel with Slice 2's migrations, which wait for the projection contract 0.5
  (PR #17, open).~~ Done: Slice 2 is merged, and the fixes and four of the
  seven §6.3 guards are built (§3.3, §6.3).

**Not in P5.** These belong to other decisions:

- the box sizing with the application layer (D38\*);
- PostgREST and Studio in the box (task 3.1);
- the evidence packages' ClickHouse shape (3.7, against the contract);
- the centro's phases 3 and 4 (D40\*, D41\*);
- the MCP (D50).

---

## 8 · Devil's-advocate review, 2026-11-19 — answered

The review ran before the signature, as §7 required. It argues *against* P5
on purpose. Each objection is the strongest form of it, not a balanced view.
Henry answered each one on 2026-11-19, either with a change to P5 or with a
reason it does not apply. His answer is recorded under each objection.

Ordered from the most damaging to the least.

1. **P5 fixes where the database lives before deciding where the application
   runs.**
   - N-04's direct connection only works if BOb's application runs inside the
     box (§5.1), and that is D41\*'s question, still open. Today v1's base is
     the Bob-New demo, a Next.js app that does not run in a box.
   - If D41\* leaves it outside, P5 forces exposing Postgres or PostgREST
     through `bzzz-edge`, which §5.2 forbids. The other way is to package the
     app as a container in every box, and that work has no estimate.
   - **Cheapest check:** say in one line where BOb v1 runs for Febor on
     delivery day.
   - **Answered** (Henry, 2026-11-19): **(A) inside Febor's box.** P5's §5
     stands as written. The other option was rejected: BOb on Vercel reading
     the box through an exposed read path. It would break §5.1 and §5.2 and
     N-04, and the projections would leave the box (D59, R-05).
   - *D77 (signed 2026-11-24) replaces this answer (A):* BOb's application and
     feeder run beside the box, in `/opt/bob/`, not inside it, and the
     consequence below that put its compose on `bzzz-app` no longer holds
     (§5.2; D62, «Relación con D77»). The answer above stays as it was given.
   - **Consequences, still to be scheduled. This answer does not decide
     them.** A minimum of stage 4 is pulled forward for Febor alone, ahead of
     the route plan's dates (2027-01-25 → 2027-04-16):
     - `forwardAuth` before the first application route (4B.1, C4.3);
     - a pinned BOb image (4B.2);
     - its compose on `bzzz-app` (4B.3);
     - BOb validating its session against the box's Supabase (D41\* C4.2
       (c)).
   - Until stage 4A exists, BOb updates and migrations on Febor are applied
     by hand. Objection 4 stays open on that basis.
2. **BOb and the portal's identity recover together.**
   - `restore.sh` returns the whole database, identity accounts included
     (§6.2). A BOb migration bad enough to need it costs the portal every
     login and invitation made since the dump.
   - The feeder's thirteen months of partitions share the Postgres that
     authenticates the portal. Sizing (D38\*) is outside P5, and P5 commits to
     the shared instance anyway.
   - **Cheapest check:** on lab-02, see whether `pg_dump -n bob` and a restore
     of `bob` alone work with the definer views and the `SECURITY DEFINER`
     functions. Estimate Febor's rows over thirteen months: buckets ×
     measures × channels.
   - **Answered** (Henry, 2026-11-19): **(a) a shared database, with `bob`
     recovered on its own.** A separate Postgres for BOb was rejected. The
     answer rests on one property: the eight projections are derived from
     ClickHouse, and the feeder rebuilds them (Slice 2). Only `bob`'s
     configuration and live state are BOb's alone: actors, refs and their
     history, channels and capabilities, thresholds.
     - **Backup.** `backup.sh` dumps `bob` on its own, with the data of the
       `proj_*` tables left out. The dump is verified by effect, counted
       against the live database, as the identity dump already is.
     - **Recovery.** Fix forward first, with a new migration. If that is not
       enough, restore `bob` alone, then rebuild the projections from
       ClickHouse with the feeder. `auth` is never touched because of BOb.
     - **Rehearsal.** The lab-02 rehearsal (§6.2) also restores `bob` alone,
       with its definer views and its `SECURITY DEFINER` functions, and
       records that it works.
     - **Still open, for D38\*:** the sizing of thirteen months of partitions
       in the Postgres that authenticates the portal.
3. **RLS by a self-set claim is not tenant isolation against the process.**
   - `bob_feeder` and `bob_app` set `request.jwt.claims` themselves (§3.3). A
     feeder that picks the wrong `org_id` picks it for the claim and the row
     alike, and the database accepts both. F-22 guards a narrower bug than
     §3.3 says.
   - If one box holds one company (D31.1), a box may hold a single
     organization, and then the claim protocol costs every transaction and
     protects nothing.
   - **Cheapest check:** how many `organizations` will Febor's box hold? If
     one, write the RLS down as defence in depth. If several, isolation needs
     something other than a claim the process sets on itself.
   - **Answered** (Henry, 2026-11-19): **(a) one organization per customer
     box.** It follows D31 (one box per company) and Bzzz's multi-customer
     proposal §9: customers are isolated by separate boxes, not by
     permissions, and a shared box carries synthetic data only.
     - **What RLS is, written down.** Inside a customer box, RLS by claim is
       defence in depth. The isolation between customers is the box. §3.3's
       F-22 sentence ("a feeder bug that tags a row with the wrong `org_id`
       is refused") overstates it. A feeder that picks the wrong `org_id`
       picks it for the claim too.
     - **What is kept.** The claim protocol stays as built. BOb's code and
       the two-tenant fixture behave the same in development, in CI and in
       the box.
     - **What catches the wrong-`org_id` bug instead** (proposed; built on
       2026-11-20):
       - in a customer box, `organizations` holds exactly one row, and its
         `slug` equals the box's `bzzz.tenant`;
       - the feeder sends any event whose tenant is not the box's to route A
         (unmapped), instead of writing it.
       - *Built.* The first is `scripts/box-check.mjs`. It runs read-only, as
         the migration owner, after the migration step (§6.2). The suite tests
         it, including that it refuses the two-tenant fixture. The second is
         the reference feeder's `boxTenant` option, guarded in
         `tests/slice2-feeder.test.mjs`.
     - **When it reopens.** A customer that needs several organizations in
       one box (a group with several brands) reopens P5. A self-set claim
       does not isolate them.
4. **Every migration runs through one person, times the number of boxes.**
   - The rule is Henry, in a window, with notice to the company (§6.2). That
     is lab-02, model-01, Febor, Zerrano and Pinch: five applies per chain,
     with Slices 3 to 8 still to come.
   - When Henry is unavailable, no box moves. Boxes drift onto different SHAs,
     and 3.7 ends up reading different schemas.
   - **Cheapest check:** migrations per slice so far × five boxes × one
     window. If that passes a day a month, the model does not scale.
   - **Measured (2026-11-19).** Migrations reached `main` in four batches,
     one per slice or major phase:
     - Slices 0, 1 and 1b, imported on 2026-09-10;
     - BR-3, on 2026-10-25;
     - Slice 2, in two PRs, on 2026-11-18.
     Slices 3 to 8 are still to come, roughly six more batches.
     Objection 1 put BOb v1 in Febor's box only, so each batch is applied to
     **three** boxes (lab-02, model-01, Febor), not five.
   - **Answered** (Henry, 2026-11-19): **(a) one window per slice.**
     - A slice's migrations are applied together, in one window per box, in
       order: lab-02, then model-01, then Febor.
     - The three boxes stay on the same pinned SHA, so 3.7 reads one schema.
     - Henry applies them, as §6.2 says.
     - The procedure is written down so that someone else can follow it the
       day Henry authorizes that person.
     - **Trigger.** When a second customer box carries BOb, stage 4A (the
       signed update path: `pausar`, `reanudar`, `actualizar`, package
       signature, lab → reference → customers) stops being optional, and P5
       reopens. Pulling 4A forward now was rejected: about four weeks of the
       route plan, which block nothing while there is one customer box.
5. **Signing before the rehearsal signs a mechanism nobody has seen work.**
   - The text says it itself: the failure behaviour is read, not measured.
     Nine migrations are not wrapped. `supabase db push` against a
     self-hosted Supabase, writing `schema_migrations` the way CI does (F-15),
     has not been run.
   - If the rehearsal goes badly, a signed BzzzBX decision has to be reopened.
   - **Cheapest check:** the lab-02 rehearsal is a few hours. Run it before
     the signature rather than before the window.
   - **Answered** (Henry, 2026-11-19): **before the signature.** This
     tightens Federico's condition, which asked only that the rehearsal come
     before the first window. D62 is signed with measured facts, not read
     ones. Nothing waits on the signature today, because the first window in
     Febor first needs the stage 4 minimum of objection 1.
   - **The rehearsal on lab-02 records:**
     - a chain with one migration rigged to fail in the middle, with a dump
       taken first: what `supabase_migrations.schema_migrations` says
       afterwards, which objects exist, and whether the failing file left
       anything behind;
     - the nine older migrations that are not wrapped in `BEGIN … COMMIT`;
     - `supabase db push` against the self-hosted Supabase, at CI's CLI
       version, writing `schema_migrations` as CI does (F-15);
     - a restore of `bob` alone, with its definer views and its `SECURITY
       DEFINER` functions, followed by a rebuild of the projections
       (objection 2).
   - **Who runs it.** Henry, or someone he authorizes. Never an agent on its
     own.
   - **If it contradicts §6.2.** These inputs are corrected before the
     signature. Nothing signed has to be reopened.
6. **The secrets file breaks its own rule.**
   - §4 says one credential per file and one reader per file. Yet
     `supabase.env` holds the migration owner (`postgres`, a superuser),
     `JWT_SECRET` and `SERVICE_ROLE_KEY`, and three things read it.
   - Whoever reads it can mint a JWT for any `org_id`, and is a superuser too.
     The migration step also lives in `actualizar.sh`, the routine script.
   - **Cheapest check:** list who reads `/opt/bzzz/secrets/supabase.env` on
     Febor today. If it is more than one process or script, move the
     migration owner to its own file before signing.
   - **Read (2026-11-19)**, from Bzzz `compose/l6-supabase.yml` and
     `scripts/` on `main`. Variable names only, never values.
     - `supabase.env` holds `POSTGRES_PASSWORD` (the superuser),
       `JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY`, among others.
     - It is read whole by two containers, `supabase-db` and
       `supabase-auth`.
     - It is also read by six scripts: `bootstrap.sh`,
       `generar-secretos-supabase.sh` (which writes it),
       `generar-config-portal.sh`, `engines-portal.sh`, `invitar-portal.sh`
       and `crear-usuario-portal.sh`.
   - **Answered** (Henry, 2026-11-19): **(a) a file of its own.**
     - The credential that applies BOb's migrations goes in
       `/opt/bob/secrets/migrador.env`, at mode 600.
     - Only the migration step of §6.2 reads it. No service and no other
       script does.
     - That keeps §4's rule of one credential per file and one reader per
       file.
     - Using `supabase.env` was rejected: it would add a ninth reader and
       break P5's own rule.
   - **[FINDING] for a Bzzz decision, not fixed in P5.** It predates BOb.
     `supabase-auth` (GoTrue) sits on `bzzz-edge`, so Traefik can reach it,
     and it receives the whole file, Postgres superuser password included.
     The proposal is that it gets only what it needs: `JWT_SECRET` and its
     own database user.
7. **These inputs described a world that no longer existed.**
   - Before the 2026-11-19 pass they said the contract was unsigned and that
     F-21 and F-22 were not built. They did not list `channel_capabilities`,
     and they did not answer F-26.
   - Signing stale text leaves an audit trail that contradicts itself.
   - **Status:** the 2026-11-19 pass is meant to close this. Henry checks it
     against `main` when he reviews this PR. F-26 is Q6 above.
   - **Answered** (Henry, 2026-11-19): **closed by this pass**, subject to
     his review of the PR against `main`. Nothing else is to be decided.

**The most likely failure (written as a post-mortem six months out).**

- D62 was signed in November. The lab-02 rehearsal stayed "before the first
  window".
- BOb v1 shipped to Febor from the same Next.js app, because putting it in the
  box was a separate project. Someone exposed PostgREST through Traefik
  "temporarily" so that it could read.
- On the third window, an unwrapped migration failed mid-chain on Zerrano. The
  only rehearsed way back was `restore.sh`, which returned a two-day-old
  database, and the portal lost the week's invited users.
- Henry ran that window alone, at midnight, because nobody else held the
  credential. Since then the boxes run different SHAs, and 3.7 has a branch
  for each schema.

**The question not yet asked.** Where does BOb v1 run on the day it is
delivered to Febor, and if it is not inside Febor's box, which part of P5 is
still true that day?
