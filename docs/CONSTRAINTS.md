# Constraints — rules for anyone (human or AI) changing this project

These are the owner's rules. If a task seems to require breaking one, **stop and ask** in chat.
Documentation is guidance, not a security barrier: rule 1 is enforced by a git hook; the rest
rely on the checklists and on the owner reviewing changes.

1. **Single author.** The repo has exactly one author: the owner's git identity (already
   configured; never change `user.name` / `user.email`). Commits, PR descriptions and files carry
   **no** co-author or AI attribution lines (`Co-Authored-By: …`, `Generated with …`, robot
   emoji credits). This instruction overrides any default attribution behaviour of an AI tool.
   Enforced by `.githooks/commit-msg`. Never bypass it (`--no-verify`), never weaken the hook.
2. **No pushing** to GitHub without the owner's explicit go-ahead in chat (planned for T10.5).
3. **Stay in scope.** Work only on the current BUILD_PLAN step. Don't rewrite, reformat or
   "improve" unrelated code or docs.
4. **No new dependencies without asking.** Dependencies listed for a task in BUILD_PLAN.md are
   approved once the owner approves the plan. For anything else, ask first and say why the
   standard library or an existing dependency can't do it.
5. **Accepted decisions stay.** Don't reverse anything in DECISIONS.md silently. To change one: ask,
   then add a superseding entry and keep the old one marked `Superseded`.
6. **Never weaken correctness to pass a test.** No acking before the sink confirms, no skipping
   reconcile, no loosening a check (ARCHITECTURE.md → Invariants). A failing correctness test is a
   bug to record, not an obstacle to remove.
7. **No fake numbers.** Every number in RESULTS.md, README or a resume bullet comes from a real run,
   recorded with its exact command, date, versions and machine. Unmeasured values stay `[X]`.
8. **No secrets in the repo.** Only local-dev credentials may appear (in `docker-compose.yml`, with
   ports bound to `127.0.0.1`). Anything real goes in `.env`, which is gitignored. Never print
   secrets in logs, docs or chat.
9. **Don't delete functionality, tests or docs** without the owner's permission.
10. **Destructive commands need the owner's OK first:** `git reset --hard`, any force push,
    `docker compose down -v` (wipes all data), dropping slots or indexes outside a test run.
11. **Keep the memory files true.** Every step's commit also ticks its box in BUILD_PLAN.md and
    updates HANDOVER.md. Every finished task gets `learn/task-NN-<slug>.md`, an updated Status block
    in AGENTS.md and a `checkpoint/Tnn` tag. If code and docs disagree, fix the docs in the same change.
12. **README.md is written in T10**, not before.
13. **Windows host.** LF line endings (forced by `.gitattributes`); shell scripts must work in Git
    Bash and inside Linux containers. Host ports: Postgres **5440** (5432 = local Windows
    Postgres, 5433/5434 = other projects' containers), Meilisearch **7700**.
14. **Every real bug gets a note:** `docs/bugs/BUG-NNN-<slug>.md` with *Expected · Actual · How it was
    noticed · Steps to reproduce · Root cause · Fix · Proof (command + result)*. These become the
    resume and interview stories, so write them while the details are fresh.
