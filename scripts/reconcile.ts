// Proves (or disproves) "zero drift". Waits until Driftless has caught up, then compares every Postgres row with
// its Meilisearch document AND, when the config has a Redis cache, its Redis hash (T12), using the same mapping the
// sinks use (src/sinks/document.ts). Postgres is read once; every chunk is checked against every target.
// The connector must be running: its idle confirms are how "caught up" becomes visible.
//
// Usage: node scripts/reconcile.ts [--timeout=SECONDS] [--self-test]
// Exit code: 0 = identical, 1 = drift (or self-test failed), 2 = couldn't check.
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { Meilisearch, type Index } from 'meilisearch';
import { createClient } from '@redis/client';
import * as config from '../src/config.ts';
import { toDocument, type Document } from '../src/sinks/document.ts';
import { encode, escapeGlob, type RedisClient } from '../src/sinks/redis.ts';
import { lsnToBigInt } from '../src/source/lsn.ts';

const CHUNK = 1000;
const SAMPLES = 5;
const pk = config.index.primaryKey;

type Report = {
  rows: number;
  documents: number;
  missing: string[]; // row exists, document doesn't
  extra: string[]; // document exists, row doesn't
  mismatched: { id: string; expected: string; actual: string }[];
};

// Something reconcile compares with Postgres: the index, or the Redis cache.
type Target = {
  name: string;
  unit: string; // what it holds per row: documents, keys
  get(ids: string[]): Promise<Map<string, Document>>; // only the ids it has
  ids(): Promise<Set<string>>; // every id it holds
  count(): Promise<number>;
  // For the self-test: plant drift, then put the truth back.
  corrupt(id: string): Promise<void>; // add a field no row has
  remove(ids: string[]): Promise<void>;
  replace(docs: Document[]): Promise<void>; // whole documents, replacing whatever is there
};

// Field order doesn't matter, values do: compare documents as JSON with sorted keys.
const canonical = (doc: Document) => JSON.stringify(Object.fromEntries(Object.entries(doc).sort(([a], [b]) => a.localeCompare(b))));

async function write(task: ReturnType<Index['updateDocuments']>): Promise<void> {
  const done = await task.waitTask({ timeout: 60_000 });
  if (done.status !== 'succeeded') throw new Error(`self-test write ${done.status}: ${done.error?.message}`);
}

function meilisearchTarget(index: Index): Target {
  return {
    name: 'meilisearch',
    unit: 'documents',
    async get(ids) {
      const { results } = await index.getDocuments({ ids, limit: ids.length });
      return new Map(results.map((doc) => [String(doc[pk]), doc]));
    },
    async ids() {
      const all = new Set<string>();
      for (let offset = 0; ; offset += CHUNK) {
        const { results } = await index.getDocuments({ fields: [pk], limit: CHUNK, offset });
        if (results.length === 0) return all;
        for (const doc of results) all.add(String(doc[pk]));
      }
    },
    count: async () => (await index.getStats()).numberOfDocuments,
    corrupt: (id) => write(index.updateDocuments([{ [pk]: id, selftest_corrupted: true }])),
    remove: (ids) => write(index.deleteDocuments(ids)),
    replace: (docs) => write(index.addDocuments(docs)),
  };
}

function redisTarget(client: RedisClient, prefix: string): Target {
  const key = (id: string) => prefix + id;
  const decode = (hash: Record<string, string>): Document =>
    Object.fromEntries(Object.entries(hash).map(([field, value]) => [field, JSON.parse(value)]));
  const ids = async () => {
    const all = new Set<string>(); // a Set: SCAN may return a key more than once
    let cursor = '0';
    do {
      const page = await client.scan(cursor, { MATCH: `${escapeGlob(prefix)}*`, COUNT: 1000 });
      cursor = page.cursor;
      for (const k of page.keys) all.add(k.slice(prefix.length));
    } while (cursor !== '0');
    return all;
  };
  return {
    name: 'redis',
    unit: 'keys',
    async get(chunk) {
      // Issued in the same tick, so the client sends them as one pipeline.
      const hashes = (await Promise.all(chunk.map((id) => client.hGetAll(key(id))))) as Record<string, string>[];
      return new Map(chunk.flatMap((id, i) => (Object.keys(hashes[i]!).length > 0 ? [[id, decode(hashes[i]!)] as const] : [])));
    },
    ids,
    count: async () => (await ids()).size,
    corrupt: async (id) => void (await client.hSet(key(id), 'selftest_corrupted', 'true')),
    remove: async (gone) => void (await client.del(gone.map(key))),
    async replace(docs) {
      const multi = client.multi();
      for (const doc of docs) multi.del(key(String(doc[pk]))).hSet(key(String(doc[pk])), encode(doc));
      await multi.exec();
    },
  };
}

// Caught up = the slot has confirmed everything up to the WAL position at the moment we started waiting, and
// Meilisearch has no write left in its queue. (Redis applies writes before replying, so it has no queue to wait for;
// and a transaction is confirmed only once every sink has it, D-029.)
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

async function compare(db: pg.Client, targets: Target[]): Promise<Map<Target, Report>> {
  const reports = new Map(targets.map((t): [Target, Report] => [t, { rows: 0, documents: 0, missing: [], extra: [], mismatched: [] }]));
  const table = config.table.split('.').map((part) => db.escapeIdentifier(part)).join('.');
  const pkColumn = db.escapeIdentifier(pk);
  const ids = new Set<string>(); // ponytail: every id in memory (~50 MB per million rows); fine for a checker
  let last: string | null = null;
  for (;;) {
    // Keyset pagination: "rows after the last id seen", which stays fast at any table size.
    const { rows }: { rows: Record<string, unknown>[] } = await db.query(
      `SELECT * FROM ${table} WHERE $1::text IS NULL OR ${pkColumn} > $1::bigint ORDER BY ${pkColumn} LIMIT ${CHUNK}`,
      [last],
    );
    if (rows.length === 0) break;
    const chunkIds: string[] = rows.map((row) => String(row[pk]));
    for (const id of chunkIds) ids.add(id);
    for (const [target, report] of reports) {
      const documents = await target.get(chunkIds);
      for (const [i, row] of rows.entries()) {
        const id = chunkIds[i]!;
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
    }
    last = chunkIds.at(-1)!;
  }
  for (const [target, report] of reports) {
    report.documents = await target.count();
    // Every document that matched a row is accounted for; any surplus means documents without a row.
    if (report.documents > report.rows - report.missing.length) {
      for (const id of await target.ids()) if (!ids.has(id)) report.extra.push(id);
    }
  }
  return reports;
}

const drift = (r: Report) => r.missing.length + r.extra.length + r.mismatched.length;
const totalDrift = (reports: Map<Target, Report>) => [...reports.values()].reduce((sum, r) => sum + drift(r), 0);

function print(reports: Map<Target, Report>, ms: number): void {
  const sample = (ids: string[]) => (ids.length ? ` (e.g. ${ids.slice(0, SAMPLES).join(', ')})` : '');
  for (const [target, r] of reports) {
    console.log(`reconcile: ${r.rows} rows vs ${r.documents} ${target.unit} in ${target.name}`);
    console.log(`  missing ${target.unit}:    ${r.missing.length}${sample(r.missing)}`);
    console.log(`  extra ${target.unit}:      ${r.extra.length}${sample(r.extra)}`);
    console.log(`  mismatched ${target.unit}: ${r.mismatched.length}${sample(r.mismatched.map((m) => m.id))}`);
    for (const m of r.mismatched.slice(0, 2)) {
      console.log(`    #${m.id} expected ${m.expected.slice(0, 200)}`);
      console.log(`    #${m.id} actual   ${m.actual.slice(0, 200)}`);
    }
  }
  console.log(`reconcile: compared in ${ms} ms`);
  const total = totalDrift(reports);
  console.log(total === 0 ? 'OK: no drift' : `DRIFT: ${total} document(s)/key(s) differ from Postgres`);
}

// A checker that can't see drift is worse than none. In every target, plant one corrupted, one missing and one extra
// entry, demand that compare() finds exactly those, then put everything back and demand 0 again.
async function selfTest(db: pg.Client, targets: Target[]): Promise<boolean> {
  if (totalDrift(await compare(db, targets)) !== 0) throw new Error('every target must be in sync before the self-test');
  const { rows: [a, b] } = await db.query(`SELECT * FROM ${config.table} ORDER BY ${db.escapeIdentifier(pk)} LIMIT 2`);
  const [idA, idB] = [String(a[pk]), String(b[pk])];
  for (const target of targets) {
    await target.corrupt(idA);
    await target.remove([idB]);
    await target.replace([{ [pk]: 'selftest-extra', name: 'not in Postgres' }]);
  }
  const planted = await compare(db, targets);
  const found = (got: string[], want: string) => got.length === 1 && got[0] === want;
  let caught = true;
  for (const [target, r] of planted) {
    const ok = found(r.mismatched.map((m) => m.id), idA) && found(r.missing, idB) && found(r.extra, 'selftest-extra');
    caught &&= ok;
    console.log(`self-test (${target.name}): planted mismatch #${idA}, missing #${idB}, extra #selftest-extra → found ` +
      `${r.mismatched.length} mismatched, ${r.missing.length} missing, ${r.extra.length} extra`);
  }
  for (const target of targets) {
    await target.replace([toDocument(a, config.keepColumn), toDocument(b, config.keepColumn)]); // the true rows
    await target.remove(['selftest-extra']);
  }
  const restored = totalDrift(await compare(db, targets)) === 0;
  console.log(`self-test: after restoring, drift = ${restored ? 0 : 'NOT 0'}`);
  console.log(caught && restored ? 'self-test PASSED' : 'self-test FAILED');
  return caught && restored;
}

const args = process.argv.slice(2);
const timeoutS = Number(args.find((arg) => arg.startsWith('--timeout='))?.split('=')[1] ?? 600);
const db = new pg.Client(config.pgConfig);
const meili = new Meilisearch(config.meilisearch);
const redis = config.redis ? createClient({ url: config.redis.url, password: config.redis.password }) : undefined;
redis?.on('error', () => {}); // a failed command rejects anyway; reconcile then exits with 2
try {
  await db.connect();
  await redis?.connect();
  const targets = [meilisearchTarget(meili.index(config.index.uid))];
  if (redis && config.redis) targets.push(redisTarget(redis, config.redis.keyPrefix));
  console.log(`reconcile: caught up after waiting ${await waitForCatchUp(db, meili, timeoutS * 1000)} ms`);
  if (args.includes('--self-test')) {
    process.exitCode = (await selfTest(db, targets)) ? 0 : 1;
  } else {
    const started = Date.now();
    const reports = await compare(db, targets);
    print(reports, Date.now() - started);
    process.exitCode = totalDrift(reports) === 0 ? 0 : 1;
  }
} catch (err) {
  console.error(`reconcile: could not check: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
} finally {
  await db.end();
  if (redis?.isOpen) await redis.quit();
}
