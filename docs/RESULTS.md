# Results — measured numbers, with the exact commands

Every number in the README or on a resume must come from this file, and every entry here comes from a real
run, with its command, date, versions and machine (CONSTRAINTS rule 7). Unmeasured claims stay `[X]`.

## Machine and versions

| | |
|---|---|
| Host | Windows 11, Docker Desktop 4.83.0 (engine 29.6.2); the engine sees 28 CPUs and ~7.6 GiB RAM |
| Not a quiet machine | other projects' containers ran at the same time (online-judge-v2, reachinbox-scheduler) |
| Postgres / Meilisearch | 17.11 / 1.54.3 (pinned, D-010) |
| Driftless | Node 24.18.0 (`node:24.18.0-alpine` in the `connector` service), pg-logical-replication 2.5.0, meilisearch-js 0.62.0 |
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

**Steady load:** at 200 tx/s for 30 s (5,805 transactions), Driftless kept up throughout: caught up 13 ms after
the load stopped, ~5 changes per write, 60–100 transactions in flight. 0 drift.

---

## Resume claims: status

| Claim (BUILD_PLAN Part 0) | Status |
|---|---|
| 0 mismatched documents out of [N] after [M] updates/deletes while SIGKILLed every [30 s] | **measured at 200 tx/s**: 0 drift over 101,729 rows after 119,764 transactions and 20 SIGKILLs (T06); T09 repeats it as the headline run |
| End-to-end lag p99 < [X] ms at [N] writes/s | not measured yet (T09) |
| Lanes + batching raised throughput from [A] to [B] | **measured**: 9 → 6,752 transactions/s (backlog drain, §4) |
| Debugging story | BUG-001 (library ack off-by-one), reproduced and fixed |
