import { describe, expect, it } from 'vitest';
import { ErrorReply, SocketClosedUnexpectedlyError } from '@redis/client';
import type { RowChange } from '../pipeline/lanes.ts';
import { redisSink, type RedisClient } from './redis.ts';

const table = 'public.products';
const insert = (pk: string, row: Record<string, unknown>): RowChange => ({ op: 'insert', table, pk, row: { id: pk, ...row } });
const update = (pk: string, row: Record<string, unknown>): RowChange => ({ op: 'update', table, pk, row: { id: pk, ...row } });
const del = (pk: string): RowChange => ({ op: 'delete', table, pk });

// A fake client: records every MULTI as a list of commands; `failures` are thrown by the next exec() calls.
function fakeRedis(options: { failures?: unknown[]; scanPages?: Array<{ cursor: string; keys: string[] }> } = {}) {
  const multis: Array<Array<[string, ...unknown[]]>> = [];
  const unlinked: string[][] = [];
  const scans: Array<{ cursor: string; match: string }> = [];
  const failures = [...(options.failures ?? [])];
  const pages = [...(options.scanPages ?? [{ cursor: '0', keys: [] }])];
  const client = {
    multi() {
      const commands: Array<[string, ...unknown[]]> = [];
      const chain = {
        del: (keys: string[]) => (commands.push(['DEL', keys]), chain),
        hSet: (key: string, fields: Record<string, string>) => (commands.push(['HSET', key, fields]), chain),
        exec: async () => {
          if (failures.length > 0) throw failures.shift();
          multis.push(commands);
          return [];
        },
      };
      return chain;
    },
    scan: async (cursor: string, opts: { MATCH: string }) => (scans.push({ cursor, match: opts.MATCH }), pages.shift()!),
    unlink: async (keys: string[]) => (unlinked.push(keys), keys.length),
  };
  return { client: client as unknown as RedisClient, multis, unlinked, scans };
}

const quiet = { log: () => {}, backoff: () => 0 };

describe('redisSink (T12, D-029)', () => {
  it('writes one hash per row, every value JSON-encoded, deletes as DEL, all in one MULTI', async () => {
    const redis = fakeRedis();
    const sink = redisSink(redis.client, { table, keyPrefix: 'product:', ...quiet });
    await sink.applyBatch([insert('5', { name: 'Lamp', price_cents: 100, note: null }), del('9')]);
    expect(redis.multis).toEqual([[
      ['DEL', ['product:9']],
      ['HSET', 'product:5', { id: '"5"', name: '"Lamp"', price_cents: '100', note: 'null' }],
    ]]);
  });

  it('sends only the fields the WAL sent, merged per key in order (unchanged TOAST stays as it is)', async () => {
    const redis = fakeRedis();
    const sink = redisSink(redis.client, { table, keyPrefix: 'product:', ...quiet });
    await sink.applyBatch([update('5', { price_cents: 200 }), update('5', { price_cents: 300, stock: 4 })]);
    expect(redis.multis[0]).toEqual([['HSET', 'product:5', { id: '"5"', price_cents: '300', stock: '4' }]]);
  });

  it('a re-insert after a delete is the whole new row; excluded columns never reach Redis', async () => {
    const redis = fakeRedis();
    const keep = (column: string) => column !== 'description';
    const sink = redisSink(redis.client, { table, keyPrefix: 'p:', keep, ...quiet });
    await sink.applyBatch([update('5', { name: 'old' }), del('5'), insert('5', { name: 'new', description: 'long' })]);
    expect(redis.multis[0]).toEqual([['HSET', 'p:5', { id: '"5"', name: '"new"' }]]);
  });

  it('retries the whole batch while Redis is unreachable, then applies it once', async () => {
    const logged: string[] = [];
    const redis = fakeRedis({ failures: [new SocketClosedUnexpectedlyError(), new SocketClosedUnexpectedlyError()] });
    const sink = redisSink(redis.client, { table, keyPrefix: 'product:', log: (m) => logged.push(m), backoff: () => 0 });
    await sink.applyBatch([insert('1', { name: 'a' })]);
    expect(redis.multis).toHaveLength(1);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatch(/redis is unavailable.*attempt 1/);
  });

  it('fail-stops when Redis rejects a command, and on anything unexpected (no endless retry of a bug)', async () => {
    const rejected = fakeRedis({ failures: [new ErrorReply('WRONGTYPE Operation against a key holding the wrong kind of value')] });
    await expect(redisSink(rejected.client, { table, keyPrefix: 'p:', ...quiet }).applyBatch([insert('1', {})]))
      .rejects.toThrow(/WRONGTYPE/);
    const buggy = fakeRedis({ failures: [new TypeError('not a function')] });
    await expect(redisSink(buggy.client, { table, keyPrefix: 'p:', ...quiet }).applyBatch([insert('1', {})]))
      .rejects.toThrow(TypeError);
  });

  it('clears by prefix page by page, matching the prefix literally', async () => {
    const redis = fakeRedis({ scanPages: [{ cursor: '17', keys: ['a*b:1', 'a*b:2'] }, { cursor: '0', keys: ['a*b:3'] }] });
    await redisSink(redis.client, { table, keyPrefix: 'a*b:', ...quiet }).clear();
    expect(redis.scans.map((s) => s.match)).toEqual(['a\\*b:*', 'a\\*b:*']);
    expect(redis.unlinked).toEqual([['a*b:1', 'a*b:2'], ['a*b:3']]);
  });

  it('is empty only when a full SCAN finds no key; an empty page mid-scan is not the end', async () => {
    const empty = fakeRedis({ scanPages: [{ cursor: '0', keys: [] }] });
    expect(await redisSink(empty.client, { table, keyPrefix: 'p:', ...quiet }).isEmpty()).toBe(true);
    const later = fakeRedis({ scanPages: [{ cursor: '9', keys: [] }, { cursor: '0', keys: ['p:1'] }] });
    expect(await redisSink(later.client, { table, keyPrefix: 'p:', ...quiet }).isEmpty()).toBe(false);
  });
});
