# Task 6 — Lanes, batching and the checkpointer, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 6

1. **Lanes** (`src/pipeline/lanes.ts`): changes are spread over N parallel queues by a hash of their
   primary key, so the same row always goes to the same lane and keeps its order.
2. **Natural batching**: a lane sends everything that queued up while its previous write was in flight.
   There's no timer.
3. **Coalescing**: a batch is reduced to its net effect per row, so it needs at most two Meilisearch
   writes, sent in parallel.
4. **The checkpointer** (`src/pipeline/checkpointer.ts`): with lanes finishing out of order, it decides what
   may safely be confirmed to Postgres.
5. Wired all of it into `main.ts`, with TRUNCATE as a barrier, then **measured** before and after and
   re-ran chaos at full speed.

The problem it solves, measured in Task 4: one Meilisearch write takes about 100 ms whether it carries 1
document or 500. Applying one transaction at a time therefore capped Driftless at about 10 transactions per
second, while the workload makes 200.

---

## 1. Lanes: parallel, but never out of order for one row

If every change went into one queue, there would be no parallelism. If changes went to random workers,
two updates to the same product could race, and the older one could land last. The fix is to **partition
by key**:

```
lane = hash(primary key) % number of lanes
```

The same key always lands in the same lane, and each lane applies its changes in arrival order (= commit
order). Different lanes hold different keys, so they can run at the same time without ever reordering a row.
This is the same idea as Kafka sending all messages with one key to one partition.

**The hash: FNV-1a.** Five lines, no dependency: for each character, XOR it into the hash, then multiply
by a fixed prime. A test checks that 80,000 sequential ids spread over 8 lanes within 10% of a fair share,
so no lane gets all the work.

---

## 2. Natural batching (no timer)

The original plan said "flush every 500 documents or every 50 ms". A timer means even a lone change on a
quiet system waits up to 50 ms. Instead:

- When a lane is idle and a change arrives, it's written **immediately**, as a batch of 1.
- While that write is in flight (~100 ms), more changes queue up behind it.
- When the write finishes, the lane sends **everything that queued up** (up to `batchMax`) as the next batch.

So batch size adjusts itself to the load. Quiet means small batches with no added delay; busy means big
batches and few writes. Databases do the same thing when committing ("group commit"). The live stats line
shows it: about **5 changes per write** at 200 tx/s, and **500 per write** (the cap) during a 100k-row bulk load.

---

## 3. Coalescing: a batch's net effect

One batch can contain several changes to the same row, from different transactions. Only the final state
matters, so the batch is reduced to **one result per key**:

| Changes to row 5 in one batch | Net effect sent |
|---|---|
| update price, then update stock | one upsert with both fields (merged in order, later wins) |
| update, then delete | delete |
| update, delete, insert again | one upsert with the *new* whole row |

After that, the upserts and the deletes touch **different keys**, so their order can't matter, and the two
writes go out **in parallel** (`Promise.all`).

**The subtle case: delete, then re-insert.** We drop the delete and send just the upsert, using
Meilisearch's *merge* write (Task 4) onto the stale old document. That's only correct if the upsert carries
*every* column, and it does. A row can only come back after a delete through an INSERT, and an INSERT
always sends every column. The "unchanged, not resent" TOAST marker only ever appears in UPDATEs. A unit
test pins this case down.

---

## 4. The checkpointer: what may we confirm?

With one lane, "confirm after applying" was simple. With 8 lanes, transactions finish **out of order**:

```
txn 1: 300 changes spread over all lanes (slow)
txn 2:   1 change on lane 4             (finishes first)
```

A confirm means "everything **before** this position is done". Confirming txn 2's end would also tell
Postgres that txn 1 is done. If Driftless then crashed, Postgres would never re-send txn 1, and it would
be lost.

**The rule:** confirm only the end of the longest **unbroken run** of fully applied transactions, counted from
the oldest. Each transaction carries a countdown of its unapplied changes. Lanes count it down as they finish
batches, and `advance()` walks forward from the oldest transaction while the countdowns are zero. Txn 2 just
waits behind txn 1; when txn 1 completes, both are confirmed in one step. Five unit tests cover this,
including empty transactions and transactions spread over several lanes.

**TRUNCATE is a barrier (D-018).** It must not overtake earlier changes or be overtaken by later ones. So
dispatching pauses, waits until **every lane is empty** (`lanes.idle()`), clears the index, then continues.

**The idle check grew.** Task 3's "idle, so confirm the server's position" must now also require that no
transaction is still in flight in a lane, and that no confirm is pending.

---

## 5. Results

The authoritative copy, with exact commands, is `docs/RESULTS.md` §1 and §4.

**Throughput: how fast a backlog of ~18,000 transactions drains** (`scripts/bench-drain.sh`; every run ended
with a reconcile at 0 drift):

| Lanes | Max changes per write | Throughput | vs Task 4 |
|---|---|---|---|
| 1 | 1 (unbatched, like Task 4) | 9 tx/s | 1× |
| 1 | 500 | 1,613 tx/s | 180× |
| 1 | 5,000 | 4,682 tx/s | 520× |
| 8 | 500 | 4,910 tx/s | 545× |
| **8** | **5,000** | **6,752 tx/s** | **750×** |

Batching gives the big jump (one write carries hundreds of changes); lanes multiply it (several writes in
flight at once). The numbers include ~1 s of container start-up, so they're conservative.

**Something the measurements changed.** The first version capped batches at 500. A 100,000-row bulk load
through 8 lanes then took 6.9 s to catch up, *slower* than Task 4's single lane with 10,000-document chunks
(4.1 s). Raising the cap to 5,000 brought it to 3.2 s, and the backlog test agreed (6,752 vs 4,910 tx/s). Under
normal load, natural batching keeps writes small anyway (about 5 changes each at 200 tx/s), so the default is
now 5,000. The decision came from data, not from guessing (D-022).

*A small lesson about benchmarks:* the first attempt used ~2,000-transaction backlogs. Every setting then
"took" 1.6–2.1 s, almost all of it container start-up, so the numbers couldn't tell the settings apart. Make
the measured work much bigger than the fixed overhead.

**Correctness at full speed** (`scripts/chaos.sh`, 200 tx/s, 40× Task 5's rate):

| Run | Kills | Transactions | After | Drift |
|---|---|---|---|---|
| 10 min, a kill every ~30 s | 20 | 119,764 | 101,729 rows = 101,729 documents | **0** |
| 3 min, a kill every ~5 s | 30 | 35,759 | 102,327 = 102,327 | **0** |

At 200 tx/s there are always 60–100 transactions in flight, so every kill threw away unconfirmed, partly
applied work. Postgres re-sent it, the lanes re-applied it, and the checkpointer never confirmed past a gap.
51 connector starts, 0 fatal errors.

---

## 6. If an interviewer asks…

- **"How do you parallelize without breaking order?"** Partition by primary key: same key → same lane →
  applied in order. Different lanes never share a key, so parallel work can't reorder a row.
- **"Lanes finish out of order. How do you ack safely?"** Only the end of the contiguous run of fully applied
  transactions, starting from the oldest. A fast transaction behind a slow one waits; otherwise a crash
  would lose the slow one.
- **"Why no batch timer?"** Natural batching gives zero added latency when quiet and large batches when busy.
  A timer only adds delay.
- **"Isn't merging a delete and a re-insert dangerous?"** It would be if the re-insert could be partial, but an
  INSERT always carries every column, so the merged upsert is a whole row.

---

## Glossary

- **Lane / partition**: one of N ordered queues; a key always maps to the same one.
- **Hash partitioning**: choosing the lane with `hash(key) % N`.
- **FNV-1a**: a simple, fast, non-cryptographic string hash.
- **Natural batching / group commit**: send whatever accumulated while the previous write was in flight.
- **Coalescing**: reducing many changes to a row into its single final effect.
- **Checkpoint / contiguous prefix**: the furthest point before which *everything* is done.
- **Barrier**: a point that waits for all earlier work to finish before anything later starts.
- **Backlog drain**: measuring throughput by timing how fast a pile of queued work is processed.
