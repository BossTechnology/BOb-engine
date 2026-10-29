# BOb v1 · Projection read contract

**Status: DRAFT 0.1 — not published, not signed.** Opens Slice 2. Once Henry
approves it, it is published on Relevo task 6 and BzzzBX route-plan task 3.7 implements
against it. No migration is written until then.

**How it changes.** It is published, not negotiated (Relevo task 6, 23 Oct). If anything
here is impossible or expensive on the ClickHouse side, it is said on Relevo task 6 and
the contract changes deliberately, with a new version number and an entry in
`Documentation/contract-amendments.md`. When this file and a signed decision
disagree, the decision wins.

**Sources.** Relevo task 6 (C-13, C-14, C-15, the five feeder obligations); Relevo task 7 thread,
26–27 Oct (ruling (d): `org_id` as the tenant key; A-05a/A-05b; partitions);
the scope map `BOb_v1_Remaining_Work(1).docx` (md5 `ee44393d…`); SR-1 in
`20260902100100_organizations_slug_shape.sql`; `20260902100300_roles_and_grants.sql`;
F-17 to F-19 and A-06 in `contract-amendments.md`.

Items marked **[PROPOSED]** are not stated by any of those sources and need a
ruling before 0.2. Items marked **[OPEN]** are questions, listed in §11.

---

## 1 · Who owns what

| Party | Owns | Never does |
|---|---|---|
| **BzzzBX** (truth store, ClickHouse) | Raw business events, per-interaction grain, `correlation_id`, `entity_id`, `bzzz.tenant` | Knows a BOb UUID |
| **BOb** (Postgres, schema `bob`) | `org_id`, `channel_id`, `actor_id`, configuration, live state, the shape of the eight tables | Queries the truth store; writes a projection (PR-4) |
| **The feeder** | Every row in the eight tables. Slice 2 builds the reference feeder; task 3.7 replaces it at connection | Reads BOb configuration beyond the two named views in §7 |

There is exactly one writer, `bob_feeder`. Whether the reference feeder or 3.7
holds that credential, the contract is the same.

## 2 · Tenant key

- Every projection row carries **`org_id UUID NOT NULL`**, a foreign key to
  `organizations(id)`. **Never the slug.** SR-1: `org_id` is the key for RLS and
  every foreign key inside BOb; the slug is only what crosses the boundary.
- The feeder receives `bzzz.tenant` (the slug) with each event, resolves
  `(tenant_slug, source_key)` through `v_feeder_channel_map`, and writes the
  `org_id` and `channel_id` it gets back.
- An event whose `(tenant_slug, source_key)` does not resolve is **not
  projected**. It is never written under a guessed tenant or a catch-all channel.
  How the feeder reports it is **[OPEN]** (§11, Q6).
- RLS is enabled on every table **and on every partition**, with the policy
  every tenant table already uses: `org_id = (auth.jwt() ->> 'org_id')::uuid`.
  A partition does not inherit RLS (F-18), so a partition read directly would
  otherwise return every tenant's rows.
- `ON DELETE CASCADE` from `organizations` **[PROPOSED]**: it lets the fixture's
  cascade reach projections (F-19) and makes deleting a tenant complete.

## 3 · Grain, partitions, retention

- **Grain: five-minute buckets, UTC-aligned (C-13).** Column
  `bucket_start TIMESTAMPTZ NOT NULL`, covering `[bucket_start, bucket_start + 5 min)`,
  with `CHECK (extract(epoch FROM bucket_start)::bigint % 300 = 0)` on every
  table.
- An event lands in the bucket of its **event time** in UTC, not its ingestion
  time **[PROPOSED]**. Late events reopen nothing sealed; they are picked up by a
  rebuild (§8.5).
- **No stored rollups.** Hours, days and months are computed at read time. Every
  measure in §6 is additive (counts, sums, mins, maxes, histogram buckets), so a
  coarser window is a sum of finer ones and never an average of averages.
- The five-minute bucket is structural, not configuration: it is the floor of
  the cooldown CHECK (D-05) and changing it means rebuilding thirteen months.
- **Partitions: monthly, by `RANGE (bucket_start)`, UTC month boundaries (C-14).**
  Name `<parent>_yYYYYmMM` **[PROPOSED]**.
- **Retention: thirteen months (C-14)**, matching `business_events` at 395 days
  (Bzzz D39). Older partitions are detached and dropped, never deleted row by row.
  Who drops them, and who pre-creates the next month, is **[OPEN]** (§11, Q7).

## 4 · Provenance — three columns on every row

| Column | Type | Meaning |
|---|---|---|
| `feeder_version` | `TEXT NOT NULL` | Build of the feeder that wrote the row (Relevo task 6). |
| `computed_at` | `TIMESTAMPTZ NOT NULL` | When the row was last written. **[PROPOSED]** |
| `source_watermark` | `TIMESTAMPTZ NOT NULL` | The truth-store watermark the row was computed behind. **[PROPOSED]** |

Relevo task 6 says "the three provenance columns" and names only `feeder_version`; the
other two names are this draft's. **Sealed is derived, not stored:** a bucket is
sealed when `bucket_start + 5 min <= source_watermark`. A stored `sealed` flag
beside the timestamps would be a second answer to a question they already
answer, which is the reason A-09 removed `'live'`.

## 5 · Absent is not zero

A missing row means **not observed**. A row with a zero means **observed, and
none**. Slice 3 builds the rendering on this distinction (FR-32, UI-03, PR-10,
SR-2), so the feeder must never write a zero it did not observe, and must write
one when it did. That needs a signal that a channel was alive in a bucket with
no business events. `proj_channel_coverage` (§6.8) is this draft's answer
**[PROPOSED]**; the signal behind it is **[OPEN]** (§11, Q4).

Two derived figures are absent rather than zero by ruling:
- ORGA when no selected channel carries a customer turn (Relevo task 8, D-17).
- MECA when no selected channel emits RUM (FR-32).

## 6 · The eight tables

**Only three of the eight are named in any source this draft could read:**
`proj_metric_counts`, `proj_actor_metrics`, `proj_response_time`. The other five
below are **[PROPOSED]** from what Slices 2 to 6 need. If the Data Model or
Handoff §4.1 names them, those names win (§11, Q1).

Every table also carries `org_id`, `bucket_start` and the three provenance
columns. They are omitted from the column lists. `actor_type` is
`TEXT CHECK (actor_type IN ('user','asa','human','arep'))`, the set `actors` and
`channel_actor_mix` already use.

### 6.1 `proj_metric_counts` — volume by actor type

Primary key `(org_id, bucket_start, channel_id, actor_type)`.

| Column | Type | Notes |
|---|---|---|
| `channel_id` | `UUID NOT NULL` → `channels(id)` | |
| `actor_type` | `TEXT NOT NULL` | |
| `interactions` | `BIGINT NOT NULL CHECK (>= 0)` | Distinct `correlation_id`s that started in the bucket |
| `duration_ms_sum` | `BIGINT NOT NULL CHECK (>= 0)` | Over interactions that ended in the bucket **[PROPOSED]** |
| `duration_n` | `BIGINT NOT NULL CHECK (>= 0)` | Interactions behind `duration_ms_sum` |

Feeds FR-10 to FR-14 (attribution: sum by actor type over the selected channels,
renormalise over the actors present) and FR-22 (user availability:
`bob_availability_user(volume, window, duration_ms_sum / duration_n)`). Replaces
`interactions` (F-03) and `metric_snapshots` (F-04).

### 6.2 `proj_actor_metrics` — per actor

Primary key `(org_id, bucket_start, channel_id, actor_id)`.

| Column | Type | Notes |
|---|---|---|
| `channel_id` | `UUID NOT NULL` | |
| `actor_id` | `UUID NOT NULL` → `actors(id)` | Resolved from `entity_id`, §7 |
| `handled_count` | `BIGINT NOT NULL CHECK (>= 0)` | |

D-03 stays open: what this table carries beyond `handled_count` is the
contract question CF-12 waits on. Adding a column later is an additive version
of this contract, not a break.

### 6.3 `proj_response_time` — OTel exponential histogram (C-15)

Primary key `(org_id, bucket_start, channel_id, actor_type)`.

| Column | Type | Notes |
|---|---|---|
| `channel_id`, `actor_type` | as 6.1 | |
| `n` | `BIGINT NOT NULL CHECK (>= 0)` | Exact count |
| `sum_ms` | `BIGINT NOT NULL` | Exact sum |
| `min_ms`, `max_ms` | `BIGINT` | NULL only when `n = 0` |
| `hist_scale` | `SMALLINT NOT NULL CHECK (hist_scale = 4)` | |
| `hist_zero_count` | `BIGINT NOT NULL` | |
| `hist_offset` | `INTEGER NOT NULL` | Index of `hist_counts[1]` |
| `hist_counts` | `BIGINT[] NOT NULL` | Positive range only; a response time is never negative |

**No stored percentile, mean or median, ever.** Merge rule: align offsets, add
counts. A percentile is read from the merged histogram at render time. Which
event pair a response time measures is **[OPEN]** (§11, Q3).

### 6.4 `proj_sentiment_turns` — ORGA readings [PROPOSED]

Primary key `(org_id, bucket_start, channel_id)`. One reading is one **customer
speaker turn**; agent turns produce none (D-17, Relevo task 8).

| Column | Type |
|---|---|
| `channel_id` | `UUID NOT NULL` |
| `angry`, `unsatisfied`, `satisfied`, `content`, `happy` | `BIGINT NOT NULL CHECK (>= 0)` |

The five states carry the simulator's labels (the same five columns as the
inherited `sentiment_readings`). Counts, not percentages, so volume and duration
weight automatically. No row when the bucket had no customer turn.

### 6.5 `proj_sentiment_rum` — MECA readings [PROPOSED]

Primary key `(org_id, bucket_start, channel_id)`. Same five state counts as 6.4,
from RUM signals. The state composition table is product truth; the
coefficients are the feeder's. No row for a channel that emits no RUM.

### 6.6 `proj_delivery_outcomes` — AutoBotz results read back [PROPOSED]

Primary key `(org_id, bucket_start, autobotz_id, outcome)`. Slice 6 drains the
outbox to a stub and reads outcomes back through the real projection path, so
that execution arriving changes nothing in BOb.

| Column | Type |
|---|---|
| `autobotz_id` | `UUID NOT NULL` → `autobotz(id)` |
| `outcome` | `TEXT NOT NULL` — value set **[OPEN]** |
| `deliveries` | `BIGINT NOT NULL CHECK (>= 0)` |

### 6.7 `proj_detections` — CEP detections [PROPOSED]

Primary key `(org_id, bucket_start, channel_id, detection_kind)`. ClickHouse
already holds CEP detections (Relevo task 1, 7 Sep); this is their BOb-facing count.

| Column | Type |
|---|---|
| `channel_id` | `UUID NOT NULL` |
| `detection_kind` | `TEXT NOT NULL` |
| `detections` | `BIGINT NOT NULL CHECK (>= 0)` |

### 6.8 `proj_channel_coverage` — was the channel observed [PROPOSED]

Primary key `(org_id, bucket_start, channel_id)`. One row per channel per bucket
in which its source was seen alive, **with or without business events**. This
is what turns "no row in 6.1" into either *observed, none* or *not observed*,
and what FR-23 reads to tell a quiet channel from a broken deployment.

| Column | Type |
|---|---|
| `channel_id` | `UUID NOT NULL` |
| `events_received` | `BIGINT NOT NULL CHECK (>= 0)` |
| `events_rejected` | `BIGINT NOT NULL CHECK (>= 0)` — dead-lettered |

## 7 · Correlation

**`correlation_id` and `entity_id` are BzzzBX's.** BzzzBX mints or inherits them
upstream; BOb never mints one (Slice 8 inherits wherever an upstream key exists).

**Neither appears as a column in any projection.** Per-interaction grain is
truth-store grain (A-06). They reach the projection only through what the
feeder does with them:

- **`correlation_id`** is how the feeder counts an interaction once, pairs the
  events behind a response time, and orders customer turns. The aggregate lands
  in BOb; the identifier stays in ClickHouse.
- **`entity_id`** resolves to `actors.id` through a second named view,
  **`v_feeder_actor_map`** **[PROPOSED]**: `org_id`, `actor_id`, `actor_type`,
  `external_ref`, with `external_ref = entity_id`. No `display_name`, no
  `display_id`: the feeder never sees a name. An `entity_id` with no actor counts
  in 6.1 under its actor type and is absent from 6.2. The feeder never creates an
  actor. Who is authoritative for `external_ref` is D-02, still open.
- **Evidence is not a projection.** 3.7's evidence packages by `correlation_id`
  and `entity_id` are the platform's surface. A BOb cell reaches them through its
  frame (`tenant_slug`, `source_key`, bucket window, `external_ref`), which is a
  query key into BzzzBX, not a BOb table. So 3.7 delivers two things that must
  not merge: the eight tables here, and the evidence packages.

The feeder reads exactly two things from BOb: `v_feeder_channel_map` (exists)
and `v_feeder_actor_map`. Anything more is a finding about this contract.

## 8 · The feeder's five obligations (Relevo task 6)

1. **Fill at declared grain.** Every row on a five-minute UTC boundary; the CHECK
   in §3 refuses anything else.
2. **Idempotent on the primary key.** `INSERT … ON CONFLICT (pk) DO UPDATE`.
   Replaying a window yields the same rows; only `computed_at` may differ.
3. **Advance a watermark and seal only behind it.** The watermark travels on
   each row as `source_watermark` **[PROPOSED]**. A sealed bucket is never
   rewritten outside a rebuild. A separate watermark table written by
   `bob_feeder` would be a ninth projection to the PR-4 guard (F-18 counts every
   table the feeder writes), so this draft keeps the watermark on the rows.
4. **Stamp `feeder_version`** on every row it writes.
5. **Rebuild an arbitrary window on demand.** For `(org_id, [from, to))`: delete
   and refill. The Slice 2 rebuild test truncates every projection, re-runs the
   feeder, and asserts an identical render.

## 9 · Roles, grants, schema

- The eight tables live in schema **`bob`**, created in the Slice 2 schema move.
- Each table and each partition goes through **`bob_grant_projection()`**:
  `bob_feeder` SELECT, INSERT, UPDATE, DELETE; `bob_app` and `authenticated`
  SELECT only; no write for PUBLIC or `anon`. `bob_ai_ro` reads `v_ai_*` views,
  never these tables (IR-1).
- **A-05a closes in Slice 2:** `bob_app` becomes a LOGIN role and BOb connects as
  it. The credential is set outside the migration chain.
- **A-05b does not:** service-role reads move with the first route handler. The
  thin Performance matrix is that handler and starts on `bob_app` or the
  user-scoped client, never the service client (Relevo task 7, 27 Oct).

## 10 · Guards Slice 2 adds

Each one is seen failing on purpose before it is trusted, and recorded in
`contract-amendments.md`.

| Guard | Discovers | Asserts |
|---|---|---|
| Exactly eight | `projectionTables()` (F-18) | The set of non-partition projections equals the eight table names in §6 of **this file**, read from here rather than copied into the test |
| Partitions granted | partitions via `pg_inherits` | Every partition of a projection passes `projectionGrantFindings()` |
| Partitions guarded | `tenantTables()` | Every partition has RLS and the `org_id` policy |
| `bob_app` grants | every `org_id` table | Non-projections: `bob_app` SELECT, INSERT, UPDATE, DELETE. Projections: SELECT only. Replaces the hand list in `20260902100300` |
| Pre-rename absence | every schema except `pg_*` and `information_schema` | No `autobotz_bindings` table or policy anywhere; replaces the two `public`-only checks in `slice0-schema.test.mjs` |
| Grain | every projection | Carries the bucket-alignment CHECK |
| No percentiles | every projection column | No column named like `p\d+`, `percentile`, `median`, `avg`, `mean` |
| Provenance | every projection | Carries the three columns of §4, `NOT NULL` |
| Tenant key | every projection | Carries `org_id UUID NOT NULL`, no slug column |

## 11 · Open questions before 0.2

1. **The eight names.** Data Model / Handoff §4.1 presumably lists them. Five in
   §6 are proposals. Which document is authoritative, and where is it?
2. **Provenance names.** `computed_at` and `source_watermark` are this draft's.
   Does the spec name the other two?
3. **Response time.** Which event pair, matched by `correlation_id`: customer
   turn to first reply, request to response, or per channel type?
4. **Observed with nothing.** What tells the feeder a channel was alive in a
   bucket with no business events: an adapter heartbeat, a span, a DLQ count?
   Without it §5 cannot hold, and 6.8 has nothing to read.
5. **Late events.** Event time or ingestion time for bucket assignment, and how
   late an event may arrive before only a rebuild picks it up.
6. **Unresolved tenant or channel.** Where the feeder reports events it could not
   map: a log, a ClickHouse counter, or a ninth table (which would change the
   count of eight).
7. **Partition lifecycle.** Who creates next month's partitions and drops the
   fourteenth month. `pg_cron` arrives in Slice 5; Slice 2 needs an answer
   before then.
8. **D-03, D-02, D-15.** Still open. They change columns in 6.2 and the authority
   for `external_ref`, and decide whether Response Quality is a ninth measure.
