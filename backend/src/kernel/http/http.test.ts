/**
 * The request pipeline every spec endpoint goes through, on a small made-up module:
 * token → phase gate → caller checks → validation → Idempotency-Key → step-up → handler → response validation.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as common from '../../spec/common.js';
import { auth, callers, ISSUER, TEST_JWK, token } from '../../testing/app.js';
import { devClaims } from '../auth/dev.js';
import { moduleAuthorities } from '../auth/authorities.js';
import { signFileLink } from '../auth/file-links.js';
import { createAuthChain } from '../auth/setup.js';
import { devSigner, newDevJwk, signAccessToken } from '../auth/tokens.js';
import { loadConfig } from '../config/index.js';
import { createDatabase, type Database } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { migrate } from '../migrations/index.js';
import { defineEndpoints } from '../spec/define.js';
import { registerFileRoute } from './files.js';
import { postgresIdempotencyStore } from './idempotency.js';
import { notImplemented, routes } from './index.js';
import { registerEndpoints, registrationsOf } from './register.js';
import { createServer } from './server.js';
import { hmacWebhookVerifier, signWebhook } from './webhooks.js';

const Item = z.object({ id: z.uuid(), name: z.string(), price: common.Money });

const endpoints = defineEndpoints({
  getItem: { area: 'store', method: 'GET', path: '/items/{id}', auth: 'visitor', scope: 'public', summary: 'One item', params: () => z.object({ id: z.uuid() }), response: () => Item, status: 200, phase: 1 },
  listItems: { area: 'store', method: 'GET', path: '/items', auth: 'customer', scope: 'own-customer', summary: 'Items', query: () => z.object({ q: z.string().optional() }), paging: true, response: () => Item, status: 200, phase: 1 },
  placeOrder: { area: 'store', method: 'POST', path: '/orders', auth: 'shopper', scope: 'own-customer', summary: 'Place', body: () => z.object({ itemId: z.uuid(), quantity: z.number().int().min(1) }), response: () => z.object({ orderId: z.string(), n: z.number().int(), scope: z.string() }), status: 201, idempotent: true, phase: 1 },
  upload: { area: 'store', method: 'PUT', path: '/uploads/{id}/content', auth: 'shopper', scope: 'own-customer', summary: 'Raw bytes', params: () => z.object({ id: z.uuid() }), bodyFormat: 'binary', body: () => z.instanceof(Uint8Array), response: () => z.object({ bytes: z.number().int(), first: z.number().int(), type: z.string() }), status: 200, phase: 1 },
  broken: { area: 'store', method: 'GET', path: '/broken', auth: 'visitor', scope: 'public', summary: 'Returns the wrong shape', response: () => Item, status: 200, phase: 1 },
  unbuilt: { area: 'store', method: 'GET', path: '/unbuilt', auth: 'visitor', scope: 'public', summary: 'Not built', response: () => Item, status: 200, phase: 1 },
  later: { area: 'store', method: 'GET', path: '/later', auth: 'visitor', scope: 'public', summary: 'Phase 3', response: () => Item, status: 200, phase: 3 },
  publicInfo: { area: 'public', method: 'GET', path: '/info', auth: 'visitor', scope: 'public', summary: 'Any app', response: () => z.object({ ok: z.boolean() }), status: 200, phase: 1 },
  start: { area: 'public', method: 'POST', path: '/app-sessions', auth: 'bootstrap', scope: 'public', summary: 'Visitor token', response: () => z.object({ ok: z.boolean() }), status: 201, phase: 1 },
  refresh: { area: 'public', method: 'POST', path: '/sessions/refresh', auth: 'refresh', scope: 'public', summary: 'Refresh', body: () => z.object({ refreshToken: z.string().optional() }), response: () => z.object({ sessionId: z.string() }), status: 200, phase: 1 },
  approve: { area: 'admin', method: 'POST', path: '/items/{id}/approve', auth: 'staff', scope: 'staff', permission: 'demo.items.review', summary: 'Approve', params: () => z.object({ id: z.uuid() }), response: null, status: 204, phase: 1 },
  reports: { area: 'admin', method: 'GET', path: '/reports', auth: 'staff', scope: 'staff', summary: 'Reports', query: () => z.object({ view: z.string().optional() }), permissionWhen: [{ if: { 'query.view': 'all' }, permission: 'demo.reports.all' }], response: () => z.object({ view: z.string() }), status: 200, phase: 1 },
  mine: { area: 'seller', method: 'GET', path: '/mine', auth: 'seller', scope: 'own-seller', summary: 'Seller scope', response: () => z.object({ sellerId: z.string() }), status: 200, phase: 1 },
  payouts: { area: 'seller', method: 'POST', path: '/payout-account', auth: 'seller', scope: 'own-seller', permission: 'demo.payouts.manage', stepUp: { kind: 'reauth', purpose: 'payout-account' }, summary: 'Owner only, fresh proof', body: () => z.object({ reauthToken: z.string().optional() }), response: null, status: 204, phase: 1 },
  hook: { area: 'webhooks', method: 'POST', path: '/provider', auth: 'provider', scope: 'public', summary: 'Provider callback', body: () => z.unknown(), response: null, status: 204, phase: 1 },
  security: { area: 'store', method: 'GET', path: '/security/{id}', auth: 'account', scope: 'public', summary: 'Any signed-in account', params: () => z.object({ id: z.string() }), response: () => z.object({ ok: z.boolean() }), status: 200, phase: 1 },
  sendCode: { area: 'public', method: 'POST', path: '/codes', auth: 'visitor', scope: 'public', rateLimit: 'code', summary: 'Rate-limited class', response: null, status: 204, phase: 1 },
});

/** A second module whose webhooks are verified and answer a body */
const ackEndpoints = defineEndpoints({
  ack: { area: 'webhooks', method: 'POST', path: '/events', auth: 'provider', scope: 'public', summary: 'Acknowledged callback', body: () => z.unknown(), response: () => z.object({ received: z.boolean() }), status: 200, phase: 1 },
});
let acked = 0;

let placed = 0;
const item = (id: string) => ({ id, name: 'Trail runner', price: { amount: 18900, currency: 'USD' } });
const sets = [
  routes(endpoints, 'store', {
    security: async () => ({ ok: true }),
    getItem: async ({ params }) => item(params.id),
    listItems: async ({ page }) => ({ items: [item(newId())], nextCursor: null, ...(page.mode === 'page' ? { page: page.page, totalPages: 1, total: 1 } : {}) }),
    placeOrder: async ({ body, scope }) => ({ orderId: `MK-${++placed}`, n: body.quantity, scope: scope.kind }),
    upload: async ({ body, request }) => {
      // a stream, read by the handler (never buffered by the kernel)
      const chunks: Buffer[] = [];
      for await (const c of body ?? []) chunks.push(c as Buffer);
      const all = Buffer.concat(chunks);
      return { bytes: all.length, first: all[0] ?? -1, type: String(request.headers['content-type']) };
    },
    broken: async () => ({ id: 'not-a-uuid' }) as never,
    unbuilt: notImplemented,
    later: notImplemented,
  }),
  routes(endpoints, 'public', {
    publicInfo: async () => ({ ok: true }),
    start: async () => ({ ok: true }),
    sendCode: async () => undefined,
    refresh: async ({ request }) => ({ sessionId: request.auth!.refreshSession!.sessionId }),
  }),
  routes(endpoints, 'admin', { approve: async () => undefined, reports: async ({ query }) => ({ view: query.view ?? 'mine' }) }),
  routes(endpoints, 'seller', { mine: async ({ sellerId }) => ({ sellerId: sellerId! }), payouts: async () => undefined }),
  routes(endpoints, 'webhooks', { hook: async () => undefined }),
];
const ackSets = [routes(ackEndpoints, 'webhooks', { ack: async () => (acked++, { received: true }) })];

const REFRESH = 'refresh-token-ok';
const STORE_ORIGIN = 'https://store.example';
const SELLER_ORIGIN = 'https://seller.example';
const FILES_SECRET = 'demo-files-secret';
let app: FastifyInstance;
let db: Database;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test' }, { launchPhase: 2, devSigning: { file: '', jwk: TEST_JWK }, cors: { store: [STORE_ORIGIN], seller: [SELLER_ORIGIN], admin: [] } });
  db = await createDatabase();
  await migrate(db, []);
  app = createServer(config);
  const { auth: chain } = await createAuthChain({
    config,
    clock: { now: () => new Date() },
    log: app.log,
    db: db.kysely,
    authorities: moduleAuthorities(() => undefined),
    wrap: (a) => ({ ...a, verifyRefreshToken: async (t) => (t === REFRESH ? { sessionId: 'session-1', audience: 'store', kind: 'customer' } : null) }),
    webhookVerifiers: new Map([['acks', hmacWebhookVerifier(config, 'acks')]]),
    ownerOnly: new Set(['demo.payouts.manage']),
    fileLinks: { secret: FILES_SECRET, permanentBuckets: new Set(['pub']) },
  });
  chain.install(app);
  registerEndpoints(app, [...registrationsOf('demo', 'Demo', sets), ...registrationsOf('acks', 'Acks', ackSets)], {
    config,
    auth: chain,
    idempotency: postgresIdempotencyStore(db.kysely),
    sessionCookie: new Set(['demo.start']),
  });
  // the file the verified link names, as the serving module receives it
  registerFileRoute(app, { module: 'demo', permanentBuckets: ['pub'], serve: async (file, request, reply) => reply.send({ ...file, method: request.method, via: request.auth?.via }) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const visitor = auth(callers.visitor());

describe('token on every request', () => {
  it('refuses a request without a token, before routing', async () => {
    for (const url of [`/api/store/demo/items/${newId()}`, '/api/store/demo/nowhere', '/anything']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error).toMatchObject({ code: 'UNAUTHORIZED', details: { reason: 'token_missing' } });
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
    expect((await app.inject({ url: '/api/store/demo/nowhere', headers: visitor })).statusCode).toBe(404);
  });

  it('refuses expired, foreign-key and tampered tokens, and says a refresh can help', async () => {
    const expired = token(devClaims('customer'), -120);
    const foreign = signAccessToken(devSigner({ jwk: newDevJwk() }), devClaims('customer'), { issuer: ISSUER });
    const [h, b] = callers.customer().split('.');
    const tampered = `${h}.${b}.${'A'.repeat(86)}`;
    for (const [t, reason] of [[expired, 'token_expired'], [foreign, 'token_unknown_key'], [tampered, 'token_bad_signature'], ['abc', 'token_malformed']]) {
      const res = await app.inject({ url: `/api/store/demo/items/${newId()}`, headers: auth(t!) });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.details.reason).toBe(reason);
      expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    }
  });

  it('serves a visitor token on visitor endpoints', async () => {
    const res = await app.inject({ url: `/api/store/demo/items/${newId()}`, headers: { ...visitor, 'x-request-id': 'req-123' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-123');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('takes any app’s token on public endpoints', async () => {
    for (const t of [callers.visitor({ audience: 'seller' }), callers.staff(), callers.customer()]) {
      expect((await app.inject({ url: '/api/public/demo/info', headers: auth(t) })).statusCode).toBe(200);
    }
  });
});

describe('caller checks', () => {
  it('needs a signed-in customer where the endpoint says so', async () => {
    const res = await app.inject({ url: '/api/store/demo/items', headers: visitor });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.details.reason).toBe('sign_in_required');
    expect(res.headers['www-authenticate']).toBe('Bearer'); // not a token problem: refreshing won't help
    expect((await app.inject({ url: '/api/store/demo/items', headers: auth(callers.customer()) })).statusCode).toBe(200);
  });

  it('refuses a token issued for another app', async () => {
    const res = await app.inject({ url: '/api/store/demo/items', headers: auth(callers.staff()) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'WRONG_AUDIENCE', details: { tokenAudience: 'admin', area: 'store' } });
  });

  it('checks staff permissions and names the missing one', async () => {
    const url = `/api/admin/demo/items/${newId()}/approve`;
    const denied = await app.inject({ method: 'POST', url, headers: auth(callers.staff(['other.permission'])) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'demo.items.review' } });
    expect((await app.inject({ method: 'POST', url, headers: auth(callers.staff(['demo.items.review'])) })).statusCode).toBe(204);
  });

  it('needs 2-step verification for staff', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/admin/demo/items/${newId()}/approve`, headers: auth(callers.staff(undefined, { twoStepAt: undefined })) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'two-step-sign-in' } });
  });

  it('asks for the extra permission only when the request reaches further', async () => {
    const h = auth(callers.staff([]));
    expect((await app.inject({ url: '/api/admin/demo/reports', headers: h })).json()).toEqual({ view: 'mine' });
    const all = await app.inject({ url: '/api/admin/demo/reports?view=all', headers: h });
    expect(all.json().error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'demo.reports.all' } });
    expect((await app.inject({ url: '/api/admin/demo/reports?view=all', headers: auth(callers.staff(['demo.reports.all'])) })).statusCode).toBe(200);
  });

  it('acts for the seller in the token', async () => {
    const sellerId = newId();
    const res = await app.inject({ url: '/api/seller/demo/mine', headers: auth(callers.seller({ sellerId })) });
    expect(res.json()).toEqual({ sellerId });
  });

  it('needs a seller account chosen', async () => {
    const res = await app.inject({ url: '/api/seller/demo/mine', headers: auth(callers.seller({}, { sellerId: undefined })) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.details.reason).toBe('seller_context_required');
  });

  it('keeps owner-only permissions for the owner, and asks the owner for a fresh proof', async () => {
    const url = '/api/seller/demo/payout-account';
    const member = await app.inject({ method: 'POST', url, headers: auth(callers.seller({ permissions: ['demo.payouts.manage'] })), payload: {} });
    expect(member.json().error.code).toBe('OWNER_ONLY');
    const owner = auth(callers.seller());
    const stale = await app.inject({ method: 'POST', url, headers: owner, payload: {} });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'reauth', purpose: 'payout-account' } });
    expect((await app.inject({ method: 'POST', url, headers: owner, payload: { reauthToken: 'dev-reauth.other' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: owner, payload: { reauthToken: 'dev-reauth.payout-account' } })).statusCode).toBe(204);
  });

  it('lets a visitor shop as a guest, scoped to the visitor session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/store/demo/orders', headers: { ...visitor, 'idempotency-key': newId() }, payload: { itemId: newId(), quantity: 1 } });
    expect(res.statusCode).toBe(201);
    expect(res.json().scope).toBe('visitor');
  });

  it('hands a binary body to the handler as a stream, whatever the content type and size', async () => {
    const url = `/api/store/demo/uploads/${newId()}/content`;
    for (const [type, payload] of [['image/png', Buffer.from([137, 80, 78, 71, 13, 10])], ['application/json', Buffer.from('{"a":1}')], ['application/octet-stream', Buffer.alloc(3 * 1024 * 1024, 7)]] as const) {
      const res = await app.inject({ method: 'PUT', url, headers: { ...visitor, 'content-type': type }, payload });
      expect(res.statusCode, type).toBe(200);
      expect(res.json()).toEqual({ bytes: payload.length, first: payload[0], type });
    }
    expect((await app.inject({ method: 'PUT', url, payload: Buffer.from([1]) })).statusCode).toBe(401);
  });
});

describe('signed file links (GET /files/…)', () => {
  const link = (l: Partial<Parameters<typeof signFileLink>[1]> = {}, secret = FILES_SECRET) =>
    signFileLink(secret, { bucket: 'priv', key: 'docs/a b.pdf', expiresAt: new Date(Date.now() + 60_000), contentType: 'application/pdf', disposition: 'attachment; filename="a.pdf"', ...l });

  it('opens the exact file the signature names, without any Authorization header', async () => {
    const res = await app.inject({ url: link() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ bucket: 'priv', key: 'docs/a b.pdf', contentType: 'application/pdf', disposition: 'attachment; filename="a.pdf"', method: 'GET', via: 'file-link' });
    expect((await app.inject({ method: 'HEAD', url: link() })).statusCode).toBe(200);
    // permanent links, only for the public buckets
    expect((await app.inject({ url: link({ bucket: 'pub', expiresAt: null }) })).json()).toMatchObject({ bucket: 'pub', expiresAt: null });
  });

  it('refuses a missing, tampered or foreign signature in the middleware (401, no Bearer challenge)', async () => {
    const good = link();
    const bad = [
      good.replace(/sig=[^&]+/, ''), // no signature
      good.replace('docs/a%20b.pdf', 'docs/other.pdf'), // another file
      good.replace('priv/', 'pub/'), // another bucket
      good.replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) + 86_400}`), // a longer life
      good.replace('ct=application%2Fpdf', 'ct=text%2Fhtml'), // another content type
      link({}, 'another-secret'),
      link({ expiresAt: null }), // a permanent link to a private bucket
      '/files/priv/docs/a%20b.pdf',
    ];
    for (const url of bad) {
      const res = await app.inject({ url, headers: visitor }); // a valid Bearer token opens no file
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      expect(res.json().error.details.reason).toMatch(/^link_(missing|invalid)$/);
      expect(res.headers['www-authenticate']).toBeUndefined();
    }
  });

  it('refuses an expired link (403 link_expired) and needs a token for anything else under /files', async () => {
    const res = await app.inject({ url: link({ expiresAt: new Date(Date.now() - 61_000) }) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'link_expired' } });
    expect((await app.inject({ url: '/files' })).json().error.details.reason).toBe('token_missing');
    expect((await app.inject({ method: 'PUT', url: link() })).statusCode).toBe(401); // not a file route: 401 before 404
  });
});

describe('tokens other than bearer', () => {
  it('starts a session only with an app proof', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/public/demo/app-sessions' })).json().error.code).toBe('APP_PROOF_INVALID');
    expect((await app.inject({ method: 'POST', url: '/api/public/demo/app-sessions', headers: { 'x-app-proof': 'nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/public/demo/app-sessions', headers: { 'x-app-proof': 'dev' } })).statusCode).toBe(201);
  });

  it('refreshes only with a valid refresh token, from the cookie or the body', async () => {
    const url = '/api/public/demo/sessions/refresh';
    expect((await app.inject({ method: 'POST', url, payload: {} })).json().error.details.reason).toBe('token_missing');
    expect((await app.inject({ method: 'POST', url, payload: { refreshToken: 'wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, payload: { refreshToken: REFRESH } })).json()).toEqual({ sessionId: 'session-1' });
    const page = { origin: STORE_ORIGIN, 'x-requested-with': 'fetch' };
    expect((await app.inject({ method: 'POST', url, headers: { ...page, cookie: `__Secure-mk_refresh=${REFRESH}` }, payload: {} })).statusCode).toBe(200);
  });

  it('takes the website cookie only from an app page: allowed Origin and X-Requested-With (Android’s body token needs neither)', async () => {
    const url = '/api/public/demo/sessions/refresh';
    const cookie = `__Secure-mk_refresh=${REFRESH}`;
    for (const [headers, reason] of [
      [{ cookie, 'x-requested-with': 'fetch' }, 'origin_not_allowed'],
      [{ cookie, origin: 'https://evil.example', 'x-requested-with': 'fetch' }, 'origin_not_allowed'],
      [{ cookie, origin: SELLER_ORIGIN }, 'x_requested_with_required'],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, headers, payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', details: { reason } });
    }
    // every app's origin, and the API's own (a website served through it)
    for (const origin of [SELLER_ORIGIN, 'http://localhost:4000']) {
      expect((await app.inject({ method: 'POST', url, headers: { cookie, origin, 'x-requested-with': 'fetch' }, payload: {} })).statusCode, origin).toBe(200);
    }
    expect((await app.inject({ method: 'POST', url, payload: { refreshToken: REFRESH } })).statusCode).toBe(200);
  });

  it('processes a signed webhook once and acknowledges replays without running the handler', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const headers = { 'content-type': 'application/json', 'x-event-id': 'evt_1' };
    const first = await app.inject({ method: 'POST', url: '/webhooks/acks/events', headers: { ...headers, ...signWebhook('dev-webhook-secret', body) }, payload: body });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ received: true });
    const replay = await app.inject({ method: 'POST', url: '/webhooks/acks/events', headers: { ...headers, ...signWebhook('dev-webhook-secret', body) }, payload: body });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['x-webhook-duplicate']).toBe('true');
    expect(acked).toBe(1);
    const forged = await app.inject({ method: 'POST', url: '/webhooks/acks/events', headers: { ...headers, 'x-signature': 'sha256=00', 'x-timestamp': '1' }, payload: body });
    expect(forged.statusCode).toBe(401);
  });

  it('refuses webhooks until the module verifies signatures', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhooks/demo/provider', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('browsers (CORS) and response headers', () => {
  const preflight = (url: string, origin: string, method = 'POST') =>
    app.inject({ method: 'OPTIONS', url, headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': 'authorization, x-requested-with' } });

  it('allows credentials on the routes that set or read the refresh cookie, and only there', async () => {
    for (const url of ['/api/public/demo/app-sessions', '/api/public/demo/sessions/refresh', '/api/public/demo/sessions/refresh/']) {
      const res = await preflight(url, STORE_ORIGIN);
      expect(res.statusCode, url).toBe(204);
      expect(res.headers['access-control-allow-origin'], url).toBe(STORE_ORIGIN);
      expect(res.headers['access-control-allow-credentials'], url).toBe('true');
      expect(String(res.headers['access-control-allow-headers'])).toContain('x-requested-with');
    }
    const plain = await preflight('/api/public/demo/info', STORE_ORIGIN, 'GET');
    expect(plain.headers['access-control-allow-origin']).toBe(STORE_ORIGIN);
    expect(plain.headers['access-control-allow-credentials']).toBeUndefined();
    // the real response carries the same answer as its preflight
    const started = await app.inject({ method: 'POST', url: '/api/public/demo/app-sessions', headers: { origin: STORE_ORIGIN, 'x-app-proof': 'dev' } });
    expect(started.headers['access-control-allow-credentials']).toBe('true');
    expect((await preflight('/api/public/demo/app-sessions', 'https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets every app call the self-service account endpoints, and only its own app’s other endpoints', async () => {
    const res = await preflight(`/api/store/demo/security/${newId()}`, SELLER_ORIGIN, 'GET');
    expect(res.headers['access-control-allow-origin']).toBe(SELLER_ORIGIN);
    const get = await app.inject({ url: `/api/store/demo/security/x`, headers: { ...auth(callers.seller()), origin: SELLER_ORIGIN } });
    expect(get.statusCode).toBe(200);
    expect(get.headers['access-control-allow-origin']).toBe(SELLER_ORIGIN);
    expect((await preflight('/api/store/demo/orders', SELLER_ORIGIN)).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('exposes the headers apps read across origins', async () => {
    const res = await app.inject({ url: '/api/store/demo/items', headers: { origin: STORE_ORIGIN } });
    expect(res.statusCode).toBe(401);
    const exposed = String(res.headers['access-control-expose-headers']).toLowerCase().split(/,\s*/);
    expect(exposed).toEqual(expect.arrayContaining(['www-authenticate', 'x-request-id', 'idempotent-replayed', 'retry-after']));
  });

  it('says when to retry a refused request (Retry-After)', async () => {
    const h = auth(callers.visitor({ audience: 'seller' }));
    let res;
    for (let i = 0; i < 31 && res?.statusCode !== 429; i++) res = await app.inject({ method: 'POST', url: '/api/public/demo/codes', headers: h });
    expect(res!.statusCode).toBe(429);
    const seconds = res!.json().error.details.retryAfterSeconds;
    expect(seconds).toBeGreaterThan(0);
    expect(res!.headers['retry-after']).toBe(String(seconds));
  });
});

describe('validation', () => {
  it('answers VALIDATION_FAILED with the fields', async () => {
    const res = await app.inject({ url: '/api/store/demo/items/not-a-uuid', headers: visitor });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'params.id' }] } });
  });

  it('refuses responses that do not match the spec', async () => {
    const res = await app.inject({ url: '/api/store/demo/broken', headers: visitor });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
  });
});

describe('paging', () => {
  it('wraps lists in a page and validates paging input', async () => {
    const h = auth(callers.customer());
    const res = await app.inject({ url: '/api/store/demo/items?page=1&limit=10', headers: h });
    expect(res.json()).toMatchObject({ items: [{ name: 'Trail runner' }], nextCursor: null, page: 1, totalPages: 1 });
    expect((await app.inject({ url: '/api/store/demo/items?limit=101', headers: h })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/store/demo/items?cursor=x&page=2', headers: h })).statusCode).toBe(400);
  });
});

describe('launch phases and unbuilt endpoints', () => {
  it('answers NOT_IMPLEMENTED for a later launch phase', async () => {
    const res = await app.inject({ url: '/api/store/demo/later', headers: visitor });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.details).toMatchObject({ reason: 'later_phase', phase: 3 });
  });

  it('answers NOT_IMPLEMENTED for a designed endpoint that is not built', async () => {
    const res = await app.inject({ url: '/api/store/demo/unbuilt', headers: visitor });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.details).toMatchObject({ reason: 'not_built', operation: 'demo.unbuilt' });
  });
});

describe('Idempotency-Key', () => {
  const h = auth(callers.customer({ accountId: newId() }));
  const body = { itemId: newId(), quantity: 2 };

  it('is required', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/store/demo/orders', headers: h, payload: body });
    expect(res.statusCode).toBe(400);
  });

  it('replays the first result instead of placing the order twice', async () => {
    const key = newId();
    const first = await app.inject({ method: 'POST', url: '/api/store/demo/orders', headers: { ...h, 'idempotency-key': key }, payload: body });
    const again = await app.inject({ method: 'POST', url: '/api/store/demo/orders', headers: { ...h, 'idempotency-key': key }, payload: body });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(again.headers['idempotent-replayed']).toBe('true');
  });

  it('refuses the same key with a different request', async () => {
    const key = newId();
    await app.inject({ method: 'POST', url: '/api/store/demo/orders', headers: { ...h, 'idempotency-key': key }, payload: body });
    const res = await app.inject({ method: 'POST', url: '/api/store/demo/orders', headers: { ...h, 'idempotency-key': key }, payload: { ...body, quantity: 3 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
