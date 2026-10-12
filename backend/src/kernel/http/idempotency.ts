/**
 * Idempotency-Key handling (common.json headers; plan scenario 3: no duplicate orders or charges).
 * Same key + same request → the first result is replayed. Same key + different request → 422
 * IDEMPOTENCY_KEY_REUSED. A request still running with that key → 409 CONFLICT.
 * Keys are scoped to the operation and the caller, and kept for 24 hours.
 */
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { MongoStore } from '../mongo/index.js';
import { AppError } from '../errors/index.js';
import { systemClock, type Clock } from '../lib/clock.js';

export interface IdempotencyStore {
  /** Returns a stored response to replay, or null when this request should run. */
  begin(scope: string, key: string, requestHash: string): Promise<{ status: number; body: unknown } | null>;
  complete(scope: string, key: string, status: number, body: unknown): Promise<void>;
  /** The request failed in a way that may succeed on retry: forget the key. */
  release(scope: string, key: string): Promise<void>;
}

const TTL_MS = 24 * 3600_000;

export const hashRequest = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts ?? null)).digest('hex');

interface KeyDoc {
  _id: string;
  scope: string;
  key: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status?: number;
  /** the response as JSON text, replayed exactly */
  response_body?: string;
  created_at: Date;
  completed_at?: Date;
}

/** Keys in MongoDB (kernel.idempotency_keys, expired by a TTL index after 24 h) */
export function mongoIdempotencyStore(store: MongoStore, clock: Clock = systemClock): IdempotencyStore {
  const keys = store.kernel('idempotency_keys');
  const idOf = (scope: string, key: string) => `${scope}|${key}`;
  return {
    async begin(scope, key, requestHash) {
      const _id = idOf(scope, key);
      const r = await keys.updateOne({ _id }, { $setOnInsert: { scope, key, request_hash: requestHash, status: 'in_progress', created_at: clock.now() } }, { upsert: true });
      if (r.upsertedCount) return null;
      const row = (await keys.findOne({ _id }).lean()) as KeyDoc | null;
      if (!row) return this.begin(scope, key, requestHash);
      if (clock.now().getTime() - row.created_at.getTime() > TTL_MS) {
        await keys.deleteOne({ _id, created_at: row.created_at });
        return this.begin(scope, key, requestHash);
      }
      if (row.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED');
      if (row.status !== 'completed') throw new AppError('CONFLICT', 'A request with this Idempotency-Key is still being processed');
      return { status: row.response_status!, body: row.response_body === undefined ? null : JSON.parse(row.response_body) };
    },
    async complete(scope, key, status, body) {
      await keys.updateOne({ _id: idOf(scope, key) }, { $set: { status: 'completed', response_status: status, response_body: JSON.stringify(body ?? null), completed_at: clock.now() } });
    },
    async release(scope, key) {
      await keys.deleteOne({ _id: idOf(scope, key) });
    },
  };
}

export function postgresIdempotencyStore(db: Kysely<any>, clock: Clock = systemClock): IdempotencyStore {
  const table = 'kernel.idempotency_keys';
  const release = (scope: string, key: string) => db.deleteFrom(table).where('scope', '=', scope).where('key', '=', key).execute();

  return {
    async begin(scope, key, requestHash) {
      const claimed = await db
        .insertInto(table)
        .values({ scope, key, request_hash: requestHash, status: 'in_progress', created_at: clock.now() })
        .onConflict((oc) => oc.columns(['scope', 'key']).doNothing())
        .returning('key')
        .executeTakeFirst();
      if (claimed) return null;
      const row = await db.selectFrom(table).selectAll().where('scope', '=', scope).where('key', '=', key).executeTakeFirst();
      if (!row) return null;
      if (clock.now().getTime() - new Date(row.created_at).getTime() > TTL_MS) {
        await release(scope, key);
        return this.begin(scope, key, requestHash);
      }
      if (row.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED');
      if (row.status !== 'completed') throw new AppError('CONFLICT', 'A request with this Idempotency-Key is still being processed');
      return { status: row.response_status, body: row.response_body };
    },
    async complete(scope, key, status, body) {
      await db
        .updateTable(table)
        .set({ status: 'completed', response_status: status, response_body: JSON.stringify(body ?? null), completed_at: clock.now() })
        .where('scope', '=', scope)
        .where('key', '=', key)
        .execute();
    },
    async release(scope, key) {
      await release(scope, key);
    },
  };
}
