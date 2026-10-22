# Task 10 — Config, packaging and the README, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 10

Turned a working project into something **another person can run from the README**:
1. A **config file** that says what to sync where, validated before anything happens.
2. A **Docker image** for the connector, used by the compose stack and every test script.
3. The **README**, every number taken from `docs/RESULTS.md`.
4. A **final docs pass**, and a test that follows the README from a brand-new clone.

---

## 1. The config file

`driftless.config.json` holds the *what and where*: the Postgres connection, which table goes to which index, the
primary key, and optionally which columns become document fields:

```json
"sync": { "table": "public.products", "index": "products", "primaryKey": "id", "columns": { "exclude": ["description"] } }
```

**Why JSON?** Node reads it with no dependency (`JSON.parse`). YAML would need a library, and a config this small
doesn't need comments badly enough to justify one.

**Why not put everything in it?** Three kinds of setting, three homes:

| Kind | Where | Why |
|---|---|---|
| What/where (table, index, columns, hosts) | the file | describes *this deployment*; worth keeping in git |
| Secrets (passwords, API keys) | env only (`PGPASSWORD`, `MEILI_MASTER_KEY`) | a file gets committed, copied and pasted; env vars don't |
| Tuning (`DRIFTLESS_LANES`, …) | env | changed per run by the benchmark scripts |

Env vars also **override** the file's connection settings (`PGHOST`, `MEILI_HOST`, …). That's how the same image
connects to `postgres:5432` inside Docker and `127.0.0.1:5440` on the host.

### Validation: fail at start, say exactly what's wrong

`parseConfig` (in `src/config-file.ts`, a pure function, unit-tested) checks everything and **reports every problem at
once**. Fixing one typo per restart is miserable. Real output:

```
driftless: invalid config:
  - postgres.password: secrets don't belong in the config file; set PGPASSWORD instead
  - postgres.port must be a whole number from 1 to 65535
  - meilisearch.host '127.0.0.1:7700' must be an http:// or https:// URL
  - sync.colums: unknown setting (expected: table, index, primaryKey, columns)
  - sync.table 'products' must be schema.table in lower case, e.g. public.products
```

Two details that matter:
- **Unknown keys are errors.** Otherwise `"colums"` (a typo) would be silently ignored, and every column would be
  indexed without anyone noticing.
- **A config mistake isn't a crash.** It prints one message and exits with code 2, with no stack trace. A stack trace
  tells the reader "the program is broken"; this message says "your file is".

### Checking the config against reality, before creating anything

Some mistakes only show against the real database: a `primaryKey` that isn't the table's key, or a column name that
doesn't exist. `checkSync` asks Postgres's catalog (`pg_attribute`, `pg_index`) and fails with a list of the table's
real columns.

**Something that went wrong: the order of startup checks.** Testing a wrong primary key showed that `ensureIndex` ran
*before* the Postgres check. With a new index name, Driftless would have **created the index with the wrong primary
key** and only then complained, leaving junk behind. Fix: check the config against Postgres first, then touch
Meilisearch, then create the slot. The rule: **validate everything before creating anything**, because creating is
the part that needs cleaning up.

## 2. Column filtering, and proving it

The filter is applied in `toDocument`, the one function that turns a row into a document. The sink, the backfill and
reconcile all go through it, so they can't disagree about what a document should contain.

**The live test.** A second config, `index: "products_t10"` with `description` excluded, run against the real table:
- **Backfill path:** 274,776 rows copied in 75 s.
- **Streaming path:** 272 updates changing description + price, 289 updates changing *only* the excluded column,
  3 inserts.
- **Result:** reconcile with the same config: 0 drift. No document has a `description` field, and a search for text
  that only appears in descriptions finds 0 hits.

**The side effect, and the repair.** Both configs share one replication slot, so while the test ran, those 564
changes went to the test index, *not* the real one. Reconcile on the real index then reported exactly **564**
(561 mismatched + 3 missing), which is a nice check of the checker itself. The test deliberately had no deletes, so a
fresh backfill could repair it, and it did: 274,779 rows, 0 drift.

## 3. The Docker image

```dockerfile
FROM node:24.18.0-alpine
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY driftless.config.json ./
USER node
CMD ["node", "src/main.ts"]
```

- **No build step.** Node 24 runs `.ts` files directly by stripping the types, so there's no `dist/` folder to keep in
  sync.
- **Layer order = cache.** Dependencies are copied and installed *before* the source. Editing `src/` reuses the cached
  install layer, and rebuilds take about a second.
- **`npm ci --omit=dev`:** exactly the lockfile's versions, without TypeScript, Vitest and type packages. 244 MB image.
- **`USER node`:** the official image has an unprivileged user. Nothing in Driftless needs root, so it doesn't get it.
- **`.dockerignore` as an allow-list.** Start from `*` (exclude everything), then allow the four things the Dockerfile
  copies. A deny-list can forget `.env` one day; an allow-list can't leak what it never lists.

**The stale-image trap.** Before Task 10, the compose connector mounted the repo, so it always ran the current code.
An image is a snapshot: change `src/` and `docker compose up` happily runs the *old* build. So every test script now
runs `docker compose build -q connector` first. A chaos test that tests yesterday's code proves nothing.

## 4. The README, and testing it like a stranger

Rules for the README: every number links to the RESULTS section it came from, one shell command per code block, and
limitations stated plainly. A README that oversells is the first thing an interviewer probes.

**The fresh-clone test** follows the quick start literally in a new clone: `npm ci`, `compose up`, seed, start the
connector, workload, reconcile, search, metrics, `npm test`. Everything passed: a 100,000-row backfill in 5.9 s, 0 drift,
52/52 tests. Two traps on the way:

- **`name: driftless` in `docker-compose.yml` fixes the compose project name**, whatever the folder is called. A
  second clone on the same machine would have *reused the real volumes*, the real data. For the test,
  `COMPOSE_PROJECT_NAME=driftless-fresh` (which wins over the file) gave it its own volumes. A new user on a new
  machine never hits this, but a developer with two checkouts would.
- **Windows' 260-character path limit.** The first clone, inside a deeply nested temp folder, failed with "Filename
  too long". The clone moved to a short path.

## 5. The final docs pass

Comparing the docs with the code found real drift *in the docs*:
- ARCHITECTURE's diagram still said **"batch: 500 docs / 50 ms"**, the plan from Task 1. The code has done
  natural batching up to 5,000 with *no timer* since Task 6.
- An invariant mentioned a Redis cache that was a stretch goal and never built.
- Flow 2 was still marked "in progress, verified for the printing connector", although three chaos campaigns had
  proven it since.

Docs rot exactly like code does, but no test catches it. That's why reading them against the code is a release step.

## 6. If an interviewer asks…

- **"How do you handle configuration?"** A file for what and where, env vars for secrets and per-run tuning, env
  overriding the file. Validated completely at start, with every error at once. Unknown keys rejected. Then checked
  against the real database before anything is created.
- **"Why validate before creating anything?"** Creation has side effects that need cleanup: an index with the wrong
  primary key, a replication slot that starts holding WAL. I found this order bug in my own startup code while testing.
- **"What's in your Docker image, and why?"** Runtime dependencies plus source, no build step, non-root, an allow-list
  build context. And the scripts rebuild before every test so they never run a stale image.
- **"How do you know your README works?"** I followed it in a fresh clone with its own compose project, end to end,
  including the tests.

---

## Glossary

- **Config validation**: checking a configuration completely before using it; *fail fast* with precise messages.
- **Exit code**: the number a process returns; 0 = success. Driftless uses 1 for crashes and 2 for config mistakes.
- **Docker layer cache**: each Dockerfile step is a cached layer; a step re-runs only if it or an earlier step changed.
- **`.dockerignore`**: what's left out of the build context (the files sent to Docker for building).
- **Allow-list vs deny-list**: list what's permitted (safe by default) vs what's forbidden (unsafe by default).
- **Compose project name**: the prefix of a stack's containers and volumes; same name = same volumes.
- **MAX_PATH**: Windows' classic 260-character limit on file paths.
