/**
 * Development-only routes: test tooling a module offers for people testing by hand and for seed scripts (force a
 * checkout change set, settle a held development payment …). They are registered only while DEV_TOKENS is on (the
 * config refuses DEV_TOKENS in production and outside a loopback host), live outside the API spec under /api/dev
 * and are hidden from OpenAPI like /docs, so `check:api` and the generated clients never see them.
 *
 * Like every URL they need a token: the app-level auth hook verifies it before the handler runs (route auth kind
 * `visitor`: any valid access token of any app). Handlers check what the route needs on top (a session id, …).
 */
import type { FastifyInstance } from 'fastify';
import { actorOf, type Principal } from '../auth/index.js';
import type { Actor } from '../../spec/common.js';
import { AppError } from '../errors/index.js';

export interface DevRouteInput {
  params: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  /** The verified caller, and the actor recorded for what the route does */
  principal: Principal;
  actor: Actor;
  requestId: string;
}

export interface DevRoute {
  method: 'GET' | 'POST' | 'DELETE';
  /** Path under /api/dev/<module>, Fastify style (e.g. /sessions/:id/change-set) */
  path: string;
  /** One line for the server log at start-up */
  summary: string;
  handler(input: DevRouteInput): Promise<unknown>;
}

/** A module's development routes (ctx.http.devRoutes) */
export interface ModuleDevRoute extends DevRoute {
  module: string;
}

/** The URL a module's development route is served at */
export const devRouteUrl = (module: string, path: string) => `/api/dev/${module}${path.startsWith('/') ? path : `/${path}`}`;

export function registerDevRoutes(app: FastifyInstance, routes: readonly ModuleDevRoute[]) {
  for (const r of routes) {
    app.route({
      method: r.method,
      url: devRouteUrl(r.module, r.path),
      config: { auth: 'visitor' },
      schema: { hide: true },
      async handler(request, reply) {
        const principal = request.auth?.principal;
        if (!principal) throw new AppError('UNAUTHORIZED', 'Development routes need a token'); // the middleware already refused it
        const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : {};
        const out = await r.handler({ params: request.params as Record<string, string>, query: request.query as Record<string, string>, body, principal, actor: actorOf(request.auth), requestId: request.id });
        if (out === undefined) return reply.code(204).send();
        return out;
      },
    });
    app.log.debug(`development route ${r.method} ${devRouteUrl(r.module, r.path)}: ${r.summary}`);
  }
}
