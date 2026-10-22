import { describe, expect, it } from 'vitest';
import { Checkpointer } from './checkpointer.ts';

describe('Checkpointer', () => {
  it('confirms transactions in commit order as they complete', () => {
    const cp = new Checkpointer();
    const t1 = cp.track(100n, 1);
    const t2 = cp.track(200n, 1);
    expect(cp.advance()).toBeUndefined();
    t1.remaining--;
    expect(cp.advance()).toBe(100n);
    t2.remaining--;
    expect(cp.advance()).toBe(200n);
    expect(cp.advance()).toBeUndefined(); // nothing new
  });

  it('holds back a later transaction that finished first (the data-loss case)', () => {
    const cp = new Checkpointer();
    const big = cp.track(100n, 3); // e.g. spread over a slow lane
    const small = cp.track(200n, 1);
    small.remaining--; // finished first on a fast lane
    expect(cp.advance()).toBeUndefined(); // confirming 200 would also "confirm" the unfinished 100
    big.remaining -= 3;
    expect(cp.advance()).toBe(200n); // now both, in one step
  });

  it('counts a transaction spread over several lanes as done only when every part is', () => {
    const cp = new Checkpointer();
    const txn = cp.track(300n, 3);
    txn.remaining--; // lane 0
    txn.remaining--; // lane 5
    expect(cp.advance()).toBeUndefined();
    txn.remaining--; // lane 2
    expect(cp.advance()).toBe(300n);
  });

  it('lets an empty transaction through, but only behind the earlier ones', () => {
    const cp = new Checkpointer();
    const t1 = cp.track(100n, 1);
    cp.track(150n, 0); // e.g. a transaction with no changes to our tables
    expect(cp.advance()).toBeUndefined();
    t1.remaining--;
    expect(cp.advance()).toBe(150n);
  });

  it('reports each transaction as it becomes confirmable, oldest first (for the lag metric)', () => {
    const seen: number[] = [];
    const cp = new Checkpointer((txn) => seen.push(txn.committedAt));
    const t1 = cp.track(100n, 1, 1_000);
    const t2 = cp.track(200n, 1, 2_000);
    t2.remaining--;
    cp.advance();
    expect(seen).toEqual([]); // t2 is done but waits behind t1, and so does its lag
    t1.remaining--;
    cp.advance();
    expect(seen).toEqual([1_000, 2_000]);
  });

  it('reports what is still in flight, and keeps memory flat over many transactions', () => {
    const cp = new Checkpointer();
    for (let i = 1; i <= 5000; i++) {
      const txn = cp.track(BigInt(i), 1);
      expect(cp.inFlight).toBe(1);
      txn.remaining--;
      expect(cp.advance()).toBe(BigInt(i));
      expect(cp.inFlight).toBe(0);
    }
  });
});
