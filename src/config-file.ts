// The config file (T10.1): where to connect, and what to sync where. Validated in full before anything starts, so a
// typo stops Driftless with a message that names it instead of streaming into the wrong place. Every problem is
// reported at once, not one per attempt. Pure (no file or env access), so it's unit-tested directly.
export type Columns = { include: string[] } | { exclude: string[] };
// One table mirrored into one index (and, with Redis, one key prefix). `sync` holds one or several (T13).
export type Mapping = { table: string; index: string; primaryKey: string; columns?: Columns; redisKeyPrefix?: string };
export type FileConfig = {
  postgres: { host: string; port: number; user: string; database: string };
  meilisearch: { host: string };
  sync: Mapping[]; // with Redis configured, every mapping has its redisKeyPrefix filled in
  redis?: { url: string }; // the cache (T12); absent = Meilisearch only
};

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

// Secrets go in environment variables, never in a file that might be committed.
const SECRETS: Record<string, string> = {
  'postgres.password': 'PGPASSWORD',
  'meilisearch.apiKey': 'MEILI_MASTER_KEY',
  'meilisearch.masterKey': 'MEILI_MASTER_KEY',
  'redis.password': 'REDIS_PASSWORD',
};
const PREFIX = /^[A-Za-z0-9_:.-]{1,64}$/;
const PREFIX_RULE = 'may only use letters, digits and _ : . -';

export function parseConfig(raw: unknown): FileConfig {
  const problems: string[] = [];

  const object = (value: unknown, where: string, keys: string[]): Obj => {
    if (!isObj(value)) {
      problems.push(`${where} must be an object`);
      return {};
    }
    for (const key of Object.keys(value)) {
      if (keys.includes(key)) continue;
      const secret = SECRETS[`${where}.${key}`];
      problems.push(secret
        ? `${where}.${key}: secrets don't belong in the config file; set ${secret} instead`
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

  const root = object(raw, 'config', ['postgres', 'meilisearch', 'sync', 'redis']);

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

  // `sync` is one mapping (as before T13) or a list of them.
  const list = Array.isArray(root.sync) ? root.sync : [root.sync];
  if (list.length === 0) problems.push('sync must name at least one table');
  const sync = list.map((item, i) => mapping(item, Array.isArray(root.sync) ? `sync[${i}]` : 'sync'));

  function mapping(item: unknown, where: string): Mapping {
    const s = object(item, where, ['table', 'index', 'primaryKey', 'columns', 'redisKeyPrefix']);
    const m: Mapping = {
      // ponytail: unquoted lower-case names only (what Postgres folds names to); quoted mixed-case names would need quoting rules.
      table: text(s, 'table', where, /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/, 'must be schema.table in lower case, e.g. public.products'),
      index: text(s, 'index', where, /^[A-Za-z0-9_-]{1,400}$/, 'may only use letters, digits, - and _ (a Meilisearch index uid)'),
      primaryKey: text(s, 'primaryKey', where), // checked against the real table at start (checkSync)
    };
    if (s.redisKeyPrefix !== undefined) m.redisKeyPrefix = text(s, 'redisKeyPrefix', where, PREFIX, PREFIX_RULE);
    if (s.columns !== undefined) {
      const c = object(s.columns, `${where}.columns`, ['include', 'exclude']);
      const kinds = (['include', 'exclude'] as const).filter((kind) => c[kind] !== undefined);
      const names = c[kinds[0]!];
      if (kinds.length !== 1) problems.push(`${where}.columns must have exactly one of: include, exclude`);
      else if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || n === '')) {
        problems.push(`${where}.columns.${kinds[0]} must be a list of column names`);
      } else if (new Set(names).size !== names.length) problems.push(`${where}.columns.${kinds[0]} lists a column twice`);
      else if (kinds[0] === 'include' && !names.includes(m.primaryKey)) {
        problems.push(`${where}.columns.include must contain the primary key '${m.primaryKey}': it's the document id`);
      } else if (kinds[0] === 'exclude' && names.includes(m.primaryKey)) {
        problems.push(`${where}.columns.exclude can't contain the primary key '${m.primaryKey}': it's the document id`);
      } else m.columns = kinds[0] === 'include' ? { include: names } : { exclude: names };
    }
    return m;
  }

  let redis: FileConfig['redis'];
  if (root.redis !== undefined) {
    const r = object(root.redis, 'redis', ['url', 'keyPrefix']);
    redis = {
      url: text(r, 'url', 'redis', /^rediss?:\/\/[^\s@]+$/,
        'must be a redis:// or rediss:// URL without credentials (set REDIS_PASSWORD instead)'),
    };
    // `redis.keyPrefix` is the single-table form (T12); with several tables each mapping names its own.
    if (r.keyPrefix !== undefined) {
      const legacy = text(r, 'keyPrefix', 'redis', PREFIX, PREFIX_RULE);
      if (sync.length > 1) problems.push('redis.keyPrefix works for one table only; give each sync entry its own redisKeyPrefix');
      else if (sync[0]?.redisKeyPrefix !== undefined) problems.push('set the key prefix in one place: redis.keyPrefix or sync.redisKeyPrefix');
      else if (sync[0]) sync[0].redisKeyPrefix = legacy;
    }
    for (const m of sync) m.redisKeyPrefix ??= `${m.index}:`;
  } else if (sync.some((m) => m.redisKeyPrefix !== undefined)) {
    problems.push('redisKeyPrefix needs a redis section (the cache is off without one)');
  }

  // Each table, index and key prefix belongs to one mapping. A prefix that starts another would make clearing one
  // table's keys (SCAN MATCH prefix*) delete the other's.
  const duplicates = (values: string[]) => values.filter((v, i) => values.indexOf(v) !== i);
  for (const t of new Set(duplicates(sync.map((m) => m.table)))) problems.push(`sync: table ${t} is listed twice`);
  for (const ix of new Set(duplicates(sync.map((m) => m.index)))) problems.push(`sync: index ${ix} is used twice`);
  const prefixes = sync.flatMap((m) => m.redisKeyPrefix ?? []);
  for (const [i, a] of prefixes.entries()) {
    for (const [j, b] of prefixes.entries()) {
      if (i !== j && b.startsWith(a) && (a !== b || i < j)) problems.push(`sync: key prefix '${b}' overlaps '${a}'`);
    }
  }

  if (problems.length > 0) throw new Error(`invalid config:\n  - ${problems.join('\n  - ')}`);
  return { postgres, meilisearch, sync, ...(redis && { redis }) };
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
