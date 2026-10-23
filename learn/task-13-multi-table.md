# Task 13 — Several tables per instance, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 13

Until now one Driftless mirrored one table. Now one Driftless mirrors **several** (the demo has `products` and a new
`customers` table), each into its own Meilisearch index and its own Redis key prefix, with every earlier guarantee
intact. That includes the interesting case: **one transaction that changes rows in two tables**.

---

## 1. One stream, several mirrors

All tables share **one** replication slot, one publication, one change stream, one set of lanes, one checkpointer. Each
table gets a *mirror*: its index, its cache prefix, and its own backfill.

**Why not just run one Driftless per table?** Each would need its own replication slot, and every slot makes Postgres
keep WAL for it. Worse, a transaction that changes a product *and* a customer would be confirmed separately by each
connector, with no way to treat it as one unit. One shared stream sees the transaction once, whole.

### The config

```json
"sync": [
  { "table": "public.products",  "index": "products",  "primaryKey": "id", "redisKeyPrefix": "product:" },
  { "table": "public.customers", "index": "customers", "primaryKey": "id", "redisKeyPrefix": "customer:" }
]
```

The validator's new rules:
- tables, indexes and key prefixes must be unique;
- **no key prefix may start another**. Clearing a table's keys uses `SCAN MATCH prefix*`, so with prefixes `p:` and
  `p:x:`, clearing the first table would also delete the second table's keys.

Old single-table config files still work (a single `sync` object, and T12's `redis.keyPrefix`).

## 2. Routing: lanes keyed by table *and* id

Lanes keep each row's changes in order by sending the same key to the same lane (Task 6). With several tables the key
becomes `table:id`. Product #7 and customer #7 are different rows, so they may run in parallel. Each still keeps its own
order.

A lane's batch can now hold rows of several tables. The batch is split by table and each part goes to that table's sinks
(its index and its prefix), all at once. The batch counts as applied only when every part is.

## 3. A transaction across two tables

`db/workload/cross_table.sql` does `BEGIN; UPDATE products …; UPDATE customers …; COMMIT;`. Both changes arrive in one
transaction, probably land in different lanes, and are applied independently.

When may Driftless confirm that transaction to Postgres? Only when **both** changes are applied in **every** sink.
Nothing new was needed: the checkpointer (Task 6) already counts a transaction's remaining changes wherever they're
applied. That's a nice property of the design. Multi-table support didn't touch the correctness core, only the routing
around it.

## 4. The publication must match the config, and leftovers are skipped

Setup now **adds** newly configured tables to the publication and **drops** removed ones. But dropping a table from the
publication doesn't remove its old changes from the slot. Changes written before the drop are still in the WAL, and
Postgres still sends them. Dispatch therefore **skips** changes of tables it doesn't mirror (and logs that once) instead
of failing on them.

**Re-adding a removed table needs care:** while it was out, its index and cache missed changes. They aren't empty, so
no automatic backfill starts, but they're stale. The procedure: delete its index and its keys, then add it back. The
empty sinks trigger a backfill of just that table.

## 5. Backfill per table, and a livelock found before it happened

Backfills run one table at a time, and each table's progress is saved under its own name (`backfill:public.products`).
The old single-table row (`backfill`) is renamed once on start, so a finished backfill isn't redone.

**What nearly went wrong.** Preparing the two-table race test, one question: what happens if the connector is killed
*between* tables, with products done and customers half done, while `DRIFTLESS_BACKFILL=1` (the "please backfill"
switch) is still set? The old logic said "the switch is on, start every table from scratch", so products would restart.
With a kill every 20 s and a products backfill longer than 20 s, it would **never finish**: a livelock.

The fix extends a rule from Task 7, **resume beats request**, across tables:
- if any table's backfill is `running`, this start *continues that round*: unfinished tables resume, finished ones stay
  finished;
- a requested round first marks **every** table as due, so even a table the round never reached survives a restart.

The proof: the race test emptied both indexes and the cache and backfilled under concurrent writes (cross-table
transactions included) with **7 SIGKILLs**. The log shows products *resuming* seven times from its saved id
(282,148 → … → 509,769), never restarting, then customers. Reconcile: both tables, both sinks, 0 drift.

## 6. The other proofs (RESULTS §13)

- **Old config, new code:** the progress row was renamed, nothing was re-backfilled, 0 drift.
- **Adding `customers`:** added to the publication; only customers backfilled (19,995 rows in 1.2 s).
- **Removing it and adding it back:** its leftover changes were skipped; after clearing its sinks, re-adding it
  backfilled just that table.
- **Crashes with cross-table transactions:** 54,138 transactions, 11 SIGKILLs, both tables in both sinks identical to
  Postgres.
- **CI** now runs the two-table version on every push.

## 7. If an interviewer asks…

- **"How do you sync several tables?"** One slot and one stream for all of them, a mirror per table, lanes keyed by
  table and id. A transaction across tables is confirmed only when every change in every sink is applied: the
  checkpointer already counts per transaction, so cross-table atomicity came for free.
- **"Why one connector instead of one per table?"** One slot means one WAL retention cost, and multi-table transactions
  stay whole.
- **"What happens when you remove a table?"** It's dropped from the publication; its changes still in the WAL are
  skipped. To re-add it, clear its sinks so it's backfilled fresh.
- **"Tell me about a bug you prevented."** The backfill livelock: forced backfills restarting finished tables after
  every crash. Spotted by thinking through the kill test before running it, fixed with "resume beats request" across
  tables, then proven by a race with seven kills.

---

## Glossary

- **Mirror (Driftless)**: one table's sinks and backfill.
- **Publication**: the list of tables whose changes Postgres streams to a subscriber.
- **Livelock**: the system keeps working but never finishes (here: redoing the same backfill after every restart).
- **Round (backfill)**: one pass over every table that needs a backfill; continued, not restarted, after a crash.
