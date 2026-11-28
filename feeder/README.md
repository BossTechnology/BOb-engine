# The feeder

`reference-feeder.mjs` projects business events into BOb's projection tables
(projection contract §8). It reads from a *truth store*, an object with two
methods the run needs, `watermark()` and `events({from, to})`, and a third,
`memberRefsSeen(frame, page)`, used only by `stageMemberRefs`.

| Store | Reads | Used by |
|---|---|---|
| `memory-truth-store.mjs` | memory | the tests and the lab rehearsal |
| `vecinos-truth-store.mjs` | `bzzz-vecinos`, HTTPS with mutual TLS | `main.mjs`: the feeder on a box (task 3.7) |

`main.mjs` is the entry point: it reads its configuration, builds the HTTPS
store and runs `runFeeder`. Scheduling it, and the signed image that carries it
(P-H8), belong to the box's compose in Bob-New (`deploy/caja`), not here.

## Invoking it

The environment is defined in [`.env.example`](../.env.example). Secrets are
files (mode 600): the variables name the file. From the repository root:

```bash
# an ordinary run: the last BOB_FEEDER_LOOKBACK_SECONDS (a day) up to the watermark
node feeder/main.mjs

# a window, or a rebuild: stepped (BOB_FEEDER_STEP_SECONDS), one transaction per tenant per step
node feeder/main.mjs --from 2026-11-01T00:00:00Z --to 2026-12-01T00:00:00Z

# also ask for member_refs_seen: refused by name, reported, the run still completes
node feeder/main.mjs --member-refs
```

It prints one JSON line per event on stdout (`start`, `warning`, `step_done`,
`step_failed`, `member_refs_failed`, `report`) and never a credential. Exit code
`0` the run completed, `1` a step failed (the line says what to resume with),
`2` the configuration is wrong. Warnings and anomalies do not change the exit
code; they are in the output.

A run is idempotent. The feeder deletes the window and refills it (§8.5), so the
same window run twice, or two runs that overlap, leave the same rows.

## What it reads, and how

Two views of `bzzz-vecinos`, `GET /v1/bob/<view>`:

- **`eventos`**, by window `[desde, hasta)` of event time on the five-minute grain.
  The store cuts the range into windows of `BOB_VECINOS_WINDOW_SECONDS` (one day
  by default; configuration, not a constant) and pages each with the service's
  opaque cursor, `limite` up to 500. A window of ninety days in one query fails on
  the reader's memory; a day fits (Bzzz, `docs/OPERACION_vecinos.md` §5.1).
- **`marca_de_agua`**, per source. The store's watermark is the **minimum** of
  `ingerido_hasta` across the sources of this box's channels, never the latest:
  the slowest source is what makes a bucket complete. The watermark does not decide
  when to seal, the channel's declared lag does; the watermark is what lets the
  run notice that a declaration stopped being true. So `main.mjs` reads both and
  prints a `warning` for: a channel whose `source_key` has no source in the box (it
  would read as a quiet channel), a source that is in no channel, and a source
  whose newest arrival is older than its channel's declared lag.

The store sends no tenant: the box sets it (one box, one tenant). `main.mjs`
passes the same tenant to `runFeeder` as `boxTenant`, so that an event of another
tenant is counted as unmapped and never written, even where BOb holds a channel
for it.

Rows come back as arrays in the order of `columnas`; the store builds the
event the feeder reads (`event_time`, `bzzz.tenant`, `source_key`, `correlation_id`,
`event_name`, `attributes`) from the names, not from positions. The feeder depends
on the order of events (response time), so the store sorts by event time and does
not rely on the order of the view; where the view broke its own order, or repeated
a row, the store says so in `report.anomalies` (a repeated row is counted once).

## Failures and what they cost

| What happened | What the store does |
|---|---|
| 429, 503, a dropped connection, a timeout | waits (`Retry-After` if the service sends it, else `BOB_VECINOS_RETRY_BASE_MS` doubling) and asks for the **same page** again, up to `BOB_VECINOS_MAX_RETRIES` |
| any other refusal (400, 401, 403, 404, 502, 507) | fails at once, with the service's `error` code and status |
| retries exhausted | the call fails whole; no partial list is returned, nothing is written |
| an answer without a column the feeder reads | fails (`shape`), not a quiet gap |
| no source with a watermark | fails (`no_watermark`): the store does not say how far it is complete if it does not know |

## An interrupted rebuild: resume or start over?

Both, at two levels.

- **Inside a call** (the pages of a window), a cut that the retries cover resumes
  at the page: the retry carries the same cursor. This is tested.
- **Between calls**, the cursor is not saved anywhere. A call that fails after its
  retries starts over from the first page of its window when it is made again.
  Nothing persisted could make it do otherwise: the service's cursor is signed for
  one window's parameters and is only good for that call.
- **A rebuild** runs in steps; each step is one `runFeeder`, and each commits one
  transaction per tenant. A rebuild interrupted at minute forty of ninety has the
  steps before it written and the interrupted step not (or whole: a step is one
  transaction). `step_failed` prints the line to run again,
  `--from <that step> --to <the end>`: the steps already done are not repeated, the
  interrupted one starts over from its first page. Losing a step costs about a
  step's read time, not the rebuild.
- Nothing is checkpointed on disk, by design: the progress is in the database,
  and the printed `--from` is the checkpoint.

## Cost of a rebuild, and `BOB_FEEDER_READ_AHEAD_SECONDS`

Unset, each `runFeeder` reads up to the watermark, so that a label that arrives
after its turn is seen. A rebuild of a year by day would read every day since, for
each day: quadratic. Set it (a day is a reasonable start) and each step reads only
that far past its window; a label that arrives later than that reads as missing
at seal (`label_missing`). It is configuration because that trade is the
channel's, not the feeder's. Each step also reads `BOB_FEEDER_CONTEXT_SECONDS`
before its window (a day by default), so a day-step reads about two days of events:
the bench's "ninety minutes for thirteen months" is for one read of each day, and a
rebuild with these defaults should be expected to take about twice that. Not
measured.

## Known limits

- **`value` arrives as 0 when it was missing** (Bzzz, `bzzz-vecinos` `eventos`,
  stated 27 Nov 2026). The ingestion view stores an absent value as 0 and the view
  cannot tell the two apart. The store passes `value` through as it came, the
  feeder does not read it, and no projection depends on it today
  (`tests/vecinos-truth-store.test.mjs` sees both). Whoever first reads a zero
  from `value` is looking at "0 or absent": that is the absent-stored-as-zero shape
  this build exists to refuse, found inside the newest component.
- **`memberRefsSeen` is not covered.** `v1/bob/miembros_vistos` exists but is not
  wired: ghost creation on Febor waits for the E.164 cutover. `stageMemberRefs`
  reports `memberRefsSeen is not available` per tenant and goes on.
- **Nothing tells test events from real ones.** Nobody has decided where that is
  marked, or by whom. Febor's stream has none.
- **The service as a whole is not measured through this path:** mTLS, the audit
  write and the 20 s per request were not in Bzzz's bench, and its volumes were
  synthetic. The rebuild guarantee "from what `bzzz-vecinos` exposes" is stated and
  not yet verified through this path.
- **Whether `eventos` keeps `event_time` order across pages** is an open question
  to Federico; the store does not depend on it and counts the breaks.
- **Whether `miembro.id` travels in `attributes`** is open too. The view's
  `miembros_vistos` reads `attributes['miembro.id']`, which says it does; the store
  hands `attributes` over whole, and the feeder reads it from there (D47).
