# Results — measured numbers, with the exact commands

Every number in the README or on a resume must come from this file, and every entry here comes from a real
run, with its command, date, versions and machine (CONSTRAINTS rule 7). Unmeasured claims stay `[X]`.

## Machine and versions

| | |
|---|---|
| Host | Windows 11, Docker Desktop 4.83.0 (engine 29.6.2); the engine sees 28 CPUs and ~7.6 GiB RAM |
| Not a quiet machine | other projects' containers ran at the same time (online-judge-v2, reachinbox-scheduler) |
| Postgres / Meilisearch / Redis | 17.11 / 1.54.3 / 8.10.1 since T12 (pinned, D-010) |
| Driftless | Node 24.18.0 (`node:24.18.0-alpine` in the `connector` service), pg-logical-replication 2.5.0, meilisearch-js 0.62.0, @redis/client 6.3.0 (T12) |
| Metrics (T09) | prom-client 15.1.3; Prometheus 3.15.0 and Grafana 13.2.3 (profile `metrics`, not in the measured path) |
| Data | `db/seed.sql` 100,000 rows (deterministic, D-016), workload mix 60/20/10/10 (`scripts/workload.sh`) |

---

## 1. Correctness under crashes (T05)

**Command:** `scripts/chaos.sh DURATION KILL_EVERY RATE`. The connector is SIGKILLed at random gaps of
0.5–1.5 × KILL_EVERY and restarted; then `scripts/reconcile.ts` compares every row with its document.

| Date | Command | Kills | Transactions (failed) | Rows = documents | Missing / extra / mismatched |
|---|---|---|---|---|---|
| 2026-10-22 | `chaos.sh 60 10 5` (smoke) | 4 | 268 (0) | 100,005 = 100,005 | 0 / 0 / 0 |
| 2026-10-22 | `chaos.sh 600 30 5` | 17 | 2,995 (0) | 99,987 = 99,987 | 0 / 0 / 0 |
| 2026-10-22 | `chaos.sh 180 5 5` (harsh) | 27 | 899 (0) | 99,982 = 99,982 | 0 / 0 / 0 |
| 2026-10-22 | `chaos.sh 600 30 200` (T06: 8 lanes, batch ≤ 5000) | 20 | **119,764** (0) | 101,729 = 101,729 | 0 / 0 / 0 |
| 2026-10-22 | `chaos.sh 180 5 200` (T06, harsh) | 30 | 35,759 (0) | 102,327 = 102,327 | 0 / 0 / 0 |
| 2026-10-23 | **`chaos.sh 1200 30 1000` (T09 headline: 8 lanes, batch ≤ 5000)** | **36** | **1,197,314** (0) | **261,113 = 261,113** | **0 / 0 / 0** |

**T09 headline run** (2026-10-23 01:58–02:18 IST): 20 minutes at 1,000 tx/s, about ⅓ of the drain capacity on
that index (§9), so every kill threw away seconds of unconfirmed, partly applied work. 36 kills, and the connector
log shows 36 restarts in the run window, matching Prometheus (`changes(driftless_process_start_time_seconds[21m])` =
36). 0 fatal errors, backpressure never paused. Caught up 5.3 s after the load stopped; reconcile compared 261,113
rows in 9.2 s.

**Unplanned extra run (2026-10-23 02:19–02:25 IST):** a quoting mistake started `chaos.sh 1200 30 1000` a second time
(learn/task-09 §9). It ran ~2.5 min at 1,000 tx/s, SIGKILLed the connector twice, and was stopped mid-loop, leaving
the connector down for ~3 min while its pgbench kept writing. After the stray pgbench was stopped and the connector
restarted: caught up in 20.6 s, slot `reserved` with 35 MB retained, `node scripts/reconcile.ts`: 274,776 rows =
274,776 documents, **0 / 0 / 0**. Not counted in the table: no planned command, and the kill count is approximate.

T06 runs at 200 tx/s: at that rate 60–100 transactions are in flight at any moment (stats line, §4), so every
kill threw away unconfirmed, partly applied work. Caught up 0.5 s and 2.1 s after the load stopped; 51 connector
starts, 0 fatal errors.

- Over the three runs, **48 SIGKILLs**. The connector log shows 51 starts and **0 fatal errors**.
- **The kills hit in-flight work:** 31 transactions were handled, killed before their ack, and handled
  again after the restart (the same xid appears twice; e.g. xid 10098 resumed at `0/E6D0D20`, before
  its end `0/E6D0F08`). All replays were absorbed: 0 drift.
- **No new bug was found** by these runs. (The bug found so far is BUG-001, found by reading the
  library's source, in T03.)
- Limits: the rate is 5 tx/s because of the single-lane limit below; only the connector is killed (not
  Meilisearch or Postgres).

## 2. Reconcile cost (T05)

| What | Result |
|---|---|
| Compare 100,000 rows with their documents (1,000-id chunks) | 4.5–4.8 s |
| Self-test (planted 1 mismatched, 1 missing, 1 extra) | all 3 found, restored to 0: PASSED |

## 3. Throughput baseline before batching (T04)

Read from the connector's log lines (`applied in N ms`); proper fixed-rate benchmarks are T09.

| What | Result |
|---|---|
| Small transaction, one Meilisearch task each (host) | 99–110 ms → about **10 transactions/s** with one in flight |
| Small transaction (inside the `connector` container) | 68–96 ms |
| One 100,000-row transaction (ten 10k-document writes) | 4.1 s |

This is the "before" number for T06 (lanes + batching across transactions).

## 4. Throughput with lanes and batching (T06)

**Backlog drain:** `scripts/bench-drain.sh LANES BATCH_MAX RATE SECONDS`. It writes a backlog with the standard
workload while Driftless is stopped, starts the `connector` service with those settings, and times until
caught up (including ~1 s of container start-up), then reconciles. Every run below ended with **0 drift**.

| Date | Command | Backlog (txns) | Drained in | Throughput |
|---|---|---|---|---|
| 2026-10-22 | `bench-drain.sh 1 1 200 10` (unbatched) | 2,031 | 234.0 s | **9 tx/s** |
| 2026-10-22 | `bench-drain.sh 1 500 600 30` | 17,923 | 11.1 s | 1,613 tx/s |
| 2026-10-22 | `bench-drain.sh 1 5000 600 30` | 17,666 | 3.8 s | 4,682 tx/s |
| 2026-10-22 | `bench-drain.sh 8 500 600 30` | 18,040 | 3.7 s | 4,910 tx/s |
| 2026-10-22 | `bench-drain.sh 8 5000 600 30` | 17,852 | 2.6 s | **6,752 tx/s** |

(First attempt with ~2,000-transaction backlogs: 935 / 1,286 / 1,227 tx/s. Those drains took 1.6–2.1 s, mostly
start-up, too short to separate the settings, so the backlog was raised to ~18,000.)

**Bulk load:** re-seed 100,000 rows (`db/seed.sql`: one TRUNCATE + one 100k-row transaction) with the connector
running at 8 lanes. Time from the seed finishing until caught up:

| batchMax | Caught up after | Drift |
|---|---|---|
| 500 | 6.9 s | 0 |
| 5,000 | 3.2 s | 0 |

**Decision from these numbers:** defaults are 8 lanes and `batchMax` 5000 (D-022). That's **~750×** the unbatched
throughput on this machine (lower bound: start-up time is included).

**These numbers depend on the index (re-measured in T09, 2026-10-23).** The same command on a bigger index (195,393
documents vs ~105,000, and a much larger vocabulary, see §8) drains **2,810 tx/s** instead of 6,752. Meilisearch's
cost per batch grows with its word dictionary. Same-index comparisons are in §9.

**Steady load:** at 200 tx/s for 30 s (5,805 transactions), Driftless kept up throughout: caught up 13 ms after
the load stopped, ~5 changes per write, 60–100 transactions in flight. 0 drift.

## 5. Backfill under load (T07)

**Command:** `scripts/backfill-race.sh DELAY_MS RATE SECONDS [KILL_EVERY_S]`. It empties the index and its backfill
progress, starts Driftless with backfill on, writes with the standard workload meanwhile, then reconciles every row.
`DELAY_MS` holds each chunk's read→write window open longer, to make races likely.

| Date | Version | Command | Backfilled | Concurrent tx | Result |
|---|---|---|---|---|---|
| 2026-10-22 | naive (`9852dce`) | `backfill-race.sh 0 0` (no load) | 102,327 rows / 73 s | 0 | 0 drift |
| 2026-10-22 | naive | `backfill-race.sh 300 200 150` | 104,516 | 29,885 | **DRIFT 42** (40 older values, 2 resurrected): BUG-002 |
| 2026-10-22 | naive | `backfill-race.sh 0 200 100` | 104,250 | 19,845 | 0 drift (window ms-wide; see BUG-002) |
| 2026-10-22 | watermarks, keys only | `backfill-race.sh 300 200 150` | 105,288 (47 dropped) | 29,549 | **DRIFT 1** (missing description): BUG-003 |
| 2026-10-22 | watermarks, column-aware | `backfill-race.sh 300 200 150` | 105,867 (42 dropped, 1 filled) | 30,171 | 0 drift |
| 2026-10-22 | + saved progress | `backfill-race.sh 300 200 150 20` (6 SIGKILLs) | resumed 6×, 105,175 total | 30,055 | 0 drift |
| 2026-10-23 | final | `DRIFTLESS_BACKFILL_CHUNK=1000 backfill-race.sh 300 200 150` × **10** | 107,308–114,808 per run | ~30,000 per run | **0 drift in 10 / 10** |

The 10 final runs used 1,000-row chunks on purpose (≈105 race windows per run instead of ≈11). Across them,
**420** snapshot rows were dropped because the stream had a newer value (the naive version would have written each
back), and **9** were only filled in (each would have been a BUG-003 document missing its description).

## 6. Slow sink: Meilisearch frozen under load (T08)

**Command:** `scripts/slow-sink.sh PAUSE_S RATE MAX_PENDING`. It freezes Meilisearch with `docker pause` while the
workload writes, samples the connector's memory (`docker stats`) and the WAL Postgres holds for the slot every 15 s,
then unfreezes and reconciles.

| Date | Command | Connector memory during the freeze | WAL held by the end | Fatal errors | Drift |
|---|---|---|---|---|---|
| 2026-10-23 | `slow-sink.sh 90 200 2000` | flat ~42 MiB | 8.2 MB | 0 | 0 |
| 2026-10-23 | `slow-sink.sh 300 600 50000` | rose to ~88 MiB, then flat once paused | 79 MB | **1** (HTTP 408, BUG-004) | 0 |
| 2026-10-23 | `slow-sink.sh 300 600 100000000` (cap effectively off) | **45 → 220 MiB, still rising** | 105 MB | 0 | 0 |
| 2026-10-23 | `slow-sink.sh 300 600 50000` (re-run, full log kept) | ≤ 100 MiB | 79 MB | 1 (408 captured) | 0 |
| 2026-10-23 | `slow-sink.sh 300 600 50000` (after the BUG-004 fix) | 75–128 MiB (GC) | 111 MB | **0** | 0 |

Each 5-minute run wrote ~216,000 transactions. With the cap, reading pauses at 50,000 waiting changes and the backlog
waits in Postgres's WAL. Without it, everything is pulled into memory, which only grows. The connection survived every
freeze, including the 5-minute ones, far beyond `wal_sender_timeout` (1 min), thanks to the 10 s status re-send.
Memory during the *catch-up* after the freeze peaked at ~300 MiB (8 lanes × up to 5,000-document writes in flight):
a bounded working set, not a growing queue.

## 7. WAL safety: a dead Driftless can't fill the disk (T08)

Experiment (2026-10-23, Driftless stopped throughout steps 1–3; `max_slot_wal_keep_size` lowered to 32 MB with
`ALTER SYSTEM` just for the test, then reset):

| Step | Slot |
|---|---|
| start | `reserved`, 12 MB of WAL held |
| after 5,991 transactions Driftless missed | `reserved`, 15 MB |
| after 1.5M rows into an unrelated table | **`unreserved`, 153 MB** (past the cap) |
| after `CHECKPOINT` | **`lost`**: Postgres invalidated the slot to protect its disk |
| start Driftless | refused (exit 1), printing the 4 recovery steps |
| steps followed: new slot, then backfill of the emptied index | 150,085 rows in 28.6 s → reconcile **0 drift** |

The permanent setting is `max_slot_wal_keep_size=1GB` (in `docker-compose.yml`). After the change the slot reported
`safe_wal_size` = 1,033 MB of headroom.

**Chunk size** (no load, no delay, 105,175 rows): each chunk costs roughly the same fixed overhead, so bigger is faster.

| `DRIFTLESS_BACKFILL_CHUNK` | Time | Rate |
|---|---|---|
| 1,000 | 104.5 s | ~1,000 rows/s |
| 5,000 | 22.8 s | ~4,600 rows/s |
| 10,000 (new default) | 14.1 s | ~7,400 rows/s |

---

## 8. End-to-end lag at fixed write rates (T09)

**What lag means here:** from the transaction's commit in Postgres (the timestamp in its WAL COMMIT message) until it
and every transaction before it are applied in Meilisearch, i.e. until it may be confirmed. Measured in the
checkpointer, exported as the `driftless_lag_seconds` histogram (`GET /metrics`).

**Command:** `node scripts/bench-lag.ts RATE 60 CLIENTS`, with the connector running in Docker (same machine clock as
Postgres: measured < 1 ms apart from inside the connector container). It snapshots `/metrics`, runs the standard
workload at RATE for 60 s, samples the queue gauges every second, waits until caught up, snapshots again, and
computes quantiles from the bucket differences. Its quantile math was checked against Prometheus's
`histogram_quantile` on the same run: identical to 0.01 s (p50 2.19 s, p99 2.89 s).

**Series:** 2026-10-23 01:39–01:46 IST, run in this order, connector 8 lanes / `batchMax` 5000, index ~150k → ~185k
documents during the series. Every row is one 60-second run.

| Target tx/s | Achieved (pgbench) | Clients | Lag p50 | p95 | p99 | One write p50 | Changes/write | Max changes waiting | Caught up after stop |
|---|---|---|---|---|---|---|---|---|---|
| 200 | 199.5 | 4 | 2.34 s | 3.34 s | **3.97 s** | 1.36 s | 21 | 174 | 1.5 s |
| 500 | 499.1 | 4 | 2.73 s | 3.39 s | **3.64 s** | 1.64 s | 58 | 458 | 2.0 s |
| 1000 | 998.8 | 8 | 3.35 s | 4.40 s | **4.88 s** | 1.81 s | 139 | 1,025 | 2.5 s |
| 2000 | 1,856.6 ¹ | 8 | 5.48 s | 7.62 s | 7.92 s | 2.93 s | 385 | 3,206 | 3.5 s |
| 4000 | 3,841.9 ¹ | 16 | 11.66 s | 14.67 s | ≤ 15 s ² | 6.67 s | 1,318 | 15,274 | 8.5 s |
| 6000 | 4,782.1 ¹ | 16 | 12.83 s | 27.04 s | 15–30 s ² | 6.21 s | 1,735 | 24,842 | 10.1 s |

¹ pgbench couldn't keep its schedule (average schedule lag 0.66 s / 1.44 s / 4.22 s): that's as fast as Postgres in
this Docker VM could commit the workload, so the load generator, not Driftless, set these rates.
² Interpolated inside wide buckets (10–15 s, 15–30 s): 14.93 s and 29.41 s only mean "in that bucket".

**Kept up at every rate.** Backpressure never engaged (0 paused samples). The queue rose and fell rather than
climbing, and Driftless caught up 1.5–10 s after the load stopped. In Prometheus, p99 over 15 s windows stayed flat
for the whole ~3,800 tx/s minute. **The highest rate measured, ~4,800 tx/s, was the load generator's limit**; the
upper bound for Driftless itself is the backlog-drain rate (§4, §9).

**Where the time goes: Meilisearch, not Driftless.** Lag ≈ 1.7–1.9 × one Meilisearch write at every rate: a change
usually arrives while its lane's write is in progress, waits for it, then rides the next one. One write is mostly
Meilisearch's own per-batch work. At T09.1 (200 tx/s, ~70 documents per batch) a batch took ~560 ms, of which
**420 ms was "post processing words > word fst"**: rebuilding its dictionary of every distinct word in the index
(`GET /batches` → `progressTrace`). The synthetic workload makes that dictionary grow without end: every description
rewrite adds a random `md5` word. So write time, and with it lag, **drifts upward as the index grows** (e.g. the
1000 tx/s run repeated 7 minutes later: p50 3.35 s → 4.10 s, §9). Natural batching is what keeps up: from 200 to
~3,800 tx/s, writes per second fell (about 6 → under 2) while changes per write grew 63× (21 → 1,318).

## 9. Lanes: throughput vs lag (T09)

**Steady load, 1000 tx/s:** `node scripts/bench-lag.ts 1000 60 8` with `DRIFTLESS_LANES` set per run, in this order
(A-B-A), 2026-10-23 01:47–01:52 IST, `batchMax` 5000, index ~185k documents. The Meilisearch columns come from its
task timestamps (`GET /tasks`, enqueued → started → finished) in each run's window.

| Order | Lanes | Lag p50 | p95 | p99 | One write p50 | Changes/write | Tasks per Meili batch | Task queued in Meili | Meili batch indexing | Caught up |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 1.83 s | 2.95 s | **3.84 s** | 1.16 s | 694 | 1.8 | 0.04 s | 1.07 s | 0.9 s |
| 2 | 8 | 4.10 s | 4.92 s | **4.99 s** | 2.24 s | 158 | 7.8 | 0.95 s | 1.13 s | 3.2 s |
| 3 | 1 | 2.11 s | 3.09 s | **3.78 s** | 1.36 s | 804 | 1.9 | 0.02 s | 1.31 s | 0.6 s |
| 4 | 4 | 4.45 s | 5.80 s | **6.50 s** | 2.37 s | 340 | 4.0 | 1.07 s | 1.23 s | 3.0 s |

**Why 1 lane wins here:** Meilisearch indexes one batch at a time per index (86–98 % busy in every run) and merges all
queued tasks into it. More lanes don't add indexing parallelism; each lane's task just waits ~1 s behind the batch in
progress. With 1 lane, the waiting happens inside Driftless instead, where changes pile up and ride the next write.

**Backlog drain on the same index (195k documents),** 2026-10-23 01:53–01:56 IST, `scripts/bench-drain.sh LANES
BATCH_MAX 600 30` (~17,900-transaction backlog, start-up included), every run 0 drift:

| Lanes × batchMax | Drained in | Throughput |
|---|---|---|
| 8 × 5,000 (default) | 6.3 s | **2,810 tx/s** |
| 1 × 40,000 | 8.4 s | 2,132 tx/s |
| 1 × 5,000 | 10.6 s | 1,700 tx/s |

Lanes are more than a bigger batch: parallel requests overlap the HTTP, JSON and task polling around each
Meilisearch batch. **Decision (D-027):** keep 8 lanes by default, because a backlog (downtime, bulk load, backfill)
is when speed matters. `DRIFTLESS_LANES=1` is the low-lag setting for Meilisearch.

## 10. Config and packaging checks (T10)

2026-10-23, on the 274,776-row table. Not benchmarks: correctness checks of the new config file and the image.

| Check | Command | Result |
|---|---|---|
| Column exclusion, backfill path | host connector with a config: index `products_t10`, `columns.exclude: ["description"]` | 274,776 rows backfilled in 75.2 s |
| Column exclusion, streaming path | then 272 updates (description + price), 289 description-only updates, 3 inserts | `reconcile.ts` with that config: 274,779 = 274,779, **0 / 0 / 0**; documents have no `description`; search for text only in descriptions: 0 hits; `--self-test` passed |
| Image re-backfill | `DRIFTLESS_BACKFILL=1 docker compose up -d --build connector` (repairs the 564 changes the main index missed during the test, which reconcile had listed exactly) | 274,779 rows in 90.2 s → **0 / 0 / 0** |
| Image under chaos | `scripts/chaos.sh 60 10 200` | 6 kills, 12,044 transactions (0 failed), 275,353 = 275,353, **0 / 0 / 0** |

## 11. Polish checks (T11)

2026-10-23. Correctness checks after the T11 changes (hardened `confirm()`, CI script), not benchmarks.

| Check | Command | Result |
|---|---|---|
| Chaos after the `confirm()` hardening | `scripts/chaos.sh 60 10 200` | 0 drift (275,858 = 275,858) |
| The CI end-to-end script, locally | `COMPOSE_PROJECT_NAME=driftless-ci scripts/ci-e2e.sh 20000 120` (fresh stack) | backfill 20,000 rows in 1.4 s; 24,060 transactions, 10 SIGKILLs; 20,116 = 20,116, **0 / 0 / 0**; self-test passed; 145 s in total |
| Its guard | `scripts/ci-e2e.sh` in the default project, outside CI | refused (exit 2), nothing touched |
| Dashboard screenshot run | `scripts/chaos.sh 240 30 300` with Prometheus + Grafana up | 7 kills, 0 failed transactions (count not captured); 279,180 = 279,180, **0 / 0 / 0**; image: `docs/images/dashboard-chaos.png` |
| **CI on GitHub**, first run | push of `6b67aaa` → Actions run 39935636390 (ubuntu-24.04) | unit 13 s; e2e 2 min 45 s: backfill 20,000 rows in 1.8 s; 24,057 transactions, **11 SIGKILLs**; 20,239 = 20,239, **0 / 0 / 0**; self-test passed |
| BUG-001 contract | `npm test` (`ack-contract.test.ts`) | library 2.5.0 writes position + 1, as the compensation assumes |

## 12. The Redis cache as a second sink (T12)

2026-10-23. Redis 8.10.1 (AOF, `appendfsync always`), `@redis/client` 6.3.0, 8 lanes / `batchMax` 5000. Reconcile
compares every row with its Meilisearch document **and** its Redis hash.

**Correctness on the main stack** (~280k rows):

| Check | Command | Result |
|---|---|---|
| Switching Redis on for existing rows | connector restarted with the new config; Redis empty | "empty sink(s): redis" → backfill of **279,652 rows in 84 s** → 279,652 = documents = keys, **0 / 0 / 0**; self-test passed for both targets |
| Connector crashes | `scripts/chaos.sh 180 15 300` | 53,887 transactions, **11 SIGKILLs**; 282,154 rows = documents = keys, **0 / 0 / 0** in both |
| Redis frozen | `scripts/slow-sink.sh 120 300 50000 redis` | 2 min frozen under 300 tx/s: connection survived, connector memory 42–81 MiB, WAL held peaked at 22 MB and drained to 56 bytes; 284,640 = documents = keys, **0 / 0 / 0**. (Backpressure didn't engage: ~36k changes stayed under the 50k cap.) |

**Redis crash: what its durability setting decides** (`COMPOSE_PROJECT_NAME=driftless-redis scripts/redis-crash.sh
MODE 200 150 100`: a fresh stack per mode, 20,000 seeded rows, 150 s at 200 tx/s, Redis SIGKILLed at 100 s and started
again):

| Mode | What it is | Transactions | Redis after the crash | Meilisearch |
|---|---|---|---|---|
| `rdb` | Redis's out-of-the-box setup: no AOF, a snapshot every 60 s | 30,156 | **6,238 wrong keys**: 4,143 holding an *older* value, 1,120 missing, 975 deleted rows back | 0 drift |
| `everysec` | AOF, fsync once a second (the AOF default) | 30,308 | 0 drift | 0 drift |
| **`always`** | AOF, fsync before every reply (**what Driftless ships**) | 30,055 | **0 drift** | 0 drift |

- **`rdb` is the failure D-029 exists for.** Redis said OK to writes that lived only in memory, Driftless confirmed
  them, and the crash took the cache back to its last snapshot. For example, product #1's cached price went back to
  99,676 while Postgres says 92,098. Nothing would ever repair it: those changes were confirmed and won't be re-sent.
- **`everysec` passing is expected, and not a proof that it's safe.** A process kill leaves everything Redis has already
  `write()`-ten in the operating system's page cache, so it survives. `everysec`'s window (up to 1 s of writes) opens on
  an OS crash or power loss, which this setup can't cause. `always` closes it.

**What Redis costs in lag** (`node scripts/bench-lag.ts 1000 60 8`, fresh 20k-row stack, A-B-A; "off" = the same
connector with a config without `redis`):

| Order | Redis | Lag p50 | p95 | p99 | Redis write p50 | Meilisearch write p50 |
|---|---|---|---|---|---|---|
| 1 | on | 0.71 s | 1.48 s | 2.62 s ¹ | 0.03 s | 0.41 s |
| 2 | off | 0.69 s | 1.04 s | 1.24 s | (none) | 0.39 s |
| 3 | on | 0.85 s | 1.20 s | 1.38 s | 0.03 s | 0.43 s |

¹ pgbench fell behind its own schedule in that run (schedule lag 8.5 s), then caught up in a burst: shown, not used.

Redis adds about **+0.15 s** at p50 and p99 (runs 2 → 3). That's not Redis's own write time (30 ms): every batch now waits
for both sinks, and the connector does more work per batch. **Index size matters far more:** the same 1,000 tx/s on the
main stack's 284,640-document index gave lag p50 12.33 s, p99 29.49 s (Meilisearch write p50 5.74 s, p99 27.60 s;
Redis write p50 0.08 s), the vocabulary-growth effect of §8.

## 13. Several tables per instance (T13)

2026-10-23. `products` (~290k rows) and `customers` (~20k rows), each with its own index and Redis key prefix. Reconcile
compares every row of both tables with both sinks. The `multi` workload mix (`WORKLOAD_MIX=multi`) adds customer
changes and cross-table transactions (`BEGIN; UPDATE products …; UPDATE customers …; COMMIT;`).

| Check | Command | Result |
|---|---|---|
| New code, old single-table config | connector restarted, config unchanged | progress row `backfill` → `backfill:public.products`; publication unchanged; **nothing re-backfilled**; 287,491 rows = documents = keys, 0 drift |
| Adding a table to a running deployment | config switched to two tables | publication **added** `customers`; only customers backfilled ("1 of 2 needed it"): 19,995 rows in 1.2 s; both tables × both sinks 0 drift |
| Two-table backfill race | `WORKLOAD_MIX=multi scripts/backfill-race.sh 300 200 150 20` | both indexes and the cache emptied, backfill under 200 tx/s of multi writes with **7 SIGKILLs**: products **resumed 7 times** from its saved id, never restarted; then customers. 288,390 + 20,068 rows, both sinks, **0 / 0 / 0** |
| Removing a table | stopped; 1,075 multi transactions written; restarted with a products-only config | publication **dropped** `customers`; its changes still in the WAL **skipped** (logged once), not fatal; products 288,409 = documents = keys, 0 drift |
| Re-adding it | its index and `customer:*` keys deleted, full config back | publication re-added it; only customers backfilled (20,080 rows in 1.1 s); both tables × both sinks 0 drift |
| Crashes with cross-table transactions | `WORKLOAD_MIX=multi scripts/chaos.sh 180 15 300` | 54,138 transactions, **11 SIGKILLs**; 289,886 products + 20,517 customers = documents = keys in both sinks, **0 / 0 / 0** |
| The CI script, two tables | `COMPOSE_PROJECT_NAME=driftless-ci scripts/ci-e2e.sh 20000 120` (fresh stack, 20,000 products + 5,000 customers) | 23,901 multi transactions, 10 SIGKILLs; both tables × both sinks 0 drift; self-test caught planted drift in all 4 table × sink combinations |
| **CI on GitHub**, two tables | push of `8e665ea` → Actions run 39947004991 | 23,868 multi transactions, **12 SIGKILLs**; 20,039 products + 5,192 customers = documents = keys, **0 / 0 / 0**; self-test passed |

**Found while preparing the backfill race** (D-030): with `DRIFTLESS_BACKFILL=1` set, a connector killed between tables
would have restarted the finished table on every restart: a livelock under repeated kills. Fixed before the race ran
(resume beats request across tables; a requested round marks every table as due). The race above is the proof.

---

## Resume claims: status

| Claim (BUILD_PLAN Part 0) | Status |
|---|---|
| 0 mismatched documents out of [N] after [M] updates/deletes while SIGKILLed every [30 s] | **measured (T09 headline, §1)**: **0 missing / extra / mismatched out of 261,113 documents after 1,197,314 transactions at 1,000 tx/s, with 36 SIGKILLs** (~every 30 s for 20 min) |
| End-to-end lag p99 < [X] ms at [N] writes/s | **measured (§8, §9)**: p99 **< 4 s at 500 tx/s and < 5 s at 1,000 tx/s** (commit in Postgres → searchable in Meilisearch, 8 lanes); 3.8 s at 1,000 tx/s with 1 lane. Kept up with ~4,800 tx/s, the most this machine's Postgres could generate. Lag is bounded by Meilisearch's ~1 s per-batch indexing on a 150–190k-document index |
| Lanes + batching raised throughput from [A] to [B] | **measured**: 9 → 6,752 transactions/s (backlog drain on a ~105k-document index, §4); the same command gives 2,810 tx/s on a 195k-document index (§4 note, §9) |
| A cache that is never stale (T12) | **measured (§12)**: the Redis cache stays exact under connector SIGKILLs (11 kills, 0 drift over 282,154 rows) and under a **Redis SIGKILL** with `appendfsync always` (0 drift). With Redis's default persistence the same crash left **6,238 wrong keys** (4,143 rolled back to older values). Redis adds ~0.15 s of lag at 1,000 tx/s |
| Several tables, cross-table transactions (T13) | **measured (§13)**: two tables (290k + 20k rows) × two sinks stay exact through 11 SIGKILLs with cross-table transactions, a backfill race with 7 SIGKILLs, and adding, removing and re-adding a table on a running deployment |
| Debugging story | BUG-001 (library ack off-by-one); **BUG-002** (backfill race: 42 docs wrong → fixed with watermarks); **BUG-003** (the watermark algorithm assumed full row images; Postgres omits unchanged TOAST → 1 doc → 0) |
