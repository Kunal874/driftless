# Handover — where we left off

Updated 2026-10-22, end of T04 (session 1). Overwrite this at every checkpoint: it describes
*now*; history lives in git.

## Current state

- Last checkpoint: **T04 — Meilisearch sink, ack after apply** (tag `checkpoint/T04`)
- In progress: **T05**. T05.1 done: `scripts/reconcile.ts`. It waits for catch-up (slot ≥ WAL position at
  start + no pending Meilisearch tasks), compares every row with its document via `toDocument` in 1,000-id
  chunks (`getDocuments({ ids })`), and finds extra documents. Exit 0 = OK, 1 = drift, 2 = couldn't check.
  Live: 100,000 rows vs 100,000 docs, **0 drift**, 4.7 s; with the connector stopped it exits 2 ("Is Driftless
  running?"). `--self-test` mode is in the same file.
  - T05.2 done: `node scripts/reconcile.ts --self-test` (connector running) planted mismatch #1, missing #3
    and an extra doc → found exactly 1/1/1 → restored → drift 0 → **PASSED**.
  - T05.3 done: compose service `connector` (`node:24.18.0-alpine`, repo mounted read-only, profile
    `connector`, `restart: unless-stopped`). Verified: streams and applies (68 ms) inside Docker; exiting by
    itself → Docker restarts it; `docker kill` → stays down (a manual stop), so chaos restarts it explicitly.
    **It may be running now.** Before running `node src/main.ts` on the host, `docker compose stop connector`
    (only one connection may use the slot).
  - T05.4 done: `scripts/chaos.sh [DURATION=600] [KILL_EVERY=30] [RATE=5]`: workload + SIGKILL at random gaps
    (0.5–1.5 × KILL_EVERY) + explicit restart, then `reconcile --timeout=1800`; exits with reconcile's code.
    Smoke run (60 s, ~10 s, 5 tx/s): 4 kills, 268 tx, 0 failed → 100,005 = 100,005, **0 drift**.
  - T05.5 done: `chaos.sh 600 30 5` (17 kills, 2,995 tx) and `chaos.sh 180 5 5` (27 kills, 899 tx) → both
    **0 drift**. 51 connector starts, 0 fatal errors; 31 transactions killed before their ack were replayed and
    absorbed. No new bug found. Recorded in the new `docs/RESULTS.md`.
- Next step: **T05.6**: checklist, `learn/task-05-correctness-harness.md` (draft written, results section to
  fill), checkpoint

## What the system holds right now

- `products`: 100,000 rows (re-seeded in T04.2, plus a few test edits: ids 1, 6, 10, 20, 30 changed, 2 and
  21 deleted, 100001–100002 inserted).
- Meilisearch index `products` (primary key `id`): **in sync** with Postgres (100,000 = 100,000; sampled ids identical).
- Publication `driftless_pub` + slot `driftless_slot`, caught up; no connector running.

## Done so far

- **T01 Foundation ✅**: repo, single-author hook, Docker stack, docs, plan.
- **T02 Source data ✅**: schema, deterministic seed, workload runner, unchanged-TOAST proof.
- **T03 Read the WAL ✅**: decoder, confirm protocol (D-019), BUG-001 (library ack +1) reproduced and fixed.
- **T04 Meilisearch sink ✅**: `ensureIndex` (explicit primary key), `toDocument` (D-020), `planSteps` (same-kind
  runs merged per key, never reordered across deletes/TRUNCATE, 10k chunks), ack after every write
  `succeeded`, retry policy D-021 (wait out outages with full-jitter backoff; 3 tries then fail-stop on
  rejections). Live: 100k rows through the stream in 4.1 s; outage → no confirm, retries, full catch-up;
  kill after apply → replay is harmless. `npm test` 21/21.

## Notes for T05 (read before starting)

- **Throughput today is ~10 transactions/s** (one transaction at a time, ~100 ms per Meilisearch task).
  `scripts/workload.sh` at 200 tx/s will build a big backlog. Until T06, run chaos with a low rate (e.g.
  `scripts/workload.sh 5 …`) or expect a long drain before reconcile.
- Reconcile must use `toDocument()` from `src/sinks/document.ts` on rows from a normal `SELECT` (same `pg` type
  parsing as the stream). That's how the T04 spot checks matched exactly: sort keys, then compare JSON.
- "Caught up" = slot `confirmed_flush_lsn` ≥ `pg_current_wal_lsn()` (the idle confirm gets there within a few
  seconds) **and** no `enqueued`/`processing` Meilisearch tasks.
- Ids are strings in Meilisearch (D-020), so there are no numeric range filters. Compare by fetching documents
  for each chunk of Postgres ids (check the client for a fetch-by-ids option), and find *extra* documents by
  paging through all documents.
- The debug knob `DRIFTLESS_DEBUG_ACK_DELAY_MS` sits after apply and before confirm. The chaos script doesn't
  need it: SIGKILL at random moments is the point.

## Files changed in T04

`package.json`, `package-lock.json` (meilisearch 0.62.0), `src/config.ts`, `src/main.ts`,
`src/sinks/document.ts`, `src/sinks/meilisearch.ts`, `src/sinks/meilisearch.test.ts`, `docs/` (DECISIONS
D-020, D-021, BUILD_PLAN, ARCHITECTURE, FLOW, TEST_CHECKLIST), `AGENTS.md` status,
`learn/task-04-meilisearch-sink.md`

## Environment (verified 2026-10-22)

| Thing | Value |
|---|---|
| OS | Windows 11 |
| Git | 2.55.0 (installed in `C:\CODE\Git`); global identity `Kunal <kunalchandrakar2005@gmail.com>` |
| Node / npm | 24.18.0 / 11.16.0 |
| Docker | Engine 29.6.2, Desktop 4.83.0, Compose v5.3.1; engine sees 28 CPUs, ~7.6 GiB RAM |
| Ports already taken | 5432 Windows Postgres · 5433 + 6379 online-judge-v2 · 5434 + 6380 reachinbox-scheduler (both auto-start with Docker) |

## Open issues / watch out

- Git Bash rewrites container paths: `docker compose exec … -f /db/…` needs `MSYS_NO_PATHCONV=1`
  (scripts set it themselves).
- Git Bash's `kill` doesn't reliably kill a Windows `node.exe`. For a SIGKILL-style test use
  `taskkill //F //PID "$(cat /proc/$PID/winpid)"`. **Never** `taskkill /IM node.exe`: it would also kill the
  AI tool.
- For agents: `cd` in a Bash call persists across calls. Start commands with `cd /d/PROJECTS/driftless`.
- Docker Desktop may be stopped at session start. Start it before `docker compose up -d --wait`.
- Init scripts in `db/init/` only run on an **empty** volume (`docker compose down -v` wipes data; ask first).
- BUG-001 could be reported upstream to `kibae/pg-logical-replication`. That's the owner's decision
  (outward-facing); the repro script and note are ready.

## Resume prompt

> Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off.
