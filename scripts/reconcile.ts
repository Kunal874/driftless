// Proves (or disproves) "zero drift": every row of every mirrored table against its Meilisearch document and Redis hash.
// The logic lives in src/reconcile.ts (shipped as `driftless reconcile`, T15); this wrapper keeps every script and doc
// that runs `node scripts/reconcile.ts` working, and adds --self-test, which plants drift (never against production).
//
// Usage: node scripts/reconcile.ts [--timeout=SECONDS] [--self-test]
// Exit code: 0 = identical, 1 = drift (or self-test failed), 2 = couldn't check.
import { reconcile } from '../src/reconcile.ts';

const args = process.argv.slice(2);
process.exitCode = await reconcile({
  timeoutS: Number(args.find((arg) => arg.startsWith('--timeout='))?.split('=')[1] ?? 600),
  selfTest: args.includes('--self-test'),
});
