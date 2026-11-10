# Task 15 — Publishing Driftless, explained

> One file per finished task: everything that was done, *why*, and what went wrong on the way.

## What we did in Task 15

Until now, using Driftless meant cloning the repo. Task 15 publishes it two ways, both built from a version tag:

- a **container image** on GitHub's registry: `docker run ghcr.io/kunal874/driftless:0.3.0` (amd64 and arm64);
- an **npm package**, `driftless-cdc`, which installs a `driftless` command: `npx driftless-cdc`.

Version 0.3.0 (Task 14's alerts plus this) is out both ways and was checked from the outside, the way a user gets it.

---

## 1. Two ways to ship a Node program

**A container image** bundles everything: Node itself, our code, our dependencies. Anyone with Docker runs the exact
bytes we tested. **GHCR** (GitHub Container Registry, `ghcr.io`) hosts images next to the repo, free for public
projects.

**An npm package** is a tarball of files plus a `package.json`. Installing it pulls its dependencies from npm. The
`bin` field (`"driftless": "dist/cli.js"`) tells npm to put a `driftless` command on the PATH. **`npx`** downloads a
package into a cache and runs its command in one step, with no install.

Why both: Docker users get a sealed image; Node users (on a VM, next to a Node app, on a platform without Docker) get
`npx`.

## 2. The catch: Node won't run TypeScript from `node_modules`

Since Task 3 the repo runs `.ts` files directly: Node 24 strips the types as it loads them (D-004). But Node
**refuses to do that for files inside `node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). That's a
deliberate choice by Node: packages are supposed to ship JavaScript. An npm package with only `src/*.ts` would
install fine and then fail on its first `import`.

So the npm package ships JavaScript. `tsc`, which we already had for type-checking, now also *emits* code with a
second config, `tsconfig.build.json`: output to `dist/`, tests excluded, and **`rewriteRelativeImportExtensions`**.
Our sources import `./config.ts`; the emitted file must import `./config.js`, and that option rewrites those paths.

The repo and the image keep running the `.ts` files. Only the npm package has a build step (`prepack` runs it, so
`npm pack` and `npm publish` can't forget it).

**The lesson that shaped the tests:** in the repo checkout, everything works either way. So every check uses the
**packed tarball, installed into an empty folder**. CI does the same on every push: pack, install, `driftless
--version`, then a run with a missing config file must exit 2. Why does an error prove anything? In ES modules,
every `import` is resolved and linked **before any code runs**. Reaching our config error means every file of the
package was found.

## 3. The CLI

- `driftless`: run the connector (the same `main.ts` the image runs).
- `driftless reconcile`: compare every row with every sink, read-only; exit 0 = identical, 1 = drift.
- `--config <file>`, `--timeout`, `--version`, `--help`.

`reconcile` used to live in `scripts/`, which isn't shipped. It moved to `src/reconcile.ts` as a function, and
`scripts/reconcile.ts` became a three-line wrapper, so every script and doc that calls it still works.

**What it refuses:** `--self-test`. It plants wrong documents to prove reconcile notices them. That's right in a test
stack and harmful in someone's production search, so only the repo script has it. The CLI's argument parser runs in
strict mode, so an unknown option is an error, not something silently ignored.

**Why two files (`cli.ts` + `cli-args.ts`):** the usual trick to "run only when executed, not when imported by a
test" is `import.meta.main`. But only newer Node 24 releases have it; on an older one it's `undefined`, and the CLI
would silently do nothing. Instead, the parser lives in `cli-args.ts` (unit-tested), and `cli.ts` just runs.

## 4. Names, versions and what users install

- **`driftless` was taken on npm** (an unrelated package from 2022). The owner chose `driftless-cdc`; the command is
  still `driftless`, because `bin` names are separate from the package name.
- **Exact dependency versions.** Our `package-lock.json` pins every version for us, but **npm ignores a package's
  lockfile when someone installs it**. With `"meilisearch": "^0.62.0"`, a user could get a version we never tested. So
  the direct dependencies are pinned exactly. (Their own dependencies still float; `npm-shrinkwrap.json` would lock
  those too, which we judged not worth it yet.)
- **`files: ["dist"]`:** only the build output goes in (npm always adds `package.json`, README and LICENSE). The
  tarball is 21 files, 37 kB: no config with local hosts, no tests, no scripts.

## 5. The release workflow

`.github/workflows/release.yml` runs when a tag like `v0.3.0` is pushed:

1. typecheck and unit tests; the tag must equal `package.json`'s version;
2. build the image for **amd64 and arm64**. GitHub's runners are amd64, so arm64 is built under **QEMU** (an
   emulator); that's quick because the Dockerfile only installs pure-JavaScript dependencies;
3. push it to GHCR as `0.3.0`, `0.3` and `latest`, logging in with the workflow's own `GITHUB_TOKEN` (no secret to
   store or leak);
4. `npm publish --provenance` through **trusted publishing**.

**Trusted publishing** replaces the classic stored npm token. npm is told "the workflow `release.yml` in repo
`Kunal874/driftless` may publish this package". At publish time GitHub hands the workflow a short-lived signed
identity token (OIDC), and npm checks it. There's nothing to steal, and npm attaches **provenance**: a public,
signed record of which commit and workflow built the tarball.

**Dry run:** started by hand, the same workflow builds everything and runs `npm publish --dry-run`, pushing nothing.
It ran green on GitHub before the real release.

**Pinning actions by commit:** third-party actions are referenced by commit SHA, not by tag (`@v4`), because a tag
can be moved to different code, and this workflow can publish. Each pinned version was at least 14 days old (D-017):
`docker/login-action` v4.8.0 was 6 days old, so v4.7.0 it is.

## 6. What happened on release day

1. **The push was refused (HTTP 403).** Git on this machine uses Git Credential Manager, which held a *different*
   GitHub account (`Skillgenz-dev`) for github.com. The owner said to switch: `gh auth switch` made Kunal874 active
   in the GitHub CLI. Git doesn't ask `gh` for credentials here, though, so the push went through `gh` for that one
   command (`git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push`), with nothing saved.
2. **npm's first publish had to be by hand.** npm only lets you add a trusted publisher to a package that already
   exists (PyPI has "pending publishers"; npm doesn't). So the owner ran `npm publish` once. Its tarball's checksum
   equals a local `npm pack` of the release commit: `npm pack` normalizes timestamps and file order, so the same
   files always give the same hash. That's proof that what's on npm is exactly what was committed.
3. **The tag then published the image,** and the npm step said "already on npm: skipped", as designed.
4. **`latest` was pushed twice.** `docker/metadata-action` adds `latest` for version tags by itself; listing it as well
   doubled it. Harmless; the extra line is gone.
5. **The image was public at once.** New GHCR packages are usually private, but an anonymous token could read this
   one straight away, so no visibility change was needed.
6. **The release check's first run "failed".** It ran `npx driftless-cdc` from the repo root. But the repo's own
   `package.json` is now *named* `driftless-cdc`, so npx took the checkout for the package and looked for a
   `driftless` command that was never installed there. Not a bug in the package: the check now runs it from an empty
   folder, like a user would.
7. **A warning every user sees:** `prom-client` (our metrics library) is deprecated on npm in favor of
   `@prometheus-io/client`. It still works. Switching is a dependency change, so it's written down as a follow-up.

## 7. Checking the release from the outside: `scripts/release-check.sh`

A published release can still be broken in ways no repo test sees. The check runs exactly what users get, on a
throwaway stack, twice: the **GHCR image** pulled anonymously, then **`npx driftless-cdc` inside a clean `node`
container** (fresh npm cache: a real download). Each round seeds fresh tables and starts Driftless, which must
backfill them by itself. Then it writes for 60 s with **3 SIGKILLs**, and the **published** `driftless reconcile` must
find 0 drift.

For 0.3.0 both rounds passed: the image (amd64, built from `cd3dca7`) backfilled 25,000 rows in under 12 s, took
11,940 transactions and 3 SIGKILLs, and ended at 0 drift; `npx driftless-cdc` did the same with 12,150 transactions.
Details: RESULTS §15.

## 8. Words used in this task

- **Container image / registry:** a packaged filesystem + start command / a server that stores images (`ghcr.io`).
- **Multi-architecture image:** one name, several builds (amd64, arm64); Docker picks the one for your machine.
- **QEMU:** an emulator that lets an amd64 machine run arm64 programs, used here to build the arm64 image.
- **Type stripping:** Node removing TypeScript types while loading a file, so `.ts` runs without a compiler step.
- **`bin`, `npx`:** the commands a package installs / "download and run a package's command".
- **Lockfile vs shrinkwrap:** a lockfile pins versions for *this* project only; a shrinkwrap is published and pins
  them for everyone who installs the package.
- **OIDC / trusted publishing / provenance:** a short-lived signed identity from GitHub / npm accepting that identity
  instead of a stored token / a signed public record of where a package was built.
