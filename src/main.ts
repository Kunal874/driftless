import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { Meilisearch } from 'meilisearch';
import { LogicalReplicationService, PgoutputPlugin, type Pgoutput } from 'pg-logical-replication';
import * as config from './config.ts';
import { checkSync, ensureReplicationSetup } from './source/replication.ts';
import { transactionAssembler, type Transaction } from './source/decode.ts';
import { bigIntToLsn, lsnToBigInt } from './source/lsn.ts';
import { ensureIndex, meilisearchSink } from './sinks/meilisearch.ts';
import { createLanes } from './pipeline/lanes.ts';
import { Checkpointer } from './pipeline/checkpointer.ts';
import { createBackfill, readBackfillState } from './source/backfill.ts';
import { nextReadState } from './pipeline/backpressure.ts';
import { batchSize, changesApplied, gaugeOf, lag, serveMetrics, writeSeconds } from './metrics.ts';

const STATS_EVERY_MS = 5_000;
const STATUS_EVERY_MS = 10_000; // well under Postgres's wal_sender_timeout (1 min)

// The config is checked against the real table before anything is created anywhere (an index with the wrong
// primary key, a slot that starts holding WAL).
const db = new pg.Client(config.pgConfig);
await db.connect();
await checkSync(db, config.table, config.index.primaryKey, config.namedColumns).catch(config.configError);

const meili = new Meilisearch(config.meilisearch);
await ensureIndex(meili, config.index.uid, config.index.primaryKey);
const sink = meilisearchSink(meili.index(config.index.uid), config.table, config.keepColumn);

const startLsn = await ensureReplicationSetup(db, config);
await db.end();

// Both of the library's automatic acks are off (learn/task-03): one acks every message on receipt,
// the other acks the last *received* position every 10 s. Driftless acks only what it has applied.
const service = new LogicalReplicationService(config.pgConfig, { acknowledge: { auto: false, timeoutSeconds: 0 } });
const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [config.publication] });

let stats = { txns: 0, changes: 0, writes: 0 }; // since the last stats line
const checkpointer = new Checkpointer((txn) => lag.observe((Date.now() - txn.committedAt) / 1000));
const lanes = createLanes({
  count: config.lanes,
  batchMax: config.batchMax,
  apply: async (changes) => {
    const written = writeSeconds.startTimer();
    await sink.applyBatch(changes); // returns only once Meilisearch reports the writes `succeeded`
    written();
    stats.changes += changes.length;
    stats.writes++;
    batchSize.observe(changes.length); // its count is the number of writes
    for (const change of changes) changesApplied.inc({ op: change.op });
  },
  onApplied: () => {
    void confirmApplied().catch(fail);
    applyBackpressure();
  },
  onError: fail,
});

const backfill = createBackfill({
  table: config.table,
  primaryKey: config.index.primaryKey,
  watermarkTable: config.watermarkTable,
  stateTable: config.stateTable,
  chunk: config.backfill.chunk,
  debugDelayMs: config.backfill.debugDelayMs,
  push: (entry) => lanes.push(entry),
  log: (message) => console.log(message),
});

const assemble = transactionAssembler();
const queue: Pgoutput.Message[] = []; // bounded by backpressure below (D-025)
let draining = false;
let readingPaused = false;
let txnOpen = false; // a BEGIN has been handled but its transaction isn't dispatched yet
let confirming = 0; // confirms in progress (including the crash-test delay)
let confirmed = lsnToBigInt(startLsn); // everything before this WAL position is applied

service.on('data', (_lsn: string, msg: Pgoutput.Message) => {
  queue.push(msg); // synchronous, so a later keepalive always sees this message as pending
  applyBackpressure();
  void drain();
});

// Backpressure (D-025). When too much work is waiting inside Driftless, stop reading the replication socket:
// unread data fills the kernel buffer, TCP stops Postgres's sender, and Postgres keeps the WAL. Nothing is lost.
// The library has no public pause, so this reaches its connection's socket, checked at runtime.
function applyBackpressure(): void {
  const next = nextReadState(queue.length + lanes.queued(), readingPaused, config.maxPending);
  if (!next) return;
  const socket = (service as unknown as { _connection?: { stream?: { pause(): void; resume(): void } } })._connection?.stream;
  if (!socket) throw new Error('pg-logical-replication internals changed: no _connection.stream to pause');
  readingPaused = next === 'pause';
  if (readingPaused) socket.pause();
  else socket.resume();
  console.log(`driftless: ${readingPaused ? 'paused' : 'resumed'} reading the stream (${queue.length + lanes.queued()} changes waiting)`);
}

// While reading is paused, Postgres's "are you there?" requests go unread, so re-send the confirmed position
// regularly, or Postgres drops the connection after wal_sender_timeout. (The library's own timer stays off:
// it would send the *received* position, D-019.)
setInterval(() => void sendStatus(confirmed).catch(fail), STATUS_EVERY_MS).unref();

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
// confirms it once every change has been. Every change also goes past the backfill, which needs to see the
// stream in commit order (D-023).
async function dispatch(txn: Transaction): Promise<void> {
  if (config.logTransactions) console.log(describe(txn));
  stats.txns++;
  const tracked = checkpointer.track(lsnToBigInt(txn.commitEndLsn), txn.changes.length, txn.commitTime.getTime());
  for (const change of txn.changes) {
    if (change.op === 'truncate') {
      if (change.tables.includes(config.table)) {
        // A barrier (D-018): everything before it is applied first, nothing after it starts before the clear.
        backfill.truncated();
        await lanes.idle();
        await sink.clear();
      }
      tracked.remaining--;
    } else if (change.table === config.watermarkTable) {
      if (change.op !== 'delete') backfill.watermark(String(change.row.mark)); // may push a chunk into the lanes
      tracked.remaining--; // bookkeeping only: nothing to apply
    } else {
      backfill.rowChanged(change);
      lanes.push({ change, txn: tracked });
    }
  }
  await confirmApplied(); // a transaction with nothing for the lanes has no lane to report it
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

// Tells Postgres everything before `end` is applied, so it may recycle that WAL. Never moves backwards, by
// construction: the check and the update happen before any await (the library writes to the socket synchronously),
// so two overlapping confirms can't reorder on the wire or in `confirmed` (T11.2).
async function confirm(end: bigint): Promise<void> {
  if (end <= confirmed) return;
  confirmed = end; // the caller guarantees everything before `end` is applied
  await sendStatus(end);
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
  if (stats.txns === 0 && stats.changes === 0 && !readingPaused) return;
  const perWrite = stats.writes > 0 ? Math.round(stats.changes / stats.writes) : 0;
  console.log(`driftless: +${stats.txns} txns, ${stats.changes} changes applied in ${stats.writes} writes ` +
    `(${perWrite}/write); ${checkpointer.inFlight} txns in flight; ${queue.length + lanes.queued()} changes waiting` +
    `${readingPaused ? ' (reading paused)' : ''}; confirmed ${bigIntToLsn(confirmed)}`);
  stats = { txns: 0, changes: 0, writes: 0 };
}, STATS_EVERY_MS).unref();

// GET /metrics (T09). The gauges read values that live above, at scrape time.
gaugeOf('driftless_changes_waiting', 'Changes received but not yet applied (backpressure input, D-025)',
  () => queue.length + lanes.queued());
gaugeOf('driftless_txns_in_flight', 'Transactions received but not yet confirmable', () => checkpointer.inFlight);
gaugeOf('driftless_reading_paused', '1 while backpressure has paused reading the stream', () => (readingPaused ? 1 : 0));
gaugeOf('driftless_confirmed_lsn', 'WAL position confirmed to Postgres, as a number (rate() = bytes/s)',
  () => Number(confirmed));
// How much WAL Postgres keeps for this slot: what a stalled Driftless costs the database (cap: 1 GB, D-026).
const metricsDb = new pg.Pool({ ...config.pgConfig, max: 1 });
metricsDb.on('error', () => {}); // an idle connection dropped: the next scrape reconnects
gaugeOf('driftless_slot_retained_wal_bytes', 'WAL Postgres keeps for the slot (current position − restart_lsn)',
  async () => {
    try {
      const { rows } = await metricsDb.query(
        `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::float8 AS bytes
           FROM pg_replication_slots WHERE slot_name = $1`, [config.slot]);
      return rows[0]?.bytes ?? NaN;
    } catch {
      return NaN; // Postgres unreachable: report "unknown", don't fail the whole scrape
    }
  });
serveMetrics(config.metricsServer.host, config.metricsServer.port).on('error', fail);

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

// A backfill runs alongside the stream once streaming has started (T07). Its marks only make sense in the
// stream, so it can't start before the stream does.
service.once('start', () => void maybeBackfill().catch(fail));

async function maybeBackfill(): Promise<void> {
  const reader = new pg.Client(config.pgConfig);
  await reader.connect();
  const state = await readBackfillState(reader, config.stateTable);
  let from: string | null | undefined; // undefined = no backfill this time
  if (state?.status === 'running') {
    from = state.after; // an earlier backfill was interrupted: resume after the last applied chunk
  } else if (config.backfill.enabled) {
    from = null; // asked for: DRIFTLESS_BACKFILL=1
  } else {
    const { rows: [{ has_rows }] } = await reader.query(`SELECT EXISTS (SELECT 1 FROM ${config.table}) AS has_rows`);
    const empty = (await meili.index(config.index.uid).getStats()).numberOfDocuments === 0;
    if (empty && has_rows) from = null; // an empty index for a table with rows: first start, or a deleted index
  }
  if (from === undefined) {
    await reader.end();
    return;
  }
  console.log(from === null ? `backfill: starting (chunks of ${config.backfill.chunk} rows)` : `backfill: resuming after id ${from}`);
  const { rows, dropped, filled, ms } = await backfill.run(reader, from);
  await reader.end();
  console.log(`backfill: done, ${rows} rows in ${ms} ms (${dropped} snapshot rows dropped and ${filled} only ` +
    `filled in, because the stream had newer values)`);
}

console.log(`driftless: streaming slot ${config.slot}, resuming after ${startLsn} (${config.lanes} lanes, ` +
  `up to ${config.batchMax} changes per write); metrics on ${config.metricsServer.host}:${config.metricsServer.port}`);
await service.subscribe(plugin, config.slot).catch(fail);
if (!stopping) fail(new Error('replication stream ended unexpectedly'));
