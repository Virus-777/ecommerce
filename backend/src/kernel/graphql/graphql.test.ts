/**
 * The GraphQL kernel on a small made-up module: persisted query formats, limits (cost, depth, page size,
 * time budget), field-level @auth refusals and the error codes clients see.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Actor } from '../../spec/common.js';
import { baseTypeDefs } from '../../spec/graphql.js';
import type { AuthChain } from '../auth/chain.js';
import type { Principal, RequestAuth } from '../auth/index.js';
import { loadConfig, type Config } from '../config/index.js';
import { ACTOR_KIND, gqlActor, LIMITS, registerGraphQL, type GraphQLKernelOptions, type ModuleResolvers } from './index.js';

const fragment = /* GraphQL */ `
  type DemoItem {
    id: ID!
    name: String!
    secret: String @areas(in: [ADMIN]) @auth(requires: STAFF, permission: "demo.secrets.view")
    email: String @sensitive(permission: "demo.contact.view", mask: "email")
    phones: [String!] @sensitive(permission: "demo.contact.view", mask: "phone")
    note: String @sensitive(permission: "demo.contact.view", mask: "hide")
    "Converted by the demo module's DemoItem resolver (no @source: demo defines the type)"
    shout: String!
  }
  type DemoItemPage {
    items: [DemoItem!]!
    nextCursor: String
  }
  type DemoNode {
    id: ID!
    child: DemoNode
  }
  extend type Query {
    demoItems(paging: PageInput): DemoItemPage! @source(module: "demo", fn: "list")
    demoTop(limit: Int = 10, previewLimit: Int): [DemoItem!]! @source(module: "demo", fn: "top")
    demoSlow: String @source(module: "demo", fn: "slow")
    demoHeavy: String @cost(weight: 400) @source(module: "demo", fn: "heavy")
    demoTree: DemoNode @source(module: "demo", fn: "tree")
    demoMe: String @areas(in: [STORE]) @auth(requires: CUSTOMER) @source(module: "demo", fn: "me")
    demoPrices: [Money!]! @source(module: "demo", fn: "prices")
  }
`;

/** A module that is off: its fragment is in the schema, its fields answer null */
const offFragment = /* GraphQL */ `
  extend type DemoItem {
    saved: Boolean @source(module: "off", fn: "isSaved")
  }
`;

const seen: { paging?: unknown; limit?: unknown; previewLimit?: unknown }[] = [];
const node = (n: number): { id: string; child: unknown } => ({ id: String(n), child: n < 20 ? node(n + 1) : null });
const resolvers: ModuleResolvers = {
  DemoItem: {
    shout: (r: { name: string }) => `${r.name.toUpperCase()}!`,
  },
  Query: {
    demoItems: (_r, args: { paging?: unknown }) => (seen.push({ paging: args.paging }), { items: [{ id: '1', name: 'One', secret: 's', email: 'ana@example.com', phones: ['+15035550123'], note: 'VIP' }], nextCursor: null }),
    demoTop: (_r, args: { limit?: unknown; previewLimit?: unknown }) => (seen.push({ limit: args.limit, previewLimit: args.previewLimit }), []),
    demoSlow: () => new Promise((resolve) => setTimeout(() => resolve('late'), 400)),
    demoHeavy: () => 'heavy',
    demoTree: () => node(1),
    demoMe: () => 'me',
    // REST shapes, as most module resolvers return them; the second keeps a module's own text
    demoPrices: () => [{ amount: 18900, currency: 'USD' }, { amount: 500, currency: 'USD', formatted: 'Five dollars' }],
  },
};

const PING_ID = 'a'.repeat(64);
const persisted = { store: { [PING_ID]: 'query Ping { ping }' }, seller: {}, admin: {} };

const principals: Record<string, Principal> = {
  visitor: { kind: 'visitor', audience: 'store', sessionId: 'v1', guestSessionId: 'v1' },
  customer: { kind: 'customer', audience: 'store', accountId: 'c1', sessionId: 's1' },
  staff: { kind: 'staff', audience: 'admin', accountId: 'st1', sessionId: 's2' },
  seller: { kind: 'seller', audience: 'seller', accountId: 'se1', sessionId: 's3', sellerId: 'seller-1' },
};

/** The kernel without the token middleware: `x-test-caller: staff` (and `x-test-permissions`) stand for a verified token */
async function demoApp(o: { persistedOnly?: boolean; limits?: GraphQLKernelOptions['limits'] } = {}) {
  const app = Fastify();
  app.decorateRequest('auth', undefined);
  app.addHook('onRequest', async (request) => {
    const kind = String(request.headers['x-test-caller'] ?? 'visitor');
    const permissions = String(request.headers['x-test-permissions'] ?? '').split(',').filter(Boolean);
    (request as { auth?: RequestAuth & { permissions?: string[] } }).auth = { via: 'token', principal: principals[kind]!, permissions };
  });
  const auth = {
    checkCaller: async () => undefined,
    can: async (a: RequestAuth & { permissions?: string[] }, p: string) => Boolean(a?.permissions?.includes(p)),
    customerIdOf: async () => null,
  } as unknown as AuthChain;
  const config: Config = { ...loadConfig({ NODE_ENV: 'test' }), graphqlPersistedOnly: o.persistedOnly ?? false };
  await registerGraphQL(app, { config, baseTypeDefs, fragments: [{ module: 'demo', typeDefs: fragment }, { module: 'off', typeDefs: offFragment }], resolvers: new Map([['demo', resolvers]]), auth, persisted, limits: o.limits, enabledModules: new Set(['demo']) });
  await app.ready();
  return app;
}

const post = (app: FastifyInstance, area: string, payload: unknown, caller = 'visitor', permissions = '') =>
  app.inject({ method: 'POST', url: `/graphql/${area}`, payload: payload as object, headers: { 'x-test-caller': caller, 'x-test-permissions': permissions } });

describe('GraphQL kernel', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await demoApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  describe('persisted queries', () => {
    it('runs a manifest id sent the mercurius way', async () => {
      const res = await post(app, 'store', { persisted: true, query: PING_ID });
      expect(res.json()).toEqual({ data: { ping: 'pong' } });
    });

    it('runs a manifest id sent the Apollo way (automatic persisted queries), by POST and by GET', async () => {
      const extensions = { persistedQuery: { version: 1, sha256Hash: PING_ID } };
      expect((await post(app, 'store', { extensions, variables: {} })).json()).toEqual({ data: { ping: 'pong' } });
      const get = await app.inject({ url: `/graphql/store?operationName=Ping&extensions=${encodeURIComponent(JSON.stringify(extensions))}`, headers: { 'x-test-caller': 'visitor' } });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ data: { ping: 'pong' } });
    });

    it('answers an unknown id with PersistedQueryNotFound', async () => {
      const res = await post(app, 'store', { extensions: { persistedQuery: { version: 1, sha256Hash: 'b'.repeat(64) } } });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0]).toMatchObject({ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } });
    });

    it('accepts only manifest ids where persisted-only is on (store and seller in production), in both formats', async () => {
      const only = await demoApp({ persistedOnly: true });
      try {
        const text = await post(only, 'store', { query: '{ ping }' });
        expect(text.statusCode).toBe(400);
        expect(text.json().errors[0].extensions.code).toBe('PERSISTED_QUERY_NOT_SUPPORTED');
        expect((await post(only, 'store', { persisted: true, query: PING_ID })).json()).toEqual({ data: { ping: 'pong' } });
        // an Apollo retry carrying query text still runs the manifest's text, never the client's
        const retry = await post(only, 'store', { query: '{ demoHeavy }', extensions: { persistedQuery: { version: 1, sha256Hash: PING_ID } } });
        expect(retry.json()).toEqual({ data: { ping: 'pong' } });
        // staff tools may send ad-hoc queries
        expect((await post(only, 'admin', { query: '{ ping }' }, 'staff')).json()).toEqual({ data: { ping: 'pong' } });
      } finally {
        await only.close();
      }
    });
  });

  describe('limits', () => {
    it(`refuses a query above the cost limit (${LIMITS.maxCost}) before anything resolves`, async () => {
      const ok = await post(app, 'store', { query: '{ a: demoHeavy b: demoHeavy c: demoHeavy }' });
      expect(ok.json().data).toEqual({ a: 'heavy', b: 'heavy', c: 'heavy' });
      const res = await post(app, 'store', { query: '{ a: demoHeavy b: demoHeavy c: demoHeavy d: demoHeavy }' });
      expect(res.statusCode).toBe(400);
      expect(res.json().data).toBeNull();
      expect(res.json().errors[0].extensions).toEqual({ code: 'QUERY_TOO_COMPLEX', details: { cost: 1600, limit: LIMITS.maxCost } });
    });

    it('counts lists as 10 and repeated fragments each time they are spread', async () => {
      const spreads = Array.from({ length: 160 }, (_, i) => `t${i}: demoTop { id }`).join(' ');
      const res = await post(app, 'store', { query: `{ ${spreads} }` });
      // each: demoTop (list, 10) + id (1) = 11 → 1,760
      expect(res.json().errors[0].extensions).toEqual({ code: 'QUERY_TOO_COMPLEX', details: { cost: 1760, limit: LIMITS.maxCost } });
    });

    it(`refuses a query deeper than ${LIMITS.maxDepth} levels with the same code`, async () => {
      const deep = '{ demoTree { child { child { child { child { child { child { child { child { child { id } } } } } } } } } } }';
      const res = await post(app, 'store', { query: deep });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
    });

    it(`clamps page sizes to 1–${LIMITS.maxPageSize}`, async () => {
      seen.length = 0;
      await post(app, 'store', { query: '{ a: demoItems(paging: { limit: 500 }) { nextCursor } b: demoItems(paging: { limit: 0, cursor: "x" }) { nextCursor } c: demoItems { nextCursor } }' });
      await post(app, 'store', { query: 'query($n: Int) { demoTop(limit: $n, previewLimit: 7000) { id } }', variables: { n: 1000 } });
      await post(app, 'store', { query: '{ demoTop { id } }' });
      expect(seen).toEqual([{ paging: { limit: 100 } }, { paging: { limit: 1, cursor: 'x' } }, { paging: undefined }, { limit: 100, previewLimit: 100 }, { limit: 10, previewLimit: undefined }]);
    });

    it('answers QUERY_TIMEOUT for fields still running after the time budget; the rest of the data stays', async () => {
      const quick = await demoApp({ limits: { timeoutMs: 50 } });
      try {
        const res = await post(quick, 'store', { query: '{ ping demoSlow demoHeavy }' });
        expect(res.statusCode).toBe(200);
        expect(res.json().data).toEqual({ ping: 'pong', demoSlow: null, demoHeavy: 'heavy' });
        expect(res.json().errors).toHaveLength(1);
        expect(res.json().errors[0]).toMatchObject({ path: ['demoSlow'], extensions: { code: 'QUERY_TIMEOUT', details: { timeoutMs: 50 } } });
      } finally {
        await quick.close();
      }
    });
  });

  describe('field-level @auth', () => {
    it('refuses with FORBIDDEN (not UNAUTHORIZED, so clients keep their token) inside a 200 partial response', async () => {
      const guest = await post(app, 'store', { query: '{ ping demoMe }' });
      expect(guest.statusCode).toBe(200);
      expect(guest.json().data).toEqual({ ping: 'pong', demoMe: null });
      expect(guest.json().errors[0].extensions).toEqual({ code: 'FORBIDDEN', details: { reason: 'sign_in_required', requires: 'CUSTOMER' } });
      expect((await post(app, 'store', { query: '{ demoMe }' }, 'customer')).json()).toEqual({ data: { demoMe: 'me' } });
    });

    it('refuses a staff field without the permission with FORBIDDEN and the permission, like REST', async () => {
      const without = await post(app, 'admin', { query: '{ demoItems { items { id secret } } }' }, 'staff');
      expect(without.statusCode).toBe(200);
      expect(without.json().data.demoItems.items[0]).toEqual({ id: '1', secret: null });
      expect(without.json().errors[0].extensions).toEqual({ code: 'FORBIDDEN', details: { permission: 'demo.secrets.view' } });
      const withIt = await post(app, 'admin', { query: '{ demoItems { items { secret } } }' }, 'staff', 'demo.secrets.view');
      expect(withIt.json()).toEqual({ data: { demoItems: { items: [{ secret: 's' }] } } });
    });
  });

  describe('@sensitive fields', () => {
    const q = { query: '{ demoItems { items { email phones note } } }' };
    const itemOf = (res: { json(): any }) => res.json().data.demoItems.items[0];

    it('masks them centrally in the admin and seller areas without the permission, with the REST masks', async () => {
      const masked = { email: 'a***@example.com', phones: ['***23'], note: null };
      expect(itemOf(await post(app, 'admin', q, 'staff'))).toEqual(masked);
      expect(itemOf(await post(app, 'seller', q, 'seller'))).toEqual(masked);
    });

    it('shows them to holders of the permission, and in the store (the shopper’s own data)', async () => {
      const plain = { email: 'ana@example.com', phones: ['+15035550123'], note: 'VIP' };
      expect(itemOf(await post(app, 'admin', q, 'staff', 'demo.contact.view'))).toEqual(plain);
      expect(itemOf(await post(app, 'seller', q, 'seller', 'demo.contact.view'))).toEqual(plain);
      expect(itemOf(await post(app, 'store', q, 'customer'))).toEqual(plain);
    });
  });

  describe("fields of a module's own types", () => {
    it("are converted by that module's type resolver, without @source", async () => {
      const res = await post(app, 'store', { query: '{ demoItems { items { name shout } } }' });
      expect(res.json()).toEqual({ data: { demoItems: { items: [{ name: 'One', shout: 'ONE!' }] } } });
    });
  });

  describe('modules that are off', () => {
    it('keep their fields in the schema, answering null, so screen queries that select them still run', async () => {
      const res = await post(app, 'store', { query: '{ demoItems { items { name saved } } }' });
      expect(res.json()).toEqual({ data: { demoItems: { items: [{ name: 'One', saved: null }] } } });
    });
  });

  describe('Money', () => {
    it('formats every Money a resolver returns without its text, and keeps a text it gives', async () => {
      const res = await post(app, 'store', { query: '{ demoPrices { amount currency formatted } }' });
      expect(res.json()).toEqual({ data: { demoPrices: [{ amount: 18900, currency: 'USD', formatted: '$189.00' }, { amount: 500, currency: 'USD', formatted: 'Five dollars' }] } });
    });
  });

  describe('Actor', () => {
    it('maps every REST actor kind the same way for every module (visitor and anonymous → GUEST, provider and system → SYSTEM)', () => {
      const kinds: Actor['kind'][] = ['customer', 'visitor', 'anonymous', 'seller', 'staff', 'provider', 'system'];
      expect(Object.keys(ACTOR_KIND).sort()).toEqual([...kinds].sort());
      expect(Actor.safeParse({ kind: 'robot' }).success).toBe(false); // the REST enum has exactly these kinds
      expect(kinds.map((k) => gqlActor({ kind: k, id: 'x' })?.kind)).toEqual(kinds.map((k) => ({ customer: 'CUSTOMER', visitor: 'GUEST', anonymous: 'GUEST', seller: 'SELLER', staff: 'STAFF', provider: 'SYSTEM', system: 'SYSTEM' })[k]));
      expect(gqlActor({ kind: 'provider', name: 'stripe' })).toEqual({ kind: 'SYSTEM', id: null, name: 'stripe' });
      expect(gqlActor(null)).toBeNull();
      for (const k of kinds) expect(Actor.safeParse({ kind: k }).success).toBe(true);
    });

    it('is the only mapping: module resolvers use it instead of their own', () => {
      const modules = join(dirname(fileURLToPath(import.meta.url)), '../../modules');
      const own = readdirSync(modules, { recursive: true, encoding: 'utf8' })
        .filter((f) => /graphql[\\/][^\\/]+\.ts$/.test(f))
        .filter((f) => /\b(ACTOR_KIND|ActorKind)\b.*[:=]\s*(Record<|\{)|'GUEST'/.test(readFileSync(join(modules, f), 'utf8')));
      expect(own).toEqual([]);
    });
  });

  describe('errors', () => {
    it('gives every error an extensions.code', async () => {
      const syntax = await post(app, 'store', { query: '{ ping ' });
      expect(syntax.statusCode).toBe(400);
      expect(syntax.json().errors[0].extensions.code).toBe('VALIDATION_FAILED');
      const unknown = await post(app, 'store', { query: '{ nothingHere }' });
      expect(unknown.json().errors[0].extensions.code).toBe('VALIDATION_FAILED');
      const variables = await post(app, 'store', { query: 'query($n: Int!) { demoTop(limit: $n) { id } }', variables: { n: 'many' } });
      expect(variables.json().errors[0].extensions.code).toBe('VALIDATION_FAILED');
    });
  });
});
