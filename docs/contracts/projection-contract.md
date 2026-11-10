# BOb v1 · Projection read contract

**Status: DRAFT 0.3 — not published, not signed.** Opens Slice 2. Once Henry
signs it on Relevo task 6, it is published there and BzzzBX route-plan task 3.7
implements against it. No migration is written until then.

**How it changes.** It is published, not negotiated (Relevo task 6, 23 Oct). If anything
here is impossible or expensive on the ClickHouse side, it is said on Relevo task 6 and
the contract changes deliberately, with a new version number and an entry in
`Documentation/contract-amendments.md`. When this file and a signed decision
disagree, the decision wins.

**What changed from 0.2.** Handoff §3.3 arrived (F-20 closed) and is now the
source of every column list, with five named supersessions. The ten §11
questions of 0.2 are closed. D-03, D-12 and Relevo's A-07 are ruled. Draft 0.2's
[PROPOSED] column lists are gone. The full list is in `contract-amendments.md`,
under "Slice 2 · The projection read contract, 0.3".

**Sources.**
- Relevo task 6 thread: 23 Oct (C-13 to C-15, the five obligations); 4 Nov
  (D-12, A-07 raised); 10 Nov (F-20 closed with §3.3 attached, D-03, the
  hallucinations correction, A-07 ruled, §11 Q3 to Q7, `health_pct` dropped).
- **Handoff §3.3, "The tables"** (`BOb_Implementation_Handoff_v1_2.docx`), as
  attached to Relevo task 6 on 10 Nov: `BOb_Handoff_3_3_The_Tables.md`, 16,183
  bytes, md5 `eb89363d41da5c8e9f11df8c905d7f3c`, with its supersession notes.
- Relevo task 10 (`channel_capabilities`, 4 Nov; idle bound and heartbeat,
  10 Nov), task 12 (D-15, the two grains; the hallucinations correction, 10 Nov),
  task 13 (`actor_external_refs`, 10 Nov; D-02 for agents and ASA, 10 Nov).
- Relevo task 7 thread, 26–27 Oct (ruling (d): `org_id` as the tenant key; A-05a/A-05b).
- The Slice 1c package (8 Sep): Migration Order step 14, Decision Sheet C-11 to
  C-15, Build Brief Slices 2 and 6, System Flows §3.
- The migration chain on `main`, and F-17 to F-19 and A-06 in `contract-amendments.md`.

**Markers.** **[PROPOSED]** marks a choice this draft makes that no ruling
states; it stands unless the review changes it. **[OPEN]** marks a question
listed in §11. Everything unmarked is ruled, and the ruling is named next to it.

**A note on letters.** Relevo's A-07 (the member drill-through) and A-09 (the
abstained count) are not A-07 and A-09 in `contract-amendments.md`, which are
Data Model §5.3 and `actor_shifts.status`. Where this file cites one of
Relevo's, it says so.

---

## 1 · Who owns what

| Party | Owns | Never does |
|---|---|---|
| **BzzzBX** (truth store, ClickHouse) | Raw business events, per-interaction grain, `correlation_id`, `entity_id`, `miembro.id`, `bzzz.tenant` | Knows a BOb UUID; holds an identity store (D47) |
| **BOb** (Postgres, schema `bob`) | `org_id`, `channel_id`, `actor_id`, configuration (§9), live state, the shape of the eight tables | Queries the truth store, except through `affected_members` (§7.3); writes a projection (PR-4) |
| **The feeder** | Every row in the eight tables, and the partitions they live in (§3) | Reads BOb configuration beyond the two named views in §7.4; creates an actor |

There is exactly one writer, `bob_feeder`. Whether the reference feeder or 3.7
holds that credential, the contract is the same.

## 2 · Tenant key

- Every projection row carries **`org_id UUID NOT NULL`**. **Never the slug.**
  SR-1: `org_id` is the key for RLS and every foreign key inside BOb; the slug is
  only what crosses the boundary.
- The feeder receives `bzzz.tenant` (the slug) with each event, resolves
  `(tenant_slug, source_key)` through `v_feeder_channel_map`, and writes the
  `org_id` and `channel_id` it gets back.
- An event whose `(tenant_slug, source_key)` does not resolve is **not
  projected**. It is never written under a guessed tenant or a catch-all channel.
  It is **emitted, not stored** (§11 Q6 of 0.2, ruled 10 Nov): it has no `org_id`, so
  it cannot live in a tenant-scoped table, and a log is invisible to the product.
  A non-zero unmapped rate is our defect, not the customer's data. See §8.6.
- RLS is enabled on every table **and on every partition**, with the policy
  every tenant table already uses: `org_id = (auth.jwt() ->> 'org_id')::uuid`.
  A partition does not inherit RLS (F-18).
- §3.3 declares no foreign key from `org_id` to `organizations`, and 0.3 follows
  it. 0.2's proposed `ON DELETE CASCADE` is withdrawn. The fixture's sweep of
  every discovered tenant table (F-19) already covers tables the cascade cannot
  reach.

## 3 · Grain, partitions, retention

- **Grain: five-minute buckets, UTC-aligned (C-13)**, for the six aggregate
  tables (§6.1 to §6.6). Column `bucket_start TIMESTAMPTZ NOT NULL`, covering
  `[bucket_start, bucket_start + 5 min)`, with
  `CHECK (extract(epoch FROM bucket_start)::bigint % 300 = 0)`.
- **Two tables are event-grained, not bucketed** (§3.3): `proj_detections`
  (one row per detection, partitioned by `detected_at`) and `proj_deliveries`
  (one row per delivery attempt, partitioned by `attempted_at`). The grain CHECK
  does not apply to them. **[OPEN]** §11 Q2.
- **Event time, not ingestion time** (ruled 10 Nov, Q5). An event lands in the bucket of
  its event time in UTC. Ingestion time would put the same conversation in
  different buckets depending on the network, and D-17's time attribution
  depends on event time.
- **How late is too late** is the channel's declared lag (D-25,
  `channels.lag_seconds`). NULL means not declared, which the evaluator must
  refuse rather than treat as zero (A-04). An event arriving after its bucket is
  sealed is a **rebuild trigger** (§8.5), the same path linkage uses, not a
  late-arrival path of its own.
- Some measures land somewhere other than the bucket their first event fell in,
  deliberately (§6.3, §6.1):
  - a response time lands in the bucket of its **closing** turn;
  - a conversation-grain figure (resolution, closing sentiment) lands in the
    bucket the conversation **closed** in.

  So a call from 13:30 to 14:03 puts its sentiment readings across 13:30–14:00
  and its resolution in 14:00. The two sides of the panel attribute the same
  conversation to different times on purpose (Relevo task 12, D-15). It is not a bug.
- **No stored rollups.** Hours, days and months are computed at read time. Every
  measure is additive (counts, sums, mins, maxes, histogram buckets), so a
  coarser window is a sum of finer ones. The exceptions are `error_rate` and
  `uptime_pct` (§6.4, §11 Q10).
- The five-minute bucket is structural, not configuration: it is the floor of
  the cooldown CHECK (D-05) and changing it means rebuilding thirteen months.
- **Partitions: monthly, by `RANGE` on the partition column, UTC month
  boundaries (C-14).** Name `<parent>_yYYYYmMM` **[PROPOSED]**.
- **The feeder creates the partition it is about to write into** (ruled 10 Nov, Q7):
  idempotently, in the same function that grants it. `CREATE TABLE IF NOT
  EXISTS … PARTITION OF …`, then `bob_grant_projection()`, then `ENABLE ROW
  LEVEL SECURITY` and the `org_id` policy, all in one function. That makes a
  forgotten-partition bug impossible rather than guarded against, and closes
  F-18's remaining half by construction.
  - `bob_feeder` does not own the parents and cannot run
    `bob_grant_projection()` (EXECUTE is revoked from PUBLIC in
    `20260902100300`). So the function is `SECURITY DEFINER`, owned by the
    migration owner, with EXECUTE granted to `bob_feeder` alone. It takes a
    parent from the eight and a month, and nothing else **[PROPOSED]**.
- **Retention: thirteen months (C-14)**, matching `business_events` at 395 days
  (Bzzz D39). **Until Slice 5, retention is not enforced.** Nothing drops a
  partition in Slice 2: dropping is destructive, nothing is thirteen months old,
  and `pg_cron` arrives in Slice 5. When it does, old partitions are detached and
  dropped, never deleted row by row.

## 4 · Provenance and sealing

Three provenance columns on every row of all eight tables. The names are
§3.3's (F-20, closed 10 Nov):

| Column | Type | Meaning |
|---|---|---|
| `computed_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | When the row was last written |
| `source_watermark` | `TIMESTAMPTZ NOT NULL` | The truth-store watermark the row was computed behind |
| `feeder_version` | `TEXT NOT NULL` | Build of the feeder that wrote the row |

**`sealed BOOLEAN NOT NULL DEFAULT false`** is on the six bucketed tables, as
§3.3 declares it. 0.2 derived sealing from the watermark instead of storing it;
§3.3 stores it and no ruling supersedes that, so 0.3 stores it **[OPEN]** §11 Q1.
Whatever answer Q1 gets, the flag must never disagree with the watermark.
The invariant `sealed ⇒ bucket_start + interval '5 minutes' <= source_watermark`
is asserted by a guard (§10).

**Sealed means complete, not immutable** (D-12, 4 Nov). A sealed bucket will receive no
further facts. Attribution inside it can still be revised when an identity
is linked (§8.5), and a late event can still trigger a rebuild of it (§3). The
change is always applied by rebuilding the window, never by patching rows.
Anyone implementing "sealed" as "immutable" implements the ruling out of
existence.

## 5 · Absent, zero, not configured

Three states, and the product renders each differently:

| State | Meaning | How it is known |
|---|---|---|
| **Not configured** | The channel has no instrumentation that could produce this | No `channel_capabilities` row for the class (§9.1). D-14's third state |
| **Not observed** | It could, and nothing reached us | Capability present, no row |
| **Observed, none** | It could, it was alive, and nothing happened | A row with a zero |

The feeder must never write a zero it did not observe, and must write one when
it did.

**Liveness comes from the instrumentation heartbeat** (ruled 10 Nov, Q4). An instrumented
property emits on a timer whether or not a customer showed up. So "alive in a
bucket with no business events" is read from the health signal, not inferred
from customer activity or a DLQ count. That signal is what writes a
`proj_channel_health` row with `observed = true`. A channel with no health
instrumentation is **not configured**, not "not observed". The capability that
declares health instrumentation is **[OPEN]** §11 Q9.

§5, D-14 and `channel_capabilities` are one mechanism, not three (Relevo task 10, 10 Nov).

Derived figures that are absent rather than zero by ruling:
- ORGA when no selected channel carries a customer turn (Relevo task 8, D-17).
- MECA when no selected channel declares `meca_rum` (FR-32, FR-35).
- `hallucinations` ("Unfounded claims") until a ground truth exists (§6.1).

The em dash in the Slice 7 roster means **off shift** (Relevo task 10). That is a
fourth rendering, and it belongs to the roster rather than to this contract.

## 6 · The eight tables

**Names: Migration Order step 14.**

- `proj_metric_counts`
- `proj_sentiment`
- `proj_response_time`
- `proj_channel_health`
- `proj_rum_signals`
- `proj_actor_metrics`
- `proj_detections`
- `proj_deliveries`

§3.3's opening line says "all six"; there are eight (supersession note 5).

**Columns: Handoff §3.3, except where a later ruling supersedes it.** The
supersessions are named, not left to be inferred (Relevo task 6, 10 Nov):

| # | Table | §3.3 says | 0.3 carries | Ruling |
|---|---|---|---|---|
| S1 | `proj_response_time` | `sketch BYTEA` (t-digest), no min/max | OTel exponential histogram, `n`, `sum_ms`, `min_ms`, `max_ms` | C-15; note 1 |
| S2 | `proj_channel_health` | `latency_p50_ms`, `latency_p95_ms` | The same histogram shape as S1 | Note 2 |
| S3 | `proj_channel_health` | `health_pct` | Dropped. Status is derived at read time | 10 Nov |
| S4 | four tables | — | Added columns: rung at interaction, abstained, classifier-down, conversation grain, histogram scale and offset | Note 3 |
| S5 | prose | `member` | `actor_type` value is `'user'`, as the schema says | Note 4 |

All eight tables live in schema `bob` and are `PARTITION BY RANGE`. `actor_type`
is `TEXT CHECK (actor_type IN ('user','asa','human','arep'))`, the set
`actors` and `channel_actor_mix` use. BObee is not an actor type
(Relevo task 10, point 8).

Below, "provenance" means the three columns of §4. On the six bucketed tables,
it also means `sealed` and the grain CHECK of §3. Lines marked `-- 0.3` differ
from §3.3.

### 6.1 `proj_metric_counts` — the five metrics

```sql
CREATE TABLE bob.proj_metric_counts (
  org_id        UUID        NOT NULL,
  channel_id    UUID        NOT NULL REFERENCES channels(id),
  actor_type    TEXT        NOT NULL
                CHECK (actor_type IN ('user','asa','human','arep')),
  metric_id     TEXT        NOT NULL
                CHECK (metric_id IN ('resolved','abandoned',
                       'disambiguation','escalations','hallucinations')),
  bucket_start  TIMESTAMPTZ NOT NULL,
  event_count   BIGINT      NOT NULL DEFAULT 0,
  session_count BIGINT      NOT NULL DEFAULT 0,   -- denominator
  -- sealed + provenance
  PRIMARY KEY (org_id, channel_id, actor_type, metric_id, bucket_start)
) PARTITION BY RANGE (bucket_start);
```

**Attribution (D-03, closed 10 Nov).** A metric attributes to the actor that produced
the event the metric counts. That is who did the thing being counted, not who
was involved.

| `metric_id` | Attributed to |
|---|---|
| `resolved` | the actor that produced the resolution |
| `abandoned` | the actor holding the interaction when the customer left **[OPEN]** §11 Q4 |
| `escalations` | the actor that escalated |
| `disambiguation` | the actor that had to disambiguate |
| `hallucinations` | the actor that made the unfounded claim |

- One interaction can produce several metrics with different owners. An ASA that
  carries a conversation and hands off records one `escalations`; the human who
  closes it records one `resolved`. That is not double-counting.
- Counting one metric for two actors is not allowed. It would make the
  denominator count touches rather than interactions, and break FR-10 to
  FR-14's hundred-percent rule silently.
- The hundred-percent rule holds by construction. §3.3's window function
  renormalises over the actor types present in the selection, and an absent
  actor contributes no row.
- **An abandonment with no actor holding it attributes to nobody.** A customer
  who leaves while queued contributes no row here. Where that queue abandonment
  is counted instead is **[OPEN]** §11 Q4.

**`resolved`, for v1, means closed without escalation** (Relevo task 12, D-15). It is
conversation grain and lands in the bucket the conversation closed in (§3).
"No re-contact within N hours" is deferred to v1.1, because it needs a second,
later-settling watermark.

**`hallucinations` applies to all four actor types** (10 Nov, reversing the ASA-only
ruling of 5 Nov on Relevo task 12).
- A human agent can state an unfounded policy. A customer can state an
  unfounded belief ("I was promised a 30% return"), and that is a signal about
  marketing or mis-selling.
- The stored `metric_id` stays `hallucinations`, because it is already in a
  CHECK. It is **displayed as "Unfounded claims"**.
- Detection needs a ground truth: D-29's knowledge notes, which ship empty in
  v1. So this row renders absent longer than the other four, and that is the
  reason.

### 6.2 `proj_sentiment` — ORGA and MECA

```sql
CREATE TABLE bob.proj_sentiment (
  org_id        UUID        NOT NULL,
  channel_id    UUID        NOT NULL REFERENCES channels(id),
  source        TEXT        NOT NULL CHECK (source IN ('orga','meca')),
  state         TEXT        NOT NULL
                CHECK (state IN ('s0','s1','s2','s3','s4')),
  bucket_start  TIMESTAMPTZ NOT NULL,
  reading_count BIGINT      NOT NULL DEFAULT 0,
  -- 0.3: abstained count and classifier-down count. Placement OPEN, §11 Q6.
  -- sealed + provenance
  PRIMARY KEY (org_id, channel_id, source, state, bucket_start)
) PARTITION BY RANGE (bucket_start);
```

- **Two sources and five states, as §3.3 declares.** This replaces 0.2's "four
  sources" and its five named labels (0.2 §11 Q8, closed with §3.3).
- ORGA and MECA are separate rows. The blend is computed at read time from the
  configured mechanical weight, so changing the weight re-renders history
  instead of invalidating it. MECA rows, like every row here, are written by the
  feeder.
- Counts, not percentages (PR-1).
- One ORGA reading is one customer speaker turn. Agent turns produce none
  (D-17). ORGA on WhatsApp/YCloud comes from the local classifier (D51); voice
  stays absent until the sides arrive separately.
- **Two counts outside the five states** (supersession note 3):
  - **abstained** (Relevo's A-09): the classifier read the turn and declined to
    label it;
  - **classifier-down** (Henry's extension): the classifier was not running.
    Without it, a dead classifier looks like a very cautious one.

  Neither is ever one of the five states.
- **Closing sentiment** (D-15): the state of a conversation's final customer
  turn, stored beside `resolved` as a weight, never as a confirmation. No
  blended resolution score is computed from the two. Where it is stored is
  **[OPEN]** §11 Q7.

### 6.3 `proj_response_time` — distributions, not averages (S1)

```sql
CREATE TABLE bob.proj_response_time (
  org_id          UUID        NOT NULL,
  channel_id      UUID        NOT NULL REFERENCES channels(id),
  actor_type      TEXT        NOT NULL
                  CHECK (actor_type IN ('user','asa','human','arep')),  -- 0.3 [PROPOSED]
  bucket_start    TIMESTAMPTZ NOT NULL,
  n               BIGINT      NOT NULL,           -- exact count
  sum_ms          BIGINT      NOT NULL,           -- exact mean on recombine
  min_ms          BIGINT,                         -- 0.3, C-15
  max_ms          BIGINT,                         -- 0.3, C-15
  hist_scale      SMALLINT    NOT NULL DEFAULT 4, -- 0.3, C-15 (replaces sketch)
  hist_offset     INTEGER     NOT NULL,           -- 0.3, index of first populated bucket
  hist_counts     BIGINT[]    NOT NULL DEFAULT '{}',  -- 0.3
  hist_zero_count BIGINT      NOT NULL DEFAULT 0,     -- 0.3
  -- sealed + provenance
  PRIMARY KEY (org_id, channel_id, actor_type, bucket_start)
) PARTITION BY RANGE (bucket_start);
```

`hist_scale` is stored per row and is **not** constrained to 4: rows at
different scales are down-scaled by powers of two before merging. Merge: align
by `hist_offset`, add counts. Percentiles are read by walking buckets. **No
stored percentile, ever.**

**What it measures** (ruled 10 Nov, Q3):
- **The window rule.** A window is opened by a turn and closed by the first
  turn from the other side after it. Consecutive turns from the same side move
  the opening to the latest of them. Three customer messages at 10:00, 10:02 and
  10:04, answered at 10:10, are a six-minute response, not ten.
- **Both directions, attributed to whoever responded** (D-03). An agent asks at
  10:00 and the customer answers at 10:17: seventeen minutes, `actor_type =
  'user'`. Business-side figures carry thresholds and SLAs; customer-side
  figures are engagement.
- **It lands in the bucket of its closing turn.** An open window contributes
  nothing until it closes, then lands once.
- **Never merged across `actor_type`.** The histogram merges freely across
  channels and time. Merging agent speed with customer think-time produces a
  figure describing nobody. This is enforced by a test, not by this sentence
  (§10).
- **A gap is a response time or an abandonment, never both.**
  - If the reply comes, however late, the gap is a response time.
  - If it never comes, it converts to `abandoned` in §6.1.

  Without this, "we never replied" would score better than "we replied slowly".
  There are three ways an abandonment is detected:
  - **explicit**: the ASA closes the conversation on its own timer;
  - **superseded**: a new conversation starts while this one is open;
  - **idle**: no activity past the channel's idle bound (§9.2).

  Which bucket an abandonment lands in is **[OPEN]** §11 Q5.
- **Request-to-response latency is not this metric.** It is technical latency
  and lives in `proj_channel_health` (§6.4).
- A per-conversation average response time is a different metric ("how fast
  was this conversation"), shown as a drill-down column. It is not a second
  name for this one (Relevo task 12).

### 6.4 `proj_channel_health` — the components, not a blend (S2, S3)

```sql
CREATE TABLE bob.proj_channel_health (
  org_id                  UUID        NOT NULL,
  channel_id              UUID        NOT NULL REFERENCES channels(id),
  bucket_start            TIMESTAMPTZ NOT NULL,
  -- health_pct, latency_p50_ms, latency_p95_ms: dropped (S2, S3)
  latency_n               BIGINT      NOT NULL DEFAULT 0,      -- 0.3
  latency_sum_ms          BIGINT      NOT NULL DEFAULT 0,      -- 0.3
  latency_min_ms          BIGINT,                              -- 0.3
  latency_max_ms          BIGINT,                              -- 0.3
  latency_hist_scale      SMALLINT    NOT NULL DEFAULT 4,      -- 0.3
  latency_hist_offset     INTEGER     NOT NULL DEFAULT 0,      -- 0.3
  latency_hist_counts     BIGINT[]    NOT NULL DEFAULT '{}',   -- 0.3
  latency_hist_zero_count BIGINT      NOT NULL DEFAULT 0,      -- 0.3
  error_rate              NUMERIC,
  uptime_pct              NUMERIC,
  disconnects             INTEGER,
  observed                BOOLEAN     NOT NULL DEFAULT true,   -- PR-10
  -- sealed + provenance
  PRIMARY KEY (org_id, channel_id, bucket_start)
) PARTITION BY RANGE (bucket_start);
```

The latency columns carry §6.3's shape under a `latency_` prefix. The prefix is
**[PROPOSED]**; the shape is ruled (note 2).

- **Standard instrumentation, not ours** (note 2):
  - APM and browser or mobile agents for digital properties (a website, a web
    form, an app);
  - API-level measurement and synthetic probes for channels reached over an
    API, such as WhatsApp.

  OTel's standard shape for a duration is already a histogram, so keeping it
  mergeable and using the standard signal are one decision.
- **`health_pct` is dropped** (10 Nov). No standard supplies it, and it would be a
  weighted opinion wearing a percent sign (PR-1). Retuning its weights would
  silently change thirteen months of rows and every threshold set against them.
- **Channel status is derived at read time as the worst breaching component.**
  A threshold colours the display whether or not a response is attached (Relevo task 9).
  Nothing new is stored, and BOb still writes no projection (PR-4). How many
  display states that produces is a Slice 7 question, not this contract's.
- **For an API-mediated channel, health is the health of our integration**, not
  of the provider's product. A red WhatsApp channel means our calls to Meta are
  failing or slow. The interface must not let it read as WhatsApp being down.
- A row with `observed = true` is what §5 reads as "alive in this bucket". RS-06
  reads this table for channel health as it stood when an alert fired.
- `error_rate` and `uptime_pct` are kept as ruled. Whether they can be merged
  across a channel selection is **[OPEN]** §11 Q10.

### 6.5 `proj_rum_signals` — the MECA inputs

```sql
CREATE TABLE bob.proj_rum_signals (
  org_id        UUID        NOT NULL,
  channel_id    UUID        NOT NULL REFERENCES channels(id),
  signal        TEXT        NOT NULL CHECK (signal IN
                  ('rage_click','dead_click','error_click','thrash',
                   'rapid_exit','clean_session','fast_session')),
  bucket_start  TIMESTAMPTZ NOT NULL,
  signal_count  BIGINT      NOT NULL DEFAULT 0,
  session_count BIGINT      NOT NULL DEFAULT 0,
  -- sealed + provenance
  PRIMARY KEY (org_id, channel_id, signal, bucket_start)
) PARTITION BY RANGE (bucket_start);
```

Verbatim from §3.3. Replaces `rum_events`. Raw RUM events stay in the truth
store. A channel that does not declare `meca_rum` (§9.1) has no rows, and MECA
renders absent (FR-35).

### 6.6 `proj_actor_metrics` — per actor

```sql
CREATE TABLE bob.proj_actor_metrics (
  org_id        UUID        NOT NULL,
  actor_id      UUID        NOT NULL REFERENCES actors(id),
  channel_id    UUID        NOT NULL REFERENCES channels(id),
  metric_id     TEXT        NOT NULL,
  identity_rung_at_interaction TEXT NOT NULL                    -- 0.3, D-12
                CHECK (identity_rung_at_interaction IN
                       ('identified','ghost','guest','inferred')),
  bucket_start  TIMESTAMPTZ NOT NULL,
  event_count   BIGINT      NOT NULL DEFAULT 0,
  handled_count BIGINT      NOT NULL DEFAULT 0,
  -- sealed + provenance
  PRIMARY KEY (org_id, actor_id, channel_id, metric_id,
               identity_rung_at_interaction, bucket_start)       -- 0.3 [PROPOSED]
) PARTITION BY RANGE (bucket_start);
```

- **Unblocked by D-03** (10 Nov). §3.3's boxed note held this table on "what counts as
  contributing". `event_count` follows §6.1's attribution rule. `handled_count`
  is how many interactions this actor touched, whatever happened. The two no
  longer overlap. This also unblocks CF-12 and the Slice 7 per-agent columns.
  How `handled_count` sits on rows keyed by `metric_id` is **[OPEN]** §11 Q8.
- **`identity_rung_at_interaction`** (D-12, 4 Nov) keeps the rung as it was when the
  interaction happened, beside the actor it now points to.
  - Example: a ghost merged into an identified member keeps the fact that their
    first visits were pre-authentication.
  - It is derived from the linkage history as of event time (§9.4), never from
    the actor's current rung. Otherwise the first rebuild after a merge turns
    every pre-authentication rung into `identified`, and the rebuild test still
    passes.
  - It sits in the primary key **[PROPOSED]**, so one actor's pre- and
    post-authentication activity in the same bucket stay separate rows.
- **Linkage reaches only this table.** A ghost and an identified member are
  both `actor_type = 'user'`, so `proj_metric_counts` summed by actor type and
  FR-10 to FR-14 are unchanged by a merge (D-12).

### 6.7 `proj_detections` — what Flink found (event grain)

```sql
CREATE TABLE bob.proj_detections (
  org_id            UUID        NOT NULL,
  detection_id      TEXT        NOT NULL,
  channel_id        UUID        REFERENCES channels(id),   -- may be null
  detection         TEXT        NOT NULL,
  detected_at       TIMESTAMPTZ NOT NULL,
  confidence        NUMERIC,
  infra_evidence    JSONB,
  business_evidence JSONB,
  acted_upon        BOOLEAN     NOT NULL DEFAULT false,
  correlation_id    TEXT        NOT NULL,
  -- provenance (no sealed, no bucket_start)
  PRIMARY KEY (org_id, detection_id)
) PARTITION BY RANGE (detected_at);
```

Verbatim from §3.3. `rule_id` is absent by design: a stream detection has no
authored rule. Named anomaly rules stay in BOb and alert through the evaluation
loop; unnamed patterns arrive here.

### 6.8 `proj_deliveries` — what actually happened (event grain)

```sql
CREATE TABLE bob.proj_deliveries (
  org_id           UUID        NOT NULL,
  attempt_id       TEXT        NOT NULL,
  outbound_id      UUID        NOT NULL,   -- joins outbound_queue
  correlation_id   TEXT        NOT NULL,
  kind             TEXT        NOT NULL CHECK (kind IN ('autocomm','autobotz')),
  provider         TEXT        NOT NULL,
  attempted_at     TIMESTAMPTZ NOT NULL,
  outcome          TEXT        NOT NULL
                   CHECK (outcome IN ('delivered','failed',
                          'rejected','expired','suppressed')),
  attempt          INTEGER     NOT NULL DEFAULT 1,
  provider_ref     TEXT,
  provider_message TEXT,
  guardrail_bound  TEXT,        -- which limit applied, if any
  report           JSONB,       -- the typed return payload, Handoff §7.4
  -- provenance (no sealed, no bucket_start)
  PRIMARY KEY (org_id, attempt_id)
) PARTITION BY RANGE (attempted_at);
```

- Verbatim from §3.3. It answers 0.2's Q9:
  - the outcome set is the five values above;
  - AutoComm and AutoBotz share the table through `kind`;
  - the chain joins back through `outbound_id`.
- Provider accounts belong to the customer. So this row, with `provider_ref`,
  is the answer when a customer says an alert never arrived.
- `outbound_queue` (Handoff Part 4) is not in the migration chain yet.
  `outbound_id` is therefore not a foreign key in Slice 2.
- AutoBotz execution is not enabled before Slice 8 (Relevo task 6, 4 Nov). The durable
  audit path for a mutative action is the emission (X-10), and emission is
  Slice 8.

## 7 · Correlation, identity and the drill-through

### 7.1 Whose identifiers

`correlation_id` and `entity_id` are BzzzBX's (C-11). BOb never mints one.
`miembro.id` is BzzzBX's too: a salted hash computed at source (D47), held in
`business_events.attributes['miembro.id']`, not in `entity_id`. No connector
sets `entity_id`.

- **`correlation_id`** is how the feeder counts an interaction once, opens and
  closes response-time windows (§6.3), and orders turns. It appears as a column
  only on the two event-grained tables, `proj_detections` and `proj_deliveries`
  (§3.3). 0.2's "neither appears in any projection" is corrected. On the six
  aggregate tables the aggregate lands in BOb and the identifier stays in
  ClickHouse.
- **`entity_id`** appears in no projection.

### 7.2 Resolving an external identifier to an actor

An actor's external identifiers live in **`actor_external_refs (org_id,
actor_id, ref)`, with `(org_id, ref)` UNIQUE** (Relevo task 13, 10 Nov). The constraint
makes "two actors, one person" impossible rather than unlikely. The lookup runs
from `ref` to actor. A new identifier type needs no migration. See §9.3.

| Actor type | `ref` | How it is obtained | Authority for "these refs are one actor" |
|---|---|---|---|
| `user` | `m:…`, the `miembro.id` | **Computed** (D47) | The customer's member record |
| `human` | `<source_key>:<external id>` | **Mapped**; the namespace comes from `channels.source_key`, discovered, never typed | The customer's staff directory |
| `asa` | The bot platform's deployment identifier | **Mapped**; one deployment can serve several channels | The customer's deployment record |
| `arep` | Inherits the ASA shape when it exists | | |

- **Corrects 0.2 §7.** For members, `external_ref` is
  `attributes['miembro.id']`, not `entity_id`.
- **BOb never infers a link from similarity.**
- **The namespace in an agent ref is not cosmetic.** PBX agent 42 and Zendesk
  agent 42 are different people. Unnamespaced, `(org_id, ref)` UNIQUE would
  merge them into one actor with no error.
- How an ASA's deployment identifier is namespaced is **[OPEN]** §11 Q14.
- **An unmapped identifier never becomes a new actor** (Relevo task 13, 10 Nov). It is
  emitted on the unmapped path (§8.6) and produces no actor row. The feeder never
  creates an actor.
- An interaction whose ref resolves to no actor counts in §6.1 under its actor
  type and is absent from §6.6.
- For members, this collides with D-12's "capture as much member activity as we
  can" **[OPEN]** §11 Q13.
- Today a human agent is identifiable on voice only: there is no agent on
  WhatsApp events. The table shows that as an absent mapping, not as missing
  data.

### 7.3 `affected_members(frame, filter)` — the drill-through (Relevo's A-07, ruled 10 Nov)

"Who was affected" is answered by a **drill-through to the truth store, named
here as part of the contract**, not by per-member projection rows. Per-member
rows at five-minute grain approach interaction grain, which A-06 and D-30 left
in the truth store. The problem is the grain, not the size. Because the
interface is named in the contract, the application still never knows which
truth store it runs against.

- **Input.**
  - A `frame`: `tenant_slug`, `source_key`(s), and a window `[from, to)` no
    longer than retention, the same frame §7.5 uses.
  - A `filter` selecting the events that count as "affected". **[OPEN]**
    §11 Q15.
- **Output, two kinds of thing and never one:**
  1. **Members as rows.** One row per member per interaction:
     - `external_ref` (`m:…`);
     - `correlation_id`;
     - `first_seen`;
     - `last_seen`;
     - `n_events`.

     Paged. BOb aggregates to one line per member and resolves `m:…` to an
     actor through §7.2.
  2. **Anonymous traffic as a count.** The number of distinct
     `correlation_id`s in the frame and filter with no `miembro.id`.
     **Interactions, not visitors**: counting distinct anonymous people needs
     exactly the key we do not have.
- The panel reads, for example: "47 members affected, and 23 interactions with
  no identified member". Omitting the count would show 70 where 100 were
  affected and say nothing about the gap.
- **Pseudonyms only.** BzzzBX never learns a name. Turning `m:…` into a person
  is BOb's, under ID-04, and the reveal control appears in Slice 8.
- **No ghost key for anonymous visitors.** D47 stays as signed and no new
  member type is added: a count needs no key.
- **Cost on the ClickHouse side** (Henry, 6 Nov, estimated, not measured).
  - A windowed query prunes on `business_events`' primary key and is cheap.
  - One member's whole history reads the attributes map for the window, because
    `miembro.id` has no index today. A materialized `miembro_id` column with a
    bloom-filter index is the BzzzBX fix if it hurts, proposed only.
- Whether 3.7 delivers this as a third deliverable or as a mode of the evidence
  packages is **[OPEN]** §11 Q15.

### 7.4 What the feeder reads from BOb

Exactly two views. Anything more is a finding about this contract.

- **`v_feeder_channel_map`** (exists): `channel_id`, `org_id`, `tenant_slug`,
  `source_key`, `lag_seconds`, `adapter_kind`. In 0.3 it gains the idle bound of
  §9.2 **[PROPOSED]**.
- **`v_feeder_actor_map`** **[PROPOSED]**: `org_id`, `ref`, `actor_id`,
  `actor_type`, and the linkage history of §9.4 (`identity_rung`, `valid_from`,
  `valid_to`). From these the feeder derives the actor and the rung as of an
  event's time. No `display_name`, no `display_id`: the feeder never sees a name.

### 7.5 Evidence is not a projection

3.7's evidence packages by `correlation_id` and `entity_id` are the platform's
surface. A BOb cell reaches them through its frame (`tenant_slug`,
`source_key`, bucket window, `external_ref`), a query key into BzzzBX, not a BOb
table. So 3.7 delivers the eight tables, the evidence packages, and
`affected_members`, and the eight tables never merge with the other two.

## 8 · The feeder's obligations

The five from the Build Brief (Slice 2) and System Flows §3, as amended by the
10 Nov rulings, plus a sixth that follows from §2.

1. **Fill every table at declared grain.**
   - Bucketed tables are written on five-minute UTC boundaries; the CHECK in §3
     refuses anything else.
   - Event-grained tables carry their event time.
   - Buckets are assigned by event time (§3).
2. **Idempotent on the primary key.** An upsert on the projection primary key.
   Replaying a window changes nothing but `computed_at`.
3. **Advance a watermark and seal only behind it.**
   - The watermark travels on the rows as `source_watermark`, read back as its
     maximum per tenant and table. A watermark table written by `bob_feeder`
     would be a ninth projection to the F-18 guard.
   - `sealed` is set only when the bucket's end is at or behind the watermark
     (§4).
   - **Sealed means complete, not immutable.**
4. **Stamp `feeder_version`** on every row it writes.
5. **Rebuild an arbitrary window on demand.** The same query over a different
   range: for `(org_id, [from, to))`, delete and refill. Two events trigger one:
   - **A linkage** (D-12). The window is `[earliest interaction attributable to
     the linked identity, now)`, bounded by retention (C-14). It runs in the
     background, bounded, never synchronously with a login. Attribution is
     re-derived from the linkage history as of each event's time (§9.4), so the
     rebuilt rows equal what a full rebuild would produce.
   - **A late event** behind the seal (§3, Q5).

   **Alerts already fired are not re-evaluated** (D-12). An alert records what was
   known when it fired.

   The rebuild test truncates every projection, re-runs the feeder, and asserts
   the application renders identically. One case of it has a linkage inside the
   window (§10).
6. **Create the partition it writes into, and report what it cannot map.**
   - The partition comes through the one function of §3: create, grant, RLS.
   - An event whose tenant or channel does not resolve (§2) is **emitted to the
     bus, not stored**, as audit is under X-10. So is an external identifier
     that resolves to no actor (§7.2).
   - If the feeder silently drops five per cent of events, every figure is
     understated and nothing says so. What the Slice 2 reference feeder does
     before the bus emission exists is **[OPEN]** §11 Q12.

The recommended shape (System Flows §3) is a scheduled ClickHouse query on a
timer, not a stream: idempotency comes from the upsert, and rebuild is the same
query with a different range.

## 9 · Configuration the contract depends on

Configuration, not projection: authored in BOb, written by `bob_app`, backed up,
never rebuilt, outside the count of eight and outside PR-4.

### 9.1 `channel_capabilities` (Relevo task 10, 4 Nov)

```sql
channel_capabilities (org_id, channel_id, capability)
  PRIMARY KEY (org_id, channel_id, capability)
```

- **A row means this channel can produce this class; no row means it cannot.**
  The table records presence only, with no `enabled` boolean, by C-16's
  reasoning.
- Capabilities:
  - `orga_conversation`
  - `meca_rum`
  - `response_time`
  - `resolution`
  - `coherence`
  - `hallucination`

  None of them declares health instrumentation **[OPEN]** §11 Q9.
- **Declared per channel, never mapped from `channel_type`.** Two web forms at
  the same customer differ when one has a comment box. A guard asserts no code
  path maps a channel type to capabilities (§10).
- The drill-down reads the union of capabilities across the selected channels.

### 9.2 The per-channel idle bound — where it lives **[PROPOSED]**

Q3 requires an idle bound for abandonment that is **per channel and never a
constant in the feeder**. Twenty minutes is abandonment on voice and nothing on
email; one hour on WhatsApp would turn half of a healthy conversation set into
failures. Federico placed it "beside the capability and lag declarations on the
channel" and left the home to us.

This draft puts it on `channels`, beside `lag_seconds`:

```sql
ALTER TABLE channels ADD COLUMN idle_bound_seconds INTEGER
  CHECK (idle_bound_seconds IS NULL OR idle_bound_seconds > 0);
```

It is exposed to the feeder through `v_feeder_channel_map`.

- **Not in `channel_capabilities`.** That table is presence only, and a number
  in it is the `enabled` column C-16 refused.
- **A column on `channels`, like `lag_seconds`.** The feeder already reads its
  per-channel declarations from `v_feeder_channel_map`, so this needs no third
  view. That keeps §7.4's "exactly two".
- **Nullable, no default.** A default would declare a bound for every channel
  that nobody checked, which is A-04's trap.

What the feeder does when the bound is NULL is **[OPEN]** §11 Q11.

### 9.3 `actor_external_refs` (Relevo task 13, 10 Nov)

`actor_external_refs (org_id, actor_id, ref)`, `(org_id, ref)` UNIQUE, indexed
on `ref`. Ruled for all four actor types (§7.2). What happens to the existing
`actors.external_ref` column is **[OPEN]** §11 Q14.

BOb's `miembro.id` computation reads BzzzBX's `conectores/contratos/miembro/vectores.json`. It does not keep a
copy or a fixture of its own. The salt is checked by effect: a reserved canary
identifier that the feeder skips by rule, run at startup and daily (Relevo task 13). Both
belong to the actor work in Slice 2, not to this contract. They are named here
because a wrong salt fails §7.2 silently.

### 9.4 The linkage history **[PROPOSED]**

D-12's rebuild derives attribution from identity state. The rung at interaction
time (§6.6) cannot be recovered from *current* state. So BOb keeps an
append-only, dated history of which actor a ref belonged to and at what rung:

```sql
actor_ref_history (
  org_id        UUID        NOT NULL,
  ref           TEXT        NOT NULL,
  actor_id      UUID        NOT NULL,
  identity_rung TEXT        NOT NULL
                CHECK (identity_rung IN ('identified','ghost','guest','inferred')),
  valid_from    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, ref, valid_from)
)
```

- The state of a ref at time `t` is its row with the greatest `valid_from <= t`.
- A linkage, a merge or a rung change appends a row and never updates one.
- `actor_external_refs` is the current state, and a guard asserts it equals the
  latest history row per ref.
- The feeder reads the history through `v_feeder_actor_map`, so a rebuild always
  reproduces the rung as it was.

Name and shape are this draft's.

## 10 · Guards Slice 2 adds

Each one is seen failing on purpose before it is trusted, and recorded in
`contract-amendments.md`.

| Guard | Discovers | Asserts |
|---|---|---|
| Exactly eight | `projectionTables()` (F-18) | The non-partition projections equal the eight names in §6 of **this file**, read from here, not copied into the test |
| Partitions granted | partitions via `pg_inherits` | Every partition passes `projectionGrantFindings()` |
| Partitions guarded | `tenantTables()` | Every partition has RLS and the `org_id` policy |
| Partition function | the function of §3 | Run twice for one month: one partition, granted, with RLS. Executable by `bob_feeder` and no other role |
| `bob_app` grants | every `org_id` table | Non-projections: `bob_app` SELECT, INSERT, UPDATE, DELETE. Projections: SELECT only. Replaces the hand list in `20260902100300` |
| Pre-rename absence | every schema except `pg_*` and `information_schema` | No `autobotz_bindings` table or policy anywhere; replaces the two `public`-only checks in `slice0-schema.test.mjs` |
| Grain | every projection with a `bucket_start` column | Carries the bucket-alignment CHECK |
| No percentiles | every projection column | No column named like `p\d+`, `percentile`, `median`, `avg`, `mean`, `health_pct` |
| Provenance | every projection | Carries the three columns of §4, `NOT NULL` |
| Sealed agrees with watermark | every projection with `sealed` | No row with `sealed` and `bucket_start + 5 min > source_watermark` |
| Tenant key | every projection | Carries `org_id UUID NOT NULL`, no slug column |
| **Never merged across `actor_type`** | every view and function whose definition reads `proj_response_time` (`pg_depend`, `pg_proc`) | Structural: `actor_type` is `NOT NULL` and in the primary key. Behavioural: over a fixture with `user` and `human` rows in the same channel and bucket, every discovered reader returns them as separate distributions, never one. **[PROPOSED]**; see §11 Q16 |
| Rebuild with linkage | the rebuild test | A linkage inside the rebuilt window leaves `identity_rung_at_interaction` as it was at event time, and the render identical to a full rebuild |
| No capability from channel type | the codebase and the schema | No code path, view, function or seed derives `channel_capabilities` from `channel_type` (Relevo task 10). Lands with `channel_capabilities` |

## 11 · Open questions before signing

Draft 0.2's ten are closed (Relevo task 6, 10 Nov). These came out of writing 0.3 against
§3.3, the rulings and the migration chain. None reopens a ruling. Each one is a
place where two sources disagree, or where a ruling leaves a choice that the
contract must make.

1. **`sealed`: stored or derived.** §3.3 stores `sealed BOOLEAN` on six tables,
   and no supersession names it. 0.2 derived it from `source_watermark`, so as
   not to keep two answers to one question. 0.3 follows §3.3 and adds a guard
   that the two never disagree (§10). Confirm, or name it a sixth supersession.
2. **Two event-grained tables.** §3.3 gives `proj_detections` and
   `proj_deliveries` one row per event, partitioned by `detected_at` and
   `attempted_at`, with `correlation_id` on the row. Relevo task 6's "grain:
   five-minute buckets" was read in 0.2 as every table. 0.3 follows §3.3, so C-13
   and §7's "no correlation_id" apply to six tables. Confirm.
3. **FR-22 has lost its input.** `bob_availability_user(volume, window,
   avg_duration)` needs an average interaction duration.
   - 0.2 carried `duration_ms_sum` and `duration_n` on `proj_metric_counts` as
     proposals.
   - §3.3 has no duration anywhere, and no ruling adds one.

   Where does user availability's duration come from? Count and sum, by the
   D-15 discipline.
4. **Abandonment: holder or whoever went silent, and the queue.**
   - D-03 attributes `abandoned` to "the actor holding the interaction when the
     customer left".
   - Q3 attributes it to "whoever went silent": "Users 80%, Human Agent 20%".

   When a customer walks away from an agent, these two disagree. Which one?
   Separately, a queue abandonment "attributes to nobody … and shows at channel
   level". But every row of `proj_metric_counts` needs an `actor_type`, so
   nothing in the eight tables holds a channel-level count. Where is it stored?
5. **Which bucket an abandonment lands in.** Explicit close: the close event.
   Superseded: the new conversation's start. Idle: when the bound expires, or
   the last activity? Not ruled.
6. **Abstained and classifier-down counts.** They are ruled to be counts
   outside the five states. `proj_sentiment` is keyed by `state`, so a column
   would repeat on all five rows of a bucket. Options:
   - a reserved `state` value, which the ruling forbids;
   - a second key shape;
   - rows in `proj_metric_counts`.

   Which one?
7. **Closing sentiment (D-15).** "One column, derived from data we are already
   keeping", stored beside `resolved`, count-and-sum. Which table? Per closing
   state, or as a sum?
8. **`proj_actor_metrics` keys.**
   - (a) `identity_rung_at_interaction` in the primary key: proposed on
     6 Nov, not ratified.
   - (b) `handled_count` is per interaction but sits on rows keyed by
     `metric_id`, so it repeats across an actor's metric rows. Should it live on
     a row of its own, or be read as the maximum?
   - (c) §3.3 gives `metric_id` no CHECK here. Should it be the five of
     `proj_metric_counts`?
9. **The health capability.** Q4 makes "not configured" mean "no health
   instrumentation declared in `channel_capabilities`". None of the six ruled
   capabilities declares health. Add a seventh, e.g. `channel_health`?
10. **`error_rate` and `uptime_pct`.** They are kept by ruling, as ratios. A ratio
    averaged across a channel selection without weights fails the same way a
    stored percentile does (PR-1, the reasoning that dropped `health_pct`). Store
    numerator and denominator instead (errors and requests, seconds up and
    seconds observed)?
11. **Idle bound NULL.** If the feeder skips idle detection, the gap vanishes for
    that channel: Q3's perverse incentive returns, on undeclared channels only.
    If it refuses to project the channel, nothing renders until declared. The
    lag precedent (A-04) is "refuse"; here refusing costs more. Which?
12. **Unmapped events before Slice 8.** Q6 emits them to the bus, as audit under
    X-10, and emission arrives in Slice 8 (Relevo task 6, 4 Nov). What does the Slice 2
    reference feeder do until then? Counting into a structure without `org_id`
    is the one thing ruled out.
13. **Ghost members.** A WhatsApp sender with a `miembro.id` who is not in the
    customer's member record is a ghost on the same key. The feeder never creates
    an actor, and an unmapped ref never becomes one (§7.2). Who creates that
    ghost's actor so D-12 can "capture as much member activity as we can"? Or
    does it stay counted-only until the member record names it?
14. **`actors.external_ref` and ASA namespaces.** Ruled: `actor_external_refs`
    replaces the single column. Is `actors.external_ref` dropped in Slice 2, or
    kept nullable and unread? And is an ASA's deployment ref namespaced by its
    platform, the way an agent's is by `source_key`? From the same thread, still
    with Henry: are there non-channel sources of agent identity (an HR system, a
    directory)? If yes, `source_key` cannot name them, and a source registry is
    a column in Slice 2.
15. **`affected_members`: the filter and the deliverable.** What a `filter` may
    select (`event_name`s, a metric, a detection?), and whether 3.7 delivers it
    as a third deliverable or as a mode of the evidence packages. Henry offered
    both on 6 Nov; neither is ruled.
16. **The never-merge guard before a reader exists.** Slice 2 has no route
    handler (A-05b), so discovery finds no reader of `proj_response_time`, and
    the behavioural half would pass over nothing. Proposal: the structural half
    runs in Slice 2. The behavioural half reports `todo`, never `pass`, while it
    discovers zero readers. A floor naming the first handler then makes it
    required, as `TENANCY_FLOOR` does for tables. Acceptable?
