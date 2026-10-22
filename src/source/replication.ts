import type { Client } from 'pg';

type Setup = { publication: string; slot: string; tables: string[]; watermarkTable: string };

// Gets Postgres ready for streaming, and is safe to run on every start: checks the settings Driftless
// depends on, then creates the watermark table, the publication and the slot only if they're missing.
// Returns the slot's confirmed position: everything before it has already been handled.
export async function ensureReplicationSetup(db: Client, { publication, slot, tables, watermarkTable }: Setup): Promise<string> {
  const { rows: [wal] } = await db.query<{ wal_level: string }>('SHOW wal_level');
  if (wal.wal_level !== 'logical') {
    throw new Error(`wal_level is '${wal.wal_level}' but must be 'logical' (see docker-compose.yml)`);
  }

  const qualified = (table: string) => table.split('.').map((part) => db.escapeIdentifier(part)).join('.');
  // Driftless's own one-row table: backfill watermarks are updates to it (D-023).
  await db.query(`CREATE TABLE IF NOT EXISTS ${qualified(watermarkTable)} (id int PRIMARY KEY, mark text NOT NULL)`);
  await db.query(`INSERT INTO ${qualified(watermarkTable)} VALUES (1, '') ON CONFLICT (id) DO NOTHING`);

  for (const table of tables) await checkTable(db, table);

  const existing = await db.query('SELECT 1 FROM pg_publication WHERE pubname = $1', [publication]);
  if (existing.rowCount === 0) {
    // Default `publish` list = insert, update, delete, truncate: TRUNCATE is handled, not ignored (D-018).
    await db.query(`CREATE PUBLICATION ${db.escapeIdentifier(publication)} FOR TABLE ${tables.map(qualified).join(', ')}`);
  }
  const { rows: published } = await db.query<{ name: string }>(
    `SELECT schemaname || '.' || tablename AS name FROM pg_publication_tables WHERE pubname = $1`,
    [publication],
  );
  // It's Driftless's own publication, so a table it now needs (e.g. the watermark table, added in T07) is added.
  for (const table of tables.filter((t) => !published.some((p) => p.name === t))) {
    await db.query(`ALTER PUBLICATION ${db.escapeIdentifier(publication)} ADD TABLE ${qualified(table)}`);
  }

  // The slot comes after the publication, so it never sees changes from before the publication existed.
  // A new slot starts at the current WAL position: rows that already exist are NOT streamed (backfill, T07).
  const query = 'SELECT plugin, confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name = $1';
  let { rows: [found] } = await db.query<{ plugin: string; confirmed_flush_lsn: string }>(query, [slot]);
  if (!found) {
    await db.query(`SELECT pg_create_logical_replication_slot($1, 'pgoutput')`, [slot]);
    ({ rows: [found] } = await db.query(query, [slot]));
  }
  if (found.plugin !== 'pgoutput') {
    throw new Error(`slot ${slot} uses plugin '${found.plugin}', expected 'pgoutput'`);
  }
  return found.confirmed_flush_lsn;
}

// Driftless needs exactly one primary-key column per table: its value becomes the document id, and
// logical replication uses it to say which row an UPDATE or DELETE touched.
async function checkTable(db: Client, table: string): Promise<void> {
  const { rows: [info] } = await db.query<{ replident: string; pk_columns: number | null }>(
    `SELECT c.relreplident::text AS replident,
            (SELECT i.indnkeyatts FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS pk_columns
     FROM pg_class c
     WHERE c.oid = to_regclass($1)`,
    [table],
  );
  if (!info) throw new Error(`table ${table} not found`);
  if (info.pk_columns === null) throw new Error(`table ${table} has no primary key`);
  // ponytail: single-column keys only; composite keys need an id-joining rule for Meilisearch.
  if (info.pk_columns !== 1) throw new Error(`table ${table}: composite primary keys aren't supported yet`);
  // d = default (primary key), f = full row. "nothing"/"index" would hide which row changed.
  if (info.replident !== 'd' && info.replident !== 'f') {
    throw new Error(`table ${table}: REPLICA IDENTITY must be DEFAULT or FULL (is '${info.replident}')`);
  }
}
