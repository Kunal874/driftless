# Handover — where we left off

Updated 2026-10-23, end of T07 (session 1). Overwrite this at every checkpoint: it describes
*now*; history lives in git.

## Current state

- Last checkpoint: **T07 — Backfill** (tag `checkpoint/T07`)
- In progress: **T08**. T08.1 done (spike, D-025): pause `service._connection.stream` (the `net.Socket` pg reads
  via `'data'` events) at a pending-work cap, resume at half; re-send the confirmed position every 10 s
  (`wal_sender_timeout` is 1 min). Found: `max_slot_wal_keep_size` is −1 (unlimited) on this stack.
  T08.2 done: `src/pipeline/backpressure.ts` (`nextReadState`, + 2 tests) and in `main.ts` the socket pause/resume
  (cap `DRIFTLESS_MAX_PENDING`, default 50,000; resume at half), a 10 s status re-send, and a stats line while paused.
  `scripts/slow-sink.sh PAUSE_S RATE MAX_PENDING`. Verified `slow-sink.sh 90 200 2000`: paused at exactly 2,000; memory
  flat ~42 MiB for the 90 s freeze; WAL held for the slot 0.8 → 8.2 MB; **0 fatal** (survived > 60 s
  `wal_sender_timeout`); 0 drift. `npm test` 44/44.
  T08.3 done: 5-min freezes at 600 tx/s (~216k tx each). Capped: memory bounded (≤ ~130 MiB) and the backlog waited
  as WAL; uncapped: 45 → 220 MiB and rising. The capped run had **1 fatal: HTTP 408** (requests sent to the frozen
  Meilisearch time out when it wakes up), and the retry policy wrongly treated it as a rejection (**BUG-004**; no data
  lost thanks to fail-stop + restart + replay). Fixed (408 is retryable), re-run → 0 fatal, 0 drift.
  `slow-sink.sh` now keeps the full connector log. Numbers: RESULTS.md §6.
  T08.4 done (D-026): `replication.ts` refuses to start on `wal_status = 'lost'` (prints 4 recovery steps) and warns
  on `unreserved`. Experiment: 32 MB cap, Driftless stopped → held 12 → 15 → 153 MB → CHECKPOINT → **lost** → refused
  → steps followed → 150,085 rows backfilled → **0 drift**. Compose now starts Postgres with
  `max_slot_wal_keep_size=1GB` (was unlimited); the slot survived the restart (`safe_wal_size` 1,033 MB). ROLLBACK.md
  has a "Lost replication slot" section.
- Next step: **T08.5**: checklist, `learn/task-08-backpressure.md` (draft written; fill §2 and §3), checkpoint

## What the system holds right now

- `products`: ~113,728 rows; Meilisearch `products`: **identical** (last reconcile 0 / 0 / 0, from the 10th proof run).
- `driftless_state`: backfill `done`. Publication streams `products` + `driftless_watermark`. Slot caught up.
- The `connector` service is **stopped** (`backfill-race.sh` stops it at the end).

## Done so far

- **T01–T06 ✅**: foundation, source data, WAL reader + confirm protocol (BUG-001), sink + retry policy, correctness
  harness, lanes + batching + checkpointer (9 → 6,752 tx/s; chaos at 200 tx/s, 0 drift).
- **T07 ✅**: backfill. Naive version reproduced the race (**BUG-002**: 42 docs wrong). Watermark version (D-023)
  left 1 (**BUG-003**: Postgres omits unchanged TOAST, so the window became column-aware). Progress in unpublished
  `driftless_state`, resume after crashes (D-024). **10/10 proof runs at 0 drift** (420 stale snapshot rows dropped,
  9 filled in); 6 SIGKILLs mid-backfill → resumed → 0 drift. Default chunk 10,000 (105k rows in 14 s).
  `npm test` 42/42.

## Notes for T08 (read before starting)

- **Where memory can grow today:** the stream message queue (`queue` in `src/main.ts`) and the lanes
  (`queued()` in `src/pipeline/lanes.ts`) are unbounded. The backfill is bounded (one chunk, ≤ 10,000 rows, in
  flight at a time).
- To pause reading, `pg-logical-replication`'s `flowControl` pauses `connection.stream`, but its keepalives bypass
  its queue (D-019), so if used, keep Driftless's own idle check. While paused, keepalive requests aren't read:
  send periodic status updates yourself, or `wal_sender_timeout` (60 s) drops the connection.
- Slow-sink test idea: `docker pause driftless-meilisearch-1` for 5 min under load, watch the connector's memory
  (`docker stats`), unpause, reconcile.
- WAL safety: first *observe* retained WAL growing with the connector stopped (`pg_replication_slots`), then set
  `max_slot_wal_keep_size` in compose and detect `wal_status = 'lost'` on start (recover = new slot + backfill;
  the empty-index rule of D-024 can help).

## Files changed in T07

`src/source/backfill.ts` (+ tests), `src/source/replication.ts`, `src/main.ts`, `src/config.ts`,
`docker-compose.yml`, `scripts/backfill-race.sh`, `docs/bugs/BUG-002-…`, `docs/bugs/BUG-003-…`, `docs/` (DECISIONS
D-023, D-024, RESULTS §5, FLOW, ARCHITECTURE, ROLLBACK, BUILD_PLAN, TEST_CHECKLIST), `AGENTS.md` status,
`learn/task-07-backfill.md`

## Environment (verified 2026-10-23)

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
- Long runs (chaos, benchmarks, backfill races) belong in the background.
- Docker Desktop may be stopped at session start. Start it before `docker compose up -d --wait`.
- Init scripts in `db/init/` only run on an **empty** volume (`docker compose down -v` wipes data; ask first).
- BUG-001 could be reported upstream to `kibae/pg-logical-replication`. That's the owner's decision
  (outward-facing); the repro script and note are ready.

## Resume prompt

> Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off.
