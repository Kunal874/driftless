// Reproduces docs/bugs/BUG-001: pg-logical-replication's acknowledge(lsn) reports lsn + 1 to Postgres.
// Acking a commit's END position that way confirms one byte too far, so a transaction whose commit
// record starts exactly there is skipped after a restart, i.e. silently lost.
//
// Usage (Driftless must be stopped; uses test data only):
//   node scripts/repro-ack-off-by-one.ts           ack the way the library's own auto mode does
//   node scripts/repro-ack-off-by-one.ts fixed     ack end − 1, so Postgres receives exactly the end
import pg from 'pg';
import { LogicalReplicationService, PgoutputPlugin, type Pgoutput } from 'pg-logical-replication';
import * as config from '../src/config.ts';
import { bigIntToLsn, lsnToBigInt } from '../src/source/lsn.ts';

const fixed = process.argv[2] === 'fixed';
const db = new pg.Client(config.pgConfig);
await db.connect();

// 1. Start from a clean position: skip whatever test changes the slot still holds.
await db.query('SELECT pg_replication_slot_advance($1, pg_current_wal_lsn())', [config.slot]);

// 2. Two transactions with adjacent commit records: both write first, then commit back to back.
const a = new pg.Client(config.pgConfig);
const b = new pg.Client(config.pgConfig);
await a.connect();
await b.connect();
await a.query('BEGIN');
await a.query('UPDATE products SET stock = stock + 1 WHERE id = 3');
await b.query('BEGIN');
await b.query('UPDATE products SET stock = stock + 1 WHERE id = 4');
await a.query('COMMIT');
await b.query('COMMIT');
await a.end();
await b.end();

// 3. Stream both, acknowledge ONLY the first (as if the second hadn't been applied yet), stop.
type Commit = { xid: number; commitLsn: string; commitEndLsn: string };
const service = new LogicalReplicationService(config.pgConfig, { acknowledge: { auto: false, timeoutSeconds: 0 } });
const commits: Commit[] = [];
await new Promise<void>((resolve, reject) => {
  let xid = 0;
  service.on('data', (_lsn: string, msg: Pgoutput.Message) => {
    if (msg.tag === 'begin') xid = msg.xid;
    if (msg.tag === 'commit') {
      commits.push({ xid, commitLsn: msg.commitLsn!, commitEndLsn: msg.commitEndLsn! });
      if (commits.length === 2) resolve();
    }
  });
  service.on('error', reject);
  service.subscribe(new PgoutputPlugin({ protoVersion: 1, publicationNames: [config.publication] }), config.slot).catch(reject);
});
const [t1, t2] = commits as [Commit, Commit];
const arg = fixed ? bigIntToLsn(lsnToBigInt(t1.commitEndLsn) - 1n) : t1.commitEndLsn;
await service.acknowledge(arg);
await new Promise((resolve) => setTimeout(resolve, 1000)); // let the WAL sender process the status update
await service.stop();
while ((await db.query('SELECT active FROM pg_replication_slots WHERE slot_name = $1', [config.slot])).rows[0].active) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// 4. Ask Postgres what it would re-send after a restart.
const { rows: [slot] } = await db.query('SELECT confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name = $1', [config.slot]);
const { rows: pending } = await db.query(
  `SELECT DISTINCT xid::text FROM pg_logical_slot_peek_binary_changes($1, NULL, NULL, 'proto_version', '1', 'publication_names', $2)`,
  [config.slot, config.publication],
);
const resent = pending.some((row) => row.xid === String(t2.xid));
console.log(`mode:                        ${fixed ? 'fixed (ack end − 1)' : 'library (ack end)'}`);
console.log(`T1 xid ${t1.xid}: commit ${t1.commitLsn} → end ${t1.commitEndLsn}  (acked)`);
console.log(`T2 xid ${t2.xid}: commit ${t2.commitLsn} → end ${t2.commitEndLsn}  (NOT acked)`);
console.log(`T2's commit starts where T1's ends: ${lsnToBigInt(t2.commitLsn) === lsnToBigInt(t1.commitEndLsn)}`);
console.log(`acknowledge() was given ${arg}; slot confirmed_flush_lsn is now ${slot.confirmed_flush_lsn}`);
console.log(resent ? 'RESULT: T2 would be re-sent after a restart (correct)' : 'RESULT: T2 would NOT be re-sent after a restart: it is LOST');
await db.end();
