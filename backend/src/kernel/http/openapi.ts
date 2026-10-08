/**
 * OpenAPI for /docs, generated from the same Zod schemas that validate requests and responses.
 * Every named spec type is one component with the spec's name (e.g. `wishlist.SavedItem`), the same
 * names as docs/api/openapi.json. Spec types have no transforms, so the request and response sides of a
 * type are identical; fastify-type-provider-zod's transform would add `…Input` components, which
 * collide with spec types such as `access.RoleInput`.
 */
import type { SwaggerTransform, SwaggerTransformObject } from '@fastify/swagger';
import { z } from 'zod';
import { $ZodType, type $ZodRegistry } from 'zod/v4/core';

type Json = Record<string, unknown>;
type Registry = $ZodRegistry<{ id: string }>;

const ROOT = '__root__';
const REF = '__ref__/';
const DROP = new Set(['id', '$id', '$schema']);

const componentRef = (id: string) => `#/components/schemas/${id}`;

/** Drops zod's identity keywords and points refs at components (zod files registry refs under `__shared#/$defs/`). */
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && value.startsWith(REF) ? componentRef(value.slice(REF.length).replace(/^.*#\/(?:\$defs|definitions)\//, '')) : value;
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'properties' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, clean(s)]));
    else if (!DROP.has(k)) out[k] = clean(v);
  }
  return out;
}

const options = (registry: Registry, uri: (id: string) => string) =>
  ({ target: 'draft-2020-12', io: 'output', metadata: registry, unrepresentable: 'any', cycles: 'ref', reused: 'inline', uri }) as const;

export function zodToJson(schema: $ZodType, registry: Registry): Json {
  const id = registry.get(schema)?.id;
  if (id) return { $ref: componentRef(id) };
  const one = z.registry<{ id: string }>().add(schema, { id: ROOT });
  return clean(z.toJSONSchema(one, options(registry, (i) => `${REF}${i}`)).schemas[ROOT]) as Json;
}

/** @fastify/swagger `transform`: converts the Zod parts of each route schema */
export function createOpenApiTransform(registry: Registry, skip: string[] = []): SwaggerTransform {
  const json = (s: unknown) => (s instanceof $ZodType ? zodToJson(s, registry) : s);
  return ({ schema, url }) => {
    if (!schema || schema.hide || skip.some((s) => url.startsWith(s))) return { schema: { ...schema, hide: true }, url };
    const { response, headers, querystring, body, params, ...rest } = schema as Json;
    const out: Json = { ...rest };
    for (const [k, v] of Object.entries({ headers, querystring, body, params })) if (v) out[k] = json(v);
    if (response) out.response = Object.fromEntries(Object.entries(response as Json).map(([status, s]) => [status, json(s)]));
    return { schema: out, url };
  };
}

/** @fastify/swagger `transformObject`: every registered spec type becomes a component */
export function createOpenApiObjectTransform(registry: Registry): SwaggerTransformObject {
  let components: Record<string, Json> | undefined; // swagger asks once for JSON and once for YAML
  return (doc) => {
    const o = ('openapiObject' in doc ? doc.openapiObject : {}) as Json & { components?: { schemas?: Json } };
    components ??= Object.fromEntries(Object.entries(z.toJSONSchema(registry, options(registry, componentRef)).schemas).map(([k, v]) => [k, clean(v) as Json]));
    return { ...o, components: { ...o.components, schemas: { ...o.components?.schemas, ...components } } } as never;
  };
}
