import { setTimeout as sleep } from 'node:timers/promises';
import type { Client } from 'pg';
import type { Entry } from '../pipeline/lanes.ts';

// Lanes count a batch's `remaining` down as they apply it; this one also notices when it reaches 0.
export function countdown(n: number): { txn: { remaining: number }; done: Promise<void> } {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  let remaining = n;
  const txn = {
    get remaining() {
      return remaining;
    },
    set remaining(value: number) {
      remaining = value;
      if (value === 0) resolve();
    },
  };
  if (n === 0) resolve();
  return { txn, done };
}

type Options = {
  table: string; // e.g. "public.products"
  primaryKey: string;
  chunk: number;
  debugDelayMs: number;
  push: (entry: Entry) => void; // into the same lanes the stream uses, so each key keeps one queue
  log: (message: string) => void;
};

// NAIVE backfill (T07.1). Reads the table in primary-key order, one chunk at a time, and pushes the rows into
// the lanes as inserts while the stream keeps running.
// It has a race (BUG-002): a chunk is read at one moment and written a little later. If a row in it changes in
// between, the stream applies the new value first and the chunk then overwrites it with the old one, for good.
export async function naiveBackfill(db: Client, { table, primaryKey, chunk, debugDelayMs, push, log }: Options) {
  const qualified = table.split('.').map((part) => db.escapeIdentifier(part)).join('.');
  const pk = db.escapeIdentifier(primaryKey);
  const started = Date.now();
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const { rows }: { rows: Record<string, unknown>[] } = await db.query(
      `SELECT * FROM ${qualified} WHERE $1::text IS NULL OR ${pk} > $1::bigint ORDER BY ${pk} LIMIT ${chunk}`,
      [after],
    );
    if (rows.length === 0) break;
    if (debugDelayMs > 0) await sleep(debugDelayMs); // widen the race window on purpose
    const batch = countdown(rows.length);
    for (const row of rows) push({ change: { op: 'insert', table, pk: String(row[primaryKey]), row }, txn: batch.txn });
    await batch.done;
    after = String(rows.at(-1)![primaryKey]);
    total += rows.length;
    if (total % 20_000 < chunk) log(`backfill: ${total} rows so far`);
  }
  return { rows: total, ms: Date.now() - started };
}
