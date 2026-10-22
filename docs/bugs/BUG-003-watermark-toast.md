# BUG-003 — The textbook watermark fix still lost data: Postgres doesn't send whole rows

| | |
|---|---|
| Found | 2026-10-22, T07.3, by the reconcile harness on the **first** run of the watermark backfill |
| Severity | **permanent, silent drift**: a document missing a whole field, in exactly the fresh-backfill case |
| Status | fixed in T07.3 before it was committed (column-aware windows) |

## Expected

The watermark backfill (DBLog, D-023) makes the BUG-002 test pass: 0 drift.

## Actual

`scripts/backfill-race.sh 300 200 150` went from 42 drifted documents to **1**:

```
backfill: done, 105288 rows … (47 snapshot rows dropped: the stream had newer values)
reconcile: 103786 rows vs 103786 documents
  mismatched documents: 1 (e.g. 19880)
    #19880 expected {"category":"office","description":"f6cb0b7ba8a833dd…","id":"19880",…}
    #19880 actual   {"category":"office","id":"19880","name":"Rugged Chair 180","price_cents":24271,…}
```

The document didn't hold an *old* value. It had **no `description` field at all**.

## How it was noticed

Reconcile after the run. That one document stood out because it was missing a field rather than holding a
stale one, which pointed straight at T02's unchanged-TOAST finding.

## Root cause

DBLog's rule is: "if the stream changed a key between the marks, drop the snapshot row; the stream has the newer
row". That assumes every change event carries the **whole** row, which holds for MySQL's full-row binlog, the
setting the technique was published with. Postgres's UPDATE events leave out big **unchanged** (TOASTed) values
(proved in T02). So for row 19880, which has a 2.5 KB description:

```
the index starts empty (fresh backfill)
low mark   → the window opens
             app: price-only UPDATE of 19880 → stream sends {id, sku, name, category, price, stock, updated_at}
                                               (no description: unchanged TOAST) → index: a doc WITHOUT it
SELECT     → the chunk has the full row, description included
high mark  → "19880 changed in the window" → its snapshot row is DROPPED
             → the only remaining copy of the description is thrown away, for good
```

It needs a big-description row *and* a partial update landing inside that row's own chunk window, so it's rare:
about 5% of rows × 60% price-only writes × the window ≈ 1 of the 47 dropped rows, matching what we saw. But it
hits the main backfill use case: indexing a table for the first time.

## Fix

Track **which columns** the stream sent for each changed key during the window, not just that the key changed:
- a DELETE (or full coverage) → drop the snapshot row, since the stream has the whole truth;
- an UPDATE that sent only some columns → push the snapshot's values for **only the columns the stream didn't
  send**. Those can't have changed in the window, because a changed value is always sent in full.

`createBackfill()` in `src/source/backfill.ts` (`changed: Map<key, Set<column> | 'all'>`), plus the unit test
"fills in the columns a partial update did not send, instead of dropping the row (BUG-003)", which fails on
the keys-only version.

## Proof

Same command, `scripts/backfill-race.sh 300 200 150`, after the fix: see T07.5 and `docs/RESULTS.md`.

## The interview version

"I implemented Netflix's DBLog watermark algorithm for backfilling while writes continue, and my reconcile
harness still found one document missing a whole field. The algorithm assumes change events carry the full
row. Postgres doesn't resend big unchanged TOASTed values in an UPDATE, so when such an update hit a row
inside its own chunk window, the algorithm dropped the snapshot copy, which was the only copy of that value. I
made the window track which *columns* the stream sent per key and fill in only the missing ones from the
snapshot. The lesson: a published algorithm comes with its original system's assumptions, and you have to check
them against yours."
