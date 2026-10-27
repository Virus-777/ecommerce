/**
 * Idempotency-Key handling (common.json headers; plan scenario 3: no duplicate orders or charges).
 * Same key + same request → the first result is replayed. Same key + different request → 422
 * IDEMPOTENCY_KEY_REUSED. A request still running with that key → 409 CONFLICT.
 * Keys are scoped to the operation and the caller, and kept for 24 hours.
 */
import { createHash } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { MongoStore } from '../mongo/index.js';
import { isDuplicateKey } from '../mysql/errors.js';
import type { MysqlStore } from '../mysql/index.js';
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
      // one round trip: the key's document as it was before (null: this request created it and runs)
      const row = (await keys.findOneAndUpdate({ _id }, { $setOnInsert: { scope, key, request_hash: requestHash, status: 'in_progress', created_at: clock.now() } }, { upsert: true, new: false, lean: true })) as KeyDoc | null;
      if (!row) return null;
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

/**
 * Keys in MySQL (`kernel_idempotency_keys`, purged after 24 h by kernel.purge-expired).
 *
 * `begin` is an INSERT that catches the duplicate, which is the whole of it: the request that manages to
 * insert the row is the one that runs, and every other request with that key reads the row and is answered
 * from it. MongoDB needed an upsert returning the previous document because a duplicate key there would
 * have aborted the caller's transaction; here it costs the statement and nothing else. The happy path —
 * a key never seen before — is one round trip.
 */
export function mysqlIdempotencyStore(store: MysqlStore, clock: Clock = systemClock): IdempotencyStore {
  interface Row extends RowDataPacket {
    request_hash: string;
    status: string;
    response_status: number | null;
    response_body: string | null;
    created_at: Date;
  }

  const read = async (scope: string, key: string): Promise<Row | undefined> => {
    const [rows] = await store.pool.query<Row[]>(
      'SELECT `request_hash`, `status`, `response_status`, `response_body`, `created_at` FROM `kernel_idempotency_keys` WHERE `scope` = ? AND `key` = ?',
      [scope, key],
    );
    return rows[0];
  };

  const begin = async (scope: string, key: string, requestHash: string, attempt: number): Promise<{ status: number; body: unknown } | null> => {
    // a key that keeps vanishing between the insert and the read is a bug, not a race worth retrying forever
    if (attempt > 2) throw new AppError('CONFLICT', 'A request with this Idempotency-Key could not be settled; try again');
    try {
      await store.pool.query('INSERT INTO `kernel_idempotency_keys` (`scope`, `key`, `request_hash`, `status`, `created_at`) VALUES (?, ?, ?, ?, ?)', [
        scope,
        key,
        requestHash,
        'in_progress',
        clock.now(),
      ]);
      return null;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    const row = await read(scope, key);
    if (!row) return begin(scope, key, requestHash, attempt + 1); // purged between the insert and the read
    if (clock.now().getTime() - row.created_at.getTime() > TTL_MS) {
      // delete only the row we read, so a request that has already replaced it is left alone
      await store.pool.query('DELETE FROM `kernel_idempotency_keys` WHERE `scope` = ? AND `key` = ? AND `created_at` = ?', [scope, key, row.created_at]);
      return begin(scope, key, requestHash, attempt + 1);
    }
    if (row.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED');
    if (row.status !== 'completed') throw new AppError('CONFLICT', 'A request with this Idempotency-Key is still being processed');
    return { status: row.response_status!, body: row.response_body === null ? null : JSON.parse(row.response_body) };
  };

  return {
    begin: (scope, key, requestHash) => begin(scope, key, requestHash, 1),
    async complete(scope, key, status, body) {
      await store.pool.query<ResultSetHeader>(
        'UPDATE `kernel_idempotency_keys` SET `status` = ?, `response_status` = ?, `response_body` = ?, `completed_at` = ? WHERE `scope` = ? AND `key` = ?',
        ['completed', status, JSON.stringify(body ?? null), clock.now(), scope, key],
      );
    },
    async release(scope, key) {
      await store.pool.query('DELETE FROM `kernel_idempotency_keys` WHERE `scope` = ? AND `key` = ?', [scope, key]);
    },
  };
}
