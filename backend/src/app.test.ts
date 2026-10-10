import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withStubs } from './app.js';
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
    expect(app.kernel.health()).toMatchObject({ status: 'ok', modules: enabledModules.length, launchPhase: 2 });
  });

  it('builds the OpenAPI document (served at /docs in development only)', async () => {
    expect((await app.inject({ url: '/docs/json' })).statusCode).toBe(401);
    const doc = app.swagger() as any;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/api/store/catalog/products/{id}']).toBeDefined();
    expect(doc.components.schemas['catalog.Product']).toBeDefined();
  });

  it('needs a token before anything else, even for unknown routes', async () => {
    const anon = await app.inject({ url: '/api/store/nowhere' });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['www-authenticate']).toBe('Bearer');
  });

  it('uses the spec error format for unknown routes', async () => {
    const res = await app.inject({ url: '/api/store/nowhere', headers: auth(callers.visitor()) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No route GET /api/store/nowhere' } });
  });

  describe('GraphQL read layer', () => {
    it('answers on each area with that area’s token', async () => {
      const ping = { query: '{ ping }' };
      expect((await app.inject({ method: 'POST', url: '/graphql/store', payload: ping })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/graphql/store', payload: ping, headers: auth(callers.visitor()) })).json()).toEqual({ data: { ping: 'pong' } });
      expect((await app.inject({ method: 'POST', url: '/graphql/seller', payload: ping, headers: auth(callers.customer()) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/graphql/admin', payload: ping })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/graphql/admin', payload: ping, headers: auth(callers.staff()) })).json()).toEqual({ data: { ping: 'pong' } });
      expect((await app.inject({ method: 'POST', url: '/graphql/seller', payload: ping, headers: auth(callers.seller()) })).json()).toEqual({ data: { ping: 'pong' } });
    });

    it('has no mutations', async () => {
      const res = await app.inject({ method: 'POST', url: '/graphql/store', payload: { query: 'mutation { ping }' }, headers: auth(callers.visitor()) });
      expect(res.json().errors?.length).toBeGreaterThan(0);
    });

    it('keeps the REST status and error code for token problems', async () => {
      const res = await app.inject({ method: 'POST', url: '/graphql/admin', payload: { query: '{ ping }' } });
      expect(res.statusCode).toBe(401);
      expect(res.json().errors[0].extensions.code).toBe('UNAUTHORIZED');
    });

    it('runs persisted screen queries', async () => {
      const [id, op] = Object.entries(persistedQueries.store).find(([, q]) => q.name === 'OrderList')!;
      const res = await app.inject({ method: 'POST', url: '/graphql/store', payload: { persisted: true, query: id, variables: {} }, headers: auth(callers.customer()) });
      expect(op.screens).toContain('account/orders');
      expect(res.json().errors, res.body).toBeUndefined();
      expect(res.json().data).toBeDefined();
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

  it('boots the phase 4 fulfillment service from MODULES like any other module', async () => {
    const app = await buildTestApp({ env: { NODE_ENV: 'test', MODULES: [...enabledModules, 'fulfillment-service'].join(',') }, config: { launchPhase: 4 } });
    try {
      expect(app.kernel.modules).toContain('fulfillment-service');
    } finally {
      await app.close();
    }
  });
});

describe('apiStubs (tests)', () => {
  /** A public API whose methods use private fields, like the module services */
  class Counter {
    #n = 0;
    bump() {
      return ++this.#n;
    }
    twice() {
      this.bump();
      return this.bump();
    }
  }

  it("keeps the module's own methods (with #private fields) working next to a stubbed one", () => {
    const api = withStubs(new Counter(), { bump: () => 100 }) as Counter;
    expect(api.bump()).toBe(100); // the stub
    expect(api.twice()).toBe(2); // the module's own method, on the module object: its private field and its own bump
    const unstubbed = withStubs(new Counter(), {}) as Counter;
    expect(unstubbed.twice()).toBe(2);
    expect(unstubbed.twice).toBe(unstubbed.twice); // bound once
    // a function assigned later replaces the stub of the same name
    (api as { bump: () => number }).bump = () => 7;
    expect(api.bump()).toBe(7);
  });

  it('answers an optional lookup (tryUse) of a module that is off with its stub', async () => {
    const app = await buildTestApp({ only: ['orders'], apiStubs: { 'fulfillment-service': { isServiceOffer: async () => true } } });
    try {
      expect(app.kernel.modules).not.toContain('fulfillment-service');
      const ctx = (app.kernel.boot.apis.get('orders') as { core: { ctx: { tryUse(m: string): { isServiceOffer(id: string): Promise<boolean> } | undefined } } }).core.ctx;
      expect(await ctx.tryUse('fulfillment-service')!.isServiceOffer('any')).toBe(true);
      expect(ctx.tryUse('fulfillment-service')).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
