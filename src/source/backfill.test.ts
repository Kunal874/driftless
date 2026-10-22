import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import type { RowChange } from '../pipeline/lanes.ts';
import { countdown, createBackfill } from './backfill.ts';

describe('countdown', () => {
  it('resolves once lanes have counted every entry down', async () => {
    const { txn, done } = countdown(3);
    let finished = false;
    void done.then(() => { finished = true; });
    txn.remaining--;
    txn.remaining--;
    await Promise.resolve();
    expect(finished).toBe(false);
    txn.remaining--;
    await done;
    expect(txn.remaining).toBe(0);
  });

  it('is already done for an empty batch', async () => {
    await countdown(0).done; // would time out if it never resolved
  });
});

type Row = Record<string, unknown>;
const table = 'public.products';
const row = (id: number): Row => ({ id: String(id), name: `product ${id}`, description: `long text ${id}` });
// Stream changes as the decoder delivers them: `row` holds only the columns Postgres sent.
const update = (id: number, sent: Row): RowChange => ({ op: 'update', table, pk: String(id), row: { id: String(id), ...sent } });
const del = (id: number): RowChange => ({ op: 'delete', table, pk: String(id) });

// A fake database standing in for Postgres *and* the stream: SELECTs return the scripted chunks, and every
// watermark UPDATE is "streamed" back through `onMark`, where a test can also inject concurrent changes.
function setup(chunks: Row[][], onMark: (mark: string, bf: ReturnType<typeof createBackfill>) => void) {
  const pushed: string[] = [];
  const pushedRows: Row[] = [];
  const selectedAfter: unknown[] = [];
  const saved: unknown[] = [];
  const bf = createBackfill({
    table, primaryKey: 'id', watermarkTable: 'public.driftless_watermark', stateTable: 'public.driftless_state',
    chunk: 3, debugDelayMs: 0,
    push: (entry) => { // "applied" at once
      pushed.push(entry.change.pk);
      if (entry.change.op !== 'delete') pushedRows.push(entry.change.row);
      entry.txn.remaining--;
    },
    log: () => {},
  });
  const db = {
    escapeIdentifier: (name: string) => `"${name}"`,
    async query(sql: string, params: unknown[] = []) {
      if (sql.startsWith('UPDATE')) {
        const mark = String(params[0]);
        queueMicrotask(() => onMark(mark, bf));
        return { rows: [] };
      }
      if (sql.startsWith('SELECT')) {
        selectedAfter.push(params[0]);
        return { rows: chunks.shift() ?? [] };
      }
      if (sql.startsWith('INSERT INTO "public"."driftless_state"')) {
        saved.push({ ...JSON.parse(String(params[0])), pushedSoFar: pushed.length });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Client;
  return { bf, db, pushed, pushedRows, selectedAfter, saved };
}

describe('createBackfill (watermarks, D-023)', () => {
  it('drops a row the stream fully replaced between the low and the high mark (the BUG-002 case)', async () => {
    const { bf, db, pushed } = setup([[row(1), row(2), row(3)]], (mark, b) => {
      b.watermark(mark);
      if (mark.startsWith('low:')) {
        b.rowChanged(update(2, { name: 'new', description: 'new text' })); // every column: the stream has it all
        b.rowChanged(del(3)); // deleted while the chunk was being read: must not come back
      }
    });
    const result = await bf.run(db, null);
    expect(pushed).toEqual(['1']);
    expect(result).toMatchObject({ rows: 1, dropped: 2, filled: 0 });
  });

  it('fills in the columns a partial update did not send, instead of dropping the row (BUG-003)', async () => {
    const { bf, db, pushedRows } = setup([[row(1), row(2)]], (mark, b) => {
      b.watermark(mark);
      // A price-style update: Postgres didn't resend the big unchanged description (TOAST).
      if (mark.startsWith('low:')) b.rowChanged(update(2, { name: 'renamed' }));
    });
    const result = await bf.run(db, null);
    expect(pushedRows).toStrictEqual([
      row(1), // untouched: the whole snapshot row
      { id: '2', description: 'long text 2' }, // only what the stream didn't carry; `name` comes from the stream
    ]);
    expect(result).toMatchObject({ filled: 1 });
  });

  it('keeps rows whose changes came before the low mark or after the high mark', async () => {
    const { bf, db, pushed } = setup([[row(1), row(2), row(3)]], (mark, b) => {
      if (mark.startsWith('low:')) b.rowChanged(del(1)); // already in the stream before the window opened
      b.watermark(mark);
      if (mark.startsWith('high:')) b.rowChanged(del(3)); // after the chunk was pushed: lands behind it in the lane
    });
    await bf.run(db, null);
    expect(pushed).toEqual(['1', '2', '3']);
  });

  it('ignores marks from another chunk, e.g. replayed after a restart', async () => {
    const { bf, db, pushed } = setup([[row(1), row(2)]], (mark, b) => {
      if (mark.startsWith('low:')) {
        b.watermark('low:old-run'); // stale marks, before this chunk's window opens
        b.rowChanged(del(1)); // not inside *this* chunk's window
        b.watermark('high:old-run'); // must not push anything
      }
      b.watermark(mark);
    });
    await bf.run(db, null);
    expect(pushed).toEqual(['1', '2']);
  });

  it('drops the whole chunk if the table was truncated inside its window', async () => {
    let lowMarks = 0;
    const { bf, db, pushed } = setup([[row(1), row(2), row(3)], [row(4)]], (mark, b) => {
      b.watermark(mark);
      if (mark.startsWith('low:') && ++lowMarks === 1) b.truncated(); // only inside the first chunk's window
    });
    await bf.run(db, null);
    expect(pushed).toEqual(['4']); // rows 1–3 were read before the TRUNCATE: they no longer exist
  });

  it('saves progress only after a chunk is applied, and resumes after the saved key', async () => {
    const { bf, db, saved, selectedAfter } = setup([[row(5), row(6), row(7)], [row(8)]], (mark, b) => b.watermark(mark));
    await bf.run(db, '4'); // resuming: rows up to id 4 were done by an earlier, killed run
    expect(selectedAfter[0]).toBe('4');
    expect(saved).toMatchObject([
      { status: 'running', after: '4', pushedSoFar: 0 }, // before anything new
      { status: 'running', after: '7', pushedSoFar: 3 }, // only once rows 5–7 were applied
      { status: 'running', after: '8', pushedSoFar: 4 },
      { status: 'done', rows: 4 },
    ]);
  });

  it('walks the table chunk by chunk in primary-key order', async () => {
    const { bf, db, pushed, selectedAfter } = setup([[row(1), row(2), row(3)], [row(4)]], (mark, b) => b.watermark(mark));
    expect(await bf.run(db, null)).toMatchObject({ rows: 4, dropped: 0 });
    expect(pushed).toEqual(['1', '2', '3', '4']);
    expect(selectedAfter).toEqual([null, '3', '4']); // the last query finds nothing and ends the backfill
  });
});
