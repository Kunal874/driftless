import { describe, expect, it } from 'vitest';
import { LogicalReplicationService } from 'pg-logical-replication';

// BUG-001 contract. pg-logical-replication 2.5.0's acknowledge(lsn) writes lsn + 1 into the standby status update,
// so Driftless sends `end − 1` to confirm exactly `end` (sendStatus in src/main.ts). Upstream removed the + 1 in 2.6.0
// (kibae/pg-logical-replication#222). The dependency is pinned to 2.5.0; if an upgrade makes this test fail, change
// sendStatus to pass `end` unchanged in the same commit, or Driftless confirms one byte short of every end.
describe('pg-logical-replication acknowledge() (BUG-001 contract)', () => {
  it('writes the given position + 1 into the written, flushed and applied fields', async () => {
    const service = new LogicalReplicationService({}, { acknowledge: { auto: false, timeoutSeconds: 0 } });
    const sent: Buffer[] = [];
    const internals = service as unknown as { _stop: boolean; _connection: { sendCopyFromChunk(b: Buffer): void } };
    internals._stop = false; // as if subscribed
    internals._connection = { sendCopyFromChunk: (chunk) => sent.push(chunk) };

    expect(await service.acknowledge('0/9D68A47')).toBe(true);

    const lsnAt = (offset: number) => (BigInt(sent[0]!.readUInt32BE(offset)) << 32n) | BigInt(sent[0]!.readUInt32BE(offset + 4));
    expect(sent[0]![0]).toBe(0x72); // 'r': standby status update
    expect([lsnAt(1), lsnAt(9), lsnAt(17)]).toEqual([0x9d68a48n, 0x9d68a48n, 0x9d68a48n]);
  });
});
