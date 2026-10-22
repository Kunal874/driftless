import { MeilisearchApiError, type EnqueuedTaskPromise, type Meilisearch } from 'meilisearch';

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

// Meilisearch answers a write with "202 Accepted" (queued) and applies it later as a task. A write only
// counts once its task reports `succeeded`.
async function succeeded(write: EnqueuedTaskPromise, what: string): Promise<void> {
  const task = await write.waitTask({ timeout: 60_000 });
  if (task.status !== 'succeeded') throw new Error(`${what}: task ${task.status}: ${task.error?.message}`);
}
