/**
 * The contract every module is held to, whatever is built inside it:
 *   - it boots with exactly its spec dependencies;
 *   - its migrations create the spec's tables and columns;
 *   - every spec endpoint is routed at the spec URL;
 *   - every endpoint answers 401 without a token, 403 WRONG_AUDIENCE for another app's token,
 *     403 FORBIDDEN (or OWNER_ONLY) without its permission;
 *   - with the right token, requests pass the middleware and validation and reach the handler.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeUrlOf, urlOf } from '../kernel/http/register.js';
import { schemaOf } from '../kernel/migrations/index.js';
import { allSpecs, specOf } from '../kernel/module-system/loader.js';
import type { Area, AuthKind, EndpointDef } from '../kernel/spec/define.js';
import type { Audience } from '../kernel/auth/tokens.js';
import { auth, buildTestApp, callers } from './app.js';
import { sampleParams } from './samples.js';

const PG_TYPE: Record<string, string> = {
  int: 'int4',
  integer: 'int4',
  bigint: 'int8',
  bigserial: 'int8',
  bool: 'bool',
  boolean: 'bool',
  char: 'bpchar',
};

const udtOf = (t: string): string => {
  const base = t.replace(/\(.*\)/, '');
  if (base.endsWith('[]')) return `_${udtOf(base.slice(0, -2))}`;
  return PG_TYPE[base] ?? base;
};

const fill = (url: string, params: Record<string, string>) => url.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? 'x'));

const BEARER = new Set<AuthKind>(['visitor', 'shopper', 'customer', 'account', 'seller', 'staff']);
const AUDIENCE: Partial<Record<Area, Audience>> = { store: 'store', seller: 'seller', admin: 'admin' };

/** The token an endpoint asks for: the right kind of caller, for the app that owns the area. */
function tokenFor(def: EndpointDef, permissions: 'all' | 'none' = 'all'): Record<string, string> {
  const audience = AUDIENCE[def.area] ?? 'store';
  switch (def.auth) {
    case 'visitor':
      return auth(callers.visitor({ audience }));
    case 'account':
      return auth(audience === 'seller' ? callers.seller() : audience === 'admin' ? callers.staff() : callers.customer());
    case 'customer':
    case 'shopper':
      return auth(callers.customer());
    case 'seller':
      return auth(permissions === 'none' ? callers.seller({ permissions: [] }) : callers.seller());
    case 'staff':
      return auth(callers.staff(permissions === 'none' ? [] : undefined));
    default:
      return {};
  }
}

/** A signed-in token from another app (staff for the store, a customer for seller and admin areas). */
const otherAppToken = (def: EndpointDef) => auth(def.area === 'store' ? callers.staff() : callers.customer());

export function describeModule(name: string) {
  const spec = specOf(name)!;
  const endpoints = Object.entries(spec.endpoints);

  describe(`${name} module`, () => {
    let app: FastifyInstance;
    const ownerOnly = new Set(Object.values(allSpecs).flatMap((s) => s.permissions.filter((p) => p.ownerOnly).map((p) => p.key)));

    beforeAll(async () => {
      // every launch phase on, so auth and validation are exercised for later-phase endpoints too
      app = await buildTestApp({ only: [name], config: { launchPhase: 4, rateLimits: false } });
    });
    afterAll(async () => {
      await app?.close();
    });

    it('boots with its spec dependencies', () => {
      expect(app.kernel.modules).toContain(name);
      for (const dep of spec.dependsOn) expect(app.kernel.modules).toContain(dep);
    });

    it('creates the tables and columns of its spec', async () => {
      const schema = schemaOf(name);
      const rows = await sql<{ table_name: string; column_name: string; is_nullable: string; udt_name: string }>`
        select table_name, column_name, is_nullable, udt_name from information_schema.columns where table_schema = ${schema}`.execute(app.kernel.database.kysely);
      const actual = new Map(rows.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
      const expected = Object.entries(spec.tables).flatMap(([t, cols]) => Object.entries(cols).map(([c, d]) => ({ key: `${t}.${c}`, ...d })));
      for (const e of expected) {
        const a = actual.get(e.key);
        expect(a, `${schema}.${e.key} exists`).toBeDefined();
        expect(a!.udt_name, `${schema}.${e.key} type`).toBe(udtOf(e.type));
        expect(a!.is_nullable === 'YES', `${schema}.${e.key} nullable`).toBe(e.nullable);
      }
      expect(rows.rows.length, 'no columns outside the spec').toBe(expected.length);
    });

    it.each(endpoints)('routes %s at its spec URL', (_id, def) => {
      const url = urlOf(name, def).replace(/\{(\w+)\}/g, ':$1');
      expect(app.hasRoute({ method: def.method, url })).toBe(true);
    });

    const call = (def: EndpointDef, headers: Record<string, string> = {}) =>
      app.inject({ method: def.method, url: fill(urlOf(name, def), sampleParams(def.params?.())), headers, ...(def.body ? { payload: {} } : {}) });

    // every endpoint needs a token: a bearer token, an app proof, a refresh token or a provider signature
    if (endpoints.length) {
      it.each(endpoints)('%s refuses a request without a token', async (_id, def) => {
        const res = await call(def);
        expect(res.statusCode, res.body).toBe(401);
        expect(res.json().error.code).toBe(def.auth === 'bootstrap' ? 'APP_PROOF_INVALID' : 'UNAUTHORIZED');
      });
    }

    const audienced = endpoints.filter(([, d]) => BEARER.has(d.auth) && d.auth !== 'account' && AUDIENCE[d.area]);
    if (audienced.length) {
      it.each(audienced)('%s refuses a token issued for another app', async (_id, def) => {
        const res = await call(def, otherAppToken(def));
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.code).toBe('WRONG_AUDIENCE');
      });
    }

    const permissioned = endpoints.filter(([, d]) => d.permission && (d.auth === 'staff' || d.auth === 'seller'));
    if (permissioned.length) {
      it.each(permissioned)('%s refuses callers without its permission', async (_id, def) => {
        const res = await call(def, tokenFor(def, 'none'));
        expect(res.statusCode, res.body).toBe(403);
        if (def.auth === 'seller' && ownerOnly.has(def.permission!)) expect(res.json().error.code).toBe('OWNER_ONLY');
        else expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', details: { permission: def.permission } });
      });
    }

    // GET endpoints whose query has no required fields can be called as they are
    const callable = endpoints.filter(([, d]) => d.method === 'GET' && BEARER.has(d.auth) && !d.stepUp && (!d.query || d.query().safeParse({}).success));
    if (callable.length) {
      it.each(callable)('%s reaches its handler with the right token', async (_id, def) => {
        const res = await call(def, tokenFor(def));
        expect([400, 401, 403, 500], res.body).not.toContain(res.statusCode);
      });
    }
  });
}
