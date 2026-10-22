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

---

## Resume claims: status

| Claim (BUILD_PLAN Part 0) | Status |
|---|---|
| 0 mismatched documents out of [N] after [M] updates/deletes while SIGKILLed every [30 s] | **measured at 5 tx/s**: 99,987 rows, 2,995 tx, 17 kills, 0 drift. Headline run at full rate: T09 |
| End-to-end lag p99 < [X] ms at [N] writes/s | not measured yet (T09) |
| Lanes + batching raised throughput from [A] to [B] docs/s | A ≈ 10 transactions/s (single lane, above); B: T06 |
| Debugging story | BUG-001 (library ack off-by-one), reproduced and fixed |
