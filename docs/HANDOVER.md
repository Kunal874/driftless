# Handover — where we left off

Updated 2026-10-22, end of T05 (session 1). Overwrite this at every checkpoint: it describes
*now*; history lives in git.

## Current state

- Last checkpoint: **T05 — Correctness harness** (tag `checkpoint/T05`)
- In progress: **T06** (steps refined in BUILD_PLAN: natural batching with no timer; checkpointer before
  wiring). T06.1 done: `src/pipeline/lanes.ts` (FNV-1a router, ordered lanes, natural batching ≤ batchMax,
  `idle()` barrier) + 6 tests. Not wired into `main.ts` yet; the connector still applies one transaction
  at a time.
- Next step: **T06.2**: `src/pipeline/checkpointer.ts` + tests

## What the system holds right now

- `products`: ~99,982 rows (after the T05 chaos workloads); Meilisearch `products`: **identical** (last
  reconcile: 0 missing / 0 extra / 0 mismatched).
- Publication `driftless_pub` + slot `driftless_slot`, caught up.
- The `connector` compose service was **stopped** at the end of the session (`docker compose stop connector`).
  `docker compose up -d connector` starts it; stop it before running `node src/main.ts` on the host.

## Done so far

- **T01 Foundation ✅**: repo, single-author hook, Docker stack, docs, plan.
- **T02 Source data ✅**: schema, deterministic seed, workload runner, unchanged-TOAST proof.
- **T03 Read the WAL ✅**: decoder, confirm protocol (D-019), BUG-001 (library ack +1) reproduced and fixed.
- **T04 Meilisearch sink ✅**: merge updates, never reordered, ack after `succeeded`, retry policy D-021.
- **T05 Correctness harness ✅**: `scripts/reconcile.ts` (catch-up wait, full compare via `toDocument`, exit
  0/1/2, `--self-test` PASSED); `connector` compose service (profile, `restart: unless-stopped`);
  `scripts/chaos.sh` (random SIGKILLs + reconcile). 48 kills over 3 runs at 5 tx/s → **0 drift**, 31 replays
  absorbed, 0 fatal errors. Numbers in `docs/RESULTS.md`.

## Notes for T06 (read before starting)

- **Baseline to beat:** ~10 transactions/s with one transaction in flight (~100 ms per Meilisearch task;
  `docs/RESULTS.md` §3). A 10k-document write costs about the same as a 1-document write, so batch *across*
  transactions.
- Reuse `planSteps()` (merges per key within one write, never across a delete/TRUNCATE). T06 extends the same
  rules across transactions, per lane.
- Ack rule after T06: confirm only the end of the longest **contiguous** prefix of fully applied transactions.
  The heartbeat "idle" check in `src/main.ts` must then also consider work still sitting in lanes.
- TRUNCATE must be a barrier across all lanes (D-018).
- Prove it with the harness at real speed: `scripts/chaos.sh 600 30 200` (and higher), plus reconcile. Record
  lanes 1 vs 8 throughput in RESULTS.md.
- `docker kill` is not restarted by the restart policy (manual stop); `chaos.sh` restarts the connector itself.

## Files changed in T05

`scripts/reconcile.ts`, `scripts/chaos.sh`, `docker-compose.yml` (connector service), `docs/RESULTS.md` (new),
`docs/` (BUILD_PLAN, ARCHITECTURE, TEST_CHECKLIST, HANDOVER), `AGENTS.md` status,
`learn/task-05-correctness-harness.md`

## Environment (verified 2026-10-22)

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
- A foreground command that runs longer than 2 minutes (chaos runs) should be started in the background.
- Docker Desktop may be stopped at session start. Start it before `docker compose up -d --wait`.
- Init scripts in `db/init/` only run on an **empty** volume (`docker compose down -v` wipes data; ask first).
- BUG-001 could be reported upstream to `kibae/pg-logical-replication`. That's the owner's decision
  (outward-facing); the repro script and note are ready.

## Resume prompt

> Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off.
