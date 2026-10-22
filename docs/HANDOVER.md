# Handover — where we left off

Updated 2026-10-22, end of T06 (session 1). Overwrite this at every checkpoint: it describes
*now*; history lives in git.

## Current state

- Last checkpoint: **T06 — Ordered lanes, batching, checkpointer** (tag `checkpoint/T06`)
- In progress: **T07**. T07.1 done: `src/source/backfill.ts` `naiveBackfill()` (keyset chunks → lanes as
  inserts, `countdown` waits for each chunk to be applied); `DRIFTLESS_BACKFILL=1`,
  `DRIFTLESS_BACKFILL_CHUNK` (1000), `DRIFTLESS_BACKFILL_DEBUG_DELAY_MS` (also passed through compose);
  `scripts/backfill-race.sh DELAY RATE SECONDS` (empty index → backfill under load → reconcile). Smoke with
  no concurrent writes: 102,327 rows in 73 s, **0 drift**. (Slow: each chunk waits to be applied; tune later.)
  T07.2 done: **race reproduced**. `backfill-race.sh 300 200 150` → **42 drifted documents** (40 hold older
  values, 2 deleted rows resurrected); without the delay this run happened to stay clean (the window is ms wide).
  Written up in `docs/bugs/BUG-002-backfill-race.md` (repro = commit `9852dce`).
  T07.3 done: `createBackfill()` (watermarks through `public.driftless_watermark`, which is created and added
  to the publication automatically; D-023). The first run of the textbook version left **1** drift: **BUG-003**.
  A partial (TOAST-omitting) update inside a row's own window made it drop the only copy of the description.
  Fixed by tracking which *columns* the stream sent per key (`docs/bugs/BUG-003-watermark-toast.md`). Re-run of
  `backfill-race.sh 300 200 150`: 42 snapshot rows dropped, 1 filled in → **0 drift**. `npm test` 41/41.
  Not persisted yet: a killed backfill starts over only if `DRIFTLESS_BACKFILL=1`.
  T07.4 done: progress in unpublished `public.driftless_state` (saved after each *applied* chunk); start rules
  (D-024): resume an interrupted backfill > `DRIFTLESS_BACKFILL=1` > empty index with a non-empty table.
  `backfill-race.sh` now resets the state when it empties the index and takes a 4th arg KILL_EVERY_S. Live:
  `backfill-race.sh 300 200 150 20` → 6 SIGKILLs, each restart resumed after the last applied id → **0 drift**.
  `npm test` 42/42.
- Next step: **T07.5**: chunk-size timing (1000 vs 5000) and 10 proof runs of `backfill-race.sh 300 200 150`

## What the system holds right now

- `products`: ~102,327 rows (after the T06 chaos workloads); Meilisearch `products`: **identical** (last
  reconcile 0 / 0 / 0).
- Publication + slot caught up. The `connector` service is **stopped** (start: `docker compose up -d connector`).

## Done so far

- **T01–T05 ✅**: foundation, source data, WAL reader + confirm protocol (BUG-001 fixed), Meilisearch sink +
  retry policy, correctness harness (reconcile + self-test + chaos).
- **T06 ✅**: `src/pipeline/lanes.ts` (FNV-1a routing, ordered lanes, natural batching with no timer),
  `src/pipeline/checkpointer.ts` (confirm only the unbroken run of applied transactions), sink `coalesce`
  (≤ 2 parallel writes per batch), TRUNCATE barrier (D-022). Measured: **9 → 6,752 tx/s** (backlog drain), bulk
  100k rows in 3.2 s. Defaults: 8 lanes, `batchMax` 5000. Chaos at **200 tx/s**: 50 kills over 155k transactions
  → **0 drift**. `npm test` 33/33. Numbers in `docs/RESULTS.md`.

## Notes for T07 (read before starting)

- The index currently mirrors every row, because rows reached it by streaming a re-seed. To test backfill
  for real, start from an **empty index** (delete the `products` index in Meilisearch, or create a fresh one)
  while rows already exist and the workload keeps writing.
- Backfill rows must go through **the same lanes** (`lanes.push({ change, txn })`) so per-key order holds.
  A chunk can be pushed as `insert` changes with its own countdown object `{ remaining: n }`; when it hits 0
  the chunk is applied, so save progress only *then*.
- Backfill progress and WAL confirms are independent. If Driftless dies after confirming but before a chunk is
  applied, the saved progress hasn't moved, so the chunk is simply read again on restart.
- The naive version (T07.1) should *lose* to the stream sometimes. Widen the race window with a debug delay
  between SELECT and push, and prove the drift with `scripts/reconcile.ts` before fixing it (T07.2 → a
  `docs/bugs/BUG-002-…` note).
- For the watermark version, the watermark table must be **in the publication**, or the marks never arrive.

## Files changed in T06

`src/pipeline/{lanes,checkpointer}.ts` (+ tests), `src/sinks/meilisearch.ts` (+ tests), `src/main.ts`,
`src/config.ts`, `docker-compose.yml`, `scripts/bench-drain.sh`, `docs/` (DECISIONS D-022, RESULTS §1/§4,
BUILD_PLAN, ARCHITECTURE, FLOW, TEST_CHECKLIST), `AGENTS.md` status, `learn/task-06-lanes-and-batching.md`

## Environment (verified 2026-10-22)

| Thing | Value |
|---|---|
| OS | Windows 11 |
| Git | 2.55.0 (installed in `C:\CODE\Git`); global identity `Kunal <kunalchandrakar2005@gmail.com>` |
| Node / npm | 24.18.0 / 11.16.0 (connector container: `node:24.18.0-alpine`) |
| Docker | Engine 29.6.2, Desktop 4.83.0, Compose v5.3.1; engine sees 28 CPUs, ~7.6 GiB RAM |
| Ports already taken | 5432 Windows Postgres · 5433 + 6379 online-judge-v2 · 5434 + 6380 reachinbox-scheduler (both auto-start with Docker) |

## Open issues / watch out

- Git Bash rewrites container paths: `docker compose exec … -f /db/…` needs `MSYS_NO_PATHCONV=1`
  (scripts set it themselves).
- Git Bash's `kill` doesn't reliably kill a Windows `node.exe`. For a SIGKILL-style test of a host process use
  `taskkill //F //PID "$(cat /proc/$PID/winpid)"`. **Never** `taskkill /IM node.exe`: it would also kill the
  AI tool. (Inside Docker: `docker compose kill -s SIGKILL connector`.)
- For agents: `cd` in a Bash call persists across calls. Start commands with `cd /d/PROJECTS/driftless`.
- Long runs (chaos, benchmarks) belong in the background.
- Docker Desktop may be stopped at session start. Start it before `docker compose up -d --wait`.
- Init scripts in `db/init/` only run on an **empty** volume (`docker compose down -v` wipes data; ask first).
- BUG-001 could be reported upstream to `kibae/pg-logical-replication`. That's the owner's decision
  (outward-facing); the repro script and note are ready.

## Resume prompt

> Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off.
