// The config file (T10.1): where to connect, and what to sync where. Validated in full before anything starts, so a
// typo stops Driftless with a message that names it instead of streaming into the wrong place. Every problem is
// reported at once, not one per attempt. Pure (no file or env access), so it's unit-tested directly.
export type Columns = { include: string[] } | { exclude: string[] };
export type FileConfig = {
  postgres: { host: string; port: number; user: string; database: string };
  meilisearch: { host: string };
  sync: { table: string; index: string; primaryKey: string; columns?: Columns };
};

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

// Secrets go in environment variables, never in a file that might be committed.
const SECRETS: Record<string, string> = { password: 'PGPASSWORD', apiKey: 'MEILI_MASTER_KEY', masterKey: 'MEILI_MASTER_KEY' };

export function parseConfig(raw: unknown): FileConfig {
  const problems: string[] = [];

  const object = (value: unknown, where: string, keys: string[]): Obj => {
    if (!isObj(value)) {
      problems.push(`${where} must be an object`);
      return {};
    }
    for (const key of Object.keys(value)) {
      if (keys.includes(key)) continue;
      problems.push(key in SECRETS
        ? `${where}.${key}: secrets don't belong in the config file; set ${SECRETS[key]} instead`
        : `${where}.${key}: unknown setting (expected: ${keys.join(', ')})`);
    }
    return value;
  };
  const text = (obj: Obj, key: string, where: string, pattern?: RegExp, rule?: string): string => {
    const value = obj[key];
    if (typeof value !== 'string' || value === '') problems.push(`${where}.${key} must be a non-empty string`);
    else if (pattern && !pattern.test(value)) problems.push(`${where}.${key} '${value}' ${rule}`);
    return value as string;
  };

  const root = object(raw, 'config', ['postgres', 'meilisearch', 'sync']);

  const pg = object(root.postgres, 'postgres', ['host', 'port', 'user', 'database']);
  if (!Number.isInteger(pg.port) || (pg.port as number) < 1 || (pg.port as number) > 65535) {
    problems.push('postgres.port must be a whole number from 1 to 65535');
  }
  const postgres = {
    host: text(pg, 'host', 'postgres'),
    port: pg.port as number,
    user: text(pg, 'user', 'postgres'),
    database: text(pg, 'database', 'postgres'),
  };

  const meili = object(root.meilisearch, 'meilisearch', ['host']);
  const meilisearch = { host: text(meili, 'host', 'meilisearch', /^https?:\/\/\S+$/, 'must be an http:// or https:// URL') };

  const s = object(root.sync, 'sync', ['table', 'index', 'primaryKey', 'columns']);
  const sync: FileConfig['sync'] = {
    // ponytail: unquoted lower-case names only (what Postgres folds names to); quoted mixed-case names would need quoting rules.
    table: text(s, 'table', 'sync', /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/, 'must be schema.table in lower case, e.g. public.products'),
    index: text(s, 'index', 'sync', /^[A-Za-z0-9_-]{1,400}$/, 'may only use letters, digits, - and _ (a Meilisearch index uid)'),
    primaryKey: text(s, 'primaryKey', 'sync'), // checked against the real table at start (checkSync)
  };
  if (s.columns !== undefined) {
    const c = object(s.columns, 'sync.columns', ['include', 'exclude']);
    const kinds = (['include', 'exclude'] as const).filter((kind) => c[kind] !== undefined);
    const names = c[kinds[0]!];
    if (kinds.length !== 1) problems.push('sync.columns must have exactly one of: include, exclude');
    else if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || n === '')) {
      problems.push(`sync.columns.${kinds[0]} must be a list of column names`);
    } else if (new Set(names).size !== names.length) problems.push(`sync.columns.${kinds[0]} lists a column twice`);
    else if (kinds[0] === 'include' && !names.includes(sync.primaryKey)) {
      problems.push(`sync.columns.include must contain the primary key '${sync.primaryKey}': it's the document id`);
    } else if (kinds[0] === 'exclude' && names.includes(sync.primaryKey)) {
      problems.push(`sync.columns.exclude can't contain the primary key '${sync.primaryKey}': it's the document id`);
    } else sync.columns = kinds[0] === 'include' ? { include: names } : { exclude: names };
  }

  if (problems.length > 0) throw new Error(`invalid config:\n  - ${problems.join('\n  - ')}`);
  return { postgres, meilisearch, sync };
}

// Which row columns become document fields.
export function columnFilter(columns: Columns | undefined): (column: string) => boolean {
  if (!columns) return () => true;
  if ('include' in columns) {
    const keep = new Set(columns.include);
    return (column) => keep.has(column);
  }
  const drop = new Set(columns.exclude);
  return (column) => !drop.has(column);
}
