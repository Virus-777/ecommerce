/**
 * Small mappers every module's GraphQL resolvers use the same way: enum values, deadlines, paging input, lazy and
 * batched lookups. (Money needs none: wireResolvers fills in every Money.formatted.)
 */
import { isAppError } from '../errors/index.js';
import type { Deadline, PageInput } from '../../spec/common.js';
import type { GraphQLContext } from './index.js';

/**
 * GraphQL enum name of a REST value: upper case, hyphens as underscores (payout-account → PAYOUT_ACCOUNT, a name
 * GraphQL accepts). None or empty → null.
 */
export function gqlEnum(s: string): string;
export function gqlEnum(s: string | null | undefined): string | null;
export function gqlEnum(s: string | null | undefined): string | null {
  return s ? s.toUpperCase().replace(/-/g, '_') : null;
}

/** GraphQL Deadline { dueAt, state } of a REST deadline */
export const gqlDeadline = (d: Deadline | null | undefined) => (d ? { dueAt: d.dueAt, state: gqlEnum(d.state) } : null);

/** REST paging of GraphQL paging arguments (only what was given) */
export const pageInput = (p: PageInput | null | undefined): PageInput => ({ ...(p?.cursor ? { cursor: p.cursor } : {}), ...(p?.page ? { page: p.page } : {}), ...(p?.limit ? { limit: p.limit } : {}) });

/** { name, value } pairs of a string map (specs, variant options) */
export const pairs = (m: Record<string, string> | null | undefined) => Object.entries(m ?? {}).map(([name, value]) => ({ name, value }));

/** A field computed on first use and then shared (several fields of one object need the same lookup) */
export const lazy = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
};

/** A lookup that answers null for a record that does not exist, or an id that cannot be one (VALIDATION_FAILED) */
export const nullOnNotFound = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (err) {
    if (isAppError(err) && (err.code === 'NOT_FOUND' || err.code === 'VALIDATION_FAILED')) return null;
    throw err;
  }
};

type Batch<V> = { ids: Set<string>; promise: Promise<Map<string, V>> };

/**
 * A per-request batcher for one module: load(ctx, key, id, fetch) collects the ids asked for under `key` in the
 * same tick and calls fetch once with all of them. Each module makes its own, so two modules using the same key
 * never share a batch.
 */
export function createBatchLoader() {
  const batches = new WeakMap<object, Map<string, Batch<unknown>>>();
  return function load<V>(ctx: GraphQLContext, key: string, id: string, fetch: (ids: string[]) => Promise<Map<string, V>>): Promise<V | undefined> {
    let perCtx = batches.get(ctx);
    if (!perCtx) batches.set(ctx, (perCtx = new Map()));
    let batch = perCtx.get(key) as Batch<V> | undefined;
    if (!batch) {
      const ids = new Set<string>();
      const promise = new Promise<Map<string, V>>((resolve, reject) => {
        setImmediate(() => {
          perCtx!.delete(key);
          fetch([...ids]).then(resolve, reject);
        });
      });
      batch = { ids, promise };
      perCtx.set(key, batch as Batch<unknown>);
    }
    batch.ids.add(id);
    return batch.promise.then((m) => m.get(id));
  };
}
