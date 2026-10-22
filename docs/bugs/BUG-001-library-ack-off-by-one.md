# BUG-001 — The replication library's ack can silently drop a transaction after a restart

| | |
|---|---|
| Found | 2026-10-22, T03, by reading `pg-logical-replication` 2.5.0's source *before* using it, then reproduced |
| Severity | **silent data loss**, after a crash or restart, when two commit records sit next to each other in the WAL |
| Status | fixed in Driftless (`sendStatus()` in `src/main.ts`); not reported upstream yet (owner's call) |

## Expected

After Driftless confirms transaction T1, a restart re-sends every later transaction that wasn't confirmed.

## Actual

`acknowledge(T1.commitEndLsn)` makes Postgres store `confirmed_flush_lsn = T1's end + 1`. That's exactly
what the library's own auto-ack does when it acks a commit message. If T2's commit record starts exactly at
T1's end, which is common because commit records are written back to back, Postgres treats T2 as already
confirmed and **never re-sends it**.

## How it was noticed

Reading `node_modules/pg-logical-replication/dist/logical-replication-service.js` before writing the
connector. `acknowledge()` adds 1 to the LSN it receives (lines 194–201), because the protocol field means
"last WAL byte + 1". But a commit's end LSN and a keepalive's position are *already* end positions (last
byte + 1). Postgres's own subscriber sends them unchanged.

The same file has two dangerous defaults (not bugs, but each loses data if left on):
- `acknowledge.auto = true`: every message is acked when it's *received*, before it's handled (at-most-once).
- `acknowledge.timeoutSeconds = 10`: a timer acks the last *received* LSN every 10 s, **even when
  `auto` is false**. If handling ever takes longer than 10 s, it acks work that isn't done.

## Steps to reproduce

```bash
node scripts/repro-ack-off-by-one.ts        # library-style ack
node scripts/repro-ack-off-by-one.ts fixed  # Driftless's ack
```

Driftless must be stopped. The script uses test data only:
1. Skip the slot to the current WAL position.
2. Two sessions each update a row, then commit back to back, which produces adjacent commit records.
3. Stream both, acknowledge only T1, stop.
4. `pg_logical_slot_peek_binary_changes(...)` lists what Postgres would re-send after a restart.

## Root cause

On restart Postgres skips every transaction whose commit record starts *before* `confirmed_flush_lsn`
(logical decoding's "needs skip" check, `commit LSN < start_decoding_at`). Confirming `end + 1` puts a
commit record that starts exactly at `end` on the wrong side of that line.

## Fix

Driftless always confirms an **end** position (a commit's `commitEndLsn`, or a keepalive's position when
idle) and compensates in one place: `service.acknowledge(end − 1)`, so Postgres receives exactly `end`.
Both library auto-acks are off: `{ auto: false, timeoutSeconds: 0 }`.

## Proof (2026-10-22)

| Run | T1 end | T2 commit starts at | Slot confirmed at | T2 re-sent after restart? |
|---|---|---|---|---|
| library ack | `09D68A48` | `09D68A48` | `09D68A49` | **no: lost** |
| fixed ack | `09D697F8` | `09D697F8` | `09D697F8` | yes |
| library ack (repeat) | `09D699B8` | `09D699B8` | `09D699B9` | **no: lost** |

Every run produced adjacent commit records, so the loss reproduces every time, not just occasionally.

## The interview version

"Before trusting the replication library I read its source and saw its ack adds one byte to the
position. I wrote a reproduction: two transactions whose commit records are adjacent. Acking the first
the library's way makes Postgres permanently skip the second after a restart. The fix was to confirm
exactly the commit's end LSN, like Postgres's own subscriber does, and the same reproduction now shows
the second transaction re-sent."
