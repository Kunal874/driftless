# Handover — where we left off

Updated 2026-10-23, end of T10 (session 1). **The build plan is complete.** Overwrite this at every checkpoint: it
describes *now*; history lives in git.

## Current state

- Last checkpoint: **T10 — Config, packaging, README, release** (tags `checkpoint/T10`, `v0.1.0`)
- Published: **https://github.com/Kunal874/driftless** (public, MIT). `main` and all tags pushed; GitHub lists one
  contributor, `Kunal874`, with all commits.
- In progress: nothing. Next step: none planned. New work needs a plan the owner approves (BUILD_PLAN style).
- Left for the owner: delete the folder `D:\PROJECTS\driftless-fresh` (the T10 fresh-clone test; its Docker project
  is already removed, and a safety check stopped the agent from deleting the folder).

## What the system holds right now

- `products`: 275,353 rows; Meilisearch `products`: **identical** (last reconcile 0 / 0 / 0, after restarting the stack
  following the fresh-clone test). The test index `products_t10` was deleted.
- Slot `driftless_slot` caught up. Postgres runs with `max_slot_wal_keep_size=1GB`.
- `postgres`, `meilisearch` and `connector` (the built image) are **running**; `prometheus` and `grafana` are stopped.
  Start them with `docker compose --profile metrics up -d`.

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
  - `npm test` 52/52.

## Ideas, if the owner wants more (none started)

- Report BUG-001 upstream to `kibae/pg-logical-replication` (outward-facing: the owner's call; repro + note ready).
- A second sink (e.g. a Redis cache), the original stretch goal. D-027 says to re-check lanes then.
- Multiple tables per instance; schema-change handling (`ALTER TABLE` is untested).
- CI (GitHub Actions running `npm test` + typecheck). Note: the integration scripts need Docker and minutes per run.

## Files changed in T10

`driftless.config.json`, `src/config-file.ts` (+ test), `src/config.ts`, `src/main.ts`, `src/sinks/document.ts`,
`src/sinks/meilisearch.ts` (+ test), `src/source/replication.ts`, `scripts/reconcile.ts`, `Dockerfile`, `.dockerignore`,
`docker-compose.yml`, `scripts/{chaos,backfill-race,bench-drain,slow-sink}.sh` (build first), `README.md`, `LICENSE`,
`package.json` (0.1.0, MIT), `docs/` (DECISIONS D-028, RESULTS §10, ARCHITECTURE, FLOW, CONSTRAINTS, BUILD_PLAN,
TEST_CHECKLIST), `AGENTS.md`, `learn/task-05` (pointer), `learn/task-10-release.md`

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
