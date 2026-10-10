/**
 * Rate limits in three stages (docs/03-auth-middleware.md §11): by IP before authentication, by caller
 * after it, and by body field for sign-in style endpoints; and modules' business limits (ctx.rateLimit).
 *
 * Fixed windows aligned to the epoch (an hour window runs from :00 to :00), counted per (scope, key,
 * window start): scope "http" for the middleware, the module name for ctx.rateLimit. A refused attempt
 * is not counted. Two stores (RATE_LIMIT_STORE): PostgreSQL (kernel.rate_limits), shared by every
 * server instance, and memory, per process (development and tests). A key always uses one window size.
 */
import { sql, type Kysely } from 'kysely';
import { AppError } from '../errors/index.js';
import type { Clock } from '../lib/clock.js';

export interface Limit {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** When the window ends (0 when allowed) */
  retryAfterMs: number;
}

export interface RateLimitStore {
  /**
   * Counts one attempt for the key when it is within the limit. `peek` only looks: whether one more
   * attempt would be allowed, counting nothing.
   */
  hit(scope: string, key: string, l: Limit, o?: { peek?: boolean }): Promise<RateLimitResult>;
  /** Removes windows that have ended; returns how many */
  purge(): Promise<number>;
}

const windowOf = (now: number, windowMs: number) => {
  const start = Math.floor(now / windowMs) * windowMs;
  return { start, end: start + windowMs };
};
const refused = (end: number, now: number): RateLimitResult => ({ allowed: false, retryAfterMs: Math.max(1, end - now) });
const ALLOWED: RateLimitResult = { allowed: true, retryAfterMs: 0 };

export function memoryRateLimitStore(clock: Clock): RateLimitStore {
  const windows = new Map<string, { end: number; count: number }>();
  const purge = (now: number) => {
    let n = 0;
    for (const [k, w] of windows) if (w.end <= now && windows.delete(k)) n++;
    return n;
  };
  return {
    async hit(scope, key, l, o = {}) {
      const now = clock.now().getTime();
      const { start, end } = windowOf(now, l.windowMs);
      const id = `${scope}\u0000${key}\u0000${start}`;
      const count = windows.get(id)?.count ?? 0;
      if (count >= l.limit) return refused(end, now);
      if (o.peek) return ALLOWED;
      windows.set(id, { end, count: count + 1 });
      if (windows.size > 100_000) purge(now);
      return ALLOWED;
    },
    purge: async () => purge(clock.now().getTime()),
  };
}

/** kernel.rate_limits: one row per (scope, key, window start), counted with a single upsert */
export function postgresRateLimitStore(db: Kysely<any>, clock: Clock): RateLimitStore {
  return {
    async hit(scope, key, l, o = {}) {
      const now = clock.now().getTime();
      const { start, end } = windowOf(now, l.windowMs);
      if (l.limit <= 0) return refused(end, now);
      const at = new Date(start);
      if (o.peek) {
        const row = await db.selectFrom('kernel.rate_limits').select('count').where('scope', '=', scope).where('key', '=', key).where('window_start', '=', at).executeTakeFirst();
        return (row?.count ?? 0) < l.limit ? ALLOWED : refused(end, now);
      }
      // counts only while under the limit: no row back means the window is full
      const { rows } = await sql<{ count: number }>`
        insert into kernel.rate_limits as r (scope, key, window_start, window_end, count)
        values (${scope}, ${key}, ${at}, ${new Date(end)}, 1)
        on conflict (scope, key, window_start) do update set count = r.count + 1 where r.count < ${l.limit}
        returning r.count`.execute(db);
      return rows.length ? ALLOWED : refused(end, now);
    },
    async purge() {
      const r = await db.deleteFrom('kernel.rate_limits').where('window_end', '<=', clock.now()).executeTakeFirst();
      return Number(r.numDeletedRows);
    },
  };
}

/** RATE_LIMITS off (contract and load tests): the middleware counts nothing */
export const UNLIMITED: RateLimitStore = { hit: async () => ALLOWED, purge: async () => 0 };

/** The kernel job that clears ended windows */
export const PURGE_RATE_LIMITS_JOB = {
  name: 'kernel.purge-rate-limits',
  module: 'kernel',
  schedule: 'every 10 min',
  does: 'Delete rate-limit windows that have ended (kernel.rate_limits)',
};

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Per-caller limits after authentication */
export const CALLER_LIMITS: Record<string, { all: Limit; writes?: Limit }> = {
  visitor: { all: { limit: 300, windowMs: MIN }, writes: { limit: 30, windowMs: MIN } },
  customer: { all: { limit: 120, windowMs: MIN }, writes: { limit: 30, windowMs: MIN } },
  seller: { all: { limit: 300, windowMs: MIN } },
  staff: { all: { limit: 600, windowMs: MIN } },
};

export const IP_LIMIT: Limit = { limit: 600, windowMs: MIN };

/** Named classes (spec `rateLimit`), keyed by request fields */
export const CLASS_LIMITS: Record<string, { key: (r: { ip: string; body: any }) => string | undefined; limit: Limit }[]> = {
  'sign-in': [
    { key: (r) => `ip:${r.ip}`, limit: { limit: 10, windowMs: MIN } },
    { key: (r) => (r.body?.email ? `email:${String(r.body.email).toLowerCase()}` : undefined), limit: { limit: 5, windowMs: 15 * MIN } },
  ],
  registration: [
    { key: (r) => `ip:${r.ip}`, limit: { limit: 20, windowMs: HOUR } },
    { key: (r) => (r.body?.email ? `email:${String(r.body.email).toLowerCase()}` : undefined), limit: { limit: 5, windowMs: HOUR } },
  ],
  'password-reset': [
    { key: (r) => `ip:${r.ip}`, limit: { limit: 20, windowMs: HOUR } },
    { key: (r) => (r.body?.email ? `email:${String(r.body.email).toLowerCase()}` : undefined), limit: { limit: 5, windowMs: HOUR } },
  ],
  code: [{ key: (r) => `ip:${r.ip}`, limit: { limit: 30, windowMs: MIN } }],
  bootstrap: [
    { key: (r) => `ip:${r.ip}`, limit: { limit: 300, windowMs: HOUR } },
    { key: (r) => (r.body?.device?.installationId ? `install:${r.body.device.installationId}` : undefined), limit: { limit: 30, windowMs: HOUR } },
  ],
};

/** RATE_LIMITED with retryAfterSeconds when the window is full */
export function rateLimited(r: RateLimitResult, message = 'Too many requests; retry later'): AppError {
  return new AppError('RATE_LIMITED', message, { retryAfterSeconds: Math.max(1, Math.ceil(r.retryAfterMs / 1000)) });
}

/** The middleware's limits (scope "http") */
export async function enforce(store: RateLimitStore, key: string, l: Limit) {
  const r = await store.hit('http', key, l);
  if (!r.allowed) throw rateLimited(r);
}
