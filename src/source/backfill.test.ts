import { describe, expect, it } from 'vitest';
import { countdown } from './backfill.ts';

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
