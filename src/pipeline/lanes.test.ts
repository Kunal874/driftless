import { describe, expect, it } from 'vitest';
import { createLanes, laneOf, type RowChange } from './lanes.ts';

const change = (pk: string, n: number): RowChange => ({ op: 'update', table: 'public.products', pk, row: { id: pk, n } });
const ns = (batches: RowChange[][]) => batches.map((batch) => batch.map((c) => (c.op === 'delete' ? 'del' : c.row.n)));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const failTest = (err: unknown) => { throw err; };

// A fake sink whose writes stay "in flight" until the test releases them.
function heldSink() {
  const batches: RowChange[][] = [];
  const inFlight: Array<() => void> = [];
  return {
    batches,
    apply: (changes: RowChange[]) => {
      batches.push(changes);
      return new Promise<void>((resolve) => inFlight.push(resolve));
    },
    release: async () => {
      for (const finish of inFlight.splice(0)) finish();
      await tick();
    },
  };
}

describe('laneOf', () => {
  it('always sends a key to the same lane, and spreads keys evenly', () => {
    for (const key of ['1', '42', '100000']) expect(laneOf(key, 8)).toBe(laneOf(key, 8));
    const counts = new Array<number>(8).fill(0);
    for (let id = 1; id <= 80_000; id++) counts[laneOf(String(id), 8)]!++;
    for (const n of counts) expect(Math.abs(n - 10_000)).toBeLessThan(1_000); // within 10% of a fair share
  });
});

describe('createLanes', () => {
  it("keeps one key's changes in order and batches whatever queued up during a write", async () => {
    const sink = heldSink();
    const txn = { remaining: 4 };
    let appliedBatches = 0;
    const lanes = createLanes({ count: 4, batchMax: 100, apply: sink.apply, onApplied: () => appliedBatches++, onError: failTest });
    for (let n = 1; n <= 4; n++) lanes.push({ change: change('7', n), txn });
    expect(ns(sink.batches)).toEqual([[1]]); // the first change is written at once
    await sink.release();
    expect(ns(sink.batches)).toEqual([[1], [2, 3, 4]]); // the rest arrived during that write
    await sink.release();
    expect(txn.remaining).toBe(0);
    expect(appliedBatches).toBe(2);
  });

  it('never puts more than batchMax changes into one write', async () => {
    const sizes: number[] = [];
    const lanes = createLanes({ count: 1, batchMax: 3, apply: async (c) => void sizes.push(c.length), onApplied() {}, onError: failTest });
    const txn = { remaining: 7 };
    for (let n = 0; n < 7; n++) lanes.push({ change: change(String(n), n), txn });
    await lanes.idle();
    expect(sizes).toEqual([1, 3, 3]);
    expect(txn.remaining).toBe(0);
  });

  it('runs different lanes at the same time', () => {
    const sink = heldSink();
    const lanes = createLanes({ count: 8, batchMax: 100, apply: sink.apply, onApplied() {}, onError: failTest });
    const lane = (pk: string) => laneOf(`public.products:${pk}`, 8); // routing key = table:pk (T13)
    const second = ['2', '3', '4', '5', '6'].find((key) => lane(key) !== lane('1'))!;
    lanes.push({ change: change('1', 1), txn: { remaining: 1 } });
    lanes.push({ change: change(second, 2), txn: { remaining: 1 } });
    expect(sink.batches).toHaveLength(2); // both writes are in flight before either finished
  });

  it('routes by table and id: one row stays in order, equal ids of different tables are independent (T13)', async () => {
    const sink = heldSink();
    const lanes = createLanes({ count: 8, batchMax: 100, apply: sink.apply, onApplied() {}, onError: failTest });
    const other = ['public.customers', 'public.a', 'public.b', 'public.c'].find(
      (t) => laneOf(`${t}:7`, 8) !== laneOf('public.products:7', 8),
    )!;
    const customer = (n: number): RowChange => ({ op: 'update', table: other, pk: '7', row: { id: '7', n } });
    lanes.push({ change: change('7', 1), txn: { remaining: 1 } });
    lanes.push({ change: customer(10), txn: { remaining: 1 } });
    expect(sink.batches).toHaveLength(2); // product #7 and customer #7 are written at the same time
    lanes.push({ change: change('7', 2), txn: { remaining: 1 } });
    await sink.release();
    expect(ns(sink.batches)).toEqual([[1], [10], [2]]); // product #7's second change waited for its first
  });

  it('idle() resolves only after every lane has finished', async () => {
    const sink = heldSink();
    const lanes = createLanes({ count: 8, batchMax: 100, apply: sink.apply, onApplied() {}, onError: failTest });
    lanes.push({ change: change('1', 1), txn: { remaining: 2 } });
    lanes.push({ change: change('2', 2), txn: { remaining: 2 } });
    let idle = false;
    void lanes.idle().then(() => { idle = true; });
    await tick();
    expect(idle).toBe(false);
    await sink.release();
    expect(idle).toBe(true);
  });

  it('reports a failed write instead of counting it as applied', async () => {
    const errors: unknown[] = [];
    const txn = { remaining: 1 };
    const lanes = createLanes({
      count: 1, batchMax: 10, apply: async () => { throw new Error('rejected'); }, onApplied() {}, onError: (e) => errors.push(e),
    });
    lanes.push({ change: change('1', 1), txn });
    await lanes.idle();
    expect(errors).toHaveLength(1);
    expect(txn.remaining).toBe(1); // never counted, so it can never be acked
  });
});
