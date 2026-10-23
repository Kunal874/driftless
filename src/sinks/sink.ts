import type { RowChange } from '../pipeline/lanes.ts';

// What every sink provides (T12). main.ts applies each lane batch to every sink, in parallel, and counts the batch as
// applied only once all of them have applied it: ack-after-apply covers every sink (D-029).
export type Sink = {
  name: string; // the `sink` label on metrics
  applyBatch(changes: RowChange[]): Promise<void>; // resolves only once the writes are really applied (and durable)
  clear(): Promise<void>; // TRUNCATE of the mirrored table
  isEmpty(): Promise<boolean>; // nothing mirrored yet, so a backfill is needed
};
