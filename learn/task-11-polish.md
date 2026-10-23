# Task 11 — Polish after release, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 11

After v0.1.0 was published, the owner asked to make the project better "in every possible way". That's unbounded,
so the first step was a plan (BUILD_PLAN → T11) that keeps only what adds real value:
1. A **fresh-eyes review** of the core code against the invariants.
2. **CI**: every push type-checks, runs the unit tests, *and* runs a real crash test.
3. A README that **shows** (a CI badge, a dashboard screenshot from a real chaos run).
4. Checking whether **BUG-001** should be reported upstream. It turned out upstream had fixed it already, which
   exposed a real risk in our own dependency range.

The stretch goals (a Redis sink, multiple tables…) stayed cut: they're new features, not polish, and each would need
its own plan.

---

## 1. The review: invariants that hold "by luck" vs "by construction"

Reading `main.ts` again found no bug, but one place where an invariant held only because of how the code happened to
be called.

`confirm(end)` promises the confirmed position **never moves backwards**. It did this:

```ts
if (end <= confirmed) return;           // check
if (await sendStatus(end)) confirmed = end;  // ... await ... then update
```

The library writes the status message to the socket **synchronously** (its `acknowledge` is `async` but contains no
`await`), so the message is on the wire *before* `confirmed` is updated. A second `confirm(smaller)` arriving in that
gap would pass the check and send a *lower* position after the higher one. Today no caller can do that (heartbeat
confirms need nothing in flight, and checkpointer ends only grow), but that's an accident of the callers, not a
property of the function. The fix moves the update before the `await`:

```ts
if (end <= confirmed) return;
confirmed = end;      // check and update with no await in between: no other code can run in the gap
await sendStatus(end);
```

The lesson: in single-threaded JavaScript, **code between two `await`s runs atomically**. If a check and the update
it protects are both before the first `await`, nothing can interleave. Put an `await` between them and you have a race,
even without threads.

## 2. Upstream had already fixed BUG-001, and that was a risk for us

Before drafting an issue for `pg-logical-replication`, we searched its tracker. PR **#222** ("preserve WAL end
positions in standby acknowledgements") had been merged on 2026-10-14 and released in **2.6.0**. Someone else had
hit the same `+ 1`, from a PostgreSQL 18 failover problem.

That's good news (independent confirmation of our root cause). It also exposed a trap in our own repo:
- Driftless sends `end − 1` *because* 2.5.0 adds 1.
- `package.json` said `"^2.5.0"`, and the caret allows **2.6.0**, which doesn't add 1.
- The lockfile kept us on 2.5.0, but an upgrade (`npm update`, or a lockfile regenerated one day) would have changed
  our confirm positions silently.

Two fixes:
1. **Pin exactly** (`"2.5.0"`). If your code compensates for a library's quirk, you depend on that exact behavior.
2. **A contract test** (`src/source/ack-contract.test.ts`) that checks the bytes the library actually sends:
   `acknowledge('0/9D68A47')` must write `0/9D68A48`. After an upgrade it fails, and its comment names the one line to
   change. A test like this guards *someone else's* code: it fails when an assumption about a dependency stops
   being true.

## 3. CI that proves the claim on every push

`.github/workflows/ci.yml` has two jobs:
- **unit:** `npm ci`, `npm run typecheck`, `npm test` (seconds).
- **e2e** (after unit passes): `scripts/ci-e2e.sh`, the real stack on the GitHub runner: Postgres + Meilisearch,
  20,000 seeded rows, Driftless started (it sees an empty index and backfills by itself), then `chaos.sh`
  (2 minutes of writes at 200 tx/s with a SIGKILL about every 10 s), a full reconcile that must find 0 drift, and the
  reconcile self-test (plant drift, demand it's found).

The main claim, "0 drift under crashes", is now re-proven automatically, not just once on one laptop. Locally, in its
own compose project, the script took 145 s: backfill of 20,000 rows in 1.4 s, 24,060 transactions with 10 SIGKILLs,
reconcile 20,116 = 20,116, 0 drift, self-test passed. (The first run on GitHub happens on the next push.)

Design choices:
- **The steps live in a script, not in YAML.** `scripts/ci-e2e.sh` runs locally too, so CI can be debugged without
  pushing.
- **A guard:** the script re-seeds the table, so outside CI (`CI=true` is set by GitHub) it refuses the default compose
  project and asks for `COMPOSE_PROJECT_NAME=driftless-ci`. A test script must never be able to wipe a developer's data
  by accident.
- **On failure** the workflow prints the connector's last 300 log lines, the first thing you'd want.
- `permissions: contents: read`: the workflow token can't write to the repo.

## 4. A README that shows: the dashboard screenshot

`docs/images/dashboard-chaos.png` is a real Grafana render during `chaos.sh 240 30 300` (7 kills, 0 drift afterwards).
It was rendered by **headless Edge** (`--headless=new --screenshot --window-size=1600,1460 --virtual-time-budget=15000`),
with a throwaway profile directory, so it never touches anyone's browser profile. The virtual time budget lets
Grafana's JavaScript run its queries before the picture is taken.

### Small things that went wrong on the way

- **Windows' path limit again.** Edge silently produced no file when its profile folder sat in a very long temp path.
  A short temp folder fixed it, and the folder was deleted afterwards.
- **A flag that made the screenshot flaky.** Two attempts with `--hide-scrollbars` wrote nothing, and the same command
  without it worked. When a tool fails silently, change one thing at a time and print its output.
- **A number I couldn't explain stayed out of the caption.** Grafana's "Restarts" panel showed 8 where the script
  counted 7 kills, probably a connector start just inside the time window. The caption describes what the picture
  shows without quoting that count. A README number must be one you can defend.

## 5. Things worth knowing

- **Contract test**: a test about a dependency's behavior that your code relies on.
- **Pinning**: `"2.5.0"` = exactly that version; `"^2.5.0"` = any 2.x ≥ 2.5.0.
- **Atomic between awaits**: JavaScript runs one piece of code at a time; other code can only run where you `await`.
- **CI (continuous integration)**: every push is built and tested automatically by a server.
