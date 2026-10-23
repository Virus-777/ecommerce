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
/** Per key: the batch still collecting ids this tick, and what earlier batches of this request already read */
type KeyState<V> = { batch?: Batch<V>; cache: Map<string, V | undefined> };

/** Ids per statement. A list page of 100 parents with 5 batched fields stays one statement each; a reindex does not */
export const BATCH_CHUNK = 500;

/**
 * A per-request batcher for one module: load(ctx, key, id, fetch) collects the ids asked for under `key` in the
 * same tick and calls fetch once with all of them. Each module makes its own, so two modules using the same key
 * never share a batch.
 *
 * Two things beyond collecting (docs/10 §16.2):
 * - **a result cache per request and key.** A field resolved for the same id in a later tick — a nested list, a
 *   second page of the same parents, two GraphQL fields that need the same record — is answered from what the
 *   earlier batch read instead of asking again. Ids that came back missing are cached as missing, so they are not
 *   re-asked either. The cache lives as long as the request's context object and no longer.
 * - **a cap of {@link BATCH_CHUNK} ids per call to `fetch`.** Bigger batches are split and the chunks run side by
 *   side, so one page of a big list cannot build a single unbounded `IN (…)`. Pass `chunk` where the API being
 *   called has a smaller limit of its own (`catalog.getProducts` refuses more than 200).
 */
export function createBatchLoader() {
  const perRequest = new WeakMap<object, Map<string, KeyState<unknown>>>();
  return function load<V>(ctx: GraphQLContext, key: string, id: string, fetch: (ids: string[]) => Promise<Map<string, V>>, chunk = BATCH_CHUNK): Promise<V | undefined> {
    let keys = perRequest.get(ctx);
    if (!keys) perRequest.set(ctx, (keys = new Map()));
    let state = keys.get(key) as KeyState<V> | undefined;
    if (!state) {
      state = { cache: new Map<string, V | undefined>() };
      keys.set(key, state as KeyState<unknown>);
    }
    if (state.cache.has(id)) return Promise.resolve(state.cache.get(id));
    if (!state.batch) {
      const ids = new Set<string>();
      const promise = new Promise<Map<string, V>>((resolve, reject) => {
        setImmediate(() => {
          state!.batch = undefined;
          const asked = [...ids];
          const chunks: string[][] = [];
          const size = Math.max(1, Math.min(chunk, BATCH_CHUNK));
          for (let i = 0; i < asked.length; i += size) chunks.push(asked.slice(i, i + size));
          Promise.all(chunks.map((c) => fetch(c)))
            .then((maps) => {
              const all = new Map<string, V>();
              for (const m of maps) for (const [k, v] of m) all.set(k, v);
              // every id asked for is remembered, found or not, so this request never asks for it again
              for (const k of asked) state!.cache.set(k, all.get(k));
              resolve(all);
            })
            .catch(reject);
        });
      });
      state.batch = { ids, promise };
    }
    state.batch.ids.add(id);
    return state.batch.promise.then((m) => m.get(id));
  };
}
