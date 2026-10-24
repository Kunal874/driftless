import { describe, expect, it } from 'vitest';
import { LogicalReplicationService } from 'pg-logical-replication';

// BUG-001 contract. sendStatus (src/main.ts) passes a commit's END position straight to acknowledge(), which is right
// only if the library writes that position unchanged into the standby status update: true since 2.6.0
// (kibae/pg-logical-replication#222). 2.5.0 added 1, and Driftless used to send `end − 1` to make up for it. If a
// different version makes this test fail, sendStatus must change with it, or every confirm is off by the difference.
describe('pg-logical-replication acknowledge() (BUG-001 contract)', () => {
  it('writes the given position unchanged into the written, flushed and applied fields', async () => {
    const service = new LogicalReplicationService({}, { acknowledge: { auto: false, timeoutSeconds: 0 } });
    const sent: Buffer[] = [];
    const internals = service as unknown as { _stop: boolean; _connection: { sendCopyFromChunk(b: Buffer): void } };
    internals._stop = false; // as if subscribed
    internals._connection = { sendCopyFromChunk: (chunk) => sent.push(chunk) };

    expect(await service.acknowledge('0/9D68A47')).toBe(true);

    const lsnAt = (offset: number) => (BigInt(sent[0]!.readUInt32BE(offset)) << 32n) | BigInt(sent[0]!.readUInt32BE(offset + 4));
    expect(sent[0]![0]).toBe(0x72); // 'r': standby status update
    expect([lsnAt(1), lsnAt(9), lsnAt(17)]).toEqual([0x9d68a47n, 0x9d68a47n, 0x9d68a47n]);
  });

  it('keeps the high half across a 32-bit boundary (no carry games any more)', async () => {
    const service = new LogicalReplicationService({}, { acknowledge: { auto: false, timeoutSeconds: 0 } });
    const sent: Buffer[] = [];
    const internals = service as unknown as { _stop: boolean; _connection: { sendCopyFromChunk(b: Buffer): void } };
    internals._stop = false;
    internals._connection = { sendCopyFromChunk: (chunk) => sent.push(chunk) };

    await service.acknowledge('1/FFFFFFFF');

    expect([sent[0]!.readUInt32BE(9), sent[0]!.readUInt32BE(13)]).toEqual([1, 0xffffffff]);
  });
});
