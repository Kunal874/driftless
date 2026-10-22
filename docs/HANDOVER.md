# Handover — where we left off

Updated 2026-10-22, end of T02 (session 1). Overwrite this at every checkpoint: it describes
*now*; history lives in git.

## Current state

- Last checkpoint: **T02 — Source database & workload** (tag `checkpoint/T02`)
- In progress: nothing
- Next step: **T03.1**: Node/TypeScript project (`package.json`, `tsconfig.json`), see BUILD_PLAN.md → T03

## What the database holds right now

- `products`: 99,965 rows (seeded 100,000, then one 30 s workload run). Re-seed any time with
  `db/seed.sql` and you get identical data.
- No publications and no replication slots yet (T03 creates them). Meilisearch: no indexes.

## Done so far

- **T01 Foundation ✅**: repo, single-author hook, Docker stack, docs, build plan.
- **T02 Source data ✅**: schema (`description` STORAGE EXTERNAL); deterministic seed (100k rows in
  1.9 s, 5,132 big descriptions, identical checksum across runs); workload runner (200 tx/s, 0 failed,
  60/20/10/10 mix); proof that a price-only update of a big row decodes as `unchanged-toast-datum`.

## Notes for T03 (read before starting)

- Decide how to handle **TRUNCATE** (BUILD_PLAN T03 pitfalls). `db/seed.sql` truncates before seeding.
- The unchanged-TOAST marker is real and frequent: 60% of workload writes are price-only updates. The
  decoder's test fixtures (T03.5) must include it.
- To peek at decoded changes without code, use a temporary `test_decoding` slot (learn/task-02 §3).
  Always check `pg_replication_slots` is clean afterwards.
- Node connects from the host to `127.0.0.1:5440`, user/password `driftless`, database `shop`.

## Files changed in T02

`db/init/01-schema.sql`, `db/seed.sql`, `db/workload/*.sql`, `scripts/workload.sh`,
`docker-compose.yml` (mounts), `docs/` (BUILD_PLAN, HANDOVER, ARCHITECTURE, CONSTRAINTS rule 13,
DECISIONS D-016, TEST_CHECKLIST), `AGENTS.md` status, `learn/task-02-source-data.md`

## Environment (verified 2026-10-22)

| Thing | Value |
|---|---|
| OS | Windows 11 |
| Git | 2.55.0 (installed in `C:\CODE\Git`); global identity `Kunal <kunalchandrakar2005@gmail.com>` |
| Node / npm | 24.18.0 / 11.16.0 |
| Docker | Engine 29.6.2, Desktop 4.83.0, Compose v5.3.1; engine sees 28 CPUs, ~7.6 GiB RAM |
| Ports already taken | 5432 Windows Postgres · 5433 + 6379 online-judge-v2 · 5434 + 6380 reachinbox-scheduler (both auto-start with Docker) |

## Open issues / watch out

- Git Bash rewrites container paths: `docker compose exec … -f /db/…` needs `MSYS_NO_PATHCONV=1`
  (scripts set it themselves).
- Docker Desktop may be stopped at session start. Start it before `docker compose up -d --wait`.
- Init scripts in `db/init/` only run on an **empty** volume. Changing the schema later means
  `docker compose down -v` (wipes all data; ask first) or a manual migration.

## Resume prompt

> Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off.
