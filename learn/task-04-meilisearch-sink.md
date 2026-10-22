# Task 4 — The Meilisearch sink, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 4

1. Installed the official Meilisearch JavaScript client (0.62.0, under the 14-day rule) and **read its API
   before using it**. Its default "wait for a write" timeout of 5 s would have been too short.
2. Created the `products` index with an **explicit primary key**.
3. Wrote the single **row → document mapping** (D-020).
4. Built the **sink**. Each transaction becomes as few Meilisearch writes as possible, without ever reordering
   a change.
5. **Ack after apply:** a transaction is confirmed to Postgres only after Meilisearch reports *every* write
   `succeeded`.
6. A **retry policy** that treats "Meilisearch is down" and "Meilisearch said no" differently (D-021).
7. Proved it live: 100,000 rows indexed through the stream in 4.1 s, the big-description case, a Meilisearch
   outage, and a crash between "applied" and "acked".

---

## 1. How Meilisearch thinks

- A **document** is a JSON object; an **index** is a collection of documents (ours: `products`).
- The **primary key** is the field that identifies a document (ours: `id`). Writing a document whose id
  already exists updates that document instead of adding another.
- **Why set it explicitly.** If you don't, Meilisearch guesses from the first document: any field whose name
  contains "id". That guess can fail, or pick the wrong field. `ensureIndex()` creates the index with
  `primaryKey: 'id'`, and refuses to start if an existing index uses a different key.
- **Writes are tasks.** Every write returns `202 Accepted` and a task number straight away. The real work
  happens later. A task moves `enqueued → processing → succeeded` (or `failed` / `canceled`), and tasks run
  in the order they were enqueued. **202 means "queued", not "done".**
- **Waiting.** The client's `waitTask()` asks Meilisearch every 50 ms "is task N finished?". Its default
  timeout is 5 seconds, but writing 10,000 documents can take longer, so the sink waits up to 10 minutes.

---

## 2. The document shape (D-020)

`src/sinks/document.ts` is the only place that decides what a document looks like:
- **`id` is a string** (`"10"`). The `pg` driver delivers `bigint` as a string, because a JavaScript number
  is only exact up to 2⁵³. A string id can never be rounded, and Meilisearch accepts string ids.
- **Dates become ISO-8601 strings** (`"2026-10-22T16:00:00.123Z"`): exact, readable, and they sort correctly.
- **Only the columns that arrived** go into the document (next section).

There's only one mapping because Task 5's reconcile will compare Postgres rows against documents using *this
same function*. The writer and the checker can never disagree about what "correct" means.

---

## 3. Merge vs replace: the TOAST trap, closed

Meilisearch has two ways to write a document:

| Method | What happens to fields you don't send |
|---|---|
| `addDocuments` ("add or **replace**") | they're **deleted**: the new document replaces the old one entirely |
| `updateDocuments` ("add or **update**") | they're **kept**: your fields are merged into the stored document |

A price-only update arrives without `description`: it's unchanged, so Postgres didn't resend it (Task 2,
TOAST). With `addDocuments`, every price change would wipe the description from search. With
`updateDocuments` it stays. **Proof:** after a price-only update, document #10 still has its 2,560-character
description, the same as the row.

---

## 4. Turning a transaction into writes (`planSteps`)

One write per change would be slow; one write for everything could reorder changes. The rule:

- **Consecutive** inserts/updates share one write. If the same row is changed twice inside that run, the two
  versions are **merged in order**, so later fields win. (Proof: transaction 6883 changed #6's stock and then
  its price; the document has both.)
- A **delete** or a **TRUNCATE** always starts a new write, so nothing moves across it. For example,
  `update #5 → delete #5 → insert #5` stays three separate writes, in that order. Merging across the delete
  would bring the deleted row back with mixed-up fields.
- **TRUNCATE** clears the whole index (`deleteAllDocuments`, D-018).
- Very big runs are cut into **10,000-document chunks**. The 100,000-row seed became 10 writes, indexed in
  4.1 s.

One consequence to be honest about: a transaction's writes land one by one, so for a few milliseconds search
can show *part* of a multi-row transaction. That's acceptable for search (D-007); Postgres stays the source of
truth.

---

## 5. Ack after apply

`handle()` in `src/main.ts` now does, in this order: **print → apply** (wait until every write
`succeeded`) **→ confirm** the transaction's end position to Postgres.

If it confirmed after the 202 instead, a write that later failed would be lost for good: Postgres would have
dropped that WAL, and nobody would retry.

**A number worth remembering:** each small transaction takes about **100 ms** to apply, because it's one
Meilisearch task plus waiting for it. Applying transactions one at a time therefore caps Driftless at roughly
**10 transactions per second**, while the workload produces 200. A 10,000-document write costs about the
same as a 1-document write, so the answer is to batch *across* transactions. That's Task 6, and this is the
"before" number.

---

## 6. The retry policy (D-021)

Two kinds of failure need opposite treatment. Think of a shop: *closed* versus *open but refusing your order*.

| Failure | Examples | What Driftless does |
|---|---|---|
| **Unavailable** ("closed") | can't connect, request timeout, HTTP 5xx (server error), HTTP 429 (too many requests) | wait and retry, **as long as it takes** |
| **Rejected** ("refused") | the task `failed` (e.g. an invalid document), HTTP 4xx | 3 tries in total, then **stop** with the transaction id and document ids |

- **Waiting out an outage loses nothing.** Nothing is confirmed while waiting, so Postgres keeps the WAL. Lag
  grows, which is visible, and everything catches up afterwards.
- **A rejection usually repeats** (the same bad document fails the same way), so retrying forever would hang
  silently. Stopping is loud, loses nothing, and the error message says exactly which rows (fail-stop, D-009).
- **Exponential backoff with full jitter.** After attempt *n*, wait a *random* time between 0 and
  min(30 s, 100 ms × 2ⁿ). Exponential means a long outage isn't hammered with requests. *Random* matters
  because many clients retrying on the same schedule would all hit the server at the same instant it comes back
  (a "thundering herd").
- **Re-sending is safe.** If Meilisearch failed after receiving a write, re-sending it may apply it twice. That's
  harmless: writes set values (idempotent), and tasks run in enqueue order.
- **Startup fails fast** instead. If Meilisearch is unreachable when Driftless starts, it exits with a clear
  error; a supervisor (Task 5's compose service) restarts it.

**Tests without a real server:** `meilisearch.test.ts` uses a scripted fake write that returns "unreachable",
503, 429, "failed" or "succeeded" in a given order. That checks every branch in milliseconds (21/21 tests).

---

## 7. The live proofs

1. **The whole table through the pipeline.** Re-seeding after the slot exists streamed one TRUNCATE plus one
   100,000-row transaction. Indexed in 4.1 s; 100,000 rows = 100,000 documents; 11 sampled ids identical.
2. **Outage.** `docker compose stop meilisearch`, then three writes. For 10 seconds the slot didn't move and
   the log showed jittered retries (`retrying in 52 ms`, `395 ms`, `337 ms`, …). After
   `docker compose start meilisearch`, all three were applied within about 5 s, with no loss.
3. **Crash after apply, before ack.** `stock = stock + 1` on #30 (92 → 93) was applied, then the process was
   killed before confirming. The slot didn't move. On restart the transaction was replayed and applied again,
   and the document shows **93, not 94**. A change stream carries the row's new *value* ("stock is now 93"),
   not the operation ("add 1"), so applying it twice is harmless. That's idempotency, live.

---

## 8. If an interviewer asks…

- **"Why not ack when Meilisearch returns 202?"** 202 means queued. If the task later fails and I've already
  acked, Postgres has dropped that change and nobody retries it, so it's lost silently.
- **"What if Meilisearch is down for an hour?"** Driftless keeps retrying with capped, jittered backoff and
  confirms nothing. Postgres keeps the WAL, lag grows (visible), and it catches up when Meilisearch returns.
  The cost is WAL disk space, which Task 8 bounds.
- **"Why jitter?"** Without it, every retrying client wakes up at the same moments and floods the server just as
  it recovers.
- **"Isn't applying a change twice a problem?"** Not here: the stream carries values, not increments, and
  writes are keyed by primary key. A replay sets the same value again.
- **"Is search consistent with Postgres?"** Eventually. Each row is applied in commit order, but a multi-row
  transaction can be briefly half-visible, which is fine for search. Lag is measured in Task 9.

---

## Glossary

- **Document / index / primary key**: a JSON record / a collection of them / the field that identifies one.
- **Task**: Meilisearch's unit of asynchronous work; `202 Accepted` + a task id; done when `succeeded`.
- **Add-or-replace vs add-or-update**: `addDocuments` drops unsent fields; `updateDocuments` merges.
- **Sink**: the component that writes changes to the destination system.
- **Idempotent**: applying it twice gives the same result as once.
- **Transient vs permanent failure**: "try again later" vs "will fail the same way again".
- **Exponential backoff with full jitter**: random waits from a range that doubles after each failure, up to a cap.
- **Thundering herd**: many clients retrying at the same instant and overwhelming a recovering server.
- **Fail-stop**: stop loudly on an error that can't be safely handled, instead of skipping it.
