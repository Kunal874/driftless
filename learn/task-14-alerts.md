# Task 14 — Alerts, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 14

Since Task 9, Driftless has had metrics and a dashboard. But a dashboard only helps someone who is looking at it. Task 14
adds **alerts**: rules that watch the metrics and fire when something needs a person. There are five of them, in one file
anyone can drop into their own Prometheus. Each one is unit-tested and was made to fire on the real stack.

---

## 1. What an alert rule is

Prometheus (Task 9) scrapes `GET /metrics` every 5 seconds and keeps the numbers as time series. An **alert rule** is a
query Prometheus runs on a timer (here every 15 s, `evaluation_interval`). If the query returns anything, the alert is
**pending**. If it keeps returning something for the rule's `for:` time, the alert is **firing**. When the query
returns nothing again, the alert goes back to **inactive**.

`for:` stops a blip from paging anyone. A connector restart takes a few seconds, and nobody needs a pager for that. A
connector that's been gone for 2 minutes is a different story.

Prometheus only *decides* that an alert fires. Sending it somewhere (Slack, email, a pager) is a separate program,
**Alertmanager**. We don't ship one, because where alerts go is part of each team's own setup. Prometheus lists them at
`http://127.0.0.1:9090/alerts`, and the dashboard's new top panel shows them.

## 2. The five alerts, and why each exists

| Alert | Fires when | Why it matters |
|---|---|---|
| `DriftlessDown` | Prometheus can't scrape Driftless for 2 min | search goes stale and the slot starts holding WAL |
| `DriftlessStalled` | transactions are waiting, nothing applied for ~5 min | a sink is down; Driftless retries forever (D-021), so it never crashes, and without this alert nobody would know |
| `DriftlessLagHigh` | lag p99 > 60 s for 10 min | search is running but far behind |
| `DriftlessSlotWalHigh` | the slot holds > 50 % of its WAL cap for 5 min | early warning |
| `DriftlessSlotWalCritical` | > 80 % for 1 min | the slot is about to be invalidated, which costs a full backfill (D-026) |

## 3. The blind spot: a dead connector can't report itself

The metric `driftless_slot_retained_wal_bytes` is measured by Driftless itself: it asks Postgres on every scrape. So
when Driftless is **dead**, which is exactly when WAL piles up, that metric is gone. An alert on it alone would stay
silent at the worst moment.

The fix is Prometheus's own `up` series. Prometheus writes `up = 1` for every successful scrape and `up = 0` for every
failed one, so `up{job="driftless"} == 0` works even when Driftless is dead.

**Rejected:** running postgres_exporter, a separate program that would watch the slot from outside. It's another
service to run, and "down for 2 minutes" plus the WAL cap (Task 8) already cover the case.

## 4. Share of the cap, not a byte count

The obvious rule is "alert when the slot holds more than 500 MB". But that's only right for our 1 GB cap. Someone with a
50 GB cap would get paged at 1 %, and someone with a 256 MB cap never.

Postgres reports a second number per slot, `safe_wal_size`: how much more WAL it may write before it invalidates the
slot. Task 14 exports it as `driftless_slot_safe_wal_bytes`. Then:

```
share of the cap = retained / (retained + safe)
```

That's correct for any cap, so one rule file fits everyone. We measured how exact it is: `retained + safe` came out
~10–11 MB *more* than the cap (Postgres counts from the start of a 16 MB WAL segment), so the share reads 1–4 % low.
That's harmless next to the 80 % → 100 % margin.

Without any cap, `safe_wal_size` is NULL, so the share is NaN and those alerts can never fire. That setup is also the
dangerous one (the disk fills), so Driftless now **warns at startup** when `max_slot_wal_keep_size` is unlimited.

## 5. A subtle bug avoided: `and` vs `unless`

The stall rule says "transactions in flight, and nothing applied lately". The natural way to write it:

```
driftless_txns_in_flight > 0  and  rate(applied[2m]) == 0
```

But `driftless_changes_applied_total` has labels (`op`, `table`), and a labelled counter has **no series at all**
until its first increment. Picture a sink that's down when Driftless restarts: nothing has been applied since the
restart, so the counter doesn't exist. `and` with nothing gives nothing, and the alert stays silent in exactly the
case it's for.

The rule is written the other way around:

```
driftless_txns_in_flight > 0  unless  rate(applied[2m]) > 0
```

"Waiting, unless we can see changes being applied." No series means nothing to suppress it, so it fires.

## 6. Testing alert rules: `promtool test rules`

Prometheus ships a tool, `promtool`, that runs rules against **made-up time series** and checks which alerts fire at
which time. `docker/prometheus/alerts.test.yml` has a case per alert: one series that should fire, one healthy series
that shouldn't, plus the edge cases (no traffic → no lag alert; idle → no stall alert; restarted with no counter →
stall alert; no cap → no slot alert).

**Testing the test:** we changed `unless` to `and` in a copy and ran the tests again. The restart case failed, as it
should. A test that passes with the bug in it proves nothing.

**What promtool is strict about:** it compares *annotations* (the alert's text) exactly. So each alert has one short
templated `summary` instead of a long description.

CI runs `promtool check config` and `promtool test rules` from the Prometheus image we already pin, so nothing new is
installed.

## 7. Proving it live: `scripts/alert-drill.sh`

Unit tests use made-up numbers. The drill breaks the real stack and watches Prometheus:

- `down`: SIGKILL the connector → **firing after 2 min 30 s** → restart → resolved 10 s later.
- `stalled 200`: freeze Meilisearch (`docker pause`) under 200 tx/s → **firing after 5 min 26 s** → unfreeze →
  resolved 31 s later → reconcile: 0 drift.
- `slot 50`: lower the cap, freeze Meilisearch, then **fill the slot's WAL in controlled steps** to ~60 % (warning fires
  5 min later) and ~85 % (critical fires about a minute later). The drill never reaches 100 %, because that would
  really lose the slot. Then unfreeze, wait for both alerts to resolve, reconcile, and put the cap back.

**How do you fill WAL on purpose without touching data?** `pg_logical_emit_message(false, 'prefix', 4 MB of text)`
writes a "logical message" record into the WAL. It's real WAL, so the slot must keep it. But pgoutput only sends
messages to subscribers that ask for them, and Driftless doesn't, so the connector never even sees it. Each step adds
exactly the WAL we want.

## 8. What broke, and how it was fixed

**1. `ALTER SYSTEM` no longer changes the cap.** In Task 8 we lowered the cap with `ALTER SYSTEM SET
max_slot_wal_keep_size`. Since then the cap lives on Postgres's command line (`-c max_slot_wal_keep_size=1GB` in
compose), and a command-line setting **beats** `ALTER SYSTEM`. So the compose file now reads it from a variable,
`PG_MAX_SLOT_WAL_KEEP_SIZE` (default `1GB`), and the drill recreates Postgres with `256MB`.

**2. Compose quietly undid the 256 MB cap.** The first slot run logged `cap 1GB`. The drill had recreated Postgres with
256 MB, then run `docker compose up -d connector`. Compose checks a service's dependencies too. It saw that the running
Postgres didn't match the compose file as it read it then (no variable set → 1 GB), so it **recreated Postgres** with
1 GB. Fix: `--no-deps` (start only the connector), plus a check that stops the drill if the cap isn't 256 MB. The run
wasn't wasted: it proved the alerts at the shipped 1 GB cap. The rerun proved 256 MB, and with it the "any cap" claim.

**3. Not a bug, but a measured margin.** With Meilisearch frozen at 50 tx/s, the WAL kept growing ~3 % of a 256 MB cap
per minute. During the minute the critical alert waits (`for: 1m`), the share went from 87 % to 90 %. A small cap
under a heavy write load could go from 80 % to 100 % faster than that. The README and FLOW now say: size the cap so 20 %
of it covers more than a few minutes of your WAL.

## 9. Words used in this task

- **Alert rule:** a query Prometheus evaluates on a timer; results become alerts.
- **Pending / firing / inactive:** the condition holds but `for:` hasn't passed yet / it has / it doesn't hold.
- **`up`:** a series Prometheus writes itself for every scrape target: 1 = the scrape worked, 0 = it didn't.
- **`safe_wal_size`:** Postgres's own count of how much more WAL a slot can fall behind before it's invalidated.
- **promtool:** Prometheus's command-line tool; `test rules` runs alert rules against synthetic series.
- **Logical message:** a WAL record written with `pg_logical_emit_message`; logical decoding delivers it only to
  subscribers that ask for messages.
