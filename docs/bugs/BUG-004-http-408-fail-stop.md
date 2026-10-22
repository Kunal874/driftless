# BUG-004 — A woken-up Meilisearch answered 408, and the retry policy crashed Driftless

| | |
|---|---|
| Found | 2026-10-23, T08.3: `scripts/slow-sink.sh 300 600 50000` (Meilisearch frozen for 5 minutes under load) |
| Severity | an unnecessary crash and restart. **No data lost**: fail-stop + restart + replay worked as designed |
| Status | fixed: HTTP 408 is retried like 429 and 5xx (`isTransient()` in `src/sinks/meilisearch.ts`) |

## Expected

After a long Meilisearch outage, Driftless keeps retrying until Meilisearch is back, then catches up, with no crash.

## Actual

The connector log showed one fatal error, one Docker restart, then a normal catch-up (reconcile: 0 drift):

```
driftless: fatal: MeilisearchApiError: 408: Request Timeout
    at async submit (src/sinks/meilisearch.ts:93:20)
    at async Object.applyBatch (src/sinks/meilisearch.ts:69:7)
```

## How it was noticed

The first 5-minute run reported "1 fatal error" while reconcile still passed. The script only printed a few log
lines, and the next run recreated the container, which deleted its log. So `slow-sink.sh` was changed to save the
full log and print every fatal error with its stack. The re-run reproduced it.

## Root cause

D-021 split errors into "unavailable" (retry forever) and "rejected" (3 tries, then stop), and put **every**
HTTP 4xx in the second group. But **408 Request Timeout** means "the server gave up waiting for your request: send it
again". Requests that were in flight when Meilisearch was frozen get exactly that answer when it wakes up. Treating
it as "your document is invalid" stopped Driftless for no reason.

## Fix

`isTransient()` now counts 408 as retryable, alongside 429 and 5xx. A unit test scripts a 408 into the "keeps
retrying while Meilisearch is unreachable or overloaded" case.

## Proof

The same 5-minute run after the fix: **0 fatal errors**, 0 drift (`docs/RESULTS.md` §6).

## Why it didn't lose data anyway

Fail-stop (D-009) means a crash never confirms past an unapplied change. Docker's restart policy brought the
connector back (T05), and Postgres re-sent everything after the last confirmed position (T03). The bug cost a
restart, not correctness. That's exactly why the design treats "stop and resume" as the safe default.
