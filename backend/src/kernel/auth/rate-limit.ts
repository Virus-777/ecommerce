/**
 * Rate limits in three stages (docs/03-auth-middleware.md §11): by IP before authentication, by caller
 * after it, and by body field for sign-in style endpoints; and modules' business limits (ctx.rateLimit).
 *
 * Fixed windows aligned to the epoch (an hour window runs from :00 to :00), counted per (scope, key,
 * window start): scope "http" for the middleware, the module name for ctx.rateLimit. A refused attempt
 * is not counted. Two stores (RATE_LIMIT_STORE): MongoDB (kernel.rate_limits), shared by every server
 * instance, and memory, per process (development and tests). A key always uses one window size.
 */
import { AppError } from '../errors/index.js';
import type { Clock } from '../lib/clock.js';
import type { MongoStore } from '../mongo/index.js';

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

/**
 * Windows in MongoDB (kernel.rate_limits), shared by every instance: one document per scope, key and window,
 * counted with a conditional $inc. A full window makes the upsert collide with the existing document (duplicate
 * key), which is the refusal; ended windows expire by a TTL index (and the purge job).
 */
export function mongoRateLimitStore(store: MongoStore, clock: Clock): RateLimitStore {
  const windows = store.kernel('rate_limits');
  return {
    async hit(scope, key, l, o = {}) {
      const now = clock.now().getTime();
      const { start, end } = windowOf(now, l.windowMs);
      if (l.limit <= 0) return refused(end, now);
      const _id = `${scope}|${key}|${start}`;
      if (o.peek) {
        const row = (await windows.findOne({ _id }).lean()) as { count: number } | null;
        return (row?.count ?? 0) < l.limit ? ALLOWED : refused(end, now);
      }
      try {
        await windows.updateOne({ _id, count: { $lt: l.limit } }, { $inc: { count: 1 }, $setOnInsert: { scope, key, window_start: new Date(start), window_end: new Date(end) } }, { upsert: true });
        return ALLOWED;
      } catch (err) {
        if ((err as { code?: number }).code === 11000) return refused(end, now);
        throw err;
      }
    },
    async purge() {
      return (await windows.deleteMany({ window_end: { $lte: clock.now() } })).deletedCount;
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

/** Per-caller limits after authentication; GraphQL requests are reads (the read layer has no mutations) */
export const CALLER_LIMITS: Record<string, { all: Limit; writes?: Limit }> = {
  visitor: { all: { limit: 300, windowMs: MIN }, writes: { limit: 30, windowMs: MIN } },
  customer: { all: { limit: 120, windowMs: MIN }, writes: { limit: 30, windowMs: MIN } },
  seller: { all: { limit: 300, windowMs: MIN } },
  staff: { all: { limit: 600, windowMs: MIN } },
};

/** The caller bucket: a visitor per session and IP, a seller member per account and seller, others per account */
export function callerKey(p: { kind: string; accountId?: string | null; sessionId: string; sellerId?: string | null }, ip: string): string {
  if (p.kind === 'visitor' || !p.accountId) return `${p.kind}:${p.sessionId}@${ip}`;
  if (p.kind === 'seller') return `seller:${p.accountId}:${p.sellerId ?? '-'}`;
  return `${p.kind}:${p.accountId}`;
}

export const IP_LIMIT: Limit = { limit: 600, windowMs: MIN };
/** Signed file links (GET /files/…): images on a page come many at a time, so they don't spend the API budget */
export const FILES_IP_LIMIT: Limit = { limit: 3000, windowMs: MIN };
/** Refresh and sign-out, per session (after the refresh token is verified) */
export const REFRESH_LIMIT: Limit = { limit: 30, windowMs: HOUR };
/** Webhooks, per provider (after the signature is verified, so forged calls never spend a provider's budget) */
export const WEBHOOK_LIMIT: Limit = { limit: 1000, windowMs: MIN };

/** What a class key is computed from */
export interface ClassKeyInput {
  ip: string;
  body: any;
  /** The verified caller (absent on refresh, webhook and bootstrap calls) */
  principal?: { accountId?: string | null; sessionId: string } | null;
}

/**
 * The class an endpoint counts in: its spec `rateLimit`, else `export` for a POST that creates an export
 * (a path ending in /exports: every module names them so).
 */
export function rateLimitClassOf(d: { rateLimit?: string; method: string; path: string }): string | undefined {
  if (d.rateLimit) return d.rateLimit;
  return d.method === 'POST' && /\/exports$/.test(d.path) ? 'export' : undefined;
}

/** Named classes (spec `rateLimit`), keyed by request fields */
export const CLASS_LIMITS: Record<string, { key: (r: ClassKeyInput) => string | undefined; limit: Limit }[]> = {
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
  /** Creating exports (reports, registers, data exports): per account, whichever module */
  export: [{ key: (r) => (r.principal ? `account:${r.principal.accountId ?? r.principal.sessionId}` : undefined), limit: { limit: 10, windowMs: HOUR } }],
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
