# Rollback — how to recover when something breaks

This file doesn't roll anything back by itself. **Git** (for code) and **Docker volumes**
(for data) are the actual recovery mechanisms; this explains how to use them in this project.

## How this repo uses git

- One branch: `main`.
- One commit per plan step, message starting with the step id: `T03.2: create publication and slot`.
- One tag per finished task: `checkpoint/T03` = a known-good state where all of T03's checks passed.

## Find a known-good state

```bash
git tag -l "checkpoint/*"            # every finished task
git log --oneline --decorate -20     # recent steps, tags shown inline
git log --oneline --grep "T04\."     # every commit of task T04
```

## Before restoring anything

1. `git status`: is there uncommitted work? Save it first: `git stash push -u -m "before rollback"`.
2. See what you would lose: `git log --oneline checkpoint/T03..HEAD`.
3. Anything destructive needs the owner's OK (CONSTRAINTS rule 10).

## Recipes, safest first

| Situation | Command | Loses anything? |
|---|---|---|
| Look at an old state without changing anything | `git switch --detach checkpoint/T03` (back: `git switch main`) | no |
| Retry a task from a checkpoint, on the side | `git switch -c retry-T04 checkpoint/T03` | no |
| Undo the last commit but keep its changes to fix them | `git reset --soft HEAD~1` | no |
| Undo a bad commit that was already pushed | `git revert <hash>` (adds an "undo" commit) | no |
| Throw away uncommitted edits to one file | `git restore <file>` | that file's edits |
| Move `main` back to a checkpoint | `git reset --hard checkpoint/T03` | **yes**: every later commit |

## Data (Docker volumes)

- `docker compose down` stops containers and **keeps** data.
- `docker compose down -v` **deletes** Postgres and Meilisearch data, including the replication
  slot. Ask first.
- Full fresh start: `docker compose down -v && docker compose up -d --wait`
  (from T02, Postgres re-runs `db/init/*.sql` on the empty volume).
- Reset only the search index or the cache: delete the index in Meilisearch, or the table's Redis keys
  (`product:*`, `customer:*`). On its next start, Driftless sees an empty sink for a non-empty table and backfills that
  table by itself (D-024, T12).
- Force a fresh backfill (e.g. after a mapping change): stop Driftless, then
  `DELETE FROM driftless_state WHERE name LIKE 'backfill%';` (or `name = 'backfill:public.products'` for one table),
  then start it with `DRIFTLESS_BACKFILL=1`. Without the DELETE, an interrupted backfill would *resume* instead of
  starting over. (Before T13 the progress row was named just `backfill`; Driftless renames it on start.)

## The replication slot (important)

A slot is a bookmark that makes Postgres keep WAL until Driftless confirms it has processed it.
A forgotten slot keeps WAL **forever** and can fill the disk. Check it, and drop it only when
Driftless is stopped and you're going to re-backfill:

```sql
SELECT slot_name, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;

SELECT pg_drop_replication_slot('driftless_slot');
```

Run SQL with: `docker compose exec postgres psql -U driftless -d shop -c "<sql>"`

### Lost replication slot (`wal_status = 'lost'`)

`max_slot_wal_keep_size` (1 GB in `docker-compose.yml`, T08.4) caps the WAL a slot may hold. If Driftless stays
down long enough to exceed it, Postgres **invalidates** the slot to protect its own disk. The changes in that WAL are
gone, so Driftless refuses to start and prints these steps:

1. `SELECT pg_drop_replication_slot('driftless_slot');`
2. Delete every mirrored Meilisearch index (`products`, `customers`) and the Redis keys under every prefix
   (`product:*`, `customer:*`): entries of rows deleted during the outage would otherwise survive.
3. `DELETE FROM driftless_state WHERE name LIKE 'backfill%';`
4. Start Driftless. It creates a new slot *first* (so nothing written from then on is missed), then sees the empty
   sinks and backfills every row of every table (D-024). Check with `node scripts/reconcile.ts`.

Watch for it before it happens: `wal_status = 'unreserved'` means the slot is already past the cap, and Driftless logs
a warning on start.

## After restoring

Run the global checklist plus the restored task's checks (docs/TEST_CHECKLIST.md), then update
docs/HANDOVER.md so the next session knows what happened.
