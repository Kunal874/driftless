# Flows — how the important processes work, step by step

Each step lists **where it can break**. When something goes wrong, find the step whose
"can break" matches the symptom. Status: ✅ built · 📐 designed, not built yet.

---

## Flow 1 — One row change, end to end · ✅ built (T03–T06); the lag metric in step 10 comes in T09

1. The app runs `UPDATE products SET price_cents = 999 WHERE id = 42` and commits.
   - *Can break:* a table without a primary key. Once it's in a publication, Postgres
     **rejects** its UPDATE/DELETE statements ("does not have a replica identity").
2. Postgres writes the change to the WAL before touching the table files (crash safety).
   With `wal_level=logical` the record contains enough to rebuild the row.
3. The WAL sender serving `driftless_slot` decodes it with **pgoutput** and streams
   `BEGIN → UPDATE → COMMIT` to Driftless. Nothing is sent before the commit.
   - *Can break:* slot missing or invalidated (Flow 4); connection drop (reconnect resumes
     from the slot's confirmed LSN, so no loss).
4. The decoder turns the messages into `ChangeEvent`s (`op`, `pk`, `row`, `commitLsn`, `commitTime`).
   - *Can break:* columns sent as **"unchanged TOAST"** (big values that didn't change) must be
     *omitted*, not written as `null`, or the document loses its description.
5. The router hashes the primary key to lane *k*; the lane queues the event in order.
   - *Can break:* queue full → the stream must pause (Flow 4), never drop events.
6. When lane *k*'s previous write finishes, it takes everything that queued up meanwhile (up to
   `batchMax`, default 5000; no timer) and reduces it to one result per key. It sends at most two writes in
   parallel: `updateDocuments` (merge) and `deleteDocuments`, which touch different keys (D-022).
7. Meilisearch answers **202 = queued**, then applies the task asynchronously. Driftless waits
   until the task status is `succeeded`.
   - *Can break:* treating 202 as "done"; a `failed` task (bad document) → retry with backoff,
     then **stop** with an error naming the row (fail-stop, D-009). Never skip it.
8. The lane reports "events of txn X applied". The checkpointer marks txn X complete once all
   its events, across all lanes, are applied.
9. The checkpointer acks the highest commit **end** LSN whose transaction **and every earlier one**
   are complete. Postgres advances the slot; old WAL can be recycled. (Confirm rules: D-019.)
   - *Can break:* acking a later transaction while an earlier one is still in flight (data loss
     on crash); acking one byte past the end (BUG-001: the next transaction can be skipped after
     a restart); never acking while idle (WAL grows forever, so confirm the keepalive position when
     nothing is pending).
10. A search for the product now shows the new price. Lag = time of step 7 − commit time (T09).

---

## Flow 2 — Crash and restart · 🔨 verified in T03 for the printing connector (T04–T05 with the sink)

1. Driftless dies at any moment (`docker kill`, power cut, bug).
2. Postgres still holds all WAL after the slot's confirmed LSN. Nothing is lost.
3. On restart Driftless reconnects to the same slot; Postgres re-sends every transaction after
   the last ack.
4. Some re-sent changes were already applied before the crash. Upsert/delete by primary key
   makes applying them again harmless (invariant 4).
5. The index converges; `reconcile` reports 0 drift.
   - *Can break:* auto-ack left on in the replication library; ack before apply; any
     non-idempotent write (e.g. incrementing a counter).

---

## Flow 3 — Backfill with watermarks · ✅ built in T07 (D-023)

Goal: index rows that existed before Driftless started, while live writes keep coming.

1. Read persisted progress: the last primary key already backfilled (T07.4).
2. Write a **low watermark** L (`UPDATE driftless_watermark SET mark = 'low:<uuid>'`). It travels
   through the WAL like any change.
3. `SELECT` the next chunk of rows by primary key.
4. Write a **high watermark** H.
5. In the stream: from L on, record for every changed key **which columns** the stream sent
   (a DELETE counts as "all"). The low mark can arrive before the SELECT returns, so keys are
   recorded rather than removed from a chunk that may not be loaded yet.
6. On seeing H, push the chunk into the normal lanes, at exactly that point in the stream:
   untouched rows whole; for a changed key only the columns the stream did *not* send; nothing
   for keys deleted or fully rewritten in the window. A TRUNCATE in the window drops the chunk.
7. After those rows are applied, persist progress = last key of the chunk. Repeat until done.
   - *Can break:* watermark table missing from the publication (marks never arrive, so it
     hangs); chunk rows written outside the lanes (order lost); progress saved before apply;
     dropping a whole row for a *partial* update (BUG-003: the TOASTed value is lost).

The naive version (SELECT, then write straight into the lanes) has a race: a chunk row read
*before* an update can be written *after* it, putting the old value back permanently (BUG-002,
reproduced on purpose in T07.2: 42 documents wrong).

---

## Flow 4 — Slow sink, backpressure and WAL safety · 📐 (built in T08)

1. Meilisearch slows down or stops, so lane queues fill up.
2. At the high-water mark Driftless stops reading the replication stream. TCP backpressure
   stops the WAL sender; Postgres keeps the WAL on disk (watched via retained-WAL metric).
3. Meilisearch recovers → queues drain below the low-water mark → reading resumes.
4. If Driftless is down so long that retained WAL exceeds `max_slot_wal_keep_size`, Postgres
   **invalidates the slot** to protect its own disk.
5. On start, Driftless sees `wal_status = 'lost'` and stops with recovery steps: drop and recreate
   the slot, then re-backfill. It never "just continues" (changes were lost).
