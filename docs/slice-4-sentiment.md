# BOb v1 · Slice 4 · Sentiment — spec, the part that does not wait for D55

**Status: SPEC, proposed. Nothing is built. D55 is not signed.** This spec
draws Slice 4 up to the line D55 draws. Everything on the near side of the line
(§2) can be built test first the day Henry approves this document. Everything on
the far side is written in §9 as an **Open** section with a recommended option,
isolated so that changing the ruling changes one migration and one block of
tests (the shape Slice 7 used for D-33). Federico signs the product rulings;
this spec proposes.

Henry decided one thing in the grill that the contract left open (§1, U1: where
the mechanical weight lives). Nothing else in this document has been through a
grill with him yet, so it carries no «decided» column beyond U1 and U2.

**What Slice 4 is.** The sentiment panel's database side: the five states of
ORGA and of MECA read from `bob.proj_sentiment`, the mechanical weight that
blends them at read time, the label-failure counts beside them, the closing
sentiment, and FR-35 (MECA is absent where the channel declares no
`meca_rum`). Slice 3 already resolves *whether a sentiment cell exists and what
state it is in* (`bob_cell_state`, the `ORGA` and `MECA` rows of its §3). Slice 4
adds the **distribution** across the five states, the **blend**, and the
vocabulary that goes with them. The application only paints, as in Slice 3. The
routes are bob-web's, outside this repository.

**Done when:**
- the acceptance tests of §8 pass, each seen failing first;
- no figure is shown for a source that is not observed: an absent source is
  absent, never a zero share (§3, §4);
- changing the mechanical weight re-renders history and writes no row to
  `proj_sentiment` (contract §6.2);
- the five states plus the three failure values account for every customer turn
  at seal, in one function (§5);
- nothing in this slice reads, names or assumes how a label is produced (§2).

**Inputs.**
- Contract 0.5.3/0.6: §3.3 (the five states, `s0`–`s4`), §4 and §4.1 (sealing,
  `label_missing`), §5 (absent, zero, not configured), §6.1 (`abstained`,
  `classifier_down`, `label_missing`), §6.2 (`proj_sentiment`), §6.5
  (`proj_rum_signals`), §9.1 (`orga_conversation`, `meca_rum`).
- `docs/slice-3-absent-not-zero.md` §3 (the ORGA and MECA rows of the cell
  matrix), §8 (FR-32; «FR-35 itself stays in Slice 4») and §10.
- `docs/slice-5-thresholds.md` §5: `bob_threshold_status` reads the same cells,
  so a sentiment metric that gets a threshold needs no new machinery.
- `Documentation/contract-amendments.md`: A-12 (abstained is counted and is
  never a sentiment state), Q6, Q7 (`closing_count`), and the C2/C3 rulings
  (`label_missing`, a late label is a rebuild).
- Relevo task 14 (D55, «The AI drone… supersedes D51»), read to the Federico
  reply of 23 Nov. Used only to draw the line in §2 and to fill §9.

---

## 1 · Questions for Henry (U1 to U2, answered)

| | Decided |
|---|---|
| U1 | The mechanical weight is one number per organization in a new `bob.sentiment_config`. NULL means no blend: ORGA and MECA are shown apart |
| U2 | Deriving a MECA state from RUM signals is **not** in this slice. The reference feeder does not write `source = 'meca'` rows until Federico gives the rule (§7) |

U1 and U2 were answered with the recommended option on 27 Nov. Everything else
below is a proposal that Henry has not yet approved.

---

## 2 · What waits for D55 and what does not

The line is one question: **does the database need to know how, where or by
whom a label was produced?** It does not. `proj_sentiment` rows carry a
`source` (`orga` or `meca`) and a state. Slice 3 already ruled that a turn's
label arrives before the seal (a reading), after it (a late event and a
rebuild, C3) or never (`label_missing`). D55 changes *who* sends the label (a
relay in the box, to a provider the customer contracts) and nothing about the
shape of what lands.

| Piece | Depends on D55? | Where |
|---|---|---|
| The five states and the three failure values, as a read | No | §3, §5 |
| «Observed / not observed / not configured» for a sentiment cell and for a source | No | §4 |
| Mechanical weight and the read-time blend | No | §3.3, §6 |
| Closing sentiment as counts beside `resolved`, ORGA only | No | §3.2 |
| FR-35: MECA absent without `meca_rum` | No | §4 |
| Label failures beside the distribution | No | §5 |
| `bob.sentiment_config` and its migration | No | §6 |
| The read tests and the fixture rows they need | No | §8 |
| ORGA on chat: the producer of the label (relay, provider, model) | **Yes** | §9 |
| The per-source `sentimiento` switch: where it is stored and what an off switch looks like in a cell | **Yes** | §9, D55-a |
| Auto-off when the bench has not been re-run for the model in use, and how it is counted | **Yes** | §9, D55-b |
| Who consumes the label, and the one-month keep-or-switch-off test | **Yes** (product) | §9, D55-c |
| Whether anything the provider returns (themes, proposed topics) reaches `bob` | **Yes**, and not Slice 4 | §9, D55-d |
| Reference-feeder writing ORGA on chat from the relay | **Yes** | §9, D55-e |
| The MECA rule from RUM signals to a state | Not D55; **Federico's rule, still missing** | §7 |

**Febor's Monday install does not include Slice 4.** D55 is not signed, and
Federico's 23 Nov reply asks for it to be built «when it reaches the front of
the queue on its own merits». This spec does not change that. It makes the
reading side ready so that signing D55 adds one producer and one switch, not a
slice.

---

## 3 · The distribution (reads `proj_sentiment`)

### 3.1 Counts per state

`bob.bob_sentiment_panel(org, channels[], from, to)`: SQL standard body
(`BEGIN ATOMIC`, so a restore of `bob` alone carries it, F-47), **invoker**,
under RLS, in `bob`, beside `bob_cell_state`. One row per
`(channel_id, source, bucket_start)` with:

- `state` and `reasons` **from `bob_cell_state`**, not recomputed. The panel
  never decides whether a cell is observed; it asks the one implementation
  (Slice 3, §7);
- `s0_count` … `s4_count`: `reading_count` per state, `NULL` for all five when
  the cell is not `observed`;
- `labelled`: their sum, `NULL` when not observed;
- `abstained`, `classifier_down`, `label_missing`, `customer_turns`: §5.

**Counts, never percentages, are what the function returns** (PR-1). A share is
`s_i_count / labelled`, computed by the application, and **a bucket with
`labelled = 0` has no share**: it is `observed` with zero labelled turns, which
is a different thing from a distribution (§4).

### 3.2 Closing sentiment

`closing_s0_count` … `closing_s4_count`, from `closing_count`, **ORGA only**
(the CHECK in §6.2 already refuses a MECA row with `closing_count > 0`). Stored
and returned per state, never summed: the five states are ordinal and a sum of
them is not a state of anything. Closing sentiment sits beside `resolved`,
never blended into a resolution score (D-15). The function reads the bucket the
conversation **closed** in, as `closing_count` lands there (§3).

### 3.3 The blend

When `bob.sentiment_config.mechanical_weight` is set to `w` (0 to 1) and **both**
sources are `observed` with `labelled > 0` in the bucket:

`blended_share(s) = (1 − w) · orga_share(s) + w · meca_share(s)`

returned beside the two source rows, as an extra row with
`source = 'blended'`. Rules:

- **The blend is computed on shares, not counts**: ORGA counts turns, MECA
  counts a different unit, and adding them would let the bigger channel set the
  weight.
- **If either source is not `observed`, or has `labelled = 0`, there is no
  blended row for that bucket.** The panel does not renormalise onto the one
  that is there: «what the customer said» alone is not «what the customer said
  mixed with what the interface showed». The reasons say which one is missing
  (`blend_source_absent:orga` or `:meca`).
- **`mechanical_weight` NULL (no row, or the column NULL) means no blend.** The
  two sources are returned apart and `blended` rows do not exist. A weight of
  `0` is a weight (all ORGA); NULL is the absence of one.
- **The weight is read when the function runs**, never stored on the reading.
  Changing it re-renders history. A test pins that no `proj_sentiment` row
  changes.
- **Which channels the blend spans.** One weight per organization, applied per
  channel and bucket, then rolled up by summing counts across channels *before*
  taking shares. A channel without `meca_rum` contributes no blended row, and
  the rollup says so (`blend_partial` with the channel list) rather than
  quietly blending the others.

---

## 4 · The vocabulary: observed, not observed, not configured

Slice 3's `state` column, applied to sentiment without a new word. A reader of
the panel gets exactly these, from `bob_cell_state`:

| State | Meaning for a sentiment cell | Example reason |
|---|---|---|
| `observed` | A sealed bucket, with the capability declared. `labelled` may be 0; that is a real zero and the failure counts (§5) say why | `none_observed` when `customer_turns = 0` |
| `not_observed` | Capability declared, the bucket sealed, and no `proj_sentiment` row for the source | `no_rows_for_source` |
| `not_configured` | Nothing that could produce this was declared | `capability_not_declared:orga_conversation`, `capability_not_declared:meca_rum` |
| `pending` | Not sealed yet, or the channel declares no lag and so never seals (A-04) | `not_sealed`, `lag_not_declared` |
| `not_applicable` | The source cannot exist for this selection | (rare for sentiment) |

- **FR-35.** A selection that includes no channel declaring `meca_rum` gives
  MECA `not_configured` with `capability_not_declared:meca_rum`, a NULL figure
  and never a 0. The same selection still shows ORGA.
- **Voice produces no ORGA today** (mono audio has no turns; ruled 5 Nov and
  restated by Federico on 17 Nov). A voice channel has no `orga_conversation`
  declaration, so its ORGA cell is `not_configured`, not `not_observed`. This is
  declared, not inferred: no code maps a channel type to a capability (BOB-10).
- **An agent has no ORGA reading** (D-17). ORGA and MECA cells are channel
  grain. The panel has no `actor_type` column and the actor cells of Slice 3
  are unchanged.
- **`labelled = 0` on an observed cell is displayed as «no readings»**, not as a
  distribution of zeros. UI-03 holds: a NULL or 0 carries at least one reason.

---

## 5 · Label failures beside the distribution

The panel returns, per `(channel, bucket)`, the three failure counts from
`proj_metric_counts` (`user`, degenerate, §6.1) and the denominator:

| Column | From | Owner of the signal |
|---|---|---|
| `abstained` | `abstained`, `event_count` | tuning (the confidence bar) |
| `classifier_down` | `classifier_down`, `event_count` | operations |
| `label_missing` | `label_missing`, `event_count` | plumbing |
| `customer_turns` | their `session_count`, the true denominator | |

- **The identity the contract states is a test:** `labelled + abstained +
  classifier_down + label_missing = customer_turns` for every sealed `observed`
  ORGA bucket. When it fails the row is returned with
  `reasons = ['accounting_gap']` and an alert is the right response; nothing
  is quietly renormalised.
- **They are never a sixth state.** A sixth state would let FR-30 count it
  (A-12). A guard asserts no column of the panel is named like a state beyond
  `s0`–`s4`.
- **They are `not_applicable` for `asa`, `human` and `arep`** (Slice 3, §3) and
  `not_configured` without `orga_conversation`. MECA has no label failures: its
  cell never carries them.
- As metrics they already take a threshold and a response (Slice 5). The
  abstention rate is the instrument for tuning the bar.

---

## 6 · `bob.sentiment_config` and the migration skeleton

```sql
CREATE TABLE bob.sentiment_config (
  org_id            UUID PRIMARY KEY REFERENCES bob.organizations(id),
  mechanical_weight NUMERIC CHECK (mechanical_weight IS NULL
                                   OR mechanical_weight BETWEEN 0 AND 1),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

A tenant table under RLS on `org_id`, found by the tenancy suite with no new
code. `bob_app` reads and writes its own organization's row (INSERT and UPDATE
only, **no DELETE and no TRUNCATE**: F-50 and F-58 are the lesson), `authenticated`
reads it, no other role touches it. NULL by default: a new organization has no
blend until someone sets one.

**Migrations.** After `20261127100500` on `main`, and after `20261128100000`
and `100100` which Slice 7 reserved. The numbers are taken when the build
starts, from whatever `main` holds then; the order is what matters:

| Contents | Depends on D55 |
|---|---|
| `slice4_sentiment_config`: the table above, RLS, grants | No |
| `slice4_sentiment_panel`: `bob_sentiment_panel`, `BEGIN ATOMIC`, invoker | No |
| (later, §9) `slice4_d55_switch`: the switch and its cell reason | **Yes, written after D55** |

All three go in schema `bob` and create nothing in `public`: on a box every
migration outside the install chain is pushed by `bob_migrador`, which holds no
CREATE on `public` (F-51). The install chain, its fingerprint, `scripts/f58/`
and `supabase/provision/` are not touched by this spec; as with Slice 5, a box
installs these only after Henry signs the new fingerprint.

---

## 7 · What Slice 4 does not do

- **No rule from RUM signals to a MECA state (U2).** `proj_rum_signals` holds
  the inputs, `proj_sentiment` with `source = 'meca'` holds the output, and the
  contract (§6.5, «verbatim from §3.3») gives no function between them. This
  spec invents none. Until Federico gives one, **the reference feeder writes no
  `meca` rows and no `proj_rum_signals`**, as Slice 3 §8 already says. MECA
  renders `not_observed` where `meca_rum` is declared and the bucket is sealed,
  and `pending` where the channel declares no lag. The read side is complete
  and tested against rows the fixture writes by hand.
- No classifier, no model, no provider, no relay, no term matcher (BOB-16 is a
  different card).
- No screen. The panel is bob-web's.
- No new capability: `orga_conversation` and `meca_rum` already exist (§9.1).

---

## 8 · Acceptance tests (`tests/slice4-sentiment.test.mjs`)

Each is written first and seen failing against the chain without its migration
or against a sabotage (the table goes into amendments). The fixture gains
sentiment rows written by hand, with fictitious data only.

**Vocabulary (FR-35, UI-03)**
1. A selection with no channel declaring `meca_rum` gives MECA `not_configured`,
   `capability_not_declared:meca_rum`, a NULL figure, and ORGA still observed.
2. A declared channel, a sealed bucket and no ORGA row is `not_observed`, never a
   zero distribution.
3. A voice channel (no `orga_conversation`) gives ORGA `not_configured`, not
   `not_observed`.
4. An observed bucket with `customer_turns = 0` is a real zero with the reason
   `none_observed`; `labelled = 0` returns no shares.
5. Every cell the panel returns whose count is NULL or 0 has at least one
   reason, asserted over the fixture's whole frame (UI-03).

**Distribution**
6. The five counts equal `proj_sentiment.reading_count` per state, and
   `labelled` is their sum.
7. A bucket with no row for one state returns 0 for it, not NULL, when the source
   is observed.
8. Closing counts come back per state and never summed, ORGA only; a MECA row
   with `closing_count > 0` is refused by the table (already enforced) and the
   panel returns none.
9. The panel's `state` and `reasons` equal `bob_cell_state`'s for the same
   inputs, for every bucket (one implementation).

**Label failures**
10. `labelled + abstained + classifier_down + label_missing = customer_turns` on
    every sealed observed ORGA bucket; a sabotaged row returns `accounting_gap`.
11. The failure counts are `not_applicable` for the three non-customer actor
    types and `not_configured` without `orga_conversation`.
12. No column of the panel is a sixth state (a guard that discovers the
    function's output columns).

**The blend**
13. With `w = 0.25`, `blended_share` equals `0.75·orga + 0.25·meca` per state,
    computed on shares.
14. Changing `w` changes the blended row and changes no `proj_sentiment` row
    (a checksum of the table before and after).
15. MECA not observed, or `labelled = 0`: no `blended` row, reason
    `blend_source_absent:meca`. ORGA alone is not renormalised.
16. `w = 0` gives all ORGA, and `w` NULL gives no `blended` row at all.
17. A rollup over two channels, one without `meca_rum`: counts are summed before
    shares, and `blend_partial` names the channel left out.

**Security**
18. The function is invoker and has a `BEGIN ATOMIC` body; a guard discovers it
    by name and by `prosecdef` (the Slice 3 pattern), so a restore of `bob`
    alone carries it.
19. Tenant B's rows never appear in tenant A's panel, and tenant B's weight is
    never read for tenant A.
20. `bob_app` can INSERT and UPDATE `sentiment_config` for its organization and
    nothing else: no DELETE, no TRUNCATE, no write to another organization's row
    (found by the tenancy suite and the privilege guard, with no new code).
21. A weight of 1.5, or −0.1, is refused by the CHECK.

---

## 9 · Open: D55

**D55 is the decision that replaces D51 for chat** («The AI drone · a per-customer
VPS for all AI work», Relevo task 14, BOB-14). Federico ruled its shape on 13 to
23 Nov. It is not signed: Henry has not signed it and Federico asked on 23 Nov
that it be built when it reaches the front of the queue. This section writes
what Slice 4 would do under the recommended reading and what it would take to
change it. **Nothing here is built.**

**What is ruled in the thread and carried as given** (not decided by this spec):
chat always enters the box; the relay sends redacted text to a provider the
customer contracts; redaction is best effort and never a gate; what comes back is
untrusted and passes Presidio on arrival; the label is **async**, with three
named outcomes (a label before the seal is a reading, after it a late event and a
rebuild, never is `label_missing`); an unbenched model turns the switch off and
the readings count as `fallo`, loudly; the switch is per source and needs the
customer's written acceptance; and **no consumer is named** at Febor.

### D55-a · The `sentimiento` switch, and what an off switch looks like

*Recommended:* **the switch is not a database object of `bob`.** It lives with the
relay (P5). The database sees only its effect, which is that no ORGA row arrives
for that source. The cell for a channel whose switch is off reads
`not_configured`, reason `sentiment_switch_off`, when the **feeder declares it**
by dropping `orga_conversation` for the channel (the capability is presence-only
configuration, BOB-10). No new column, no new table.

*To change it:* if D55 wants the database to hold the switch, add
`slice4_d55_switch` (§6): a per-channel `sentiment_switch` row, with
`bob_cell_state` reading it for the reason. One migration, tests 22–23 below.
**The recommendation is a single reason string,** `sentiment_switch_off`, defined
in one place; renaming it changes one constant and the tests that name it.

### D55-b · The auto-off when the bench is stale, and how it is counted

*Recommended:* **auto-off counts as `classifier_down`**, the operations signal,
not as a new metric. Federico's accepted wording is «`fallo`», D51's term for a
failed label that is never added to `abstencion`; `classifier_down` is the
contract's metric that «asserts the cause» (§6.1) and already takes a threshold
and a response. The loudness Federico asked for («something somebody sees on
the same day») is a **Slice 5 alert on `classifier_down`**, which needs no new
machinery. The role address that receives the provider's notices is not a
database concern.

*To change it:* `fallo` becomes its own `metric_id` (a CHECK change on
`proj_metric_counts` and `proj_actor_metrics` and a new row in the Slice 3 cell
matrix), which is a contract change and goes to Federico. The recommended
reading avoids that.

### D55-c · The consumer and the keep-or-switch-off test

*Recommended:* **Slice 4 is built behind a named consumer, or not at all.**
Federico's reply says nobody at Febor is named and that the test is «whether
anyone opens it in the first month, and whether one conversation is handled
differently because of a label». The database can report the first half, and the
spec proposes nothing for it: opening a panel is bob-web's telemetry. If Diana
names a supervisor in the acceptance conversation, this slice moves up the queue
and the build starts.

*To change it:* nothing in the schema moves. This is a priority call, and it is
Henry's.

### D55-d · What the provider returns besides a label

*Recommended:* **out of Slice 4.** Themes, proposed topics and questions are
BOB-16, which has its own registry and its own cap. They do not enter
`proj_sentiment`, and the closed return form (the five states plus `abstained`
and `classifier_down`) is what this slice reads.

### D55-e · The reference feeder and ORGA on chat

*Recommended:* **the reference feeder keeps writing ORGA from fictitious labels
in the fixture only**, as today, and D55's relay becomes a second producer of the
same rows through the same `bob_feeder` path. No change to the feeder's contract.
The async rule needs no new code: a late label is already a rebuild (C3), and the
label that never comes is already `label_missing` (C2).

*To change it:* if D55 asks the relay to write straight to `bob`, that is a new
role and goes to P5, not to this slice.

### Tests that exist only under D55 (written after signing)

22. With the switch off for a channel, its ORGA cell is `not_configured`,
    reason `sentiment_switch_off`, and a non-NULL figure is a test failure.
23. An auto-off period reads as `classifier_down` counts, never as `abstained`,
    and the accounting identity of §5 still holds.

---

## 10 · Findings

- **F-60 · The MECA cell's figure is a placeholder.** `bob_cell_state`
  (`20261121200100`, the MECA branch) emits `0::numeric` for a RUM row and says
  «its figure is the MECA readings». The second `proj_sentiment` branch also
  emits `meca` rows, with `reading_count`. Whether the two collide into one cell
  with the right figure is **not verified in this spec**; the first build test
  (§8, 1 and 9) decides it, and a bug found goes in a migration that replaces
  the function, never in an edit of the applied one.
- **F-61 · The mechanical weight has no home.** The contract says the blend is
  computed «from the configured mechanical weight», and nothing in the schema
  configures one. Henry decided (U1) that it is `bob.sentiment_config`. Proposed
  for 0.6, to Federico.
- **F-62 · No rule from RUM signals to a MECA state.** §6.5 says the signals
  are «verbatim from §3.3» and §6.2 stores a state, with no function between
  them. U2 leaves it to Federico; until it arrives, MECA is absent by
  construction (§7).

(F-60 to F-62 are taken after checking `main` and the open branches on 27 Nov:
the highest in use is F-59, and Slice 7's are F-56 and F-57.)

---

## 11 · Interim, named

| Interim in Slice 4 | Superseded by | When |
|---|---|---|
| MECA has no producer | The Federico rule, §7 | Not scheduled |
| ORGA on chat has no producer outside the fixture | D55's relay | After D55 is signed |
| The switch is outside the database | D55-a, if D55 wants it inside | With D55 |
| No screen | bob-web | Outside this repository |

## 12 · Open, outside this spec

- Who consumes the sentiment label at Febor (D55-c).
- Febor's written acceptance and who signs it (D55, q12).
- The MECA rule (§7), and whether the weight should ever vary by channel.
- Coherence, which needs the agent side and is deferred.
