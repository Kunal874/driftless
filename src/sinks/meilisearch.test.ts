import { describe, expect, it } from 'vitest';
import { MeilisearchApiError, MeilisearchRequestError, type EnqueuedTaskPromise } from 'meilisearch';
import type { Change } from '../source/decode.ts';
import { backoffMs, planSteps, submit } from './meilisearch.ts';

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

// A fake write: each call returns the next scripted outcome (a task status, or an error from waitTask).
function scripted(...outcomes: Array<'succeeded' | 'failed' | Error>) {
  const write = () => {
    write.calls++;
    const outcome = outcomes.shift() ?? 'succeeded';
    const waitTask = async () => {
      if (outcome instanceof Error) throw outcome;
      return { status: outcome, error: outcome === 'failed' ? { message: 'invalid document' } : null };
    };
    return Object.assign(Promise.resolve({}), { waitTask }) as unknown as EnqueuedTaskPromise;
  };
  write.calls = 0;
  return write;
}

const fast = { backoff: () => 0, log: () => {} };
const unreachable = () => new MeilisearchRequestError('http://127.0.0.1:7700/tasks/1', new Error('ECONNREFUSED'));
const httpError = (status: number) => new MeilisearchApiError(new Response(null, { status }));

describe('submit (retry policy, D-021)', () => {
  it('returns once the task has succeeded', async () => {
    const write = scripted('succeeded');
    await submit(write, 'id 1', fast);
    expect(write.calls).toBe(1);
  });

  it('keeps retrying while Meilisearch is unreachable or overloaded', async () => {
    const logged: string[] = [];
    const write = scripted(unreachable(), httpError(503), httpError(429), unreachable(), 'succeeded');
    await submit(write, 'id 1', { ...fast, log: (m) => logged.push(m) });
    expect(write.calls).toBe(5);
    expect(logged).toHaveLength(4);
    expect(logged[0]).toMatch(/unavailable.*\[id 1\]; attempt 1/);
  });

  it('gives a rejected write a few tries, then stops naming the rows', async () => {
    const write = scripted('failed', 'failed', 'failed', 'succeeded');
    await expect(submit(write, 'xid 7: upsert id 10', fast)).rejects.toThrow(/xid 7: upsert id 10: Meilisearch rejected.*invalid document/);
    expect(write.calls).toBe(3);
  });

  it('accepts a write that was rejected once and then succeeded', async () => {
    const write = scripted('failed', 'succeeded');
    await submit(write, 'id 1', fast);
    expect(write.calls).toBe(2);
  });

  it('does not retry client errors (HTTP 4xx): they would fail again', async () => {
    const write = scripted(httpError(400));
    await expect(submit(write, 'id 1', fast)).rejects.toBeInstanceOf(MeilisearchApiError);
    expect(write.calls).toBe(1);
  });

  it('backs off with full jitter, capped at 30 s', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const delay = backoffMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(Math.min(30_000, 100 * 2 ** attempt));
    }
  });
});
