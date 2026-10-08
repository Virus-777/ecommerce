/**
 * The request pipeline every spec endpoint goes through, on a small made-up module:
 * phase gate → auth → validation → Idempotency-Key → handler → response validation.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as common from '../../spec/common.js';
import { auth, callers, TEST_SECRET } from '../../testing/app.js';
import { devAuthenticator, moduleAuthenticator } from '../auth/authenticators.js';
import { loadConfig } from '../config/index.js';
import { createDatabase, type Database } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { migrate } from '../migrations/index.js';
import { defineEndpoints } from '../spec/define.js';
import { postgresIdempotencyStore } from './idempotency.js';
import { notImplemented, routes } from './index.js';
import { registerEndpoints, registrationsOf } from './register.js';
import { createServer } from './server.js';

const Item = z.object({ id: z.uuid(), name: z.string(), price: common.Money });

const endpoints = defineEndpoints({
  getItem: { area: 'store', method: 'GET', path: '/items/{id}', auth: 'anyone', summary: 'One item', params: () => z.object({ id: z.uuid() }), response: () => Item, status: 200, phase: 1 },
  listItems: { area: 'store', method: 'GET', path: '/items', auth: 'customer', summary: 'Items', query: () => z.object({ q: z.string().optional() }), paging: true, response: () => Item, status: 200, phase: 1 },
  placeOrder: { area: 'store', method: 'POST', path: '/orders', auth: 'shopper', summary: 'Place', body: () => z.object({ itemId: z.uuid(), quantity: z.number().int().min(1) }), response: () => z.object({ orderId: z.string(), n: z.number().int() }), status: 201, idempotent: true, phase: 1 },
  broken: { area: 'store', method: 'GET', path: '/broken', auth: 'anyone', summary: 'Returns the wrong shape', response: () => Item, status: 200, phase: 1 },
  unbuilt: { area: 'store', method: 'GET', path: '/unbuilt', auth: 'anyone', summary: 'Not built', response: () => Item, status: 200, phase: 1 },
  later: { area: 'store', method: 'GET', path: '/later', auth: 'anyone', summary: 'Phase 3', response: () => Item, status: 200, phase: 3 },
  approve: { area: 'admin', method: 'POST', path: '/items/{id}/approve', auth: 'staff', permission: 'demo.items.review', summary: 'Approve', params: () => z.object({ id: z.uuid() }), response: null, status: 204, phase: 1 },
  mine: { area: 'seller', method: 'GET', path: '/mine', auth: 'seller', summary: 'Seller scope', response: () => z.object({ sellerId: z.string() }), status: 200, phase: 1 },
  hook: { area: 'webhooks', method: 'POST', path: '/provider', auth: 'provider', summary: 'Provider callback', body: () => z.unknown(), response: null, status: 204, phase: 1 },
});

let placed = 0;
const item = (id: string) => ({ id, name: 'Trail runner', price: { amount: 18900, currency: 'USD' } });
const sets = [
  routes(endpoints, 'store', {
    getItem: async ({ params }) => item(params.id),
    listItems: async ({ page }) => ({ items: [item(newId())], nextCursor: null, ...(page.mode === 'page' ? { page: page.page, totalPages: 1, total: 1 } : {}) }),
    placeOrder: async ({ body }) => ({ orderId: `MK-${++placed}`, n: body.quantity }),
    broken: async () => ({ id: 'not-a-uuid' }) as never,
    unbuilt: notImplemented,
    later: notImplemented,
  }),
  routes(endpoints, 'admin', { approve: async () => undefined }),
  routes(endpoints, 'seller', { mine: async ({ sellerId }) => ({ sellerId }) }),
  routes(endpoints, 'webhooks', { hook: async () => undefined }),
];

let app: FastifyInstance;
let db: Database;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test' }, { launchPhase: 2 });
  db = await createDatabase();
  await migrate(db, []);
  app = createServer(config);
  registerEndpoints(app, registrationsOf('demo', 'Demo', sets), {
    config,
    authenticator: devAuthenticator(TEST_SECRET, moduleAuthenticator(() => undefined)),
    idempotency: postgresIdempotencyStore(db.kysely),
    webhookVerifiers: new Map(),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('validation', () => {
  it('answers VALIDATION_FAILED with the fields', async () => {
    const res = await app.inject({ url: '/api/store/demo/items/not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'params.id' }] } });
  });

  it('sends the request id back', async () => {
    const res = await app.inject({ url: `/api/store/demo/items/${newId()}`, headers: { 'x-request-id': 'req-123' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-123');
  });

  it('refuses responses that do not match the spec', async () => {
    const res = await app.inject({ url: '/api/store/demo/broken' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
  });
});

describe('auth guard', () => {
  it('needs the session the endpoint names', async () => {
    expect((await app.inject({ url: '/api/store/demo/items' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/store/demo/items', headers: auth(callers.customer()) })).statusCode).toBe(200);
  });

  it('rejects a token issued for another area', async () => {
    const res = await app.inject({ url: '/api/store/demo/items', headers: auth(callers.staff()) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/admin area/);
  });

  it('checks staff permissions and names the missing one', async () => {
    const url = `/api/admin/demo/items/${newId()}/approve`;
    const denied = await app.inject({ method: 'POST', url, headers: auth(callers.staff(['other.permission'])) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'demo.items.review' } });
    const ok = await app.inject({ method: 'POST', url, headers: auth(callers.staff(['demo.items.review'])) });
    expect(ok.statusCode).toBe(204);
  });

  it('acts for the seller in the token', async () => {
    const sellerId = newId();
    const res = await app.inject({ url: '/api/seller/demo/mine', headers: auth(callers.seller({ sellerId })) });
    expect(res.json()).toEqual({ sellerId });
  });

  it('accepts a guest session on shopper endpoints', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/store/demo/orders', headers: { 'x-guest-session': newId(), 'idempotency-key': newId() }, payload: { itemId: newId(), quantity: 1 } });
    expect(res.statusCode).toBe(201);
  });

  it('refuses webhooks until the module verifies signatures', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhooks/demo/provider', payload: {} });
    expect(res.statusCode).toBe(401);
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
    const res = await app.inject({ url: '/api/store/demo/later' });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.details).toMatchObject({ reason: 'later_phase', phase: 3 });
  });

  it('answers NOT_IMPLEMENTED for a designed endpoint that is not built', async () => {
    const res = await app.inject({ url: '/api/store/demo/unbuilt' });
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
