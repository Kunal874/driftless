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
