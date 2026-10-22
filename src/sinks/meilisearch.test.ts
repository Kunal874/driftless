import { describe, expect, it } from 'vitest';
import type { Change } from '../source/decode.ts';
import { planSteps } from './meilisearch.ts';

const table = 'public.products';
const upsert = (pk: string, row: Record<string, unknown>): Change => ({ op: 'update', table, pk, row: { id: pk, ...row } });
const del = (pk: string): Change => ({ op: 'delete', table, pk });

describe('planSteps', () => {
  it('merges consecutive upserts into one write, later fields winning per key', () => {
    const steps = planSteps([
      { op: 'insert', table, pk: '5', row: { id: '5', name: 'Lamp', description: 'long text', price_cents: 100 } },
      upsert('6', { name: 'Desk' }),
      upsert('5', { price_cents: 200 }), // a price-only update: description not sent
    ], table);
    expect(steps).toStrictEqual([
      {
        kind: 'upsert',
        docs: new Map([
          ['5', { id: '5', name: 'Lamp', description: 'long text', price_cents: 200 }],
          ['6', { id: '6', name: 'Desk' }],
        ]),
      },
    ]);
  });

  it('never moves a change across a delete or a TRUNCATE', () => {
    const steps = planSteps([
      upsert('5', { name: 'v1' }), del('5'), upsert('5', { name: 'v2' }),
      { op: 'truncate', tables: [table] }, upsert('7', { name: 'after' }),
    ], table);
    expect(steps.map((s) => s.kind)).toStrictEqual(['upsert', 'delete', 'upsert', 'clear', 'upsert']);
    expect(steps[2]).toStrictEqual({ kind: 'upsert', docs: new Map([['5', { id: '5', name: 'v2' }]]) });
  });

  it('collects consecutive deletes into one write, once per id', () => {
    expect(planSteps([del('1'), del('2'), del('1')], table)).toStrictEqual([{ kind: 'delete', ids: new Set(['1', '2']) }]);
  });

  it('turns dates into ISO strings', () => {
    const steps = planSteps([upsert('8', { updated_at: new Date('2026-10-22T16:00:00.123Z') })], table);
    expect(steps[0]).toStrictEqual({ kind: 'upsert', docs: new Map([['8', { id: '8', updated_at: '2026-10-22T16:00:00.123Z' }]]) });
  });

  it('refuses changes for a table it does not mirror', () => {
    expect(() => planSteps([{ op: 'delete', table: 'public.orders', pk: '1' }], table)).toThrow(/doesn't mirror/);
  });
});
