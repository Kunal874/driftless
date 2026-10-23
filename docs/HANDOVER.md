# Handover — where we left off

Updated 2026-10-23, end of T10 (session 1). **The build plan is complete.** Overwrite this at every checkpoint: it
describes *now*; history lives in git.

## Current state

- Last checkpoint: **T12 — Redis cache as a second sink** (tag `checkpoint/T12`); release `v0.1.0` = T10
- Published: **https://github.com/Kunal874/driftless** (public, MIT). T11 is pushed with CI green. **T12 is committed
  locally, not pushed** (push only with the owner's go-ahead).
- Next step: **T13**: multiple tables per instance (BUILD_PLAN → T13, approved by the owner 2026-10-23).
- Throwaway compose projects used in T12 (`driftless-redis`, `driftless-ci`) are removed, volumes included.

## What the system holds right now

- `products`: 287,476 rows; Meilisearch `products` and Redis `product:*`: **identical** (last reconcile 0 / 0 / 0 in
  both, after the T12.5 runs).
- Redis 8.10.1 on 127.0.0.1:6381, AOF `appendfsync always`, volume `driftless_redisdata`.
- Slot `driftless_slot` caught up. Postgres runs with `max_slot_wal_keep_size=1GB`.
- `postgres`, `meilisearch`, `redis` and `connector` are **running**; `prometheus` and `grafana` are stopped.

## Done

- **T01–T09 ✅**: foundation, source data, WAL reader + confirm protocol (BUG-001), sink + retry policy, correctness
  harness, lanes + batching + checkpointer, watermark backfill (BUG-002, BUG-003), backpressure + WAL safety (BUG-004),
  metrics + benchmarks (headline: 1,197,314 transactions, 36 SIGKILLs, 0 drift; lag p99 < 5 s at 1,000 tx/s; D-027).
- **T10 ✅**:
  - Config file `driftless.config.json`, validated in full and checked against the table before anything is created
    (D-028). This fixed a startup-order bug: a wrong primary key with a new index name used to create that index first.
  - Column include/exclude, proven live through both backfill and streaming.
  - Dockerfile (244 MB, non-root, no build step); the compose `connector` is built from it.
  - README; fresh-clone test passed; final docs pass.
  - MIT license; version 0.1.0; published.
- **T11 ✅** (polish; owner asked "make it better in every possible way"):
  - Fresh-eyes review: no bugs; `confirm()` now never moves backwards *by construction*.
  - BUG-001 had been fixed upstream in 2.6.0 (#222), so no report is needed. The dependency is pinned to exactly
    2.5.0, and a contract test guards the `+ 1` our code compensates for.
  - CI: typecheck + unit tests + `scripts/ci-e2e.sh` (fresh stack, SIGKILL chaos, reconcile 0) on every push. Passed
    locally and on GitHub (first run: 11 SIGKILLs, 0 drift).
  - README: CI badge, a real Grafana screenshot from a chaos run, package metadata.
- **T12 ✅** Redis cache as a second sink (D-029):
  - `src/sinks/sink.ts` (contract), `src/sinks/redis.ts` (a hash per row, one MULTI per batch); every batch goes to every
    sink and counts as applied only when all have it; a backfill starts when any sink is empty.
  - Redis on by default (shipped config + compose), AOF `appendfsync always`; `@redis/client` 6.3.0.
  - Reconcile and its self-test cover both sinks; CI therefore checks Redis on every push.
  - Proofs (RESULTS §12): backfill of 279,652 rows; chaos and a 2-min Redis freeze at 0 drift; a Redis SIGKILL at
    0 drift with `always`, against 6,238 wrong keys with Redis's default persistence; ~+0.15 s of lag.
  - `npm test` 63/63.

## Ideas, if the owner wants more (none started)

- Schema-change handling (`ALTER TABLE` is untested). Multiple tables are planned as T13.
- D-027 (lanes) was written for Meilisearch alone; with Redis (fast) beside it, Meilisearch still sets the pace, so it
  stands. Re-measure if a faster search sink ever replaces it.
- Upgrade `pg-logical-replication` to ≥ 2.6.0 once it passes the 14-day rule (2026-10-28): change `sendStatus` to
  pass `end` unchanged in the same commit; `ack-contract.test.ts` will demand it (BUG-001 → Upstream).

## Files changed in T12

`src/sinks/sink.ts` (new), `src/sinks/redis.ts` (+ test, new), `src/sinks/meilisearch.ts` (Sink, `isEmpty`),
`src/main.ts` (all sinks, Redis client, backfill on any empty sink), `src/metrics.ts` (`sink` label), `src/config.ts` +
`src/config-file.ts` (+ test) (`redis` section), `driftless.config.json` (Redis on), `scripts/reconcile.ts` (targets),
`scripts/redis-crash.sh` (new), `scripts/slow-sink.sh` (service argument), `scripts/bench-lag.ts` (per-sink writes),
`docker-compose.yml` (redis service), `docker/grafana/dashboards/driftless.json` (write panel per sink), `package.json`
(@redis/client 6.3.0), `docs/` (DECISIONS D-029, RESULTS §12, ARCHITECTURE, BUILD_PLAN, TEST_CHECKLIST), `README.md`,
`AGENTS.md`, `learn/task-12-redis.md`

## Environment (verified 2026-10-23)

| Thing | Value |
|---|---|
| OS | Windows 11 |
| Git | 2.55.0 (installed in `C:\CODE\Git`); global identity `Kunal <kunalchandrakar2005@gmail.com>` |
| Node / npm | 24.18.0 / 11.16.0 (connector container: `node:24.18.0-alpine`) |
| Docker | Engine 29.6.2, Desktop 4.83.0, Compose v5.3.1; engine sees 28 CPUs, ~7.6 GiB RAM |
| Ports already taken | 5432 Windows Postgres · 5433 + 6379 online-judge-v2 · 5434 + 6380 reachinbox-scheduler (both auto-start with Docker) |
| Driftless ports | 5440 Postgres · 7700 Meilisearch · 6381 Redis · 9464 metrics · 9090 Prometheus · 3000 Grafana (all 127.0.0.1) |

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
- The index keeps growing with every benchmark (vocabulary too), so Meilisearch gets slower over time. Benchmarks are
  only comparable on the same index state; record it with each run (RESULTS §8–9).
- For doc edits: avoid `sed` with `#` delimiters on Markdown (`##` clashes). **Never put text containing backticks
  inside bash double quotes**: bash runs it as a command. In T09 that started an unintended second `chaos.sh`
  (learn/task-09 §9). Use plain file edits or a quoted heredoc (`<<'EOF'`).
- After stopping a script that started background jobs, check for orphans: `ps -ef | grep -E "workload|pgbench"` and
  `docker compose exec -T postgres ps -o pid,args | grep pgbench`.
- BUG-001 could be reported upstream to `kibae/pg-logical-replication`. That's the owner's decision
  (outward-facing); the repro script and note are ready.

## Resume prompt

> Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off.
