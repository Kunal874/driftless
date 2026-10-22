# Task 8 — Backpressure and WAL safety, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 8

Two failure modes, opposite in direction:
1. **Meilisearch slow or down → Driftless must not run out of memory.** Fixed with **backpressure**: when too
   much work is waiting, Driftless stops *reading*, and the backlog waits in Postgres instead.
2. **Driftless down → Postgres must not run out of disk.** Fixed with a **cap on WAL kept for the slot**, plus
   detection and a recovery path when Postgres has to give the slot up.

---

## 1. Backpressure: stop reading, don't drop

Picture a kitchen. When dirty dishes pile up faster than the dishwasher runs, the sensible thing is to stop
taking new orders for a moment, not to throw plates away and not to let the pile reach the ceiling.

Before Task 8, every change Postgres sent was put in memory straight away. If Meilisearch stalled, those queues
grew without limit until the process ran out of memory and died.

**Now:** Driftless counts the changes waiting inside it (stream messages not yet handed to lanes, plus changes
queued in lanes). At `DRIFTLESS_MAX_PENDING` (default 50,000) it **pauses reading the network socket** that
Postgres streams into. It resumes when the count falls to **half**.

What happens next is a chain:
- Unread bytes fill the operating system's socket buffer.
- When it's full, **TCP** tells the sender to wait. That's TCP's built-in flow control.
- Postgres's sender process blocks. Nothing is lost, because Postgres was keeping that WAL anyway until Driftless
  confirms it.

The backlog moves from Driftless's memory to Postgres's disk, where it was already durable.

**Why resume at half, not just below the cap?** Without a gap the system would flip between paused and reading on
every single message. A gap between "on" and "off" thresholds is called **hysteresis**; thermostats do the same.

**How the socket is paused.** The replication library has no public pause. Its own "flow control" pauses the
socket, but it delivers Postgres's keepalive messages outside its queue: the race found in Task 3. So Driftless
reaches the library's connection socket directly (`_connection.stream`, a Node `net.Socket`) and calls
`pause()` / `resume()`. It's a private field, so the code checks it exists and fails loudly if a library update
ever renames it.

**Keeping the connection alive while paused.** While paused, Driftless doesn't read *anything*, including Postgres's
"are you still there?" keepalive requests. Postgres drops a connection that hasn't answered for `wal_sender_timeout`
(1 minute here). So a timer re-sends the **confirmed** position every 10 s. That's "still here, no progress", and it's
safe. The library's built-in timer stays off because it would send the *received* position (Task 3).

---

## 2. The proofs

`scripts/slow-sink.sh PAUSE_S RATE MAX_PENDING` freezes Meilisearch (`docker pause`, which suspends the process)
while the workload keeps writing. It samples the connector's memory and the WAL Postgres holds for the slot, then
unfreezes and reconciles.

**First check, a 90 s freeze at 200 tx/s with a small cap (2,000):**
- reading paused at exactly 2,000 waiting changes;
- connector memory stayed flat at about 42 MiB;
- WAL held for the slot grew from 0.8 MB to 8.2 MB: the backlog waiting in Postgres;
- **0 fatal errors**: the connection survived a freeze longer than the 1-minute timeout;
- after unfreezing it caught up, and reconcile found 0 drift.

**The 5-minute freeze at 600 tx/s, capped vs uncapped** (`docs/RESULTS.md` §6; ~216,000 transactions per run):

| | Connector memory during the freeze | Outcome |
|---|---|---|
| cap 50,000 (default) | rises, then **flat** once reading pauses (≤ ~130 MiB) | 0 drift |
| cap effectively off | **45 → 220 MiB and still rising** | would eventually run out of memory |

### Something that went wrong: BUG-004

The first capped 5-minute run reported **one crash**. Reconcile still passed: the crash triggered fail-stop, Docker
restarted the connector, and Postgres re-sent what wasn't confirmed. So no data was lost, but a crash is still a
bug. The log needed to see why was gone: the next run recreated the container, and a container's logs go with it.
So the test script was changed to save the whole log, and a re-run showed:

```
driftless: fatal: MeilisearchApiError: 408: Request Timeout
```

Task 4's retry policy treated every HTTP 4xx as "Meilisearch rejected the write, stop". But **408 Request Timeout**
means "I gave up waiting for your request: send it again", and it's exactly what a frozen Meilisearch answers to
requests that were in flight when it wakes up. Now 408 is retried like 429 and 5xx. Re-run: **0 crashes, 0 drift.**
Note: `docs/bugs/BUG-004-http-408-fail-stop.md`.

Two lessons. Read the meaning of a status code, not just its first digit. And this is why the design treats "stop and
resume" as the safe default: even with a wrong retry rule, nothing was lost.

---

## 3. WAL safety: a dead connector must not fill the disk

A replication slot is a promise: "Postgres will keep every WAL file this consumer hasn't confirmed". If the consumer
dies and nobody notices, the promise holds **forever**, and WAL piles up until the database's disk is full. At that
point Postgres itself stops. Driftless would have taken down the database it reads from, which is the worst possible
failure for a sidecar tool.

On this stack, `max_slot_wal_keep_size` was `-1` (unlimited), which is the default.

**The fix has two halves:**
1. **A cap.** Postgres now starts with `max_slot_wal_keep_size=1GB` (in `docker-compose.yml`). If a slot needs more than
   that, Postgres **invalidates** it: deletes the old WAL and marks the slot `lost`. The database stays healthy.
2. **An honest connector.** A lost slot means changes are gone, so the index can't be trusted. On start, Driftless checks
   the slot's `wal_status`. If it's `lost`, it **refuses to run** and prints the exact recovery steps. If it's
   `unreserved` (already past the cap), it warns.

**The experiment** (cap lowered to 32 MB for the test only, Driftless stopped):

| Step | Slot |
|---|---|
| start | `reserved`, 12 MB held |
| 5,991 writes Driftless missed | 15 MB |
| 1.5M rows into an unrelated table | **153 MB, `unreserved`** |
| `CHECKPOINT` (when Postgres cleans up old WAL) | **`lost`** |
| start Driftless | refused, with the 4 steps |

**Recovery**, following the printed steps:
1. Drop the old slot.
2. Delete the search index, because documents for rows deleted during the outage would otherwise survive.
3. Reset the backfill progress.
4. Start Driftless. It creates a **new slot first**, so nothing written from that moment is missed. It then sees the
   empty index and backfills every row (Task 7).

Result: 150,085 rows in 28.6 s, then reconcile: **0 drift**. The 5,991 missed writes are included, because the
backfill copied the current version of every row.

Why isn't recovery automatic? It deletes things: a slot and a whole index. Postgres has already lost data at that point,
and a person should know and decide.

---

## 4. If an interviewer asks…

- **"What happens if your sink is down for an hour?"** Driftless stops reading once 50,000 changes are waiting. TCP
  backpressure makes Postgres hold the backlog as WAL, memory stays flat, and the connection stays alive with periodic
  status messages. When the sink returns, it drains and catches up.
- **"Why not buffer to disk?"** The replication slot already *is* a durable, ordered buffer on disk. A second one would
  just be another thing to keep consistent.
- **"What's the risk of a replication slot?"** Unbounded WAL retention if the consumer dies, until the primary's disk
  fills. Cap it (`max_slot_wal_keep_size`), alert on retained WAL, and have a recovery path for when Postgres
  invalidates the slot.
- **"What is hysteresis?"** Different thresholds for switching on and off, so a system doesn't oscillate.

---

## Glossary

- **Backpressure**: a slow consumer making producers slow down instead of being overwhelmed.
- **TCP flow control**: TCP's receive window; a full receiver buffer makes the sender wait.
- **Hysteresis**: separate on/off thresholds to avoid flapping.
- **`docker pause`**: suspends every process in a container (frozen, not stopped).
- **`wal_sender_timeout`**: how long Postgres waits for a replication client's reply before disconnecting.
- **WAL retention**: how much old WAL Postgres keeps because a slot still needs it.
- **`max_slot_wal_keep_size`**: the cap on WAL kept for slots; beyond it Postgres invalidates the slot.
- **Invalidated (lost) slot**: a slot whose needed WAL was removed; the changes in it are gone.
