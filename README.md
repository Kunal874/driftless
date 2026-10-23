# Driftless

[![CI](https://github.com/Kunal874/driftless/actions/workflows/ci.yml/badge.svg)](https://github.com/Kunal874/driftless/actions/workflows/ci.yml)

**Keeps a Meilisearch index in sync with a Postgres table by reading the database's write-ahead log, and proves the
two never drift apart, even when the sync process is killed mid-write.**

The usual way to keep search in sync is a *dual write*: the app saves to Postgres, then also updates the search index.
When the second write fails, or two requests race, the index silently disagrees with the database, and nobody
notices until a customer searches. Driftless removes the second write. The app writes only to Postgres. Driftless
streams every committed change out of Postgres's WAL (logical replication) and applies it to Meilisearch, at least
once and in commit order per row, and it tells Postgres "done" only after the change is really in the index.

Written in TypeScript on Node 24 (run directly, no build step). Postgres 17, Meilisearch 1.54, Docker Compose.

## Results

Every number below comes from a recorded run in [docs/RESULTS.md](docs/RESULTS.md), with its exact command, date,
versions and machine (Windows 11, Docker Desktop, 28 CPUs / 7.6 GiB visible to Docker).

| What | Result |
|---|---|
| **Correctness under crashes** | **0 missing / 0 extra / 0 mismatched** documents out of 261,113, after **1,197,314 transactions** at 1,000 tx/s with the connector **SIGKILLed 36 times** (about every 30 s for 20 min). [§1](docs/RESULTS.md#1-correctness-under-crashes-t05) |
| **Freshness** (commit in Postgres → searchable) | p99 **3.6 s at 500 tx/s**, **4.9 s at 1,000 tx/s**. Kept up with ~4,800 tx/s, the most the machine's Postgres could generate. Lag ≈ 2 × one Meilisearch write, most of which is Meilisearch's own indexing. [§8](docs/RESULTS.md#8-end-to-end-lag-at-fixed-write-rates-t09) |
| **Throughput** (draining a backlog) | **9 → 6,752 tx/s** from batching across transactions + 8 parallel ordered lanes (on a ~105k-document index; 2,810 tx/s on a 195k-document one, since Meilisearch's per-batch cost grows with the index). [§4](docs/RESULTS.md#4-throughput-with-lanes-and-batching-t06), [§9](docs/RESULTS.md#9-lanes-throughput-vs-lag-t09) |
| **Backfill while the table is being written** | 0 drift in **10 / 10** races (≈105 race windows each), using DBLog-style watermarks. [§5](docs/RESULTS.md#5-backfill-under-load-t07) |
| **Meilisearch down for 5 minutes** at 600 tx/s | memory stayed bounded (backpressure; uncapped it grew 45 → 220 MiB and kept rising), connection kept alive, 0 drift after. [§6](docs/RESULTS.md#6-slow-sink-meilisearch-frozen-under-load-t08) |
| **Driftless down for too long** | Postgres gives up the slot at a 1 GB WAL cap instead of filling its disk; Driftless refuses to run on a lost slot and prints the recovery steps; recovery tested at 0 drift. [§7](docs/RESULTS.md#7-wal-safety-a-dead-driftless-cant-fill-the-disk-t08) |

**Every push re-proves the main claim.** CI type-checks, runs the unit tests, then starts the real stack on the
runner: it seeds 20,000 rows, lets Driftless backfill them, SIGKILLs the connector about every 10 s under 200 tx/s of
writes, and fails unless reconcile finds 0 drift ([`scripts/ci-e2e.sh`](scripts/ci-e2e.sh)).

![Grafana during a crash test](docs/images/dashboard-chaos.png)

*The provisioned dashboard during `scripts/chaos.sh 240 30 300`: 4 minutes at 300 tx/s with a SIGKILL about every 30 s.
Each kill shows as a gap in "Connector up" and a lag spike while the restarted connector replays unconfirmed work.
Backpressure never engaged, and once the run ended the WAL held for the slot drained to 56 bytes. Reconcile afterwards:
279,180 rows = 279,180 documents, 0 drift.*

Bugs found on the way, each with a repro and a write-up: a replication library acknowledging one byte too far
([BUG-001](docs/bugs/BUG-001-library-ack-off-by-one.md)), a backfill race that wrote stale rows back
([BUG-002](docs/bugs/BUG-002-backfill-race.md)), the watermark algorithm assuming full row images when Postgres omits
unchanged TOAST columns ([BUG-003](docs/bugs/BUG-003-watermark-toast.md)), and an HTTP 408 treated as fatal
([BUG-004](docs/bugs/BUG-004-http-408-fail-stop.md)).

## How it works

```mermaid
flowchart LR
  app[App] -->|writes only here| pg[(Postgres<br/>WAL)]
  pg -->|logical replication<br/>slot + pgoutput| decode[Decode &<br/>assemble txns]
  decode --> route{"hash(id) % N"}
  route --> l1[lane 1]
  route --> l2[lane …]
  route --> ln[lane N]
  l1 & l2 & ln -->|batched, coalesced<br/>upserts / deletes| meili[(Meilisearch)]
  meili -->|task succeeded| cp[Checkpointer]
  cp -->|confirm LSN<br/>only after apply| pg
  bf[Backfill<br/>with watermarks] -.->|existing rows| route
```

1. **Read the WAL, never dual-write.** A replication slot makes Postgres keep every change until Driftless confirms it,
   across restarts.
2. **Confirm only after apply.** A transaction's end position is confirmed only once Meilisearch reports every one of
   its changes `succeeded`, and only once everything before it is too: the checkpointer confirms the end of the
   unbroken run of applied transactions. A crash at any moment replays from the last confirmed point.
3. **Replays are harmless.** Writes are idempotent upserts and deletes by primary key, so at-least-once delivery has
   an exactly-once effect.
4. **Order per row, parallel across rows.** Changes are routed by a hash of the primary key into N ordered lanes, so one
   row's changes are never reordered, while different rows' changes are written in parallel.
5. **Batch without a timer.** When a lane's write finishes, it sends everything that queued up meanwhile (up to 5,000),
   merged per key. A quiet system writes each change at once; a busy one sends big batches.
6. **Fail-stop.** On any error it can't safely retry, Driftless exits; Docker restarts it and it resumes from the slot.
7. **Backpressure, not buffering.** At 50,000 waiting changes it stops reading the socket. TCP pushes back and the
   backlog waits in Postgres's WAL, which was keeping it anyway.

The full design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), every choice and its reason in
[docs/DECISIONS.md](docs/DECISIONS.md), and step-by-step flows in [docs/FLOW.md](docs/FLOW.md).

## Quick start

Needs Docker (with Compose v2), Node.js ≥ 24 and bash (on Windows: Git Bash).

```bash
git clone https://github.com/Kunal874/driftless.git
```

```bash
cd driftless && npm ci
```

Start Postgres (with `wal_level=logical`) and Meilisearch. Both are bound to 127.0.0.1, with local-dev credentials:

```bash
docker compose up -d --wait
```

Create 100,000 demo products (on Windows Git Bash, put `MSYS_NO_PATHCONV=1 ` in front):

```bash
docker compose exec -T postgres psql -U driftless -d shop -f /db/seed.sql
```

Start Driftless. It sees an empty index, copies the existing rows (backfill), then streams new changes:

```bash
docker compose --profile connector up -d --build connector
```

```bash
docker compose logs -f connector
```

Write to Postgres (a random mix of updates, inserts and deletes at 200 tx/s for 30 s), then check every row against
its document:

```bash
scripts/workload.sh 200 30
```

```bash
node scripts/reconcile.ts
```

It should end with `OK: no drift`. Search the index:

```bash
curl -s http://127.0.0.1:7700/indexes/products/search -H 'Authorization: Bearer driftless-dev-master-key' -H 'Content-Type: application/json' -d '{"q":"chair","limit":3}'
```

Dashboards (Prometheus + Grafana, then open http://127.0.0.1:3000):

```bash
docker compose --profile metrics up -d
```

And the crash test: SIGKILL the connector about every 30 s for 10 minutes under load, then reconcile:

```bash
scripts/chaos.sh 600 30 200
```

## Configuration

**What to sync where** lives in [`driftless.config.json`](driftless.config.json) (or the file `DRIFTLESS_CONFIG` points
to):

```json
{
  "postgres": { "host": "127.0.0.1", "port": 5440, "user": "driftless", "database": "shop" },
  "meilisearch": { "host": "http://127.0.0.1:7700" },
  "sync": {
    "table": "public.products",
    "index": "products",
    "primaryKey": "id",
    "columns": { "exclude": ["description"] }
  }
}
```

`columns` is optional: `include` (a list that must contain the primary key) or `exclude`; without it, every column
becomes a document field. The file is validated in full at start, every problem reported at once. Then it's checked
against the real table (the primary key must match, named columns must exist) before anything is created. Secrets are
refused in the file: they come from environment variables.

**Environment variables** override the file or tune the pipeline:

| Variable | Default | |
|---|---|---|
| `PGHOST` `PGPORT` `PGUSER` `PGDATABASE` | from the file | standard Postgres variables |
| `PGPASSWORD` | `driftless` (local dev) | never in the file |
| `MEILI_HOST` | from the file | |
| `MEILI_MASTER_KEY` | `driftless-dev-master-key` (local dev) | never in the file |
| `DRIFTLESS_LANES` | `8` | parallel ordered lanes. `1` gives the lowest steady lag on Meilisearch, 8 the fastest catch-up ([D-027](docs/DECISIONS.md)) |
| `DRIFTLESS_BATCH_MAX` | `5000` | most changes in one write |
| `DRIFTLESS_MAX_PENDING` | `50000` | stop reading the stream at this many waiting changes; resume at half |
| `DRIFTLESS_BACKFILL` | off | `1` = copy all existing rows on start (it also starts by itself when the index is empty and the table isn't) |
| `DRIFTLESS_BACKFILL_CHUNK` | `10000` | rows per backfill chunk |
| `DRIFTLESS_METRICS_HOST` / `_PORT` | `127.0.0.1` / `9464` | `GET /metrics` |
| `DRIFTLESS_LOG_TXNS` | off | `1` = log every transaction |

Postgres needs `wal_level=logical`, and the table needs a single-column primary key with `REPLICA IDENTITY` `DEFAULT`
or `FULL`. Driftless creates its own publication, slot and two small bookkeeping tables (`driftless_watermark`,
`driftless_state`).

## Observability

`GET :9464/metrics` serves Prometheus metrics:
- `driftless_lag_seconds`: commit → applied *and* confirmable;
- `driftless_write_seconds` and `driftless_batch_changes`;
- `driftless_changes_applied_total{op}`;
- the gauges changes waiting, transactions in flight, reading paused and confirmed LSN;
- `driftless_slot_retained_wal_bytes`, the WAL Postgres keeps for the slot.

The `metrics` profile adds Prometheus and a provisioned 15-panel Grafana dashboard ([docker/](docker/)).

## Testing

```bash
npm test
```

```bash
npm run typecheck
```

Unit tests cover decoding, the checkpointer, lanes, coalescing, the retry policy, backfill watermarks, backpressure
and config validation. The claims are proven by scripts against the real stack:

| Script | Proves |
|---|---|
| `scripts/ci-e2e.sh [ROWS] [CHAOS_SECONDS]` | what CI runs: fresh stack → backfill → SIGKILL chaos → reconcile 0 → self-test (locally: `COMPOSE_PROJECT_NAME=driftless-ci`) |
| `scripts/reconcile.ts [--self-test]` | every row equals its document (the self-test plants drift and demands it's found) |
| `scripts/chaos.sh DURATION KILL_EVERY RATE` | 0 drift with random SIGKILLs under load |
| `scripts/backfill-race.sh DELAY RATE SECONDS [KILL_EVERY]` | backfill racing concurrent writes (and crashes) |
| `scripts/slow-sink.sh PAUSE RATE MAX_PENDING` | bounded memory while Meilisearch is frozen |
| `scripts/bench-drain.sh LANES BATCH_MAX RATE SECONDS` | backlog drain throughput |
| `node scripts/bench-lag.ts RATE SECONDS CLIENTS` | end-to-end lag quantiles at a fixed write rate |
| `node scripts/repro-ack-off-by-one.ts` | reproduces BUG-001 |

## Limitations

- One table → one index per Driftless instance; single-column primary keys; plain lower-case table names.
- Meilisearch only (the sink is one module, `src/sinks/meilisearch.ts`).
- Schema changes (`ALTER TABLE`) are untested. A dropped column's old values would stay in documents until each row is
  rewritten or a fresh backfill runs.
- A slot lost to the WAL cap needs manual recovery (on purpose: it involves deleting the index).
  [docs/ROLLBACK.md](docs/ROLLBACK.md) has the steps.
- Numbers come from one developer machine, with other containers running; treat them as relative, not absolute.

## Repository guide

| | |
|---|---|
| [`src/`](src/) | the connector (tests next to code as `*.test.ts`) |
| [`scripts/`](scripts/) | workload, reconcile, chaos, benchmarks |
| [`db/`](db/) | schema, seed, workload SQL |
| [`docs/`](docs/) | architecture, decisions, flows, results, bugs, rollback, build plan |
| [`learn/`](learn/) | one plain-language write-up per build task: what was done, why, and what went wrong |

## License

[MIT](LICENSE)
