# Task 2 — Source database & write workload, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 2

1. Defined the **`products` table**, the data the search index must mirror. It's created
   automatically whenever the database starts empty.
2. Wrote a **seed script** that fills it with 100,000 realistic rows in about 2 seconds, and the
   *same* rows every time.
3. Wrote a **write workload**: pgbench scripts that update, insert and delete random products at a
   fixed rate, run through one runner script.
4. **Proved the tricky case exists.** An update that doesn't touch a big description makes logical
   decoding say "unchanged" instead of sending the description. Driftless must handle this in Task 4.

---

## 1. Why a demo table at all

Driftless copies changes, so it needs something to copy and something that keeps changing. The data
should look real: mostly small values with some big ones, and a steady mix of inserts, updates and
deletes. Every later task (reading the WAL, the sink, chaos tests, benchmarks) runs against this table
and this workload.

---

## 2. The `products` table, column by column

| Column | Type | Why this type |
|---|---|---|
| `id` | `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` | unique row id, numbered by Postgres |
| `sku` | `text NOT NULL UNIQUE` | the shop's product code; no two products share one |
| `name` | `text NOT NULL` | what people search for |
| `description` | `text` (storage EXTERNAL) | sometimes big; drives the TOAST case (section 3) |
| `category` | `text NOT NULL` | e.g. `electronics`; useful later as a search filter |
| `price_cents` | `integer NOT NULL CHECK (>= 0)` | money as whole cents |
| `stock` | `integer NOT NULL CHECK (>= 0)` | items left |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | when the row last changed |

**Primary key.** A column whose value is unique and never null, and which identifies one row. It does
two jobs for Driftless:
1. It becomes the **document id** in Meilisearch, so row 42 ↔ document 42.
2. Logical replication uses it to say *which* row an UPDATE or DELETE touched (the "replica identity").
   Without one, Postgres refuses UPDATE/DELETE on a table that's in a publication.

**`IDENTITY` vs `serial`.** Both number rows automatically. `GENERATED ALWAYS AS IDENTITY` is the SQL
standard way. "ALWAYS" means an app can't accidentally insert its own id; Postgres raises an error
instead. `serial` is the older Postgres-only shorthand with looser rules.

**`bigint` vs `integer`.** `integer` stops at 2,147,483,647 (about 2.1 billion). Busy tables do reach
that, and changing a primary key's type later rewrites the whole table. `bigint` costs 4 extra bytes a row.

**`text`.** In Postgres, `text` and `varchar(n)` are stored identically; `varchar(n)` only adds a length
check. We don't need one.

**`NOT NULL` / `UNIQUE` / `CHECK`.** Rules the *database* enforces, so no app bug can store a product
without a name or with a negative price. `UNIQUE` also creates an index (`products_sku_key`).

**Money as integer cents.** Never store money as floating point: in floats `0.1 + 0.2` is
`0.30000000000000004`, and those errors pile up in sums. Whole numbers of cents (or paise) are exact.

**`timestamptz`.** Stores an exact instant (kept as UTC) and displays it in your session's time zone.
Plain `timestamp` is just a wall-clock reading with no zone, which is ambiguous. **`now()`** is the
start time of the *transaction*, not the moment each row is written. That's why all 100,000 seeded rows
share one `updated_at`: one INSERT statement is one transaction. You can see it in the decode output in
section 3.

---

## 3. TOAST: where big values go, and why Driftless cares

Postgres stores rows in **8 KB pages**, and a row must fit inside one page. When a row grows beyond
about **2 KB**, Postgres moves its big column values into a side table, the **TOAST** table ("The
Oversized-Attribute Storage Technique"), and leaves a small pointer in the row.

Each column has a **storage mode**:

| Mode | Compress? | Move out of the row? | Typical for |
|---|---|---|---|
| PLAIN | no | no | fixed-size types (`integer`, `bigint`, `timestamptz`) |
| MAIN | yes | only as a last resort | rarely used |
| EXTENDED | yes, first | yes | the default for `text` |
| EXTERNAL | **no** | **yes** | our `description` |

We set `description` to EXTERNAL so a description over about 2 KB is *always* moved out of the row
(compression can't shrink it back under the limit). That makes the TOAST case predictable. Verified:
`description=e` in `pg_attribute`, plus 5,132 big descriptions and a 13 MB TOAST table.

**Why it matters.** When you UPDATE a row but don't change a TOASTed column, Postgres keeps the old
pointer and does **not** write the big value into the WAL again (that would waste space). So logical
decoding has no value to send for that column. It sends a marker meaning "unchanged".

**Proof from this task.** Two price-only updates, decoded by Postgres's demo decoder `test_decoding`
(long lines shortened):

```
BEGIN 6840
table public.products: UPDATE: id[bigint]:10 … description[text]:unchanged-toast-datum … price_cents[integer]:37415 …
COMMIT 6840
BEGIN 6841
table public.products: UPDATE: id[bigint]:1 … description[text]:'Reliable everyday product, model 1.' … price_cents[integer]:18951 …
COMMIT 6841
```

Row 10 has a 2.5 KB description, so it came out as `unchanged-toast-datum`. Row 1's description is
short and lives inside the row, so it was sent in full.

**What this means for Task 4.** If Driftless turned "unchanged" into `description: null`, a product's
description would vanish from search after every price change. The fix: leave unchanged columns out of
the update and use Meilisearch's *merge* update (`updateDocuments`), which keeps fields you don't send.
The workload makes this happen constantly: 60% of all writes are price-only updates.

**How we looked inside.** We used a **temporary** replication slot (created with
`pg_create_logical_replication_slot(…, 'test_decoding', true)`). The `true` makes it temporary:
Postgres deletes it automatically when the session ends. We still checked that 0 slots remained
afterwards, because a forgotten slot makes Postgres keep WAL forever.

---

## 4. How the table gets created: Docker init scripts

The postgres image runs every `.sql` or `.sh` file in `/docker-entrypoint-initdb.d/`, but **only when
its data directory is empty**, i.e. on the very first start. We mount our `db/init/` folder there.

That's why we ran `docker compose down -v` once. The volume from Task 1 already existed (empty but
initialised), so the script would never have run. Before wiping we checked there was nothing to lose:
0 tables in Postgres and 0 indexes in Meilisearch. After the restart the log showed
`running /docker-entrypoint-initdb.d/01-schema.sql`.

A **bind mount** (`./db:/db:ro`) makes the host folder `db/` appear inside the container at `/db`.
`:ro` means read-only, so the container can't change your files. You edit on Windows and the container
sees the change instantly.

---

## 5. The seed script, piece by piece

- **`generate_series(1, :rows)`** is a *set-returning function*: it produces rows 1…N, like a for-loop in
  SQL. A single `INSERT … SELECT` creates all rows in one statement. That's why 100,000 rows took 1.9 s
  instead of minutes of separate INSERTs.
- **psql variables.** `-v rows=100000` sets `:rows`. `\if :{?rows}` checks whether it was given, and if
  not the script defaults to 100,000. `\set ON_ERROR_STOP on` makes psql stop at the first error with a
  failing exit code (by default psql carries on after errors).
- **Random picks.** `(ARRAY['Swift', …])[1 + floor(random() * 16)::int]` picks one of 16 words. Postgres
  arrays start at index **1**, hence the `1 +`.
- **`setseed(0.42)`.** `random()` normally gives different numbers every run. `setseed` fixes the starting
  point so the "random" sequence repeats exactly. Verified: two runs gave the identical checksum
  `d88a27ea…`. This keeps benchmark numbers comparable (D-016).
- **5% big descriptions.** `CASE WHEN random() < 0.05 THEN <2.5 KB of random hex> ELSE <short text> END`.
- **A subtle trap we avoided.** A subquery that doesn't mention the outer row gets computed **once** and
  reused for every row (Postgres calls it an *InitPlan*). All 5,000 big descriptions would have been
  identical. Ours mentions `g`, the outer row number, so it runs for each row.
- **`TRUNCATE products RESTART IDENTITY`** empties the table instantly (no row-by-row delete) and resets
  the id counter to 1, so the seed can be re-run any time. *For Task 3:* TRUNCATE also travels through
  logical replication, so Driftless must decide what to do with it (now noted in the plan's T03 pitfalls).
- **`ANALYZE`** refreshes the statistics the query planner uses to pick fast plans. They're stale after
  a bulk load.

Result: 100,000 rows, 5,132 big descriptions (5.1%), 13 MB table + 13 MB TOAST.

---

## 6. The workload: pgbench

**pgbench** is Postgres's built-in benchmarking tool. By default it runs its own bank-style test; we
give it our own scripts instead.

- **One script = one transaction.** `\set id random(1, :maxid)` is evaluated by pgbench itself, which
  then sends the SQL with the number filled in.
- **Weights.** `update_price.sql@6`, `update_desc.sql@2`, `insert.sql@1`, `delete.sql@1` → 60 / 20 / 10 / 10 %.
- **Why that mix.** Shops mostly change prices and stock. Those updates leave big descriptions untouched,
  so the unchanged-TOAST case happens all the time, not only in one special test.
- **A fixed rate (`--rate=200`).** pgbench starts 200 transactions per second at random moments (like real
  traffic) instead of going flat out. Later we measure Driftless's *lag at a known load*. A flat-out run
  measures the database instead and changes with the machine. "Schedule lag" in the output is how late
  pgbench started transactions compared with its plan: 2.1 ms on average here, with spikes up to 261 ms
  from Docker on Windows.
- **`--client=4 --jobs=4`**: 4 concurrent connections, each in its own thread.
- **`-n`**: skip the vacuum pgbench normally runs on its own tables (which don't exist here, so it would error).
- **`--define=maxid=…`** passes a variable into the scripts. The runner reads `max(id)` from the table itself.

**Why a runner script (`scripts/workload.sh`).** The mix is defined in exactly one place (D-016), so every
test and benchmark uses the same load. It also sets `MSYS_NO_PATHCONV` (section 7) and refuses to run on an
empty table.

**Results of the 30-second run:**

| | |
|---|---|
| transactions | 6,096 (203 per second), 0 failed |
| mix | 60.2% / 19.9% / 9.6% / 10.2%, matching the weights |
| latency | 4.4 ms average |
| row count | 100,000 + 587 inserts − 622 deletes = **99,965**, exactly what the table showed |

Every delete hit a real row this time. As more rows get deleted, some deletes will pick an id that's
already gone: 0 rows affected, still counted as a transaction. Known limitation: rows inserted *during* a
run are never picked for updates in that run, because ids are chosen up to the `max(id)` read at the start.
That's fine for our purposes.

---

## 7. What went wrong: Git Bash rewrites paths

Git Bash tries to be helpful. When you pass an argument that looks like a Unix path (`/db`) to a Windows
program (`docker.exe`), it converts it into a Windows path: `/db` → `C:/CODE/Git/db` (your Git lives in
`C:\CODE\Git`). The container then looks for a folder that doesn't exist:

```
ls: cannot access 'C:/CODE/Git/db': No such file or directory
```

**Fix:** put `MSYS_NO_PATHCONV=1` in front of the command to switch the conversion off. The runner script
sets it itself. PowerShell, cmd, Linux and macOS don't do this. Recorded in CONSTRAINTS rule 13, because AI
sessions here run commands through Git Bash too.

A smaller one: a query `attname || '=' || attstorage` failed with
`operator is not unique: text || "char"`. `attstorage` uses Postgres's internal one-byte type `"char"`
(quotes included, not the same as `char(n)`), and `||` couldn't decide how to join it to text. Casting
with `attstorage::text` fixed it. System-catalog columns often use special internal types like this.

---

## 8. If an interviewer asks…

- **"Why integer cents for money?"** Floating point can't represent most decimal fractions exactly, so sums
  drift (`0.1 + 0.2 ≠ 0.3`). Integers are exact.
- **"What is TOAST and why does it matter for CDC?"** Big values are stored outside the row. An update that
  doesn't change them doesn't log them again, so a change-data-capture consumer gets "unchanged" instead of
  a value. It must merge the update into the existing document, not overwrite it.
- **"Why benchmark at a fixed rate instead of max throughput?"** Lag only means something at a known, steady
  load. A max-throughput run measures the database, not the connector, and varies with the machine.
- **"Why is the seed deterministic?"** Identical data across runs keeps results comparable and makes bugs
  reproducible.

---

## Glossary

- **Primary key**: the column that uniquely identifies a row (`id`).
- **Identity column**: a column Postgres numbers automatically (`GENERATED ALWAYS AS IDENTITY`).
- **Replica identity**: what logical replication uses to identify the changed row; by default the primary key.
- **TOAST**: Postgres's side storage for big column values.
- **Storage mode**: per-column rule for compressing / moving big values (PLAIN, MAIN, EXTENDED, EXTERNAL).
- **Init script**: SQL the postgres image runs on first start, from `/docker-entrypoint-initdb.d/`.
- **Bind mount**: a host folder made visible inside a container.
- **`generate_series`**: a function producing a series of rows, like a loop.
- **`setseed`**: fixes the starting point of `random()` so results repeat.
- **InitPlan**: a subquery Postgres computes once and reuses (the trap in section 5).
- **`ANALYZE`**: refreshes the query planner's statistics.
- **`TRUNCATE`**: empties a table instantly.
- **pgbench / tps**: Postgres's benchmark tool / transactions per second.
- **Schedule lag**: how late pgbench started transactions compared with its fixed-rate plan.
- **`test_decoding`**: Postgres's demo logical-decoding plugin with readable text output.
- **Temporary slot**: a replication slot that Postgres deletes when the session ends.
- **MSYS path conversion**: Git Bash rewriting Unix-looking arguments into Windows paths.
