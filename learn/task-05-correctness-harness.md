# Task 5 — The correctness harness, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 5

1. **`scripts/reconcile.ts`**: the zero-drift checker. It waits until Driftless has caught up, then compares
   *every* Postgres row with its Meilisearch document.
2. **A self-test for the checker**: it plants drift on purpose and demands that reconcile finds exactly that.
3. **The connector as a Docker service**, so a test can kill it the hard way (`SIGKILL`).
4. **`scripts/chaos.sh`**: steady writes while the connector is killed at random moments, then reconcile.
5. **The first real chaos runs**, recorded in `docs/RESULTS.md`, which is where resume numbers come from.

Why now, before making anything faster (D-015): a fast pipeline you can't prove correct is worthless. From
here on, every change to Driftless can be checked for drift with one command.

---

## 1. Reconcile: proving "zero drift"

### Lag is not drift

Right after a write, the index is *behind* Postgres for a few milliseconds. That's **lag**, and it's normal.
**Drift** is when the index stays wrong even after Driftless has had time to catch up. A checker that compared
too early would report false drift, so reconcile first **waits until Driftless has caught up**:
- Postgres side: the slot's confirmed position has reached the WAL position recorded when reconcile started
  (everything written before that moment has been handled), **and**
- Meilisearch side: no write is still `enqueued` or `processing`.

If that never happens within the timeout, reconcile says it **couldn't check** (exit code 2) instead of
guessing. That's what happens when the connector isn't running, because the connector's idle confirms are
what make "caught up" visible (Task 3).

### The comparison

- Rows are read in chunks of 1,000 by primary key, using **keyset pagination**: "the next 1,000 rows after
  the last id I saw". That stays fast at any size, unlike `OFFSET`, which re-reads all the skipped rows.
- For each chunk, the matching documents are fetched by id (`getDocuments({ ids })`).
- Each row goes through **the same `toDocument()` the sink uses** (D-020). Both sides are written as JSON with
  sorted keys and compared as text. Because there's only one mapping, the writer and the checker can't
  disagree about what "correct" means.
- Three kinds of drift are counted: **missing** (row without a document), **mismatched** (both exist but
  differ), and **extra** (document without a row). Extras are found cheaply: if Meilisearch holds more
  documents than matched rows, reconcile pages through the document ids to name the surplus.
- **Exit codes**: 0 = identical, 1 = drift, 2 = couldn't check. Scripts can rely on these.

First result: **100,000 rows vs 100,000 documents, 0 drift, compared in 4.7 s.** The index survived every
Task 4 test exactly.

### Testing the tester (`--self-test`)

A checker that always says "OK" looks exactly like a working one, until the day it matters. So reconcile
can test itself. It writes straight into Meilisearch, bypassing Driftless: it corrupts one document,
deletes another and adds one that has no row. It then demands that compare() finds **exactly** those three.
Finally it restores them from Postgres and demands 0 again. Result: planted #1 / #3 / `selftest-extra` →
found 1 mismatched, 1 missing, 1 extra → restored → **PASSED**.

---

## 2. The connector as a Docker service

To kill a process the hard way from a script, it's easiest if Docker runs it. The new `connector` service in
`docker-compose.yml` runs `node src/main.ts` inside `node:24.18.0-alpine`:

- **Read-only mount of the repo** (`./:/app:ro`): no image to build; Node runs the TypeScript directly.
  `node_modules` comes from your Windows install, which works on Linux because every runtime dependency is
  plain JavaScript.
- **Inside Docker's network**, it reaches the databases by service name: `postgres:5432`,
  `http://meilisearch:7700`.
- **A profile** (`profiles: ["connector"]`): a plain `docker compose up` doesn't start it. You start it on
  purpose (`docker compose up -d connector`), so it never fights a `node src/main.ts` on your machine for
  the slot. Only one connection may use a slot.
- **`restart: unless-stopped`**: Docker acts as the **supervisor**. Fail-stop (D-009) only works if
  something brings the process back: Driftless stops loudly on an error it can't handle, and Docker starts it
  again, resuming from the slot's confirmed position.

**A surprise worth knowing.** After `docker kill`, Docker did *not* restart the container (restart count 0,
exit code 137). Docker treats `kill` as a deliberate manual stop, and restart policies ignore manual stops.
When the process exited *by itself* (a signal from inside), Docker restarted it (restart count 1). So real
crashes and fail-stop exits are restarted, and `chaos.sh` restarts the connector itself after each of its
deliberate kills.

**SIGKILL vs SIGTERM.** SIGTERM is a polite "please stop"; Driftless catches it and shuts down cleanly.
SIGKILL can't be caught: the process vanishes instantly, mid-whatever it was doing. That's the closest thing
to a power cut, so chaos uses SIGKILL. (Exit code 137 = 128 + 9, where 9 is SIGKILL's number.)

---

## 3. Chaos: killing it on purpose

`scripts/chaos.sh DURATION KILL_EVERY RATE`:
1. Starts the connector service.
2. Runs the standard workload (`scripts/workload.sh`, D-016) at a fixed rate for DURATION seconds.
3. Meanwhile it SIGKILLs the connector after **random** gaps of 0.5–1.5 × KILL_EVERY, and restarts it each time.
4. When the writes stop, it runs reconcile (waiting up to 30 minutes for the backlog to drain) and exits with
   reconcile's verdict.

**Why random gaps.** A kill on a fixed beat can lock into step with the work and keep hitting the same
moment. Random gaps spread the kills across every phase:

| A kill can land… | What makes it harmless |
|---|---|
| while a transaction is being received | nothing about it was confirmed, so Postgres re-sends it |
| between two of a transaction's writes to Meilisearch | the whole transaction is replayed; writes are idempotent |
| after Meilisearch applied it, before the ack | replay re-applies the same values (proved in T04) |
| while Meilisearch is still processing a write | the task finishes or not; the replay re-sends it; tasks run in order |
| right after an ack | nothing is lost; Postgres starts after that position |
| during startup | the next start simply begins again |

Each kill costs a restart (about 1–2 s) during which writes pile up. That's lag, which reconcile waits out.

**Why only 5 transactions/s?** Task 4 measured about 100 ms per transaction with one transaction in flight,
which is about 10 per second at most. A 200 tx/s workload would mostly test patience. Task 6 adds batching,
and then chaos runs at full speed.

---

## 4. Results

The authoritative copy, with exact commands, is `docs/RESULTS.md`.

| Run | Kills | Transactions | After the run | Drift |
|---|---|---|---|---|
| `chaos.sh 60 10 5` (smoke) | 4 | 268 | 100,005 rows = 100,005 documents | 0 |
| `chaos.sh 600 30 5` (10 min) | 17 | 2,995 | 99,987 = 99,987 | 0 |
| `chaos.sh 180 5 5` (a kill every ~5 s) | 27 | 899 | 99,982 = 99,982 | 0 |

- **The kills really interrupted work.** 31 transactions appear twice in the connector's log: handled,
  killed before the ack, then re-sent by Postgres and handled again after the restart. Example: xid 10098
  ended at `0/E6D0F08`, and the next start resumed at `0/E6D0D20`, *before* it. Every one was absorbed.
- 51 connector starts, **0 fatal errors**. Even with kills 5 seconds apart, a restarting connector never
  collided with the old connection's hold on the slot.
- **No new bug was found.** That's a legitimate result, recorded as-is rather than dressed up. The harness
  exists so that later changes (batching in Task 6, backfill in Task 7) are checked the moment they land.
  Task 7 is where we expect it to catch a real race.

---

## 5. What this does *not* prove yet (being honest)

- Only the **connector** is killed. Killing Meilisearch or Postgres mid-write is a different experiment.
  Meilisearch persists its task queue to disk, and Postgres has its WAL, but neither is proven here.
- The load is **5 tx/s on one laptop**, with other projects' containers running alongside. Higher rates come
  after Task 6, and the headline numbers come from Task 9.
- **Backfill** (rows that existed before the slot) isn't covered until Task 7. The index got all 100,000 rows
  by streaming a re-seed.

---

## 6. If an interviewer asks…

- **"How do you know it's correct?"** After every chaos run, a checker compares every row against its search
  document through the same mapping the writer uses, and it can't silently pass: it has a self-test that
  plants drift and must find it.
- **"Why wait before comparing?"** To tell lag from drift. Reconcile waits until the replication slot has
  confirmed everything written before the check started and Meilisearch's queue is empty. If that doesn't
  happen, it reports "couldn't check" instead of a false result.
- **"Why SIGKILL and not a normal stop?"** A normal stop lets the program clean up; real crashes don't.
  SIGKILL gives no chance to flush, ack or log, which is exactly the case the design must survive.
- **"What restarts it in production?"** A supervisor; here Docker's restart policy. One gotcha: `docker kill`
  counts as a manual stop and is *not* restarted, but a crash or a fail-stop exit is.

---

## Glossary

- **Lag / drift**: the index being temporarily behind / staying wrong after catching up.
- **Reconcile**: comparing the source of truth with a copy, item by item.
- **Keyset pagination**: "next N rows after id X"; fast at any depth, unlike OFFSET.
- **Self-test**: a check that the checker itself can detect what it's meant to detect.
- **Compose profile**: a group of services that only start when asked for.
- **Restart policy / supervisor**: the rule (and the component) that brings a stopped process back.
- **SIGTERM / SIGKILL**: polite stop the program can handle / instant termination it can't.
- **Exit code 137**: 128 + 9, the process was killed by SIGKILL.
- **Chaos testing**: deliberately breaking parts of a running system to prove it recovers correctly.
