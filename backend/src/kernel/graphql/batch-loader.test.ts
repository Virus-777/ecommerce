/**
 * createBatchLoader: collecting ids within a tick, the per-request result cache and the chunk cap
 * (docs/10-mysql-migration.md §16.2). The cache and the cap are what stop a list page of parents from
 * becoming one statement per row, or one statement with an unbounded IN (…).
 */
import { describe, expect, it } from 'vitest';
import { BATCH_CHUNK, createBatchLoader } from './helpers.js';
import type { GraphQLContext } from './index.js';

/** The loader only uses the context as a WeakMap key, so any object stands in for a request */
const aRequest = () => ({}) as GraphQLContext;
const tick = () => new Promise((r) => setImmediate(r));

describe('createBatchLoader', () => {
  it('asks once for every id wanted in the same tick', async () => {
    const load = createBatchLoader();
    const calls: string[][] = [];
    const fetch = async (ids: string[]) => {
      calls.push(ids);
      return new Map(ids.map((id) => [id, `v:${id}`]));
    };
    const ctx = aRequest();
    const [a, b, c] = await Promise.all([load(ctx, 'k', 'a', fetch), load(ctx, 'k', 'b', fetch), load(ctx, 'k', 'a', fetch)]);
    expect([a, b, c]).toEqual(['v:a', 'v:b', 'v:a']);
    expect(calls).toEqual([['a', 'b']]);
  });

  it('answers a later tick from the cache instead of asking again', async () => {
    const load = createBatchLoader();
    let calls = 0;
    const fetch = async (ids: string[]) => {
      calls++;
      return new Map(ids.map((id) => [id, `v:${id}`]));
    };
    const ctx = aRequest();
    expect(await load(ctx, 'k', 'a', fetch)).toBe('v:a');
    await tick();
    expect(await load(ctx, 'k', 'a', fetch)).toBe('v:a');
    expect(calls).toBe(1);
  });

  it('remembers an id that came back missing, and does not ask for it again', async () => {
    const load = createBatchLoader();
    let calls = 0;
    const fetch = async (_ids: string[]) => {
      calls++;
      return new Map<string, string>();
    };
    const ctx = aRequest();
    expect(await load(ctx, 'k', 'gone', fetch)).toBeUndefined();
    await tick();
    expect(await load(ctx, 'k', 'gone', fetch)).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('caches per request, so another request reads for itself', async () => {
    const load = createBatchLoader();
    let calls = 0;
    const fetch = async (ids: string[]) => {
      calls++;
      return new Map(ids.map((id) => [id, `v:${id}`]));
    };
    expect(await load(aRequest(), 'k', 'a', fetch)).toBe('v:a');
    expect(await load(aRequest(), 'k', 'a', fetch)).toBe('v:a');
    expect(calls).toBe(2);
  });

  it('splits a batch bigger than the chunk cap and merges the answers', async () => {
    const load = createBatchLoader();
    const sizes: number[] = [];
    const fetch = async (ids: string[]) => {
      sizes.push(ids.length);
      return new Map(ids.map((id) => [id, Number(id)]));
    };
    const ctx = aRequest();
    const ids = Array.from({ length: BATCH_CHUNK + 20 }, (_, i) => String(i));
    const got = await Promise.all(ids.map((id) => load<number>(ctx, 'k', id, fetch)));
    expect(sizes).toEqual([BATCH_CHUNK, 20]);
    expect(got[0]).toBe(0);
    expect(got.at(-1)).toBe(BATCH_CHUNK + 19);
  });

  it('keeps the batch of one key out of another', async () => {
    const load = createBatchLoader();
    const byKey: Record<string, string[]> = {};
    const fetchFor = (key: string) => async (ids: string[]) => {
      byKey[key] = ids;
      return new Map(ids.map((id) => [id, `${key}:${id}`]));
    };
    const ctx = aRequest();
    const [one, two] = await Promise.all([load(ctx, 'products', 'x', fetchFor('products')), load(ctx, 'offers', 'x', fetchFor('offers'))]);
    expect(one).toBe('products:x');
    expect(two).toBe('offers:x');
    expect(byKey).toEqual({ products: ['x'], offers: ['x'] });
  });

  it('lets a failed batch be retried, and does not cache the failure', async () => {
    const load = createBatchLoader();
    let calls = 0;
    const fetch = async (ids: string[]) => {
      calls++;
      if (calls === 1) throw new Error('database said no');
      return new Map(ids.map((id) => [id, `v:${id}`]));
    };
    const ctx = aRequest();
    await expect(load(ctx, 'k', 'a', fetch)).rejects.toThrow('database said no');
    expect(await load(ctx, 'k', 'a', fetch)).toBe('v:a');
    expect(calls).toBe(2);
  });
});
