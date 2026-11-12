# BOb v1 · Projection read contract

**Status: DRAFT 0.5 — not published, not signed.** Opens Slice 2. Once Henry
signs it on Relevo task 6, it is published there and BzzzBX route-plan task 3.7
implements against it. No migration is written until then.

**How it changes.** It is published, not negotiated (Relevo task 6, 23 Oct). If anything
here is impossible or expensive on the ClickHouse side, it is said on Relevo task 6 and
the contract changes deliberately, with a new version number and an entry in
`Documentation/contract-amendments.md`. When this file and a signed decision
disagree, the decision wins.

**What changed from 0.4.** Federico ruled O1 to O5 on Relevo task 6
(12 Nov, 08:23), accepted the A-11/A-12 numbering and the five choices 0.4 made,
and asked for two things: §7.2 split into its two routes, and the shape of the
D-25 cut. The main changes:

- **O1.** A channel with no declared lag never seals and is never evaluated.
  Its rows are still written and rendered, and it is surfaced as "lag not
  declared" (§4, §4.1).
- **O2.** `interaction_duration` rows are always `user`, the third degenerate
  actor, with a CHECK (§6.3).
- **O3.** Q11's refusal does not reach `abandoned_in_queue` (§9.2).
- **O4.** §7.2 is split into two routes. An unmapped event has no `org_id`;
  an unresolved actor ref has one. The ghost reconciliation does its own
  windowed discovery and no longer depends on the bus (§7.2, §8.6).
- **O5.** The count equality is in interactions on both sides. The panel's
  "47 members" is distinct members, deliberately a different number (§7.3).
- **New, §4.1.** The channel-lag section: voice is 5–10 minutes late end to
  end (Relevo task 14), and a proposed cut after which a missing label is a failure
  rather than lag. The cut has three choices in it, left to Federico (§11
  C1–C3).
- **New, §7.3a.** A proposed `member_refs_seen(frame)` for the reconciliation
  to ask the truth store through; how it is delivered is §11 O6.

The 0.3→0.4 changes are in `contract-amendments.md`, under "Slice 2 · The
projection read contract, 0.4". This round is under "…, 0.5".

**One property runs through it** (Relevo task 6, 11 Nov): **a projection stores
counts, sums and distributions. It never stores a figure derived from them.**
That rule dropped the t-digest, `health_pct`, stored percentiles and stored
ratios.

**Sources.**
- Relevo task 6 thread:
  - 23 Oct: C-13 to C-15, the five obligations.
  - 4 Nov: D-12.
  - 10 Nov: F-20 closed with §3.3 attached, D-03, the hallucinations
    correction, A-11, 0.2's Q3 to Q7, `health_pct` dropped.
  - 11 Nov: 0.3's sixteen questions.
  - 12 Nov: O1 to O5, the numbering and the five choices accepted, §7.2's
    split, the D-25 cut asked for.
- Relevo task 14 (the AI drone), 12 Nov: Henry's measured voice latency
  (00:39, 01:42) and Federico's ruling that only chat goes to the provider in
  v1 (08:17).
- **Handoff §3.3, "The tables"** (`BOb_Implementation_Handoff_v1_2.docx`), as
  attached to Relevo task 6 on 10 Nov: `BOb_Handoff_3_3_The_Tables.md`, 16,183
  bytes, md5 `eb89363d41da5c8e9f11df8c905d7f3c`, with its supersession notes.
- Relevo task 10 (`channel_capabilities`), task 12 (D-15, the two grains), and
  task 13 (`actor_external_refs`; D-02 for agents and ASA).
- Relevo task 7 thread, 26–27 Oct: ruling (d), `org_id` as the tenant key;
  A-05a/A-05b.
- The Slice 1c package (8 Sep): Migration Order step 14, Decision Sheet C-11 to
  C-15, Build Brief Slices 2 and 6, System Flows §3.
- The migration chain on `main`, and F-17 to F-19 in `contract-amendments.md`.

**Markers.**
- **[PROPOSED]** marks a choice this draft makes that no ruling states. It
  stands unless the review changes it.
- **[OPEN]** marks a question listed in §11.
- Everything unmarked is ruled, and the ruling is named next to it.

**Identifiers.** `contract-amendments.md` is the register of A-numbers. A number
there is permanent. A ruling made on Relevo under a number the register already
uses is entered at the next free number, and is cited by that number from then
on (decided by 0.4, as Relevo task 6 asked on 11 Nov; accepted 12 Nov). So:

| On Relevo it was called | It is | Meaning |
|---|---|---|
| A-07 | **A-11** | "Who was affected" is a drill-through named in the contract, `affected_members` (§7.3) |
| A-09 | **A-12** | The abstained count, separate from the five sentiment states (now a `metric_id`, §6.1) |
| — | A-07 | Data Model §5.3 is superseded in full (register, unchanged) |
| — | A-09 | `actor_shifts.status` drops `'live'` (register, unchanged) |

---

## 1 · Who owns what

| Party | Owns | Never does |
|---|---|---|
| **BzzzBX** (truth store, ClickHouse) | Raw business events, per-interaction grain, `correlation_id`, `entity_id`, `miembro.id`, `bzzz.tenant` | Knows a BOb UUID; holds an identity store (D47) |
| **BOb** (Postgres, schema `bob`) | `org_id`, `channel_id`, `actor_id`, configuration (§9), live state, the shape of the eight tables, ghost reconciliation (§7.2) | Queries the truth store except through the named interfaces of §7.3 and §7.3a; writes a projection (PR-4) |
| **The feeder** | Every row in the eight tables, and the partitions they live in (§3) | Reads BOb configuration beyond the two named views in §7.4; creates or writes an actor |

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
  It is emitted, never stored. It has no `org_id`, so it cannot live in a
  tenant-scoped table. What the feeder does with it until the bus exists is in
  §8.6.
- RLS is enabled on every table **and on every partition**, with the policy
  every tenant table already uses: `org_id = (auth.jwt() ->> 'org_id')::uuid`.
  A partition does not inherit RLS (F-18).
- §3.3 declares no foreign key from `org_id` to `organizations`, and the
  contract follows it. The fixture's sweep of every discovered tenant table
  (F-19) covers tables the cascade cannot reach.

## 3 · Grain, partitions, retention

- **Grain: five-minute buckets, UTC-aligned (C-13)**, for the six aggregate
  tables (§6.1 to §6.6). Column `bucket_start TIMESTAMPTZ NOT NULL`, covering
  `[bucket_start, bucket_start + 5 min)`, with
  `CHECK (extract(epoch FROM bucket_start)::bigint % 300 = 0)`.
- **Two tables are event-grained, not bucketed** (§3.3; confirmed 11 Nov, Q2).
  - `proj_detections` has one row per detection, partitioned by `detected_at`.
  - `proj_deliveries` has one row per delivery attempt, partitioned by
    `attempted_at`.

  The grain CHECK does not apply to them. C-11 is about who owns the
  identifiers, not where they appear (§7.1).
- **Event time, not ingestion time** (0.2 Q5, ruled 10 Nov). An event lands in
  the bucket of its event time in UTC.
- **How late is too late** is the channel's declared lag (D-25,
  `channels.lag_seconds`). NULL means not declared, which the evaluator must
  refuse rather than treat as zero (A-04). An event arriving after its bucket is
  sealed is a **rebuild trigger** (§8.5), not a late-arrival path of its own.
  What a channel's lag must cover, and when a missing label stops being late
  and becomes a failure, is §4.1.
- **Where a measure lands, by rule:**

| Measure | Lands in the bucket of | Ruling |
|---|---|---|
| A turn-grain reading (ORGA, RUM) | the turn or action | D-17 |
| A response time | its **closing** turn | 0.2 Q3 |
| A conversation-grain figure (resolution, closing sentiment, interaction duration) | the conversation's **close** | D-15 |
| An abandonment, however detected | the conversation's **last activity** | 0.3 Q5 |

So a call from 13:30 to 14:03 puts its sentiment readings across 13:30–14:00
and its resolution in 14:00. The two sides of the panel attribute one
conversation to different times on purpose (Relevo task 12). It is not a bug.

An abandonment is placed at last activity for two reasons. Placing it at
detection would record it one idle bound late. It would also let a change to the
bound move where history sits. The bound decides only *whether* a gap is an
abandonment, never *when*. Because the abandonment is detected after its
bucket, it usually arrives behind the seal and is applied by the rebuild path
(§8.5). That costs nothing new. Choosing detection-time placement to avoid the
rebuild is ruled out.

- **No stored rollups.** Hours, days and months are computed at read time. Every
  measure is additive (counts, sums, mins, maxes, histogram buckets), so a
  coarser window is a sum of finer ones.
- The five-minute bucket is structural, not configuration: it is the floor of
  the cooldown CHECK (D-05) and changing it means rebuilding thirteen months.
- **Partitions: monthly, by `RANGE` on the partition column, UTC month
  boundaries (C-14).** Name `<parent>_yYYYYmMM` **[PROPOSED]**.
- **The feeder creates the partition it is about to write into** (0.2 Q7):
  idempotently, in the same function that grants it.
  - The function runs `CREATE TABLE IF NOT EXISTS … PARTITION OF …`, then
    `bob_grant_projection()`, then `ENABLE ROW LEVEL SECURITY` and the `org_id`
    policy.
  - `bob_feeder` does not own the parents and cannot execute
    `bob_grant_projection()` (revoked from PUBLIC in `20260902100300`). So the
    function is `SECURITY DEFINER`, owned by the migration owner, with EXECUTE
    granted to `bob_feeder` alone.
  - It takes a parent from the eight and a month, and nothing else
    **[PROPOSED]**.
- **Retention: thirteen months (C-14)**, matching `business_events` at 395 days
  (Bzzz D39). **Until Slice 5, retention is not enforced.** Nothing drops a
  partition in Slice 2. When `pg_cron` arrives, old partitions are detached and
  dropped, never deleted row by row.

## 4 · Provenance and sealing

Three provenance columns on every row of all eight tables, named as in §3.3
(F-20):

| Column | Type | Meaning |
|---|---|---|
| `computed_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | When the row was last written |
| `source_watermark` | `TIMESTAMPTZ NOT NULL` | The truth-store watermark the row was computed behind |
| `feeder_version` | `TEXT NOT NULL` | Build of the feeder that wrote the row |

**`sealed BOOLEAN NOT NULL DEFAULT false` is stored** on the six bucketed tables
(ruled 11 Nov, Q1). That is §3.3's shape, but it is stored for a different
reason: `lag_seconds` is configuration and can change. A bucket sealed under a
two-minute lag was sealed by the rule in force then. A flag derived from today's
lag would silently un-seal thirteen months of history the day a lag is raised.
Stored records what was true at the time, the same argument that put
`identity_rung_at_interaction` on §6.6.

**The sealing rule, with declared lag.** The feeder sets `sealed` only when

```
bucket_start + interval '5 minutes' + (lag_seconds * interval '1 second') <= source_watermark
```

using the channel's `lag_seconds` at the moment of writing. 0.3 stated the rule
without the lag, which is stricter than the contract and wrong for every channel
with a declared lag.

**A channel whose lag is NULL never seals** (12 Nov, O1). That is A-04 applied:
NULL is not zero. Only sealing and evaluation stop:
- Its rows are still written and still rendered. The data is not lost; the
  alerting is honestly off, because the evaluator refuses every open bucket
  and so no threshold ever fires on that channel.
- The channel is surfaced to the customer as **"lag not declared"**. Without
  it the customer sees figures, receives no alerts, and has no way to learn
  why. A silence with no stated cause looks like a system that is working.
- Slice 2 reports **the count of channels whose lag is NULL**, so we see the
  gap too, not only a customer who happens to open the right panel. It sits
  beside the lag-below-idle-bound report (§9.2).

One declaration fixes it.

**The guard asserts this at write time, not as a standing invariant** (Q1). After a
lag change, or after a rebuild moves a watermark, honest historic rows would trip
a standing check. A guard that cries wolf is a guard somebody disables, which is
how F-14 came to run in no job at all. See §10.

**Sealed means complete, not immutable** (D-12, 4 Nov). A sealed bucket will receive no
further facts of its own, but its attribution is revisable:
- a linkage triggers a rebuild of the window (§8.5);
- a late event or a late-detected abandonment (§3) does the same.

The change is always applied by rebuilding the window, never by patching rows.
Anyone implementing "sealed" as "immutable" implements the ruling out of
existence.

### 4.1 Channel lag (D-25): what it must cover, and the label cut

New in 0.5. Federico moved the latency finding here from Relevo task 14
(12 Nov): "a projection fact, not a drone fact".

**What a declared lag states.** `channels.lag_seconds` says: by this long after
a bucket ends, every fact of that bucket has reached the truth store. Sealing
(§4) and evaluation (PR-7) wait for it. It is per channel because the paths
differ by minutes.

**Voice is minutes late, with or without a provider.** Febor today (Relevo
task 14, 12 Nov):

| Leg | Febor today | Kind |
|---|---|---|
| Call delivered to the box by the third party, after hang-up | 1.5–6 min | Measured |
| Whisper transcription | ~3.5 min per call | Measured |
| Provider round trip, if a call's text were sent | ~5 s median, ~20 s p95 | Estimated |
| **End to end** | **~5–10 min** | |

- The provider term is not the one that matters. Voice misses the 30-second
  watermark and the five-minute bucket with the provider or without it.
- A voice channel's lag must cover the slowest leg behind any fact the eight
  tables read from it. If a projected fact comes from the transcript, that is
  ~10 minutes on today's figures. A 14:00–14:05 voice bucket then seals around
  14:15 at the earliest, and "real time" on voice means that.
- In v1 no voice transcript goes to the provider, and voice produces no ORGA
  because the audio is mono (Relevo task 14, 12 Nov; ruled 5 Nov). So the
  provider leg does not apply to voice in v1.
- Chat to the provider adds ~1.5 s median and ~6 s p95 per message
  (estimated). That fits well inside a five-minute bucket, and chat's lag is
  set by the rest of its path.
- **Declare lag from the measured tail, not the median** **[PROPOSED]**. A lag
  at the median puts half of a channel's facts behind the seal, and each of
  them is a rebuild.

**The label cut: when a missing label is a failure rather than lag.** A label
is a fact derived from a fact that has already arrived. In Slice 2 it is the
ORGA sentiment label on a customer turn, on a channel that declares
`orga_conversation`. If the turn has arrived and its label has not, the label
is either late or lost, and 0.4 does not say when the first becomes the second.

Without a cut, a lost label is lateness forever. The turn sits in the
denominator and in no state. `abstained` and `classifier_down` stay at zero.
A provider outage on chat reads as lag, not as a failure. That is
absent-versus-zero again, in the labelling path.

**Proposed shape** **[PROPOSED; three choices in it, §11 C1–C3]:**
1. **The cut is the seal.** When a bucket seals under §4, a customer turn in
   it with no label, no `abstained` and no `classifier_down` is a failure. No
   new configuration. The declared lag is already the channel saying
   "everything for this bucket has arrived by now", and a label is part of
   everything. Sealed keeps meaning complete.
2. **The failure is its own `metric_id`, `label_missing`** (name
   **[PROPOSED]**), `actor_type = 'user'`, degenerate like the other two
   (§6.1). It is not `classifier_down`. At the cut we know the label never
   came, not why: a provider timeout, a lost message, the drone down.
   `classifier_down` asserts a cause. As a metric it takes a threshold and a
   response with no new machinery, which is how a provider outage on chat
   becomes an alert.
3. **A label that arrives after the cut is a late event** (§3). It triggers a
   rebuild, which moves the turn from `label_missing` to its state. Alerts
   already fired stay as they fired (D-12).

**What it buys.** At seal, every customer turn on a channel that declares
`orga_conversation` is in exactly one of: the five states, `abstained`,
`classifier_down`, `label_missing`. Those add up to the true denominator, the
`session_count` of §6.1. A guard asserts it at write time (§10). A missing
label can no longer be silently absent.

**Where the cut does not apply.**
- A channel whose lag is NULL never seals, so it never cuts (O1). A missing
  label there stays lag, and the channel shows "lag not declared".
- A channel that does not declare `orga_conversation` expects no label.
  Nothing is missing; it is not configured (§5). Febor voice is this case
  today.

## 5 · Absent, zero, not configured

Three states, and the product renders each differently:

| State | Meaning | How it is known |
|---|---|---|
| **Not configured** | The channel has no instrumentation, or no declaration, that could produce this | No `channel_capabilities` row for the class (§9.1), or a required declaration is NULL (§9.2). D-14's third state |
| **Not observed** | It could, and nothing reached us | Capability present, no row |
| **Observed, none** | It could, it was alive, and nothing happened | A row with a zero |

The feeder must never write a zero it did not observe, and must write one when
it did.

**Liveness comes from `health_uptime`** (ruled 11 Nov, Q9, refining 0.2 Q4).
- An uptime probe is the instrumentation that emits on a timer whether or not a
  customer showed up. A `proj_channel_health` row with `observed = true` comes
  from it.
- A channel that declares APM latency but no uptime probe can say how slow it
  was when used. It cannot say it was alive at three in the morning, so it is
  **not configured for liveness** even while it declares health.
- Each health component renders *not configured* on its own when its
  capability is missing (§6.4).

§5, D-14 and `channel_capabilities` are one mechanism, not three (Relevo task 10, 10 Nov).

Derived figures that are absent rather than zero by ruling:
- ORGA when no selected channel carries a customer turn (Relevo task 8, D-17).
- MECA when no selected channel declares `meca_rum` (FR-32, FR-35).
- `hallucinations` ("Unfounded claims") until a ground truth exists (§6.1).
- `abandoned` on a channel with no idle bound: it renders **not configured**
  (§9.2). `abandoned_in_queue` is not affected (12 Nov, O3).

One more state is about alerting, not figures: a channel whose lag is NULL
renders its figures and is marked **"lag not declared"**, because nothing on
it is evaluated (§4, O1).

The em dash in the Slice 7 roster means **off shift** (Relevo task 10), a
fourth rendering that belongs to the roster rather than to this contract.

## 6 · The eight tables

**Names: Migration Order step 14, with one rename (11 Nov, Q3).**

- `proj_metric_counts`
- `proj_sentiment`
- `proj_durations`
- `proj_channel_health`
- `proj_rum_signals`
- `proj_actor_metrics`
- `proj_detections`
- `proj_deliveries`

The Migration Order's `proj_response_time` is now `proj_durations`, because a
table named after one of its two contents is how meaning drifts. Today that is
one line here, since the "exactly eight" guard reads the names from this file.
Once anything is built, it would be a migration. §3.3's opening line says "all
six"; there are eight.

**Columns: Handoff §3.3, except where a later ruling supersedes it.**

| # | Table | §3.3 says | The contract carries | Ruling |
|---|---|---|---|---|
| S1 | `proj_durations` | `proj_response_time`, `sketch BYTEA` (t-digest), no min/max | OTel exponential histogram, `n`, `sum_ms`, `min_ms`, `max_ms`; `measure` in the key; renamed | C-15; note 1; 11 Nov Q3 |
| S2 | `proj_channel_health` | `latency_p50_ms`, `latency_p95_ms` | The same histogram shape as S1 | Note 2 |
| S3 | `proj_channel_health` | `health_pct`, `error_rate`, `uptime_pct` | Dropped. `error_n`/`request_n` and `uptime_seconds`/`observed_seconds` instead. Status derived at read time | 10 Nov; 11 Nov Q10 |
| S4 | four tables | — | Added: `identity_rung_at_interaction` and `actor_type` on §6.6; `closing_count` on §6.2; new `metric_id` values on §6.1 and §6.6 | Note 3; 11 Nov Q6–Q8 |
| S5 | prose | `member` | `actor_type` value is `'user'`, as the schema says | Note 4 |
| S6 | `proj_actor_metrics` | `handled_count`; `metric_id` unconstrained | Column dropped; `handled` is a reserved `metric_id`; `metric_id` takes a CHECK | 11 Nov Q8 |

All eight tables live in schema `bob` and are `PARTITION BY RANGE`. `actor_type`
is `TEXT CHECK (actor_type IN ('user','asa','human','arep'))`, the set
`actors` and `channel_actor_mix` use. BObee is not an actor type
(Relevo task 10, point 8).

Below, "provenance" means the three columns of §4. On the six bucketed tables,
it also means `sealed` and the grain CHECK of §3. Lines marked `-- 0.4` differ
from 0.3, and lines marked `-- 0.5` differ from 0.4.

### 6.1 `proj_metric_counts` — the metrics, by actor type

```sql
CREATE TABLE bob.proj_metric_counts (
  org_id        UUID        NOT NULL,
  channel_id    UUID        NOT NULL REFERENCES channels(id),
  actor_type    TEXT        NOT NULL
                CHECK (actor_type IN ('user','asa','human','arep')),
  metric_id     TEXT        NOT NULL
                CHECK (metric_id IN ('resolved','abandoned','abandoned_in_queue', -- 0.4
                       'disambiguation','escalations','hallucinations',
                       'abstained','classifier_down',                            -- 0.4
                       'label_missing')),                     -- 0.5, §4.1 C2
  bucket_start  TIMESTAMPTZ NOT NULL,
  event_count   BIGINT      NOT NULL DEFAULT 0,
  session_count BIGINT      NOT NULL DEFAULT 0,   -- denominator
  -- 0.4: these metrics have one possible actor, by definition
  CONSTRAINT proj_metric_counts_degenerate_actor
    CHECK (metric_id NOT IN ('abandoned_in_queue','abstained','classifier_down',
                             'label_missing')                 -- 0.5, §4.1 C2
           OR actor_type = 'user'),
  -- sealed + provenance
  PRIMARY KEY (org_id, channel_id, actor_type, metric_id, bucket_start)
) PARTITION BY RANGE (bucket_start);
```

**Attribution (D-03, 10 Nov; abandonment rewritten 11 Nov, Q4).**
- **For the four metrics that count something an actor did**, the metric
  attributes to the actor that produced the event it counts.
- **`abandoned` counts something an actor did not do.** It attributes to the
  **side that owed the next turn**.

| `metric_id` | Attributed to |
|---|---|
| `resolved` | the actor that produced the resolution |
| `escalations` | the actor that escalated |
| `disambiguation` | the actor that had to disambiguate |
| `hallucinations` | the actor that made the unfounded claim |
| `abandoned` | the side that owed the next turn. Last turn the customer's, nobody replied: the agent or ASA holding. Last turn the business's, no reply came: `user` |
| `abandoned_in_queue` | `user`, always (degenerate) |
| `abstained`, `classifier_down` | `user`, always (degenerate) |
| `label_missing` | `user`, always (degenerate). Proposed in 0.5 (§4.1) |

- **D-03's original wording for `abandoned` is superseded.** "The actor holding
  the interaction when the customer left" named a bystander. It would have filed
  every customer-side abandonment against the agent who happened to be there,
  and erased the split Q3 exists for ("abandoned — Users 80%, Human Agent 20%").
  The rule is mechanically decidable from the last turn, in all three detections
  (§6.3).
- **One interaction can produce several metrics with different owners.** An ASA
  that carries a conversation and hands off records one `escalations`. The
  human who closes it records one `resolved`. That is not double-counting.
  Counting one metric for two actors is not allowed: it would make the
  denominator count touches, not interactions.
- **The hundred-percent rule holds by construction.** Each metric renormalises
  within itself over the actor types present (§3.3's window function), so the
  new values change nothing in FR-10 to FR-14.

**`abandoned_in_queue`** (11 Nov, Q4). Nobody ever answered: the customer left
while queued. `abandoned` means a conversation died mid-flight, which is a
conversation problem. `abandoned_in_queue` is a staffing problem. Keeping them
apart keeps visible the one a manager can act on.
- Nobody else was present, so the actor dimension is degenerate by definition.
  The CHECK above makes that a constraint, and a test asserts it (§10).
- It replaces 0.3's "attributes to nobody", which left the most actionable
  abandonment with no row at all.

**`abstained` and `classifier_down`** (11 Nov, Q6; abstained is A-12). They are
customer turns the classifier failed to label:
- `abstained`: the classifier read the turn and declined to label it.
- `classifier_down`: the classifier was not running.

`actor_type = 'user'`, degenerate, by the same constraint.
- They are **not** sentiment states: a sixth state would let FR-30 count it.
- Their `session_count` carries the **true denominator**, all customer turns in
  the bucket. That is what makes D-17's "340 of 1,200 customer turns were angry"
  computable. Summing `reading_count` over the five states counts only labelled
  turns, which leaves out the abstentions this exists to show.
- As metrics they take a threshold and a response with no new machinery. The
  abstention rate is the instrument for tuning the classifier's confidence bar.

**`label_missing`** (proposed in 0.5, §4.1). A customer turn still unlabelled
when its bucket seals: the label never came, cause unknown. Kept apart from
`classifier_down`, which asserts the cause, so that transport failures do not
pollute the figures used to tune the classifier. With it, the five states plus
the three failure values account for every customer turn at seal.

**`resolved`, for v1, means closed without escalation** (Relevo task 12, D-15).
It is conversation grain and lands at the conversation's close (§3). "No
re-contact within N hours" is deferred to v1.1.

**`hallucinations` applies to all four actor types** (10 Nov).
- The stored `metric_id` stays `hallucinations`. It is **displayed as
  "Unfounded claims"**.
- Detection needs D-29's knowledge notes, which ship empty in v1, so this row
  renders absent longer than the others.

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
  closing_count BIGINT      NOT NULL DEFAULT 0,                        -- 0.4
  -- 0.4: MECA has no conversation close
  CONSTRAINT proj_sentiment_closing_is_orga
    CHECK (source = 'orga' OR closing_count = 0),
  -- sealed + provenance
  PRIMARY KEY (org_id, channel_id, source, state, bucket_start)
) PARTITION BY RANGE (bucket_start);
```

- **Two sources and five states**, as §3.3 declares. ORGA and MECA are separate
  rows. The blend is computed at read time from the configured mechanical
  weight, so changing the weight re-renders history instead of invalidating it.
  Counts, not percentages (PR-1).
- One ORGA reading is one customer speaker turn, and agent turns produce none
  (D-17). ORGA on WhatsApp/YCloud comes from the local classifier (D51). Voice
  stays absent until the two sides arrive separately.
- **`closing_count`** (11 Nov, Q7) is how many conversations **closed** on this
  state. `reading_count` is how many turns were in it. Same key, no repeat, no
  new table.
  - It is stored per state as counts and never as a sum: the five states are
    ordinal, and a sum of them is not a state of anything.
  - It is populated for `source = 'orga'` only. The CHECK above says so, and a
    test asserts it (§10).
  - It lands at the conversation's close (§3). Closing sentiment is a weight
    beside `resolved`, never a confirmation, and no blended resolution score is
    computed from the two (D-15).
- The abstained and classifier-down counts are not here. They are `metric_id`s in
  §6.1.

### 6.3 `proj_durations` — distributions, not averages (S1)

```sql
CREATE TABLE bob.proj_durations (                                        -- 0.4, renamed
  org_id          UUID        NOT NULL,
  channel_id      UUID        NOT NULL REFERENCES channels(id),
  actor_type      TEXT        NOT NULL
                  CHECK (actor_type IN ('user','asa','human','arep')),
  measure         TEXT        NOT NULL                                   -- 0.4
                  CHECK (measure IN ('response_time','interaction_duration')),
  bucket_start    TIMESTAMPTZ NOT NULL,
  n               BIGINT      NOT NULL,           -- exact count
  sum_ms          BIGINT      NOT NULL,           -- exact mean on recombine
  min_ms          BIGINT,
  max_ms          BIGINT,
  hist_scale      SMALLINT    NOT NULL DEFAULT 4,
  hist_offset     INTEGER     NOT NULL,           -- index of first populated bucket
  hist_counts     BIGINT[]    NOT NULL DEFAULT '{}',
  hist_zero_count BIGINT      NOT NULL DEFAULT 0,
  -- 0.5: a conversation's length belongs to the conversation (O2)
  CONSTRAINT proj_durations_interaction_is_user
    CHECK (measure <> 'interaction_duration' OR actor_type = 'user'),
  -- sealed + provenance
  PRIMARY KEY (org_id, channel_id, actor_type, measure, bucket_start)    -- 0.4
) PARTITION BY RANGE (bucket_start);
```

`hist_scale` is stored per row and is **not** constrained to 4. Rows at
different scales are down-scaled by powers of two before merging. Merge: align
by `hist_offset`, add counts. Percentiles are read by walking buckets. **No
stored percentile, ever.**

**Never merged across `actor_type` or across `measure`** (0.2 Q3; extended
11 Nov, Q3). The histogram merges freely across channels and time.
- Merging agent speed with customer think-time produces a figure describing
  nobody.
- Merging a response time with a conversation's duration does the same: both
  are milliseconds.

A test enforces this, not this sentence (§10).

**`measure = 'response_time'`** (0.2 Q3):
- **The window rule.** A window is opened by a turn and closed by the first
  turn from the other side after it. Consecutive turns from the same side move
  the opening to the latest of them. Three customer messages at 10:00, 10:02 and
  10:04, answered at 10:10, are a six-minute response.
- **Both directions, attributed to whoever responded.** An agent asks at 10:00
  and the customer answers at 10:17: seventeen minutes, `actor_type = 'user'`.
- **It lands in the bucket of its closing turn.** An open window contributes
  nothing until it closes.
- **A gap is a response time or an abandonment, never both.** If the reply comes,
  however late, it is a response time. If it never comes, it converts to
  `abandoned` (§6.1).
- **Three detections.** An abandonment is detected one of three ways:
  - **explicit**: the ASA closes the conversation on its own timer;
  - **superseded**: a new conversation starts while this one is open;
  - **idle**: no activity past the channel's idle bound (§9.2).

  All three land at the conversation's last activity (§3) and attribute to the
  side that owed the next turn (§6.1).
- **Request-to-response latency is not this measure.** It is technical latency,
  and it lives in `proj_channel_health`.

**`measure = 'interaction_duration'`** (11 Nov, Q3). The length of an interaction,
as a distribution.
- **FR-22** reads it. User availability gets a distribution instead of the
  average it asked for, and `bob_availability_user`'s average duration is
  `sum_ms / n` over it. The drill-down gets conversation length for nothing.
- It is conversation grain and lands at the conversation's close (§3).
- **Its rows always carry `actor_type = 'user'`** (12 Nov, O2). A
  conversation's duration is a property of the conversation, not of an actor.
  The customer is the only actor present for the whole of it; every other actor
  is present for part.
  - Splitting it as per-actor held time would need a sum across `actor_type`
    to recover the conversation's length, which the never-merge rule forbids.
    Taking the quantity that needs no exemption keeps the rule whole.
  - This is the third degenerate actor, after `abandoned_in_queue` and the
    classifier counts. Same treatment: the CHECK above, and a test that the
    value never varies (§10).
  - If per-actor held time is wanted later, it is **a different `measure` with
    its own name**, never a reinterpretation of this one.
- It replaces 0.2's `duration_ms_sum` and `duration_n` on `proj_metric_counts`.
  Those repeated the same two numbers on every metric row, the same defect as
  `handled_count` (§6.6).

### 6.4 `proj_channel_health` — components, no derived figure (S2, S3)

```sql
CREATE TABLE bob.proj_channel_health (
  org_id                  UUID        NOT NULL,
  channel_id              UUID        NOT NULL REFERENCES channels(id),
  bucket_start            TIMESTAMPTZ NOT NULL,
  -- latency: same shape as proj_durations; health_latency
  latency_n               BIGINT      NOT NULL DEFAULT 0,
  latency_sum_ms          BIGINT      NOT NULL DEFAULT 0,
  latency_min_ms          BIGINT,
  latency_max_ms          BIGINT,
  latency_hist_scale      SMALLINT    NOT NULL DEFAULT 4,
  latency_hist_offset     INTEGER     NOT NULL DEFAULT 0,
  latency_hist_counts     BIGINT[]    NOT NULL DEFAULT '{}',
  latency_hist_zero_count BIGINT      NOT NULL DEFAULT 0,
  -- errors: health_errors                                             -- 0.4
  error_n                 BIGINT      NOT NULL DEFAULT 0,
  request_n               BIGINT      NOT NULL DEFAULT 0,
  -- uptime: health_uptime                                             -- 0.4
  uptime_seconds          BIGINT      NOT NULL DEFAULT 0,
  observed_seconds        BIGINT      NOT NULL DEFAULT 0,
  -- disconnects: health_disconnects
  disconnects             INTEGER,
  observed                BOOLEAN     NOT NULL DEFAULT true,   -- PR-10
  -- sealed + provenance
  PRIMARY KEY (org_id, channel_id, bucket_start)
) PARTITION BY RANGE (bucket_start);
```

**`proj_channel_health` stores no derived figure at all** (11 Nov, Q10). It is the
third time the same reasoning lands on this table:
- percentiles became a histogram (note 2);
- `health_pct` was dropped (10 Nov);
- `error_rate` and `uptime_pct` became numerator and denominator.

An error rate is `sum(error_n) / sum(request_n)` over the selection, and an
uptime is `sum(uptime_seconds) / sum(observed_seconds)`. Both are computed at
read time, weighted correctly by construction. The `latency_` prefix is this
draft's **[PROPOSED]**; the shape is ruled.

- **Standard instrumentation, not ours** (note 2):
  - APM and browser or mobile agents for digital properties;
  - API-level measurement and synthetic probes for channels reached over an
    API.

  OTel's standard shape for a duration is already a histogram.
- **Channel status is derived at read time as the worst breaching component**
  (10 Nov). A threshold colours the display whether or not a response is
  attached (Relevo task 9). Nothing new is stored, and BOb still writes no
  projection. How many display states that produces is a Slice 7 question.
- **For an API-mediated channel, health is the health of our integration**, not
  of the provider's product. A red WhatsApp channel means our calls to Meta are
  failing or slow.
- **Each component has its own capability** (§9.1): `health_latency`,
  `health_errors`, `health_uptime`, `health_disconnects`. A component whose
  capability is absent renders **not configured**, not "not observed". An API
  channel has no disconnects at all.
- A row with `observed = true` comes from `health_uptime` (§5). RS-06 reads this
  table for channel health as it stood when an alert fired.

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

Verbatim from §3.3. Replaces `rum_events`. A channel that does not declare
`meca_rum` (§9.1) has no rows, and MECA renders absent (FR-35).

### 6.6 `proj_actor_metrics` — per actor

```sql
CREATE TABLE bob.proj_actor_metrics (
  org_id        UUID        NOT NULL,
  actor_id      UUID        NOT NULL,
  actor_type    TEXT        NOT NULL                                   -- 0.4, denormalised
                CHECK (actor_type IN ('user','asa','human','arep')),
  channel_id    UUID        NOT NULL REFERENCES channels(id),
  metric_id     TEXT        NOT NULL                                   -- 0.4, CHECK
                CHECK (metric_id IN ('resolved','abandoned','disambiguation',
                       'escalations','hallucinations','handled')),
  identity_rung_at_interaction TEXT NOT NULL
                CHECK (identity_rung_at_interaction IN
                       ('identified','ghost','guest','inferred',
                        'not_applicable')),                             -- 0.4
  bucket_start  TIMESTAMPTZ NOT NULL,
  event_count   BIGINT      NOT NULL DEFAULT 0,
  -- handled_count: dropped; metric_id = 'handled' carries it          -- 0.4
  -- 0.4: the rung is a member's; nobody else has one
  CONSTRAINT proj_actor_metrics_rung_pairs_with_type
    CHECK ((actor_type = 'user') = (identity_rung_at_interaction <> 'not_applicable')),
  -- 0.4: the denormalised type must be the actor's own
  FOREIGN KEY (actor_id, actor_type) REFERENCES actors (id, actor_type),
  -- sealed + provenance
  PRIMARY KEY (org_id, actor_id, channel_id, metric_id,
               identity_rung_at_interaction, bucket_start)
) PARTITION BY RANGE (bucket_start);
```

**Ruled 11 Nov, Q8.** The exact DDL above is this draft's; what is ruled is listed
below.

- **(a) The rung stays in the key, and its pairing with `actor_type` is a
  constraint, not a convention.**
  - The rung is right for member rows and impossible for the others: a human
    agent or an ASA has no identity rung, and a primary-key column cannot be
    NULL. So non-member rows carry the declared value `'not_applicable'`
    (chosen in 0.4, accepted 12 Nov).
  - The CHECK asserts that `user` rows never carry it and non-`user` rows always
    do. That needs `actor_type` on the row.
  - The composite foreign key keeps the denormalised type equal to the actor's.
    It needs `UNIQUE (id, actor_type)` on `actors`, added in the Slice 2
    migration that already touches `actors` (§9.3). Accepted 12 Nov: the
    foreign key makes the pairing unforgeable, not merely checked.
- **(b) `handled_count` is dropped.** Keyed by `metric_id`, it repeated on every
  metric row of an actor. It becomes the reserved **`metric_id = 'handled'`**
  (name chosen in 0.4, accepted 12 Nov), whose `event_count` is the number of interactions the
  actor touched, whatever happened. That gives one row per actor, channel, rung
  and bucket. "Read it as the maximum" would have been a rule enforced by
  documentation.
- **(c) `metric_id` takes a CHECK:** the five of §6.1 plus `handled`. §3.3 leaving
  it unconstrained was an omission, not a decision.

`event_count` follows §6.1's attribution. This table is unblocked by D-03, and
so are CF-12 and the Slice 7 per-agent columns.

**`identity_rung_at_interaction`** (D-12) keeps a member's rung as it was when the
interaction happened, beside the actor it now points to. It is derived from the
linkage history as of event time (§9.4), never from the actor's current rung.
Otherwise the first rebuild after a merge turns every pre-authentication rung
into `identified` while the rebuild test still passes.

**Linkage reaches only this table.** A ghost and an identified member are both
`actor_type = 'user'`, so `proj_metric_counts` and FR-10 to FR-14 are unchanged
by a merge (D-12).

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
loop; unnamed patterns arrive here. `correlation_id` here is what lets
`affected_members` filter by `detection_id` (§7.3).

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

- Verbatim from §3.3.
- **`correlation_id` here is deliberate, and it carries weight** (11 Nov, Q2).
  - Slice 8 must answer the chain from condition to alert to action to outcome
    in one query, and this column is that join.
  - Nobody removes it to match the six bucketed tables.
- Provider accounts belong to the customer. So this row, with `provider_ref`, is
  the answer when a customer says an alert never arrived.
- `outbound_queue` (Handoff Part 4) is not in the migration chain yet, so
  `outbound_id` is not a foreign key in Slice 2.
- AutoBotz execution is not enabled before Slice 8 (Relevo task 6, 4 Nov).

## 7 · Correlation, identity and the drill-through

### 7.1 Whose identifiers

`correlation_id` and `entity_id` are BzzzBX's (C-11). BOb never mints one.
**C-11 is about ownership, not presence** (11 Nov, Q2).

- `miembro.id` is BzzzBX's too: a salted hash computed at source (D47), held in
  `business_events.attributes['miembro.id']`, not in `entity_id`. No connector
  sets `entity_id`.
- **`correlation_id`** is how the feeder counts an interaction once, opens and
  closes duration windows (§6.3), and orders turns.
  - It is a column on the two event-grained tables (§6.7, §6.8).
  - On the six aggregate tables the aggregate lands in BOb and the identifier
    stays in ClickHouse.
- **`entity_id`** appears in no projection.

### 7.2 Resolving an external identifier to an actor

An actor's external identifiers live in **`actor_external_refs (org_id,
actor_id, ref)`, with `(org_id, ref)` UNIQUE** (Relevo task 13, 10 Nov). See §9.3.

| Actor type | `ref` | How it is obtained | Authority for "these refs are one actor" |
|---|---|---|---|
| `user` | `m:…`, the `miembro.id` | **Computed** (D47) | The customer's member record |
| `human` | `<source_key>:<external id>` | **Mapped**; namespace from `channels.source_key` | The customer's staff directory |
| `asa` | `<platform>:<deployment id>` | **Mapped**; namespace is the platform declared on the deployment record (11 Nov, Q14) | The customer's deployment record |
| `arep` | Inherits the ASA shape when it exists | | |

- **Namespaces are never typed** (11 Nov, Q14).
  - An agent's namespace is discovered from `channels.source_key`.
  - An ASA's is authored on its deployment record, because there is nothing to
    discover it from. `actors.provider`, the ASA-only column that exists today,
    is the source (chosen in 0.4, accepted 12 Nov).
  - No code path contains a namespace literal, and a guard asserts it (§10).
  - Deployment 42 on two platforms is two deployments, the same argument as PBX
    42 against Zendesk 42.
- **No source registry in Slice 2** (Q14). If a staff directory becomes a
  source later, the refs that re-key are agents and ASAs, tens of rows. Member
  refs are `m:` hashes and are untouched. The guard above is what keeps that
  deferral safe.
- **BOb never infers a link from similarity.**

**Two routes, never one** (12 Nov, O4). 0.4 sent two different failures down
one sentence and both to §8.6. That is how the Q12/Q13 collision survived two
readings. They differ in one fact: whether the event has an `org_id`.

| | Route A · an unmapped event | Route B · an unresolved actor ref |
|---|---|---|
| What failed | `(tenant_slug, source_key)` did not resolve (§2) | The event mapped; its actor ref resolved to no actor |
| `org_id` | **None.** That is what failed | **Known**, and so is the channel |
| Is the event projected? | No | **Yes.** It counts in §6.1 under its actor type, and is absent from §6.6 until the ref resolves |
| Where it goes | Counted and returned by the feeder (§8.6); the bus in Slice 8 | Splits by actor type, below |
| Ruling | 0.2 Q6; 11 Nov, Q12, unchanged | 11 Nov, Q13; 12 Nov, O4 |

Route A's arithmetic (no `org_id`, so no tenant-scoped table) is what ruled out
a ninth projection. It never applied to route B.

**Route B splits by actor type** (11 Nov, Q13):

| Actor type | Meaning | What happens |
|---|---|---|
| `human`, `asa` | A configuration error: the person or deployment is in the customer's record and we failed to map it | Emitted, **never** an actor. Creating one would paper over the error and corrupt the roster. Until the bus, the feeder counts these apart from route A (§8.6) |
| `user` | Normal: someone contacted the business who is not a registered customer. The majority case | It is a **ghost** and gets an actor at rung `ghost`, created by the reconciliation below |

**The ghost reconciliation does its own discovery** (12 Nov, O4).
- It runs **as `bob_app`**, on a schedule, over a window: it asks the truth
  store which member refs (`m:…`) were seen in the window, and creates a ghost
  for each one that resolves to no actor in `actor_external_refs`.
- "Resolves to no actor" is decided on BOb's side. BzzzBX never knows a BOb
  actor (§1), so the truth store returns refs seen and BOb subtracts the refs
  it knows.
- The question goes through a named interface, `member_refs_seen(frame)`
  (name and shape **[PROPOSED]**, §7.3a), so BOb still never knows which truth
  store it runs against.
- **No new table. No change to the feeder's grants. No dependence on Slice 8's
  bus.** With the bus as the source there would be no ghosts for most of v1,
  which guts the member drill-down ghosts were ruled to serve.
- The window starts where the last run ended, bounded by retention (C-14)
  **[PROPOSED]**.

What stays from 0.4:
- **The feeder still never creates an actor.** It stays read-only on `actors`.
  A guard asserts that the reconciliation can never produce a non-`user` actor
  (§10).
- **Ghost creation is a linkage event.** It triggers D-12's bounded rebuild
  (§8.5), which fills the `proj_actor_metrics` rows that were absent while the
  ref resolved to nothing. No new mechanism is needed.
- **The identified-to-ghost ratio is the product-visible signal** a normalisation
  defect now shows up in (for example, non-E.164 phones: Henry's count of 482 pbx
  refs and 1,547 YCloud refs at Febor, none in common, cited 11 Nov, Q13). The unresolved *agent* count stays the
  operational one.
- Today a human agent is identifiable on voice only, because there is no agent
  on WhatsApp events. The table shows that as an absent mapping.

### 7.3 `affected_members(frame, filter)` — the drill-through (A-11)

"Who was affected" is answered by a **drill-through to the truth store, named
here as part of the contract**, not by per-member projection rows (A-11, ruled
10 Nov). Per-member rows at five-minute grain approach interaction grain, which
A-06 and D-30 left in the truth store. Because the interface is named in the
contract, the application still never knows which truth store it runs against.

- **`frame`**: `tenant_slug`, `source_key`(s), and a window `[from, to)` no
  longer than retention, the same frame §7.5 uses.
- **`filter` speaks the cell's language** (11 Nov, Q15). It takes:
  - **`metric_id`**, resolved through the **feeder's own event mapping**;
  - optionally **`actor_type`**;
  - optionally **`detection_id`**, answerable through `proj_detections.correlation_id`.

  It never takes an `event_name`. If the filter carried its own idea of which
  events count, the drill-through could disagree with the number it drills into:
  click 47, get 52 names. **One definition, two consumers.** Whatever the feeder
  uses to decide an event is an `abandoned` is what `affected_members` uses.
- **Output, two kinds of thing and never one:**
  1. **Members as rows.** One row per member per interaction:
     - `external_ref` (`m:…`)
     - `correlation_id`
     - `first_seen`
     - `last_seen`
     - `n_events`

     The rows are paged. BOb aggregates them to one line per member and resolves
     `m:…` through §7.2.
  2. **Anonymous traffic as a count.** The number of distinct `correlation_id`s
     in the frame and filter with no `miembro.id`. It counts **interactions,
     not visitors.**
- The panel reads, for example: "47 members affected, and 23 interactions with
  no identified member".
- **The count-equality test is the whole guarantee.** The drill-through's member
  count plus its anonymous count equals the cell's count for the same frame. It
  is seen failing first (§10).
- **The unit is interactions, on both sides** (12 Nov, O5). Member interaction
  rows plus anonymous interactions equals the cell's interaction count. It is
  the only unit that balances: distinct members plus anonymous interactions
  does not, because one member has several interactions.
- **The panel shows a different number on purpose.** "47 members affected" is
  **distinct members**; the test balances **interactions**. Both are correct and
  they are not meant to agree. Written here so that the first person to check
  47 against the cell does not report a bug that is not there, and nobody
  "fixes" it.
- **A third deliverable** (11 Nov, Q15), not a mode of the evidence packages.
  The two are different shapes: a lookup by a known key, against a query that
  returns a set. The count-equality test also needs this one independently
  callable.
- **Pseudonyms only.** BzzzBX never learns a name. Turning `m:…` into a person
  is BOb's job, under ID-04 (Slice 8).
- **No ghost key for anonymous visitors.** D47 stays as signed.
- **Cost on the ClickHouse side** (Henry, 6 Nov, estimated, not measured):
  - a windowed query prunes on `business_events`' primary key and is cheap;
  - one member's whole history reads the attributes map for the window. A
    materialised `miembro_id` column with a bloom-filter index is the BzzzBX fix
    if it hurts.

### 7.3a `member_refs_seen(frame)` — what the ghost reconciliation reads **[PROPOSED]**

New in 0.5, for O4. Federico ruled that the reconciliation does a windowed
query against the truth store and "reuses the affected_members shape". This
draft names it as its own interface:

- **`frame`**: `tenant_slug`, `source_key`(s), and a window `[from, to)`, as in
  §7.3.
- **Output**: one row per distinct member ref seen in the frame:
  `external_ref` (`m:…`), `first_seen`, `last_seen`. Paged. No
  `correlation_id`, no counts: the reconciliation needs to know a ref exists,
  not what it did.
- **Pseudonyms only**, as in §7.3.

Why not `affected_members` with the filter left out: Q15 ruled against one
endpoint with two behaviours, because half its parameters become meaningless in
one of them, and the count-equality test has no cell to balance against here.
The alternative is open as §11 O6.

### 7.4 What the feeder reads from BOb

Exactly two views. Anything more is a finding about this contract.

- **`v_feeder_channel_map`** (exists): `channel_id`, `org_id`, `tenant_slug`,
  `source_key`, `lag_seconds`, `adapter_kind`. It gains `idle_bound_seconds`
  (§9.2).
- **`v_feeder_actor_map`** **[PROPOSED]**: `org_id`, `ref`, `actor_id`,
  `actor_type`, and the linkage history of §9.4 (`identity_rung`, `valid_from`,
  `valid_to`).
  - From these the feeder derives the actor and the rung as of an event's time.
  - It carries no `display_name` and no `display_id`: the feeder never sees a
    name.

### 7.5 Evidence is not a projection

3.7's evidence packages by `correlation_id` and `entity_id` are the platform's
surface. A BOb cell reaches them through its frame (`tenant_slug`,
`source_key`, bucket window, `external_ref`), which is a query key into BzzzBX,
not a BOb table.

So 3.7 delivers things that do not merge:
- the eight tables;
- the evidence packages;
- `affected_members`;
- `member_refs_seen`, if §11 O6 keeps it separate.

## 8 · The feeder's obligations

1. **Fill every table at declared grain.**
   - Bucketed tables are written on five-minute UTC boundaries; the CHECK in §3
     refuses anything else.
   - Event-grained tables carry their event time.
   - Buckets are assigned by event time, and each measure lands where §3 says.
2. **Idempotent on the primary key.** An upsert on the projection primary key.
   Replaying a window changes nothing but `computed_at`.
3. **Advance a watermark and seal only behind it.**
   - The watermark travels on the rows as `source_watermark`, read back as its
     maximum per tenant and table. A watermark table written by `bob_feeder`
     would be a ninth projection to the F-18 guard.
   - `sealed` is set only by the rule in §4, with the declared lag, and is
     checked when it is written.
   - **Sealed means complete, not immutable.**
4. **Stamp `feeder_version`** on every row it writes.
5. **Rebuild an arbitrary window on demand.** The same query over a different
   range: for `(org_id, [from, to))`, delete and refill. Three things trigger
   one:
   - **A linkage** (D-12), ghost creation included (§7.2).
     - The window is `[earliest interaction attributable to the linked
       identity, now)`, bounded by retention (C-14).
     - It runs in the background, bounded, never synchronously with a login.
     - Attribution is re-derived from the linkage history as of each event's
       time (§9.4).
   - **A late event** behind the seal (§3).
   - **An abandonment detected behind the seal**, which is the usual case for
     idle detection (§3).

   **Alerts already fired are not re-evaluated** (D-12).

   The rebuild test truncates every projection, re-runs the feeder, and asserts
   the application renders identically. One case of it has a linkage inside the
   window (§10).
6. **Create the partition it writes into, and account for what it cannot map.**
   - Partitions go through the one function of §3: create, grant, RLS.
   - What it cannot map is emitted to the bus, as audit is under X-10. That
     covers §7.2's route A (an unresolved tenant or channel) and the agent and
     ASA half of route B (a ref with no actor). An unresolved **member** ref is
     neither: it is normal, it is projected, and the reconciliation finds it
     on its own (§7.2). The feeder does not report it.
   - **Until the bus exists (Slice 8), the reference feeder counts per run and
     returns the counts** (11 Nov, Q12). **Two counts, never one sum**
     **[PROPOSED]**: unmapped events (route A) and unresolved agent and ASA refs
     (route B). One is an event we dropped; the other is an event we projected
     with a roster gap. A single number would send both down one path again
     (O4). A non-zero run reports them, and a test asserts both are zero
     against the fixture (§10). Nothing is stored: a ninth projection breaks the
     count of eight, and a non-tenant table of unresolved customer data is worse
     than the problem.
   - The requirement is that nobody can believe the feeder processed everything
     when it did not. The interim is tied to a test, not a log, so it cannot
     quietly become permanent. §11 names what supersedes it.

The recommended shape (System Flows §3) is a scheduled ClickHouse query on a
timer, not a stream: idempotency comes from the upsert, and rebuild is the same
query with a different range.

## 9 · Configuration the contract depends on

Configuration, not projection: authored in BOb, written by `bob_app`, backed up,
never rebuilt, outside the count of eight and outside PR-4.

### 9.1 `channel_capabilities` (Relevo task 10, 4 Nov; health 11 Nov, Q9)

```sql
channel_capabilities (org_id, channel_id, capability)
  PRIMARY KEY (org_id, channel_id, capability)
```

**A row means this channel can produce this class; no row means it cannot.**
Presence only, with no `enabled` boolean (C-16's reasoning).

| Capability | Declares |
|---|---|
| `orga_conversation` | Customer language to classify |
| `meca_rum` | Interface telemetry |
| `response_time` | Turns from both sides |
| `resolution` | A conversation close |
| `coherence` | The business's own text (deferred, Relevo task 12) |
| `hallucination` | Claims to check against a ground truth |
| `health_latency` | Latency instrumentation (APM, API measurement, probe) |
| `health_errors` | Error and request counts |
| `health_uptime` | A probe emitting on a timer. **The source of liveness** (§5) |
| `health_disconnects` | Disconnect counts |

- **Four health capabilities, not one** (11 Nov, Q9). Health instrumentation
  differs per channel the same way the other classes do:
  - a synthetic probe gives uptime and latency;
  - APM gives latency and errors;
  - an API channel has no disconnects.

  A single `channel_health` would render a missing probe's uptime as *not
  observed* when the truth is *not instrumented*.
- **Declared per channel, never mapped from `channel_type`.** A guard asserts it
  (§10).
- The drill-down reads the union of capabilities across the selected channels.

### 9.2 The per-channel idle bound

```sql
ALTER TABLE channels ADD COLUMN idle_bound_seconds INTEGER
  CHECK (idle_bound_seconds IS NULL OR idle_bound_seconds > 0);
```

Exposed to the feeder through `v_feeder_channel_map`.

- **Why it lives on `channels`.** It is per channel and never a constant in the
  feeder (0.2 Q3). It sits beside `lag_seconds`, where the feeder already reads
  per-channel declarations, so it needs no third view. It is not in
  `channel_capabilities`, because a number there is the `enabled` column C-16
  refused. Placed in 0.3; not disputed in the 11 Nov round.
- **NULL: refuse the metric, not the channel** (11 Nov, Q11).
  - The channel projects normally, and **`abandoned` alone renders not
    configured**.
  - **No `abandoned` rows are written for a channel with no idle bound**, not
    even the explicit and superseded ones. On WhatsApp, where most abandonments
    are idle, a partial count would show twelve when the truth is three hundred:
    a real number, understated by an unknown amount, with nothing saying so.
  - An absent metric is recoverable in a minute by declaring the bound.
  - This is A-04's refuse precedent at the right scope.
- **The refusal does not reach `abandoned_in_queue`** (12 Nov, O3). Q11
  withholds abandonment because idle detection needs the bound. A queue
  abandonment does not use it: the customer ends the interaction before any
  actor takes it, which is an explicit event, not a timeout.
  - Withholding it would be the rule applied by name rather than by reason, and
    it would suppress the staffing signal, the most actionable figure in the
    set.
  - Caveat: on Febor voice this is theory until the call-label problem
    resolves, because the labels that would identify a queue abandonment are
    the ones in question (Relevo tasks 10 and 14).
- **Lag and idle bound: a declared relationship, not a CHECK** (11 Nov, Q5,
  which offered either; chosen in 0.4, accepted 12 Nov).
  - If a channel's `lag_seconds` is shorter than its `idle_bound_seconds`,
    every idle abandonment lands behind the seal and triggers a rebuild. That is
    not wrong, but it is constant churn.
  - A CHECK forcing `lag_seconds >= idle_bound_seconds` would delay evaluation of
    every open bucket on that channel by the idle bound (PR-7). On WhatsApp that
    means hours, which trades churn for blind alerting.
  - So the relationship is declared here, and Slice 2 reports channels where
    lag is below the bound rather than refusing them.

### 9.3 `actor_external_refs` (Relevo task 13, 10 Nov; 11 Nov, Q14)

`actor_external_refs (org_id, actor_id, ref)`, `(org_id, ref)` UNIQUE, indexed
on `ref`, for all four actor types (§7.2).

**`actors.external_ref` is dropped in Slice 2** (11 Nov, Q14). A replaced identity
column kept beside its replacement is two sources of truth for one fact, which
is the defect this table exists to fix. The counter-precedent,
`alerts.acknowledged_at` kept nullable and unread, has no competing replacement
and lives on a partitioned table. `actors` is neither.

The same Slice 2 migration adds `UNIQUE (id, actor_type)` to `actors` for §6.6's
composite key (accepted 12 Nov).

Two more pieces belong to the actor work in Slice 2, not to this contract. They
are named here because a wrong salt fails §7.2 silently:
- BOb's `miembro.id` computation reads BzzzBX's
  `conectores/contratos/miembro/vectores.json`, not a copy.
- The salt is checked by effect: a reserved canary identifier that the feeder
  skips by rule, run at startup and daily (Relevo task 13).

### 9.4 The linkage history **[PROPOSED]**

D-12's rebuild cannot recover the rung at interaction time (§6.6) from
*current* state. So BOb keeps an append-only, dated history:

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
- A linkage, a merge, a ghost creation or a rung change appends a row and never
  updates one.
- `actor_external_refs` is the current state. A guard asserts that, for every
  member ref, it equals the latest history row.

The table holds member refs only, since only members have a rung. Agent and ASA
refs need no history: their `identity_rung_at_interaction` is
`'not_applicable'`, and `v_feeder_actor_map` reads them from
`actor_external_refs` directly.

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
| **No derived figures** | every projection column | No column named like `p\d+`, `percentile`, `median`, `avg`, `mean`, `health_pct`, **`_rate`**, **`_pct`**. With the last two it would have caught `error_rate` and `uptime_pct` by itself (Q10) |
| Provenance | every projection | Carries the three columns of §4, `NOT NULL` |
| **Sealed at write time** | every projection with a `sealed` column | Over the rows the feeder writes in the test run, and only those, every row written with `sealed` satisfies §4's rule **with the channel's declared lag at that moment**. Not a standing scan of history (Q1) |
| Tenant key | every projection | Carries `org_id UUID NOT NULL`, no slug column |
| **Never merged across `actor_type` or `measure`** | every view and function whose definition reads `proj_durations` (`pg_depend`, `pg_proc`) | Structural, in Slice 2: `actor_type` and `measure` are `NOT NULL` and in the primary key. Behavioural: over a fixture with `user` and `human` rows, and with both measures, in one channel and bucket, every discovered reader returns separate distributions. While it discovers zero readers it reports **`todo`, printed and counted in CI**, never `pass` (Q16) |
| Degenerate actor | `proj_metric_counts`, `proj_durations` | A `proj_metric_counts` row with `abandoned_in_queue`, `abstained`, `classifier_down` or `label_missing` and any `actor_type` but `user` is refused. So is a `proj_durations` row with `interaction_duration` and any `actor_type` but `user` (O2) |
| **Every turn accounted at seal** (§4.1, if C1–C3 stand) | the rows the feeder writes with `sealed = true` on channels declaring `orga_conversation` | The five states' `reading_count` plus `abstained`, `classifier_down` and `label_missing` equal the true denominator for the bucket. A turn whose label is withheld in the fixture is seen landing in `label_missing`, and moving to its state on a rebuild once the label arrives |
| **Lag not declared** | every channel with `lag_seconds IS NULL` | The fixture's undeclared channel (`roster.sql:36`) gets rows written and none sealed, and Slice 2's report counts it (O1) |
| Closing is ORGA | `proj_sentiment` | A `meca` row with `closing_count > 0` is refused |
| Rung pairs with type | `proj_actor_metrics` | A `user` row with `'not_applicable'`, a non-`user` row with any other rung, and an `actor_type` that differs from the actor's are each refused |
| Ghost path | the reconciliation of §7.2 | Given agent, ASA and member refs that resolve to nothing, it creates actors for member refs only, all at rung `ghost`, and never a non-`user` actor. It finds them through `member_refs_seen` (§7.3a), with the feeder's counts at zero for member refs |
| No namespace literal | every tracked file (`git ls-files`, as the naming test does) | No code path builds a ref with a literal namespace; namespaces come from `channels.source_key` or the deployment record (Q14) |
| Unmapped is counted, by route | the reference feeder over the fixture | Both returned counts are zero. Then three injections, one at a time: an unmappable event moves only the route A count; an agent ref with no actor moves only the route B count; a member ref with no actor moves neither (Q12, O4) |
| `affected_members` count equality | 3.7's endpoint over a frame | Member interaction rows plus anonymous interactions equal the cell's interaction count for the same frame (Q15, O5). The distinct-member figure the panel shows is not part of the equality |
| Rebuild with linkage | the rebuild test | A linkage inside the rebuilt window leaves `identity_rung_at_interaction` as it was at event time, and the render identical to a full rebuild |
| No capability from channel type | the codebase and the schema | No code path, view, function or seed derives `channel_capabilities` from `channel_type` (Relevo task 10) |

**The never-merge floor is part of A-05b's definition of done** (11 Nov, Q16).
A-05b returns with the first route handler, and the floor that makes the
behavioural half required lands in that same commit. It is not a later
promise.

## 11 · Interim measures, and what is open after 0.5

0.3's sixteen questions are closed (Relevo task 6, 11 Nov). 0.4's five are
closed (12 Nov, 08:23).

### Interim, named so it stays visibly interim

| Interim in Slice 2 | Superseded by | When |
|---|---|---|
| The reference feeder counts unmapped events (route A) and unresolved agent and ASA refs (route B) per run and returns both counts, under a zero-against-fixture test (§8.6) | Emission to the bus, as audit is under X-10 | Slice 8 |
| The never-merge guard's behavioural half reports `todo` (§10) | The floor, in A-05b's commit | The first route handler |
| Retention is not enforced (§3) | `pg_cron` detaching and dropping partitions | Slice 5 |

The ghost reconciliation is **not** interim. It does its own discovery (§7.2)
and does not wait for the bus.

### Closed on 12 Nov

| | Ruling | Where |
|---|---|---|
| O1 | Never seal with NULL lag; rows still written and rendered; "lag not declared"; a count of such channels | §4, §5 |
| O2 | `interaction_duration` is always `user`, degenerate, with a CHECK and a test | §6.3 |
| O3 | Q11's refusal does not reach `abandoned_in_queue` | §9.2 |
| O4 | Two routes; the reconciliation discovers member refs itself, as `bob_app` | §7.2, §8.6 |
| O5 | Interactions on both sides; the panel's distinct-member figure is a different number on purpose | §7.3 |

### Open after 0.5

The D-25 cut (§4.1) is a proposal with three real choices in it. The
recommendation is (a) in each.

- **C1 · Where the cut sits.**
  - (a) **At the seal.** No new configuration; sealed keeps meaning complete.
    The cost: a channel's lag must cover its label path, so a slow label path
    delays that channel's evaluation.
  - (b) A second per-channel declaration, `label_cutoff_seconds >=
    lag_seconds`. A channel could seal its counts early and wait longer for
    labels. But a sealed bucket would then routinely receive labels after the
    seal: "sealed" would mean "complete except labels", which weakens D-12's
    sentence. Between seal and cut a turn would be in a sixth condition,
    pending, that evaluation would have to handle.
  - (c) A system constant. Ruled out by the argument that made the idle bound
    per channel (0.2 Q3): label paths differ by minutes between channels, so
    one number is too tight for one and too loose for another.
- **C2 · How the failure is counted.**
  - (a) **Its own `metric_id`, `label_missing`.** It says what is known: the
    label never came.
  - (b) Folded into `classifier_down`. One value fewer, but it asserts a cause
    the feeder does not know, and it mixes transport failures into the figures
    used to tune the classifier.
- **C3 · A label that arrives after the cut.**
  - (a) **A late event and a rebuild**: the failure becomes a reading. The
    projection stays a function of the truth store, and the rebuild test holds
    unchanged.
  - (b) **Final**: once cut, it stays a failure. Figures are stable once
    sealed, but the feeder must compare each label's arrival time with the cut.
    That needs an arrival timestamp on the label in the truth store, so that a
    full rebuild reaches the same verdict.
- **O6 · How the reconciliation asks the truth store** (§7.3a). (a) its own
  named interface, `member_refs_seen(frame)`, a fourth deliverable of 3.7; or
  (b) `affected_members` called with the filter left out. (a) follows Q15's
  reasoning against one endpoint with two behaviours. (b) adds nothing to
  3.7's scope.
