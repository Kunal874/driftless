# Handover — where we left off

Updated 2026-10-23, during T09 (session 1). Overwrite this at every checkpoint: it describes
*now*; history lives in git.

## Current state

- Last checkpoint: **T08 — Backpressure & WAL safety** (tag `checkpoint/T08`)
- In progress: **T09 — Observability & benchmarks**. T09.1 ✅ (`src/metrics.ts`, `GET /metrics` on 9464).
  T09.2 ✅ (`docker compose --profile metrics up -d`: Prometheus 127.0.0.1:9090, Grafana 127.0.0.1:3000, 15-panel
  dashboard "Driftless" provisioned from `docker/grafana/`, anonymous view-only)
- Next step: **T09.3**: lag benchmark at stepped fixed rates. First make the lag buckets finer between 1 and 10 s
  (p99 at 200 tx/s showed as 4.95 s, i.e. just "somewhere in 2.5–5 s")

## What the system holds right now

- `products`: ~150,085 rows; Meilisearch `products`: **identical** (last reconcile 0 / 0 / 0).
- A **new** slot `driftless_slot` (recreated during the T08.4 recovery experiment), caught up.
- Postgres now runs with `max_slot_wal_keep_size=1GB` (compose). The `connector` service is **stopped**.

## Done so far

- **T01–T07 ✅**: foundation, source data, WAL reader + confirm protocol (BUG-001), sink + retry policy, correctness
  harness, lanes + batching + checkpointer (9 → 6,752 tx/s), watermark backfill (BUG-002, BUG-003; 10/10 at 0 drift).
- **T08 ✅**: backpressure (D-025): pause the replication socket at `DRIFTLESS_MAX_PENDING` (50,000), resume at half,
  10 s status re-send. 5-min Meilisearch freeze at 600 tx/s → memory bounded vs 45 → 220 MiB uncapped. **BUG-004**
  (HTTP 408 treated as a rejection) found and fixed. WAL safety (D-026): 1 GB slot cap; refuse to start on a lost slot
  with recovery steps; recovery proven (0 drift). `npm test` 44/44.

## Notes for T09 (read before starting)

- `prom-client` is pre-approved; install with the 14-day rule (D-017).
- **Lag** = time a transaction becomes confirmable − its `commitTime`. The natural place is `Checkpointer.advance()`: give
  `track()` the commit time and observe each transaction it moves past. That measures commit → applied *and* confirmable.
- Useful gauges already exist as values in `main.ts`: changes waiting (`queue.length + lanes.queued()`), `readingPaused`,
  `checkpointer.inFlight`, `confirmed`. Retained WAL needs a periodic `pg_replication_slots` query (one small pg client).
- Prometheus/Grafana ports: 9090 and 3000 were free at T01. Check again before binding (other projects' containers start
  with Docker). Bind to `127.0.0.1`.
- Headline numbers to produce (RESULTS.md "Resume claims"): lag p99 at fixed rates, and one long chaos run at full rate
  with reconcile.
- **Finding at T09.1 (record it in RESULTS with T09.3):** at 200 tx/s, lag is ~2.1 s on average, all of it between 1 and
  2.5 s. Clocks agree within 1 ms (checked from inside the connector). Cause: every Meilisearch batch takes ~560 ms
  however small, and 420 ms of it is "post processing words > word fst" (`GET /batches` → `progressTrace`). The
  vocabulary keeps growing because every description rewrite adds a random `md5` word. Lag ≈ 1.8 × one write
  (`driftless_write_seconds` avg 1.19 s). This is Meilisearch on this data, not Driftless overhead; don't tune it away.
  It also **drifts upward during a run** (write p50 1.2 s → 1.75 s over another 60 s at 200 tx/s), because the vocabulary
  keeps growing. So record the order of the benchmark runs, and the index's state at each one.

## Files changed in T08

`src/pipeline/backpressure.ts` (+ test), `src/main.ts`, `src/config.ts`, `src/sinks/meilisearch.ts` (+ test),
`src/source/replication.ts`, `docker-compose.yml`, `scripts/slow-sink.sh`, `docs/bugs/BUG-004-…`, `docs/` (DECISIONS D-025,
D-026, D-021 update, RESULTS §6–7, ROLLBACK, FLOW, ARCHITECTURE, BUILD_PLAN, TEST_CHECKLIST), `AGENTS.md` status,
`learn/task-08-backpressure.md`

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
- Long runs (chaos, benchmarks, backfill races, slow-sink) belong in the background.
- `docker compose up -d --force-recreate` deletes the old container's logs. Save logs first if you need them (BUG-004 lesson).
- Docker Desktop may be stopped at session start. Start it before `docker compose up -d --wait`.
- Init scripts in `db/init/` only run on an **empty** volume (`docker compose down -v` wipes data; ask first).
- BUG-001 could be reported upstream to `kibae/pg-logical-replication`. That's the owner's decision
  (outward-facing); the repro script and note are ready.

## Resume prompt

> Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off.
