import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enabledModules } from './modules.config.js';
import { persistedQueries } from './spec/graphql.js';
import { auth, buildTestApp, callers } from './testing/app.js';

describe('the launch configuration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('boots every launch module', async () => {
    expect([...app.kernel.modules].sort()).toEqual([...enabledModules].sort());
    const res = await app.inject({ url: '/health' });
    expect(res.json()).toMatchObject({ status: 'ok', modules: enabledModules.length, launchPhase: 2 });
  });

  it('serves the OpenAPI document at /docs', async () => {
    const res = await app.inject({ url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/api/store/catalog/products/{id}']).toBeDefined();
    expect(doc.components.schemas['catalog.Product']).toBeDefined();
  });

  it('uses the spec error format for unknown routes', async () => {
    const res = await app.inject({ url: '/api/store/nowhere' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No route GET /api/store/nowhere' } });
  });

  describe('GraphQL read layer', () => {
    it('answers on each area with that area’s session', async () => {
      const ping = { query: '{ ping }' };
      expect((await app.inject({ method: 'POST', url: '/graphql/store', payload: ping })).json()).toEqual({ data: { ping: 'pong' } });
      expect((await app.inject({ method: 'POST', url: '/graphql/admin', payload: ping })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/graphql/admin', payload: ping, headers: auth(callers.staff()) })).json()).toEqual({ data: { ping: 'pong' } });
      expect((await app.inject({ method: 'POST', url: '/graphql/seller', payload: ping, headers: auth(callers.seller()) })).json()).toEqual({ data: { ping: 'pong' } });
    });

    it('has no mutations', async () => {
      const res = await app.inject({ method: 'POST', url: '/graphql/store', payload: { query: 'mutation { ping }' } });
      expect(res.json().errors?.length).toBeGreaterThan(0);
    });

    it('keeps the REST status and error code for session problems', async () => {
      const res = await app.inject({ method: 'POST', url: '/graphql/admin', payload: { query: '{ ping }' } });
      expect(res.statusCode).toBe(401);
      expect(res.json().errors[0].extensions.code).toBe('UNAUTHORIZED');
    });

    it('runs persisted screen queries; unbuilt fields answer NOT_IMPLEMENTED', async () => {
      const [id, op] = Object.entries(persistedQueries.store).find(([, q]) => q.name === 'OrderList')!;
      const res = await app.inject({ method: 'POST', url: '/graphql/store', payload: { persisted: true, query: id, variables: {} }, headers: auth(callers.customer()) });
      expect(op.screens).toContain('account/orders');
      expect(res.json().errors?.[0]?.extensions?.code).toBe('NOT_IMPLEMENTED');
    });

    it('reports screen queries that need a module that is off at launch', () => {
      // Product.saved (wishlist, phase 3) and Customer.wallet / walletAdmin (wallet, phase 3): see the design note in README
      const names = app.kernel.unusableQueries.map((q) => `${q.area}/${q.name}`).sort();
      expect(names).toEqual(['admin/AdminCustomer', 'store/AccountOverview', 'store/CategoryPage', 'store/HomePage', 'store/ProductPage', 'store/SearchResults', 'store/SellerStorefront']);
    });
  });
});

describe('module configuration', () => {
  it('refuses to start when an enabled module needs one that is off', async () => {
    await expect(buildTestApp({ modules: ['wishlist', 'customers', 'identity'] })).rejects.toThrow(/"wishlist" needs "catalog"/);
  });
});
