# BOb v1 · Slice 3 · The absent-not-zero state — spec

**Status: SPEC, decided by Henry in the Slice 3 grill (2026-11-20). Nothing is
built.** The contract stays at 0.5.3. The contract changes this spec needs are
listed in §9 as **proposed for 0.6**, registered in
`Documentation/contract-amendments.md` as F-28 to F-34, and go to Federico on
Relevo task 6 before any of them is written into the contract.

**What Slice 3 is** (Build Brief, Slice 3; Relevo task 7 scope map): one shared
mechanism that tells every consumer, for every cell, whether a figure is
missing because nothing could arrive, because nothing has arrived yet, because
nothing did arrive, or because nothing happened. Four consumers: the charts,
the Performance matrix, the sentiment panel and, later, BObee.

**Done when:** FR-32, UI-03, PR-10 and SR-2 pass against **one**
implementation, not four (§8).

**Inputs.**
- Contract 0.5.3: §4 and §4.1 (sealing, lag NULL), §5 (three states,
  liveness), §6 (the eight tables), §8 (the feeder), §9.1 and §9.2
  (capabilities, idle bound).
- D-14, closed by Federico on Relevo task 7 (5 Nov): not configured means no
  `source_key` or no `telemetry_started_at`, and "the cell should say what to do
  about it"; not observed is the em dash; observed is a figure. Detection reuses
  `bob_source_key_unset()` (D-19) and `organizations.telemetry_started_at`
  (D-18), both from Slice 0.
- The thin Performance matrix (Bob-New PR #29) and its note for this grill,
  `docs/slice-2-matrix/nota-slice-3.md` on branch
  `slice-2-performance-matrix-thin`: read as `bob_app` over the reference
  feeder's output on the two-tenant fixture.
- The behavioural rules FR-11, FR-23, FR-32, FR-35 and UI-03. Their source
  document is internal, so they are cited here by ID only.
- The Relevo task 7 scope map, `BOb_v1_Remaining_Work_2026-11-10.docx` (md5
  `8365ae540c863b2c287db45325edc247`), read after the grill. Its Slice 3
  section matches this spec in all of these:
  - the three states;
  - the "what to do" of the third;
  - the off-shift dash in the drill-down;
  - the four consumers;
  - the done condition.

  Two things in it are not resolved here:
  - It says the mechanism serves "nine rules now, not four", and does not list
    them. The done condition still names four.
  - Its section on the order says seven consumers, against four in its Slice 3
    section. This spec builds for the four that are named. Any other consumer
    reads the same view.

The grill's questions are cited as **G1 to G15**. Each one was answered by
Henry with the recommended option.

---

## 1 · What the matrix showed

Read on the fixture, the matrix could not tell four things apart:

1. **No zero ever reaches it.** The feeder writes zeros only for the three
   label-failure counts. "Not observed" and "observed, none" are both "no row".
   §5 ties liveness to `health_uptime`, and no channel declares it.
2. **Three rows can never say "not configured"**: disambiguation, escalations
   and abandoned in queue have no capability in §9.1.
3. **"No row" has more meanings than §5 names**: *pending* (a channel with lag
   NULL never seals, so its label cut never runs), and *the actor cannot
   produce this metric* (Resolved under Customer).
4. **The "All" total mixes states.** It sums sealed and unsealed buckets, and
   the union of capabilities (§9.1) counts a row as configured if any channel
   declares it. Voice drops out of the label-failure total without saying so.

Also: Unfounded claims has two causes of absence at once. Available and Response
quality have no projection. Durations, health and RUM are empty in the fixture,
so there "no row" always coincides with "not configured". AREP has no column.

## 2 · The states (G1, G2, G12, G14)

A cell resolves to **exactly one state**, plus an ordered list of **reasons**.
The states are a closed set, and each one is painted differently. The reasons
say why the cell is in that state and what to do. Evaluation is ordered, and
the first match wins:

| # | Value in the schema | In `CONTEXT.md` | Meaning | Painted |
|---|---|---|---|---|
| 1 | `not_applicable` | No aplica | The actor cannot produce this metric, by definition (§4) | Empty, muted, no action |
| 2 | `not_configured` | No configurado | A declaration is missing, so nothing *can* arrive | Says what to declare (its reasons) |
| 3 | `pending` | Pendiente | No row, and the bucket cannot be known yet | Marked pending |
| 4 | `not_observed` | No observado | Configured, sealed, no row, no evidence the channel was alive | The em dash |
| 5 | `observed` | Observado | A figure. Zero is a figure | The value |
| — | `off_shift` | Fuera de turno | Per-actor drill-down cells only: the actor was not on shift (`bob_shift_is_live()` false) | The em dash |

**`provisional`** (G2) is a flag on `observed`, not a state: the row exists,
but its bucket has not sealed. O1 says such rows are written **and rendered**,
so `pending` applies only when there is **no row**. The matrix's existing
asterisk is this flag. A channel whose lag is NULL also carries §4's "lag not
declared" notice.

**The em dash** (G14) is shared by `not_observed` (D-14) and `off_shift`
(Relevo task 10, §5's last paragraph). Both rulings stand as written. The two
are told apart by state and reasons, never by glyph. Every em dash opens its
cause (UI-03). In the per-actor drill-down, `off_shift` also marks the actor's
row next to the name.

**Reasons are a list** (G5), ordered by who can fix them. Anything the customer
fixes in BOb comes first, and anything outside their control comes last. The
interface shows the first and "and N more". BObee receives the whole list.
Reasons are `snake_case`, in English, like FR-23's. The ones that already exist
in `bob_availability_reason()` keep their names.

**An `observed` cell can carry reasons too** (G8). A zero always does (UI-03):
`none_observed` with its liveness source, or `actor_not_present`.

## 3 · The resolution order, in full

For one cell `(org, channel, metric, actor_type, bucket)`:

1. **`not_applicable`.** The pair `(metric, actor_type)` is marked inapplicable
   in the catalog (§4). Reasons: none.
2. **`not_configured`.** The reasons below are checked **in this order**, and
   every one that applies is added:
   1. `telemetry_not_started`: `organizations.telemetry_started_at` is NULL
      (D-14, D-18). Organisation-wide.
   2. `source_key_unset`: `bob_source_key_unset(channels.source_key)` is true
      (D-14, D-19, **SR-2**). The whole channel. This calls the one definition
      that already exists and never re-implements it.
   3. `mix_not_declared`: `channel_actor_mix` has no row for this channel and
      actor type (G8, PR-10).
   4. `capability_not_declared:<capability>`: the metric's required capability
      has no `channel_capabilities` row (§5, §9.1).
   5. `idle_bound_not_declared`: the metric is `abandoned` and
      `idle_bound_seconds` is NULL (§9.2). It does not reach
      `abandoned_in_queue` (O3).
   6. `no_ground_truth`: the metric is `hallucinations` and no knowledge note
      exists (D-29, §6.1). This one is outside the customer's control.
   7. `no_definition:D-15`: Response quality only (§6). Outside the customer's
      control.

   If any applies, the state is `not_configured`.
3. **`pending`.** There is no row, and the bucket is not sealed. Reason:
   `not_sealed`, or `lag_not_declared` when the channel's lag is NULL (O1).
4. **`not_observed`.** There is no row. Reason: `no_liveness`, meaning no
   traffic and no probe (§5).
5. **`observed`.** There is a row. `provisional` when `sealed = false`.
   - A zero carries `none_observed` with `liveness_source = 'traffic' | 'probe'`.
   - `channel_actor_mix` declares the actor absent (`present = false`): the
     value is **0** with `actor_not_present` (G8, FR-11). This cell is
     `observed` even with no row, because the declaration is the observation.

## 4 · The catalog and the rule for each row (G4, G9, G15)

One configuration table in `bob`, beside the mechanism, says for each metric
where it is read, what it requires and which actor types can produce it. It is
the catalog the mechanism reads, not a list in application code. A guard
**discovers** the `metric_id` and `measure` values from the CHECK constraints
of the eight tables and fails if any value is missing from the catalog
(CLAUDE.md: discover, do not enumerate).

**The Performance matrix, row by row:**

| Row | Read from | Requires | `not_applicable` for |
|---|---|---|---|
| Available | `bob_availability()` (live, no bucket) | `channel_actor_mix` | — |
| Response time | `proj_durations`, `response_time` | `response_time` | — |
| Response quality | none | `coherence` (deferred) **and** D-15 | — (always `not_configured`: `capability_not_declared:coherence`, `no_definition:D-15`) |
| Resolved | `proj_metric_counts`, `resolved` | `resolution` | `user` |
| Abandoned | `proj_metric_counts`, `abandoned` | `idle_bound_seconds` | — |
| Disambiguation | `proj_metric_counts`, `disambiguation` | `disambiguation` (**new**) | `user` |
| Escalations | `proj_metric_counts`, `escalations` | `escalation` (**new**) | `user` |
| Unfounded claims | `proj_metric_counts`, `hallucinations` | `hallucination` **and** a ground truth | — (all four, 10 Nov) |
| Abandoned in queue | `proj_metric_counts`, `abandoned_in_queue` | `queue` (**new**) | `asa`, `human`, `arep` |

**Elsewhere:**

| Figure | Read from | Requires | `not_applicable` for |
|---|---|---|---|
| Label failures (`abstained`, `classifier_down`, `label_missing`) | `proj_metric_counts` | `orga_conversation` | `asa`, `human`, `arep` |
| Interaction duration (FR-22) | `proj_durations`, `interaction_duration` | `resolution` (a close; chosen here, no ruling names it) | `asa`, `human`, `arep` |
| ORGA | `proj_sentiment`, `orga` | `orga_conversation` | — |
| MECA (FR-32, FR-35) | `proj_sentiment`, `meca` and `proj_rum_signals` | `meca_rum` | — |
| Health latency, errors, uptime, disconnects | `proj_channel_health` | `health_latency`, `health_errors`, `health_uptime`, `health_disconnects`, each on its own (§6.4) | — |

- Three `user` cells are inapplicable: Resolved, Disambiguation and
  Escalations. **This is new** (G15): §6.1 attributes these to whoever did them,
  and does not forbid the customer. A guard fails if the feeder ever writes one
  of these rows, so the cell never hides it. Proposed as a clarification of
  §6.1 (F-33).
- **Available** (G9) does not come from the cell view. It returns the same
  `(state, reasons)` shape, translated in the database from the reasons FR-23
  already returns, and `bob_availability_reason()` is unchanged:
  - `no_channels_selected`, `mix_not_declared` → `not_configured`;
  - `no_channels_carry_actor_type` → `observed` 0;
  - `no_skilled_actors`, `none_on_shift`, `no_live_instances`,
    `no_actors_available` → `observed` 0, each with its reason.

  It is never `pending` or `provisional`, because it has no bucket.
- **The actor columns** follow `channel_actor_mix` (§3, step 2.3 and step 5).
  - **AREP** (G11) follows the same rules, with no special case in the
    mechanism.
  - The matrix shows the AREP column **only if some selected channel declares
    it present**. BObee receives its rows regardless.
  - How an AREP ref resolves (§7.2) stays open in the contract (F-34).

## 5 · Liveness, and who writes the zero (G3)

**Two sources of liveness**, each evidence for one bucket of one channel:
- **Traffic.** The channel had at least one interaction with activity in the
  bucket. That bucket was observed for every metric whose capability the
  channel declares.
- **Probe.** No traffic, but a `proj_channel_health` row with `observed = true`
  (`health_uptime`). The channel was alive and nothing happened. Q9's ruling
  stands for the case it was about: three in the morning.

**The feeder writes the observed zero, at seal.** For every sealed bucket with
liveness, and every metric whose capability the channel declares, it writes:
- **`proj_metric_counts`:** `event_count = 0`, with `session_count` = the
  bucket's interactions. A probe-only bucket writes `session_count = 0`. This
  is the shape the label-failure zeros already have.
- **`proj_durations`:** `n = 0`, `sum_ms = 0`, `hist_offset = 0`, an empty
  histogram, and `min_ms`/`max_ms` NULL.

It writes no zero on a channel that does not declare the capability: that is
`not_configured` (the F-25 note to 3.7 already says so for the label
failures). It writes no zero without liveness: that is `not_observed`.

The zero rows go through the upsert, the seal rule and the rebuild like every
other row, so the rebuild test covers them (§8).

## 6 · The "All" total and coverage (G6)

`bob_cell_rollup(org, channels[], frame)` aggregates cells over channels and
time:
- **The figure** sums only the cells that are `observed`.
- **The state** is `observed` if at least one cell is `observed`. Otherwise it
  is the first state, in the §2 order, among the cells.
- **`coverage`** is "n of m channels", with each excluded channel and its state
  and reasons. The interface shows it in the cell or its tooltip, and BObee
  says it.
- **`provisional`** if any contributing cell is.
- §9.1's union of capabilities decides **whether a row is shown**, and coverage
  says **how complete it is** (F-30).
- The hundred-percent rule (FR-10 to FR-14) is untouched, because coverage
  labels the sum without changing it.

## 7 · Where it lives (G7)

In the database, as one implementation:

| Object | Kind | What it does |
|---|---|---|
| The catalog (§4) | table in `bob`, configuration | Metric → source, required declarations, applicable actor types |
| `bob.v_cell_state` | view, RLS by `org_id` | One row per `(org_id, channel_id, metric, actor_type, bucket_start)`: `state`, `reasons TEXT[]`, `value`, `provisional`, `liveness_source`. §3 is resolved here, in SQL |
| `bob_cell_rollup(org, channels[], frame)` | function in `public`, `search_path = bob, public` (as `bob_availability()`) | §6 |
| Available's translation (§4) | function beside it | FR-23 reasons → `(state, reasons)` |
| `v_ai_cell_state` | view for `bob_ai_ro` | BObee's face of `v_cell_state`: no `display_name` (IR-1). An unobserved channel arrives as a value, not an absence |

**The application only paints**: state → painting, reason → sentence. No rule
lives in TypeScript.

**Cost is open, not decided.** The implementation PR runs `EXPLAIN` on the
fixture for a thirteen-month frame. Whether `v_cell_state` needs materialising
is decided from that measurement.

## 8 · Acceptance tests

All in `node:test`, serial, under the advisory lock, against the extended
fixture (§8.1). Each guard is seen failing before it counts, as in every slice.

**The four rules, against one implementation:**
- **FR-32.**
  - A selection of Voice only gives MECA `not_configured`
    (`capability_not_declared:meca_rum`), with value NULL and never 0.
  - Website declares `meca_rum` and has no RUM rows, so it gives
    `not_observed`.
  - FR-35 itself stays in Slice 4.
- **UI-03.** Every cell and every rollup whose value is NULL or 0 has at least
  one reason. Asserted over the whole view on the fixture, not over a sample.
- **PR-10.** The same capability and sealed bucket, three ways:
  - no traffic and no probe gives `not_observed`, with no row;
  - traffic and no event gives `observed` 0, from a written row,
    `liveness_source = 'traffic'`;
  - a probe row and no traffic gives `observed` 0, `liveness_source = 'probe'`.

  Also: a declared-false mix is different from an undeclared one (G8).
- **SR-2.**
  - A channel whose `source_key` matches the sentinel gives `not_configured`
    with `source_key_unset` in every cell, ahead of any capability reason.
  - An organisation with no `telemetry_started_at` gives
    `telemetry_not_started`.
  - Replacing the view's call to `bob_source_key_unset()` with a re-implemented
    pattern must turn a test red. The test asserts the view depends on the
    function (`pg_depend`).

**One implementation, not four:**
- `v_ai_cell_state` and `bob_cell_rollup` read `v_cell_state`, asserted
  through `pg_depend`. A second definition of the order would have no
  dependency to show.
- **Exactly one state per cell, in the §3 order.** A property test over fuzzed
  combinations of declarations, seals, traffic and probes, in the style of
  FR-10 to FR-14.

**The rest of what the grill decided:**
- **FR-11.** An actor declared absent in every selected channel gives exactly
  0, with `actor_not_present`.
- **Coverage.** On the fixture, the "All" label-failure total reads 2 of 3
  channels, with Voice `not_configured` (`capability_not_declared:orga_conversation`).
- **Provisional.** Website's Resolved (lag NULL) gives `observed` and
  `provisional`, with "lag not declared" on the channel.
- **Not applicable.**
  - Resolved, Disambiguation and Escalations under `user` give
    `not_applicable`.
  - A guard fails if the feeder writes any of those rows.
  - The degenerate CHECKs and the catalog agree, discovered.
- **The catalog guard.** Every `metric_id` and `measure` value in the CHECK
  constraints is in the catalog.
- **The zero rows.**
  - The feeder writes the zero only with liveness and a declared capability.
    It is seen failing both ways: a zero without liveness, and a zero on an
    undeclared capability.
  - The rebuild test (truncate, re-run, identical render) covers the zero rows.
- **Off shift.** A per-actor cell for an actor not on shift gives `off_shift`,
  apart from an actor on shift with no row (`not_observed`).

### 8.1 · The fixture and the reference feeder (G10)

Every state appears at least once, for every table the mechanism reads.
Fictitious data only:
- A channel declares `response_time` and `health_uptime`. The reference feeder
  learns to write `proj_durations` (including the `n = 0` zero) and
  `proj_channel_health` rows with `observed = true`.
- A night bucket with a probe and no traffic gives `observed` 0 by probe.
- A sealed bucket with a declared capability, no traffic and no probe gives
  `not_observed`. This is the case the fixture does not have today.
- Website declares `meca_rum` with no RUM rows. **The feeder still does not
  write `proj_rum_signals`**: that is Slice 4.
- A channel with no `channel_actor_mix` row covers `mix_not_declared`.
- A channel on the `source_key` sentinel and an organisation without
  `telemetry_started_at` cover SR-2 and D-14.
- The three new capabilities are declared on one channel and not on another.

The reference feeder is the executable contract 3.7 copies. If it does not
write the zeros, 3.7 will not either.

## 9 · Contract changes, proposed for 0.6 (G13)

**None is written into `projection-contract.md` here.** Each is registered in
`contract-amendments.md` and goes to Federico before 0.6:

| # | Section | Change |
|---|---|---|
| F-28 | §5, §8 | Liveness has two sources, traffic and probe. The feeder writes the observed zero at seal, on `proj_metric_counts` and `proj_durations` (`n = 0`). 3.7 owes it too |
| F-29 | §9.1 | Three new capabilities: `disambiguation`, `escalation`, `queue`. Presence only, declared per channel, never mapped from `channel_type`. Ten become thirteen |
| F-30 | §9.1 | "The drill-down reads the union" becomes the union plus coverage (§6) |
| F-31 | §5, new subsection | The cell vocabulary: six states in order, reasons, `provisional`, the shared em dash, D-14's markers first, and where it lives (§7) |
| F-32 | §5 | A declared-absent actor is `observed` 0 with a reason. FR-11 and UI-03 hold together |
| F-33 | §6.1 | Resolved, disambiguation and escalations never attribute to `user` |
| F-34 | §7.2 | AREP ref resolution named as open, outside Slice 3 |

D-14 is applied, not amended. The em dash keeps both of its rulings.

## 10 · Open, outside this spec

- **Per-actor zeros in the drill-down (Slice 7).** F-28 writes zeros at
  channel × actor-type grain. Writing them for every actor on shift in every
  bucket of `proj_actor_metrics` multiplies rows. Whether Slice 7 derives a
  per-actor zero from an observed channel bucket plus `bob_shift_is_live()`, or
  the feeder writes it, is decided when Slice 7 is drawn. Either way the
  vocabulary is this one.
- **Materialising `v_cell_state`** (§7), from the measured cost.
- **D-33** (rendering "rebuilt after it sealed") stays open. A rebuilt cell is
  still `observed`.
- **F-34**, AREP ref resolution.
