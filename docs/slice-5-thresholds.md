# BOb v1 · Slice 5 · Cooldown and escalation — spec

**Status: SPEC, decided by Henry in the Slice 5 grill (2026-11-27). Nothing is
built.** The product rulings it applies are Federico's and are signed: D-05
(BOB-9, 27 Oct, with the six points answered on 5 and 10 Nov) and D-31
(BOB-11, 4 Nov). The grill answered how to build them, not what they are.
Where the grill found a ruling that rests on something the schema does not
have, it is a finding (§10) and goes to Federico before the build relies on it.

**What Slice 5 is.** Step 6a (the three durations on `threshold_configs`) and
step 19 (the evaluation function). The function reads the cells of Slice 3,
decides breach and recovery per subject and response, writes alerts to
`alert_log` and, for Action responses, intentions to `bob.outbound_queue`
under the D-31 limits.

**Done when:**
- the acceptance tests of §9 pass, each seen failing first;
- no evaluation happens on a cell that is not sealed and observed (A-04, O1);
- a breaching threshold with no response still paints red (10 Nov ruling 1);
- every limit refusal is a row with its reason, never silence (BOB-11 item 1).

**Inputs.**
- `Documentation/contract-amendments.md`, «Slice 5 · Cooldown and escalation»,
  A-04, F-02, and «Slice 6 · Registries and the outbox, built».
- Relevo BOB-9 (D-05, the full thread) and BOB-11 (D-31).
- Contract 0.5.3/0.6: §4 and §4.1 (sealing, NULL lag never evaluated), §5,
  §6.1 (`hallucinations` absent until ground truth), §11 (interims).
- `docs/slice-3-absent-not-zero.md` §2, §3, §7: `bob_cell_state` is the one
  implementation of a cell, and the evaluator reads it.

The grill's questions are cited as **S1 to S13**. Henry answered each one with
the recommended option:

| | Decided |
|---|---|
| S1 | The evaluator is SQL in `bob`; who schedules it is P5 |
| S2 | Only sealed, observed cells are evaluated |
| S3 | A limit refusal is an outbox row, `suppressed`, with its reason |
| S4 | `UNIQUE (org_id, metric_id)` gives way to a scoped unique index |
| S5 | The subject is (threshold, channel, actor_type) |
| S6 | Escalation is a new alert row, once, linked |
| S7 | Retention moves to P5 with the scheduler |
| S8 | Severity by magnitude; proximity is display only |
| S9 | Manual peak windows suppress; `observed` is refused with a reason |
| S10 | `trigger_level` is absolute; sustained counts sealed buckets |
| S11 | The breach is a read function shared by display and evaluator |
| S12 | SECURITY DEFINER, no EXECUTE for any application role |
| S13 | Catch-up in order, 24 h horizon, idempotent |

---

## 1 · Step 6a · the three durations (D-05 points 1, 2, 5)

On `bob.threshold_configs`, all three **nullable, NULL inherits**:

| Column | Inherits from | Returns |
|---|---|---|
| `cooldown_seconds` | `bob.bob_default_cooldown_seconds()` | 1800 |
| `escalation_after_seconds` | `bob.bob_default_escalation_after_seconds()` | 7200 |
| `recovery_dwell_seconds` | `bob.bob_default_recovery_dwell_seconds()` | 300 |

- **The floor is in both places.** Each column gets
  `CHECK (x IS NULL OR x >= 300)`. The CHECK cannot see through a NULL, so
  each function also refuses to return less than 300: it raises instead.
- **The functions are `IMMUTABLE` SQL with a constant body.** Changing a
  default is a one-line migration that replaces the function. It reaches every
  threshold that inherits and leaves explicit overrides untouched. That is
  what "we change it centrally" promised, and a column DEFAULT could not do it
  (point 1).
- **`bob.bob_effective_durations(threshold)`** returns the three effective
  values, `COALESCE(column, function())`. The evaluator reads only this, never
  the columns.
- **`notification_rules` loses its two defaults** (`suppression_min` 15,
  `escalation_min` 30). Henry checked on 6 Nov that nothing reads them, and
  Federico ruled it on 10 Nov. The table stays: step 17 retires the Bob-New
  cron before it drops the table.

## 2 · Uniqueness of a threshold (S4, F-48)

`UNIQUE (org_id, metric_id)` is dropped. In its place goes a unique index on
`(org_id, metric_id, scope_kind, COALESCE(scope_ref, ''))`. Point 6 of D-05
was ruled on the premise that step 6 had already done this. Slice 6 added the
scope columns and left the constraint, so until this migration "per
threshold" still means per metric per organization (§10, F-48).

## 3 · On the response (10 Nov ruling 2, S10)

On `bob.response_rules`, both nullable:
- **`trigger_level NUMERIC`**: an absolute value in the metric's units, on the
  same side as the bound it hangs from. NULL means the bound itself. A trigger
  checks that the level is on the breaching side, because it depends on
  `threshold_configs`.
- **`sustained_for_seconds INTEGER`**: `CHECK (x IS NULL OR x >= 300)`. NULL
  means fire on the first sealed bucket past the level. Otherwise it fires
  after `ceil(x / 300)` consecutive sealed buckets past the level.

Several responses on one threshold at different depths are several rows. The
display does not depend on any of them (§5).

## 4 · What is evaluated (S2)

**The subject is (threshold, channel, actor_type)** (S5). The threshold's
scope (`scope_kind`, `scope_ref`) filters which channels and actor types it
reaches. `subject_key` is the text
`threshold_id || ':' || channel_id || ':' || actor_type`. One problem on four
channels and two actor types is eight subjects. D-05 already accepted that:
v1 does no correlation.

**Only a sealed, observed cell is evaluated.** From `bob_cell_state`:
`state = 'observed' AND NOT provisional`. Everything else is **refused with a
reason** in the function's output and moves no state:

| Cell | Reason | Why |
|---|---|---|
| `provisional` on a channel with `lag_seconds` NULL | `lag_not_declared` | A-04 / O1: it never seals and is never evaluated |
| `provisional` with a declared lag | `not_sealed` | PR-7: evaluation waits for the lag |
| `pending` | `not_sealed` | |
| `not_observed` | `not_observed` | absent is not zero: neither a breach nor a recovery |
| `not_configured` | `not_configured` | e.g. «Unfounded claims» with no ground truth (§6.1): the row renders absent and is never evaluated |
| `not_applicable`, `off_shift` | the cell's own | |
| `peak_mode = 'observed'` | `peak_observed_unsupported` | needs history, v1.1 (S9) |

**Absent cells do not end a breach.** A breached subject whose next bucket is
absent stays breached. Its escalation clock keeps running, because it measures
time since the breach. Its recovery dwell does not advance.

**Peak windows (S9).** With `peak_mode = 'manual'`, a bucket inside one of the
`peak_windows` is evaluated and its state moves, but no alert or intention is
written. The output says `suppressed_peak_window`. The cell paints the same.

## 5 · The breach, for display and for evaluation (10 Nov ruling 1, S8, S11)

**`bob.bob_threshold_status(org, channels[], from, to)`**: SQL standard body,
invoker, under RLS, beside `bob_cell_state`. One row per subject and bucket:
- `status`: `breach`, `near`, `ok` or `not_evaluated`;
- `bound`, `value`, `severity`;
- `reasons`.

It reads thresholds and cells, and **never reads `evaluation_state` or
`response_rules`**. A threshold with no response colours red when it is
breaching. The evaluator calls this same function, so the display and the
evaluator share one implementation of "is it breaching".
- **Severity** (D-05, unchanged): `warning`, or `critical` when the value is
  more than 20 % past the bound.
- **Proximity** (D-05, unchanged): `near` within 20 % of the bound,
  display only. No alert is written for proximity (S8). If Federico wanted
  proximity alerts, they are a response with a `trigger_level`.

## 6 · `bob.evaluation_state` (D-05 key, amended 10 Nov ruling 3)

One row per `(org_id, subject_key, response_id)`, a tenant table under RLS,
written only by the evaluator:

| Column | Meaning |
|---|---|
| `threshold_id`, `channel_id`, `actor_type` | the subject, decomposed |
| `breached_since` | first sealed bucket of the current breach; NULL when not breached |
| `past_level_buckets` | consecutive sealed buckets past this response's level |
| `last_fired_at`, `last_alert_id` | the cooldown, and the alert it guards |
| `escalated_alert_id` | set once per breach (RS-04) |
| `inside_since` | first sealed bucket back inside the bound, for the recovery dwell |
| `last_bucket_evaluated` | idempotency, and the catch-up horizon (S13) |

`bob_app` reads it, and no application role writes it. A response with no
threshold breach history has no row until its first evaluation.

## 7 · The evaluation, one subject and response at a time

For each sealed, observed bucket after `last_bucket_evaluated`, in order:

1. **Breach starts.** The value is past the bound and `breached_since` is
   NULL: set it.
2. **Fire.** Past this response's level for its sustained buckets, and the
   cooldown is clear (`last_fired_at` is NULL, or older than the effective
   cooldown): write the alert, and the intention if it is an Action (§8).
   Then set `last_fired_at`. Inside the cooldown, write nothing.
3. **Escalate, once.** The breach has lasted the effective
   `escalation_after_seconds` since `breached_since` and
   `escalated_alert_id` is NULL: write a **new** `alert_log` row, one step up
   (`warning` → `critical`, `critical` stays), linked to the alert it
   escalates (S6). Escalation does not depend on acknowledgement (D-05
   point 4), does not reset the cooldown, and fires no intention.
4. **Recovery.** Back inside the bound for the effective
   `recovery_dwell_seconds`: write `alert_type = 'recovery'`, immediately,
   with no cooldown (D-05). Then **clear the cooldown**, `breached_since` and
   `escalated_alert_id` (5 Nov ruling 5). A bucket that oscillates inside one
   dwell produces no recovery, so there is no flap storm.

**Columns `alert_log` gains:** `threshold_id`, `response_id`, `subject_key`,
`channel_id`, `actor_type`, `bucket_start`, `escalates_alert_id`, and
`acknowledged_at`. `acknowledged_at` is nullable and nothing reads or writes
it in v1 (5 Nov ruling 4). Its comment says it is deliberate.
`alert_log.alert_type` gains `'escalation'`.

**Catch-up and idempotency (S13).** One pass processes, in order, the sealed
buckets after `last_bucket_evaluated`, up to 24 hours back. Older buckets are
skipped with the reason `catch_up_window_exceeded`. Two passes over the same
bucket write nothing the second time. A bucket rebuilt after it was evaluated
is not re-evaluated: alerts already fired are not revisited (D-12).

## 8 · Intentions and their refusals (D-31, S3)

An Action response's firing writes the alert first, then the intention
through `bob_outbox_admit()` with `alert_log_id` set (BOB-11 item 4).

**`bob.outbound_queue.state` gains `'suppressed'`**, with
`suppressed_reason TEXT` (NOT NULL when suppressed, NULL otherwise, by CHECK).
A new migration replaces `bob_outbox_admit()`. When the refusal is one of the
following, it **writes the row as suppressed instead of raising**:

| Reason | From |
|---|---|
| `rate_limit_per_hour` | rolling hour |
| `invocation_cap_daily` | rolling 24 hours |
| `concurrency_limit` | written and not drained |
| `binding_unverified`, `binding_failed`, `binding_stale` | the derived state (RS-31, the 21 Nov ruling) |
| `binding_disabled` | |

Structural errors **still raise**: another organization's response, a binding
that does not match the response, or a mutative binding with no limit. They
are a broken configuration, not a limit doing its job.

- A suppressed row counts toward no limit, and nothing drains it or moves it.
  The transition guard extends to it.
- The trace from alert to intention exists even when the intention was
  refused. "Why didn't it fire?" is a row.
- **Consumer impact.** A direct INSERT over a limit now returns a suppressed
  row, not an error. The Slice 6 tests that expected the error are rewritten
  test first to expect the row. Anything in Bob-New that relies on the error
  must read `state`.
- **AutoBotz execution stays off before Slice 8** (BOB-11). Slice 5 writes
  intentions and executes nothing.

## 9 · Who runs it (S1, S12)

- **`bob.bob_evaluate(org_id)`**, and inside it
  **`bob.bob_evaluate_at(org_id, at)`** with an injected clock. SECURITY
  DEFINER, owned by the migration owner, `search_path = bob, public`, in `bob`
  so a restore of `bob` alone carries it (F-47).
- **The tenant is an explicit argument** (F-02's obligation). NULL or an
  organization that does not exist raises. Every read and write is filtered on
  that argument, never on a claim.
- **No EXECUTE for PUBLIC, `bob_app`, `bob_feeder`, `bob_ai_ro` or
  `authenticated`.** No running service can fire alerts or intentions by
  hand, or move the clock. A guard discovers every `bob_evaluate*` function
  and asserts this.
- **Nothing schedules it in Slice 5.** pg_cron is not on P5 §6.3's approved
  list, and on a box it lives in one database of Bzzz's Postgres. Which caller
  runs it (pg_cron via `cron.schedule_in_database` from Bzzz's side, or a timer
  in `/opt/bob`) is a P5 question, after the Febor window. It is listed as an
  interim (§11).

## 10 · Findings and contract changes

- **F-48 · D-05 point 6 rested on a step that did not happen.** Federico ruled
  that step 6 drops `UNIQUE (org_id, metric_id)`. Slice 6 shipped the scope
  columns without dropping it. Closed in this slice (§2). Consumer check: any
  upsert in Bob-New with `ON CONFLICT (org_id, metric_id)` stops matching a
  constraint and fails. That repository is outside this one, so the PR names
  the check rather than making it.
- **F-49 · The D-31 refusal was built as an error, not a row.** Slice 6's
  admission raises over a limit. BOB-11 placed "a suppressed row with its
  reason" in step 19, and this slice builds it (§8).
- **Contract §11, retention moves from Slice 5 to P5 (S7).** Detaching and
  dropping partitions needs a scheduler, and the scheduler is P5's. The
  interim row changes its "When" from Slice 5 to "P5, with the evaluator's
  scheduler". F-02's cleanup stays in Bob-New until the same point. Proposed
  for 0.6, to Federico.
- **Proximity is display only** (§5) and **peak `observed` is refused with a
  reason** (§4). Both are build readings of rulings that carried over
  "unchanged". Stated so that Federico can disagree.

## 11 · Interim, named

| Interim in Slice 5 | Superseded by | When |
|---|---|---|
| Nothing schedules `bob_evaluate` | The P5 caller | After 30 Nov |
| Retention is not enforced | `pg_cron` or the P5 timer, detaching and dropping | Same |
| Intentions are written and never executed | Execution | Not before Slice 8 (BOB-11) |
| `acknowledged_at` is written by nothing | An acknowledgement surface | Not in v1 |

## 12 · Acceptance tests (`tests/slice5-thresholds.test.mjs`)

Each one is written first and seen failing against the chain without its
migration, or against a sabotage (the table goes into amendments).

**Step 6a**
1. A NULL duration resolves through the function, and replacing the function
   moves it. An explicit 1800 does not move.
2. Each of the three columns refuses 299, and accepts 300 and NULL.
3. Each default function refuses to return below 300 (sabotaged to 120).
4. `notification_rules.suppression_min` and `escalation_min` have no default.
5. Two thresholds on the same metric with different scopes coexist, and a
   duplicate scope is refused.

**What is evaluated**
6. The undeclared channel (`roster.sql:36`) is never evaluated: the reason is
   `lag_not_declared`, with no alert and no state row.
7. A `not_observed` bucket after a breach neither recovers nor breaches.
8. `hallucinations` with no ground truth is `not_configured`, never evaluated.
9. A provisional bucket on a declared channel is `not_sealed`.

**Colour**
10. A breaching threshold with no response returns `breach` from
    `bob_threshold_status`. A guard reads `pg_depend` and finds that it does
    not depend on `evaluation_state` or `response_rules`.
11. Severity is `critical` past 20 %, and `near` within 20 % writes no alert.

**Cooldown, escalation, recovery**
12. Two passes over the same sealed bucket write one alert.
13. A breach held for six buckets writes one alert under the 1800 s default,
    and two under an override of 300.
14. Two responses at different depths on one subject have independent
    cooldowns: the shallow one does not suppress the deep one.
15. At 7200 s sustained, exactly one escalation row, linked, one step up,
    never a second.
16. Recovery fires immediately after the dwell. A re-breach after recovery
    alerts again, inside what would have been the cooldown.
17. Oscillation inside one dwell writes no recovery.
18. `sustained_for_seconds = 600` fires on the second consecutive bucket, not
    the first.
19. A manual peak window moves state and writes nothing.
20. A 25-hour gap: buckets older than 24 h are skipped with
    `catch_up_window_exceeded`.

**Intentions (D-31)**
21. With `rate_limit_per_hour = 10`, the eleventh firing writes a
    `suppressed` row with reason `rate_limit_per_hour`. It is not drained, and
    it does not count toward the limit.
22. The same for the daily cap, concurrency, and an unverified or stale
    binding.
23. Another organization's response still raises.
24. Every intention the evaluator writes has its `alert_log_id`.

**Who runs it**
25. `bob_evaluate(NULL)` and an unknown org raise.
26. No application role, and not PUBLIC, holds EXECUTE on any `bob_evaluate*`
    (discovered, not listed).
27. Tenant B's thresholds are never read or written by an evaluation of
    tenant A.
28. `evaluation_state` is a tenant table: the tenancy suite discovers it with
    no new code.

## 13 · Migrations

After `20261126110000` on `main`, checked on 27 Nov:

| Number | Contents |
|---|---|
| `20261127100000_slice5_threshold_durations.sql` | §1, §2 (step 6a, the unique index, `notification_rules` defaults) |
| `20261127100100_slice5_response_levels.sql` | §3 |
| `20261127100200_slice5_threshold_status.sql` | §5 |
| `20261127100300_slice5_evaluation_state_and_alerts.sql` | §6, the `alert_log` columns |
| `20261127100400_slice5_outbox_suppressed.sql` | §8 |
| `20261127100500_slice5_evaluate.sql` | §7, §9 |

**The O-3 install chain's fingerprint changes.** The chain is frozen and
signed. These migrations are not added to the box install until Henry signs a
new fingerprint, after the Febor window.

## 14 · Open, outside this spec

- Who calls the evaluator, and with which role (P5).
- An approval surface for `awaiting_approval`, and an acknowledgement surface.
- Correlation of one problem across subjects (not v1, D-05).
- Volume thresholds derived from observed history (v1.1, 10 Nov ruling 4).
