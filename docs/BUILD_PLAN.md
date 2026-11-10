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
| T05 | Correctness harness (reconcile + chaos) | 2–3 | ✅ |
| T06 | Ordered lanes, batching, checkpointer | 3 | ✅ |
| T07 | Backfill: naive → reproduce race → watermarks | 4 | ✅ |
| T08 | Backpressure & WAL safety | 5 | ✅ |
| T09 | Observability & benchmarks | 5–6 | ✅ |
| T10 | Config, packaging, README, release | 6 | ✅ |
| T11 | Polish after release (owner asked 2026-10-23) | 6 | ✅ |
| T12 | Redis cache as a second sink (approved 2026-10-23) | 7 | ✅ |
| T13 | Multiple tables per instance (approved 2026-10-23) | 7–8 | ✅ |
| T14 | Alerts: slot WAL, connector down or stalled, lag (approved 2026-11-11) | 9 | ✅ |
| T15 | Publish: image on GHCR, CLI on npm; release `v0.3.0` | 9 | approved 2026-11-11 |
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

## T05 — Correctness harness ✅

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
- [x] T05.6 Verify (TEST_CHECKLIST → T05), `learn/task-05-correctness-harness.md`, checkpoint

**Dependencies:** none new.

**Pitfalls**
- Reconciling before catch-up reports false drift.
- With 100k+ documents, compare in id ranges; don't load everything into memory.
- `node_modules` installed on Windows and mounted into a Linux container is fine for pure-JS
  dependencies. If a native one ever appears, install inside the container instead.

---

## T06 — Ordered lanes, batching, checkpointer ✅

**Goal:** parallel throughput without breaking per-key order or the ack-after-apply invariant.

*Refined when T06 started:* batching is "natural" (no `BATCH_MS` timer), and the checkpointer comes before
the wiring, so every commit stays runnable.

- [x] T06.1 `src/pipeline/lanes.ts`: router `hash(pk) % N` (inline FNV-1a, no dependency); each lane is
      an ordered queue applied one batch at a time. A lane sends whatever queued up while its previous write
      was in flight, up to `batchMax`. 6 unit tests.
- [x] T06.2 `src/pipeline/checkpointer.ts`: per transaction, count outstanding changes across lanes. Ack
      the highest commit end LSN such that it and all earlier transactions are fully applied. Pure logic +
      unit tests (out-of-order completion, empty transactions, a transaction spanning lanes).
- [x] T06.3 Wire it in. Sink: coalesce per key across a lane batch (each key ends as one delete or one merged
      upsert, so a batch's upserts and deletes touch disjoint keys → at most 2 writes, sent in parallel);
      `clear()` for TRUNCATE. Main: dispatch transactions into lanes without waiting; TRUNCATE is a barrier
      (D-018); the idle check counts in-flight transactions; periodic stats line; knobs `DRIFTLESS_LANES`
      (default 8), `DRIFTLESS_BATCH_MAX` (default 500, raised to 5000 by T06.4's measurements),
      `DRIFTLESS_LOG_TXNS`.
- [x] T06.4 Benchmark: backlog drain (the same backlog, unbatched vs lanes 1 vs lanes 8) → RESULTS.md. Chaos +
      reconcile at 200 tx/s with lanes = 8, batch = 500 → 0 drift
- [x] T06.5 Verify (TEST_CHECKLIST → T06), `learn/task-06-lanes-and-batching.md`, checkpoint

**Dependencies:** none new.

**Pitfalls**
- Acking a later transaction while an earlier one is still in flight on a slow lane = data loss on crash.
- Delete + re-insert of one key inside a batch: coalescing must respect order.
- Lanes are unbounded until T08. Keep a size counter now.

---

## T07 — Backfill ✅

**Goal:** index rows that existed before Driftless started, while writes continue, with zero drift.
First reproduce the naive race, then fix it (D-008).

- [x] T07.1 Naive backfill: chunked `SELECT … WHERE id > $last ORDER BY id LIMIT 1000` written straight to
      the sink, concurrently with the stream. Add a debug delay between SELECT and write to widen the race.
- [x] T07.2 Reproduce: workload + naive backfill + reconcile → drift > 0. Write
      `docs/bugs/BUG-NNN-backfill-race.md` with the numbers (the flagship interview story).
- [x] T07.3 Watermark backfill (FLOW.md → Flow 3): add table `driftless_watermark` to the publication;
      low mark → SELECT chunk → high mark; drop chunk keys changed between the marks; emit the rest into
      the lanes at the high mark
- [x] T07.4 Persist progress (last *applied* key) in a small unpublished `driftless_state` table so a killed
      backfill resumes. Trigger: new/empty index, or an explicit flag.
- [x] T07.5 Prove: same workload, 10 runs → 0 drift each; record in RESULTS.md, with backfill time for [N] rows
- [x] T07.6 Verify (TEST_CHECKLIST → T07), `learn/task-07-backfill.md`, checkpoint

**Dependencies:** none new.

**Pitfalls**
- Watermark table missing from the publication → marks never arrive → backfill hangs.
- Chunk rows must flow through the same lanes, or per-key order breaks.
- Save progress after the chunk is applied, not after it's read.

---

## T08 — Backpressure & WAL safety ✅

**Goal:** a slow or dead sink never crashes Driftless, and a dead Driftless never fills the Postgres disk.

- [x] T08.1 Spike: find how to stop reading the replication stream (a library API, or pausing the
      underlying socket so TCP backpressure stops the WAL sender). Record the mechanism in DECISIONS.md.
- [x] T08.2 Bound total buffered events: pause at a high-water mark, resume below a low-water mark (hysteresis)
- [x] T08.3 Slow-sink test: `docker pause` Meilisearch for 5 min under load → memory flat, no crash;
      unpause → catch up → reconcile = 0
- [x] T08.4 WAL safety: first observe retained WAL growing with the connector stopped (record it). Then set
      `max_slot_wal_keep_size` in compose. On start, detect `wal_status = 'lost'` and stop with recovery
      steps (drop + recreate slot, re-backfill).
- [x] T08.5 Verify (TEST_CHECKLIST → T08), `learn/task-08-backpressure.md`, checkpoint

**Dependencies:** none new.

**Pitfalls**
- Pausing in the wrong layer just moves the buffering into the library.
- `pg-logical-replication` 2.5's `flowControl` does pause the socket, but its keepalives bypass its queue
  (D-019). If you use it, keep Driftless's own idle check. While the socket is paused, keepalive requests
  aren't read, so send periodic status updates yourself or `wal_sender_timeout` (60 s) drops the connection.
- Without hysteresis, pause/resume thrashes.
- An invalidated slot means changes were lost for the sink. Never "just continue".

---

## T09 — Observability & benchmarks ✅

**Goal:** make freshness visible, and produce the resume numbers from real, recorded runs.

- [x] T09.1 `src/metrics.ts` + `GET /metrics` (prom-client): `driftless_lag_seconds` histogram
      (sink-confirmed time − commit time), events applied by op, batch size, lane queue depth, acked LSN,
      slot retained WAL bytes
- [x] T09.2 Prometheus + Grafana in compose (127.0.0.1 ports; check they're free first); dashboard
      provisioned from `docker/grafana/`
- [x] T09.3 Benchmarks: pgbench at fixed rates, stepping up until lag grows without bound; batch 1 vs 500;
      lanes 1 / 4 / 8 → RESULTS.md with machine, versions and exact commands
- [x] T09.4 Headline chaos run ([M] updates, SIGKILL every 30 s) → reconcile = 0 → RESULTS.md
- [x] T09.5 Verify (TEST_CHECKLIST → T09), `learn/task-09-observability.md`, checkpoint

**Dependencies:** `prom-client`.

**Pitfalls**
- Lag compares Postgres's clock (commit time) with the connector's. They're the same machine here, but note it.
- Histogram buckets must span milliseconds to minutes.
- Benchmark on a quiet machine: stop the other projects' containers first and say so in RESULTS.md.

---

## T10 — Config, packaging, README, release ✅

**Goal:** someone else can run Driftless from the README in minutes.

- [x] T10.1 Config file `driftless.config.json` (source connection, table → index, primary key, columns to
      include/exclude), validated at start with clear errors; env vars override
- [x] T10.2 `Dockerfile` (node:24-alpine, `npm ci --omit=dev`, runs `node src/main.ts`, no build step) +
      `.dockerignore`; the compose `connector` service uses it
- [x] T10.3 README.md: what it is, how it works (diagram), quick start, tests, results (from RESULTS.md only),
      limitations
- [x] T10.4 Final docs pass: ARCHITECTURE and FLOW match the code; DECISIONS complete; learn/task-01…10 exist
- [x] T10.5 GitHub, **only after the owner's explicit go-ahead**: create the repo, push `main` + tags, check
      the contributors list shows only the owner; tag `v0.1.0`
- [x] T10.6 Verify (TEST_CHECKLIST → T10), `learn/task-10-release.md`, checkpoint

**Dependencies:** none new (JSON needs no parser).

**Pitfalls**
- A fresh-clone test catches forgotten setup steps (for example `git config core.hooksPath .githooks`).
- `.dockerignore` must exclude `node_modules`, `.git`, `docs`, `learn`.

---

## T11 — Polish after release ✅

**Goal:** make the published project stronger where it counts: correctness reviewed again with fresh eyes, every push
proven automatically, and a README that shows rather than tells. Asked for by the owner on 2026-10-23 ("make the
project better in every possible way"). Scope kept to what adds real value; the stretch goals stay cut.

- [x] T11.1 Delete the fresh-clone test folder `D:\PROJECTS\driftless-fresh` (owner asked)
- [x] T11.2 Fresh-eyes review of `src/` against the invariants; fix what's real, each fix with a test where it's
      logic (D-015: reproduce before fixing)
- [x] T11.3 CI (`.github/workflows/ci.yml`): typecheck + unit tests on every push, plus an end-to-end job on the real
      stack (seed → backfill → SIGKILL chaos → reconcile = 0 → reconcile self-test) via `scripts/ci-e2e.sh`, which
      also runs locally
- [x] T11.4 README: CI badge, a Grafana screenshot from a real chaos run; `package.json` repository metadata
- [x] T11.5 BUG-001 upstream: already fixed independently in 2.6.0 (#222), so no report is needed. Pinned to exactly
      2.5.0 and added a contract test that fails if the library's +1 changes
- [x] T11.6 Verify, `learn/task-11-polish.md`, checkpoint; push only with the owner's go-ahead

**Dependencies:** none new for the project. CI uses GitHub's own `actions/checkout@v4` and `actions/setup-node@v4`.

---

## T12 — Redis cache as a second sink ✅ (approved by the owner 2026-10-23, with Redis on by default)

**Goal:** the same change stream also keeps a Redis cache exact: `product:{id}` always equals the row, never an older
value. Proven the way the index is: reconcile, connector crashes, and a crash of Redis itself.

**Design (recorded as D-029 when built):**
- **Shape:** one Redis *hash* per row, `product:{id}`, one field per column, each value JSON-encoded so types survive.
  An update that omits unchanged TOAST columns becomes `HSET` of only the sent fields: the same merge semantics as
  Meilisearch's `updateDocuments`. A delete is `DEL`. The same column filter as the index applies.
- **Both sinks or nothing:** a lane batch counts as applied, and its transactions can be confirmed, only after **both**
  Meilisearch and Redis have applied it. They're written in parallel. Fail-stop plus idempotent replay already covers
  either one failing.
- **Durability:** Redis runs with AOF `appendfsync always`, so it acknowledges only what's on disk. With the default
  `everysec`, a Redis crash loses up to a second of writes, which can *roll a key back to an older value*, i.e. a stale
  cache. T12.5 reproduces that first (D-015), then proves `always` fixes it.
- **Readers only read:** nothing but Driftless writes the cache (no cache-aside fill on a miss), so the classic "stale set
  after invalidation" race can't happen. A miss means "not cached yet", never "wrong".
- **Errors:** connection lost or refused → retry forever with backoff, like Meilisearch being unavailable (D-021). A
  command error (e.g. `WRONGTYPE`) → fail-stop.
- **TRUNCATE:** remove the key prefix (`SCAN` + `UNLINK`), as a barrier like the index clear.
- **Backfill:** starts by itself when *any* sink is empty and the table isn't (e.g. switching Redis on for existing
  rows). It rewrites both sinks, which is harmless.

- [x] T12.1 Dependencies (**approved by the owner 2026-10-23**): `@redis/client` 6.3.0 (MIT, no dependencies of its own,
      published 2026-09-30) and the image `redis:8.10.1-alpine` (pushed 2026-09-21); both pass the 14-day rule.
      Compose service `redis` on `127.0.0.1:6381` (6379/6380 are taken), AOF `always`, its own volume. D-029.
- [x] T12.2 Sink contract, no behavior change: `type Sink = { name, applyBatch, clear, isEmpty }`; main applies every
      batch to every sink; `driftless_write_seconds{sink}`; chaos → 0 drift
- [x] T12.3 `src/sinks/redis.ts` + unit tests (fake client): coalesced batch → one pipeline (`HSET`/`DEL`), retry
      policy, clear by prefix, `isEmpty`
- [x] T12.4 Config: optional `redis: { url, keyPrefix }` (omit it = Meilisearch only); `REDIS_URL`, `REDIS_PASSWORD`
      (a secret: env only). Reconcile and its self-test cover Redis too
- [x] T12.5 Proofs → RESULTS §12: (a) backfill the existing rows into an empty Redis; (b) chaos with connector SIGKILLs
      → 0 drift in both sinks; (c) reproduce the stale-key loss: `everysec` + Redis SIGKILL under load (bug note).
      **Deviation:** a process kill can't make `everysec` lose data (written data survives in the OS page cache), so
      (c) runs three modes instead. Redis's defaults (snapshots only) lose data, while `everysec` and `always` don't.
      It's recorded with D-029 rather than as a bug note, since it validates a design choice;
      (d) `always` + the same test → 0 drift; (e) Redis paused 2 min under load → backpressure, 0 drift; (f) what
      Redis adds to write time and lag at 1,000 tx/s
- [x] T12.6 CI e2e with Redis; dashboard panel per sink; README (diagram, config, results); `learn/task-12-redis.md`;
      checkpoint

**Dependencies:** `@redis/client`, image `redis:8.10.1-alpine` (T12.1).

**Pitfalls:** check that `@redis/client`'s peer dependencies are optional before installing. Redis must never be
reachable beyond 127.0.0.1 (it has no password in local dev). Keep the products-only benchmarks comparable by noting
which runs had Redis on.

---

## T13 — Multiple tables per instance ✅ (approved by the owner 2026-10-23)

**Goal:** one Driftless mirrors several tables, each into its own index and Redis prefix, with the same guarantees,
including transactions that touch several tables at once.

**Design (recorded as D-030 when built):**
- **Config:** `sync` becomes a list of mappings `{ table, index, primaryKey, columns?, redisKeyPrefix? }`. A single
  object is still accepted. Tables, index names and key prefixes must be unique.
- **Publication = exactly the configured tables** (+ the watermark table); setup adds and removes tables. Changes still in
  the WAL for a table that's no longer configured are skipped and logged, not fatal.
- **Routing:** the lane key becomes `table:pk`, so per-row order still holds and equal ids in different tables don't
  wait for each other. A transaction touching two tables is confirmed only when all of its changes, in every table and
  sink, are applied. The checkpointer already counts per transaction, so this is a test, not new logic.
- **TRUNCATE** of several tables in one statement: every mapped one is cleared behind one barrier.
- **Backfill:** one table at a time. Progress is saved per table (`backfill:<table>`; the existing `backfill` row
  becomes the products one), and marks carry the table name, so a mark can never be matched by the wrong table's
  backfill.
- **Reconcile, the startup check and metrics:** per table (a `table` label).

**Demo data:** a second table `public.customers` (id, name, email, city, updated_at; 20,000 seeded rows), and a
`multi` workload mix that includes transactions updating a product *and* a customer together. The standard
products-only mix stays exactly as it is (D-016), so earlier numbers stay comparable.

- [x] T13.1 Schema, seed and the `multi` workload (`db/workload/customer_*.sql`, `cross_table.sql`; `workload.sh`
      picks the mix with `WORKLOAD_MIX=multi`; the default is unchanged)
- [x] T13.2 Config list + validation; publication kept equal to the config; unknown tables skipped; unit tests
- [x] T13.3 Routing, dispatch and sinks per mapping (index and key prefix per table); a cross-table transaction test
- [x] T13.4 Backfill per table (saved progress, namespaced marks, migration of the old row); unit tests;
      `backfill-race.sh` with two tables
- [x] T13.5 Reconcile per table; proofs → RESULTS §13: chaos with the `multi` mix → 0 drift in both tables × both sinks;
      add a table to a running deployment's config → it backfills; remove one → its changes are ignored. CI e2e with
      two tables
- [x] T13.6 Docs (README config and limitations, ARCHITECTURE, FLOW), `learn/task-13-multi-table.md`, checkpoint;
      release `v0.2.0` (push and tag only with the owner's go-ahead)

**Dependencies:** none new.

**Pitfalls:** changing the backfill's saved-progress names must not restart a finished backfill or lose a running one
(migrate the old row). Removing a table from the publication doesn't remove its older changes from the slot, so they
must be skipped. Keep the existing single-table config files valid.

---

## T14 — Alerts: slot WAL, connector down or stalled, lag ✅ (approved by the owner 2026-11-11)

**Goal:** the operational promise is real: "the slot can't fill the disk, and someone finds out before Postgres
sacrifices it." We ship a Prometheus rule file anyone can drop into their own Prometheus. It fires when Driftless is down
or stuck, when search falls behind, and before the slot is invalidated. It's tested with `promtool` in CI and proven
live.

**Design (recorded as D-031 when built):**
- **The blind spot:** `driftless_slot_retained_wal_bytes` is measured by the connector itself. When Driftless is
  dead, which is the case that fills the disk, nothing reports it. So "connector down" is its own alert, on
  Prometheus's `up`. Measuring the slot from outside (postgres_exporter) would add a service. We skip it: `up == 0`
  plus the cap (D-026) cover that case.
- **One new gauge:** `driftless_slot_safe_wal_bytes`, read from `pg_replication_slots.safe_wal_size` in the same
  query. It's how much more WAL Postgres can write before it invalidates the slot. The slot alerts use the share of the
  cap in use, `retained / (retained + safe)`, so they work for any `max_slot_wal_keep_size`, not just our 1 GB. With
  no cap (`-1`), `safe_wal_size` is NULL and those alerts can't fire, so Driftless also warns at startup when the cap
  is unlimited.
- **Rules** (`docker/prometheus/alerts.yml`, group `driftless`). The thresholds are starting points, commented in the
  file as the knobs to tune:

  | Alert | Fires when | For | Severity |
  |---|---|---|---|
  | `DriftlessDown` | `up{job="driftless"} == 0`: not running, so the slot holds WAL and search goes stale | 2m | critical |
  | `DriftlessStalled` | running, transactions in flight, nothing applied: a sink is down or stuck (D-021 retries forever) | 5m | critical |
  | `DriftlessLagHigh` | lag p99 over 5 min > 60 s (no traffic → no data → silent) | 10m | warning |
  | `DriftlessSlotWalHigh` | over 50 % of the cap in use | 5m | warning |
  | `DriftlessSlotWalCritical` | over 80 % of the cap in use: near invalidation, which means a full re-backfill | 1m | critical |

- **Where alerts go:** Prometheus evaluates them and lists them at `:9090/alerts`. The dashboard gets one panel
  showing `ALERTS{alertname=~"Driftless.*"}`. Sending them to Slack, email or a pager is the job of the user's own
  Alertmanager. The demo stack gets no Alertmanager container; add one if local notifications are ever wanted.

- [x] T14.1 The gauge `driftless_slot_safe_wal_bytes` (the same query as the retained gauge); a startup warning when
      `max_slot_wal_keep_size` is unlimited. Check both live (`GET /metrics`; a stack started without the cap)
- [x] T14.2 `docker/prometheus/alerts.yml` + `rule_files` and `evaluation_interval: 15s` in `prometheus.yml`;
      `docker/prometheus/alerts.test.yml` for `promtool test rules`: every alert fires on its synthetic series and
      stays silent on a healthy one, including no traffic (no lag alert) and an idle connector (no stall alert)
- [x] T14.3 CI: `promtool check rules` + `promtool test rules` in the unit job, run from the pinned
      `prom/prometheus:v3.15.0` image (no new dependency)
- [x] T14.4 Dashboard panel "Firing alerts" (built as "Alerts: pending and firing", a table of `ALERTS`)
- [x] T14.5 Live proofs → RESULTS §14: (a) `docker compose kill connector` → `DriftlessDown` fires, then resolves after
      a restart; (b) `docker pause meilisearch` under load → `DriftlessStalled`; (c) the cap lowered to 256 MB
      (Postgres recreated with `PG_MAX_SLOT_WAL_KEEP_SIZE`: a `-c` setting beats `ALTER SYSTEM`, so T08.4's way no
      longer works), Meilisearch paused under load, the WAL grown in steps with `pg_logical_emit_message` →
      `SlotWalHigh`, then `SlotWalCritical` *before* the slot is lost; then unpause, reconcile → 0 drift, cap back to
      1 GB; (d) record how close `retained + safe` is to the cap. All three: `scripts/alert-drill.sh down|stalled|slot`
- [x] T14.6 README (monitoring: the alerts, using the rule file with your own Prometheus, the job label), ARCHITECTURE,
      FLOW, D-031, `learn/task-14-alerts.md`, checkpoint

**Dependencies:** none new (`promtool` ships in the Prometheus image we already pin).

**Pitfalls**
- The rules match `job="driftless"`. A user whose Prometheus calls the job something else must edit that one label,
  so the README says so.
- A connector run on the host isn't scraped (`prometheus.yml` targets the container). Run the proofs with the Docker
  connector.
- A new alert needs its `for:` plus up to one evaluation interval before it fires. Wait for it; don't shorten `for:`
  to make a test pass.
- With a lowered cap, a Meilisearch pause that runs too long *will* lose the slot, and recovery is a full backfill
  (D-026). The drill grows the WAL in controlled steps and stops at `SlotWalCritical` (~85 %); that's the proof. Put
  the 1 GB cap back afterwards (recreate `postgres` without the variable).

---

## T15 — Publish: image on GHCR, CLI on npm; release `v0.3.0` (approved by the owner 2026-11-11)

**Goal:** use Driftless without cloning it: `docker run ghcr.io/kunal874/driftless:0.3.0` or `npx driftless-cdc`. Both are
built by CI from a version tag and checked against a real stack after publishing.

**Design (recorded as D-032 when built):**
- **Image:** `.github/workflows/release.yml` runs on tags `v*`. It runs typecheck + unit tests, refuses if the tag ≠
  the `package.json` version, then builds the existing Dockerfile for `linux/amd64` and `linux/arm64` (Apple Silicon,
  Graviton; every dependency is plain JS) and pushes `ghcr.io/kunal874/driftless:<version>` and `:latest`. It logs in
  with the workflow's own `GITHUB_TOKEN` (`packages: write`), so no secret is stored. The label
  `org.opencontainers.image.source` links the package to the repo. Users mount their config over
  `/app/driftless.config.json` (or set `DRIFTLESS_CONFIG`) and pass secrets as env, as the README already says.
- **The npm catch:** Node refuses to strip types from files inside `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a package can't ship `src/*.ts` the way the image does. The npm
  package ships JavaScript emitted by the `tsc` we already have: `tsconfig.build.json` emits to `dist/`, and
  `rewriteRelativeImportExtensions` turns `./config.ts` into `./config.js`. Tests are excluded. Checked on 2026-11-11
  with tsc 7.0.2: the emitted `main.js` loads its whole module graph and stops with the normal config error (exit 2).
  **This build step is for the npm package only.** The image and the repo keep running the `.ts` files directly; D-004
  stays, with the exception recorded in D-032.
- **CLI** `src/cli.ts` (bin `driftless`), argument parsing with `node:util` `parseArgs` (no dependency):
  - `driftless` runs the connector (today's `main.ts`).
  - `driftless reconcile [--timeout=S]` compares every row with every sink and only reads. Exit 0 = identical, 1 =
    drift. It moves from `scripts/` into `src/` so the package can ship it; `scripts/reconcile.ts` stays as a thin
    wrapper, so every documented command keeps working. **`--self-test` stays out of the CLI:** it plants wrong
    documents in the index, which is fine in a test stack and harmful in someone's production search.
  - `--config <file>` (the same as `DRIFTLESS_CONFIG`), `--version`, `--help`.
- **Name: `driftless-cdc`** (chosen by the owner 2026-11-11). `driftless` on npm is taken by an unrelated package
  (v2.0.3, last changed 2022); `driftless-cdc` was free on 2026-11-11. The command it installs is still `driftless`.
- **Publishing auth:** npm trusted publishing (OIDC from the release workflow: no stored token, and provenance is
  attached). Owner steps: create the npm account. If npm requires the package to exist before a trusted publisher can
  be added, the owner publishes `0.3.0` once by hand; later releases publish from CI.
- **Package contents:** `files: ["dist", "README.md", "LICENSE"]`, `private` removed, `prepack` runs the build. Review
  `npm pack --dry-run` for anything that shouldn't ship (config, `.env`, tests, `scripts/`).

- [ ] T15.1 `src/cli.ts` + reconcile moved into `src/` (wrapper left in `scripts/`); unit test for argument parsing;
      `tsconfig.build.json`, `npm run build`; `dist/` gitignored. `npm test` and the CI e2e still pass unchanged
- [ ] T15.2 `package.json` for publishing (name, `bin`, `files`, `prepack`, no `private`); config error text no longer
      assumes the repo root. Smoke test of the **packed tarball**, installed in an empty folder: `driftless --version`;
      `driftless` streams against the dev stack; `driftless reconcile` → 0. The same pack-and-install check in CI (a
      bad config → exit 2 proves every module resolves)
- [ ] T15.3 `release.yml` (image + npm) with a `workflow_dispatch` dry run: build both architectures and run
      `npm publish --dry-run`, pushing nothing. Actions pinned per D-017
- [ ] T15.4 Owner steps, each only with the owner's go-ahead: the npm account and trusted publisher; push; the dry run
      on GitHub; tag `v0.3.0` → the workflow publishes; the owner makes the GHCR package public (GitHub creates new
      container packages as private)
- [ ] T15.5 Verify from outside, on a throwaway stack (`COMPOSE_PROJECT_NAME=driftless-release`): the **published**
      image and the **published** CLI (`npx` in an empty folder) each backfill, survive a SIGKILL + restart, and
      reconcile to 0 → RESULTS §15. README "Install" section (docker run, npx) and badges; D-032;
      `learn/task-15-publish.md`; checkpoint

**Dependencies (approved by the owner 2026-11-11):** Docker's official GitHub Actions `docker/setup-qemu-action`,
`docker/setup-buildx-action`, `docker/login-action`, `docker/metadata-action` and `docker/build-push-action`, at their
current majors and at least 14 days old when T15.3 starts (D-017). No new npm dependencies.

**Pitfalls**
- Type stripping is off in `node_modules`, so test the **packed tarball**, never the repo checkout. The checkout works
  either way and would hide the problem.
- GHCR image names must be lowercase: `kunal874`, not `Kunal874`.
- New GHCR packages are private. Until the owner makes it public, `docker pull` fails for everyone else.
- Publishing is outward-facing and permanent: an npm version number can never be reused, even after an unpublish.
  Do the dry run first; push the tag only with the owner's go-ahead.
- `ci.yml` ignores tag pushes on purpose. `release.yml` is the only workflow that runs on tags.
- The shipped `driftless.config.json` points at local-dev hosts. The image keeps it as its default; the npm package
  doesn't ship it (users write their own, and the README gives a minimal one).
- `v0.3.0` ships T14 and T15 together, so T14 comes first.

---

## Stretch goals ✂ (only after T10, or if well ahead; cut first)

- **S1 Redis cache sink** (→ planned as T12): write-through from the same stream, key `product:{id}`. Readers never write the
  cache, so the stale-set race can't happen.
- **S2 Standby connector:** a second instance waits to take over the slot. Postgres allows one active
  consumer per slot, so the slot itself works as the lock.
- **S3 Typesense sink:** a second sink behind the same interface (proves the sink boundary).
- **S4 Schema changes:** handle pgoutput relation messages (column added/removed); document that DDL itself
  isn't replicated.
