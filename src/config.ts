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

// Crash-test knob: wait this long after handling a transaction before acking it,
// so a test can kill the process inside that window (T03.4, T04.4).
export const debugAckDelayMs = Number(process.env.DRIFTLESS_DEBUG_ACK_DELAY_MS ?? 0);
