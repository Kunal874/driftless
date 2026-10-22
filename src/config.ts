import type { ClientConfig } from 'pg';

// Local-dev defaults (docker-compose.yml); the standard PG* environment variables override them.
export const pgConfig: ClientConfig = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5440),
  user: process.env.PGUSER ?? 'driftless',
  password: process.env.PGPASSWORD ?? 'driftless',
  database: process.env.PGDATABASE ?? 'shop',
};

export const meilisearch = {
  host: process.env.MEILI_HOST ?? 'http://127.0.0.1:7700',
  apiKey: process.env.MEILI_MASTER_KEY ?? 'driftless-dev-master-key',
};

export const publication = 'driftless_pub';
export const slot = 'driftless_slot';

// The table Driftless mirrors and the index it mirrors into (T10 moves this into a config file).
export const table = 'public.products';
export const index = { uid: 'products', primaryKey: 'id' };

// Driftless's own one-row table for backfill watermarks (T07, D-023). It's in the publication so the marks
// travel through the WAL in commit order; Driftless creates it if it's missing.
export const watermarkTable = 'public.driftless_watermark';
export const tables = [table, watermarkTable]; // everything the publication must stream
// Driftless's own progress notes (backfill position). NOT published: its writes never echo back.
export const stateTable = 'public.driftless_state';

// Pipeline tuning (T06): how many ordered lanes apply changes in parallel, and the most changes one
// Meilisearch write may carry. Defaults from the T06.4 benchmarks (docs/RESULTS.md §4).
export const lanes = Number(process.env.DRIFTLESS_LANES ?? 8);
export const batchMax = Number(process.env.DRIFTLESS_BATCH_MAX ?? 5000);
if (!(Number.isInteger(lanes) && lanes >= 1 && Number.isInteger(batchMax) && batchMax >= 1)) {
  throw new Error(`DRIFTLESS_LANES and DRIFTLESS_BATCH_MAX must be whole numbers ≥ 1 (got ${lanes}, ${batchMax})`);
}

// Backfill (T07): index the rows that existed before Driftless started, while streaming continues.
export const backfill = {
  // 1 = start a backfill on start (resumed instead if one was interrupted). Without it, one starts by itself
  // when the index is empty but the table isn't. To force a fresh one: delete the 'backfill' row from
  // driftless_state and start with this set.
  enabled: process.env.DRIFTLESS_BACKFILL === '1',
  chunk: Number(process.env.DRIFTLESS_BACKFILL_CHUNK ?? 1000), // rows read per chunk
  // Race-test knob: wait this long between reading a chunk and writing it (T07.2).
  debugDelayMs: Number(process.env.DRIFTLESS_BACKFILL_DEBUG_DELAY_MS ?? 0),
};

// Print every transaction as it's dispatched: noisy at high rates, handy when debugging.
export const logTransactions = process.env.DRIFTLESS_LOG_TXNS === '1';

// Crash-test knob: wait this long after handling a transaction before acking it,
// so a test can kill the process inside that window (T03.4, T04.4).
export const debugAckDelayMs = Number(process.env.DRIFTLESS_DEBUG_ACK_DELAY_MS ?? 0);
