/**
 * Turns spec endpoints + module handlers into Fastify routes:
 *   URL      /api/<area>/<module><path>  (webhooks: /webhooks/<module><path>)
 *   schema   params, query (+ cursor/page/limit), body and response from the spec (Zod), also for /docs
 *   hooks    launch-phase gate → auth guard → validation → Idempotency-Key → handler
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as common from '../../spec/common.js';
import { actorOf, authorize, type Authenticator, type AuthResult } from '../auth/index.js';
import type { Config } from '../config/index.js';
import { AppError, errorStatus } from '../errors/index.js';
import { toPageRequest } from '../lib/pagination.js';
import type { AuthKind, EndpointDef } from '../spec/define.js';
import { hashRequest, type IdempotencyStore } from './idempotency.js';
import type { Handler } from './index.js';

export type WebhookVerifier = (request: FastifyRequest & { rawBody?: string }) => boolean | Promise<boolean>;

export interface EndpointRegistration {
  module: string;
  moduleTitle: string;
  moduleErrorCodes: Readonly<Record<string, { status: number; meaning: string }>>;
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
    module?: string;
  }
  interface FastifyRequest {
    auth?: AuthResult;
    idempotency?: { scope: string; key: string };
    rawBody?: string;
  }
}

export const urlOf = (module: string, def: Pick<EndpointDef, 'area' | 'path'>) =>
  `${def.area === 'webhooks' ? '/webhooks' : `/api/${def.area}`}/${module}${def.path}`;

const SECURITY: Record<AuthKind, Record<string, string[]>[]> = {
  anyone: [],
  shopper: [{ bearer: [] }, { guestSession: [] }],
  customer: [{ bearer: [] }],
  seller: [{ bearer: [] }],
  staff: [{ bearer: [] }],
  provider: [{ webhookSignature: [] }],
};

/** Same error responses as docs/api/openapi.json (docs/api/tools/build.mjs). */
function errorStatuses(r: EndpointRegistration): Map<number, string[]> {
  const d = r.def;
  const codes = new Set(['VALIDATION_FAILED', ...(d.auth === 'anyone' ? [] : ['UNAUTHORIZED']), ...(d.permission ? ['FORBIDDEN'] : []), ...(d.params ? ['NOT_FOUND'] : []), ...(d.errors ?? [])]);
  const out = new Map<number, string[]>();
  for (const code of codes) {
    const def = (common.commonErrors as Record<string, { status: number; meaning: string }>)[code] ?? r.moduleErrorCodes[code];
    if (!def) continue;
    out.set(def.status, [...(out.get(def.status) ?? []), `${code}: ${def.meaning}`]);
  }
  return out;
}

function description(r: EndpointRegistration) {
  const d = r.def;
  return (
    [
      d.desc,
      d.permission && `**Permission:** \`${d.permission}\``,
      d.approval && `**Approval:** ${d.approval}`,
      d.idempotent && '**Idempotent:** send an Idempotency-Key.',
      d.audited && '**Audited:** recorded in the action history.',
      d.events?.length && `**Publishes:** ${d.events.map((e) => `\`${e}\``).join(', ')}`,
      d.screens?.length && `**Screens:** ${d.screens.join(', ')}`,
      d.phase > 1 && `**Launch phase:** ${d.phase}`,
    ]
      .filter(Boolean)
      .join('\n\n') || undefined
  );
}

export function buildRouteSchema(r: EndpointRegistration) {
  const d = r.def;
  const schema: Record<string, unknown> = {
    operationId: `${r.module}.${r.id}`,
    tags: [`${common.areas[d.area].title} · ${r.moduleTitle}`],
    summary: d.summary,
    description: description(r),
    security: SECURITY[d.auth],
  };
  if (d.params) schema.params = d.params();
  let query = d.query?.() as z.ZodObject | undefined;
  if (d.paging) query = query ? query.extend(common.pageQuery) : z.object(common.pageQuery);
  if (query) schema.querystring = query;
  if (d.idempotent) schema.headers = z.looseObject({ 'idempotency-key': z.string().min(1).max(255).describe(common.headers['Idempotency-Key']) });
  if (d.body) schema.body = d.body();
  const response: Record<number, z.ZodType> = {};
  // Named types keep their registry id (a $ref in /docs), so they are used as they are, without .describe()
  if (d.response) {
    const item = d.response();
    response[d.status] = d.paging ? common.page(item) : item;
  } else response[d.status] = z.null().describe('Success, no content');
  for (const [status, lines] of errorStatuses(r)) response[status] = z.object({ error: common.ErrorBody }).describe(lines.join('\n'));
  schema.response = response;
  return schema;
}

export function registerEndpoints(app: FastifyInstance, regs: EndpointRegistration[], k: HttpKernel) {
  for (const r of regs) {
    const d = r.def;
    const operationId = `${r.module}.${r.id}`;
    app.route({
      method: d.method,
      url: urlOf(r.module, d).replace(/\{(\w+)\}/g, ':$1'),
      schema: buildRouteSchema(r),
      config: { operationId, module: r.module },
      async onRequest(request) {
        if (d.phase > k.config.launchPhase) {
          throw new AppError('NOT_IMPLEMENTED', `Planned for launch phase ${d.phase}.`, { operation: operationId, reason: 'later_phase', phase: d.phase });
        }
        request.auth = await authorize(request, d, k.authenticator);
        if (d.auth === 'provider') {
          const verify = k.webhookVerifiers.get(r.module);
          if (!verify) throw new AppError('UNAUTHORIZED', `No webhook signature verifier is configured for ${r.module}`);
        }
      },
      async preHandler(request, reply) {
        if (d.auth === 'provider') {
          const ok = await k.webhookVerifiers.get(r.module)!(request);
          if (!ok) throw new AppError('UNAUTHORIZED', 'Invalid webhook signature');
        }
        if (d.idempotent) {
          const key = String(request.headers['idempotency-key']);
          const p = request.auth?.principal;
          const who = p ? `${p.kind}:${p.accountId ?? p.guestSessionId ?? '-'}:${p.sellerId ?? '-'}` : 'anon';
          const scope = `${operationId}:${who}`;
          const replay = await k.idempotency.begin(scope, key, hashRequest({ params: request.params, query: request.query, body: request.body }));
          if (replay) {
            reply.header('idempotent-replayed', 'true').code(replay.status);
            return reply.send(replay.body ?? undefined);
          }
          request.idempotency = { scope, key };
        }
      },
      async handler(request: FastifyRequest, reply: FastifyReply) {
        const auth = request.auth ?? { principal: null };
        const principal = auth.principal;
        try {
          const result = await r.handler({
            params: request.params ?? {},
            query: request.query ?? {},
            body: request.body,
            page: d.paging ? toPageRequest(request.query as common.PageInput) : undefined,
            principal,
            sellerId: d.area === 'seller' ? (principal?.sellerId ?? undefined) : undefined,
            sellerAccess: auth.sellerAccess,
            actor: actorOf(principal),
            requestId: request.id,
            idempotencyKey: request.idempotency?.key,
            operationId,
            request,
            reply,
          } as never);
          if (request.idempotency) await k.idempotency.complete(request.idempotency.scope, request.idempotency.key, d.status, result ?? null);
          if (reply.sent) return reply;
          reply.code(d.status);
          return d.response ? reply.send(result) : reply.send();
        } catch (err) {
          if (request.idempotency) await k.idempotency.release(request.idempotency.scope, request.idempotency.key).catch(() => {});
          throw err;
        }
      },
    });
  }
}

export { errorStatus };
