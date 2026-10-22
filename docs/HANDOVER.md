# Handover — where we left off

Updated 2026-10-23, end of T09 (session 1). Overwrite this at every checkpoint: it describes
*now*; history lives in git.

## Current state

- Last checkpoint: **T09 — Observability & benchmarks** (tag `checkpoint/T09`)
- In progress: **T10**. T10.1 ✅ config file (`driftless.config.json`, `src/config-file.ts`, D-028). T10.2 ✅ `Dockerfile` +
  `.dockerignore`; the compose `connector` is built from it (no repo mount any more: after code changes use
  `docker compose up -d --build connector`; the test scripts run `docker compose build -q connector` themselves)
  T10.3 ✅ README (fresh-clone test passed). T10.4 ✅ docs pass, `learn/task-10-release.md`.
- Next step: **T10.5**: push to GitHub, **only after the owner says so in chat**, and only with the owner's choices of
  visibility (public/private) and license (no LICENSE file yet). `gh` is logged in as `Kunal874`; there's no remote.
  After the push: replace `<repo-url>` in README → Quick start, tag `v0.1.0`, check that the contributors list shows only the
  owner, then T10.6 (tick the last checklist item, AGENTS.md status, tag `checkpoint/T10`).
- Left for the owner: delete the folder `D:\PROJECTS\driftless-fresh` (the fresh-clone test; its Docker project is
  already removed, and a safety check stopped me from deleting the folder).

## What the system holds right now

- `products`: 275,353 rows; Meilisearch `products`: **identical** (last reconcile 0 / 0 / 0, after restarting the stack
  following the fresh-clone test). The test index `products_t10` was deleted.
- Slot `driftless_slot` caught up. Postgres runs with `max_slot_wal_keep_size=1GB`.
- `postgres`, `meilisearch` and `connector` (the built image) are **running**; `prometheus` and `grafana` are stopped.
  Start them with `docker compose --profile metrics up -d`.

## Done so far

- **T01–T08 ✅**: foundation, source data, WAL reader + confirm protocol (BUG-001), sink + retry policy, correctness
  harness, lanes + batching + checkpointer, watermark backfill (BUG-002, BUG-003), backpressure + WAL safety (BUG-004).
- **T09 ✅**: `GET /metrics` on 9464 (`src/metrics.ts`): lag histogram measured in the checkpointer (commit →
  confirmable), write time, batch size, changes by op, queue gauges, slot retained WAL. Prometheus + Grafana under
  profile `metrics`, a 15-panel dashboard provisioned from `docker/`. `scripts/bench-lag.ts` (quantiles from
  before/after snapshots, matches Prometheus). Results:
  - Lag p99 3.6–5.0 s up to 1,000 tx/s; kept up with ~4,800 tx/s, the load generator's limit (RESULTS §8).
  - Lag ≈ 2 × one Meilisearch write; a write is mostly Meilisearch rebuilding its word FST, which grows with the
    synthetic vocabulary.
  - 1 lane gives lower steady lag than 8, while 8 lanes drain a backlog fastest → default stays 8 (**D-027**, §9).
  - The T06 drain number belongs to a ~105k-doc index: the same command on 195k docs gives 2,810 tx/s.
  - **Headline chaos run:** 1,197,314 transactions at 1,000 tx/s, 36 SIGKILLs → **0 drift** over 261,113 docs (§1).
  - `npm test` 45/45.

## Notes for T10 (read before starting)

- **README numbers come from RESULTS.md only**, with their conditions: the "Resume claims" table is ready. Say which
  index size a throughput number was measured on (§4 note), and that lag is dominated by Meilisearch (§8).
- Env vars the config file (T10.1) must keep honoring: `PG*`, `MEILI_HOST`, `MEILI_MASTER_KEY`, `DRIFTLESS_LANES`,
  `DRIFTLESS_BATCH_MAX`, `DRIFTLESS_MAX_PENDING`, `DRIFTLESS_BACKFILL*`, `DRIFTLESS_METRICS_HOST`/`_PORT`,
  `DRIFTLESS_LOG_TXNS`, `DRIFTLESS_DEBUG_ACK_DELAY_MS`. `src/config.ts` is the single place they're read.
- The Dockerfile (T10.2) replaces the connector's `./:/app:ro` mount. The chaos/bench scripts drive the `connector`
  compose service, so keep its name and env, and re-run one short `chaos.sh 60 10 200` after switching.
- The 14-day rule (D-017) applies to the Dockerfile's base image too: `node:24.18.0-alpine` is already pinned and old
  enough.
- A Grafana screenshot could illustrate the README, but it isn't required. The dashboard runs from `docker/` for
  anyone.

## Files changed in T09

`src/metrics.ts` (new), `src/main.ts`, `src/config.ts`, `src/pipeline/checkpointer.ts` (+ test),
`scripts/bench-lag.ts` (new), `docker-compose.yml` (connector port 9464, prometheus, grafana), `docker/` (new:
Prometheus config, Grafana provisioning + dashboard), `package.json` (prom-client 15.1.3), `docs/` (RESULTS §1, §4
note, §8, §9, claims; DECISIONS D-027; ARCHITECTURE, FLOW, CONSTRAINTS ports, BUILD_PLAN, TEST_CHECKLIST),
`AGENTS.md` status, `learn/task-09-observability.md`

## Environment (verified 2026-10-23)

| Thing | Value |
|---|---|
| OS | Windows 11 |
| Git | 2.55.0 (installed in `C:\CODE\Git`); global identity `Kunal <kunalchandrakar2005@gmail.com>` |
| Node / npm | 24.18.0 / 11.16.0 (connector container: `node:24.18.0-alpine`) |
| Docker | Engine 29.6.2, Desktop 4.83.0, Compose v5.3.1; engine sees 28 CPUs, ~7.6 GiB RAM |
| Ports already taken | 5432 Windows Postgres · 5433 + 6379 online-judge-v2 · 5434 + 6380 reachinbox-scheduler (both auto-start with Docker) |
| Driftless ports | 5440 Postgres · 7700 Meilisearch · 9464 metrics · 9090 Prometheus · 3000 Grafana (all 127.0.0.1) |

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
