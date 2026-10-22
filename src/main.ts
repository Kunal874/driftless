import pg from 'pg';
import { LogicalReplicationService, PgoutputPlugin, type Pgoutput } from 'pg-logical-replication';
import * as config from './config.ts';
import { ensureReplicationSetup } from './source/replication.ts';
import { transactionAssembler, type Transaction } from './source/decode.ts';

const db = new pg.Client(config.pgConfig);
await db.connect();
const startLsn = await ensureReplicationSetup(db, config);
await db.end();

// Both of the library's automatic acks are off (learn/task-03): one acks every message on receipt,
// the other acks the last *received* position every 10 s. Driftless acks only what it has handled.
const service = new LogicalReplicationService(config.pgConfig, { acknowledge: { auto: false, timeoutSeconds: 0 } });
const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [config.publication] });

const assemble = transactionAssembler();
const queue: Pgoutput.Message[] = []; // ponytail: unbounded; bounded + paused stream in T08
let draining = false;

service.on('data', (_lsn: string, msg: Pgoutput.Message) => {
  queue.push(msg);
  void drain();
});
service.on('error', fail);

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let msg = queue.shift(); msg; msg = queue.shift()) {
      const txn = assemble(msg);
      if (txn) await handle(txn);
    }
  } catch (err) {
    fail(err);
  } finally {
    draining = false;
  }
}

async function handle(txn: Transaction): Promise<void> {
  console.log(describe(txn));
}

function describe(txn: Transaction): string {
  const lines = [`txn ${txn.xid} committed ${txn.commitTime.toISOString()} end ${txn.commitEndLsn}: ${txn.changes.length} change(s)`];
  for (const c of txn.changes.slice(0, 3)) {
    if (c.op === 'truncate') lines.push(`  truncate ${c.tables.join(', ')}`);
    else if (c.op === 'delete') lines.push(`  delete ${c.table} #${c.pk}`);
    else lines.push(`  ${c.op} ${c.table} #${c.pk} [${Object.keys(c.row).join(', ')}]`);
  }
  if (txn.changes.length > 3) lines.push(`  … and ${txn.changes.length - 3} more`);
  return lines.join('\n');
}

function fail(err: unknown): never {
  console.error('driftless: fatal:', err);
  process.exit(1); // fail-stop (D-009): nothing past an unhandled change is ever acked
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    void service.stop().then(() => process.exit(0));
  });
}

console.log(`driftless: streaming slot ${config.slot}, resuming after ${startLsn}`);
await service.subscribe(plugin, config.slot).catch(fail);
if (!stopping) fail(new Error('replication stream ended unexpectedly'));
