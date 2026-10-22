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
export const tables = [table];

// Pipeline tuning (T06): how many ordered lanes apply changes in parallel, and the most changes one
// Meilisearch write may carry.
export const lanes = Number(process.env.DRIFTLESS_LANES ?? 8);
export const batchMax = Number(process.env.DRIFTLESS_BATCH_MAX ?? 500);
if (!(Number.isInteger(lanes) && lanes >= 1 && Number.isInteger(batchMax) && batchMax >= 1)) {
  throw new Error(`DRIFTLESS_LANES and DRIFTLESS_BATCH_MAX must be whole numbers ≥ 1 (got ${lanes}, ${batchMax})`);
}

// Print every transaction as it's dispatched: noisy at high rates, handy when debugging.
export const logTransactions = process.env.DRIFTLESS_LOG_TXNS === '1';

// Crash-test knob: wait this long after handling a transaction before acking it,
// so a test can kill the process inside that window (T03.4, T04.4).
export const debugAckDelayMs = Number(process.env.DRIFTLESS_DEBUG_ACK_DELAY_MS ?? 0);
