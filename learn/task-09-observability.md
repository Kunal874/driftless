# Task 9 — Observability and benchmarks, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 9

Until now, the only way to know how Driftless was doing was to read its log lines. Task 9 makes it **measurable
from the outside**, which is how production systems are watched:
1. Driftless serves its numbers at `GET /metrics` (port 9464), in the format **Prometheus** reads.
2. **Prometheus** collects those numbers every 5 s and keeps them as time series; **Grafana** draws them.
3. With that in place, we **benchmarked freshness**: how long after a commit in Postgres the change is searchable,
   at increasing write rates, and found where the time actually goes.

---

## 1. The vocabulary: Prometheus, metrics, Grafana

**Prometheus** is a database for numbers over time, plus a collector. Every few seconds it fetches ("scrapes")
a plain-text page from each service it watches and stores every number with a timestamp. The service doesn't push
anything: it just answers `GET /metrics`. That's the **pull model**: if Driftless dies, Prometheus notices
(`up = 0`) instead of silently receiving nothing.

A `/metrics` page looks like this (real lines from Driftless):

```
driftless_changes_applied_total{op="update"} 948
driftless_txns_in_flight 0
driftless_lag_seconds_bucket{le="2.5"} 1251
```

There are three kinds of metric, and choosing the right one matters:

| Kind | What it is | Driftless examples |
|---|---|---|
| **Counter** | only goes up (resets to 0 on restart) | `driftless_changes_applied_total{op}`: you look at its *rate* (changes/s), never its value |
| **Gauge** | a value right now, up or down | `driftless_changes_waiting`, `driftless_txns_in_flight`, `driftless_slot_retained_wal_bytes` |
| **Histogram** | counts of observations per range ("bucket") | `driftless_lag_seconds`, `driftless_write_seconds`, `driftless_batch_changes` |

**Labels** (`{op="update"}`) split one metric into several series. Keep them few and fixed (insert/update/delete),
never per-row ids: every distinct label value is a new series Prometheus has to store.

**Grafana** is the dashboard: it sends queries (in **PromQL**, Prometheus's query language) and draws the answers.
`rate(driftless_changes_applied_total[30s])` means "how fast did this counter grow, per second, over the last 30 s".

`prom-client` is the Node library that keeps the counters in memory and renders the text page.

## 2. Why a histogram for lag, and how p99 comes out of it

We want "p99 lag": the time under which 99 % of transactions became searchable. Storing every single lag value would
be expensive, so a histogram keeps only **counts per bucket**: "1,251 transactions took ≤ 2.5 s, 2 took ≤ 1 s, …".
Buckets are cumulative (each `le` = "less than or equal").

To get p99 from buckets: find the bucket where the cumulative count crosses 99 % of the total, and **interpolate
linearly** inside it. That's what Prometheus's `histogram_quantile` does, and what `scripts/bench-lag.ts` does too.
We checked the script against Prometheus on the same run: identical to two decimals (p50 2.19 s, p99 2.89 s).

**The catch: a quantile is only as precise as the buckets around it.** The first buckets jumped from 1 s to 2.5 s
to 5 s, and p99 came out as 4.95 s, which really only meant "somewhere in 2.5–5 s". So the buckets were made fine
where lag actually lives on this setup (0.5 to 10 s, in ¼–1 s steps).

**Taking a benchmark's numbers from two snapshots.** Histograms count since the process started. To measure one
run alone, `bench-lag.ts` scrapes before and after the run and subtracts bucket by bucket. Whatever happened
before the run can't leak into its numbers.

## 3. Where exactly lag is measured

Lag = *the moment a transaction becomes confirmable* − *its commit time in Postgres*.

"Confirmable" is deliberate. A transaction can be fully applied in Meilisearch but still wait behind an older,
unfinished one (Task 6's checkpointer rule). Until that older one finishes, a crash would replay both, so
the newer one isn't truly "done". The `Checkpointer` now takes a callback that sees each transaction at exactly the
point it becomes confirmable, and that's where `lag.observe(...)` happens.

**Clocks.** The commit time comes from Postgres's clock (it travels in the WAL's COMMIT message); "now" comes from
Driftless's clock. Lag is only meaningful if they agree, so benchmarks run Driftless in Docker, next to Postgres. We
checked from inside the connector container: the clocks differ by less than 1 ms.

## 4. Gauges that cost nothing between scrapes

Values like "changes waiting" already live in `main.ts` (`queue.length + lanes.queued()`). Instead of copying them
into a metric on every change, the gauges have a `collect()` function that **reads them at scrape time**. Zero cost
on the hot path, and they can never drift out of sync.

The one gauge that needs a database query is **retained WAL**: how much WAL Postgres is keeping because of our slot
(`pg_current_wal_lsn() − restart_lsn`). That's the cost a stalled Driftless puts on the database (capped at 1 GB in
Task 8). It uses its own one-connection pool. If Postgres is unreachable, it reports `NaN` (unknown) rather than
failing the whole page.

## 5. Grafana as code (provisioning)

The dashboard isn't clicked together in a UI. It's a JSON file in the repo (`docker/grafana/dashboards/`), loaded at
start by Grafana's **provisioning**. `allowUiUpdates: false` makes the file the only source of truth. Anyone who
runs `docker compose --profile metrics up -d` gets the same dashboard, and changes go through git like code.

Small details that matter:
- The datasource has a fixed `uid` (`prometheus`), and panels refer to it by that uid. A uid survives a rename.
- `$__rate_interval` instead of a fixed `[10s]`: Grafana picks a `rate()` window that always holds enough samples
  for the scrape interval (5 s). Too short a window holds one sample and draws gaps.
- "Restarts" is `changes(driftless_process_start_time_seconds[$__range])`: the process start time changes on
  every restart, so counting its changes counts crashes, with no extra code.
- Ports are bound to `127.0.0.1` and Grafana allows anonymous **view-only** access, which is fine for a local stack
  and not something to copy to a server.

## 6. The first scrape told a story: where lag really goes

The very first `/metrics` read at 200 tx/s showed about **2 s of lag, every transaction between 1 and 2.5 s**. A
spread that tight doesn't look like queueing (queueing gives a long tail). It looks like a **fixed cost**. The
investigation, step by step:

1. **Is it a clock problem?** From inside the connector container: Postgres's `clock_timestamp()` vs `Date.now()`,
   less than 1 ms apart. The library's timestamp decoding (microseconds since 2000 → Unix epoch) was correct too.
2. **Is it the writes?** Only 80 writes for 1,251 changes in 10 s on 8 lanes: each write took ~1 s.
3. **Where inside Meilisearch?** Meilisearch records every task's `enqueuedAt` / `startedAt` / `finishedAt`, and
   `GET /batches` returns a `progressTrace` per batch. A batch of ~70 documents took **560 ms**, and **420 ms** of
   that was `post processing words > word fst`.

An **FST** (finite-state transducer) is a compact, sorted dictionary of every distinct word in the index. Meilisearch
rebuilds it on each batch, so its cost grows with the **vocabulary**, not with the batch size. Our synthetic
workload grows the vocabulary forever: every description rewrite adds a random `md5(...)` word that has never
existed before. Real product text repeats words, so it wouldn't behave like this.

**What we did about it: measured it, explained it, didn't hide it.** We did *not* change Meilisearch settings to
make the number look better. We added one more histogram, `driftless_write_seconds`, so the split is always
visible: lag ≈ **1.7–1.9 × one write** at every rate. A change usually arrives while its lane's write is in flight,
waits for it, then rides the next write.

## 7. The benchmark (RESULTS §8)

`scripts/bench-lag.ts RATE 60 CLIENTS` runs the standard workload at a fixed rate for 60 s and reports lag
quantiles, write time, batch size, the deepest queue, and how long Driftless took to **catch up** after the load
stopped.

| Rate (achieved) | Lag p99 | Changes per write | Caught up after |
|---|---|---|---|
| 200 | 3.97 s | 21 | 1.5 s |
| 500 | 3.64 s | 58 | 2.0 s |
| 1,000 | 4.88 s | 139 | 2.5 s |
| ~1,860 | 7.92 s | 385 | 3.5 s |
| ~3,840 | ≤ 15 s | 1,318 | 8.5 s |
| ~4,780 | 15–30 s | 1,735 | 10.1 s |

How to read it:
- **"Kept up" doesn't mean "low lag"; it means "lag doesn't grow".** A flat 15 s lag is a steady state. A lag that
  grows every minute is falling behind, and it never comes back. The catch-up time after the stop (always ≤ 10 s)
  and the queue rising and falling (never climbing) show Driftless kept up at every rate.
- **Natural batching did the work.** From 200 to ~3,840 tx/s, writes per second actually *fell*, while each write
  carried 63× more changes. No timer and no tuning: batches grow by themselves when there's more to send.
- **The top rates were the load generator's limit, not Driftless's.** pgbench fell behind its own schedule above
  ~1,000 tx/s (it reports "schedule lag"). That's as fast as Postgres in this Docker VM could commit.

## 8. The surprise: more lanes, more lag (RESULTS §9, D-027)

At a steady 1,000 tx/s: **1 lane: p99 3.84 s. 8 lanes: 4.99 s. 1 lane again: 3.78 s. 4 lanes: 6.50 s.**

Running 1 lane, then 8, then 1 again (**A-B-A**) was deliberate. The index grows during every run, so a single
before/after pair can't tell "8 lanes is slower" apart from "the index got bigger in between". Getting the same
answer twice for 1 lane rules out the drift.

Why? Meilisearch's task timestamps answered it:
- Meilisearch indexes **one batch at a time per index** and merges every queued task into that batch.
- With 8 lanes, 8 tasks sit in its queue; each waits **~1 s** behind the batch in progress before indexing starts.
- With 1 lane, a task waits **~0.03 s**. The waiting still happens, but *inside Driftless*, where pending changes
  pile up for free and ride the next write.

So against this sink, extra lanes add waiting, not parallel indexing. **But for a backlog,** on the same index:
8 lanes drained 2,810 tx/s vs 1,700 (1 lane) or 2,132 (1 lane with an 8× bigger batch cap). Parallel requests still
overlap the HTTP, JSON and polling around each batch.

**Decision D-027:** keep 8 lanes by default (catching up after downtime is when speed matters) and document
`DRIFTLESS_LANES=1` as the low-lag setting. The lesson is general: **parallelism in front of a serial resource
shortens nothing; it only moves where things wait.**

**Another honest correction:** Task 6's 6,752 tx/s was measured on a ~105k-document index. On today's 195k-document
index, the same command gives 2,810 tx/s. A throughput number belongs to its dataset, so RESULTS now says which.

## 9. The headline chaos run

The run every other number rests on: `scripts/chaos.sh 1200 30 1000`. That's **20 minutes at 1,000 tx/s, with the
connector SIGKILLed at random moments about every 30 s**, then a full row-by-row reconcile.

| Transactions | Kills | Rows = documents | Missing / extra / mismatched |
|---|---|---|---|
| 1,197,314 (0 failed) | 36 | 261,113 = 261,113 | **0 / 0 / 0** |

Compared with Task 6's run (200 tx/s, 10 min, 20 kills, ~120k transactions), this one is 5× the rate and 10× the
transactions. At 1,000 tx/s each kill throws away seconds of applied-but-unconfirmed work, and all of it is
replayed after the restart. Idempotent writes make the replays harmless (Task 4), and confirming only the unbroken
prefix (Task 6) means nothing is ever skipped.

Three independent counts agree on 36 restarts: the chaos script's kill counter, the connector's log (36 start
lines in the window), and the dashboard's `changes(driftless_process_start_time_seconds[…])`. Mid-run, the
Grafana "Restarts" panel read 20 just after kill #20.

**Lag under chaos is not the lag of §7.** p99 rose to ~27 s during the run, because every kill costs a restart
(Node start-up, reconnecting the slot) plus replaying unconfirmed work. That's the price of fail-stop recovery. The
claim this run proves is about **correctness, not speed**: no change was lost or applied wrong, whatever moment the
kill hit.

### Two small things that went wrong on the way

- **A `sed` delimiter clash.** Editing docs with `sed 's#…#…#'` failed on a line containing `## Flow`, after an
  earlier `sed` in the same command had already succeeded. A follow-up "replace if found" script then appended a
  line's new ending a second time. Lesson: after a failed multi-file edit, diff before re-applying anything.
- **Backticks are commands in bash.** A Node one-liner that edited this file sat inside bash double quotes and held
  the Markdown text `` `scripts/chaos.sh 1200 30 1000` ``. Inside double quotes, bash treats backticks as **command
  substitution**, so it *ran a second chaos run*. The edit seemed to "hang"; it was really a 20-minute run. Stopping
  the task killed the kill loop but not its background pgbench, which kept writing 1,000 tx/s while the connector
  sat dead after kill #2. Found it because a final check showed the connector exited (137) *after* the real run had
  ended; `docker inspect` gave the time, and `ps` showed the orphaned pgbench. Fix: kill that pgbench, restart the
  connector. The slot held only 35 MB (cap 1 GB), and reconcile came back **274,776 = 274,776, 0 / 0 / 0**:
  an unplanned crash-plus-outage test, passed. Lessons: never put text with backticks inside bash double quotes
  (use a file edit or a quoted heredoc), and when a command "hangs", find out what it is *doing* before stopping it.
- Plain file edits avoid both problems.

## 10. If an interviewer asks…

- **"How do you know your sync is fresh?"** A lag histogram from commit time (carried in the WAL) to the moment the
  transaction is applied *and* everything before it is too. Exported to Prometheus, p50/p99 on a Grafana dashboard.
- **"What's your p99 lag?"** Under 4 s at 500 tx/s, under 5 s at 1,000 tx/s, end to end into Meilisearch. Then
  explain where it goes: ~2 × one Meilisearch write, and a write is mostly Meilisearch rebuilding its word
  dictionary. Knowing *why* matters more than the number.
- **"Why a histogram and not an average?"** An average hides the tail. p99 is what the unluckiest users see, and a
  histogram gives any quantile cheaply (counts per bucket, not every value). Its precision is the bucket width, so
  put fine buckets where the values actually fall.
- **"Did adding parallelism help?"** For draining a backlog, yes (+65 % over 1 lane on the same index). For steady
  latency against Meilisearch, no: it made p99 worse, because Meilisearch indexes one batch at a time and the extra
  lanes only queue behind each other. A measured trade-off, recorded as a decision.
- **"Pull or push metrics?"** Pull (Prometheus scrapes). A dead target shows up as `up = 0` instead of as silence, and
  the service doesn't need to know where metrics go.
- **"How did you make the benchmark fair?"** Same machine clock for both timestamps, numbers from before/after
  snapshots of each run, quantile math checked against Prometheus, A-B-A ordering when the dataset drifts, and the
  load generator's own achieved rate reported next to the target.

---

## Glossary

- **Prometheus**: a time-series database that *pulls* metrics from services over HTTP every few seconds.
- **Scrape**: one such fetch of `GET /metrics`.
- **Counter / gauge / histogram**: only-up count / current value / counts per value range.
- **Label**: a key=value that splits a metric into series (`op="update"`); keep the set small and fixed.
- **PromQL**: Prometheus's query language (`rate(...)`, `histogram_quantile(...)`).
- **Quantile (p50, p99)**: the value under which 50 % / 99 % of observations fall.
- **Grafana**: dashboards over data sources such as Prometheus.
- **Provisioning**: Grafana loading datasources and dashboards from files at start ("dashboards as code").
- **FST (finite-state transducer)**: a compact sorted dictionary structure; Meilisearch keeps one of all its words.
- **Schedule lag (pgbench)**: how far behind its planned rate pgbench fell; > 0 means the target rate wasn't reached.
- **A-B-A test**: run A, then B, then A again, to separate the effect of B from drift over time.
