# Handover — where we left off

Updated 2026-10-22, end of session 1. Overwrite this at every checkpoint: it describes *now*;
history lives in git.

## Current state

- Last checkpoint: **T01 — Foundation** (tag `checkpoint/T01`)
- In progress: **T02**. T02.1 done: `products` table created by `db/init/01-schema.sql` on a fresh
  volume (`description` storage = EXTERNAL, verified); `db/` mounted read-only in the postgres container.
- Next step: **T02.2**: `db/seed.sql` (BUILD_PLAN.md → T02)

## Done in session 1

- Repo at `D:\PROJECTS\driftless`, branch `main`. LF line endings; single-author `commit-msg` hook,
  tested (a `Co-Authored-By` line is rejected with exit 1 and no commit is created).
- Local stack verified healthy: Postgres 17.11 with `wal_level=logical` on `127.0.0.1:5440`, and
  Meilisearch 1.54.3 on `127.0.0.1:7700` (requests without the master key → 401).
- Docs: ARCHITECTURE, FLOW, DECISIONS (D-001…D-015), CONSTRAINTS, TEST_CHECKLIST, ROLLBACK,
  BUILD_PLAN, AGENTS.md / CLAUDE.md, `learn/task-01-foundation.md`.

## Files changed

`.gitignore`, `.gitattributes`, `.githooks/commit-msg`, `docker-compose.yml`, `AGENTS.md`,
`CLAUDE.md`, `docs/*.md`, `learn/task-01-foundation.md`

## Environment (verified 2026-10-22)

| Thing | Value |
|---|---|
| OS | Windows 11 |
| Git | 2.55.0; global identity `Kunal <kunalchandrakar2005@gmail.com>` |
| Node / npm | 24.18.0 / 11.16.0 |
| Docker | Engine 29.6.2, Desktop 4.83.0, Compose v5.3.1; engine sees 28 CPUs, ~7.6 GiB RAM |
| Ports already taken | 5432 Windows Postgres · 5433 + 6379 online-judge-v2 · 5434 + 6380 reachinbox-scheduler (both auto-start with Docker) |

## Open issues / watch out

- BUILD_PLAN.md approved by the owner on 2026-10-22, including every dependency it lists.
- Docker Desktop was stopped at the start of session 1. Start it before `docker compose up -d --wait`.
- Init scripts in `db/init/` only run on an **empty** volume. Changing the schema later means
  `docker compose down -v` (wipes all data; ask first) or a manual migration.

## Resume prompt

> Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off.
