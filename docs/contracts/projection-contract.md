# BOb v1 · Projection read contract

**Status: DRAFT 0.2 — not published, not signed.** Opens Slice 2. Once Henry
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
F-17 to F-19 and A-06 in `contract-amendments.md`. From the Slice 1c package
(8 Sep): the Migration Order, step 14 and the `proj_response_time` shape; the
Decision Sheet, C-11 to C-15; the Build Brief, Slice 2 and Slice 6; and System
Flows §3, the data path.

The eight table names, the response-time columns and the five obligations come
from the package. The column lists of the other seven tables do not: the
package defers them to Implementation Handoff §3.3, which is not in it.

Items marked **[PROPOSED]** are not stated by any of those sources and need a
ruling before publication. Items marked **[OPEN]** are questions, listed in §11.

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
| `feeder_version` | `TEXT NOT NULL` | Build of the feeder that wrote the row (Build Brief, Slice 2). |
| `computed_at` | `TIMESTAMPTZ NOT NULL` | When the row was last written. **[PROPOSED]** |
| `source_watermark` | `TIMESTAMPTZ NOT NULL` | The truth-store watermark the row was computed behind. **[PROPOSED]** |

Migration Order step 14 requires "the three provenance columns" on every table
and names none; the Build Brief names `feeder_version`. The other two names are
this draft's until Handoff §3.3 says otherwise. **Sealed is derived, not
stored:** a bucket is sealed when `bucket_start + 5 min <= source_watermark`. A
stored `sealed` flag beside the timestamps would be a second answer to a
question they already answer, which is the reason A-09 removed `'live'`.

## 5 · Absent is not zero

A missing row means **not observed**. A row with a zero means **observed, and
none**. Slice 3 builds the rendering on this distinction (FR-32, UI-03, PR-10,
SR-2), so the feeder must never write a zero it did not observe, and must write
one when it did. That needs a signal that a channel was alive in a bucket with
no business events. This draft puts it in `proj_channel_health` (§6.5)
**[PROPOSED]**; the signal behind it is **[OPEN]** (§11, Q4).

Two derived figures are absent rather than zero by ruling:
- ORGA when no selected channel carries a customer turn (Relevo task 8, D-17).
- MECA when no selected channel emits RUM (FR-32, FR-35).

## 6 · The eight tables

**Names: Migration Order step 14.** `proj_metric_counts`, `proj_sentiment`,
`proj_response_time`, `proj_channel_health`, `proj_rum_signals`,
`proj_actor_metrics`, `proj_detections`, `proj_deliveries`. Five of them
replace tables that leave BOb (Migration Order, "Why §7.1 no longer holds"):

| Leaves BOb | Returns as |
|---|---|
| `interactions`, `metric_snapshots` | `proj_metric_counts` |
| `sentiment_readings` | `proj_sentiment` |
| `rum_events` | `proj_rum_signals` |
| `channel_health` | `proj_channel_health` |

**Columns.** Only `proj_response_time` has a column list in the package (§6.3,
verbatim from the Migration Order). Every other column list below is
**[PROPOSED]**: the package defers them to Handoff §3.3, which this draft has
not seen (§11, Q1).

Every table also carries `org_id`, `bucket_start` and the three provenance
columns. They are omitted from the column lists. `actor_type` is
`TEXT CHECK (actor_type IN ('user','asa','human','arep'))`, the set `actors` and
`channel_actor_mix` already use.

### 6.1 `proj_metric_counts` — volume by actor type

Primary key `(org_id, bucket_start, channel_id, actor_type)` **[PROPOSED]**.

| Column | Type | Notes |
|---|---|---|
| `channel_id` | `UUID NOT NULL` → `channels(id)` | |
| `actor_type` | `TEXT NOT NULL` | |
| `interactions` | `BIGINT NOT NULL CHECK (>= 0)` | Distinct `correlation_id`s that started in the bucket |
| `duration_ms_sum` | `BIGINT NOT NULL CHECK (>= 0)` | Over interactions that ended in the bucket |
| `duration_n` | `BIGINT NOT NULL CHECK (>= 0)` | Interactions behind `duration_ms_sum` |

Feeds FR-10 to FR-14 (attribution: sum by `actor_type` over the selected
channels and renormalise; an absent actor contributes no row, so the hundred-
percent rule holds by construction) and FR-22 (user availability:
`bob_availability_user(volume, window, duration_ms_sum / duration_n)`).
`channel_actor_mix` reads its observed split from here.

### 6.2 `proj_actor_metrics` — per actor

Primary key `(org_id, bucket_start, channel_id, actor_id)` **[PROPOSED]**.

| Column | Type | Notes |
|---|---|---|
| `channel_id` | `UUID NOT NULL` | |
| `actor_id` | `UUID NOT NULL` → `actors(id)` | Resolved from `entity_id`, §7 |
| `handled_count` | `BIGINT NOT NULL CHECK (>= 0)` | Named in D-03 |

D-03 stays open: what this table carries beyond `handled_count` is the
contract question CF-12 waits on. Adding a column later is an additive version
of this contract, not a break.

### 6.3 `proj_response_time` — OTel exponential histogram (C-15)

Primary key `(org_id, bucket_start, channel_id, actor_type)` **[PROPOSED]**.
Measure columns verbatim from the Migration Order ("the amended shape", which
replaces `sketch BYTEA` in Handoff §3.3):

```sql
n                BIGINT   NOT NULL,           -- exact count
sum_ms           BIGINT   NOT NULL,           -- exact mean on recombine
min_ms           BIGINT,
max_ms           BIGINT,
hist_scale       SMALLINT NOT NULL DEFAULT 4,
hist_offset      INTEGER  NOT NULL,           -- index of first populated bucket
hist_counts      BIGINT[] NOT NULL DEFAULT '{}',
hist_zero_count  BIGINT   NOT NULL DEFAULT 0,
```

`hist_scale` is stored per row and is **not** constrained to 4: if the scale
ever changes, rows at different scales are down-scaled by powers of two before
merging, and a global assumption would make history silently unmergeable.
Merge: align by `hist_offset`, add counts. Percentiles are read by walking
buckets until the target fraction is passed. **No stored percentile, ever.**
Which event pair a response time measures is **[OPEN]** (§11, Q3).

### 6.4 `proj_sentiment` — readings by state and source

Primary key `(org_id, bucket_start, channel_id, sent_source, sent_state)`
**[PROPOSED]**.

| Column | Type | Notes |
|---|---|---|
| `channel_id` | `UUID NOT NULL` | |
| `sent_source` | `TEXT NOT NULL` | One of four sources; value set **[OPEN]** (§11, Q8) |
| `sent_state` | `TEXT NOT NULL CHECK (IN ('angry','unsatisfied','satisfied','content','happy'))` | The simulator's five labels |
| `reading_count` | `BIGINT NOT NULL CHECK (>= 0)` | Named in the Build Brief, Slice 4 |

Sentiment "carries five states × four sources" (Migration Order step 6), and
`threshold_configs` gains `sent_state` and `sent_source` to address it, so the
projection is keyed the same way. ORGA and MECA split by instrument and
substrate, not by counterparty; ASA sessions produce ORGA (C-05). One ORGA
reading is one **customer speaker turn**; agent turns produce none (D-17).
Counts, not percentages: volume weights by summing `reading_count`.

### 6.5 `proj_channel_health` — was the channel observed

Primary key `(org_id, bucket_start, channel_id)` **[PROPOSED]**. One row per
channel per bucket in which its source was seen alive, **with or without
business events**. This turns "no row in 6.1" into either *observed, none* or
*not observed*, and is what FR-23 reads to tell a quiet channel from a broken
deployment.

| Column | Type |
|---|---|
| `channel_id` | `UUID NOT NULL` |
| `events_received` | `BIGINT NOT NULL CHECK (>= 0)` |
| `events_rejected` | `BIGINT NOT NULL CHECK (>= 0)` — dead-lettered |

### 6.6 `proj_rum_signals` — the mechanical substrate

Primary key `(org_id, bucket_start, channel_id, signal)` **[PROPOSED]**.

| Column | Type |
|---|---|
| `channel_id` | `UUID NOT NULL` |
| `signal` | `TEXT NOT NULL` — value set **[OPEN]** |
| `signal_count` | `BIGINT NOT NULL CHECK (>= 0)` |

Replaces `rum_events`. No row for a channel that emits no RUM, which is what
makes MECA absent rather than zero (FR-35). Whether MECA readings are derived by
BOb from these rows through the state composition table, or written by the
feeder into `proj_sentiment`, is **[OPEN]** (§11, Q8): the Build Brief puts the
composition table in BOb and the coefficients in the feeder.

### 6.7 `proj_detections` — CEP detections

Primary key `(org_id, bucket_start, channel_id, detection_kind)` **[PROPOSED]**.
ClickHouse already holds CEP detections (Relevo task 1, 7 Sep); this is their
BOb-facing count.

| Column | Type |
|---|---|
| `channel_id` | `UUID NOT NULL` |
| `detection_kind` | `TEXT NOT NULL` |
| `detections` | `BIGINT NOT NULL CHECK (>= 0)` |

### 6.8 `proj_deliveries` — delivery outcomes read back

Primary key `(org_id, bucket_start, autobotz_id, outcome)` **[PROPOSED]**. BOb
writes an alert and its delivery intent; layer 8 transmits; the outcome returns
as a projection row on the same path as every other fact (System Flows §4). In
v1 the outbox drains to a stub and this table is read back through the real
path (Build Brief, Slice 6).

| Column | Type |
|---|---|
| `autobotz_id` | `UUID NOT NULL` → `autobotz(id)` |
| `outcome` | `TEXT NOT NULL` — value set **[OPEN]** |
| `deliveries` | `BIGINT NOT NULL CHECK (>= 0)` |

Whether a delivery is keyed to the binding, to `alert_deliveries` (step 12), or
both, is **[OPEN]**: "the full chain answers to a single query" needs a join
from the outcome back to the alert.

## 7 · Correlation

**`correlation_id` and `entity_id` are BzzzBX's.** Identity resolution is
upstream and the session's correlation id is the join (C-11); BOb never mints
one, and inherits one wherever an upstream key exists (Slice 8).

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
  actor. Actor identity comes from session data, agent login and account ID
  (C-12); which is authoritative is D-02, still open.
- **Evidence is not a projection.** 3.7's evidence packages by `correlation_id`
  and `entity_id` are the platform's surface. A BOb cell reaches them through its
  frame (`tenant_slug`, `source_key`, bucket window, `external_ref`), which is a
  query key into BzzzBX, not a BOb table. So 3.7 delivers two things that must
  not merge: the eight tables here, and the evidence packages.

The feeder reads exactly two things from BOb: `v_feeder_channel_map` (exists)
and `v_feeder_actor_map`. Anything more is a finding about this contract.

## 8 · The feeder's five obligations

From the Build Brief (Slice 2) and System Flows §3:

1. **Fill every table at declared grain.** Every row on a five-minute UTC
   boundary; the CHECK in §3 refuses anything else.
2. **Idempotent on the primary key.** An upsert on the projection primary key;
   replaying a window changes nothing but `computed_at`.
3. **Advance a watermark and seal only behind it**, so a bucket is never sealed
   while facts are still arriving. System Flows has the feeder read the
   watermark from Supabase. This draft keeps it on the rows (`source_watermark`)
   **[PROPOSED]**, read back as its maximum per tenant and table. A separate
   watermark table written by `bob_feeder` would be a ninth projection to the
   PR-4 guard (F-18 counts every table the feeder writes), and "exactly eight"
   would fail.
4. **Stamp `feeder_version`** on every row it writes.
5. **Rebuild an arbitrary window on demand.** The same query over a different
   range: for `(org_id, [from, to))`, delete and refill. The rebuild test
   truncates every projection, re-runs the feeder, and asserts the application
   renders identically.

The recommended shape (System Flows §3) is a scheduled ClickHouse query on a
timer, not a stream: idempotency comes from the upsert, and rebuild is the same
query with a different range.

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

## 11 · Open questions before publication

1. **Handoff §3.3.** The Migration Order cites it for the projection columns
   and it is not in the Slices 0, 1 or 1c packages. Seven column lists in §6
   are proposals until it is read. Where is it, or does §6 replace it?
2. **Provenance names.** Step 14 requires three provenance columns and names
   none; `feeder_version` comes from the Build Brief. `computed_at` and
   `source_watermark` are this draft's.
3. **Response time.** Which event pair, matched by `correlation_id`: customer
   turn to first reply, request to response, or per channel type?
4. **Observed with nothing.** What tells the feeder a channel was alive in a
   bucket with no business events: an adapter heartbeat, a span, a DLQ count?
   Without it §5 cannot hold, and `proj_channel_health` has nothing to read.
5. **Late events.** Event time or ingestion time for bucket assignment, and how
   late an event may arrive before only a rebuild picks it up.
6. **Unresolved tenant or channel.** Where the feeder reports events it could not
   map: a log, a ClickHouse counter, or a ninth table (which would break the
   count of eight).
7. **Partition lifecycle.** Who creates next month's partitions and drops the
   fourteenth month. `pg_cron` arrives in Slice 5; Slice 2 needs an answer
   before then.
8. **Sentiment.** The four values of `sent_source` (Technical Architecture
   §2.3, not in the package), and whether MECA is written by the feeder into
   `proj_sentiment` or derived by BOb from `proj_rum_signals`.
9. **Deliveries.** The `outcome` value set; whether AutoComm deliveries (layer 8
   transmits both) share the table, which `autobotz_id` alone cannot key; and
   whether `proj_deliveries` joins back to `alert_deliveries` so the chain
   answers to one query.
10. **D-03, D-02, D-15.** Still open. They change columns in `proj_actor_metrics`
    and the authority for `external_ref`, and decide whether Response Quality is
    a ninth measure.
