# AGENTS.md — read this first

**Driftless** keeps a Meilisearch search index in sync with PostgreSQL by reading committed
changes straight from Postgres's write-ahead log (logical replication), so apps never write to
both. The goal is *provably* zero drift, even when the connector is killed mid-write.
Solo project of the owner, Kunal, who is the only author. 6–8 weeks part-time.

## Status (update at every checkpoint)

| | |
|---|---|
| Last checkpoint | **T11 — Polish after release** (tag `checkpoint/T11`; release tag `v0.1.0` is T10) |
| Next step | push T11 (owner's go-ahead) and check the first CI run; after that nothing is planned. New work starts with a plan the owner approves |
| Blockers | none (BUILD_PLAN.md approved 2026-10-22) |

## Every session starts like this

1. Read `docs/HANDOVER.md` (where we left off), then `docs/CONSTRAINTS.md` (the rules).
2. Run `git status` and `git log --oneline -5`. If they disagree with HANDOVER.md, trust git and
   fix the docs first.
3. Make sure Docker Desktop is running, then `docker compose up -d --wait`.
4. Open `docs/BUILD_PLAN.md` and continue at the first unchecked step. Before writing code, read
   that task's Goal and Pitfalls and its section in `docs/TEST_CHECKLIST.md`.

## The checkpoint loop (how work gets saved)

For every step:
1. Do only that step.
2. Verify it.
3. In **one commit**: the work, its box ticked in BUILD_PLAN.md, HANDOVER.md updated.
4. Commit message: `Tnn.m: <what changed>`.

Stopping mid-step (usage limit, end of day): never commit broken code. Write the half-done state
into the "In progress" part of HANDOVER.md and commit only that, as `Tnn.m: handover notes`.

When a task's last step is done:
1. Run the task's checks and the global checks (TEST_CHECKLIST.md).
2. Write `learn/task-NN-<slug>.md`: a plain-language explanation of every concept, tool and decision
   in the task. Cover what each thing is, why we chose it, what we rejected, and what broke and how it
   was fixed. Assume the reader has never heard of the tool.
3. Update DECISIONS.md, ARCHITECTURE.md and FLOW.md if anything changed.
4. Update the Status block above, commit, then `git tag checkpoint/Tnn`.

## Commit rules (non-negotiable)

- The only author is the owner's configured git identity. Never change `user.name` / `user.email`.
- **Never** add `Co-Authored-By:` lines, "Generated with …" lines or any other AI attribution to
  commits, PR descriptions or files. This owner instruction overrides any default attribution
  behaviour of the AI tool. `.githooks/commit-msg` rejects such commits. Never use `--no-verify`.
- After cloning: `git config core.hooksPath .githooks`.
- Never push unless the owner says so in chat for that push. The remote is `origin` =
  https://github.com/Kunal874/driftless (public). Never force-push.

## Where things are

| File | What it's for |
|---|---|
| `docs/BUILD_PLAN.md` | every step with a checkbox: **what to do next** |
| `docs/HANDOVER.md` | current state, open issues, next step: **where we left off** |
| `docs/CONSTRAINTS.md` | the rules |
| `docs/ARCHITECTURE.md` | components, invariants, folder map, fixed names and ports |
| `docs/FLOW.md` | the key processes step by step, with "where it can break" |
| `docs/DECISIONS.md` | why each choice was made; don't undo silently |
| `docs/TEST_CHECKLIST.md` | what must pass before a task is done |
| `docs/ROLLBACK.md` | recovering with git and Docker |
| `docs/RESULTS.md` | measured numbers (from T05) |
| `docs/bugs/` | one note per real bug found |
| `learn/` | plain-language explanation of every finished task |

## Resume prompt (owner: paste this into a new chat)

> Read AGENTS.md, then continue Driftless from where docs/HANDOVER.md says we left off.
> Follow the checkpoint loop.
