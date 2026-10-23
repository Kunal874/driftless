import { describe, expect, it } from 'vitest';
import { columnFilter, parseConfig } from './config-file.ts';

const valid = () => ({
  postgres: { host: '127.0.0.1', port: 5440, user: 'driftless', database: 'shop' },
  meilisearch: { host: 'http://127.0.0.1:7700' },
  sync: { table: 'public.products', index: 'products', primaryKey: 'id' },
});

const problemsOf = (raw: unknown): string => {
  try {
    parseConfig(raw);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
};

describe('parseConfig', () => {
  it('accepts the single-table shape and returns it as a one-item list', () => {
    expect(parseConfig(valid())).toEqual({ ...valid(), sync: [valid().sync] });
  });

  it('reports every problem at once, each naming its setting', () => {
    const bad = valid() as any;
    bad.postgres.port = '5440';
    bad.sync.table = 'products';
    bad.sync.tabel = 'public.products'; // a typo of a known key
    const message = problemsOf(bad);
    expect(message).toMatch(/postgres\.port must be a whole number/);
    expect(message).toMatch(/sync\.table 'products' must be schema\.table/);
    expect(message).toMatch(/sync\.tabel: unknown setting \(expected: table, index, primaryKey, columns, redisKeyPrefix\)/);
  });

  it('refuses secrets in the file and says where they go instead', () => {
    const bad = valid() as any;
    bad.postgres.password = 'hunter2';
    bad.meilisearch.apiKey = 'k';
    expect(() => parseConfig(bad)).toThrow(/postgres\.password: secrets[\s\S]*PGPASSWORD[\s\S]*MEILI_MASTER_KEY/);
  });

  it('rejects a missing section and a non-object file', () => {
    const { sync, ...noSync } = valid();
    expect(() => parseConfig(noSync)).toThrow(/sync must be an object/);
    expect(() => parseConfig([1, 2])).toThrow(/config must be an object/);
  });

  it('checks column lists: one kind only, primary key kept, no duplicates', () => {
    const withColumns = (columns: unknown) => ({ ...valid(), sync: { ...valid().sync, columns } });
    expect(parseConfig(withColumns({ exclude: ['description'] })).sync[0]!.columns).toEqual({ exclude: ['description'] });
    expect(() => parseConfig(withColumns({ include: ['a'], exclude: ['b'] }))).toThrow(/exactly one of/);
    expect(() => parseConfig(withColumns({ include: ['name'] }))).toThrow(/must contain the primary key 'id'/);
    expect(() => parseConfig(withColumns({ exclude: ['id'] }))).toThrow(/can't contain the primary key 'id'/);
    expect(() => parseConfig(withColumns({ exclude: ['a', 'a'] }))).toThrow(/twice/);
    expect(() => parseConfig(withColumns({ exclude: 'description' }))).toThrow(/list of column names/);
  });
});

describe('parseConfig: the redis section (T12)', () => {
  const withRedis = (redis: unknown) => ({ ...valid(), redis });

  it('is optional; the single-table keyPrefix becomes that table\'s prefix', () => {
    expect(parseConfig(valid()).redis).toBeUndefined();
    const config = parseConfig(withRedis({ url: 'redis://127.0.0.1:6381', keyPrefix: 'product:' }));
    expect(config.redis).toEqual({ url: 'redis://127.0.0.1:6381' });
    expect(config.sync[0]!.redisKeyPrefix).toBe('product:');
  });

  it('refuses a password, as a key or inside the URL, pointing to REDIS_PASSWORD', () => {
    expect(() => parseConfig(withRedis({ url: 'redis://h:6379', keyPrefix: 'p:', password: 'x' })))
      .toThrow(/redis\.password: secrets[\s\S]*REDIS_PASSWORD/);
    expect(() => parseConfig(withRedis({ url: 'redis://:hunter2@h:6379', keyPrefix: 'p:' })))
      .toThrow(/redis\.url .* without credentials \(set REDIS_PASSWORD/);
  });

  it('rejects a bad URL scheme and a key prefix with glob or space characters', () => {
    expect(() => parseConfig(withRedis({ url: 'http://h:6379', keyPrefix: 'p:' }))).toThrow(/redis\.url/);
    expect(() => parseConfig(withRedis({ url: 'redis://h:6379', keyPrefix: 'p *' }))).toThrow(/redis\.keyPrefix/);
  });
});

describe('parseConfig: several tables (T13)', () => {
  const two = (extra: Record<string, unknown> = {}) => ({
    ...valid(),
    sync: [
      { table: 'public.products', index: 'products', primaryKey: 'id', redisKeyPrefix: 'product:' },
      { table: 'public.customers', index: 'customers', primaryKey: 'id', redisKeyPrefix: 'customer:' },
    ],
    redis: { url: 'redis://127.0.0.1:6381' },
    ...extra,
  });

  it('accepts a list, each table with its own index and key prefix', () => {
    const config = parseConfig(two());
    expect(config.sync.map((m) => [m.table, m.index, m.redisKeyPrefix])).toEqual([
      ['public.products', 'products', 'product:'],
      ['public.customers', 'customers', 'customer:'],
    ]);
  });

  it('gives a mapping without a prefix "<index>:"', () => {
    const config = parseConfig({ ...valid(), sync: [{ table: 'public.a', index: 'alpha', primaryKey: 'id' }], redis: { url: 'redis://h:1' } });
    expect(config.sync[0]!.redisKeyPrefix).toBe('alpha:');
  });

  it('names a bad entry by its position', () => {
    const bad = two();
    (bad.sync[1] as any).table = 'Customers';
    expect(problemsOf(bad)).toMatch(/sync\[1\]\.table 'Customers' must be schema\.table/);
  });

  it('rejects a repeated table or index, overlapping prefixes, an empty list', () => {
    const repeated = two();
    repeated.sync[1]!.table = 'public.products';
    repeated.sync[1]!.index = 'products';
    const message = problemsOf(repeated);
    expect(message).toMatch(/table public\.products is listed twice/);
    expect(message).toMatch(/index products is used twice/);

    const overlap = two();
    overlap.sync[1]!.redisKeyPrefix = 'product:x:';
    expect(problemsOf(overlap)).toMatch(/key prefix 'product:x:' overlaps 'product:'/);

    expect(problemsOf({ ...valid(), sync: [] })).toMatch(/sync must name at least one table/);
  });

  it('refuses the single-table redis.keyPrefix with several tables, and a prefix without Redis', () => {
    expect(problemsOf(two({ redis: { url: 'redis://h:1', keyPrefix: 'x:' } }))).toMatch(/redis\.keyPrefix works for one table only/);
    const { redis, ...noRedis } = two();
    expect(problemsOf(noRedis)).toMatch(/redisKeyPrefix needs a redis section/);
  });
});

describe('columnFilter', () => {
  it('keeps everything, an allow-list, or everything but a deny-list', () => {
    expect(['id', 'x'].filter(columnFilter(undefined))).toEqual(['id', 'x']);
    expect(['id', 'name', 'x'].filter(columnFilter({ include: ['id', 'name'] }))).toEqual(['id', 'name']);
    expect(['id', 'name', 'x'].filter(columnFilter({ exclude: ['x'] }))).toEqual(['id', 'name']);
  });
});
