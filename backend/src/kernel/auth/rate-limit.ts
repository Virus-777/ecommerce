/**
 * Rate limits in three stages (docs/03-auth-middleware.md §11): by IP before authentication, by caller
 * after it, and by body field for sign-in style endpoints. Fixed windows in memory per process; the
 * store interface lets a shared store (Redis) replace it.
 */
import { AppError } from '../errors/index.js';
import type { Clock } from '../lib/clock.js';

export interface RateLimitStore {
  /** Counts one hit; returns whether it is within the limit and when the window resets. */
  hit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSeconds: number };
}

export function memoryRateLimitStore(clock: Clock): RateLimitStore {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key, limit, windowMs) {
      const now = clock.now().getTime();
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        w = { start: now, count: 0 };
        windows.set(key, w);
        if (windows.size > 100_000) for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
      }
      w.count++;
      return { ok: w.count <= limit, retryAfterSeconds: Math.ceil((w.start + windowMs - now) / 1000) };
    },
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface Limit {
  limit: number;
  windowMs: number;
}

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

export function enforce(store: RateLimitStore, key: string, l: Limit) {
  const r = store.hit(key, l.limit, l.windowMs);
  if (!r.ok) throw new AppError('RATE_LIMITED', 'Too many requests; retry later', { retryAfterSeconds: r.retryAfterSeconds });
}
