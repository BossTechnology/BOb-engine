# BOb v1 · Slice 7 · Drill-downs — spec

**Status: SPEC, decided by Henry in the Slice 7 grill and approved by him
(2026-11-27). Nothing is built.** It is drawn ahead of D-33, which is open and assigned to Federico on
Relevo task 19. D-33's two questions are not decided here. §8 writes option (a),
the one proposed on the task, as the default, and isolates everything that
changes under (b) or (c) in that one section, one migration and one block of
tests. Federico signs the product rulings; this spec proposes.

**What Slice 7 is.** The three levels of the drill-down, in the database:
channel → actor → bucket. Slice 3 already resolves the first two
(`bob_cell_state`, `bob_actor_cell_state`). Slice 7 adds the per-actor zero
derived at read time, the unattributed remainder, the bucket's detail and the
link from a cell to its alerts. The application only paints, as in Slice 3. The
routes themselves are bob-web's, outside this repository.

**Done when:**
- the acceptance tests of §11 pass, each seen failing first;
- no zero reaches a cell that no observation supports: a per-actor zero exists
  only under an observed channel bucket with a row and a live shift (§2);
- the actors of a type never add up to more than their channel cell, and any
  remainder is a named row, never hidden (§4);
- an alert's detail shows the figure it fired on, from `alert_log`, beside the
  figure the cell shows now (§6);
- every new function is invoker, under RLS, and a guard discovers them (§7).

**Inputs.**
- Contract 0.5.3/0.6: §4 and §4.1 (sealing, C3: a late label is a rebuild,
  alerts already fired stay), §5 (absent, zero, not configured; the em dash of
  the roster), §6.6 (`proj_actor_metrics`), §7.3 (`affected_members`), §11
  ("Open after 0.5": D-33).
- `docs/slice-3-absent-not-zero.md` §2, §3, §7 and §10 (per-actor zeros "decided
  when Slice 7 is drawn"; "a rebuilt cell is still `observed`").
- `docs/slice-5-thresholds.md` (PR #63): `bob_threshold_status`, and the
  columns `alert_log` gains (§7 there).
- Relevo task 19 (D-33, the two questions and the per-actor zero, sent to
  Federico for information).
- `Documentation/contract-amendments.md`, «Slice 3 · built» and «Slice 5».

The grill's questions are cited as **T1 to T8**. Henry answered each one with
the recommended option:

| | Decided |
|---|---|
| T1 | Three levels, three functions in `bob`; the routes are bob-web's |
| T2 | Per-actor zeros are derived at read time, for humans on shift only |
| T3 | The derived zero is `observed` 0, `none_observed`, `liveness_source = 'shift'` |
| T4 | The cell reaches its alerts through an invoker function over `alert_log` |
| T5 | Every new function is invoker under RLS, granted to `bob_app` and `authenticated`; nothing for BObee in v1 |
| T6 | Actors sum to at most the channel cell; the remainder is a row, `unattributed` |
| T7 | Under D-33 Q1 (a), "rebuilt" is a sealed row written past its seal deadline plus one feeder cycle |
| T8 | One test file, each test red first; D-33's tests in a block of their own |

---

## 1 · The three levels (T1)

| Level | Function | Grain | Status |
|---|---|---|---|
| Channel | `bob.bob_cell_state(org, channels[], from, to)` | (channel, metric, actor_type, bucket) | Slice 3, **unchanged** |
| Actor | `bob.bob_actor_cell_state(org, channels[], from, to)` | (actor, channel, metric, bucket) | Slice 3, **extended** (§2, §3) |
| Actor remainder | `bob.bob_actor_unattributed(org, channels[], from, to)` | (channel, metric, actor_type, bucket) | **new** (§4) |
| Bucket | `bob.bob_cell_detail(org, channel, metric, actor_type, bucket)` | one cell | **new** (§5) |
| Alerts | `bob.bob_cell_alerts(org, channels[], metric, actor_type, from, to)` | one alert row | **new** (§6) |

- The channel level is not touched. Slice 3's seven consumers keep reading it as
  they do. Nothing in Slice 7 changes a channel cell's state, reasons or value,
  under option (a) of both D-33 questions. Option (b) of Q2 is the one path that
  would change it (§8.3).
- Every level speaks Slice 3's vocabulary (§3). A drill-down never shows a
  state the level above it could not have shown.
- A drill-down from an "All" total (`bob_cell_rollup`) is a drill-down into
  each channel it covers. The rollup's coverage ("n of m channels") already says
  which ones were excluded and why; Slice 7 adds no second coverage rule.

## 2 · The per-actor zero, derived at read time (T2)

Slice 3 left this open (§10 there): an actor on shift with no row is
`not_observed`. F-28 writes zeros only at channel × actor-type grain. Writing
one row per actor on shift per bucket in `proj_actor_metrics` multiplies rows
and makes the feeder own a shift rule it does not read. **The zero is derived
when the drill-down is read, and never written.**

For one `(human actor, channel, per-actor metric, bucket)` with **no row** in
`proj_actor_metrics`, the cell is `observed` 0 when **all** of these hold:
1. the channel cell for the actor's type is `observed`, from a row: not the
   declared-absent zero (`actor_not_present`), which has no row behind it;
2. the actor is skilled on the channel (`actor_channel_skills`), as Slice 3's
   `who` already requires;
3. `public.bob_shift_is_live(...)` is true for the actor at `bucket_start`,
   the same instant Slice 3 judges `off_shift` at. It calls the one definition
   and never re-implements it.

If any one fails, nothing is derived and Slice 3's order stands: `off_shift`
for a human not on shift, `pending` under a pending channel cell,
`not_observed` otherwise.

- **Humans only.** An ASA or a member has no shift, so nothing proves that it
  was there to do nothing. Without a row they stay `not_observed`, as today.
  A zero for them would be invented.
- **The channel cell carries the observation.** A metric the feeder does not
  count (`MEASURED`, contract §5) has no channel row, so its channel cell is
  `not_observed` and no actor under it gets a zero. "No zero for a metric it
  does not count" holds one level down with no new rule.
- **`provisional` follows the channel row.** A zero derived under an unsealed
  channel bucket is provisional; it seals when the channel bucket does.
- **The position in the order.** Inside `bob_actor_cell_state` the cases run:
  `not_applicable` / `not_configured` (the channel's) → `observed` from a row →
  `observed` 0 declared absent → `off_shift` → `pending` → **`observed` 0
  derived** → `not_observed`. A derived zero can only follow a channel cell that
  is `observed`, so it never meets `pending`.

Contract §5 says "the feeder must never write a zero it did not observe". A
derived zero is not written by anyone. Its observation is the channel bucket
plus the shift, and the cell says so (§3). Proposed for 0.6 as a clarification
of §5 (§9).

## 3 · The vocabulary, unchanged (T3)

No state is added. The six states and their order are Slice 3's §2.

| Cell in the drill-down | State | Reasons | `liveness_source` |
|---|---|---|---|
| The actor has a row | `observed` (`provisional` by its seal) | `none_observed` if 0 | `traffic` |
| The feeder wrote no row; the channel observed; the human is on shift | `observed` 0 | `none_observed` | **`shift`** (new value) |
| Declared absent on the channel | `observed` 0 | `actor_not_present` | the channel cell's |
| A human not on shift, no row | `off_shift` | `not_on_shift` | — |
| No row; channel pending | `pending` | the channel cell's | — |
| No row, nothing derives a zero | `not_observed` | `no_actor_row` | — |

- **`bob_actor_cell_state` gains `liveness_source`**, so a derived zero is told
  apart from a written one by a value, not by inference. That changes the
  function's return type. `CREATE OR REPLACE` cannot do that, so the migration
  drops and recreates it, with its grants, in one transaction (F-51).
- "Observed / not observed / not configured" mean what contract §5 says, at
  every level. A drill-down never turns an em dash into a zero.

## 4 · The unattributed remainder (T6)

`proj_metric_counts` counts by actor type. `proj_actor_metrics` counts by actor.
They should agree, and on the fixture they do. On a box they need not: the
feeder's route B leaves agent and ASA refs it could not resolve (contract §8.6),
and those events are in the type's count with no actor to hang them on.

**`bob.bob_actor_unattributed(org, channels[], from, to)`** returns, for each
channel cell that is `observed` from a row and has per-actor metrics:
- `value` = the channel cell's value − the sum of its actors' values;
- `state` = `observed`, `reasons` = `{unattributed}`, when the difference is
  greater than 0;
- no row when it is 0;
- `reasons` = `{actor_sum_exceeds_channel}`, with the negative value, **never
  clamped**, when the actors add up to more than the channel. That is a feeder
  defect, and the drill-down shows it rather than hiding it.

The drill-down paints the remainder as one more line under the actors:
"3 not attributed to an agent". The interface never computes it.

## 5 · The bucket (T1)

**`bob.bob_cell_detail(org, channel, metric, actor_type, bucket)`** returns one
row for one cell:

| Column | From |
|---|---|
| `state`, `reasons`, `value`, `provisional`, `liveness_source` | `bob_cell_state`, the same row |
| `sealed`, `computed_at`, `source_watermark`, `feeder_version` | the projection row(s) behind it (contract §4); NULL when there is none |
| `lag_seconds` | `channels`, as declared now; NULL renders "lag not declared" (O1) |
| `affected_frame` | `jsonb`: `tenant_slug`, `source_key`, `[from, to)` and the filter (`metric_id`, `actor_type`) for `affected_members` (contract §7.3) |
| `rebuilt_at`, `unvouched` | `bob_cell_markers` (§8, D-33) |

- **`affected_members` is not called from the database.** It is a 3.7
  interface on BzzzBX's side. `bob_cell_detail` returns its frame and filter in
  the cell's language, so the caller asks for exactly the cell it drilled from.
  The filter never carries an `event_name` (§7.3: "one definition, two
  consumers").
- When several projection rows sit behind one cell (an `actor_type` across
  rungs, for instance), `computed_at` and `source_watermark` are the greatest,
  and `sealed` is `bool_and`, as Slice 3 reads `provisional`.

## 6 · From a cell to its alerts (T4)

**`bob.bob_cell_alerts(org, channels[], metric, actor_type, from, to)`**, one
row per `alert_log` row of the cells in the frame:

| Column | From |
|---|---|
| `alert_id`, `alert_type`, `severity`, `created_at`, `escalates_alert_id` | `alert_log` |
| `channel_id`, `actor_type`, `bucket_start`, `threshold_id`, `subject_key` | `alert_log`, Slice 5's columns |
| **`value_at_firing`** | `alert_log.value`, as written when it fired |
| **`value_now`** | `bob_cell_state`'s value for the same cell |
| `bound` | `alert_log.threshold` |
| `rebuilt_after_firing` | §8.2 |

- The join is on `(org_id, channel_id, actor_type, bucket_start)` and the
  threshold's `metric_id`, all columns Slice 5 adds. A cell with no alert
  returns no row. The cell's colour comes from `bob_threshold_status`, never
  from here: a breaching threshold with no response is red and has no alert
  (Slice 5 §5).
- An escalation is listed with the alert it escalates (`escalates_alert_id`).
  A recovery is listed in the bucket it was written for.
- **It depends on Slice 5.** It cannot be built before Slice 5's
  `alert_log` columns are on `main`. That fixes the order: Slice 5 merges, then
  Slice 7's migration is written against it.
- `alert_log.value` is never rewritten (D-12: alerts already fired stay).
  `value_at_firing` and `value_now` differ exactly when the bucket was rebuilt
  after the alert. That is D-33 Q1's case; what is shown about it is §8.

## 7 · Permissions and tenancy (T5)

- Every Slice 7 function is `LANGUAGE sql`, `BEGIN ATOMIC … END`, `STABLE`,
  **`SECURITY INVOKER`**, in `bob` with `search_path = bob, public`, like
  Slice 3's (§7 there: dependencies in `pg_depend`, restorable with `bob` alone,
  F-47).
- Tenancy is RLS on what they read, plus the explicit `org` argument, as in
  `bob_cell_state`. No function is definer, so none can read another tenant's
  rows whatever argument it is given.
- `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role, bob_app,
  bob_feeder, bob_ai_ro`, then **`GRANT EXECUTE … TO bob_app, authenticated`**:
  Slice 3's grants, exactly.
- **BObee gets no drill-down in v1.** `v_ai_cell_state` stays its only face.
  An actor-level face for `bob_ai_ro` would need a definer view filtered on the
  claim, and names of agents in a model's context. That is its own decision.
- A guard **discovers** the Slice 7 functions (every function in `bob` whose
  name starts `bob_cell_` or `bob_actor_`), and asserts for each: invoker, SQL
  body, and EXECUTE held by `bob_app` and `authenticated` and by no other
  application role. It does not list them.

## 8 · Open, depends on D-33 (Relevo task 19)

**This section is the only part of the spec that changes with Federico's
ruling.** It is built in its own migration, `…_slice7_cell_markers.sql`, into one
function, `bob.bob_cell_markers`, and tested in its own block (§11, "D-33").
`bob_cell_detail` and `bob_cell_alerts` read the function's columns and
nothing else about D-33. If Federico chooses (b) or (c), this section, that
migration and that block are rewritten, and nothing else moves (with the one
exception named in §8.3).

### 8.1 · `bob.bob_cell_markers(org, channels[], from, to)`

One row per cell in the frame, at `bob_cell_state`'s grain, with two columns:
`rebuilt_at TIMESTAMPTZ` and `unvouched BOOLEAN`. Invoker, under RLS, granted
as §7. Neither column changes a cell's state: **a rebuilt cell is still
`observed`** (Slice 3 §10), and under (a) so is an unvouched one.

### 8.2 · Q1 · A bucket rebuilt after it sealed (contract C3)

A late label triggers a D-12 rebuild; alerts already fired stay. So an alert
can cite a figure the panel no longer shows: "12 %" in the alert, "9 %" in the
cell. The data is stored (`computed_at`, `source_watermark`); only the display
is open.

**Proposed default, option (a):** a quiet marker on the cell, "rebuilt at
<time>, after this bucket sealed", and the alert's detail shows the figure at
firing next to the current one.

What (a) builds:
- **`rebuilt_at`** is the row's `computed_at` when the row is `sealed` and
  `computed_at > bucket_start + 5 min + lag_seconds + 5 min` (T7). The last
  5 minutes are one feeder cycle: the run that first seals a bucket writes it a
  little after its deadline, and that is not a rebuild. Otherwise NULL. A
  channel whose lag is NULL never seals (O1), so it never shows the marker.
- **`rebuilt_after_firing`** in `bob_cell_alerts` is true when the cell's
  `computed_at > alert_log.created_at`. It is exact, needs no grace, and is
  what explains a gap between `value_at_firing` and `value_now`.
- **The cost, stated (F-52).** `lag_seconds` is read as declared now. Raising a
  channel's lag later moves the deadline, and an old bucket rebuilt inside the
  new window loses its marker. The alert's flag does not depend on the lag and
  is unaffected. The fix, if it matters, is to store the seal instant, a
  projection change for 0.6. It is not proposed now.

| If Federico picks | What changes |
|---|---|
| (b) No marker on the matrix; only the alert detail explains it | `bob_cell_markers` stops returning `rebuilt_at`, and `bob_cell_detail` drops the column. `rebuilt_after_firing`, `value_at_firing` and `value_now` stay. Tests D1–D2 are removed, D3–D4 stay |
| (c) Nothing shown | Both columns go. `bob_cell_alerts` keeps `value_at_firing` (it is `alert_log.value`, which exists today), and `value_now` goes with the flag, so nothing invites the comparison. Tests D1–D4 are removed |

### 8.3 · Q2 · A bucket with counts and no coverage record ("unvouched")

The coverage record is the one reserved as D63 in BzzzBX and not built. When it
exists, a source says "this bucket of mine is complete". A bucket with counts
and no such record has figures nobody vouched for.

**Proposed default, option (a):** `observed` with an "unvouched" marker,
**switched on per source only once that source emits coverage records.**

What (a) builds in Slice 7: **the switch, off everywhere.**
- `unvouched` is `false` for every cell in v1, because no source emits coverage
  records and there is nothing to compare against. A marker switched on before
  D63 exists would be on for every bucket of every box, and ignored within a
  week. That is why (a) switches per source.
- The column and its test exist now so the shape is fixed: test D5 asserts that
  no cell is unvouched while no source declares coverage. When D63 lands, the
  per-source declaration, the coverage table and the rule are one migration
  that replaces `bob_cell_markers`, with its own spec.

| If Federico picks | What changes |
|---|---|
| (b) Render it as `not observed` | **The one change that leaves this section.** An unvouched bucket would become `not_observed` in `bob_cell_state` itself, a change to Slice 3's resolution order (step 5 before step 6) and to every consumer. It still waits for D63, and it would be its own migration against Slice 3's function. In Slice 7 the `unvouched` column goes and test D5 is removed |
| (c) Defer until D63 is built | The `unvouched` column goes. Test D5 is removed. Nothing else |

Neither question blocks Monday's release. Q1 decides how much of §8.2 is built;
Q2 changes nothing visible in v1 under (a) or (c).

## 9 · Findings and contract changes

- **F-51 · Extending `bob_actor_cell_state` changes its return type.** The new
  `liveness_source` column (§3) cannot be added with `CREATE OR REPLACE`. The
  migration drops and recreates the function with its grants in one transaction.
  Consumer check: a caller that selects `*` gets one more column. bob-web is
  outside this repository, so the PR names the check rather than making it.
- **F-52 · The rebuilt marker depends on today's lag** (§8.2). Stated, not fixed:
  storing the seal instant is a projection change.
- **Contract §5, proposed for 0.6: the derived zero.** "The feeder must never
  write a zero it did not observe" stays. Added: the per-actor drill-down
  derives, and never writes, a zero for a human on shift under an observed
  channel bucket (§2), with `liveness_source = 'shift'`. Slice 3 §10's open
  item is closed by that.
- **Contract §11, D-33.** Still open, on Relevo task 19. This spec implements
  option (a) of both questions as a default that one section replaces.

## 10 · Interim, named

| Interim in Slice 7 | Superseded by | When |
|---|---|---|
| `unvouched` is false everywhere | Coverage records per source (D63) | When BzzzBX builds D63, and D-33 Q2 is ruled |
| `rebuilt_at` reads today's lag | A stored seal instant, if 0.6 takes it | Not proposed |
| `affected_members` is returned as a frame, not called | The application layer calling 3.7 | When bob-web wires the drill-through |
| D-33 is implemented at option (a) | Federico's ruling | Relevo task 19 |

## 11 · Acceptance tests (`tests/slice7-drilldowns.test.mjs`)

Each one is written first and seen failing against the chain without its
migration, or against a sabotage (the table goes into amendments). The two-tenant
fixture and the Slice 1 roster are the ground. CI gains a Slice 7 step.

**The derived zero (§2, §3)**
1. A human on shift, skilled on a channel whose bucket is `observed` from a row,
   with no actor row: `observed` 0, `{none_observed}`, `liveness_source = 'shift'`.
2. The same human with the shift ended (`bob_shift_is_live` false at
   `bucket_start`): `off_shift`, `{not_on_shift}`, no value.
3. The same human under a `not_observed` channel bucket: `not_observed`. Under a
   `pending` one: `pending`. No zero.
4. An ASA with no row under an observed channel bucket: `not_observed`,
   `{no_actor_row}`. The same for a member.
5. Under a declared-absent channel zero (`actor_not_present`): the declared zero,
   not a derived one, and `liveness_source` is not `shift`.
6. A metric the feeder does not count (`MEASURED`): no actor gets a zero.
7. A derived zero under an unsealed channel bucket is `provisional`.
8. Sabotage: `bob_shift_is_live` re-implemented inline in the function. A guard
   reads `pg_depend` and fails unless the function depends on
   `public.bob_shift_is_live`.
9. No new row is written to `proj_actor_metrics` by any of the above.

**The remainder (§4)**
10. On the fixture the actors of each type add up to the channel cell: no
    `unattributed` row.
11. With one event attributed to the type and to no actor: one row,
    `{unattributed}`, value 1.
12. With actors adding up to more than the channel: `{actor_sum_exceeds_channel}`,
    negative value, never clamped to 0.

**The bucket (§5)**
13. `bob_cell_detail` returns the same `state`, `reasons` and `value` as
    `bob_cell_state` for every cell of a frame.
14. Its provenance is the projection row's; a cell with no row has NULL
    provenance.
15. A channel with NULL lag: `lag_seconds` NULL, never 0.
16. `affected_frame` carries `metric_id` and `actor_type` and no `event_name`.

**Alerts (§6)** — after Slice 5 is on `main`
17. An alert written by `bob_evaluate_at` is returned for its cell, with
    `value_at_firing = alert_log.value`.
18. A cell with no alert returns nothing; a breaching threshold with no response
    is `breach` in `bob_threshold_status` and has no row here.
19. An escalation is listed with its `escalates_alert_id`.
20. Tenant B's alerts never appear in tenant A's frame.

**Permissions (§7)**
21. Every `bob_cell_*` and `bob_actor_*` function is invoker, SQL-bodied, and
    executable by `bob_app` and `authenticated` only (discovered, not listed).
22. As `bob_app` with tenant A's claim, asking for tenant B's org returns no
    rows from any Slice 7 function.
23. `bob_ai_ro` cannot execute any of them.

**D-33 (§8), option (a)** — the block that is rewritten if Federico picks (b) or (c)
- D1. A sealed row rebuilt after its deadline plus one cycle: `rebuilt_at` is
  its `computed_at`. The `state` is still `observed`.
- D2. A row sealed by its first write, inside the cycle: `rebuilt_at` NULL. A
  channel with NULL lag: `rebuilt_at` NULL.
- D3. An alert fired, then its bucket rebuilt to another value:
  `rebuilt_after_firing` true, `value_at_firing` ≠ `value_now`, and
  `alert_log.value` unchanged.
- D4. An alert whose bucket was not rebuilt: `rebuilt_after_firing` false and
  the two values equal.
- D5. With no source declaring coverage, no cell is `unvouched`.

## 12 · Migrations

After `20261126110000` on `main` (checked 27 Nov), and after Slice 5's
`20261127100000` to `20261127100500` (PR #63, building in another worktree).
Slice 7 takes `20261127110000` onward, so Slice 5 can still add a migration
below it:

| Number | Contents |
|---|---|
| `20261127110000_slice7_drilldowns.sql` | §2 to §7: `bob_actor_cell_state` recreated, `bob_actor_unattributed`, `bob_cell_detail`, `bob_cell_alerts`, grants |
| `20261127110100_slice7_cell_markers.sql` | §8: `bob_cell_markers`, the only D-33 migration |

If Slice 7 is built on a later day, the numbers move to that day and stay above
Slice 5's last.

**Not for the Febor window.** Slice 7 is not part of the 30 Nov delivery. These
migrations do not touch the O-3 install chain or anything under `/opt/bob`, and
they are not added to a box's install until Henry signs a new fingerprint.

## 13 · Open, outside this spec

- D-33 Q1 and Q2 (Relevo task 19, Federico).
- D63, coverage records in BzzzBX.
- An actor-level face for BObee.
- The routes and the painting, in bob-web.
- How many display states health has (Slice 3 amendments, 10 Nov): a Slice 7
  display question for bob-web, which reads `proj_channel_health` components
  through `bob_cell_state` already.
