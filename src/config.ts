import { readFileSync } from 'node:fs';
import type { ClientConfig } from 'pg';
import { columnFilter, parseConfig } from './config-file.ts';

// What to sync where, and where to connect: the config file (T10.1, validated by parseConfig). The repo's
// driftless.config.json holds the local-dev values; DRIFTLESS_CONFIG points to another file.
export const configPath = process.env.DRIFTLESS_CONFIG ?? 'driftless.config.json';
const file = (() => {
  try {
    return parseConfig(readConfigFile(configPath));
  } catch (err) {
    configError(err);
  }
})();

// A configuration mistake isn't a crash: print just the message (no stack trace) and exit with 2.
export function configError(err: unknown): never {
  console.error(`driftless: ${(err as Error).message}\n(config file: ${configPath})`);
  process.exit(2);
}

function readConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`can't read the config file (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); run from the repo root or set DRIFTLESS_CONFIG`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`the config file isn't valid JSON: ${(err as Error).message}`);
  }
}

// The standard PG* environment variables override the file. Passwords never come from the file: the defaults below
// are the local-dev ones from docker-compose.yml.
export const pgConfig: ClientConfig = {
  host: process.env.PGHOST ?? file.postgres.host,
  port: Number(process.env.PGPORT ?? file.postgres.port),
  user: process.env.PGUSER ?? file.postgres.user,
  password: process.env.PGPASSWORD ?? 'driftless',
  database: process.env.PGDATABASE ?? file.postgres.database,
};
if (!Number.isInteger(pgConfig.port)) throw new Error(`PGPORT must be a whole number (got '${process.env.PGPORT}')`);

export const meilisearch = {
  host: process.env.MEILI_HOST ?? file.meilisearch.host,
  apiKey: process.env.MEILI_MASTER_KEY ?? 'driftless-dev-master-key',
};

// The Redis cache (T12, D-029): on when the file has a `redis` section. REDIS_URL overrides its URL (compose points the
// connector at redis:6379); the password, if any, comes only from REDIS_PASSWORD.
export const redis = file.redis && {
  url: process.env.REDIS_URL ?? file.redis.url,
  password: process.env.REDIS_PASSWORD || undefined,
  keyPrefix: file.redis.keyPrefix,
};

export const publication = 'driftless_pub';
export const slot = 'driftless_slot';

// The table Driftless mirrors, the index it mirrors into, and which columns become document fields.
export const table = file.sync.table;
export const index = { uid: file.sync.index, primaryKey: file.sync.primaryKey };
export const keepColumn = columnFilter(file.sync.columns);
export const namedColumns = file.sync.columns ? Object.values(file.sync.columns)[0]! : []; // checked against the table

// Driftless's own one-row table for backfill watermarks (T07, D-023). It's in the publication so the marks
// travel through the WAL in commit order; Driftless creates it if it's missing.
export const watermarkTable = 'public.driftless_watermark';
export const tables = [table, watermarkTable]; // everything the publication must stream
// Driftless's own progress notes (backfill position). NOT published: its writes never echo back.
export const stateTable = 'public.driftless_state';

// Pipeline tuning (T06): how many ordered lanes apply changes in parallel, and the most changes one
// Meilisearch write may carry. Defaults from the T06.4 benchmarks (docs/RESULTS.md §4). 8 lanes drain a backlog
// fastest; 1 lane gives the lowest steady lag on Meilisearch (D-027, RESULTS.md §9).
export const lanes = Number(process.env.DRIFTLESS_LANES ?? 8);
export const batchMax = Number(process.env.DRIFTLESS_BATCH_MAX ?? 5000);
if (!(Number.isInteger(lanes) && lanes >= 1 && Number.isInteger(batchMax) && batchMax >= 1)) {
  throw new Error(`DRIFTLESS_LANES and DRIFTLESS_BATCH_MAX must be whole numbers ≥ 1 (got ${lanes}, ${batchMax})`);
}

// Prometheus metrics at http://HOST:PORT/metrics (T09). Localhost by default; the compose service listens on all
// interfaces inside its container so the Prometheus container can reach it.
export const metricsServer = {
  host: process.env.DRIFTLESS_METRICS_HOST ?? '127.0.0.1',
  port: Number(process.env.DRIFTLESS_METRICS_PORT ?? 9464),
};

// Backpressure (T08, D-025): stop reading the stream once this many changes are waiting inside Driftless
// (stream messages not yet dispatched + changes queued in lanes); resume at half.
export const maxPending = Number(process.env.DRIFTLESS_MAX_PENDING ?? 50_000);
if (!(Number.isInteger(maxPending) && maxPending >= 2)) {
  throw new Error(`DRIFTLESS_MAX_PENDING must be a whole number ≥ 2 (got ${maxPending})`);
}

// Backfill (T07): index the rows that existed before Driftless started, while streaming continues.
export const backfill = {
  // 1 = start a backfill on start (resumed instead if one was interrupted). Without it, one starts by itself
  // when the index is empty but the table isn't. To force a fresh one: delete the 'backfill' row from
  // driftless_state and start with this set.
  enabled: process.env.DRIFTLESS_BACKFILL === '1',
  // Rows read per chunk. Each chunk costs about the same fixed overhead (two marks + ~1 write per lane), so
  // bigger is faster: 105k rows took 104 s with 1,000, 23 s with 5,000, 14 s with 10,000 (RESULTS.md §5).
  chunk: Number(process.env.DRIFTLESS_BACKFILL_CHUNK ?? 10_000),
  // Race-test knob: wait this long between reading a chunk and writing it (T07.2).
  debugDelayMs: Number(process.env.DRIFTLESS_BACKFILL_DEBUG_DELAY_MS ?? 0),
};

// Print every transaction as it's dispatched: noisy at high rates, handy when debugging.
export const logTransactions = process.env.DRIFTLESS_LOG_TXNS === '1';

// Crash-test knob: wait this long after handling a transaction before acking it,
// so a test can kill the process inside that window (T03.4, T04.4).
export const debugAckDelayMs = Number(process.env.DRIFTLESS_DEBUG_ACK_DELAY_MS ?? 0);
