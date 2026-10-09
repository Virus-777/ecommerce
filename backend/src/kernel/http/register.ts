/**
 * Turns spec endpoints + module handlers into Fastify routes:
 *   URL      the area prefix from common.json + the spec path: /api/<area>/<module><path>, /webhooks/<module><path>
 *   schema   params, query (+ cursor/page/limit), body and response from the spec (Zod), also for /docs
 *   hooks    the authorization chain (kernel/auth/chain.ts) → validation → Idempotency-Key → step-up → handler
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as common from '../../spec/common.js';
import type { AuthChain } from '../auth/chain.js';
import { actorOf } from '../auth/index.js';
import { maskResponse } from '../auth/masking.js';
import { scopeFor } from '../auth/scope.js';
import type { Config } from '../config/index.js';
import { errorInfo } from '../errors/index.js';
import { toPageRequest } from '../lib/pagination.js';
import type { AuthKind, EndpointDef } from '../spec/define.js';
import { hashRequest, type IdempotencyStore } from './idempotency.js';
import type { Handler, RouteSet } from './index.js';

export type { WebhookVerifier } from '../auth/chain.js';

export interface EndpointRegistration {
  module: string;
  moduleTitle: string;
  id: string;
  def: EndpointDef;
  handler: Handler<any>;
}

export interface HttpKernel {
  config: Config;
  auth: AuthChain;
  idempotency: IdempotencyStore;
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { scope: string; key: string };
    rawBody?: string;
  }
}

/** Spec URL of an endpoint, with {placeholders}: /api/store/catalog/products/{id} */
export const urlOf = (module: string, def: Pick<EndpointDef, 'area' | 'path'>) => common.areas[def.area].prefix.replace('{module}', module) + def.path;

/** The same URL in Fastify's :param form */
export const routeUrlOf = (module: string, def: Pick<EndpointDef, 'area' | 'path'>) => urlOf(module, def).replace(/\{(\w+)\}/g, ':$1');

export const registrationsOf = (module: string, moduleTitle: string, sets: readonly RouteSet[]): EndpointRegistration[] =>
  sets.flatMap((s) => Object.entries(s.handlers).map(([id, handler]) => ({ module, moduleTitle, id, def: s.endpoints[id]!, handler })));

/** OpenAPI security per auth kind, the same as docs/api/openapi.json (docs/api/tools/build.mjs) */
const SECURITY: Record<AuthKind, Record<string, string[]>[]> = {
  visitor: [{ bearer: [] }],
  shopper: [{ bearer: [] }],
  customer: [{ bearer: [] }],
  account: [{ bearer: [] }],
  seller: [{ bearer: [] }],
  staff: [{ bearer: [] }],
  refresh: [{ refreshCookie: [] }, {}],
  provider: [{ webhookSignature: [] }],
  bootstrap: [{ appProof: [] }],
};
const BEARER = new Set<AuthKind>(['visitor', 'shopper', 'customer', 'account', 'seller', 'staff']);

/** Error responses, same as the design build: one schema per distinct description. */
const errorSchemas = new Map<string, z.ZodType>();
function errorResponses(module: string, d: EndpointDef): Map<number, z.ZodType> {
  const codes = new Set([
    'VALIDATION_FAILED',
    'UNAUTHORIZED',
    ...(BEARER.has(d.auth) ? ['WRONG_AUDIENCE'] : []),
    ...(d.permission || d.permissionWhen?.length || d.auth === 'seller' ? ['FORBIDDEN'] : []),
    ...(d.stepUp ? ['STEP_UP_REQUIRED'] : []),
    ...(d.params ? ['NOT_FOUND'] : []),
    ...(d.errors ?? []),
  ]);
  const lines = new Map<number, string[]>();
  for (const code of codes) {
    const info = errorInfo(code, module);
    if (info) lines.set(info.status, [...(lines.get(info.status) ?? []), `${code}: ${info.meaning}`]);
  }
  const out = new Map<number, z.ZodType>();
  for (const [status, l] of lines) {
    const text = l.join('\n');
    if (!errorSchemas.has(text)) errorSchemas.set(text, z.object({ error: common.ErrorBody }).describe(text));
    out.set(status, errorSchemas.get(text)!);
  }
  return out;
}

function description(d: EndpointDef) {
  const parts = [
    d.desc,
    d.permission && `**Permission:** \`${d.permission}\``,
    d.permissionWhen?.length &&
      `**Also needs:** ${d.permissionWhen
        .map((r) => `\`${r.permission}\` when ${Object.entries(r.if).map(([k, v]) => `${k} ${v.startsWith('!') ? `is not the caller's own (${v.slice(1)})` : `= ${v}`}`).join(' and ')}`)
        .join('; ')}`,
    d.stepUp && `**Step-up:** ${d.stepUp.kind === 'reauth' ? 'single-use re-auth token in the body' : '2-step code in X-Step-Up-Code'} (purpose \`${d.stepUp.purpose}\`)`,
    d.sellerContext === 'optional' && '**Seller context:** optional (works before a seller is chosen).',
    d.approval && `**Approval:** ${d.approval}`,
    d.idempotent && '**Idempotent:** send an Idempotency-Key.',
    d.audited && '**Audited:** recorded in the action history.',
    d.events?.length && `**Publishes:** ${d.events.map((e) => `\`${e}\``).join(', ')}`,
    d.screens?.length && `**Screens:** ${d.screens.join(', ')}`,
    d.phase > 1 && `**Launch phase:** ${d.phase}`,
  ];
  return parts.filter(Boolean).join('\n\n') || undefined;
}

export function buildRouteSchema(r: EndpointRegistration) {
  const d = r.def;
  const schema: Record<string, unknown> = {
    operationId: `${r.module}.${r.id}`,
    tags: [`${common.areas[d.area].title} · ${r.moduleTitle}`],
    summary: d.summary,
    description: description(d),
    security: SECURITY[d.auth],
  };
  if (d.params) schema.params = d.params();
  const query = d.query?.() as z.ZodObject | undefined;
  if (d.paging) schema.querystring = query ? query.extend(common.pageQuery) : z.object(common.pageQuery);
  else if (query) schema.querystring = query;
  const headers: Record<string, z.ZodType> = {};
  if (d.idempotent) headers['idempotency-key'] = z.string().min(1).max(255).describe(common.headers['Idempotency-Key']);
  if (d.stepUp?.kind === 'code') headers['x-step-up-code'] = z.string().min(1).max(20).describe(common.headers['X-Step-Up-Code']);
  if (Object.keys(headers).length) schema.headers = z.looseObject(headers);
  if (d.body) schema.body = d.body();
  // a binary body is the raw request bytes (a Buffer), documented as application/octet-stream
  if (d.bodyFormat === 'binary') schema.consumes = ['application/octet-stream'];
  // Named types keep their registry id (a $ref in /docs), so they are used as they are, without .describe()
  const item = d.response?.();
  const response = new Map<number, z.ZodType>([[d.status, item ? (d.paging ? common.page(item) : item) : z.null().describe('Success, no content')]]);
  for (const [status, s] of errorResponses(r.module, d)) response.set(status, s);
  schema.response = Object.fromEntries(response);
  return schema;
}

/** Registers the spec routes in their own scope, which validates and serializes with Zod. */
export function registerEndpoints(app: FastifyInstance, regs: EndpointRegistration[], k: HttpKernel) {
  void app.register(async (scope) => {
    scope.setValidatorCompiler(validatorCompiler);
    if (k.config.responseValidation) scope.setSerializerCompiler(serializerCompiler);
    else scope.setSerializerCompiler(() => (data) => JSON.stringify(data));
    for (const r of regs) if (r.def.bodyFormat !== 'binary') registerEndpoint(scope, r, k);
    // Raw-bytes endpoints (e.g. media's development upload target) in their own scope: any content type
    // is read as a Buffer, up to BINARY_BODY_LIMIT; the handler enforces its own, smaller limit
    const binary = regs.filter((r) => r.def.bodyFormat === 'binary');
    if (binary.length) {
      await scope.register(async (raw) => {
        raw.removeAllContentTypeParsers();
        raw.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BINARY_BODY_LIMIT }, (_request, body, done) => done(null, body));
        for (const r of binary) registerEndpoint(raw, r, k, { bodyLimit: BINARY_BODY_LIMIT });
      });
    }
  });
}

/** Upper bound for raw-bytes request bodies (the largest media upload purpose is 500 MB) */
export const BINARY_BODY_LIMIT = 512 * 1024 * 1024;

function registerEndpoint(app: FastifyInstance, r: EndpointRegistration, k: HttpKernel, opts: { bodyLimit?: number } = {}) {
  const { module, id, def: d, handler } = r;
  const operationId = `${module}.${id}`;
  const { idempotency, auth } = k;
  const hooks = auth.endpointHooks(module, operationId, d);

  const idempotent: preHandlerHookHandler | undefined = d.idempotent
    ? async (request, reply) => {
        const key = String(request.headers['idempotency-key']);
        const p = request.auth?.principal;
        const scope = `${operationId}:${p ? `${p.kind}:${p.accountId ?? p.sessionId}:${p.sellerId ?? '-'}` : 'anon'}`;
        const replay = await idempotency.begin(scope, key, hashRequest({ params: request.params, query: request.query, body: request.body }));
        if (replay) return reply.header('idempotent-replayed', 'true').code(replay.status).send(replay.body ?? undefined);
        request.idempotency = { scope, key };
      }
    : undefined;

  app.route({
    method: d.method,
    url: routeUrlOf(module, d),
    schema: buildRouteSchema(r),
    config: { operationId, auth: d.auth },
    ...(opts.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}),
    onRequest: hooks.onRequest,
    preValidation: hooks.preValidation,
    // conditional permissions → Idempotency-Key replay → step-up (a replay never spends a re-auth token)
    preHandler: [hooks.preHandlerBefore, ...(idempotent ? [idempotent] : []), hooks.preHandlerAfter],
    onResponse: hooks.onResponse,
    async handler(request, reply) {
      if (request.webhookDuplicate) {
        // the first delivery was processed: acknowledge without running the handler again (providers only need a 2xx);
        // the body is not the endpoint's response type, so it bypasses response validation
        reply.header('x-webhook-duplicate', 'true').code(d.status);
        return d.response ? reply.type('application/json').serializer(JSON.stringify).send({ received: true, duplicate: true }) : reply.send();
      }
      const authState = request.auth;
      const principal = authState?.principal ?? null;
      try {
        const customerId = d.scope === 'own-customer' ? await auth.customerIdOf(principal) : null;
        let result = await handler({
          params: request.params ?? {},
          query: request.query ?? {},
          body: request.body,
          page: d.paging ? toPageRequest(request.query as common.PageInput) : undefined,
          principal,
          sellerId: d.area === 'seller' ? (principal?.sellerId ?? undefined) : undefined,
          sellerAccess: authState?.sellerAccess,
          scope: scopeFor(d.scope, authState, customerId),
          can: (permission: string) => auth.can(authState, permission),
          actor: actorOf(authState),
          requestId: request.id,
          idempotencyKey: request.idempotency?.key,
          operationId,
          request,
          reply,
        } as never);
        if (d.sensitive && (d.area === 'admin' || d.area === 'seller')) result = await maskResponse(result, d.sensitive, (perm) => auth.can(authState, perm));
        if (request.idempotency) await idempotency.complete(request.idempotency.scope, request.idempotency.key, d.status, result ?? null);
        if (reply.sent) return reply;
        return d.response ? reply.code(d.status).send(result) : reply.code(d.status).send();
      } catch (err) {
        if (request.idempotency) await idempotency.release(request.idempotency.scope, request.idempotency.key).catch(() => {});
        throw err;
      }
    },
  });
}
