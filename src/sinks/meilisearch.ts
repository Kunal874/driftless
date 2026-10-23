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
import type { RowChange } from '../pipeline/lanes.ts';
import { toDocument, type Document } from './document.ts';
import type { Sink } from './sink.ts';

const TASK_WAIT_MS = 10 * 60_000; // a big task can take a while; the client's default is 5 s

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

// Reduces a lane's batch to its net effect per key (D-022): each key ends as either one delete or one upsert
// whose fields were merged in order (later wins, fields not resent are kept). The two sets touch different
// keys, so they can be written in any order, even at the same time.
// A delete followed by an upsert of the same key can only be a re-INSERT, which carries every column, so
// that upsert is a whole row: merging it onto the stale document gives the same result as replacing it.
export function coalesce(
  changes: RowChange[],
  table: string,
  keep?: (column: string) => boolean, // which columns become fields (config sync.columns); default: all
): { upserts: Map<string, Document>; deletes: Set<string> } {
  const upserts = new Map<string, Document>();
  const deletes = new Set<string>();
  for (const change of changes) {
    if (change.table !== table) throw new Error(`change for a table Driftless doesn't mirror: ${change.table}`);
    if (change.op === 'delete') {
      upserts.delete(change.pk);
      deletes.add(change.pk);
    } else if (deletes.delete(change.pk)) {
      upserts.set(change.pk, toDocument(change.row, keep)); // re-inserted after a delete: the whole row
    } else {
      upserts.set(change.pk, { ...upserts.get(change.pk), ...toDocument(change.row, keep) });
    }
  }
  return { upserts, deletes };
}

// Writes to the index. Each call returns only once Meilisearch has really applied the writes, so the
// caller may count those changes as applied (ack after apply, invariant 1).
export function meilisearchSink(index: Index, table: string, keep: (column: string) => boolean): Sink {
  return {
    name: 'meilisearch',
    async applyBatch(changes: RowChange[]): Promise<void> {
      const { upserts, deletes } = coalesce(changes, table, keep);
      const writes: Promise<void>[] = [];
      if (deletes.size > 0) {
        const ids = [...deletes];
        writes.push(submit(() => index.deleteDocuments(ids), `delete ${idList(ids)}`));
      }
      if (upserts.size > 0) {
        const docs = [...upserts.values()];
        writes.push(submit(() => index.updateDocuments(docs), `upsert ${idList([...upserts.keys()])}`));
      }
      await Promise.all(writes); // different keys, so neither write can overtake the other in a harmful way
    },
    clear: (): Promise<void> => submit(() => index.deleteAllDocuments(), 'clear index (TRUNCATE)'),
    isEmpty: async (): Promise<boolean> => (await index.getStats()).numberOfDocuments === 0,
  };
}

// Exponential backoff with "full jitter": wait a random time between 0 and min(30 s, 100 ms × 2^attempt).
// The randomness keeps retrying clients from hitting a recovering server in lock-step.
export const backoffMs = (attempt: number): number => Math.random() * Math.min(30_000, 100 * 2 ** attempt);

type RetryOptions = { maxRejections?: number; backoff?: (attempt: number) => number; log?: (message: string) => void };

// Runs one write until Meilisearch has really applied it (D-021):
// - Meilisearch unreachable or overloaded (network error, timeout, HTTP 5xx/429/408): retry with backoff, for as
//   long as it takes. Nothing is confirmed meanwhile, so lag grows visibly and nothing is lost.
// - Meilisearch rejected the write (task failed, other HTTP 4xx): try `maxRejections` times in case it was a fluke,
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

// 408 (Request Timeout) means "the server gave up waiting for the request: send it again". It's what a frozen
// Meilisearch answers once it wakes up, so it must not count as a rejection (BUG-004).
const RETRYABLE_STATUS = new Set([408, 429]);

function isTransient(err: unknown): boolean {
  if (err instanceof MeilisearchApiError) return err.response.status >= 500 || RETRYABLE_STATUS.has(err.response.status);
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
