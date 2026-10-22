// Proves (or disproves) "zero drift". Waits until Driftless has caught up, then compares every Postgres row
// with its Meilisearch document, using the same mapping the sink uses (src/sinks/document.ts).
// The connector must be running: its idle confirms are how "caught up" becomes visible.
//
// Usage: node scripts/reconcile.ts [--timeout=SECONDS] [--self-test]
// Exit code: 0 = identical, 1 = drift (or self-test failed), 2 = couldn't check.
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { Meilisearch, type Index } from 'meilisearch';
import * as config from '../src/config.ts';
import { toDocument, type Document } from '../src/sinks/document.ts';
import { lsnToBigInt } from '../src/source/lsn.ts';

const CHUNK = 1000;
const SAMPLES = 5;

type Report = {
  rows: number;
  documents: number;
  missing: string[]; // row exists, document doesn't
  extra: string[]; // document exists, row doesn't
  mismatched: { id: string; expected: string; actual: string }[];
};

// Field order doesn't matter, values do: compare documents as JSON with sorted keys.
const canonical = (doc: Document) => JSON.stringify(Object.fromEntries(Object.entries(doc).sort(([a], [b]) => a.localeCompare(b))));

// Caught up = the slot has confirmed everything up to the WAL position at the moment we started waiting,
// and Meilisearch has no write left in its queue.
async function waitForCatchUp(db: pg.Client, meili: Meilisearch, timeoutMs: number): Promise<number> {
  const { rows: [now] } = await db.query<{ lsn: string }>('SELECT pg_current_wal_lsn()::text AS lsn');
  const target = lsnToBigInt(now.lsn);
  const started = Date.now();
  for (;;) {
    const { rows: [slot] } = await db.query<{ lsn: string }>(
      'SELECT confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name = $1',
      [config.slot],
    );
    if (!slot) throw new Error(`slot ${config.slot} doesn't exist`);
    const pending = await meili.tasks.getTasks({ statuses: ['enqueued', 'processing'], limit: 1 });
    if (lsnToBigInt(slot.lsn) >= target && pending.total === 0) return Date.now() - started;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`not caught up to ${now.lsn} after ${timeoutMs / 1000} s (slot at ${slot.lsn}, ` +
        `${pending.total} Meilisearch task(s) pending). Is Driftless running?`);
    }
    await sleep(500);
  }
}

async function compare(db: pg.Client, index: Index): Promise<Report> {
  const report: Report = { rows: 0, documents: 0, missing: [], extra: [], mismatched: [] };
  const table = config.table.split('.').map((part) => db.escapeIdentifier(part)).join('.');
  const pk = db.escapeIdentifier(config.index.primaryKey);
  const ids = new Set<string>(); // ponytail: every id in memory (~50 MB per million rows); fine for a checker
  let last: string | null = null;
  for (;;) {
    // Keyset pagination: "rows after the last id seen", which stays fast at any table size.
    const { rows }: { rows: Record<string, unknown>[] } = await db.query(
      `SELECT * FROM ${table} WHERE $1::text IS NULL OR ${pk} > $1::bigint ORDER BY ${pk} LIMIT ${CHUNK}`,
      [last],
    );
    if (rows.length === 0) break;
    const chunkIds: string[] = rows.map((row) => String(row[config.index.primaryKey]));
    const { results } = await index.getDocuments({ ids: chunkIds, limit: CHUNK });
    const documents = new Map(results.map((doc) => [String(doc[config.index.primaryKey]), doc]));
    for (const [i, row] of rows.entries()) {
      const id = chunkIds[i]!;
      ids.add(id);
      const doc = documents.get(id);
      if (!doc) {
        report.missing.push(id);
        continue;
      }
      const expected = canonical(toDocument(row, config.keepColumn));
      const actual = canonical(doc);
      if (expected !== actual) report.mismatched.push({ id, expected, actual });
    }
    report.rows += rows.length;
    last = chunkIds.at(-1)!;
  }
  report.documents = (await index.getStats()).numberOfDocuments;
  // Every document that matched a row is accounted for; any surplus means documents without a row.
  if (report.documents > report.rows - report.missing.length) {
    for (let offset = 0; ; offset += CHUNK) {
      const { results } = await index.getDocuments({ fields: [config.index.primaryKey], limit: CHUNK, offset });
      if (results.length === 0) break;
      for (const doc of results) if (!ids.has(String(doc[config.index.primaryKey]))) report.extra.push(String(doc[config.index.primaryKey]));
    }
  }
  return report;
}

const drift = (r: Report) => r.missing.length + r.extra.length + r.mismatched.length;

function print(r: Report, ms: number): void {
  const sample = (ids: string[]) => (ids.length ? ` (e.g. ${ids.slice(0, SAMPLES).join(', ')})` : '');
  console.log(`reconcile: ${r.rows} rows vs ${r.documents} documents, compared in ${ms} ms`);
  console.log(`  missing documents:    ${r.missing.length}${sample(r.missing)}`);
  console.log(`  extra documents:      ${r.extra.length}${sample(r.extra)}`);
  console.log(`  mismatched documents: ${r.mismatched.length}${sample(r.mismatched.map((m) => m.id))}`);
  for (const m of r.mismatched.slice(0, 2)) {
    console.log(`    #${m.id} expected ${m.expected.slice(0, 200)}`);
    console.log(`    #${m.id} actual   ${m.actual.slice(0, 200)}`);
  }
  console.log(drift(r) === 0 ? 'OK: no drift' : `DRIFT: ${drift(r)} document(s) differ from Postgres`);
}

async function write(task: ReturnType<Index['updateDocuments']>): Promise<void> {
  const done = await task.waitTask({ timeout: 60_000 });
  if (done.status !== 'succeeded') throw new Error(`self-test write ${done.status}: ${done.error?.message}`);
}

// A checker that can't see drift is worse than none. Plant one corrupted, one missing and one extra
// document, demand that compare() finds exactly those, then put everything back and demand 0 again.
async function selfTest(db: pg.Client, index: Index): Promise<boolean> {
  if (drift(await compare(db, index)) !== 0) throw new Error('index must be in sync before the self-test');
  const pk = config.index.primaryKey;
  const { rows: [a, b] } = await db.query(`SELECT * FROM ${config.table} ORDER BY ${db.escapeIdentifier(pk)} LIMIT 2`);
  const [idA, idB] = [String(a[pk]), String(b[pk])];
  await write(index.updateDocuments([{ [pk]: idA, selftest_corrupted: true }])); // a field no row has
  await write(index.deleteDocuments([idB]));
  await write(index.updateDocuments([{ id: 'selftest-extra', name: 'not in Postgres' }]));
  const planted = await compare(db, index);
  const found = (got: string[], want: string) => got.length === 1 && got[0] === want;
  const caught = found(planted.mismatched.map((m) => m.id), idA) && found(planted.missing, idB) && found(planted.extra, 'selftest-extra');
  console.log(`self-test: planted mismatch #${idA}, missing #${idB}, extra #selftest-extra → found ` +
    `${planted.mismatched.length} mismatched, ${planted.missing.length} missing, ${planted.extra.length} extra`);

  await write(index.addDocuments([toDocument(a, config.keepColumn), toDocument(b, config.keepColumn)])); // the true rows
  await write(index.deleteDocuments(['selftest-extra']));
  const restored = drift(await compare(db, index)) === 0;
  console.log(`self-test: after restoring, drift = ${restored ? 0 : 'NOT 0'}`);
  console.log(caught && restored ? 'self-test PASSED' : 'self-test FAILED');
  return caught && restored;
}

const args = process.argv.slice(2);
const timeoutS = Number(args.find((arg) => arg.startsWith('--timeout='))?.split('=')[1] ?? 600);
const db = new pg.Client(config.pgConfig);
const meili = new Meilisearch(config.meilisearch);
const index = meili.index(config.index.uid);
try {
  await db.connect();
  console.log(`reconcile: caught up after waiting ${await waitForCatchUp(db, meili, timeoutS * 1000)} ms`);
  if (args.includes('--self-test')) {
    process.exitCode = (await selfTest(db, index)) ? 0 : 1;
  } else {
    const started = Date.now();
    const report = await compare(db, index);
    print(report, Date.now() - started);
    process.exitCode = drift(report) === 0 ? 0 : 1;
  }
} catch (err) {
  console.error(`reconcile: could not check: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
} finally {
  await db.end();
}
