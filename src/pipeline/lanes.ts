import type { Change } from '../source/decode.ts';

export type RowChange = Exclude<Change, { op: 'truncate' }>;

// Each change carries its transaction's countdown of not-yet-applied changes (see checkpointer.ts).
export type Entry = { change: RowChange; txn: { remaining: number } };

type Options = {
  count: number; // number of lanes
  batchMax: number; // most changes one write may carry
  apply: (changes: RowChange[]) => Promise<void>; // must resolve only once the batch is really applied
  onApplied: () => void; // called after every applied batch, so acks can move forward
  onError: (err: unknown) => void;
};

// FNV-1a (32-bit): a tiny, fast string hash. The same key always lands in the same lane, which is what
// keeps every row's changes in commit order even though lanes run in parallel (D-007).
export function laneOf(key: string, count: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % count;
}

// N independent ordered queues. A lane applies one batch at a time, in arrival order; different lanes hold
// different keys, so they run in parallel without reordering any row's changes.
// Batching is "natural", with no timer: when a lane's write finishes, it sends whatever queued up meanwhile
// (up to batchMax). A quiet system writes each change at once; a busy one sends big batches.
export function createLanes({ count, batchMax, apply, onApplied, onError }: Options) {
  const lanes = Array.from({ length: count }, () => ({ queue: [] as Entry[], busy: false }));
  const idleWaiters: Array<() => void> = [];
  const isIdle = () => lanes.every((lane) => !lane.busy && lane.queue.length === 0);

  async function run(lane: (typeof lanes)[number]): Promise<void> {
    lane.busy = true;
    try {
      while (lane.queue.length > 0) {
        const batch = lane.queue.splice(0, batchMax);
        await apply(batch.map((entry) => entry.change));
        for (const entry of batch) entry.txn.remaining--;
        onApplied();
      }
    } catch (err) {
      onError(err);
    } finally {
      lane.busy = false;
      if (isIdle()) for (const resolve of idleWaiters.splice(0)) resolve();
    }
  }

  return {
    push(entry: Entry): void {
      const lane = lanes[laneOf(entry.change.pk, count)]!;
      lane.queue.push(entry);
      if (!lane.busy) void run(lane);
    },
    // Resolves once every lane is empty and idle: the barrier a TRUNCATE needs (D-018).
    idle(): Promise<void> {
      return isIdle() ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve));
    },
    // ponytail: unbounded queues; T08 bounds them and pauses the stream when they fill up.
    queued: (): number => lanes.reduce((total, lane) => total + lane.queue.length, 0),
  };
}
