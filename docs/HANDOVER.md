# Handover — where we left off

Updated 2026-10-23, end of T10 (session 1). **The build plan is complete.** Overwrite this at every checkpoint: it
describes *now*; history lives in git.

## Current state

- Last checkpoint: **T11 — Polish after release** (tag `checkpoint/T11`); release `v0.1.0` = T10
- Published: **https://github.com/Kunal874/driftless** (public, MIT). `main` and all tags pushed; GitHub lists one
  contributor, `Kunal874`, with all commits.
- **T11 is pushed and CI is green** on GitHub (run 39935636390: unit + e2e crash test, 0 drift). One follow-up commit
  is local: this record, plus a CI trigger fix (tag pushes no longer re-run CI on an already-tested commit). Push it with
  the owner's go-ahead. After that nothing is planned; new work needs a plan the owner approves.
- The T10 fresh-clone folder and the T11 CI test project (`driftless-ci`) are both deleted.

## What the system holds right now

- `products`: 279,180 rows; Meilisearch `products`: **identical** (last reconcile 0 / 0 / 0, after the T11 screenshot
  chaos run).
- Slot `driftless_slot` caught up. Postgres runs with `max_slot_wal_keep_size=1GB`.
- Everything is **running**: `postgres`, `meilisearch`, `connector` (the built image), `prometheus`, `grafana`.

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
  - `npm test` 53/53.

## Ideas, if the owner wants more (none started)

- A second sink (e.g. a Redis cache), the original stretch goal. D-027 says to re-check lanes then.
- Multiple tables per instance; schema-change handling (`ALTER TABLE` is untested).
- Upgrade `pg-logical-replication` to ≥ 2.6.0 once it passes the 14-day rule (2026-10-28): change `sendStatus` to
  pass `end` unchanged in the same commit; `ack-contract.test.ts` will demand it (BUG-001 → Upstream).

## Files changed in T11

`src/main.ts` (`confirm()`), `src/pipeline/lanes.ts` (comment), `src/source/ack-contract.test.ts` (new),
`package.json` + `package-lock.json` (pg-logical-replication pinned to 2.5.0; repository metadata),
`.github/workflows/ci.yml` (new), `scripts/ci-e2e.sh` (new), `README.md` (badge, screenshot, ci-e2e row),
`docs/images/dashboard-chaos.png` (new), `docs/` (BUILD_PLAN T11, RESULTS §11, BUG-001 → Upstream, ARCHITECTURE,
TEST_CHECKLIST), `AGENTS.md`, `learn/task-11-polish.md`

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
