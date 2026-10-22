import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Client } from 'pg';
import type { Entry, RowChange } from '../pipeline/lanes.ts';

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

type Row = Record<string, unknown>;

export type BackfillState = { status: 'running'; after: string | null } | { status: 'done'; rows: number; finishedAt: string };

// Reads where the last backfill got to (null when there has never been one).
export async function readBackfillState(db: Client, stateTable: string): Promise<BackfillState | null> {
  const q = stateTable.split('.').map((part) => db.escapeIdentifier(part)).join('.');
  const { rows } = await db.query<{ value: BackfillState }>(`SELECT value FROM ${q} WHERE name = 'backfill'`);
  return rows[0]?.value ?? null;
}

type Options = {
  table: string; // e.g. "public.products"
  primaryKey: string;
  watermarkTable: string;
  stateTable: string;
  chunk: number;
  debugDelayMs: number;
  push: (entry: Entry) => void; // into the same lanes the stream uses, so each key keeps one queue
  log: (message: string) => void;
};

// The chunk currently between its marks.
type Window = {
  id: string;
  open: boolean; // the low mark has come through the stream
  changed: Map<string, Set<string> | 'all'>; // key → the columns the stream sent for it since the low mark
  truncated: boolean;
  rows: Row[];
  atHigh: (result: { pushed: number; filled: number; applied: Promise<void> }) => void;
};

// Backfill with watermarks (D-023, after Netflix's DBLog; fixes BUG-002).
//
// The naive version read a chunk and wrote it a moment later. A row that changed in between got its new value
// from the stream first and was then overwritten by the older copy. Here every chunk is bracketed by two marks,
// LOW then SELECT then HIGH. The marks are row updates to a published table, so they arrive in the change stream
// in commit order, and between them the stream names every key that changed while the chunk was read. At the
// HIGH mark the chunk is pushed into the lanes at exactly that point in the stream, minus what the stream
// already carries a newer value for.
//
// "What the stream carries" is per column, not per row (BUG-003): Postgres doesn't resend a big unchanged
// (TOASTed) value in an UPDATE. If such an update lands inside the window and the whole snapshot row were
// dropped, the snapshot's copy of that value, the only one left, would be lost. So for a changed key only the
// columns no window change sent are pushed. Those didn't change: a changed value is always sent in full.
export function createBackfill({ table, primaryKey, watermarkTable, stateTable, chunk, debugDelayMs, push, log }: Options) {
  let window: Window | undefined;

  return {
    // Stream hooks: dispatch calls these for every change, in commit order.
    watermark(mark: string): void {
      if (!window) return; // e.g. a mark from before a restart, replayed by the stream
      if (mark === `low:${window.id}`) {
        window.open = true;
      } else if (mark === `high:${window.id}`) {
        const w = window;
        w.open = false;
        const out: Row[] = [];
        let filled = 0;
        for (const row of w.truncated ? [] : w.rows) {
          const sent = w.changed.get(String(row[primaryKey]));
          if (sent === undefined) {
            out.push(row); // untouched during the read: the snapshot is current
          } else if (sent !== 'all') {
            const missing = Object.keys(row).filter((column) => !sent.has(column));
            if (missing.length === 0) continue; // the stream sent every column: nothing left to add
            out.push(Object.fromEntries([[primaryKey, row[primaryKey]], ...missing.map((c) => [c, row[c]])]));
            filled++;
          } // 'all': deleted or re-inserted in the window, so the stream has the whole truth
        }
        const batch = countdown(out.length);
        for (const row of out) push({ change: { op: 'insert', table, pk: String(row[primaryKey]), row }, txn: batch.txn });
        w.atHigh({ pushed: out.length, filled, applied: batch.done });
      }
    },
    rowChanged(change: RowChange): void {
      if (!window?.open) return;
      const before = window.changed.get(change.pk);
      if (change.op === 'delete' || before === 'all') {
        window.changed.set(change.pk, 'all');
      } else {
        const sent = before ?? new Set<string>();
        for (const column of Object.keys(change.row)) sent.add(column);
        window.changed.set(change.pk, sent);
      }
    },
    truncated(): void {
      if (window?.open) window.truncated = true; // every row the chunk read is gone
    },

    // Copies every row after `from` (null = from the start), chunk by chunk, in primary-key order. `db` is a
    // normal SQL connection. Progress is saved after each chunk has been *applied*, never just read, so a killed
    // backfill resumes by reading that chunk again (T07.4).
    async run(db: Client, from: string | null): Promise<{ rows: number; dropped: number; filled: number; ms: number }> {
      const q = (name: string) => name.split('.').map((part) => db.escapeIdentifier(part)).join('.');
      const pk = db.escapeIdentifier(primaryKey);
      const setMark = (mark: string) => db.query(`UPDATE ${q(watermarkTable)} SET mark = $1 WHERE id = 1`, [mark]);
      const save = (state: BackfillState) =>
        db.query(
          `INSERT INTO ${q(stateTable)} (name, value) VALUES ('backfill', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify(state)],
        );
      const started = Date.now();
      let after = from;
      await save({ status: 'running', after });
      let total = 0;
      let dropped = 0;
      let filledTotal = 0;
      for (;;) {
        const id = randomUUID();
        const atHigh = new Promise<{ pushed: number; filled: number; applied: Promise<void> }>((resolve) => {
          window = { id, open: false, changed: new Map(), truncated: false, rows: [], atHigh: resolve };
        });
        await setMark(`low:${id}`);
        const { rows }: { rows: Row[] } = await db.query(
          `SELECT * FROM ${q(table)} WHERE $1::text IS NULL OR ${pk} > $1::bigint ORDER BY ${pk} LIMIT ${chunk}`,
          [after],
        );
        if (rows.length === 0) break; // its low mark will come through the stream and be ignored
        window!.rows = rows; // before the high mark is written, so it's in place when that mark arrives
        if (debugDelayMs > 0) await sleep(debugDelayMs); // the same window the naive version lost to
        await setMark(`high:${id}`);
        const { pushed, filled, applied } = await atHigh;
        await applied;
        dropped += rows.length - pushed;
        filledTotal += filled;
        total += pushed;
        after = String(rows.at(-1)![primaryKey]);
        await save({ status: 'running', after });
        if (Math.floor(total / 20_000) > Math.floor((total - pushed) / 20_000)) log(`backfill: ${total} rows so far`);
      }
      window = undefined;
      await save({ status: 'done', rows: total, finishedAt: new Date().toISOString() });
      return { rows: total, dropped, filled: filledTotal, ms: Date.now() - started };
    },
  };
}
