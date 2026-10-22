# Task 7 — Backfill, explained (and two real bugs)

> One file per finished task: everything that was done, *why*, and what went wrong on the way.
> This is the task with the interview stories: BUG-002 and BUG-003.

## What we did in Task 7

1. Built the **naive backfill** on purpose: copy the existing rows in chunks while the stream keeps running.
2. **Reproduced its race** with the harness: 42 documents left permanently wrong (**BUG-002**).
3. Fixed it with **watermarks**, Netflix's DBLog technique. The harness then found **one more** wrong
   document: the textbook algorithm assumes something Postgres doesn't do (**BUG-003**). Fixed that too.
4. Made a backfill **survive crashes**: progress is saved after each applied chunk, and a restart resumes.
5. **Proved it**: repeated runs under load at 0 drift, plus kills in the middle of a backfill.

---

## 1. Why backfill exists

A replication slot only streams changes made **after** it was created (Task 3). Rows that already existed,
such as a shop's 100,000 products on the day you install Driftless, never come through the stream. Copying
them into the index is a **backfill** (also called a snapshot or initial load).

The hard part: the app doesn't stop writing while you copy. So two writers feed the index at the same time:
- the **stream**, with the newest changes;
- the **backfill**, with copies of rows read *a moment ago*.

---

## 2. The naive backfill and its race (BUG-002)

The obvious approach: read 1,000 rows by primary key, push them into the lanes (the same queues the stream
uses, so per-key order is kept), wait until they're applied, then read the next 1,000.

The flaw is that the copy is older than the moment it arrives:

```
t0  backfill reads row 778         → its copy says price 15,471
t1  the app updates row 778        → stream → lane → index says 137,275   ✓
t2  backfill pushes its copy       → lane → index says 15,471            ✗  forever
```

The lanes keep the *stream's* changes in order, but the backfill's copy enters the lane *after* the newer
update, even though it describes an *older* state. Nothing corrects it later unless the row changes again. A
DELETE in that gap is worse: the copy **brings a deleted row back**.

**Proving it.** `scripts/backfill-race.sh` empties the index, starts Driftless with backfill on, runs the
workload at 200 tx/s alongside, then reconciles. A debug setting adds a 300 ms pause between *reading* a chunk
and *writing* it, to widen the gap.

| Run | Result |
|---|---|
| 300 ms gap | **42 documents wrong**: 40 with older values, 2 deleted rows resurrected |
| no gap | 0 wrong that time |

Is the no-gap result reassuring? No. The gap is a few milliseconds on an idle laptop, but a slow query on a big
table, a garbage-collection pause or a busy database stretches it in production. The 300 ms setting simulates
that. **A race that rarely shows up is still a race.**

---

## 3. The fix: watermarks (DBLog)

Idea: make the **stream itself** say what changed while a chunk was being read. For every chunk:

1. **Low mark:** `UPDATE driftless_watermark SET mark = 'low:<random id>'`. It's a normal row change in a
   *published* table, so it goes through the WAL and arrives in the stream, in order.
2. **SELECT** the chunk.
3. **High mark:** `UPDATE driftless_watermark SET mark = 'high:<same id>'`.

Driftless watches the stream. From the low mark to the high mark, it **records every key that changes**.
When the high mark arrives, it pushes the chunk into the lanes at exactly that point, **minus** the keys that
changed: for those, the stream already carries a newer value.

Why this is correct, by where a change falls:
- **committed before the low mark:** it was already in the stream before the window, and the SELECT sees it
  too. No conflict.
- **between the marks:** the key is recorded, so the old copy isn't pushed, and the stream's version stands.
- **after the high mark:** it arrives after the chunk in the lane, so it's applied after the copy. Correct order.

**A timing detail.** The low mark can come through the stream *before* the SELECT has even returned. So
Driftless records changed keys in a separate set, rather than deleting them from a chunk it might not have
loaded yet. The high mark is only written after the SELECT, so by then the chunk is always loaded.

Other details:
- A TRUNCATE inside the window drops the whole chunk, because every row it read is gone.
- Marks from an older run (re-sent after a restart) carry a different id and are ignored.
- `driftless_watermark` is Driftless's own one-row table, created on start and added to the publication automatically.

---

## 4. The fix had a bug: Postgres doesn't send whole rows (BUG-003)

The first run of the watermark version went from 42 wrong documents to **1**. Document #19880 wasn't old: it
had **no description at all**.

DBLog was published for MySQL, whose change log carries the **whole row** for every update. The rule "a key
changed in the window → drop the copy, the stream has the newer row" depends on that. **Postgres doesn't send
whole rows.** As Task 2 proved, an UPDATE leaves out big *unchanged* (TOASTed) values. So:

```
the index starts empty (a fresh backfill)
low mark   → window opens
             price-only UPDATE of 19880 → the stream sends everything EXCEPT the 2.5 KB description
SELECT     → the chunk has the full row, description included
high mark  → "19880 changed" → its copy is dropped → the description's only copy is gone
```

**Fix:** record **which columns** the stream sent for each changed key, not just that it changed. At the high
mark:
- not changed → push the whole copy;
- deleted, or every column re-sent → push nothing;
- some columns sent → push **only the columns the stream did not send**. Those can't have changed in the
  window, because a changed value is always sent in full.

The next run's log line shows it working: *"42 snapshot rows dropped and **1 only filled in**"*, then 0 drift.

**The lesson for interviews:** a published algorithm comes with the assumptions of the system it was built
for. Check them against yours.

---

## 5. Surviving crashes: saved progress

A backfill of a big table takes a while, and it must not start over after a crash (a crash loop would never
finish) or skip anything.

- Progress lives in `driftless_state`, Driftless's own table that is **not** published, so its writes don't
  come back through the stream: `{"status":"running","after":"37593"}`.
- It's saved only after a chunk is **applied**, never just read. If Driftless dies mid-chunk, that chunk is read
  again on restart. Re-applying the same values is harmless.
- **What happens on start** (D-024): an interrupted backfill is resumed. Otherwise `DRIFTLESS_BACKFILL=1` starts
  one. Otherwise an empty index for a table with rows starts one by itself (first install, or someone deleted
  the index).

**Proof:** a backfill under 200 tx/s was killed 6 times. Each restart said `backfill: resuming after id …`, and
the result was 105,175 rows = 105,175 documents, 0 drift.

---

## 6. Results

The authoritative copy, with exact commands, is `docs/RESULTS.md` §5.

**The story in three runs** (same command each time: empty index, backfill under 200 tx/s, 300 ms windows):

| Version | Drifted documents |
|---|---|
| naive | **42** (BUG-002) |
| watermarks, keys only | **1** (BUG-003) |
| watermarks, column-aware | **0** |

**The proof: 10 out of 10.** Ten more runs of the final version, each backfilling ~110k rows while ~30,000
transactions were written, ended at 0 drift every time. Across them, **420** snapshot rows were dropped because
the stream had a newer value; the naive version would have written each one back. **9** were only filled in; the
keys-only version would have left each without a description. Both fixes did real work in every run.

**Crashes:** 6 SIGKILLs during one backfill. It resumed 6 times and ended at 0 drift.

**Speed: chunk size matters.** Every chunk costs about the same fixed overhead (two marks, a trip through the
stream, about one Meilisearch write per lane), whatever its size:

| Chunk size | 105,175 rows backfilled in |
|---|---|
| 1,000 | 104 s |
| 5,000 | 23 s |
| 10,000 (now the default) | **14 s** |

The proof runs deliberately kept 1,000-row chunks: more chunks means more race windows (≈105 per run), the
harshest test.

---

## 7. If an interviewer asks…

- **"How do you index existing data while writes continue?"** Chunked reads bracketed by watermarks written through
  the WAL. Keys the stream changes between the marks don't get the snapshot's older copy. No table locks.
- **"Why not just copy the table first, then start streaming?"** Rows change during the copy. Streaming
  first and copying alongside, with watermarks deciding who wins, has no gap and no lock.
- **"Tell me about a bug you found."** Pick BUG-002 (the race, reproduced on purpose) or BUG-003 (the published
  algorithm's hidden assumption). Both have numbers: 42 → 1 → 0.
- **"What if the backfill crashes halfway?"** Progress is saved after each applied chunk, so it resumes there. The
  interrupted chunk is read again, and re-applying values is idempotent.

---

## Glossary

- **Backfill / snapshot**: copying rows that existed before streaming started.
- **Race condition**: a bug that depends on the timing of two concurrent things.
- **Watermark**: a marker written into the stream itself, to bracket an operation.
- **DBLog**: Netflix's watermark-based change-data-capture backfill technique (2020); Debezium's incremental
  snapshots are based on it.
- **Window**: the part of the stream between a chunk's low and high marks.
- **Full row image vs partial**: whether a change event carries every column or only some.
- **Resume**: continuing an interrupted job from saved progress instead of starting over.
