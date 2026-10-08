/**
 * Idempotency-Key handling (common.json headers; plan scenario 3: no duplicate orders or charges).
 * Same key + same request → the first result is replayed. Same key + different request → 422
 * IDEMPOTENCY_KEY_REUSED. A request still running with that key → 409 CONFLICT.
 * Keys are scoped to the operation and the caller, and kept for 24 hours.
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { AppError } from '../errors/index.js';

export interface IdempotencyStore {
  /** Returns a stored response to replay, or null when this request should run. */
  begin(scope: string, key: string, requestHash: string): Promise<{ status: number; body: unknown } | null>;
  complete(scope: string, key: string, status: number, body: unknown): Promise<void>;
  /** The request failed in a way that may succeed on retry (5xx): forget the key. */
  release(scope: string, key: string): Promise<void>;
}

export const hashRequest = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts ?? null)).digest('hex');

export function postgresIdempotencyStore(db: Kysely<any>): IdempotencyStore {
  return {
    async begin(scope, key, requestHash) {
      const inserted = await sql<{ key: string }>`
        insert into kernel.idempotency_keys (scope, key, request_hash, status)
        values (${scope}, ${key}, ${requestHash}, 'in_progress')
        on conflict (scope, key) do nothing
        returning key`.execute(db);
      if (inserted.rows.length) return null;
      const row = await db
        .selectFrom('kernel.idempotency_keys')
        .select(['request_hash', 'status', 'response_status', 'response_body', 'created_at'])
        .where('scope', '=', scope)
        .where('key', '=', key)
        .executeTakeFirst();
      if (!row) return null;
      if (Date.now() - new Date(row.created_at).getTime() > 24 * 3600_000) {
        await db.deleteFrom('kernel.idempotency_keys').where('scope', '=', scope).where('key', '=', key).execute();
        return this.begin(scope, key, requestHash);
      }
      if (row.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED');
      if (row.status !== 'completed') throw new AppError('CONFLICT', 'A request with this Idempotency-Key is still being processed');
      return { status: row.response_status, body: row.response_body };
    },
    async complete(scope, key, status, body) {
      await db
        .updateTable('kernel.idempotency_keys')
        .set({ status: 'completed', response_status: status, response_body: body === undefined ? null : JSON.stringify(body), completed_at: new Date() })
        .where('scope', '=', scope)
        .where('key', '=', key)
        .execute();
    },
    async release(scope, key) {
      await db.deleteFrom('kernel.idempotency_keys').where('scope', '=', scope).where('key', '=', key).execute();
    },
  };
}
