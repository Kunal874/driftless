import { setTimeout as sleep } from 'node:timers/promises';
import {
  ConnectionTimeoutError,
  ClientOfflineError,
  ErrorReply,
  SocketClosedUnexpectedlyError,
  SocketTimeoutError,
  type createClient,
} from '@redis/client';
import type { RowChange } from '../pipeline/lanes.ts';
import { backoffMs, coalesce } from './meilisearch.ts';
import type { Sink } from './sink.ts';

// The client createClient() returns by default: node-redis 6 speaks RESP3 unless told otherwise.
export type RedisClient = ReturnType<typeof createClient<{}, {}, {}, 3>>;

// The Redis cache (T12, D-029): one hash per row, `${keyPrefix}${pk}`, one field per column, each value JSON-encoded
// so types survive (`7` stays a number, `null` stays null). A batch is reduced per key first (the same `coalesce` as
// the index), then sent as one MULTI/EXEC: deletes as DEL, upserts as HSET of only the fields the WAL sent, which
// merges into the existing hash exactly like Meilisearch's updateDocuments merges into a document.
export function redisSink(client: RedisClient, options: Options): Sink {
  const { table, keyPrefix, keep, log = console.warn, backoff = backoffMs } = options;
  const key = (pk: string) => keyPrefix + pk;
  const retrying = (what: string, op: () => Promise<unknown>) => withRetry(op, what, log, backoff);
  const prefixKeys = async (each: (keys: string[]) => Promise<unknown>, stopEarly = false): Promise<boolean> => {
    let cursor = '0';
    do {
      const page = await client.scan(cursor, { MATCH: `${escapeGlob(keyPrefix)}*`, COUNT: 1000 });
      cursor = page.cursor;
      if (page.keys.length > 0) {
        await each(page.keys);
        if (stopEarly) return true;
      }
    } while (cursor !== '0');
    return false;
  };

  return {
    name: 'redis',
    async applyBatch(changes: RowChange[]): Promise<void> {
      const { upserts, deletes } = coalesce(changes, table, keep);
      if (upserts.size === 0 && deletes.size === 0) return;
      await retrying(`${upserts.size} upsert(s), ${deletes.size} delete(s)`, () => {
        const multi = client.multi();
        if (deletes.size > 0) multi.del([...deletes].map(key));
        for (const [pk, doc] of upserts) multi.hSet(key(pk), encode(doc));
        return multi.exec();
      });
    },
    clear: () => retrying(`clear ${keyPrefix}* (TRUNCATE)`, () => prefixKeys((keys) => client.unlink(keys))),
    isEmpty: async () => !(await prefixKeys(async () => {}, true)),
  };
}

type Options = {
  table: string; // the table this cache mirrors
  keyPrefix: string; // e.g. 'product:'
  keep?: (column: string) => boolean; // the config's column filter, the same one the index uses
  log?: (message: string) => void;
  backoff?: (attempt: number) => number;
};

// Every field value JSON-encoded: a hash stores only strings, and this keeps types for readers (JSON.parse).
export function encode(doc: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(doc).map(([field, value]) => [field, JSON.stringify(value)]));
}

// The retry policy, as for Meilisearch (D-021): Redis unreachable → wait and retry forever (the batch is idempotent);
// Redis *rejected* a command (ErrorReply, e.g. WRONGTYPE) → fail-stop, because retrying can't change its answer.
// Anything else is a bug and fail-stops too, rather than looping forever.
export async function withRetry(
  op: () => Promise<unknown>,
  what: string,
  log: (message: string) => void,
  backoff: (attempt: number) => number,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await op();
      return;
    } catch (err) {
      if (err instanceof ErrorReply || !isTransient(err)) throw err;
      const delay = Math.round(backoff(attempt));
      log(`redis is unavailable: ${(err as Error).message} [${what}]; attempt ${attempt}, retrying in ${delay} ms`);
      await sleep(delay);
    }
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);

function isTransient(err: unknown): boolean {
  return err instanceof SocketClosedUnexpectedlyError || err instanceof ConnectionTimeoutError ||
    err instanceof SocketTimeoutError || err instanceof ClientOfflineError ||
    NETWORK_CODES.has((err as NodeJS.ErrnoException)?.code ?? '');
}

// SCAN MATCH treats * ? [ ] \ as glob syntax; a prefix must match literally.
export const escapeGlob = (prefix: string) => prefix.replace(/[*?[\]\\]/g, '\\$&');
