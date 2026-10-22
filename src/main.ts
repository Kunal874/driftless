import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { Meilisearch } from 'meilisearch';
import { LogicalReplicationService, PgoutputPlugin, type Pgoutput } from 'pg-logical-replication';
import * as config from './config.ts';
import { ensureReplicationSetup } from './source/replication.ts';
import { transactionAssembler, type Transaction } from './source/decode.ts';
import { bigIntToLsn, lsnToBigInt } from './source/lsn.ts';
import { ensureIndex, meilisearchSink } from './sinks/meilisearch.ts';
import { createLanes } from './pipeline/lanes.ts';
import { Checkpointer } from './pipeline/checkpointer.ts';
import { naiveBackfill } from './source/backfill.ts';

const STATS_EVERY_MS = 5_000;

const meili = new Meilisearch(config.meilisearch);
await ensureIndex(meili, config.index.uid, config.index.primaryKey);
const sink = meilisearchSink(meili.index(config.index.uid), config.table);

const db = new pg.Client(config.pgConfig);
await db.connect();
const startLsn = await ensureReplicationSetup(db, config);
await db.end();

// Both of the library's automatic acks are off (learn/task-03): one acks every message on receipt,
// the other acks the last *received* position every 10 s. Driftless acks only what it has applied.
const service = new LogicalReplicationService(config.pgConfig, { acknowledge: { auto: false, timeoutSeconds: 0 } });
const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [config.publication] });

let stats = { txns: 0, changes: 0, writes: 0 }; // since the last stats line
const checkpointer = new Checkpointer();
const lanes = createLanes({
  count: config.lanes,
  batchMax: config.batchMax,
  apply: async (changes) => {
    await sink.applyBatch(changes); // returns only once Meilisearch reports the writes `succeeded`
    stats.changes += changes.length;
    stats.writes++;
  },
  onApplied: () => void confirmApplied().catch(fail),
  onError: fail,
});

const assemble = transactionAssembler();
const queue: Pgoutput.Message[] = []; // ponytail: unbounded; bounded + paused stream in T08
let draining = false;
let txnOpen = false; // a BEGIN has been handled but its transaction isn't dispatched yet
let confirming = 0; // confirms in progress (including the crash-test delay)
let confirmed = lsnToBigInt(startLsn); // everything before this WAL position is applied

service.on('data', (_lsn: string, msg: Pgoutput.Message) => {
  queue.push(msg); // synchronous, so a later keepalive always sees this message as pending
  void drain();
});

service.on('heartbeat', (walEnd: string, _time: number, replyRequested: boolean) => {
  // Idle = every message received so far is applied and confirmed. The stream arrives in order, so the
  // server's walEnd then covers nothing we still owe: confirming it keeps the slot moving while only
  // unpublished tables change (otherwise their WAL piles up behind the slot).
  const idle = !draining && !txnOpen && queue.length === 0 && checkpointer.inFlight === 0 && confirming === 0;
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
        await dispatch(txn);
        txnOpen = false;
      }
    }
  } catch (err) {
    fail(err);
  } finally {
    draining = false;
  }
}

// Hands a transaction's changes to the lanes without waiting for them to be applied; the checkpointer
// confirms it once every change has been. TRUNCATE is a barrier (D-018): everything before it is applied
// first, and nothing after it is dispatched until the index has been cleared.
async function dispatch(txn: Transaction): Promise<void> {
  if (config.logTransactions) console.log(describe(txn));
  stats.txns++;
  const tracked = checkpointer.track(lsnToBigInt(txn.commitEndLsn), txn.changes.length);
  for (const change of txn.changes) {
    if (change.op === 'truncate') {
      await lanes.idle();
      await sink.clear();
      tracked.remaining--;
    } else {
      lanes.push({ change, txn: tracked });
    }
  }
  await confirmApplied(); // an empty or TRUNCATE-only transaction has no lane to report it
}

// Confirms the end of the unbroken run of fully applied transactions, if it grew (ack after apply, D-006).
async function confirmApplied(): Promise<void> {
  const end = checkpointer.advance();
  if (end === undefined) return;
  confirming++;
  try {
    if (config.debugAckDelayMs > 0) await sleep(config.debugAckDelayMs);
    await confirm(end);
  } finally {
    confirming--;
  }
}

// Tells Postgres everything before `end` is applied, so it may recycle that WAL. Never moves backwards.
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

setInterval(() => {
  if (stats.txns === 0 && stats.changes === 0) return;
  const perWrite = stats.writes > 0 ? Math.round(stats.changes / stats.writes) : 0;
  console.log(`driftless: +${stats.txns} txns, ${stats.changes} changes applied in ${stats.writes} writes ` +
    `(${perWrite}/write); ${checkpointer.inFlight} txns in flight; confirmed ${bigIntToLsn(confirmed)}`);
  stats = { txns: 0, changes: 0, writes: 0 };
}, STATS_EVERY_MS).unref();

function fail(err: unknown): never {
  console.error('driftless: fatal:', err);
  process.exit(1); // fail-stop (D-009): nothing past an unapplied change is ever acked
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    void service.stop().then(() => process.exit(0));
  });
}

// Backfill runs alongside the stream once streaming has started (T07).
if (config.backfill.enabled) {
  service.once('start', () => void backfillNow().catch(fail));
}

async function backfillNow(): Promise<void> {
  const reader = new pg.Client(config.pgConfig);
  await reader.connect();
  console.log(`backfill: starting (chunks of ${config.backfill.chunk} rows)`);
  const { rows, ms } = await naiveBackfill(reader, {
    table: config.table,
    primaryKey: config.index.primaryKey,
    chunk: config.backfill.chunk,
    debugDelayMs: config.backfill.debugDelayMs,
    push: (entry) => lanes.push(entry),
    log: (message) => console.log(message),
  });
  await reader.end();
  console.log(`backfill: done, ${rows} rows in ${ms} ms`);
}

console.log(`driftless: streaming slot ${config.slot}, resuming after ${startLsn} (${config.lanes} lanes, ` +
  `up to ${config.batchMax} changes per write)`);
await service.subscribe(plugin, config.slot).catch(fail);
if (!stopping) fail(new Error('replication stream ended unexpectedly'));
