# Handover — where we left off

Updated 2026-10-22, end of T02 (session 1). Overwrite this at every checkpoint: it describes
*now*; history lives in git.

## Current state

- Last checkpoint: **T02 — Source database & workload** (tag `checkpoint/T02`)
- In progress: **T03**. T03.1 done: `package.json` (pg 8.23.1, pg-logical-replication 2.5.0;
  dev: typescript 7.0.2, vitest 5.0.3, @types/node 24, @types/pg), `tsconfig.json`, `src/config.ts`.
  `npm run typecheck` passes; `node src/*.ts` runs with no build step.
- T03.2 done: `src/source/replication.ts` checks `wal_level`, the primary key and replica identity, then
  creates `driftless_pub` (publishes truncate too, D-018) and `driftless_slot` (pgoutput) only if
  missing. Verified idempotent; clear errors for a missing table or a table without a primary key.
  **The slot now exists** (created at `0/71F31D8`) and retains WAL until Driftless acks.
- T03.3 done: `src/source/decode.ts` (pgoutput → `Transaction` of `Change`s) and `src/main.ts` (setup,
  stream, print). Verified on real changes: insert; price-only update of #10 arrives **without**
  `description` (unchanged TOAST omitted); delete; 3-row txn grouped; truncate; 100k-row seed txn.
  **No acks yet by design**, so every start replays everything since the slot was created
  (`confirmed_flush_lsn` still `0/71F31D8`, 43 MB retained).
- T03.4 done: confirm protocol in `src/main.ts` (D-019) + `src/source/lsn.ts` (+ tests).
  **BUG-001 reproduced and fixed**: the library's `acknowledge()` adds 1, which can skip the next
  transaction after a restart (`scripts/repro-ack-off-by-one.ts`, `docs/bugs/BUG-001-…`). Verified: kill
  inside the ack window → slot unchanged; restart re-delivers only the un-acked txn; idle connector
  advances the slot to the server's WAL position. Note: the repro script fast-forwards the slot with
  `pg_replication_slot_advance`, so the T03.3 test changes were skipped (test data only).
- Next step: **T03.5**: decoder unit tests (`src/source/decode.test.ts` written, passing, uncommitted)

## pg-logical-replication 2.5.0: what reading its source showed (T03.1)

`node_modules/pg-logical-replication/dist/logical-replication-service.js`:
1. `acknowledge.auto` defaults to **true**: every message is acked on *receipt* (at-most-once).
2. `acknowledge.timeoutSeconds` defaults to **10**: a timer acks the last **received** LSN, *even with
   auto = false*. Must be set to 0; we answer keepalive requests ourselves.
3. `acknowledge(lsn)` sends **lsn + 1**. Postgres expects an end position, so passing a commit's end LSN
   over-reports by 1 byte. After a restart, that can make Postgres skip the next transaction if its
   commit record starts exactly there. We pass `end − 1` (to verify in T03.4 → docs/bugs).
4. With `flowControl` on, keepalives bypass the library's queue, so an "idle" ack could cover queued,
   unhandled transactions. T03 uses its own queue instead.

## What the database holds right now

- `products`: 99,965 rows (seeded 100,000, then one 30 s workload run). Re-seed any time with
  `db/seed.sql` and you get identical data.
- Publication `driftless_pub` and slot `driftless_slot` exist (since T03.2). Meilisearch: no indexes.

## Done so far

- **T01 Foundation ✅**: repo, single-author hook, Docker stack, docs, build plan.
- **T02 Source data ✅**: schema (`description` STORAGE EXTERNAL); deterministic seed (100k rows in
  1.9 s, 5,132 big descriptions, identical checksum across runs); workload runner (200 tx/s, 0 failed,
  60/20/10/10 mix); proof that a price-only update of a big row decodes as `unchanged-toast-datum`.

## Notes for T03 (read before starting)

- Decide how to handle **TRUNCATE** (BUILD_PLAN T03 pitfalls). `db/seed.sql` truncates before seeding.
- The unchanged-TOAST marker is real and frequent: 60% of workload writes are price-only updates. The
  decoder's test fixtures (T03.5) must include it.
- To peek at decoded changes without code, use a temporary `test_decoding` slot (learn/task-02 §3).
  Always check `pg_replication_slots` is clean afterwards.
- Node connects from the host to `127.0.0.1:5440`, user/password `driftless`, database `shop`.

## Files changed in T02

`db/init/01-schema.sql`, `db/seed.sql`, `db/workload/*.sql`, `scripts/workload.sh`,
`docker-compose.yml` (mounts), `docs/` (BUILD_PLAN, HANDOVER, ARCHITECTURE, CONSTRAINTS rule 13,
DECISIONS D-016, TEST_CHECKLIST), `AGENTS.md` status, `learn/task-02-source-data.md`

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
- Docker Desktop may be stopped at session start. Start it before `docker compose up -d --wait`.
- Init scripts in `db/init/` only run on an **empty** volume. Changing the schema later means
  `docker compose down -v` (wipes all data; ask first) or a manual migration.

## Resume prompt

> Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off.
