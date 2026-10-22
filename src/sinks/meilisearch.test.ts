import { describe, expect, it } from 'vitest';
import { MeilisearchApiError, MeilisearchRequestError, type EnqueuedTaskPromise } from 'meilisearch';
import type { RowChange } from '../pipeline/lanes.ts';
import { backoffMs, coalesce, submit } from './meilisearch.ts';

const table = 'public.products';
const insert = (pk: string, row: Record<string, unknown>): RowChange => ({ op: 'insert', table, pk, row: { id: pk, ...row } });
const update = (pk: string, row: Record<string, unknown>): RowChange => ({ op: 'update', table, pk, row: { id: pk, ...row } });
const del = (pk: string): RowChange => ({ op: 'delete', table, pk });

describe('coalesce (D-022)', () => {
  it("merges one key's updates in order, keeping fields that weren't resent", () => {
    const { upserts, deletes } = coalesce([
      insert('5', { name: 'Lamp', description: 'long text', price_cents: 100 }),
      update('6', { name: 'Desk' }),
      update('5', { price_cents: 200 }), // a price-only update from a later transaction: description not sent
      update('5', { price_cents: 300 }),
    ], table);
    expect(upserts).toStrictEqual(new Map([
      ['5', { id: '5', name: 'Lamp', description: 'long text', price_cents: 300 }],
      ['6', { id: '6', name: 'Desk' }],
    ]));
    expect(deletes.size).toBe(0);
  });

  it('a later delete wins over earlier upserts', () => {
    const { upserts, deletes } = coalesce([update('5', { name: 'v1' }), del('5')], table);
    expect(upserts.size).toBe(0);
    expect(deletes).toStrictEqual(new Set(['5']));
  });

  it('a re-insert after a delete replaces it with the whole new row', () => {
    const { upserts, deletes } = coalesce([update('5', { name: 'old', stock: 1 }), del('5'), insert('5', { name: 'new', stock: 9 })], table);
    expect(upserts).toStrictEqual(new Map([['5', { id: '5', name: 'new', stock: 9 }]])); // nothing kept from before the delete
    expect(deletes.size).toBe(0);
  });

  it('ends with upserts and deletes on different keys, so their order cannot matter', () => {
    const { upserts, deletes } = coalesce([del('1'), update('2', { n: 1 }), del('3'), update('1', { n: 2 }), del('2')], table);
    expect([...upserts.keys()]).toStrictEqual(['1']);
    expect([...deletes]).toStrictEqual(['3', '2']);
  });

  it('turns dates into ISO strings', () => {
    const { upserts } = coalesce([update('8', { updated_at: new Date('2026-10-22T16:00:00.123Z') })], table);
    expect(upserts.get('8')).toStrictEqual({ id: '8', updated_at: '2026-10-22T16:00:00.123Z' });
  });

  it('refuses changes for a table it does not mirror', () => {
    expect(() => coalesce([{ op: 'delete', table: 'public.orders', pk: '1' }], table)).toThrow(/doesn't mirror/);
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
    const write = scripted(unreachable(), httpError(503), httpError(429), httpError(408), unreachable(), 'succeeded');
    await submit(write, 'id 1', { ...fast, log: (m) => logged.push(m) });
    expect(write.calls).toBe(6); // 408 included: a woken-up Meilisearch answers it (BUG-004)
    expect(logged).toHaveLength(5);
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
