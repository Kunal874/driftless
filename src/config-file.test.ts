import { describe, expect, it } from 'vitest';
import { columnFilter, parseConfig } from './config-file.ts';

const valid = () => ({
  postgres: { host: '127.0.0.1', port: 5440, user: 'driftless', database: 'shop' },
  meilisearch: { host: 'http://127.0.0.1:7700' },
  sync: { table: 'public.products', index: 'products', primaryKey: 'id' },
});

describe('parseConfig', () => {
  it('accepts the shipped shape', () => {
    expect(parseConfig(valid())).toEqual(valid());
  });

  it('reports every problem at once, each naming its setting', () => {
    const bad = valid() as any;
    bad.postgres.port = '5440';
    bad.sync.table = 'products';
    bad.sync.tabel = 'public.products'; // a typo of a known key
    const message = (() => {
      try {
        parseConfig(bad);
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(message).toMatch(/postgres\.port must be a whole number/);
    expect(message).toMatch(/sync\.table 'products' must be schema\.table/);
    expect(message).toMatch(/sync\.tabel: unknown setting \(expected: table, index, primaryKey, columns\)/);
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
    expect(parseConfig(withColumns({ exclude: ['description'] })).sync.columns).toEqual({ exclude: ['description'] });
    expect(() => parseConfig(withColumns({ include: ['a'], exclude: ['b'] }))).toThrow(/exactly one of/);
    expect(() => parseConfig(withColumns({ include: ['name'] }))).toThrow(/must contain the primary key 'id'/);
    expect(() => parseConfig(withColumns({ exclude: ['id'] }))).toThrow(/can't contain the primary key 'id'/);
    expect(() => parseConfig(withColumns({ exclude: ['a', 'a'] }))).toThrow(/twice/);
    expect(() => parseConfig(withColumns({ exclude: 'description' }))).toThrow(/list of column names/);
  });
});

describe('columnFilter', () => {
  it('keeps everything, an allow-list, or everything but a deny-list', () => {
    expect(['id', 'x'].filter(columnFilter(undefined))).toEqual(['id', 'x']);
    expect(['id', 'name', 'x'].filter(columnFilter({ include: ['id', 'name'] }))).toEqual(['id', 'name']);
    expect(['id', 'name', 'x'].filter(columnFilter({ exclude: ['x'] }))).toEqual(['id', 'name']);
  });
});
