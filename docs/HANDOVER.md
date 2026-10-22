# Handover — where we left off

Updated 2026-10-22, end of T03 (session 1). Overwrite this at every checkpoint: it describes
*now*; history lives in git.

## Current state

- Last checkpoint: **T03 — Read the WAL** (tag `checkpoint/T03`)
- In progress: nothing
- Next step: **T04.1**: create the Meilisearch `products` index (explicit primary key `id`) and
  `src/sinks/document.ts` (row → document), see BUILD_PLAN.md → T04

## What the system holds right now

- `products`: 100,000 rows (re-seeded during T03, plus a few test edits to ids 1–6 and 10).
- Publication `driftless_pub` (insert/update/delete/truncate) and slot `driftless_slot`, recreated fresh
  in T03.6 and fully caught up (`confirmed_flush_lsn` = server WAL position `0/9F1E0A8`).
- Meilisearch: no indexes yet.

## Done so far

- **T01 Foundation ✅**: repo, single-author hook, Docker stack, docs, plan.
- **T02 Source data ✅**: schema, deterministic seed, workload runner, unchanged-TOAST proof.
- **T03 Read the WAL ✅**: Node 24 + TypeScript 7 with no build step; startup checks + idempotent
  publication/slot; decoder (`Transaction` of `Change`s; unchanged TOAST omitted, NULL kept; key change →
  delete + insert; TRUNCATE handled); confirm protocol D-019 (ack after handling at the exact end position,
  idle confirms, keepalive replies, own queue). **BUG-001** found by reading the library's source, reproduced
  (`scripts/repro-ack-off-by-one.ts`) and fixed. Verified: kill-before-ack replay, idle slot advance, fresh
  start. `npm test` 10/10.

## Notes for T04 (read before starting)

- The sink goes into `handle(txn)` in `src/main.ts`: apply → wait until the Meilisearch task `succeeded` →
  *then* `confirm(...)`. Keep that order (invariant 1).
- `row` holds only the columns that were sent. Unchanged TOAST columns are absent, so use
  `updateDocuments` (merge), never `addDocuments` (replace).
- `truncate` changes must remove all of that table's documents (D-018).
- Value types: `id` arrives as a **string** (`'10'`), `updated_at` as a `Date`. Decide the document shape
  in `document.ts` (it becomes the reconcile reference in T05).
- Install `meilisearch` with the 14-day rule (D-017): `npm install --before="$(date -d '-14 days' +%F)" meilisearch`.
- Rows that existed before the slot are not streamed (backfill is T07). To get every row through the
  pipeline before then, re-seed **after** the slot exists: `db/seed.sql` truncates and re-inserts, and all of
  it streams (one truncate + one 100k-row transaction).
- While `handle` waits on a slow Meilisearch, keepalive replies keep the connection alive (the socket isn't
  paused), so long retries are fine. Bounding memory is T08.

## Files changed in T03

`package.json`, `package-lock.json`, `tsconfig.json`, `src/config.ts`, `src/main.ts`,
`src/source/{replication,decode,lsn}.ts`, `src/source/{decode,lsn}.test.ts`,
`scripts/repro-ack-off-by-one.ts`, `docs/bugs/BUG-001-library-ack-off-by-one.md`, `docs/` (DECISIONS
D-017…D-019, BUILD_PLAN, ARCHITECTURE, FLOW, TEST_CHECKLIST), `AGENTS.md` status,
`learn/task-03-reading-the-wal.md`

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
