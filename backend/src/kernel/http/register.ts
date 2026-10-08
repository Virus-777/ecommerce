/**
 * Turns spec endpoints + module handlers into Fastify routes:
 *   URL      the area prefix from common.json + the spec path: /api/<area>/<module><path>, /webhooks/<module><path>
 *   schema   params, query (+ cursor/page/limit), body and response from the spec (Zod), also for /docs
 *   hooks    launch-phase gate → auth guard → validation → webhook signature / Idempotency-Key → handler
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler, preHandlerHookHandler } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as common from '../../spec/common.js';
import { actorOf, authorize, type Authenticator, type AuthResult } from '../auth/index.js';
import type { Config } from '../config/index.js';
import { AppError, errorInfo } from '../errors/index.js';
import { toPageRequest } from '../lib/pagination.js';
import type { AuthKind, EndpointDef } from '../spec/define.js';
import { hashRequest, type IdempotencyStore } from './idempotency.js';
import type { Handler, RouteSet } from './index.js';

export type WebhookVerifier = (request: FastifyRequest) => boolean | Promise<boolean>;

export interface EndpointRegistration {
  module: string;
  moduleTitle: string;
  id: string;
  def: EndpointDef;
  handler: Handler<any>;
}

export interface HttpKernel {
  config: Config;
  authenticator: Authenticator;
  idempotency: IdempotencyStore;
  webhookVerifiers: Map<string, WebhookVerifier>;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    operationId?: string;
  }
  interface FastifyRequest {
    auth?: AuthResult;
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

const SECURITY: Record<AuthKind, Record<string, string[]>[]> = {
  anyone: [],
  shopper: [{ bearer: [] }, { guestSession: [] }],
  customer: [{ bearer: [] }],
  seller: [{ bearer: [] }],
  staff: [{ bearer: [] }],
  provider: [{ webhookSignature: [] }],
};

/** Error responses, same as docs/api/openapi.json (docs/api/tools/build.mjs), one schema per distinct description. */
const errorSchemas = new Map<string, z.ZodType>();
function errorResponses(module: string, d: EndpointDef): Map<number, z.ZodType> {
  const codes = new Set(['VALIDATION_FAILED', ...(d.auth === 'anyone' ? [] : ['UNAUTHORIZED']), ...(d.permission ? ['FORBIDDEN'] : []), ...(d.params ? ['NOT_FOUND'] : []), ...(d.errors ?? [])]);
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
  if (d.idempotent) schema.headers = z.looseObject({ 'idempotency-key': z.string().min(1).max(255).describe(common.headers['Idempotency-Key']) });
  if (d.body) schema.body = d.body();
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
    for (const r of regs) registerEndpoint(scope, r, k);
  });
}

function registerEndpoint(app: FastifyInstance, r: EndpointRegistration, k: HttpKernel) {
  const { module, id, def: d, handler } = r;
  const operationId = `${module}.${id}`;
  const verify = d.auth === 'provider' ? k.webhookVerifiers.get(module) : undefined;
  const { authenticator, idempotency } = k;

  const onRequest: onRequestHookHandler =
    d.phase > k.config.launchPhase
      ? async () => {
          throw new AppError('NOT_IMPLEMENTED', `Planned for launch phase ${d.phase}.`, { operation: operationId, reason: 'later_phase', phase: d.phase });
        }
      : async (request) => {
          request.auth = await authorize(request, d, authenticator);
          if (d.auth === 'provider' && !verify) throw new AppError('UNAUTHORIZED', `No webhook signature verifier is configured for ${module}`);
        };

  const preHandler: preHandlerHookHandler | undefined = verify
    ? async (request) => {
        if (!(await verify(request))) throw new AppError('UNAUTHORIZED', 'Invalid webhook signature');
      }
    : d.idempotent
      ? async (request, reply) => {
          const key = String(request.headers['idempotency-key']);
          const p = request.auth?.principal;
          const scope = `${operationId}:${p ? `${p.kind}:${p.accountId ?? p.guestSessionId ?? '-'}:${p.sellerId ?? '-'}` : 'anon'}`;
          const replay = await idempotency.begin(scope, key, hashRequest({ params: request.params, query: request.query, body: request.body }));
          if (replay) return reply.header('idempotent-replayed', 'true').code(replay.status).send(replay.body ?? undefined);
          request.idempotency = { scope, key };
        }
      : undefined;

  app.route({
    method: d.method,
    url: routeUrlOf(module, d),
    schema: buildRouteSchema(r),
    config: { operationId },
    onRequest,
    ...(preHandler ? { preHandler } : {}),
    async handler(request, reply) {
      const { principal, sellerAccess } = request.auth ?? { principal: null };
      try {
        const result = await handler({
          params: request.params ?? {},
          query: request.query ?? {},
          body: request.body,
          page: d.paging ? toPageRequest(request.query as common.PageInput) : undefined,
          principal,
          sellerId: d.area === 'seller' ? (principal?.sellerId ?? undefined) : undefined,
          sellerAccess,
          actor: actorOf(principal),
          requestId: request.id,
          idempotencyKey: request.idempotency?.key,
          operationId,
          request,
          reply,
        } as never);
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
