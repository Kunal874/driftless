# Task 12 — A Redis cache as a second sink, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 12

The same stream of committed changes now keeps **two** copies exact: the Meilisearch index (for search) and a Redis
cache (for fast lookups by id). Same guarantees as before: no change lost, none applied out of order per row, and a
crash anywhere (Driftless, Meilisearch, or Redis itself) leaves both copies identical to Postgres after catch-up.

---

## 1. What Redis is, and the shape we store

**Redis** is an in-memory key-value store: reads and writes take microseconds, which is why it's used as a cache in
front of slower systems. Values can be strings, lists, sets… and **hashes** (a small map of field → value under one
key).

Each product row becomes one hash:

```
product:7  →  id: "7"   name: "Compact Chair 107"   price_cents: 164423   description: "…"
```

Every field value is **JSON-encoded** (`"7"` with quotes is the string id, `164423` without quotes is a number, `null`
is null), because a hash stores only strings and a reader needs the types back.

**Why a hash and not one JSON string per row?** The WAL doesn't always send every column: an update that doesn't touch
a big (TOAST) column omits it (Task 4). With one JSON string, applying that partial update means *read the old value,
merge, write it back*: two round trips and a race. With a hash, `HSET product:7 price_cents 200` changes just that
field in one command, the same "merge" behavior Meilisearch's `updateDocuments` gives the index.

## 2. Two sinks, one rule: confirmed only when both have it

Driftless confirms a transaction to Postgres only after it's applied (invariant 1, "ack after apply"). With two sinks,
"applied" must mean **applied in both**. Otherwise a crash could leave Redis permanently behind: Postgres would have
been told it may forget the change.

So `src/sinks/sink.ts` defines what any sink must provide (`applyBatch`, `clear`, `isEmpty`), and `main.ts` sends every
lane batch to all sinks **in parallel** and counts it as applied only when all have finished. The cost: every batch
waits for the slower sink, which is Meilisearch (seconds) not Redis (milliseconds).

Everything else is reused, not rewritten: the same `coalesce` (net effect per key), the same column filter, the same
retry policy (unreachable → retry forever; rejected → fail-stop), the same backfill, the same reconcile. The Redis sink
is about 90 lines.

## 3. Readers never write the cache, and why that matters

The common pattern is **cache-aside**: a reader checks the cache, and on a miss reads the database and *writes the
result into the cache*. It has a famous race:

1. Reader A misses, reads the row from the database (price 100)… and is slow.
2. Writer B updates the price to 200 and deletes the cache key.
3. Reader A finally writes its (old) price 100 into the cache. **Stale until it expires.**

In Driftless's design, **only Driftless writes the cache**, from the WAL, in commit order. A reader that misses goes to
the database and leaves the cache alone. There is no step 3, so the race can't happen. A miss means "not cached yet",
never "wrong".

## 4. Durability: what does Redis's "OK" mean?

Redis keeps data in memory and optionally persists it:
- **RDB snapshots** (the out-of-the-box setup): every so often, the whole dataset is written to disk.
- **AOF (append-only file)**: every write command is appended to a log. `appendfsync` decides when it's forced to disk:
  `always` (before replying), `everysec` (once a second, the AOF default), or `no` (when the OS likes).

This matters because Driftless treats Redis's "OK" as "applied", and then confirms. If Redis can say OK and later lose
the write, a crash rolls the key back to an **older** value, and nothing will ever fix it (the change was confirmed and
won't be re-sent). A stale cache is the one failure a cache must never have. Driftless ships `appendfsync always`
(D-029).
