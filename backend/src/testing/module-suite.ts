/**
 * The contract every module is held to, whatever is built inside it:
 *   - it boots with exactly its spec dependencies;
 *   - its migrations create the spec's tables and columns;
 *   - every spec endpoint is routed at the spec URL;
 *   - the auth guard answers 401 without the session the spec requires, 403 without the permission;
 *   - with the right session, requests pass auth and validation and reach the handler.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newId } from '../kernel/lib/ids.js';
import { urlOf } from '../kernel/http/register.js';
import type { EndpointDef, ModuleSpecDef } from '../kernel/spec/define.js';
import { specs } from '../spec/index.js';
import { auth, buildTestApp, callers } from './app.js';

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

/** A path value that satisfies the param schema (uuid, int or string). */
function sampleParams(def: EndpointDef): Record<string, string> {
  const shape = (def.params?.() as z.ZodObject | undefined)?.shape ?? {};
  const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(shape)) {
    out[k] = [newId(), '1', 'sample', '2026-01-01'].find((v) => (s as z.ZodType).safeParse(v).success) ?? 'sample';
  }
  return out;
}

const fill = (url: string, params: Record<string, string>) => url.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? 'x'));

function sessionFor(def: EndpointDef, permissions: 'all' | 'none' = 'all'): Record<string, string> {
  switch (def.auth) {
    case 'customer':
    case 'shopper':
      return auth(callers.customer());
    case 'seller':
      return auth(permissions === 'none' ? callers.seller({ isOwner: false, permissions: [] }) : callers.seller());
    case 'staff':
      return auth(callers.staff(permissions === 'none' ? [] : ['*']));
    default:
      return {};
  }
}

export function describeModule(name: keyof typeof specs) {
  const spec = specs[name] as unknown as ModuleSpecDef;
  const endpoints = Object.entries(spec.endpoints);

  describe(`${name} module`, () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      // every launch phase on, so auth and validation are exercised for later-phase endpoints too
      app = await buildTestApp({ only: [name], config: { launchPhase: 4 } });
    });
    afterAll(async () => {
      await app?.close();
    });

    it('boots with its spec dependencies', () => {
      expect(app.kernel.modules).toContain(name);
      for (const dep of spec.dependsOn) expect(app.kernel.modules).toContain(dep);
    });

    it('creates the tables and columns of its spec', async () => {
      const schema = name.replace(/-/g, '_');
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

    const guarded = endpoints.filter(([, d]) => d.auth !== 'anyone');
    if (guarded.length) {
      it.each(guarded)('%s refuses callers without the required session', async (_id, def) => {
        const res = await app.inject({ method: def.method, url: fill(urlOf(name, def), sampleParams(def)) });
        expect(res.statusCode, res.body).toBe(401);
        expect(res.json().error.code).toBe('UNAUTHORIZED');
      });
    }

    const permissioned = endpoints.filter(([, d]) => d.permission && (d.auth === 'staff' || d.auth === 'seller'));
    if (permissioned.length) {
      it.each(permissioned)('%s refuses callers without its permission', async (_id, def) => {
        const res = await app.inject({ method: def.method, url: fill(urlOf(name, def), sampleParams(def)), headers: sessionFor(def, 'none') });
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', details: { permission: def.permission } });
      });
    }

    // GET endpoints whose query has no required fields can be called as they are
    const callable = endpoints.filter(([, d]) => d.method === 'GET' && d.auth !== 'provider' && (!d.query || d.query().safeParse({}).success));
    if (callable.length) {
      it.each(callable)('%s reaches its handler with the right session', async (_id, def) => {
        const res = await app.inject({ method: 'GET', url: fill(urlOf(name, def), sampleParams(def)), headers: sessionFor(def) });
        expect([400, 401, 403, 500], res.body).not.toContain(res.statusCode);
      });
    }
  });
}
