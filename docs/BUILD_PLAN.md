# Build plan — Driftless, step by step

This file builds the whole project one checkpoint at a time. If a session dies (usage limit,
crash, new chat), the next one continues at the **first unchecked box**. The working protocol
is in AGENTS.md; the rules are in CONSTRAINTS.md.

---

## Part 0 — Project brief (the prompt)

**Problem.** Apps that put a search index (Meilisearch, Typesense) or a cache in front of
Postgres usually keep them in sync with dual writes in app code. Those silently drift when a
request crashes between the two writes, or when two concurrent updates reach the index in reverse
order. The alternative, a nightly full re-index, means hours of stale results.

**Solution.** Driftless is a small connector. It reads committed changes from Postgres's
write-ahead log through logical replication (`pgoutput`) and routes them by primary key into
ordered lanes. It batches them into Meilisearch and acknowledges its WAL position only after
Meilisearch confirms. If it crashes, changes replay and the idempotent writes absorb them: no loss,
no drift.

**For whom.** Small teams and indie developers running Postgres + Meilisearch who want search that
never drifts, without operating Kafka + Debezium.

**MVP scope.** One source table → one index. Insert / update / delete. Crash-safe resume. Backfill of
existing rows while writes continue. Backpressure. Metrics. One Docker image + a config file.

**Not in the MVP.** Multiple databases. DDL / schema-change handling (logical replication doesn't
replicate DDL). Exactly-once *delivery* (we guarantee an exactly-once *effect*). Transaction
atomicity inside the index. High availability (stretch S2).

**Success criteria = the resume claims.** Numbers come only from real, recorded runs (CONSTRAINTS rule 7):
1. "0 mismatched documents out of [N] after [M] random updates/deletes while the connector was
   SIGKILLed every [30 s]": `scripts/chaos.sh` + `scripts/reconcile.ts` (T05, T09).
2. "End-to-end lag p99 < [X] ms at [N] writes/s": pgbench at a fixed rate + lag histogram (T09).
3. "Lanes + batching raised sustained throughput from [A] to [B] docs/s": pgbench step test (T06, T09).
4. The debugging story: the bugs in `docs/bugs/`. Likely candidates: the T07 backfill race, a T04
   TOAST wipe, a T03 auto-ack loss.

**Timebox.** 6–8 weeks part-time. T01–T10 is the MVP (about 6 weeks). Stretch goals only if ahead.

---

## Part 1 — How to use this plan

- Steps are numbered `Tnn.m`. **One step = one commit** (`Tnn.m: …`) that also ticks the step's
  box here and updates HANDOVER.md.
- Before a task: read its Goal and Pitfalls, and its section in TEST_CHECKLIST.md. If the steps
  need more detail, expand them here first and commit that.
- **Dependencies** listed under a task are approved once the owner approves this plan. Anything
  else needs asking (CONSTRAINTS rule 4).
- A task is done when all its boxes are ticked, its checklist passes, `learn/task-NN-<slug>.md` is
  written and the tag `checkpoint/Tnn` exists.
- Don't reorder tasks without asking. The order is deliberate: prove correctness before speed
  (D-015), and reproduce bugs before fixing them (T07).

| Task | Name | Week | Status |
|---|---|---|---|
| T01 | Foundation: repo, safeguards, dev stack, docs, plan | 1 | ✅ |
| T02 | Source database & write workload | 1 | ✅ |
| T03 | Read the WAL | 1–2 | ✅ |
| T04 | Meilisearch sink, ack after apply | 2 | ✅ |
| T05 | Correctness harness (reconcile + chaos) | 2–3 | 🔨 |
| T06 | Ordered lanes, batching, checkpointer | 3 | ⬜ |
| T07 | Backfill: naive → reproduce race → watermarks | 4 | ⬜ |
| T08 | Backpressure & WAL safety | 5 | ⬜ |
| T09 | Observability & benchmarks | 5–6 | ⬜ |
| T10 | Config, packaging, README, release | 6 | ⬜ |
| S1–S4 | Stretch goals | if ahead | ✂ cut first |

---

## T01 — Foundation ✅

**Goal:** a repo where work can't get lost or mis-attributed, a running local stack, and a plan
any session can resume from.

- [x] T01.1 Git repo on `main`: `.gitignore`, `.gitattributes` (LF), `.githooks/commit-msg`
      (single author) enabled via `core.hooksPath`; hook tested
- [x] T01.2 `docker-compose.yml`: Postgres 17.11 (`wal_level=logical`, 127.0.0.1:5440) +
      Meilisearch 1.54.3 (127.0.0.1:7700), healthchecks; verified
- [x] T01.3 Project docs: ARCHITECTURE, FLOW, DECISIONS, CONSTRAINTS, TEST_CHECKLIST, ROLLBACK
- [x] T01.4 This build plan + AGENTS.md + CLAUDE.md + HANDOVER.md
- [x] T01.5 `learn/task-01-foundation.md`, final HANDOVER, Status block, tag `checkpoint/T01`

---

## T02 — Source database & write workload ✅

**Goal:** a realistic `products` table, seed data and a repeatable random-write workload, so every
later task has something to sync and something to stress it with.

- [x] T02.1 `db/init/01-schema.sql`: `products` (`id bigint generated always as identity primary key`,
      `sku text unique not null`, `name text not null`, `description text`, `category text not null`,
      `price_cents int not null`, `stock int not null`, `updated_at timestamptz not null default now()`).
      Add `ALTER TABLE products ALTER COLUMN description SET STORAGE EXTERNAL` so big descriptions are
      stored out-of-line uncompressed (forces the TOAST case). Mount in compose:
      `./db/init:/docker-entrypoint-initdb.d:ro` and `./db:/db:ro`. Re-create the volume once
      (`docker compose down -v`; safe now, there's no data yet).
- [x] T02.2 `db/seed.sql`: `INSERT … SELECT … FROM generate_series(1, :rows)` with random names,
      categories, prices and stock. About 5% of rows get a > 2 KB *incompressible* description
      (e.g. concatenated `md5()` values). Run:
      `docker compose exec -T postgres psql -U driftless -d shop -v rows=100000 -f /db/seed.sql`
      (Git Bash: prefix `MSYS_NO_PATHCONV=1`). Deterministic via `setseed`; re-runnable (TRUNCATE first).
- [x] T02.3 `db/workload/`: pgbench scripts `update_price.sql` (price/stock only, description untouched),
      `update_desc.sql`, `insert.sql`, `delete.sql`, mixed 6/2/1/1. Run through the single runner
      `scripts/workload.sh [RATE=200] [SECONDS=30] [CLIENTS=4]` (D-016). It reads `max(id)` itself and
      calls pgbench inside the postgres container at a fixed rate.
- [x] T02.4 Verify (TEST_CHECKLIST → T02), `learn/task-02-source-data.md`, checkpoint

**Dependencies:** none (SQL and pgbench ship inside the postgres image).

**Pitfalls**
- Init scripts run only on an **empty** volume. Later schema changes need `down -v` (wipes data) or a manual migration.
- `generated always as identity`: inserts must not pass `id`.
- Random deletes often hit already-deleted ids (0 rows affected). That's fine, but remember it when reading pgbench output.
- pgbench needs `-n` (skip vacuuming its own tables, which don't exist here).

---

## T03 — Read the WAL ✅

**Goal:** a Node/TypeScript process that streams committed row changes, prints them as typed
events grouped by transaction, and acknowledges progress manually.

- [x] T03.1 Node project: `package.json` (`"type": "module"`; scripts `start: node src/main.ts`,
      `typecheck: tsc`, `test: vitest run`) and `tsconfig.json` (`noEmit`, `strict`, `module` +
      `moduleResolution: nodenext`, `target: es2024`, `erasableSyntaxOnly`, `verbatimModuleSyntax`,
      `allowImportingTsExtensions`). Connection settings: local-dev defaults (127.0.0.1:5440,
      driftless/driftless, db `shop`), overridable with the standard `PGHOST`/`PGPORT`/… env vars
      that `pg` reads natively.
- [x] T03.2 `src/source/replication.ts`: on start, check `wal_level = logical`. Create publication
      `driftless_pub FOR TABLE public.products` and slot `driftless_slot`
      (`pg_create_logical_replication_slot('driftless_slot', 'pgoutput')`) only if missing. Check every
      published table has a primary key.
- [x] T03.3 Stream with `pg-logical-replication` + `PgoutputPlugin({ protoVersion: 1, publicationNames:
      ['driftless_pub'] })`. `src/source/decode.ts` maps messages to `ChangeEvent` (ARCHITECTURE.md),
      grouped BEGIN…COMMIT; relation messages build the table → columns / primary-key map.
- [x] T03.4 Manual acks: turn the library's automatic acknowledgement **off**. Ack a transaction's
      commit LSN after its events are handled (printed, for now). With nothing in flight, ack
      keepalive positions so the slot keeps advancing while only *other* tables change.
- [x] T03.5 Vitest unit tests for the decoder, with recorded messages as fixtures (insert / update /
      delete / unchanged-TOAST column)
- [x] T03.6 Verify (TEST_CHECKLIST → T03), `learn/task-03-reading-the-wal.md`, checkpoint

**Dependencies:** `pg`, `pg-logical-replication`; dev: `typescript`, `@types/node`, `@types/pg`, `vitest`.

**Pitfalls (expected bugs live here)**
- **The library acknowledges automatically by default** (check its README for the exact option).
  Left on, Postgres believes changes were processed before they were, and a crash loses them.
  Prime candidate for the first `docs/bugs/` note.
- A published table without a primary key makes the *app's* UPDATE/DELETE fail.
- DELETE carries only key columns. UPDATE may send unchanged TOASTed columns as an "unchanged" marker (see T04).
- pgoutput also streams **TRUNCATE** (`db/seed.sql` truncates before seeding). Decide here: handle it
  (clear the index) or publish only `insert, update, delete`. Excluding it means a re-seed leaves stale
  documents, which reconcile will report as drift.
- Ack transaction ends (commit LSN), not individual messages.
- A slot nobody acks pins WAL forever; drop it when resetting (ROLLBACK.md).

---

## T04 — Meilisearch sink, ack after apply ✅

**Goal:** every committed change lands in the `products` index, and an LSN is acknowledged only
after Meilisearch reports the write `succeeded`.

- [x] T04.1 Create index `products` with explicit primary key `id` if missing. `src/sinks/document.ts`
      maps row → document; it's the single source of truth, reused by reconcile in T05.
- [x] T04.2 `src/sinks/meilisearch.ts`: insert/update → `updateDocuments` (merge: keeps fields we didn't
      receive); delete → `deleteDocuments([id])`. Omit unchanged-TOAST columns; never write them as null.
- [x] T04.3 Ack after apply: wait for each task to be `succeeded` before acking that transaction's commit
      LSN (simple in-order checkpointer, one lane). Failures → retry with exponential backoff + jitter;
      still failing after N attempts → stop with an error naming the row (D-009).
- [x] T04.4 Crash check: a debug knob that pauses between "task succeeded" and "ack"; SIGKILL during it
      → restart → replayed → index still correct
- [x] T04.5 Verify (TEST_CHECKLIST → T04), `learn/task-04-meilisearch-sink.md`, checkpoint

**Dependencies:** `meilisearch` (official JS client).

**Pitfalls**
- HTTP 202 means *queued*, not applied.
- Without an explicit primary key Meilisearch guesses one, and can fail when the guess is ambiguous.
- Document ids: integers, or strings made of `A–Z a–z 0–9 - _`.
- `addDocuments` *replaces* whole documents; `updateDocuments` *merges*. With TOAST omissions only merge
  is correct. Likely bug: descriptions vanish after price-only updates.
- The task-wait helper's name differs between client versions; check the installed version's docs.

---

## T05 — Correctness harness 🔨

**Goal:** an automated, repeatable proof of "zero drift", built *before* any optimisation (D-015).

- [x] T05.1 `scripts/reconcile.ts`: wait for full catch-up (slot `confirmed_flush_lsn` ≥
      `pg_current_wal_lsn()` and no enqueued/processing Meilisearch tasks). Then compare every row with
      its document via `document.ts` + a canonical hash, in primary-key ranges (make `id` filterable).
      Print missing / extra / mismatched counts with sample ids; exit 1 on any drift.
- [x] T05.2 Reconcile self-test: corrupt one document, delete one, add one extra → expect
      1 mismatched / 1 missing / 1 extra
- [x] T05.3 Compose service `connector` (`node:24` image, repo mounted, `depends_on` healthy) so tests can
      `docker compose kill -s SIGKILL connector`. Profile `connector` (start: `docker compose up -d connector`);
      `restart: unless-stopped` restarts it after it exits **on its own**. A `docker kill` counts as a manual
      stop and is **not** restarted, so chaos.sh restarts it explicitly.
- [x] T05.4 `scripts/chaos.sh DURATION KILL_EVERY RATE`: run the workload, SIGKILL + restart the
      connector every KILL_EVERY seconds, stop the workload, run reconcile
- [x] T05.5 First full chaos run. For every bug found: `docs/bugs/` note → fix → re-run until 0 drift.
      Create `docs/RESULTS.md` with the run.
- [ ] T05.6 Verify (TEST_CHECKLIST → T05), `learn/task-05-correctness-harness.md`, checkpoint

**Dependencies:** none new.

**Pitfalls**
- Reconciling before catch-up reports false drift.
- With 100k+ documents, compare in id ranges; don't load everything into memory.
- `node_modules` installed on Windows and mounted into a Linux container is fine for pure-JS
  dependencies. If a native one ever appears, install inside the container instead.

---

## T06 — Ordered lanes, batching, checkpointer ⬜

**Goal:** parallel throughput without breaking per-key order or the ack-after-apply invariant.

- [ ] T06.1 `src/pipeline/lanes.ts`: router `hash(pk) % N` (inline FNV-1a, no dependency); each lane is
      an ordered queue applied one batch at a time
- [ ] T06.2 Batcher: flush at `BATCH_MAX` docs or `BATCH_MS` ms (defaults 500 / 50). Coalesce per key:
      each key ends as either one delete or one merged upsert (a delete resets, later upserts merge onto
      empty), so a batch's upserts and deletes touch disjoint keys and can go in two calls.
- [ ] T06.3 `src/pipeline/checkpointer.ts`: per transaction, count outstanding events across lanes. Ack
      the highest commit LSN such that it and all earlier transactions are fully applied. Pure logic +
      unit tests (out-of-order completion, empty transactions, a transaction spanning lanes).
- [ ] T06.4 Chaos + reconcile with lanes = 8, batch = 500 → 0 drift. Measure sustained throughput with
      lanes 1 vs 8 (pgbench step test) → RESULTS.md
- [ ] T06.5 Verify (TEST_CHECKLIST → T06), `learn/task-06-lanes-and-batching.md`, checkpoint

**Dependencies:** none new.

**Pitfalls**
- Acking a later transaction while an earlier one is still in flight on a slow lane = data loss on crash.
- Delete + re-insert of one key inside a batch: coalescing must respect order.
- Lanes are unbounded until T08. Keep a size counter now.

---

## T07 — Backfill ⬜

**Goal:** index rows that existed before Driftless started, while writes continue, with zero drift.
First reproduce the naive race, then fix it (D-008).

- [ ] T07.1 Naive backfill: chunked `SELECT … WHERE id > $last ORDER BY id LIMIT 1000` written straight to
      the sink, concurrently with the stream. Add a debug delay between SELECT and write to widen the race.
- [ ] T07.2 Reproduce: workload + naive backfill + reconcile → drift > 0. Write
      `docs/bugs/BUG-NNN-backfill-race.md` with the numbers (the flagship interview story).
- [ ] T07.3 Watermark backfill (FLOW.md → Flow 3): add table `driftless_watermark` to the publication;
      low mark → SELECT chunk → high mark; drop chunk keys changed between the marks; emit the rest into
      the lanes at the high mark
- [ ] T07.4 Persist progress (last *applied* key) in a small unpublished `driftless_state` table so a killed
      backfill resumes. Trigger: new/empty index, or an explicit flag.
- [ ] T07.5 Prove: same workload, 10 runs → 0 drift each; record in RESULTS.md, with backfill time for [N] rows
- [ ] T07.6 Verify (TEST_CHECKLIST → T07), `learn/task-07-backfill.md`, checkpoint

**Dependencies:** none new.

**Pitfalls**
- Watermark table missing from the publication → marks never arrive → backfill hangs.
- Chunk rows must flow through the same lanes, or per-key order breaks.
- Save progress after the chunk is applied, not after it's read.

---

## T08 — Backpressure & WAL safety ⬜

**Goal:** a slow or dead sink never crashes Driftless, and a dead Driftless never fills the Postgres disk.

- [ ] T08.1 Spike: find how to stop reading the replication stream (a library API, or pausing the
      underlying socket so TCP backpressure stops the WAL sender). Record the mechanism in DECISIONS.md.
- [ ] T08.2 Bound total buffered events: pause at a high-water mark, resume below a low-water mark (hysteresis)
- [ ] T08.3 Slow-sink test: `docker pause` Meilisearch for 5 min under load → memory flat, no crash;
      unpause → catch up → reconcile = 0
- [ ] T08.4 WAL safety: first observe retained WAL growing with the connector stopped (record it). Then set
      `max_slot_wal_keep_size` in compose. On start, detect `wal_status = 'lost'` and stop with recovery
      steps (drop + recreate slot, re-backfill).
- [ ] T08.5 Verify (TEST_CHECKLIST → T08), `learn/task-08-backpressure.md`, checkpoint

**Dependencies:** none new.

**Pitfalls**
- Pausing in the wrong layer just moves the buffering into the library.
- `pg-logical-replication` 2.5's `flowControl` does pause the socket, but its keepalives bypass its queue
  (D-019). If you use it, keep Driftless's own idle check. While the socket is paused, keepalive requests
  aren't read, so send periodic status updates yourself or `wal_sender_timeout` (60 s) drops the connection.
- Without hysteresis, pause/resume thrashes.
- An invalidated slot means changes were lost for the sink. Never "just continue".

---

## T09 — Observability & benchmarks ⬜

**Goal:** make freshness visible, and produce the resume numbers from real, recorded runs.

- [ ] T09.1 `src/metrics.ts` + `GET /metrics` (prom-client): `driftless_lag_seconds` histogram
      (sink-confirmed time − commit time), events applied by op, batch size, lane queue depth, acked LSN,
      slot retained WAL bytes
- [ ] T09.2 Prometheus + Grafana in compose (127.0.0.1 ports; check they're free first); dashboard
      provisioned from `docker/grafana/`
- [ ] T09.3 Benchmarks: pgbench at fixed rates, stepping up until lag grows without bound; batch 1 vs 500;
      lanes 1 / 4 / 8 → RESULTS.md with machine, versions and exact commands
- [ ] T09.4 Headline chaos run ([M] updates, SIGKILL every 30 s) → reconcile = 0 → RESULTS.md
- [ ] T09.5 Verify (TEST_CHECKLIST → T09), `learn/task-09-observability.md`, checkpoint

**Dependencies:** `prom-client`.

**Pitfalls**
- Lag compares Postgres's clock (commit time) with the connector's. They're the same machine here, but note it.
- Histogram buckets must span milliseconds to minutes.
- Benchmark on a quiet machine: stop the other projects' containers first and say so in RESULTS.md.

---

## T10 — Config, packaging, README, release ⬜

**Goal:** someone else can run Driftless from the README in minutes.

- [ ] T10.1 Config file `driftless.config.json` (source connection, table → index, primary key, columns to
      include/exclude), validated at start with clear errors; env vars override
- [ ] T10.2 `Dockerfile` (node:24-alpine, `npm ci --omit=dev`, runs `node src/main.ts`, no build step) +
      `.dockerignore`; the compose `connector` service uses it
- [ ] T10.3 README.md: what it is, how it works (diagram), quick start, tests, results (from RESULTS.md only),
      limitations
- [ ] T10.4 Final docs pass: ARCHITECTURE and FLOW match the code; DECISIONS complete; learn/task-01…10 exist
- [ ] T10.5 GitHub, **only after the owner's explicit go-ahead**: create the repo, push `main` + tags, check
      the contributors list shows only the owner; tag `v0.1.0`
- [ ] T10.6 Verify (TEST_CHECKLIST → T10), `learn/task-10-release.md`, checkpoint

**Dependencies:** none new (JSON needs no parser).

**Pitfalls**
- A fresh-clone test catches forgotten setup steps (for example `git config core.hooksPath .githooks`).
- `.dockerignore` must exclude `node_modules`, `.git`, `docs`, `learn`.

---

## Stretch goals ✂ (only after T10, or if well ahead; cut first)

- **S1 Redis cache sink:** write-through from the same stream, key `product:{id}`. Readers never write the
  cache, so the stale-set race can't happen.
- **S2 Standby connector:** a second instance waits to take over the slot. Postgres allows one active
  consumer per slot, so the slot itself works as the lock.
- **S3 Typesense sink:** a second sink behind the same interface (proves the sink boundary).
- **S4 Schema changes:** handle pgoutput relation messages (column added/removed); document that DDL itself
  isn't replicated.
