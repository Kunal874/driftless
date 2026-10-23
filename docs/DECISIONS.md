# Decisions — why we chose what we chose

Accepted decisions are not reversed silently (CONSTRAINTS rule 5). To change one: ask the
owner, then add a new entry that supersedes it, and mark the old one `Superseded by D-0xx`.
Short reasoning lives here; the long plain-language version lives in `learn/`.

| ID | Decision | Status | Task |
|---|---|---|---|
| D-001 | Read changes from the Postgres WAL (CDC); never dual-write | Accepted | design |
| D-002 | `pgoutput` plugin, protocol v1 | Accepted | design → T03 |
| D-003 | Meilisearch as the first sink | Accepted | T01 |
| D-004 | TypeScript on Node 24, run directly (no build step) | Accepted | design → T03 |
| D-005 | No Kafka or other broker | Accepted | design |
| D-006 | At-least-once delivery + idempotent writes; ack after apply | Accepted | design → T04 |
| D-007 | Per-primary-key ordered lanes | Accepted | design → T06 |
| D-008 | Watermark (DBLog) backfill, after reproducing the naive race | Accepted | design → T07 |
| D-009 | Fail-stop on persistent sink errors | Accepted | design → T04 |
| D-010 | Pin Postgres 17.11 and Meilisearch v1.54.3 exactly | Accepted | T01 |
| D-011 | Local-only Docker Compose stack | Accepted | T01 |
| D-012 | Docs + memory system (AGENTS.md, docs/, learn/) | Accepted | T01 |
| D-013 | Single author, enforced by a commit-msg hook | Accepted | T01 |
| D-014 | One branch, one commit per step, checkpoint tags | Accepted | T01 |
| D-015 | Correctness harness before performance work | Accepted | plan |
| D-016 | Deterministic seed data + one workload definition | Accepted | T02 |
| D-017 | New dependency versions must be at least 14 days old | Accepted | T03 |
| D-018 | TRUNCATE is streamed and handled, not filtered out | Accepted | T03 |
| D-019 | The confirm protocol: exact end positions, idle confirms, own queue | Accepted | T03 |
| D-020 | Document shape: exact string ids, ISO dates, partial docs merged | Accepted | T04 |
| D-021 | Retry policy: wait out unavailability, fail-stop on rejection | Accepted | T04 |
| D-022 | Natural batching + per-key coalescing across transactions | Accepted | T06 |
| D-023 | Watermark backfill: marks written through the WAL bracket each chunk | Accepted | T07 |
| D-024 | Backfill progress in an unpublished table; resume beats request | Accepted | T07 |
| D-025 | Backpressure by pausing the replication socket; safe status timer | Accepted | T08 |
| D-026 | Cap slot WAL at 1 GB; refuse to start on a lost slot; recovery is manual | Accepted | T08 |
| D-027 | Keep 8 lanes by default; 1 lane is the low-lag setting for Meilisearch | Accepted | T09 |
| D-028 | Config file for what/where, env for secrets and tuning; check it before creating anything | Accepted | T10 |
| D-029 | Redis as a second sink: hashes, both-or-nothing, durable acknowledgements, readers never write | Accepted | T12 |
| D-030 | Several tables per instance: one mirror per table, one stream, per-table backfill rounds | Accepted | T13 |

---

### D-001 — Read changes from the WAL (CDC); never dual-write
- **Decision:** the app writes only to Postgres. Driftless reads committed changes from the WAL
  through logical replication and applies them to the index.
- **Why:** the WAL is the only record that holds every committed change *in commit order*. Dual
  writes (`save to DB; save to index`) drift when a crash lands between the two writes, or when two
  concurrent updates reach the index in reverse order.
- **Rejected:** dual writes (drift, above). Periodic full re-index (hours stale, heavy).
  Debezium + Kafka Connect (correct and battle-tested, but needs Kafka plus a JVM stack; the goal
  is one small container).
- **Consequences:** the index is *eventually* consistent, so lag becomes a metric (T09). Postgres
  needs `wal_level=logical` and a replication slot that must be watched (T08).

### D-002 — `pgoutput` plugin, protocol v1
- **Decision:** decode the WAL with `pgoutput`, Postgres's built-in logical decoding plugin.
- **Why:** it ships with Postgres (since v10) and is what Postgres's own logical replication uses,
  so nothing extra is installed in the server. It sends explicit BEGIN/COMMIT and relation (schema)
  messages.
- **Rejected:** `wal2json` (an extension that must be installed into the server image). `test_decoding`
  (a demo plugin, not meant for production).
- **Consequences:** needs a pgoutput parser (`pg-logical-replication`). With proto v1, a transaction
  arrives only after it commits, so a huge transaction arrives all at once (memory bound, T08).

### D-003 — Meilisearch as the first sink
- **Why:** light (single binary, small RAM) and popular with small teams, who are the likely users.
  Its writes are asynchronous tasks, which forces the "ack only after it's really applied" discipline.
- **Rejected:** Elasticsearch/OpenSearch (JVM, heavier; PGSync already targets them). Typesense
  (similar; stretch goal S3).
- **Consequences:** wait for task `succeeded` before acking (T04). Document ids must be integers or
  strings made of `A–Z a–z 0–9 - _`.

### D-004 — TypeScript on Node 24, run directly
- **Decision:** write the connector in TypeScript and run `node src/main.ts` directly; Node 24
  strips the types natively. `tsc` is used only for type-checking (`noEmit`).
- **Why:** the owner's main stack. The workload is I/O-bound (network in, network out), which
  Node's event loop handles well. No build step and no `tsx`/`ts-node` dependency.
- **Rejected:** Go or Java (faster in raw terms, but a new language, and the bottleneck is the sink).
  `tsx`/`ts-node` (a dependency for something Node now does natively).
- **Consequences:** only "erasable" TypeScript syntax: no `enum`, `namespace` or constructor parameter
  properties. Enforced with `erasableSyntaxOnly`. Relative imports use `.ts` extensions.

### D-005 — No Kafka or other broker
- **Why:** the WAL plus the replication slot already form a durable, ordered log with a server-side
  bookmark. A broker would be a second log to keep consistent, and more infrastructure.
- **Consequences:** Postgres allows only one active connection per slot, so parallelism comes from
  lanes *inside* the process (D-007) and high availability from a standby (stretch S2).

### D-006 — At-least-once delivery + idempotent writes; ack after apply
- **Decision:** acknowledge an LSN only after the sink confirms every change up to it. Sink writes
  are upsert/delete by primary key.
- **Why:** exactly-once *delivery* between two systems isn't possible without a shared transaction.
  At-least-once delivery plus idempotent writes gives an exactly-once *effect* in the index.
- **Rejected:** ack on receive (at-most-once: a crash loses changes). Two-phase commit (Meilisearch
  doesn't support it).
- **Consequences:** after a crash, recent changes are re-applied (brief and harmless). The
  checkpointer must track exactly what's applied.

### D-007 — Per-primary-key ordered lanes
- **Decision:** route each change by `hash(pk) % N` to one of N lanes. Each lane applies changes in
  order, and a batch collapses multiple changes to the same key into its final state.
- **Why:** one serial applier can't keep up with high write rates. Random parallelism breaks per-row
  order. Hashing the key gives both speed and order.
- **Rejected:** a single lane (too slow; measured in T06). One lane per table (a hot table is still
  one lane).
- **Consequences:** a multi-row transaction can briefly appear half-applied in search (fine for
  search). Acks must wait for all lanes (contiguous-prefix checkpointer).

### D-008 — Watermark (DBLog) backfill, after reproducing the naive race
- **Decision:** backfill existing rows in primary-key chunks between low/high watermarks written to a
  watermark table in the publication. Drop chunk rows that changed between the marks (FLOW.md, Flow 3).
- **Why:** a naive "SELECT chunk → write" can overwrite a newer streamed value with an older snapshot
  value, permanently. Netflix's DBLog technique (2020), also the basis of Debezium's incremental
  snapshots, avoids this without locking the table.
- **Rejected:** locking the table during the snapshot (blocks the app). `UPDATE t SET id = id` to
  push every row through the WAL (works, but rewrites the whole table on the primary).
- **Consequences:** the watermark table must be in the publication, and backfill progress must be
  saved only after a chunk is applied.

### D-009 — Fail-stop on persistent sink errors
- **Decision:** if the sink keeps failing after retries with backoff, stop with a clear error that
  names the row and reason. Never ack past, or skip, an unapplied change.
- **Why:** correctness over availability. A skipped change means permanent, silent drift. A stopped
  connector is visible (the lag grows), and it resumes without losing anything.
- **Rejected:** dead-letter-and-continue (the row silently diverges until it changes again).
- **Consequences:** one poison document blocks the pipeline, so the error message must be precise. A
  DLQ with re-drive could be a later, separate decision.

### D-010 — Pin Postgres 17.11 and Meilisearch v1.54.3 exactly
- **Why:** exact versions make results reproducible (RESULTS.md records them). Postgres 17 is stable
  and widely supported; Postgres 18's Docker image moved its data directory
  (`/var/lib/postgresql/18/docker`), a gotcha we don't need. Meilisearch 1.54.3 over 1.55.0,
  which was days old on 2026-10-22.
- **Consequences:** upgrades are deliberate: change the tag, re-run the checklists, note it here.

### D-011 — Local-only Docker Compose stack
- **Decision:** everything runs from `docker-compose.yml`, every port bound to `127.0.0.1`,
  Postgres on host port 5440, dev credentials written inline.
- **Why:** $0, reproducible, resettable in seconds. Chaos tests need to SIGKILL processes
  (`docker kill`). Binding to `127.0.0.1` keeps the dev databases off the network. On the owner's
  machine 5432 is a Windows-installed Postgres and 5433/5434 belong to other projects' containers
  that auto-start with Docker, so Driftless uses 5440.
- **Rejected:** installing the services on Windows (version drift, hard to reset). Forcing a `.env`
  file for local-only dev values (friction with no security gain). Real secrets still go in `.env`.

### D-012 — Docs + memory system
- **Decision:** `AGENTS.md` holds tool-agnostic agent instructions and status; `CLAUDE.md` imports it
  (`@AGENTS.md`) so Claude Code loads it automatically. Project docs live in `docs/`; a plain-language
  explanation of each finished task lives in `learn/`.
- **Why:** any session (or person) can resume from the files alone after a crash, a usage limit or a
  new chat. One source of truth instead of one copy per tool.
- **Consequences:** every step commit updates BUILD_PLAN.md and HANDOVER.md (CONSTRAINTS rule 11).

### D-013 — Single author, enforced by a commit-msg hook
- **Decision:** commits carry only the owner's identity. `.githooks/commit-msg` rejects
  `Co-Authored-By:` and "Generated with Claude" lines; it is enabled with `git config core.hooksPath .githooks`.
- **Why:** owner requirement for a portfolio repo. Documentation is guidance; a hook is enforcement.
- **Consequences:** `core.hooksPath` is per-clone config and must be set again after cloning.

### D-014 — One branch, one commit per step, checkpoint tags
- **Decision:** work on `main`; commit messages start with the step id (`T03.2: …`); tag
  `checkpoint/Tnn` when a task is complete.
- **Why:** every step becomes a restore point and tags mark known-good states (ROLLBACK.md). For a
  solo project, feature branches add ceremony without benefit.
- **Consequences:** never commit a broken step. Half-done state goes into HANDOVER.md notes instead.

### D-015 — Correctness harness before performance work
- **Decision:** build reconcile + chaos testing (T05) before lanes and batching (T06).
- **Why:** a fast pipeline you can't prove correct is worthless. With the harness in place, every
  optimisation is checked for drift the moment it lands.

### D-016 — Deterministic seed data + one workload definition
- **Decision:** `db/seed.sql` calls `setseed(0.42)`, so the same row count always produces identical data
  (verified: two runs, same checksum). The write workload's mix and weights are defined in exactly one
  place, `scripts/workload.sh` + `db/workload/*.sql`, and every test and benchmark runs through it.
- **Why:** benchmark and chaos numbers are only comparable if the data and the load are the same each time.
- **Consequences:** changing the seed, the mix or the weights makes earlier RESULTS.md numbers
  incomparable. Do it only deliberately, and note it in RESULTS.md.

### D-017 — New dependency versions must be at least 14 days old
- **Decision:** install with `npm install --before=<today − 14 days>` (Git Bash:
  `--before="$(date -d '-14 days' +%F)"`). `package-lock.json` then pins the exact versions.
- **Why:** a broken or compromised release is usually noticed and pulled within days, and waiting two
  weeks costs this project nothing. On 2026-10-22, `pg-logical-replication` 2.6.0 was 8 days old, so we
  took 2.5.0; `vitest` 5.0.3 instead of the 7-day-old 5.0.5.
- **Consequences:** upgrades are deliberate. Use `npm ci` to install exactly what the lockfile says.

### D-018 — TRUNCATE is streamed and handled, not filtered out
- **Decision:** the publication keeps Postgres's default `publish = 'insert, update, delete, truncate'`. The
  decoder emits a `truncate` change; the sink (T04) removes all documents of that table.
- **Why:** filtering TRUNCATE out means `TRUNCATE` followed by re-inserts (exactly what `db/seed.sql` does)
  leaves every deleted row in the index forever. That's silent drift, and handling it is one sink call.
- **Consequences:** in T06 a truncate must act as a barrier across lanes: everything before it is applied
  first, and nothing after it is applied before it.

### D-019 — The confirm protocol: exact end positions, idle confirms, own queue
- **Decision:** (`src/main.ts`)
  1. Both library auto-acks are off: `{ auto: false, timeoutSeconds: 0 }`.
  2. After a transaction is handled, confirm its `commitEndLsn`, an *end* position, which is exactly what
     Postgres's own subscriber sends. Pass it as `end − 1` because the library adds 1 (BUG-001).
  3. When idle (nothing received is unhandled or unconfirmed), confirm the keepalive's position, so the
     slot advances while only unpublished tables change.
  4. When busy and the server asks for a reply, re-send the current position ("alive", no progress).
  5. The confirmed position starts at the slot's `confirmed_flush_lsn` and never moves backwards.
  6. Incoming messages go into Driftless's own queue synchronously, not the library's `flowControl` queue,
     so a keepalive can never look "idle" while messages are still waiting.
- **Why:** each rule closes a way to lose data or pin WAL. (1) The auto-acks confirm work on *receipt*.
  (2) `+1` can skip the next transaction after a restart. (3) Without idle confirms, WAL from other tables
  piles up behind the slot. (4) Without replies, `wal_sender_timeout` (60 s) drops the connection.
  (6) With the library's queue, a keepalive parsed in the same network chunk as unhandled messages
  would look idle.
- **Proof (2026-10-22):** killed inside the ack window → slot unchanged; restart re-delivered the un-acked
  transaction and not the acked one; an idle connector advanced the slot to the server's exact WAL position.
- **Consequences:** T08 must bound the queue and pause the socket itself. While the socket is paused,
  keepalive requests aren't read, so T08 must also send periodic status updates.

### D-020 — Document shape: exact string ids, ISO dates, partial docs merged
- **Decision:** `src/sinks/document.ts` is the only row → document mapping. The index's primary key is
  `id`, and its value is the primary key **as a string** (`'10'`), exactly as `pg` delivers `bigint`.
  Dates become ISO-8601 strings. A row missing unchanged-TOAST columns gives a partial document, written
  with `updateDocuments`, which merges into the stored document.
- **Why:** strings keep 64-bit ids exact (JSON numbers are only exact up to 2⁵³), and Meilisearch accepts
  string ids. One mapping means the sink and reconcile (T05) can never disagree about what "correct" looks like.
- **Rejected:** numeric ids (precision risk for big keys); `addDocuments` (it *replaces* documents, so a
  partial row would wipe the description).
- **Consequences:** range filters on `id` would need a numeric copy of the field; reconcile compares by
  fetching documents by id instead.

### D-021 — Retry policy: wait out unavailability, fail-stop on rejection
- **Decision:** (`submit()` in `src/sinks/meilisearch.ts`; refines D-009)
  - *Meilisearch unavailable* (network error, request or task-wait timeout, HTTP 5xx, HTTP 429, HTTP 408): retry
    **without limit**, using exponential backoff with full jitter (random 0 … min(30 s, 100 ms × 2^attempt)).
    (408 was added in T08 after BUG-004: it's what a frozen Meilisearch answers once it wakes up.)
  - *Meilisearch rejected the write* (task `failed`): try 3 times in total, then stop with an error naming
    the transaction and ids. Other HTTP 4xx stops immediately.
- **Why:** an outage is temporary, and waiting loses nothing: nothing is confirmed, so Postgres keeps the WAL
  and lag shows the problem. A rejection is usually deterministic (a bad document), so retrying forever
  would hang silently. Jitter keeps retries from arriving in synchronized waves when the server comes back.
- **Consequences:** a long outage means a long wait with WAL piling up behind the slot (bounded by T08's
  WAL safety). Re-sending a write after an error can apply it twice, which is harmless: writes are
  idempotent, and Meilisearch processes tasks in the order they were enqueued.

### D-022 — Natural batching + per-key coalescing across transactions
- **Decision:** (`src/pipeline/lanes.ts`, `coalesce()` in `src/sinks/meilisearch.ts`, refines D-007)
  - A lane has **no flush timer**. When its write finishes, it sends whatever queued up meanwhile, up to
    `batchMax`. The defaults, 8 lanes and `batchMax` 5000, were chosen by measurement (RESULTS.md §4):
    8 × 5000 drained a backlog fastest (6,752 tx/s vs 4,910 with 500) and halved a 100k-row bulk load
    (3.2 s vs 6.9 s). Under normal load batches stay small anyway, so the cap only matters for bulk.
  - A batch may mix changes from many transactions. It is reduced to its net effect per key: one delete,
    or one upsert with fields merged in order. Upserts and deletes then touch different keys, so they're sent
    as at most two writes, in parallel.
  - Transactions are dispatched into the lanes without waiting. The checkpointer (`src/pipeline/checkpointer.ts`)
    confirms only the end of the unbroken run of fully applied transactions.
  - TRUNCATE waits for every lane to empty, clears the index, then dispatching continues (D-018).
- **Why:** one Meilisearch write costs about the same for 1 document as for 500 (T04: ~100 ms each), so
  throughput comes from writing many changes per task. A timer would add latency when the system is quiet;
  natural batching adds none, and batches grow by themselves under load (like a database's group commit).
- **Rejected:** a `BATCH_MS` flush timer (the original plan: extra latency with no benefit); sending a
  batch's changes in arrival order as several writes (more tasks, no correctness gain once keys are coalesced).
- **Consequences:** a delete followed by a re-insert of the same key collapses into one upsert. That's safe
  because an INSERT always carries every column (unchanged-TOAST markers only appear in UPDATEs). A
  multi-row transaction can become visible in search piece by piece, across lanes (accepted in D-007).

### D-023 — Watermark backfill: marks written through the WAL bracket each chunk
- **Decision:** (`createBackfill()` in `src/source/backfill.ts`; implements D-008)
  - Driftless owns a one-row table `public.driftless_watermark`, created on start and added to the publication.
  - Per chunk: `UPDATE … SET mark = 'low:<uuid>'` → `SELECT` the next chunk by primary key →
    `UPDATE … SET mark = 'high:<uuid>'`.
  - In the stream (dispatch, commit order): from the low mark on, collect every key that changes. At the high
    mark, push the chunk's rows **minus** those keys into the lanes, at that exact point. A TRUNCATE inside
    the window drops the whole chunk. Marks with another uuid (e.g. replayed after a restart) are ignored.
  - Keys are *collected* rather than removed from the chunk because the low mark can come through the stream
    before the `SELECT` has even returned.
- **Why:** the naive backfill let a snapshot copy, older than the moment it reached the lane, overwrite newer
  values and resurrect deleted rows (BUG-002: 42 documents wrong). The marks make the stream itself say which
  keys changed during the read, with no table locks and no reads of the WAL beyond what Driftless already streams.
- **Rejected:** locking the table during each chunk (blocks the app); comparing versions at the sink (rows have
  no reliable version number); `UPDATE t SET id = id` to push every row through the WAL (rewrites the table).
- **Consequences:** the publication streams one extra small table, and every chunk adds two tiny UPDATEs to the WAL.
  One chunk is in flight at a time. Postgres UPDATEs omit unchanged TOASTed columns, so the window tracks *columns*
  per key, not just keys (BUG-003).

### D-024 — Backfill progress in an unpublished table; resume beats request
- **Decision:** `public.driftless_state` (created by Driftless, **not** in the publication) holds
  `{"status":"running","after":<last applied key>}` or `{"status":"done",…}`. It's saved after each chunk is
  *applied*. On start: an interrupted backfill is **resumed**; otherwise `DRIFTLESS_BACKFILL=1` starts one;
  otherwise an empty index for a non-empty table starts one by itself.
- **Why:** a killed backfill must not start over (a crash loop would never finish), and it must never skip a
  chunk: saving progress after apply means the interrupted chunk is simply read again. Resume wins over the
  env flag because a supervisor restarts the container with the same environment. The empty-index rule covers
  first-time indexing and an accidentally deleted index.
- **Consequences:** to force a fresh backfill, delete the `backfill` row and start with `DRIFTLESS_BACKFILL=1`
  (ROLLBACK.md). The state table is unpublished, so its writes never come back through the stream.

### D-025 — Backpressure by pausing the replication socket; safe status timer
- **Spike findings (T08.1):** `pg-logical-replication` 2.5 has no public pause. Its `flowControl` pauses
  `_connection.stream`, but emits keepalives outside its queue (the D-019 race). `pg` reads the socket only
  through its `'data'` events (`Connection.attachListeners` → `pg-protocol`'s `parse(stream, …)`), so pausing
  that `net.Socket` stops *every* incoming message, keepalives included, while writes still work. Postgres defaults
  on this stack: `wal_sender_timeout` = 1 min, `max_slot_wal_keep_size` = −1 (unlimited).
- **Decision:** when the work waiting in Driftless (unprocessed stream messages + changes queued in lanes)
  reaches `DRIFTLESS_MAX_PENDING`, pause that socket; resume when it falls to half (hysteresis). The socket is
  reached through the library's private `_connection` field, checked at runtime so a library change fails loudly.
  A timer re-sends the *confirmed* position every 10 s, well under the 60 s timeout, so a paused connection stays alive.
- **Why:** pausing at the socket is real end-to-end backpressure. Unread data fills the kernel buffer, TCP stops the
  sender, and Postgres keeps the WAL (which it does anyway until we confirm). Nothing is dropped and memory stays
  bounded. Keeping our own counting preserves the D-019 idle check. Hysteresis avoids pausing and resuming on every message.
- **Rejected:** `flowControl` (the keepalive race); dropping or spilling messages to disk (the slot already *is* the
  durable backlog); a memory limit that crashes (that's an outage, not backpressure).
- **Consequences:** memory is bounded by the cap, plus one in-flight batch per lane, plus **the largest single
  transaction**. A transaction is assembled whole before dispatch (proto v1 sends it at commit) and isn't counted, or a
  huge one could never complete. A paused connector lets WAL grow on the server, so `max_slot_wal_keep_size` must
  cap it (T08.4).

### D-026 — Cap slot WAL at 1 GB; refuse to start on a lost slot; recovery is manual
- **Decision:** `docker-compose.yml` starts Postgres with `max_slot_wal_keep_size=1GB`. On start, Driftless reads the
  slot's `wal_status`: `lost` → refuse to start and print the recovery steps (ROLLBACK.md); `unreserved` → warn.
  Recovery stays manual: drop the slot, delete the index, reset the backfill progress, start (a new slot, then a full
  backfill).
- **Why:** the default is unlimited. A Driftless that's down long enough would fill the database's disk and stop
  Postgres itself, the worst thing a sidecar could do. With the cap, Postgres sacrifices the slot instead. A lost slot
  means changes are gone, so continuing would mean silent drift. Recovery deletes things (a slot, an index), so a
  person should decide to do it.
- **Proof (T08.4):** cap lowered to 32 MB, Driftless stopped, writes + 153 MB of unrelated WAL, `CHECKPOINT` →
  `wal_status = lost` → Driftless refused with the steps → steps followed → 150,085 rows backfilled → 0 drift.
- **Consequences:** an outage longer than ~1 GB of WAL costs a full backfill (105k rows: ~15–30 s here). Size the cap
  to the disk and the outage you want to survive.

### D-027 — Keep 8 lanes by default; 1 lane is the low-lag setting for Meilisearch
- **Context (T09.3):** lag at a steady 1000 tx/s, A-B-A on the same index: 1 lane p99 3.84 s → 8 lanes 4.99 s →
  1 lane 3.78 s (4 lanes: 6.50 s). Meilisearch's task timestamps explain it: it indexes **one batch at a time per
  index** (~1 s each here, mostly rebuilding its word dictionary) and merges every queued task into that batch. With
  N lanes, each task waits ~1 s behind the batch in progress (0.88–1.07 s queued vs 0.02–0.04 s with 1 lane), so
  extra lanes add waiting, not indexing parallelism.
- **But for a backlog,** on the same 195k-document index: 8 lanes × 5000 drained 2,810 tx/s, 1 lane × 40000 2,132,
  1 lane × 5000 1,700. Parallel requests still overlap the HTTP, JSON and task-polling work around each batch.
- **Decision:** the default stays `DRIFTLESS_LANES=8`: draining a backlog (after downtime, a bulk load, a backfill) is
  when speed matters, and steady lag differs by ~1–2 s. `DRIFTLESS_LANES=1` is the documented setting for the lowest
  steady-state lag on Meilisearch. Correctness is the same either way (per-key order holds for any lane count).
- **Revisit when:** a sink that really indexes writes in parallel (e.g. a Redis cache), or Meilisearch indexing
  batches concurrently.

### D-028 — Config file for what/where, env for secrets and tuning; check it before creating anything
- **Decision:** `driftless.config.json` (or `DRIFTLESS_CONFIG`) holds the connection without secrets, the table → index
  mapping, the primary key and an optional column `include`/`exclude` list. `PGPASSWORD` / `MEILI_MASTER_KEY` come
  only from the environment: the validator rejects secrets in the file and names the variable to use instead.
  `PG*` and `MEILI_HOST` override the file; tuning knobs (`DRIFTLESS_LANES`, …) stay env-only. The file is
  validated in full (every problem reported at once, unknown keys rejected so typos can't pass silently). Then, before
  anything is created, it's checked against the real table: `sync.primaryKey` must be the table's primary key, and
  every named column must exist. A config mistake prints one message and exits with 2, not a stack trace.
- **Why:** a wrong mapping is the cheapest bug to stop at start and the most expensive to find later (silently
  missing fields, or an index created with the wrong primary key). Found while testing T10.1: the Meilisearch check ran
  first, so a wrong primary key with a new index name would have created that index before failing. Postgres is now
  checked first.
- **Column filter:** applied in `toDocument`, the one definition of a document, so the sink, backfill and reconcile all
  agree. Proven live: `description` excluded on a separate index → backfill 274,776 rows + streamed updates/inserts →
  reconcile 0 drift, no `description` field, no search hits on its text.
- **Limits:** one table per Driftless; plain lower-case table names (no quoted identifiers).

### D-029 — Redis as a second sink: hashes, both-or-nothing, durable acknowledgements, readers never write
- **Decision:** the same change stream keeps a Redis cache next to the Meilisearch index. One hash per row,
  `product:{id}`, one field per column with a JSON-encoded value (types survive). An update that omits unchanged TOAST
  columns becomes `HSET` of only the sent fields, the same merge semantics as Meilisearch's `updateDocuments`; a delete
  is `DEL`; the config's column filter applies. A lane batch counts as applied only when **both** sinks applied it (written
  in parallel). Redis runs with AOF `appendfsync always`. Only Driftless writes the cache. Connection errors are retried
  forever with backoff; command errors (`ErrorReply`, e.g. `WRONGTYPE`) fail-stop. TRUNCATE removes the key prefix
  (`SCAN` + `UNLINK`) behind the same barrier as the index clear. A backfill starts by itself when any sink is empty.
- **Why hashes, not one JSON string per row:** a string would need a read-modify-write to apply a partial update (the
  WAL omits unchanged TOAST columns), which is slower and racy. `HSET` merges in one command.
- **Why both-or-nothing:** confirming a transaction tells Postgres it may forget it. If Redis hadn't applied it yet, a
  crash would leave the cache permanently behind. Ack-after-apply has to cover every sink (invariant 1).
- **Why `appendfsync always`:** with the default `everysec`, Redis acknowledges writes that may still be only in
  memory. A Redis crash can then lose the last second, and a key that was updated twice in that second goes back to an
  older value: a *stale* cache, the one failure a cache must never have. `always` makes Redis reply only after the
  write is on disk. **Proof (T12.5, RESULTS §12):** SIGKILL of Redis under load. Redis's out-of-the-box persistence
  (snapshots only) → 6,238 wrong keys, 4,143 of them rolled back to older values; `always` → 0 drift. (`everysec` also
  passed, because a process kill keeps written data in the OS page cache; its window opens on an OS crash or power
  loss, which the test can't cause.) Cost: about +0.15 s of lag at 1,000 tx/s.
- **Why readers never write:** in cache-aside, a reader that misses fills the cache from the database. A slow reader
  can then put back a value that a concurrent writer has just replaced (the stale-set race). Here the cache is filled
  only from the commit-ordered WAL, so a miss means "not cached yet", never "wrong".
- **Consequences:** every write now waits for the slower of two systems (Meilisearch, in practice). Redis down = the
  pipeline waits (backpressure), like Meilisearch down. Redis is optional: without a `redis` section in the config,
  Driftless runs with Meilisearch only.

### D-030 — Several tables per instance: one mirror per table, one stream, per-table backfill rounds
- **Decision:** `sync` is a list of mappings (a single object is still accepted). Each table gets a *mirror*: its own
  index, its own Redis key prefix (default `<index>:`; no prefix may start another) and its own backfill. All tables
  share one slot, one publication, one stream, one set of lanes and one checkpointer.
- **Routing:** lanes are keyed by `table:id`, so per-row order holds and equal ids in different tables don't wait for
  each other. A lane batch may mix tables; each table's share goes to that table's sinks, in parallel.
- **Transactions across tables need nothing new:** the checkpointer counts a transaction's changes wherever they're
  applied, so a transaction that changes a product and a customer is confirmed only when both are applied in every
  sink.
- **The publication equals the config:** setup adds new tables and drops removed ones. A removed table's changes can
  still be in the slot's WAL; dispatch skips them (logged once) instead of failing.
- **TRUNCATE** clears only the truncated, mirrored tables, behind the usual barrier.
- **Backfill:** one table at a time, in config order. Progress is saved per table (`backfill:<table>`); the pre-T13 row
  `backfill` is renamed once to the first table's name. Watermark marks carry random ids, so only the backfill that
  wrote a mark can match it, and there's no need to put the table in the mark.
- **Rounds (found while testing T13.4):** "resume beats request" (D-024) now applies across tables. If any table's
  backfill is `running`, a start continues that round, and `DRIFTLESS_BACKFILL=1` doesn't restart tables the round
  already finished. Otherwise a connector killed mid-round would redo the first table forever. And a requested round
  marks *every* table as due before it starts, so the request survives a restart.
- **Why one instance for several tables, not one instance per table:** one slot means one WAL position to hold and
  confirm, and transactions that span tables are confirmed atomically. With one instance per table, each would need
  its own slot (each holding WAL), and a cross-table transaction would be confirmed in pieces.
- **Limits:** every mirrored table lives in the same database; single-column primary keys; plain lower-case names.
  Changing a table's column filter needs a forced backfill to rewrite its documents.
