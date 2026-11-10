# Handover — where we left off

Updated 2026-11-11, end of T14. Overwrite this at every checkpoint: it describes *now*; history lives in git.

## Current state

- Last checkpoint: **T14 — Alerts** (tag `checkpoint/T14`).
- Released: **`v0.2.0`** (T12–T13). `v0.3.0` will be T14 + T15. `v0.1.0` = T10.
- Published: **https://github.com/Kunal874/driftless** (public, MIT). `origin/main` = `2c39d55` (the
  `pg-logical-replication` 2.6.0 upgrade, a recorded D-017 exception). **Everything from the T14/T15 plan on is local,
  not pushed**: push only with the owner's go-ahead. CI's new promtool step has therefore not run on GitHub yet.
- **Approved 2026-11-11:** T15 (publish the image to GHCR and the CLI to npm as `driftless-cdc`, release `v0.3.0`).
- **T15 in progress.** T15.1 ✅: `src/cli.ts` (entry) + `src/cli-args.ts` (`parseCli`, tested; `--self-test` refused);
  reconcile moved to `src/reconcile.ts` as `reconcile({ timeoutS, selfTest })`, with `scripts/reconcile.ts` as the
  wrapper every script still calls; `tsconfig.build.json` + `npm run build` → `dist/` (gitignored). `import.meta.main`
  avoided on purpose (only newer Node 24 releases have it), hence the two files. `npm test` 75/75; CI e2e locally
  (`driftless-ci`, removed afterwards): 24,380 tx, 10 SIGKILLs, 0 drift, self-test passed.
- Next step: **T15.2** (BUILD_PLAN.md).
- Throwaway compose projects (`driftless-redis`, `driftless-ci`) are removed, volumes included.

## What the system holds right now

- `products`: 300,216 rows and `customers`: 20,935 rows; their indexes and Redis keys are **identical** to them (last
  reconcile 0 / 0 / 0 everywhere, after the T14.5 slot drill).
- The shipped config mirrors both tables; the publication holds products, customers and the watermark table.
- Redis 8.10.1 on 127.0.0.1:6381, AOF `appendfsync always`, volume `driftless_redisdata`.
- Slot `driftless_slot` `reserved`. Postgres runs with `max_slot_wal_keep_size=1GB` (compose variable
  `PG_MAX_SLOT_WAL_KEEP_SIZE`, default `1GB`).
- **Everything is running**: `postgres`, `meilisearch`, `redis`, `connector`, `prometheus` (with the alert rules, all
  inactive) and `grafana`.

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
- **T13 ✅** Several tables per instance (D-030):
  - `sync` is a list; one mirror per table (index, key prefix, backfill); lanes keyed by `table:id`; the publication
    is kept equal to the config; removed tables' leftover changes are skipped.
  - Backfill per table with saved progress per table (old row migrated); "resume beats request" across tables, found
    while preparing the race test (a forced round would have restarted finished tables after every kill).
  - Demo: `customers` table + seed, `WORKLOAD_MIX=multi` with cross-table transactions; CI runs two tables.
  - Proofs (RESULTS §13): add, remove, re-add a table; a two-table backfill race with 7 SIGKILLs; chaos with
    cross-table transactions (11 SIGKILLs); all 0 drift. `npm test` 69/69.
- **T14 ✅** Alerts (D-031):
  - `docker/prometheus/alerts.yml`: `DriftlessDown` (Prometheus's `up`: a dead connector reports nothing),
    `DriftlessStalled` (`unless`, so a restart with no applied changes yet still alerts), `DriftlessLagHigh`,
    `DriftlessSlotWalHigh` / `Critical` (share of the cap: retained / (retained + safe), any cap).
  - New gauge `driftless_slot_safe_wal_bytes`; a startup warning when the slot WAL cap is unlimited.
  - `alerts.test.yml` with `promtool test rules` (a mutant with `and` fails it); CI runs it. Dashboard panel on top.
  - Proofs (RESULTS §14, `scripts/alert-drill.sh`): Down 2.5 min after a SIGKILL; Stalled 5.4 min after freezing
    Meilisearch under load; slot alerts at 60 % and 87 %, at the 1 GB and a 256 MB cap, before the slot was lost; all
    resolved; 0 drift after each. `npm test` 70/70.

## Ideas, if the owner wants more (none started)

- Schema-change handling (`ALTER TABLE` is untested).
- D-027 (lanes) was written for Meilisearch alone; with Redis (fast) beside it, Meilisearch still sets the pace, so it
  stands. Re-measure if a faster search sink ever replaces it.

## Files changed in T14

`src/main.ts` (safe-WAL gauge), `src/source/replication.ts` (no-cap warning), `docker-compose.yml`
(`PG_MAX_SLOT_WAL_KEEP_SIZE`; the whole `docker/prometheus/` folder mounted), `docker/prometheus/prometheus.yml`
(`rule_files`, 15 s evaluation), `docker/prometheus/alerts.yml` + `alerts.test.yml` (new),
`docker/grafana/dashboards/driftless.json` (alerts panel), `.github/workflows/ci.yml` (promtool),
`scripts/alert-drill.sh` (new), `docs/` (BUILD_PLAN T14/T15, TEST_CHECKLIST, RESULTS §14, DECISIONS D-031, ARCHITECTURE,
FLOW 4), `README.md` (cap + alerts), `AGENTS.md`, `learn/task-14-alerts.md`

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
- `docker compose up -d connector` also **recreates a dependency whose config differs** from the compose file as read
  now (e.g. Postgres started with `PG_MAX_SLOT_WAL_KEEP_SIZE=256MB` goes back to 1 GB). Use `--no-deps` (T14.5).
- The slot WAL cap is a `-c` flag, which beats `ALTER SYSTEM`: change it with `PG_MAX_SLOT_WAL_KEEP_SIZE` and recreate
  `postgres`, then recreate it without the variable to restore 1 GB.
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
