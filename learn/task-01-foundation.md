# Task 1 — Foundation, explained

> One file per finished task. Each explains, in plain language, everything that was done and
> *why*: every tool, every setting, every decision, and what went wrong along the way.

## What we did in Task 1

1. Created the project folder and a **git** repository, with two safety files and a **hook**
   that keeps you the only author.
2. Started **PostgreSQL** and **Meilisearch** in **Docker**, with Postgres set up to record the
   extra detail Driftless needs (`wal_level=logical`).
3. Wrote the project docs: the map, the rules, the decisions, the checklists, the recovery guide.
4. Wrote the **build plan** (10 tasks, every step a checkbox) and the **agent file**, so any
   session can continue where the last one stopped.

There's no application code yet. Task 1 is the ground everything else stands on.

---

## 1. The project in one minute

Your app keeps products in Postgres. Typo-tolerant search ("iphon" → iPhone) needs a search
engine, so the products are also copied into Meilisearch. Now there are two copies. If the app
writes to both itself, a crash between the two writes, or two quick edits arriving in the wrong
order, leaves them disagreeing forever. Driftless instead reads Postgres's own diary of changes
(the WAL) and copies each change over, in order, remembering how far it has got.

---

## 2. Git — save points for your code

**What it is.** Git records snapshots of your project. Each snapshot is a **commit**: the files
at that moment, a message saying what changed, and who made it (the **author**).

**Why one commit per step.** Every step in the plan (`T01.1`, `T01.2`, …) becomes one commit, so
every step is a save point. If step T04.3 breaks everything, you can go back to the state right
after T04.2 (`docs/ROLLBACK.md` has the commands). Task 1's commits:

```
T01.1: initialize repository with LF line endings and single-author commit hook
T01.2: add local dev stack (Postgres 17.11 with logical WAL, Meilisearch 1.54.3)
T01.3: add project docs (architecture, flows, decisions, constraints, checklist, rollback)
T01.4: add step-by-step build plan, agent instructions and handover
T01.5: checkpoint T01 (this explanation, final handover)
```

**Tags.** A tag is a name stuck on one commit. When a whole task is finished and its checks pass,
we tag it, e.g. `checkpoint/T01`. That marks it "known good".

**Branch.** A branch is a line of commits. We use one, `main`. Feature branches stop team members
stepping on each other; for a solo project they're extra ceremony (decision D-014).

### Who the "author" is, and why it's only you

Every commit stores an author name and email from your git settings (`user.name`, `user.email`).
Yours were already set globally to `Kunal <kunalchandrakar2005@gmail.com>`, so every commit is yours.

GitHub links a commit to an account through that email; that's how it builds the **Contributors**
list. AI tools can append a line such as `Co-Authored-By: Claude <…>` to a commit message (a
**trailer**). GitHub reads trailers and credits the co-author too, which is how an AI account ends up
listed as a contributor. Driftless commits never contain such lines.

> **Do this once:** make sure `kunalchandrakar2005@gmail.com` is added to your GitHub account
> (Settings → Emails). Otherwise GitHub can't link these commits to your profile.

### The commit-msg hook: a rule that enforces itself

A sentence in a doc saying "don't add co-author lines" is only a request. A **git hook** is a small
script git runs automatically at a certain moment. The `commit-msg` hook runs after the message is
written and before the commit is created. If the script exits with an error, the commit is cancelled.

Ours, `.githooks/commit-msg`, looks for `Co-Authored-By:` or "Generated with Claude" and refuses the
commit. **We tested it:** a commit containing a co-author line was rejected (exit code 1), and no
commit was created.

**Why `.githooks/` plus `core.hooksPath`?** Git's default hook folder, `.git/hooks/`, is *not* part
of the repository, so it's never committed or pushed. We keep the hook in a normal folder that *is*
committed and point git at it with `git config core.hooksPath .githooks`. That setting lives in your
local `.git/config`, so after cloning the repo anywhere else, run that command once again.

---

## 3. Line endings — why `.gitattributes` exists

Every line of a text file ends with an invisible marker. Windows uses two characters, `CR LF`
("carriage return + line feed"), while Linux and macOS use one, `LF`. Our scripts and SQL will run
inside **Linux containers**. A shell script saved with Windows endings fails there with a confusing
error like `/bin/sh^M: bad interpreter` (the `^M` is the stray CR).

`.gitattributes` contains `* text=auto eol=lf`: "every text file is stored and checked out with LF,
even on Windows". VS Code and other modern editors handle LF fine.

---

## 4. `.gitignore` — files git must never track

| Pattern | Why it's ignored |
|---|---|
| `node_modules/` | installed libraries: huge, and recreated by `npm install` |
| `dist/`, `coverage/` | generated output |
| `.env` | where any real secret would go; must never be committed |
| `*.log` | logs |
| `.claude/settings.local.json`, `.remember/` | your local AI-tool state: personal, not part of the project |

---

## 5. Docker — running Postgres and Meilisearch without installing them

**Container.** A program packaged with everything it needs (its own files, libraries and
settings), running isolated from the rest of your machine. Think of a lunchbox: the food and the
cutlery come together, and it doesn't matter whose kitchen you open it in.

**Image vs container.** An **image** is the packaged recipe (`postgres:17.11`); a **container** is
one running copy of it. It's the same relationship as a class and an object.

**Not a virtual machine.** A VM emulates a whole computer with its own operating system. Containers
share one Linux kernel, so they start in seconds and use little memory. On Windows, Docker Desktop
runs a single small Linux VM (through WSL2) and every container lives inside it. Yours gives Docker
28 CPUs and about 7.6 GiB of RAM.

**Why Docker for this project:**
- the same versions every time, on any machine;
- a database can be wiped and recreated in seconds, which testing needs constantly;
- chaos tests (Task 5) must kill the connector abruptly, and `docker kill` does exactly that;
- it costs $0 and installs nothing on Windows itself.

### Docker Compose

Compose starts several containers from one file, `docker-compose.yml`.
`docker compose up -d --wait` starts everything in the background (`-d`) and waits until each
service reports healthy (`--wait`). `docker compose down` stops them.

### Our `docker-compose.yml`, line by line

- `name: driftless`: containers are named `driftless-postgres-1` and so on, kept apart from your
  other projects.
- `image: postgres:17.11`: an exact version, not `latest`, so results can be reproduced (D-010).
- `command: ["postgres", "-c", "wal_level=logical"]`: start Postgres with one setting changed (section 7).
- `environment:`: the user, password and database the image creates on first start. These are
  local-dev values, not secrets; nothing outside your computer can reach them (next point).
- `ports: "127.0.0.1:5440:5432"`: the format is `host-address:host-port:container-port`. Inside its
  container Postgres listens on its usual 5432; from Windows you reach it at 5440.
  - **Why `127.0.0.1`?** Without it Docker listens on every network interface (`0.0.0.0`), so anyone
    on the same Wi-Fi could try to connect. `127.0.0.1` ("localhost") means "this computer only".
  - **Why 5440? (something that actually went wrong).** The first start failed with
    `Bind for 0.0.0.0:5433 failed: port is already allocated`. Port 5432 belongs to a Postgres
    installed directly on Windows. 5433 and 5434 belong to your online-judge-v2 and
    reachinbox-scheduler containers, which start automatically whenever Docker starts. My first port
    check ran *before* Docker was running, so it couldn't see them. Lesson: check ports with
    everything running. 5440 was free.
- `volumes: pgdata:/var/lib/postgresql/data`: a **named volume**, storage managed by Docker that
  survives restarts and re-created containers. `docker compose down` keeps it; `docker compose down -v`
  deletes it (all data gone).
- `healthcheck:`: a command Docker runs every 2 seconds to ask "are you ready?" (`pg_isready` for
  Postgres, `curl /health` for Meilisearch). A *running* database isn't necessarily *ready*; Postgres
  needs a moment before it accepts connections. Later services (the connector, Task 5) wait for
  `healthy` before starting.
- Meilisearch settings: `MEILI_ENV: development` (friendlier errors); `MEILI_MASTER_KEY` (every
  request must carry this key; we checked that a request without it gets `401 Unauthorized`);
  `MEILI_NO_ANALYTICS` (don't send usage statistics).

---

## 6. PostgreSQL — the source of truth

PostgreSQL is a relational database. Data lives in tables of rows and columns, you query it with SQL,
and transactions commit all-or-nothing. **Source of truth** means that when Postgres and the search
index disagree, Postgres is right by definition, and the index must be corrected to match. Our
database is `shop`; it gets a `products` table in Task 2.

---

## 7. The WAL — Postgres's diary (the heart of Driftless)

**What it is.** Before Postgres changes any data file, it first writes a description of the change
to the **write-ahead log** (WAL). It's called "write-ahead" because the log entry is written first.

**Why Postgres has one.** Crash safety. If the power dies mid-write, Postgres replays the WAL on
restart and finishes or discards the half-done work. Standby servers are also fed from the WAL.

**Why Driftless cares.** The WAL contains every committed change, in the exact order they committed.
That's precisely what we need to copy changes into the search index in the right order. Instead of
trusting the app to report its changes (dual writes), we read Postgres's own diary.

**LSN.** Every position in the WAL has an address, the **Log Sequence Number**, written like
`0/1A2B3C4`. Think of it as a page number in the diary. It only ever goes up.

**`wal_level`** is how much detail the diary records:

| Level | Records | Used for |
|---|---|---|
| `minimal` | only what crash recovery needs | a single server, nothing else |
| `replica` (default) | + enough to keep a physical copy of the whole database | standby servers, backups |
| `logical` | + enough to rebuild individual row changes (which table, which row, new values) | **logical replication, i.e. Driftless** |

We set `logical`. The cost is a little more WAL written, which is negligible here.
Verified: `SHOW wal_level` → `logical`.

**Words you'll meet in Task 3** (so they aren't new then):
- **Logical decoding**: turning WAL records back into "row 42 of products was updated to …".
- **pgoutput**: the decoding plugin built into Postgres (D-002).
- **Publication**: the list of tables whose changes we want (`driftless_pub`).
- **Replication slot**: a bookmark (`driftless_slot`). Postgres keeps all WAL from the bookmark
  onward until Driftless says "I've handled everything up to LSN X" (an **ack**). That's why a crash
  loses nothing. It's also why a forgotten slot can fill the disk (Task 8).

---

## 8. Meilisearch — the search engine

A search engine builds an **index**, like the one at the back of a book (word → where it appears).
That lets it find matches instantly, tolerate typos and rank results by relevance. Postgres can do
full-text search too, but instant, typo-tolerant, ranked search-as-you-type is what search engines
are built for.

**Why Meilisearch** (D-003): it's one small program with a simple API that uses little memory, and
it's popular with small teams, the people who'd use Driftless. Elasticsearch and OpenSearch are more
powerful but much heavier (Java), and sync tools already exist for them (PGSync).

**One property that shapes the whole design.** When you send documents, Meilisearch replies
`202 Accepted` immediately and does the work later as a **task**. 202 means *queued*, not *done*.
In Task 4, Driftless waits until the task reports `succeeded` before telling Postgres "handled";
otherwise a failed task would be a silently lost change.

Verified: `/health` → `available`, version `1.54.3`, and requests without the key are refused (401).

---

## 9. Why these versions

- **Postgres 17.11:** stable and supported by every tool. Postgres 18 is newer, but its Docker image
  changed where it stores data, an unnecessary gotcha.
- **Meilisearch 1.54.3:** the newest release, 1.55.0, was only days old; 1.54 has had three bug-fix releases.
- **Node 24** (already installed): it can run TypeScript files directly, so there's no build step (D-004, from Task 3).
- **Exact versions, not `latest`:** a benchmark number only means something if you can say what it
  was measured on.

---

## 10. What's *not* here yet, and why

- **Redis:** an in-memory key-value store. It's very fast and usually used as a cache ("remember this
  answer for 60 s so the database isn't asked again"). Driftless could keep a Redis cache in sync too;
  that's stretch goal S1. It's not in the core because the core proof is "the search index never drifts".
- **Kafka:** a distributed log many companies place between databases and consumers. Here the WAL plus
  the replication slot already *are* a durable, ordered log with a bookmark, so Kafka would only be a
  second log to keep in sync (D-005).
- **README.md:** written in Task 10, when there's something real to describe.
- **`docs/RESULTS.md`, `docs/bugs/`:** created when the first measured number (Task 5) and the first
  real bug appear. Empty templates now would just be clutter.

---

## 11. The docs system — how work survives a crash or a new chat

An AI session forgets everything when it ends; files don't. So the project's memory lives in files:

| File | Role |
|---|---|
| `AGENTS.md` | Read first by any agent: what the project is, how to work, current status. Many AI coding tools read this file name by convention. |
| `CLAUDE.md` | Claude Code loads `CLAUDE.md` automatically. Ours is one line, `@AGENTS.md`, which pulls in AGENTS.md, so there's one source of truth instead of two copies. |
| `docs/BUILD_PLAN.md` | Every step with a checkbox. The next thing to do is the first unchecked box. |
| `docs/HANDOVER.md` | Where we left off: state, open issues, next step. |
| `docs/CONSTRAINTS.md` | The rules: single author, no new dependencies without asking, no fake numbers, … |
| `docs/ARCHITECTURE.md` | The map: components, invariants, folder layout, fixed names and ports. |
| `docs/FLOW.md` | The key processes step by step, each with "where it can break". |
| `docs/DECISIONS.md` | Every important choice and its reason, so nobody undoes it by accident. |
| `docs/TEST_CHECKLIST.md` | What must pass before a task counts as done. |
| `docs/ROLLBACK.md` | How to recover with git and Docker. |
| `learn/` | This folder: one plain-language file per finished task. |

**The checkpoint loop.** Do one step, verify it, then make one commit containing the work, its
ticked box and the updated handover. Because plan, handover and code are saved together, they can't
contradict each other after a crash. At the end of a task: run the checklist, write the learn file,
update the status, add the tag.

**Resuming.** In a new chat, paste:
*"Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off."*
The agent reads the files, checks git, and carries on at the first unchecked step.

---

## 12. The plan in one line, and two deliberate choices

T01 ✅ Foundation → T02 Source data → T03 Read the WAL → T04 Meilisearch sink → T05 Correctness
harness → T06 Lanes & batching → T07 Backfill → T08 Backpressure → T09 Metrics & benchmarks →
T10 Release. Stretch: S1 Redis, S2 standby, S3 Typesense, S4 schema changes.

- **Prove before speeding up (T05 before T06).** First build the tool that proves "zero drift"
  (reconcile + chaos), so every later speed-up is checked automatically. Fast but wrong is worthless.
- **Break it before fixing it (T07).** Backfill is built the naive way first. The race is reproduced
  and written up, then fixed. That bug note is your interview story, like the timing-leak fix in Invariant.

---

## 13. If an interviewer asks…

- **"Why does Driftless need `wal_level=logical`, and what does it cost?"** The default level records
  enough for crash recovery and standby copies, but not enough to say "row 42 of products changed to X".
  `logical` adds that detail, at the cost of somewhat more WAL.
- **"Why run everything in Docker?"** Pinned versions make results reproducible, and chaos testing needs
  to kill processes abruptly, which `docker kill` gives for free.
- **"Why bind the ports to 127.0.0.1?"** Docker publishes on all interfaces by default, which would make
  dev databases with dev passwords reachable from the network.

---

## Glossary

- **Commit**: a saved snapshot of the project, with a message and an author.
- **Tag**: a name on one commit (`checkpoint/T01`).
- **Hook**: a script git runs automatically at a certain moment (ours runs before a commit is created).
- **Trailer**: a `Key: value` line at the end of a commit message (e.g. `Co-Authored-By:`).
- **Image / container**: the packaged program / one running copy of it.
- **Volume**: Docker-managed storage that outlives containers.
- **Healthcheck**: an "are you ready?" command Docker runs periodically.
- **WAL**: Postgres's write-ahead log, every change in order, written before the data files.
- **LSN**: a position in the WAL (`0/1A2B3C4`); only increases.
- **`wal_level`**: how much the WAL records; `logical` lets us rebuild row changes.
- **Logical decoding / pgoutput**: turning WAL records into row changes / the built-in plugin that does it.
- **Publication**: the set of tables whose changes are streamed.
- **Replication slot**: Postgres's bookmark for one consumer; it keeps WAL until acked.
- **Ack**: "I've handled everything up to LSN X; you may discard older WAL."
- **Search index**: the search engine's lookup structure (our `products` index).
- **Source of truth**: the copy that wins when copies disagree (Postgres).
