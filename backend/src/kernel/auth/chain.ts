/**
 * The authorization middleware (docs/03-auth-middleware.md §3). Token verification is mandatory and
 * happens here, before any module code: handlers only ever see a verified `principal`.
 *
 *   every URL (app onRequest)   IP rate limit → authenticate (token / app proof / defer for refresh and webhooks)
 *   each endpoint (onRequest)   launch phase → caller rate limit → audience → caller kind → seller context → permission → staff 2-step
 *   (preValidation)             refresh token · webhook signature + replay check · rate-limit classes keyed by body
 *   (preHandler)                conditional permissions → [idempotency, in register.ts] → step-up
 *   (onResponse)                consume the re-auth token · record the webhook event
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Config } from '../config/index.js';
import { AppError } from '../errors/index.js';
import type { Clock } from '../lib/clock.js';
import type { Area, AuthKind, EndpointDef } from '../spec/define.js';
import type { AppProofVerifier } from './app-proof.js';
import { devSellerAccess, type Authorities } from './authorities.js';
import {
  checkAudience,
  checkCallerKind,
  forbidden,
  principalOf,
  sellerMayDo,
  tokenRejected,
  type Principal,
  type RequestAuth,
  type SellerMemberAccess,
} from './index.js';
import { CALLER_LIMITS, CLASS_LIMITS, enforce, IP_LIMIT, type RateLimitStore } from './rate-limit.js';
import type { RevocationList } from './revocation.js';
import { TokenError, verifyAccessToken, type AccessClaims, type KeyRing } from './tokens.js';

/** Verifies a provider's signature over the raw body; returns the provider and event, or false. */
export type WebhookVerifier = (
  request: FastifyRequest,
  provider: string | undefined,
) => boolean | { provider: string; eventId?: string; timestamp?: Date } | Promise<boolean | { provider: string; eventId?: string; timestamp?: Date }>;

export interface AuthKernel {
  config: Config;
  clock: Clock;
  keys: KeyRing;
  revocations: RevocationList;
  authorities: Authorities;
  appProof: AppProofVerifier;
  limits: RateLimitStore;
  webhookVerifiers: Map<string, WebhookVerifier>;
  /** Seller permission keys only the owner may use (spec permissions with ownerOnly) */
  ownerOnly: ReadonlySet<string>;
  db: Kysely<any>;
  /** Claims behind each verified principal (development authorities read dev claims from it) */
  claimsOf: WeakMap<Principal, AccessClaims>;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    operationId?: string;
    auth?: AuthKind;
  }
  interface FastifyRequest {
    auth?: RequestAuth;
    reauthToken?: string;
    webhookDuplicate?: boolean;
  }
}

const WEBHOOK_WINDOW_MS = 5 * 60_000;
const CACHE_MS = 60_000;
const REFRESH_COOKIE = '__Host-mk_refresh';

/** Small TTL cache for answers from access, sellers and customers */
class TtlCache<V> {
  readonly #m = new Map<string, { v: V; at: number }>();
  /** keepMissing: false = a null answer isn't remembered (a record created a moment later must be found) */
  constructor(
    private readonly clock: Clock,
    private readonly keepMissing = true,
  ) {}
  async get(key: string, load: () => Promise<V>): Promise<V> {
    const now = this.clock.now().getTime();
    const hit = this.#m.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.v;
    const v = await load();
    if (v === null && !this.keepMissing) return v;
    if (this.#m.size > 50_000) this.#m.clear();
    this.#m.set(key, { v, at: now });
    return v;
  }
  clear() {
    this.#m.clear();
  }
}

export class AuthChain {
  readonly permissions: TtlCache<boolean>;
  readonly members: TtlCache<SellerMemberAccess | null>;
  readonly customers: TtlCache<string | null>;

  constructor(readonly k: AuthKernel) {
    this.permissions = new TtlCache(k.clock);
    this.members = new TtlCache(k.clock);
    this.customers = new TtlCache(k.clock, false); // a customer created after the first request must be in scope at once
  }

  /* ---------------------------------------------------------------- every URL */

  /** App-level hooks: run for every request, including GraphQL and unknown URLs. */
  install(app: FastifyInstance) {
    app.addHook('onRequest', async (request) => {
      if (request.method === 'OPTIONS' || this.#exempt(request)) return;
      enforce(this.k.limits, `ip:${request.ip}`, IP_LIMIT);
      await this.authenticate(request, this.#kindOf(request));
    });
  }

  /** Development only: /docs (Swagger UI) is served without a token so a browser can open it. */
  #exempt(request: FastifyRequest) {
    return this.k.config.docsEnabled && (request.url === '/docs' || request.url.startsWith('/docs/'));
  }

  #kindOf(request: FastifyRequest): AuthKind {
    const configured = request.routeOptions.config?.auth;
    if (configured && !request.is404) return configured;
    if (request.url.startsWith('/graphql/seller')) return 'seller';
    if (request.url.startsWith('/graphql/admin')) return 'staff';
    return 'visitor'; // GraphQL store, and any URL that doesn't exist: still needs a valid token (401 before 404)
  }

  async authenticate(request: FastifyRequest, kind: AuthKind) {
    if (kind === 'bootstrap') {
      const proof = request.headers['x-app-proof'];
      if (!(await this.k.appProof.verify(typeof proof === 'string' ? proof : undefined, request.ip))) {
        throw new AppError('APP_PROOF_INVALID', 'Open the Marketly app or website to start a session', undefined, 401);
      }
      request.auth = { via: 'bootstrap', principal: null };
      return;
    }
    if (kind === 'provider') {
      request.auth = { via: 'provider', principal: null }; // signature checked in preValidation (needs the raw body)
      return;
    }
    if (kind === 'refresh') {
      request.auth = { via: 'refresh', principal: null }; // refresh token checked in preValidation (cookie or body)
      return;
    }
    const header = request.headers.authorization;
    const token = header && /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
    if (!token) throw tokenRejected('missing');
    let claims: AccessClaims;
    try {
      claims = verifyAccessToken(this.k.keys, token, { issuer: this.k.config.auth.issuer, leewaySeconds: 60, now: () => this.k.clock.now() });
    } catch (err) {
      if (err instanceof TokenError) throw tokenRejected(err.reason);
      throw err;
    }
    if (this.k.revocations.isRevoked(claims)) throw tokenRejected('revoked');
    if (claims.aud === 'admin') this.k.revocations.assertFresh();
    const principal = principalOf(claims);
    this.k.claimsOf.set(principal, claims);
    request.auth = { via: 'token', principal, claims };
  }

  /* ---------------------------------------------------------------- caller checks (REST endpoints and GraphQL) */

  async checkCaller(request: FastifyRequest, d: { area: Area; auth: AuthKind; permission?: string; sellerContext?: 'optional' }) {
    const auth = request.auth;
    if (auth?.via !== 'token' || !auth.principal) return; // refresh, provider and bootstrap are checked elsewhere
    const p = auth.principal;
    const limits = CALLER_LIMITS[p.kind];
    const who = `${p.kind}:${p.accountId ?? p.sessionId}`;
    if (limits) {
      enforce(this.k.limits, `caller:${who}`, limits.all);
      if (limits.writes && request.method !== 'GET') enforce(this.k.limits, `writes:${who}`, limits.writes);
    }
    checkAudience(d.area, d.auth, p);
    checkCallerKind(d.auth, p);

    if (d.auth === 'seller') {
      if (!p.sellerId) {
        if (d.sellerContext === 'optional') return;
        throw new AppError('UNAUTHORIZED', 'Choose the seller account to act for', { reason: 'seller_context_required' });
      }
      const access = await this.memberAccess(auth.claims, p);
      if (!access) throw new AppError('NO_SELLER_ACCESS', 'You are no longer a member of this seller account');
      if (p.sellerMemberId && access.memberId !== p.sellerMemberId) throw new AppError('NO_SELLER_ACCESS', 'This session belongs to a previous membership; sign in again');
      auth.sellerAccess = access;
    }
    if (d.permission && !(await this.can(auth, d.permission))) {
      throw this.k.ownerOnly.has(d.permission) && auth.sellerAccess ? new AppError('OWNER_ONLY') : forbidden(d.permission);
    }
    if (d.area === 'admin' && !p.twoStepVerifiedAt) {
      throw new AppError('STEP_UP_REQUIRED', 'Staff sessions need 2-step verification', { kind: 'two-step-sign-in' });
    }
  }

  async memberAccess(claims: AccessClaims | undefined, p: Principal): Promise<SellerMemberAccess | null> {
    const dev = devSellerAccess(claims);
    if (dev) return dev;
    return this.members.get(`${p.sellerId}:${p.accountId}`, () => this.k.authorities.getMemberAccess(p.sellerId!, p.accountId!));
  }

  /** Whether the caller holds a permission: staff through access, sellers through member access (owner-only keys need the owner). */
  async can(auth: RequestAuth | undefined, permission: string): Promise<boolean> {
    const p = auth?.principal;
    if (!p) return false;
    if (p.kind === 'staff') {
      if (auth.claims?.dev) return this.k.authorities.hasPermission(p, permission);
      return this.permissions.get(`${p.accountId}:${permission}`, () => this.k.authorities.hasPermission(p, permission));
    }
    if (p.kind === 'seller' && auth.sellerAccess) {
      if (this.k.ownerOnly.has(permission)) return auth.sellerAccess.isOwner;
      return sellerMayDo(auth.sellerAccess, permission);
    }
    return false;
  }

  /**
   * The same answer as `can` for a principal handed over in-process (no request): dev claims come from the
   * principal object the middleware created, seller members from their member access.
   */
  async canPrincipal(p: Principal | null | undefined, permission: string): Promise<boolean> {
    if (!p) return false;
    const claims = this.k.claimsOf.get(p);
    const auth: RequestAuth = { via: 'token', principal: p, claims };
    if (p.kind === 'seller' && p.sellerId && p.accountId) auth.sellerAccess = (await this.memberAccess(claims, p)) ?? undefined;
    return this.can(auth, permission);
  }

  /** Customer id of the signed-in account (customers module), for own-customer scope. */
  async customerIdOf(p: Principal | null | undefined): Promise<string | null> {
    if (p?.kind !== 'customer' || !p.accountId) return null;
    return this.customers.get(p.accountId, () => this.k.authorities.customerIdOf(p.accountId!));
  }

  /* ---------------------------------------------------------------- per endpoint */

  /** Hooks for one spec endpoint, in Fastify order. */
  endpointHooks(module: string, operationId: string, d: EndpointDef) {
    const k = this.k;
    const onRequest = async (request: FastifyRequest) => {
      if (d.phase > k.config.launchPhase) {
        throw new AppError('NOT_IMPLEMENTED', `Planned for launch phase ${d.phase}.`, { operation: operationId, reason: 'later_phase', phase: d.phase });
      }
      await this.checkCaller(request, d);
    };

    const preValidation = async (request: FastifyRequest) => {
      if (d.auth === 'refresh') await this.#verifyRefresh(request);
      if (d.auth === 'provider') await this.#verifyWebhook(module, request);
      for (const rule of CLASS_LIMITS[d.rateLimit ?? ''] ?? []) {
        const key = rule.key({ ip: request.ip, body: request.body });
        if (key) enforce(k.limits, `${d.rateLimit}:${key}`, rule.limit);
      }
    };

    const preHandlerBefore = async (request: FastifyRequest) => {
      for (const rule of d.permissionWhen ?? []) {
        if (this.#matches(rule.if, request) && !(await this.can(request.auth, rule.permission))) {
          throw k.ownerOnly.has(rule.permission) && request.auth?.sellerAccess ? new AppError('OWNER_ONLY') : forbidden(rule.permission);
        }
      }
    };

    const preHandlerAfter = async (request: FastifyRequest) => {
      if (!d.stepUp) return;
      const p = request.auth?.principal;
      const refuse = () => new AppError('STEP_UP_REQUIRED', undefined, { kind: d.stepUp!.kind, purpose: d.stepUp!.purpose });
      if (!p) throw refuse();
      if (d.stepUp.kind === 'reauth') {
        const token = (request.body as { reauthToken?: unknown } | undefined)?.reauthToken;
        if (typeof token !== 'string' || !(await k.authorities.verifyReauthToken(p, token, d.stepUp.purpose))) throw refuse();
        request.reauthToken = token; // consumed after the request succeeds
      } else {
        const code = request.headers['x-step-up-code'];
        if (typeof code !== 'string' || !(await k.authorities.verifyStepUpCode(p, code))) throw refuse();
      }
    };

    const onResponse = async (request: FastifyRequest, reply: { statusCode: number }) => {
      if (reply.statusCode >= 400) return;
      if (request.reauthToken) await k.authorities.consumeReauthToken(request.reauthToken).catch(() => {});
      const ev = request.auth?.provider;
      if (ev?.eventId && !request.webhookDuplicate) {
        await sql`insert into kernel.webhook_events (provider, event_id) values (${ev.name}, ${ev.eventId}) on conflict do nothing`.execute(k.db).catch(() => {});
      }
    };

    return { onRequest, preValidation, preHandlerBefore, preHandlerAfter, onResponse };
  }

  #matches(cond: Readonly<Record<string, string>>, request: FastifyRequest) {
    const p = request.auth?.principal;
    return Object.entries(cond).every(([path, expected]) => {
      const [part, field] = path.split('.') as ['params' | 'query' | 'body', string];
      const value = (request[part] as Record<string, unknown> | undefined)?.[field];
      if (expected === '!self') return value !== undefined && value !== null && value !== p?.accountId;
      if (expected === '!self-member') return value !== undefined && value !== null && value !== p?.sellerMemberId;
      return value !== undefined && String(value) === expected;
    });
  }

  async #verifyRefresh(request: FastifyRequest) {
    const fromBody = (request.body as { refreshToken?: unknown } | undefined)?.refreshToken;
    const token = cookie(request.headers.cookie, REFRESH_COOKIE) ?? (typeof fromBody === 'string' ? fromBody : undefined);
    if (!token) throw tokenRejected('missing');
    const session = await this.k.authorities.verifyRefreshToken(token);
    if (!session) throw tokenRejected('invalid');
    request.auth = { via: 'refresh', principal: null, refreshSession: session };
  }

  async #verifyWebhook(module: string, request: FastifyRequest) {
    const verify = this.k.webhookVerifiers.get(module);
    if (!verify) throw new AppError('UNAUTHORIZED', `No webhook signature verifier is configured for ${module}`);
    const params = request.params as Record<string, string> | undefined;
    const result = await verify(request, params?.provider ?? params?.carrier);
    if (!result) throw new AppError('UNAUTHORIZED', 'Invalid webhook signature', { reason: 'signature_invalid' });
    const info = result === true ? { provider: module } : result;
    if (info.timestamp && Math.abs(this.k.clock.now().getTime() - info.timestamp.getTime()) > WEBHOOK_WINDOW_MS) {
      throw new AppError('UNAUTHORIZED', 'Webhook timestamp outside the allowed window', { reason: 'signature_expired' });
    }
    request.auth = { via: 'provider', principal: null, provider: { name: info.provider, eventId: info.eventId } };
    if (info.eventId) {
      const seen = await sql<{ n: number }>`select 1 as n from kernel.webhook_events where provider = ${info.provider} and event_id = ${info.eventId}`.execute(this.k.db);
      request.webhookDuplicate = seen.rows.length > 0;
    }
  }

  /** Flush cached answers when the modules that own them announce a change. */
  invalidate(kind: 'permissions' | 'members' | 'customers') {
    this[kind].clear();
  }
}

function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
