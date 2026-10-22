import { describe, expect, it } from 'vitest';
import type { Pgoutput } from 'pg-logical-replication';
import { transactionAssembler, type Transaction } from './decode.ts';

// Fixtures mirror what pg-logical-replication 2.5.0's pgoutput parser hands us (see its
// dist/output-plugins/pgoutput/pgoutput-parser.js): bigint → string, integer → number, text → string,
// timestamptz → Date, SQL NULL → null, unchanged TOAST value → undefined.
const table = 'public.products';
const columns = ['id', 'sku', 'name', 'description', 'category', 'price_cents', 'stock', 'updated_at'];
const products: Pgoutput.MessageRelation = {
  tag: 'relation',
  relationOid: 16388,
  schema: 'public',
  name: 'products',
  replicaIdentity: 'default',
  columns: columns.map((name) => ({
    name, flags: name === 'id' ? 1 : 0, typeOid: 0, typeMod: -1, typeSchema: null, typeName: null, parser: (raw: unknown) => raw,
  })),
  keyColumns: ['id'],
};

const row = (id: number, overrides: Record<string, unknown> = {}) => ({
  id: String(id),
  sku: `SKU-${id}`,
  name: `Product ${id}`,
  description: 'Short description.',
  category: 'toys',
  price_cents: 1999,
  stock: 5,
  updated_at: new Date('2026-10-22T16:00:00Z'),
  ...overrides,
});

const begin = (xid: number): Pgoutput.MessageBegin => ({ tag: 'begin', commitLsn: '00000000/09D68A18', commitTime: 1_792_000_000_000_000n, xid });
const commit: Pgoutput.MessageCommit = {
  tag: 'commit', flags: 0, commitLsn: '00000000/09D68A18', commitEndLsn: '00000000/09D68A48', commitTime: 1_792_000_000_123_456n,
};

function run(...messages: Pgoutput.Message[]): Transaction[] {
  const assemble = transactionAssembler();
  return messages.map(assemble).filter((txn): txn is Transaction => txn !== undefined);
}

describe('transactionAssembler', () => {
  it('returns nothing until COMMIT, then the whole transaction in order', () => {
    const assemble = transactionAssembler();
    expect(assemble(begin(7))).toBeUndefined();
    expect(assemble(products)).toBeUndefined(); // relation messages carry no data
    expect(assemble({ tag: 'insert', relation: products, new: row(1) })).toBeUndefined();
    expect(assemble({ tag: 'delete', relation: products, key: { id: '2' }, old: null })).toBeUndefined();
    expect(assemble(commit)).toStrictEqual({
      xid: 7,
      commitLsn: '00000000/09D68A18',
      commitEndLsn: '00000000/09D68A48',
      commitTime: new Date(1_792_000_000_123), // microseconds → milliseconds
      changes: [
        { op: 'insert', table, pk: '1', row: row(1) },
        { op: 'delete', table, pk: '2' },
      ],
    });
  });

  it('leaves out unchanged-TOAST columns instead of nulling them, and keeps real NULLs', () => {
    const update: Pgoutput.MessageUpdate = {
      tag: 'update', relation: products, key: null, old: null, new: row(10, { description: undefined, category: null }),
    };
    const { description: _unchanged, ...rest } = row(10);
    // toStrictEqual, because toEqual would treat a `description: undefined` key as absent
    expect(run(begin(8), update, commit)[0]?.changes).toStrictEqual([
      { op: 'update', table, pk: '10', row: { ...rest, category: null } },
    ]);
  });

  it('with REPLICA IDENTITY FULL and an unchanged key, an update stays an update', () => {
    const update: Pgoutput.MessageUpdate = { tag: 'update', relation: products, key: null, old: row(3), new: row(3, { stock: 6 }) };
    expect(run(begin(9), update, commit)[0]?.changes).toStrictEqual([{ op: 'update', table, pk: '3', row: row(3, { stock: 6 }) }]);
  });

  it('turns a primary-key change into "delete old" + "insert new"', () => {
    const update: Pgoutput.MessageUpdate = { tag: 'update', relation: products, key: { id: '5' }, old: null, new: row(6) };
    expect(run(begin(10), update, commit)[0]?.changes).toStrictEqual([
      { op: 'delete', table, pk: '5' },
      { op: 'insert', table, pk: '6', row: row(6) },
    ]);
  });

  it('refuses a primary-key change when unsent TOAST columns would be lost', () => {
    const assemble = transactionAssembler();
    assemble(begin(11));
    const update: Pgoutput.MessageUpdate = {
      tag: 'update', relation: products, key: { id: '5' }, old: null, new: row(6, { description: undefined }),
    };
    expect(() => assemble(update)).toThrow(/REPLICA IDENTITY FULL/);
  });

  it('maps TRUNCATE to one truncate change', () => {
    const truncate: Pgoutput.MessageTruncate = { tag: 'truncate', cascade: false, restartIdentity: true, relations: [products] };
    expect(run(begin(12), truncate, commit)[0]?.changes).toStrictEqual([{ op: 'truncate', tables: [table] }]);
  });

  it('rejects data outside a transaction and a BEGIN inside one', () => {
    const assemble = transactionAssembler();
    expect(() => assemble({ tag: 'insert', relation: products, new: row(1) })).toThrow(/outside a transaction/);
    expect(() => assemble(commit)).toThrow(/COMMIT without BEGIN/);
    assemble(begin(13));
    expect(() => assemble(begin(14))).toThrow(/still open/);
  });
});
