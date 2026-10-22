# Test checklist — what must pass before a step or task counts as done

Code that was written is not code that works. A task is done only when its checks below and
the global checks pass. Paste evidence (command + result) into HANDOVER.md or RESULTS.md
whenever a number or a correctness claim depends on it.

Handy commands:
- SQL: `docker compose exec -T postgres psql -U driftless -d shop -c "<sql>"`
- From Git Bash, commands that pass container paths (`-f /db/...`) need `MSYS_NO_PATHCONV=1` in front
- Meilisearch: `curl -s -H "Authorization: Bearer driftless-dev-master-key" http://127.0.0.1:7700/<path>`

## Global (every task)

- [ ] `docker compose up -d --wait` → every service `healthy`
- [ ] `npm run typecheck` and `npm test` pass (from T03 on)
- [ ] The task's own checks below pass
- [ ] `git log -1 --format='%an <%ae>%n%b'` shows only the owner and no attribution lines
- [ ] Nothing secret staged (review `git diff --cached`)
- [ ] BUILD_PLAN.md box ticked and HANDOVER.md updated in the same commit as the work
- [ ] At task end: `learn/task-NN-<slug>.md` written, AGENTS.md Status updated, tag `checkpoint/Tnn`

## T01 — Foundation ✅ (verified 2026-10-22)

- [x] Postgres healthy; `SHOW wal_level` → `logical` (17.11, max_replication_slots 10, max_wal_senders 10)
- [x] Meilisearch healthy; `GET /health` → `{"status":"available"}`; version 1.54.3
- [x] Requests without the master key are rejected (`GET /indexes` → 401)
- [x] Ports bound to `127.0.0.1` only (5440, 7700)
- [x] commit-msg hook rejects a `Co-Authored-By:` line (exit 1, no commit created)
- [x] Every commit's author and committer is the owner

## T02 — Source database & workload ✅ (verified 2026-10-22)

- [x] Fresh volume (`docker compose down -v`, then `up -d --wait`) creates `products` automatically
      (log: `running /docker-entrypoint-initdb.d/01-schema.sql`; `description` storage = `e`, EXTERNAL)
- [x] Seed: `SELECT count(*) FROM products` equals the requested rows: 100,000 in 1.9 s; two runs →
      identical checksum
- [x] TOAST is really used: 5,132 big descriptions, TOAST relation 13 MB
      (`SELECT pg_size_pretty(pg_relation_size(reltoastrelid)) FROM pg_class WHERE relname = 'products'`)
- [x] Workload at a fixed rate runs clean: `scripts/workload.sh 200 30 4` → 6,096 tx, 203 tps, 0 failed
- [x] The mix includes price-only updates (60.2%, big descriptions untouched), description rewrites
      (19.9%), inserts (9.6%) and deletes (10.2%)
- [x] A price-only UPDATE of a big row decodes as `description[text]:unchanged-toast-datum`, while a small
      row's description is sent in full (temporary `test_decoding` slot; 0 slots left afterwards)

## T03 — Read the WAL ✅ (verified 2026-10-22)

- [x] Connector start creates `driftless_pub` and `driftless_slot` if missing; a second start doesn't error
      (fresh start after dropping both: recreated, publication includes truncate)
- [x] One INSERT, one UPDATE and one DELETE each print exactly one event (op, pk, commit end LSN, commit
      time); the price-only UPDATE of #10 arrives without `description` (unchanged TOAST omitted)
- [x] A multi-row transaction prints as one group, in order (3-row UPDATE → 1 txn, 3 changes; 100k-row
      seed → 1 txn)
- [x] Kill before ack → on restart the un-acked transaction is printed again; acked ones are not
      (`DRIFTLESS_DEBUG_ACK_DELAY_MS=8000` + `taskkill /F`; slot unchanged after the kill)
- [x] Writing only to a table *outside* the publication still advances the slot's `confirmed_flush_lsn`
      (keepalive confirm: `0/9D69C90` → `0/9F0A7D0`, equal to the server's WAL position)
- [x] Decoder unit tests cover insert / update / delete / unchanged-TOAST column (+ key change, TRUNCATE,
      replica identity full, protocol errors); `npm test` 10/10
- [x] Library off-by-one (BUG-001) reproduced (library ack → next txn lost) and fixed (Driftless ack → re-sent)

## T04 — Meilisearch sink, ack after apply ✅ (verified 2026-10-22)

- [x] INSERT / UPDATE / DELETE show up in Meilisearch within about a second (~100 ms per transaction)
- [x] Updating only `price_cents` on a row with a big description keeps the description in the document
      (#10: 2,560 chars in row and doc)
- [x] Logs show the order: `applied in N ms` (every task `succeeded`) → `confirmed <end LSN>`
- [x] `docker compose stop meilisearch` during writes → no ack (slot unchanged for 10 s), 7 jittered retries;
      start it → all 3 transactions applied within ~5 s, nothing lost
- [x] A document Meilisearch keeps rejecting → stops with an error naming the xid and ids; no ack past it
      (unit tests in `meilisearch.test.ts`: the products table can't produce a document Meilisearch rejects)
- [x] Killed after apply, before ack → restart replays → document equals the row (stock 93, not 94)
- [x] 100k-row re-seed streamed through the pipeline: indexed in 4.1 s, 100,000 rows = 100,000 documents

## T05 — Correctness harness ✅ (verified 2026-10-22)

- [x] Reconcile self-test: 1 corrupted, 1 deleted and 1 extra document → reported as 1 mismatched, 1 missing,
      1 extra; restored → 0 (`node scripts/reconcile.ts --self-test`: PASSED)
- [x] Reconcile waits for full catch-up before comparing (slot ≥ WAL position at start + no pending Meilisearch
      tasks); with the connector stopped it exits 2 ("couldn't check") instead of reporting drift
- [x] Chaos run: workload + SIGKILL every ~30 s for 10 min → reconcile reports 0 drift (17 kills, 2,995 tx,
      99,987 = 99,987); harsh run, a kill every ~5 s for 3 min → 0 drift (27 kills); 31 replays absorbed
- [x] Every bug found has a `docs/bugs/` note (none new in T05); RESULTS.md records the runs

## T06 — Ordered lanes, batching, checkpointer ✅ (verified 2026-10-22)

- [x] Unit: same-key events across batches apply in order; delete + re-insert inside one batch → correct final
      doc (`lanes.test.ts`, `coalesce` tests in `meilisearch.test.ts`)
- [x] Unit: checkpointer acks only the contiguous prefix of completed transactions (out-of-order
      completion, a transaction spanning several lanes, empty transactions; `checkpointer.test.ts`)
- [x] Chaos + reconcile = 0 drift with lanes = 8 (batch ≤ 5000, the measured default) at **200 tx/s**:
      20 kills / 119,764 tx and 30 kills / 35,759 tx
- [x] Throughput lanes = 1 vs lanes = 8 recorded in RESULTS.md (§4: 1,613 vs 4,910 tx/s at ≤ 500;
      4,682 vs 6,752 tx/s at ≤ 5000; unbatched 9 tx/s)

## T07 — Backfill

- [ ] Naive backfill under workload → reconcile > 0 drift, written up in `docs/bugs/` (the race)
- [ ] Watermark backfill under workload → 0 drift in 10 of 10 runs
- [ ] Kill during backfill → resumes from the last *applied* chunk; final reconcile = 0
- [ ] Backfill duration for [N] rows recorded

## T08 — Backpressure & WAL safety

- [ ] `docker pause` Meilisearch for 5 min under load → connector memory stays under [X] MB, no crash
- [ ] Unpause → catches up → reconcile = 0
- [ ] With the connector stopped, retained WAL grows (observed + recorded); with `max_slot_wal_keep_size` set, it's capped
- [ ] Invalidated slot (`wal_status = 'lost'`) → connector refuses to start and prints recovery steps

## T09 — Observability & benchmarks

- [ ] `/metrics` exposes lag histogram, events by op, batch size, queue depth, acked LSN, retained WAL bytes
- [ ] Grafana dashboard appears from provisioning after `docker compose up`
- [ ] RESULTS.md: lag p99 at fixed rates, max sustainable rate, batch 1 vs 500, each with command,
      versions and machine
- [ ] Headline chaos run recorded

## T10 — Config, packaging, release

- [ ] Fresh clone → README quick start works end to end
- [ ] `docker build` works; the image runs against the compose stack
- [ ] A bad config gives a clear validation error
- [ ] ARCHITECTURE.md and FLOW.md match the code; `learn/task-01` … `task-10` exist
- [ ] Pushed with the owner's go-ahead; GitHub contributors show only the owner
