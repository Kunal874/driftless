# BUG-002 — Naive backfill overwrites newer values and resurrects deleted rows

| | |
|---|---|
| Found | 2026-10-22, T07.2: reproduced **on purpose**, as planned (D-008), with `scripts/backfill-race.sh` |
| Severity | **permanent, silent drift**: wrong documents stay wrong after Driftless has fully caught up |
| Code | `naiveBackfill()` in `src/source/backfill.ts` at commit `9852dce` (T07.1) |
| Status | fixed in T07.3 with DBLog-style watermarks (see "Fix") |

## Expected

Backfilling the existing rows while the application keeps writing ends with the index equal to Postgres.

## Actual

```
reconcile: 102843 rows vs 102845 documents
  missing documents:    0
  extra documents:      2 (e.g. 56665, 98444)
  mismatched documents: 40 (e.g. 211, 778, 3359, 6614, 8377)
    #778 expected {… "price_cents":137275, … "stock":153, … "updated_at":"2026-10-22T18:07:2…
    #778 actual   {… "price_cents":15471,  … "stock":362, … "updated_at":"2026-10-22T17:59:11…
DRIFT: 42 document(s) differ from Postgres
```

Document #778 holds the row *as the backfill read it* (its `updated_at` is the seed time). Postgres holds a
newer update. Documents 56665 and 98444 exist for rows that no longer exist: they were deleted while their
chunk was in flight, and the chunk re-inserted them.

## How it was noticed

By design. The plan said to build the naive version first and try to break it, because the race is
well known (it's why Netflix's DBLog and Debezium's incremental snapshots exist). The harness from T05 turned
"there might be a race" into an exact count.

## Steps to reproduce

```bash
git switch --detach 9852dce                    # T07.1: the naive backfill
scripts/backfill-race.sh 300 200 150           # empty the index, backfill under 200 tx/s, reconcile
git switch main
```

`300` is a 300 ms pause between *reading* a chunk and *writing* it (`DRIFTLESS_BACKFILL_DEBUG_DELAY_MS`), which
makes the window easy to hit. Without the pause (`backfill-race.sh 0 200 100`) the same run ended with 0 drift
this time: the window is real but only milliseconds wide on an idle laptop. A slow `SELECT` on a big table, a GC
pause or a busy database widens it in production. The pause simulates exactly that.

## Root cause

The backfill reads a chunk at time *t₀* and writes it at *t₁*. If a row in the chunk changes between *t₀*
and *t₁*, the stream delivers the new version to the row's lane **before** the chunk's old copy arrives. The
lane applies in arrival order, so the old copy lands last and wins:

```
t₀  backfill SELECTs row 778        → holds v1 (price 15471)
t₀+ app UPDATEs row 778 → v2        → stream → lane → index has v2 ✓
t₁  backfill pushes its copy of 778 → lane → index has v1 ✗   (and nothing will ever correct it)
```

A DELETE in that window does the same thing to a row that no longer exists: the chunk re-inserts it ("extra").
Lanes keep the *stream's* changes in order, but the backfill is a second writer whose data is older than its
arrival time. Ordering alone can't fix that.

## Fix (T07.3): watermarks, after Netflix's DBLog

Bracket each chunk with two marks written *through the WAL*, so the stream itself says what happened during
the read:
1. Write a **low** mark (an UPDATE to `driftless_watermark`, a table in the publication).
2. `SELECT` the chunk.
3. Write a **high** mark.
4. In the stream: from the low mark on, remember every key that changes. At the high mark, push only the
   chunk rows whose key did **not** change, at exactly that point in the stream. Any key that changed in
   between already has a newer value coming from the stream.

## Proof

With the fix (after BUG-003 was also fixed), the same command, `backfill-race.sh 300 200 150` with 1,000-row
chunks, passed **10 times out of 10** at 0 drift. Across those runs 420 snapshot rows were dropped because the
stream already had a newer value; the naive backfill would have written every one of them back. Also passed with
6 SIGKILLs during a backfill. Details: `docs/RESULTS.md` §5.

## The interview version

"To index existing rows while writes continue, the obvious approach reads the table in chunks and writes them
alongside the change stream. I built it that way on purpose and attacked it with a harness that compares every
row with its document. With a 300 ms gap between read and write it left 42 documents permanently wrong out of
about 100k: 40 holding older values and 2 rows resurrected after deletion. The root cause is that the snapshot
copy is older than the moment it arrives. I fixed it with DBLog-style watermarks written through the WAL: any key
that changes between the low and high mark is dropped from the chunk, because the stream already carries its
newer value. The same test then passed 10 times out of 10."
