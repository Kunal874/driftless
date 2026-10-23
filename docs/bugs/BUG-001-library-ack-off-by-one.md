# BUG-001 — The replication library's ack can silently drop a transaction after a restart

| | |
|---|---|
| Found | 2026-10-22, T03, by reading `pg-logical-replication` 2.5.0's source *before* using it, then reproduced |
| Severity | **silent data loss**, after a crash or restart, when two commit records sit next to each other in the WAL |
| Status | fixed in Driftless (`sendStatus()` in `src/main.ts`). **Fixed upstream independently** in 2.6.0 (see "Upstream" below) |

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

## Upstream (checked 2026-10-23, T11.5)

Someone else hit the same `+ 1` from a different direction: PostgreSQL 18 failover slot sync skipped a fully
caught-up standby because the acknowledged position was one byte past the WAL end.
[kibae/pg-logical-replication#222](https://github.com/kibae/pg-logical-replication/pull/222) ("preserve WAL end
positions in standby acknowledgements", merged 2026-10-14) removed the increment, released in **2.6.0**. So no
report is needed; our finding and theirs agree on the cause.

What that means for Driftless:
- The dependency is **pinned to exactly `2.5.0`** (it was `^2.5.0`, which allows 2.6.0). Our `end − 1` compensation is
  correct only for a library that adds 1. 2.6.0 is also younger than the 14-day rule (D-017) allows today.
- `src/source/ack-contract.test.ts` checks the library's actual encoding (`acknowledge('0/9D68A47')` writes
  `0/9D68A48`). After an upgrade to ≥ 2.6.0 it fails, and the fix is one line: `sendStatus` passes `end` unchanged.
- With 2.6.0 and the old compensation, Driftless would confirm one byte short of each end. By our reading of the
  skip rule above, that changes nothing that gets re-sent, but it's not the exact position the code promises, so the
  test makes the upgrade a deliberate step.

## The interview version

"Before trusting the replication library I read its source and saw its ack adds one byte to the
position. I wrote a reproduction: two transactions whose commit records are adjacent. Acking the first
the library's way makes Postgres permanently skip the second after a restart. The fix was to confirm
exactly the commit's end LSN, like Postgres's own subscriber does, and the same reproduction now shows
the second transaction re-sent."
