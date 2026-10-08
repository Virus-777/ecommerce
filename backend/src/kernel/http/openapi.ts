/**
 * OpenAPI for /docs, generated from the same Zod schemas that validate requests and responses.
 * Every named spec type is one component with the spec's name (e.g. `wishlist.SavedItem`), the same
 * names as docs/api/openapi.json. Spec types have no transforms, so request and response sides of a
 * type are identical and need no separate "Input" component.
 */
import { z } from 'zod';
import { $ZodRegistry, type $ZodType } from 'zod/v4/core';

type Json = Record<string, unknown>;
type Registry = $ZodRegistry<{ id?: string }>;

const ROOT = '__root__';
const REF = '__ref__/';
const DROP = new Set(['id', '$id', '$schema']);

const ref = (id: string) => `#/components/schemas/${id}`;

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value === null || typeof value !== 'object') return typeof value === 'string' && value.startsWith(REF) ? ref(value.slice(REF.length).replace(/^.*#\/(?:\$defs|definitions)\//, '')) : value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'properties' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, clean(s)]));
    else if (!DROP.has(k)) out[k] = clean(v);
  }
  return out;
}

const params = (registry: Registry, uri: (id: string) => string) =>
  ({ target: 'draft-2020-12', io: 'output', metadata: registry, unrepresentable: 'any', cycles: 'ref', reused: 'inline', uri }) as const;

export function zodToJson(schema: $ZodType, registry: Registry): Json {
  const id = registry.get(schema)?.id;
  if (id) return { $ref: ref(id) };
  const temp = new $ZodRegistry<{ id?: string }>();
  temp.add(schema, { id: ROOT });
  const { schemas } = z.toJSONSchema(temp, params(registry, (i) => `${REF}${i}`));
  return clean(schemas[ROOT]) as Json;
}

export function componentsOf(registry: Registry): Record<string, Json> {
  const { schemas } = z.toJSONSchema(registry, params(registry, ref));
  return Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, clean(v) as Json]));
}

const isZod = (s: unknown): s is $ZodType => typeof s === 'object' && s !== null && '_zod' in s;

/** @fastify/swagger `transform` */
export function createOpenApiTransform(registry: Registry, skip: string[] = []) {
  return ({ schema, url }: { schema: Json; url: string }) => {
    if (!schema || skip.some((s) => url.startsWith(s)) || schema.hide) return { schema: { ...schema, hide: true }, url };
    const { response, headers, querystring, body, params: p, ...rest } = schema;
    const out: Json = { ...rest };
    for (const [k, v] of Object.entries({ headers, querystring, body, params: p })) if (isZod(v)) out[k] = zodToJson(v, registry);
    if (response && typeof response === 'object') {
      out.response = Object.fromEntries(
        Object.entries(response as Record<string, unknown>).map(([status, s]) => {
          if (!isZod(s)) return [status, s];
          const json = zodToJson(s, registry);
          return [status, json];
        }),
      );
    }
    return { schema: out, url };
  };
}

/** @fastify/swagger `transformObject`: adds every registered spec type as a component */
export function createOpenApiObjectTransform(registry: Registry) {
  return (doc: { openapiObject?: Json; swaggerObject?: Json }) => {
    const o = (doc.openapiObject ?? {}) as Json & { components?: Json };
    return { ...o, components: { ...(o.components ?? {}), schemas: { ...((o.components?.schemas as Json) ?? {}), ...componentsOf(registry) } } };
  };
}
