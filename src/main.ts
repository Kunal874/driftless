import pg from 'pg';
import { Meilisearch } from 'meilisearch';
import { LogicalReplicationService, PgoutputPlugin, type Pgoutput } from 'pg-logical-replication';
import * as config from './config.ts';
import { ensureReplicationSetup } from './source/replication.ts';
import { transactionAssembler, type Transaction } from './source/decode.ts';
import { bigIntToLsn, lsnToBigInt } from './source/lsn.ts';
import { ensureIndex } from './sinks/meilisearch.ts';

const meili = new Meilisearch(config.meilisearch);
await ensureIndex(meili, config.index.uid, config.index.primaryKey);

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
let txnOpen = false; // a BEGIN has been handled but its transaction isn't confirmed yet
let confirmed = lsnToBigInt(startLsn); // everything before this WAL position is handled

service.on('data', (_lsn: string, msg: Pgoutput.Message) => {
  queue.push(msg); // synchronous, so a later keepalive always sees this message as pending
  void drain();
});

service.on('heartbeat', (walEnd: string, _time: number, replyRequested: boolean) => {
  // Idle = every message received so far is handled and confirmed. The stream arrives in order, so the
  // server's walEnd then covers nothing we still owe: confirming it keeps the slot moving while only
  // unpublished tables change (otherwise their WAL piles up behind the slot).
  const idle = !draining && !txnOpen && queue.length === 0;
  const target = idle ? lsnToBigInt(walEnd) : confirmed;
  if (target > confirmed) void confirm(target).catch(fail);
  else if (replyRequested) void sendStatus(confirmed).catch(fail); // "still here", position unchanged
});

service.on('error', fail);

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let msg = queue.shift(); msg; msg = queue.shift()) {
      if (msg.tag === 'begin') txnOpen = true;
      const txn = assemble(msg);
      if (txn) {
        await handle(txn);
        txnOpen = false;
      }
    }
  } catch (err) {
    fail(err);
  } finally {
    draining = false;
  }
}

async function handle(txn: Transaction): Promise<void> {
  console.log(describe(txn));
  if (config.debugAckDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, config.debugAckDelayMs));
  await confirm(lsnToBigInt(txn.commitEndLsn)); // ack only after handling (D-006)
  console.log(`  confirmed ${txn.commitEndLsn}`);
}

// Tells Postgres everything before `end` is handled, so it may recycle that WAL. Never moves backwards.
async function confirm(end: bigint): Promise<void> {
  if (end <= confirmed) return;
  if (await sendStatus(end)) confirmed = end;
}

// The library reports lsn + 1, but Postgres wants the END position itself (that's what its own subscriber
// sends). Passing an end position straight through confirms one byte too far and can skip the next
// transaction after a restart (docs/bugs/BUG-001), so subtract the 1 the library adds.
function sendStatus(end: bigint): Promise<boolean> {
  return service.acknowledge(bigIntToLsn(end - 1n));
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
