# Architecture — the project map

Driftless keeps a Meilisearch index in sync with a PostgreSQL table by reading committed
changes from Postgres's write-ahead log (WAL) through logical replication. The application
writes **only** to Postgres; Driftless is the only thing that writes to the index.

> Status legend: ✅ built · 🔨 in progress · 📐 designed, not built yet. Update this file
> whenever a component's status or shape changes (CONSTRAINTS rule 11).

## Big picture

```
 app / pgbench
      │ INSERT / UPDATE / DELETE (normal SQL, port 5440)
      ▼
 ┌──────────────── PostgreSQL 17 ────────────────┐
 │ products table ──commit──► WAL                │  wal_level=logical
 │ publication driftless_pub  (which tables)     │
 │ slot driftless_slot        (bookmark, an LSN) │
 └──────────────────────┬────────────────────────┘
                        │ replication protocol, pgoutput plugin (proto v1)
                        ▼
 ┌──────────────── Driftless (one Node.js process) ─────────────────────────────┐
 │ stream ─► decode ─► router: hash(pk) % N ─► lanes 0..N-1 (ordered, bounded)  │
 │                                                  │ batch: 500 docs / 50 ms   │
 │                                                  ▼                           │
 │ checkpointer ◄─── "txn X applied" ◄─────── sink: Meilisearch writer          │
 │      │                                                                       │
 │      └─► ack commit LSN to Postgres (only after apply) → slot advances       │
 │                                                                              │
 │ backfill (T07): chunked SELECT between watermarks ─► same lanes              │
 │ metrics  (T09): /metrics ◄── Prometheus ◄── Grafana                          │
 └──────────────────────────────────┬───────────────────────────────────────────┘
                                    │ HTTP: documents API + tasks API (port 7700)
                                    ▼
                         Meilisearch index "products"
```

## Invariants (never break these, not even to make a test pass)

1. **Ack after apply.** Driftless acknowledges an LSN to Postgres only after the sink has
   confirmed every change at or before it. (Ack earlier and a crash loses data.)
2. **Per-key order.** Changes to the same primary key reach the sink in commit order.
3. **Single writer.** Only Driftless writes to the index (and, in S1, the cache).
4. **Idempotent writes.** Applying the same change twice leaves the same result
   (upsert/delete by primary key), so replays after a crash are harmless.
5. **Backfill never wins against the stream.** A snapshot row must never overwrite a newer
   streamed value (watermark algorithm, T07).

## Components

| Component | Job | Planned location | Task | Status |
|---|---|---|---|---|
| Dev stack | Postgres (logical WAL) + Meilisearch, local only | `docker-compose.yml` | T01 | ✅ |
| Demo source data | `products` schema, seed, random write workload | `db/`, `scripts/workload.sh` | T02 | ✅ |
| Replication setup | create publication + slot if missing, check config | `src/source/replication.ts` | T03 | ✅ |
| Stream + decoder | pgoutput messages → `Transaction`s of `Change`s | `src/source/decode.ts`, `src/main.ts` | T03 | ✅ |
| Confirm protocol | ack handled txns at their exact end; idle confirms; keepalive replies (D-019) | `src/main.ts`, `src/source/lsn.ts` | T03 | ✅ (one txn at a time) |
| Document mapping | row → search document (shared with reconcile) | `src/sinks/document.ts` | T04 | 📐 |
| Meilisearch sink | upsert / delete documents, wait for task success | `src/sinks/meilisearch.ts` | T04 | 📐 |
| Reconcile + chaos | prove zero drift under crashes | `scripts/` | T05 | 📐 |
| Router, lanes, batcher | parallel apply, per-key order, coalescing | `src/pipeline/lanes.ts` | T06 | 📐 |
| Checkpointer | safe LSN = contiguous prefix of applied transactions | `src/pipeline/checkpointer.ts` | T04 → T06 | 📐 |
| Backfill | snapshot existing rows with watermarks | `src/source/backfill.ts` | T07 | 📐 |
| Backpressure | bounded queues, pause/resume the stream | `src/pipeline/lanes.ts` | T08 | 📐 |
| Metrics | Prometheus endpoint, lag histogram | `src/metrics.ts` | T09 | 📐 |
| Config | tables → index mapping, validation | `src/config.ts` | T10 | 📐 |

File names are the plan, not a contract. If a task ends up splitting things differently,
update this table.

## The core data shape (built in T03, `src/source/decode.ts`)

```ts
type Change =
  | { op: 'insert' | 'update'; table: string; pk: string; row: Record<string, unknown> } // row: only the
  | { op: 'delete'; table: string; pk: string }                                          // columns sent;
  | { op: 'truncate'; tables: string[] };                                                // unchanged TOAST omitted

type Transaction = {
  xid: number;           // Postgres transaction id
  commitLsn: string;     // start of the commit record in the WAL
  commitEndLsn: string;  // end of the commit record: what Driftless confirms once the txn is applied
  commitTime: Date;      // used for the lag metric (T09)
  changes: Change[];     // in commit order
};
```

`pk` is the primary key as a string, i.e. the document id. A primary-key change becomes
`delete old` + `insert new`.

## How the parts connect

- **Postgres ⇄ Driftless:** two connections. A *replication* connection streams the WAL and
  receives acks; a normal SQL connection is used for setup checks, backfill and watermarks.
- **Driftless → Meilisearch:** HTTP. Writes go to the documents API and return a task id;
  Driftless polls the tasks API until the task `succeeded` before counting it as applied.
- **Prometheus → Driftless (T09):** Prometheus scrapes `GET /metrics`.
- **No frontend, no user auth.** Everything is local. Meilisearch is protected by a dev master
  key; Postgres by dev credentials; all ports are bound to `127.0.0.1`.
- **Where logic lives:** database / WAL logic in `src/source/`, ordering and acks in
  `src/pipeline/`, sink-specific code in `src/sinks/`. Sinks never talk to Postgres.

## Folder layout (target; items marked 📐 don't exist yet)

```
driftless/
├── AGENTS.md               agent instructions + current status (read first)
├── CLAUDE.md               makes Claude Code load AGENTS.md
├── README.md               📐 T10: overview + quick start
├── docker-compose.yml      local stack (connector service added in T05, Prometheus/Grafana in T09)
├── package.json            scripts + dependencies (T03)
├── tsconfig.json           type-check only; Node 24 runs .ts files directly (T03)
├── .githooks/commit-msg    single-author guard (CONSTRAINTS rule 1)
├── db/                     all SQL (T02)
│   ├── init/01-schema.sql    runs automatically on a fresh Postgres volume
│   ├── seed.sql              generates N demo rows
│   └── workload/*.sql        pgbench scripts: random updates / inserts / deletes
├── src/                    the connector (tests sit next to code as *.test.ts)
│   ├── main.ts               setup → stream → handle → confirm (T03)
│   ├── config.ts             connection defaults, names, debug knob (T03)
│   ├── source/               replication.ts, decode.ts, lsn.ts (T03); backfill.ts 📐 T07
│   ├── pipeline/  sinks/     📐 T04+
│   └── metrics.ts            📐 T09
├── scripts/                workload.sh (T02), repro-ack-off-by-one.ts (T03); 📐 T05+: reconcile.ts, chaos.sh
├── docker/grafana/         📐 T09: dashboard provisioning
├── docs/                   project docs (this folder)
│   ├── BUILD_PLAN.md  HANDOVER.md  ARCHITECTURE.md  FLOW.md
│   ├── DECISIONS.md   CONSTRAINTS.md  TEST_CHECKLIST.md  ROLLBACK.md
│   ├── RESULTS.md          📐 T05+: measured numbers with exact commands
│   └── bugs/               📐 one BUG-NNN-<slug>.md per real bug found
└── learn/                  plain-language explanation of every finished task
```

## Fixed names (use these everywhere)

| Thing | Value |
|---|---|
| Postgres (host) | `127.0.0.1:5440`, db `shop`, user/password `driftless` (dev only) |
| Meilisearch (host) | `http://127.0.0.1:7700`, master key `driftless-dev-master-key` (dev only) |
| Publication / slot | `driftless_pub` / `driftless_slot` |
| Source table / index | `public.products` / `products` |
| Watermark table (T07) | `driftless_watermark` |
