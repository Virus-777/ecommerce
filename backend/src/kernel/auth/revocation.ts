/**
 * Revoked sessions and account-wide revocations, polled from identity (its tables are the source of
 * truth), so every server refuses a revoked token within a few seconds even though tokens are
 * verified locally. Loaded on startup; entries older than the token lifetime are dropped.
 */
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../errors/index.js';
import type { Clock } from '../lib/clock.js';
import type { Authorities } from './authorities.js';
import type { AccessClaims } from './tokens.js';

export interface RevocationOptions {
  pollMs: number;
  /** keep entries this long: the longest access-token lifetime plus leeway */
  windowMs: number;
  /** production: admin requests need a sync this recent, else 503 */
  maxStalenessMs?: number;
}

export class RevocationList {
  readonly #sessions = new Map<string, number>();
  readonly #accounts = new Map<string, number>();
  #cursor: string | undefined;
  #lastSync = 0;
  #available = true;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly authorities: Authorities,
    private readonly clock: Clock,
    private readonly log: FastifyBaseLogger,
    private readonly o: RevocationOptions,
  ) {}

  async sync() {
    try {
      const r = await this.authorities.revocationsSince(this.#cursor);
      this.#available = r !== null;
      if (!r) return;
      for (const s of r.sessions) this.#sessions.set(s.sessionId, Date.parse(s.at));
      for (const a of r.accounts) this.#accounts.set(a.accountId, Math.max(this.#accounts.get(a.accountId) ?? 0, Date.parse(a.validAfter)));
      this.#cursor = r.cursor;
      this.#lastSync = this.clock.now().getTime();
      this.#prune();
    } catch (err) {
      // keep the last state and say so (identity not built yet answers null, above)
      this.#available = false;
      this.log.error({ err }, 'revocation sync failed');
    }
  }

  start() {
    this.#timer ??= setInterval(() => void this.sync(), this.o.pollMs);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Revoke locally right away (sign-out on this server); the poll brings it to the others. */
  revokeSession(sessionId: string) {
    this.#sessions.set(sessionId, this.clock.now().getTime());
  }

  isRevoked(c: AccessClaims): boolean {
    if (this.#sessions.has(c.sid)) return true;
    const validAfter = c.sub ? this.#accounts.get(c.sub) : undefined;
    return validAfter !== undefined && c.iat * 1000 < validAfter;
  }

  /**
   * Admin requests refuse to run on a stale list (production): fail closed. Stale means no successful
   * sync within maxStalenessMs, whether identity answered nothing, the sync threw, or it never ran.
   */
  assertFresh() {
    if (!this.o.maxStalenessMs) return;
    if (this.clock.now().getTime() - this.#lastSync > this.o.maxStalenessMs) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Session revocations are not current; retry shortly', { reason: this.#available ? 'revocations_stale' : 'revocations_unavailable' });
    }
  }

  #prune() {
    const cutoff = this.clock.now().getTime() - this.o.windowMs;
    for (const [k, at] of this.#sessions) if (at < cutoff) this.#sessions.delete(k);
    for (const [k, at] of this.#accounts) if (at < cutoff) this.#accounts.delete(k);
  }
}
