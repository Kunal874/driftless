# Task 3 — Reading the WAL, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 3

1. Set up **Node + TypeScript** with no build step: Node 24 runs `.ts` files directly.
2. On every start, Driftless **checks Postgres** and creates its **publication** and **replication slot**
   if they're missing.
3. It **streams every committed change** and turns Postgres's `pgoutput` messages into transactions.
4. It tells Postgres "handled up to here" (an **ack**) only *after* handling, and at exactly the right byte.
5. Before trusting the replication library, we **read its source**. We found two automatic acks that
   would lose data, plus an off-by-one that can make Postgres skip a transaction after a restart. We
   reproduced that one, fixed it and wrote it up as **BUG-001**, the project's first real debugging story.
6. Added 10 unit tests.

---

## 1. The Node + TypeScript setup

**Type stripping.** Node 24 can run TypeScript directly: `node src/main.ts`. It doesn't compile anything.
It simply *erases* the type annotations (`: string`, `type X = …`) and runs what's left as JavaScript. That
only works for TypeScript features that are pure annotations. `enum`, `namespace` and constructor
"parameter properties" generate real code, so they're not allowed, and `erasableSyntaxOnly` in
`tsconfig.json` makes the type checker reject them.

**`tsc` only checks.** TypeScript 7 runs with `noEmit`: it reports type errors and produces no files.
Running is Node's job.

**Other settings, briefly:**
- `"type": "module"` uses modern JavaScript modules (`import`/`export`).
- Imports carry the real extension (`./decode.ts`), allowed by `allowImportingTsExtensions`.
- `verbatimModuleSyntax` makes you write `import type` for type-only imports, so Node knows what to erase.
- Vitest runs the tests (`npm test`).

**The 14-day rule (D-017).** A *supply-chain attack* is when someone publishes a malicious version of a
library many projects use. Those versions are usually spotted and pulled within days. So Driftless only
installs versions that are at least 14 days old: `npm install --before="$(date -d '-14 days' +%F)"`. On
2026-10-22 that meant `pg-logical-replication` 2.5.0 instead of the 8-day-old 2.6.0. `package-lock.json`
then pins the exact versions, and `npm audit` reported 0 vulnerabilities.

**Something that went wrong:** a test script imported `'D:/PROJECTS/driftless/src/config.ts'` and Node
refused with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. On Windows, modern-module imports must be relative
(`./src/config.ts`) or a `file:///D:/…` URL, because a bare `D:` looks like a URL scheme.

---

## 2. Two kinds of connection to Postgres

- A **normal SQL connection** runs the startup checks and creates things (`src/source/replication.ts`).
- A **replication connection** (`replication: 'database'` in the connection options) speaks Postgres's
  streaming-replication protocol. Driftless sends one command,
  `START_REPLICATION SLOT driftless_slot LOGICAL 0/0 (proto_version '1', publication_names 'driftless_pub')`,
  and from then on the server keeps *pushing* changes down that connection, forever.

---

## 3. Publication and slot: getting Postgres ready (`replication.ts`)

**Publication.** A named list of tables whose changes should be streamed, and which kinds of changes.
Ours is `driftless_pub`: table `products`, with insert, update, delete and truncate.

**Replication slot.** Postgres's bookmark for one consumer. It remembers how far that consumer has
confirmed (`confirmed_flush_lsn`), and Postgres keeps all WAL after that point until it's confirmed. That's
what makes a crash harmless, and also why a forgotten slot can fill the disk. Only one connection can use a
slot at a time.

**Safe to run on every start.** The code checks first and creates only what's missing. Proof: the first run
created both (slot at `0/71F31D8`), the second run changed nothing and returned the same position, and a
missing table or a table without a primary key gives a plain error message.

**Order matters: publication first, then slot.** That way the slot never sees changes from before the
publication existed.

**A new slot starts *now*.** Rows that already existed, such as our 100,000 seeded products, are **not**
streamed, only changes made after the slot was created. Copying the existing rows is called *backfill*;
that's Task 7.

**The checks, and why each exists:**
- `wal_level` must be `logical` (Task 1), or there's nothing to decode.
- Exactly **one primary-key column**: its value becomes the search document's id.
- **Replica identity** must be DEFAULT (use the primary key) or FULL (send the whole old row). Replica
  identity is how Postgres says *which row* an UPDATE or DELETE changed. With "nothing", Driftless couldn't tell.

---

## 4. From pgoutput messages to transactions (`decode.ts`)

**What arrives, per transaction, and only after it commits:**

| Message | Meaning |
|---|---|
| BEGIN | a transaction starts (transaction id, commit position, commit time) |
| RELATION | describes a table's columns; sent before the first change to that table |
| INSERT / UPDATE / DELETE / TRUNCATE | the changes, in order |
| COMMIT | the end; carries where the commit record **starts** and **ends** in the WAL |

**How values arrive.** As text, turned into JavaScript values by `pg`'s type parsers: `integer` →
number, `text` → string, `timestamptz` → `Date`. **`bigint` → string**, because a JavaScript number can only
hold whole numbers exactly up to 2⁵³ (about 9 quadrillion), and a 64-bit integer can be bigger. A string
can't silently lose digits.

**The assembler** collects changes from BEGIN to COMMIT and then hands over one `Transaction`:
`{ xid, commitLsn, commitEndLsn, commitTime, changes }`. Each change is an insert/update (with the row), a
delete (only the key) or a truncate.

**The details that matter:**
- **Unchanged TOAST** (Task 2) arrives from the library as `undefined`; a real SQL `NULL` arrives as `null`.
  The decoder *drops* `undefined` columns and keeps `null`. Live proof: the price-only update of product #10
  printed `[id, sku, name, category, price_cents, stock, updated_at]`, with no `description`.
- **DELETE** carries only the primary key.
- **A primary-key change** becomes "delete the old document" + "insert the new one". If big unchanged columns
  weren't sent, the new document would be incomplete, so the decoder **stops with an error** that says to use
  REPLICA IDENTITY FULL. Stopping loudly beats silently losing a description (D-009).
- **TRUNCATE** becomes one change that will clear the table's documents (D-018). Ignoring it would leave
  deleted rows in search forever after a re-seed.

**Live run (T03.3):** an insert; the TOAST-safe update; a description rewrite (all columns); a delete; a
3-row UPDATE (one transaction, 3 changes, in order); the re-seed (one truncate, then **one** transaction with
100,000 inserts). At that point Driftless acked nothing, so every restart replayed everything since the slot
was created. That's "at-least-once" in its purest form.

---

## 5. Acknowledging: where correctness lives

**What an ack is.** A *standby status update*: a tiny message saying "I've handled everything before
position X". After it, Postgres won't re-send those changes after a restart, and may delete that old WAL.

- **Ack too early** (before handling): a crash loses those changes forever. That's called *at-most-once*.
- **Ack late**: after a crash some changes are re-sent and re-applied. Because our writes will be
  upserts/deletes by primary key, applying twice gives the same result (*idempotent*). At-least-once
  delivery plus idempotent writes gives an *exactly-once effect*, which is the goal (D-006).

### Reading the library before trusting it

The ack is the one place where a mistake silently loses data, so before writing code we read
`node_modules/pg-logical-replication/dist/logical-replication-service.js`. Three findings:

1. **`acknowledge.auto` is `true` by default.** Every message is acked the moment it's *received*.
2. **A hidden second auto-ack.** `acknowledge.timeoutSeconds` defaults to 10. A timer then acks the last
   *received* position every 10 s, **even when `auto` is off**. If handling ever took longer than 10 s (a
   slow search engine, say), it would ack work that isn't done. We set it to 0.
3. **`acknowledge(lsn)` adds 1 to whatever you pass.** That's BUG-001, next.

### BUG-001 — one byte too far

WAL positions used for acks are **end** positions: "everything *before* this byte is done". Think of a
bookmark placed at the first line of the next chapter. A commit's `commitEndLsn` is already such an end
position, and it's what Postgres's own subscriber sends back. The library adds 1, so the bookmark lands one
byte *into* the next chapter.

Why does one byte matter? After a restart, Postgres skips every transaction whose commit record **starts
before** the confirmed position. Commit records are often written back to back, so the next transaction's
commit can start exactly where the previous one ends:

```
T1 commit: 00000000/09D68A18 → ends 00000000/09D68A48   (handled, acked)
T2 commit: starts       00000000/09D68A48              (NOT handled yet)
library ack sends 09D68A48 + 1 = 09D68A49  →  T2 "starts before" it  →  skipped after a restart: LOST
```

**How we proved it.** `scripts/repro-ack-off-by-one.ts` makes two sessions commit back to back (adjacent
commit records), acks only T1 and stops. It then asks Postgres what it *would* re-send, using
`pg_logical_slot_peek_binary_changes`. Library-style ack: T2 is gone, in 2 of 2 runs. Our ack: T2 is still
there.

**The fix,** in one function (`sendStatus` in `src/main.ts`): pass `end − 1`, so after the library's +1
Postgres receives exactly `end`. The LSN arithmetic uses `BigInt` (`src/source/lsn.ts`), with a unit test for
the tricky case where subtracting 1 borrows across the two 32-bit halves (`1/0 − 1 = 0/FFFFFFFF`).

Full write-up: `docs/bugs/BUG-001-library-ack-off-by-one.md`.

### The rest of the confirm protocol (D-019)

- **After each transaction:** print it, then confirm its end position.
- **When idle, confirm the server's position anyway.** The slot guards WAL for *all* tables, not just ours.
  If only unpublished tables change, nothing reaches Driftless, so nothing gets confirmed and WAL piles up.
  The server regularly sends *keepalive* messages carrying its current position. When Driftless has nothing
  pending, it confirms that position. Proof: while 25,000 rows went into an unpublished table, the slot moved
  from `0/9D69C90` to `0/9F0A7D0`, exactly the server's position.
- **When busy, still answer.** If the server asks for a reply and Driftless is mid-transaction, it re-sends its
  *current* position ("still alive, no progress"). Without a reply within `wal_sender_timeout` (60 s), Postgres
  drops the connection.
- **Never backwards.** The confirmed position starts at the slot's `confirmed_flush_lsn` and only grows.
- **Our own queue.** The library offers a "flowControl" queue, but its keepalives skip that queue. A keepalive
  read from the same network chunk as still-unhandled changes would make Driftless think it's idle, and it
  would confirm those changes early. So incoming messages go straight into Driftless's own array, and "idle"
  means that array is empty, nothing is being handled, and no transaction is half-done.

### The crash test

A debug setting, `DRIFTLESS_DEBUG_ACK_DELAY_MS`, waits between handling a transaction and acking it, so a
test can kill the process inside that window. With 8 seconds of delay:
- **A:** a normal run handled transaction 6860 and confirmed it.
- **B:** transaction 6861 was printed, then the process was killed with `taskkill /F` (Windows' version of
  SIGKILL: no cleanup, no goodbye). The slot stayed exactly where A left it.
- **B2:** on restart, 6861 came back and was confirmed. 6860 was **not** re-sent.

**Fail-stop.** Any error, whether from the database, the decoder or later the search engine, makes Driftless
log it and exit. A stopped connector is visible and resumes without loss; one that skips a change drifts
silently (D-009).

---

## 6. Tests

- **`lsn.test.ts`** (3 tests): both LSN text forms, round-trips, the 32-bit borrow, bad input.
- **`decode.test.ts`** (7 tests): grouping and order, unchanged TOAST vs real NULL, replica identity FULL,
  primary-key change, refusing a key change that would lose a big value, TRUNCATE, protocol errors.
- **A Vitest gotcha:** `toEqual` treats `{ description: undefined }` the same as having no `description`
  key, so it can't tell "omitted" from "set to undefined". The TOAST test uses `toStrictEqual`, which can.
- The live checks (crash, idle, fresh start) were run by hand this time. Task 5 automates them in a harness.

---

## 7. If an interviewer asks…

- **"What delivery guarantee does Driftless give?"** At-least-once from the slot, because it only acks after
  handling. Idempotent writes turn that into an exactly-once *effect* in the index.
- **"What if the connector dies mid-transaction?"** Nothing after the last handled transaction was confirmed,
  so Postgres re-sends from there. I proved it by killing the process inside the ack window.
- **"Why read a library's source code?"** Because the ack is the correctness boundary. Its defaults were
  at-most-once, and it had an off-by-one that I reproduced: acking a commit's end the library's way makes
  Postgres skip the next transaction after a restart.
- **"Why does an idle connector need to ack?"** The slot holds WAL for the whole database. If only other
  tables change and the slot never advances, disk usage grows without limit.
- **"Why is a bigint a string in JavaScript?"** Numbers are exact only up to 2⁵³; a string can't lose digits.

---

## Glossary

- **Replication connection**: a Postgres connection in streaming mode; the server pushes changes.
- **Publication / slot**: which tables to stream / Postgres's bookmark for one consumer.
- **`confirmed_flush_lsn`**: the slot's "handled up to here" position.
- **Replica identity**: how Postgres identifies the changed row (default = primary key; full = whole old row).
- **RELATION message**: a table's column description inside the change stream.
- **Keepalive**: the server's "are you there?" message, which also carries its current WAL position.
- **Standby status update (ack)**: the client's "handled everything before X" message.
- **`wal_sender_timeout`**: how long Postgres waits for a reply before dropping the connection (60 s).
- **At-most-once / at-least-once / exactly-once effect**: may lose / may repeat / repeats harmlessly.
- **Idempotent**: doing it twice gives the same result as doing it once.
- **Fail-stop**: on an unexpected error, stop loudly instead of carrying on wrong.
- **Type stripping**: Node running TypeScript by erasing the type annotations.
- **Supply-chain cooldown**: waiting before adopting a brand-new dependency version.
