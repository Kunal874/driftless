import { setTimeout as sleep } from 'node:timers/promises';
import {
  MeilisearchApiError,
  MeilisearchRequestError,
  MeilisearchRequestTimeOutError,
  MeilisearchTaskTimeOutError,
  type EnqueuedTaskPromise,
  type Index,
  type Meilisearch,
} from 'meilisearch';
import type { Change, Transaction } from '../source/decode.ts';
import { toDocument, type Document } from './document.ts';

// ponytail: fixed chunk size for big upsert runs (e.g. a 100k-row seed); T06 makes batching tunable.
const MAX_DOCS_PER_WRITE = 10_000;
const TASK_WAIT_MS = 10 * 60_000; // a 10k-document task can take a while; the client's default is 5 s

// Creates the index with an explicit primary key if it doesn't exist yet. Without one, Meilisearch guesses
// from the first document's fields (anything containing "id") and fails the task if the guess is ambiguous.
export async function ensureIndex(client: Meilisearch, uid: string, primaryKey: string): Promise<void> {
  const existing = await client.getRawIndex(uid).catch((err: unknown) => {
    if (err instanceof MeilisearchApiError && err.cause?.code === 'index_not_found') return undefined;
    throw err;
  });
  if (!existing) {
    await succeeded(client.createIndex(uid, { primaryKey }), `create index ${uid}`);
  } else if (existing.primaryKey == null) {
    await succeeded(client.updateIndex(uid, { primaryKey }), `set primary key of index ${uid}`);
  } else if (existing.primaryKey !== primaryKey) {
    throw new Error(`index ${uid} has primary key '${existing.primaryKey}', expected '${primaryKey}'`);
  }
}

export type Step =
  | { kind: 'upsert'; docs: Map<string, Document> }
  | { kind: 'delete'; ids: Set<string> }
  | { kind: 'clear' };

// Turns a transaction's changes into as few Meilisearch writes as possible without reordering anything.
// Consecutive changes of the same kind share one write; several updates to one key inside it merge in
// order (later fields win). A delete, an upsert run or a TRUNCATE always ends the write before it.
export function planSteps(changes: Change[], table: string): Step[] {
  const steps: Step[] = [];
  for (const change of changes) {
    const tables = change.op === 'truncate' ? change.tables : [change.table];
    if (!tables.includes(table)) throw new Error(`change for a table Driftless doesn't mirror: ${tables.join(', ')}`);
    const last = steps.at(-1);
    if (change.op === 'truncate') {
      steps.push({ kind: 'clear' });
    } else if (change.op === 'delete') {
      if (last?.kind === 'delete') last.ids.add(change.pk);
      else steps.push({ kind: 'delete', ids: new Set([change.pk]) });
    } else {
      const doc = toDocument(change.row);
      if (last?.kind === 'upsert') last.docs.set(change.pk, { ...last.docs.get(change.pk), ...doc });
      else steps.push({ kind: 'upsert', docs: new Map([[change.pk, doc]]) });
    }
  }
  return steps;
}

// Applies a transaction to the index, one write at a time. Returns only when every write has really been
// applied, so the caller may then confirm the transaction to Postgres (ack after apply, invariant 1).
export function meilisearchSink(index: Index, table: string) {
  return {
    async apply(txn: Transaction): Promise<void> {
      for (const step of planSteps(txn.changes, table)) {
        if (step.kind === 'clear') {
          await submit(() => index.deleteAllDocuments(), `xid ${txn.xid}: clear index (TRUNCATE)`);
        } else if (step.kind === 'delete') {
          const ids = [...step.ids];
          await submit(() => index.deleteDocuments(ids), `xid ${txn.xid}: delete ${idList(ids)}`);
        } else {
          const docs = [...step.docs.values()];
          for (let i = 0; i < docs.length; i += MAX_DOCS_PER_WRITE) {
            const chunk = docs.slice(i, i + MAX_DOCS_PER_WRITE);
            await submit(() => index.updateDocuments(chunk), `xid ${txn.xid}: upsert ${idList(chunk.map((d) => String(d.id)))}`);
          }
        }
      }
    },
  };
}

// Exponential backoff with "full jitter": wait a random time between 0 and min(30 s, 100 ms × 2^attempt).
// The randomness keeps retrying clients from hitting a recovering server in lock-step.
export const backoffMs = (attempt: number): number => Math.random() * Math.min(30_000, 100 * 2 ** attempt);

type RetryOptions = { maxRejections?: number; backoff?: (attempt: number) => number; log?: (message: string) => void };

// Runs one write until Meilisearch has really applied it (D-021):
// - Meilisearch unreachable or overloaded (network error, timeout, HTTP 5xx/429): retry with backoff, for as
//   long as it takes. Nothing is confirmed meanwhile, so lag grows visibly and nothing is lost.
// - Meilisearch rejected the write (task failed, HTTP 4xx): try `maxRejections` times in case it was a fluke,
//   then throw. Fail-stop (D-009): stopping is visible and loses nothing; skipping would drift silently.
// Re-sending after an error is safe: writes are idempotent, and Meilisearch applies tasks in order.
export async function submit(write: () => EnqueuedTaskPromise, what: string, options: RetryOptions = {}): Promise<void> {
  const { maxRejections = 3, backoff = backoffMs, log = console.warn } = options;
  let rejections = 0;
  for (let attempt = 1; ; attempt++) {
    let problem: string;
    try {
      const task = await write().waitTask({ timeout: TASK_WAIT_MS });
      if (task.status === 'succeeded') return;
      problem = `rejected the write (task ${task.status}): ${task.error?.message ?? 'no reason given'}`;
      if (++rejections >= maxRejections) throw new Error(`${what}: Meilisearch ${problem}`);
    } catch (err) {
      if (!isTransient(err)) throw err;
      problem = `is unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
    const delay = Math.round(backoff(attempt));
    log(`meilisearch ${problem} [${what}]; attempt ${attempt}, retrying in ${delay} ms`);
    await sleep(delay);
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof MeilisearchApiError) return err.response.status >= 500 || err.response.status === 429;
  return err instanceof MeilisearchRequestError || err instanceof MeilisearchRequestTimeOutError || err instanceof MeilisearchTaskTimeOutError;
}

// Meilisearch answers a write with "202 Accepted" (queued) and applies it later as a task. A write only
// counts once its task reports `succeeded`. Used at startup, where failing fast is fine.
async function succeeded(write: EnqueuedTaskPromise, what: string): Promise<void> {
  const task = await write.waitTask({ timeout: TASK_WAIT_MS });
  if (task.status !== 'succeeded') throw new Error(`${what}: task ${task.status}: ${task.error?.message}`);
}

// Names the affected documents in errors: "id 10", "ids 1, 2, 3" or "ids 1, 2 … 10000 (10000)".
function idList(ids: string[]): string {
  if (ids.length === 1) return `id ${ids[0]}`;
  return ids.length <= 3 ? `ids ${ids.join(', ')}` : `ids ${ids[0]}, ${ids[1]} … ${ids.at(-1)} (${ids.length})`;
}
