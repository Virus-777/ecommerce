/**
 * Response headers and CORS for the API (docs/03-auth-middleware.md §5, §17):
 *   - CORS: an allowlist of origins per app. Store, seller and admin areas take their own app's origins;
 *     public endpoints, signed file links and the self-service `account` endpoints take every app's;
 *   - credentials (the HttpOnly refresh cookie) only on the routes that set, clear or read that cookie:
 *     refresh and sign-out, and the endpoints that start or switch a session (declared by their module);
 *   - headers a browser app must read cross-origin are exposed (WWW-Authenticate, X-Request-Id,
 *     Idempotent-Replayed, Retry-After);
 *   - every API response: Cache-Control private, no-store (every request carries a token), nosniff, no referrer;
 *   - 401 for a bad token carries WWW-Authenticate, the only signal that a refresh can help.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FILES_PREFIX } from '../auth/file-links.js';
import type { Config } from '../config/index.js';

type AppArea = 'store' | 'seller' | 'admin' | 'public';

/** CORS beyond the area default for one route */
export interface CorsRule {
  /** Origins of every app (store, Seller Center, Admin Center), not only the area's */
  anyApp?: boolean;
  /** Access-Control-Allow-Credentials: the route sets, clears or reads the refresh cookie */
  credentials?: boolean;
}

/**
 * Routes whose CORS differs from their area's. Matched on the path, so a preflight (which matches no
 * route) gets the same answer as the request it announces.
 */
export class CorsRoutes {
  readonly #rules: { pattern: RegExp; rule: CorsRule }[] = [];

  /** url: a route URL with :params or {params} */
  add(url: string, rule: CorsRule) {
    const source = url
      .split(/(:\w+|\{\w+\})/)
      .map((part, i) => (i % 2 ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    this.#rules.push({ pattern: new RegExp(`^${source}/?$`), rule });
  }

  ruleFor(url: string): CorsRule | undefined {
    const path = url.split('?')[0]!;
    return this.#rules.find((r) => r.pattern.test(path))?.rule;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    corsRoutes: CorsRoutes;
  }
}

/** Response headers a browser app needs to read across origins */
export const EXPOSED_HEADERS = 'WWW-Authenticate, X-Request-Id, Idempotent-Replayed, Retry-After';
/** Request headers the apps may send */
export const ALLOWED_HEADERS = 'authorization, content-type, idempotency-key, x-app-proof, x-step-up-code, x-client, x-request-id, x-requested-with';

function areaOf(url: string): AppArea | undefined {
  const m = /^\/(?:api|graphql)\/(store|seller|admin|public)\b/.exec(url);
  return m?.[1] as AppArea | undefined;
}

/** Every app's browser origins (CORS_*_ORIGINS) */
export const appOrigins = (config: Config) => [...config.cors.store, ...config.cors.seller, ...config.cors.admin];

function allowedOrigin(config: Config, request: FastifyRequest, rule: CorsRule | undefined): string | undefined {
  const origin = request.headers.origin;
  if (!origin) return undefined;
  const area = areaOf(request.url);
  // signed file links are opened by every app (no credentials: the link is the token)
  const anyApp = rule?.anyApp || area === 'public' || request.url.startsWith(FILES_PREFIX);
  const allowed = anyApp ? appOrigins(config) : area ? config.cors[area] : [];
  return allowed.includes(origin) ? origin : undefined;
}

export function installSecurity(app: FastifyInstance, config: Config) {
  const routes = new CorsRoutes();
  app.decorate('corsRoutes', routes);

  app.addHook('onRequest', async (request, reply) => {
    const rule = routes.ruleFor(request.url);
    const origin = allowedOrigin(config, request, rule);
    if (origin) {
      reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
      if (rule?.credentials) reply.header('access-control-allow-credentials', 'true');
    }
    // CORS preflight carries no token by design; answer it here, before authentication
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
      if (origin) {
        reply
          .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE')
          .header('access-control-allow-headers', ALLOWED_HEADERS)
          .header('access-control-max-age', '600');
      }
      return reply.code(204).send();
    }
    if (origin) reply.header('access-control-expose-headers', EXPOSED_HEADERS);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (/^\/(api|graphql|webhooks)\//.test(request.url)) {
      reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
      if (config.env === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    // only the middleware's UNAUTHORIZED is about the token; business 401s (INVALID_CREDENTIALS …) are not,
    // nor is a bad file link (no Bearer token can help: the app asks for a new link)
    if (reply.statusCode === 401 && !request.url.startsWith(FILES_PREFIX) && typeof payload === 'string' && payload.includes('"code":"UNAUTHORIZED"')) {
      const m = /"reason":"token_(\w+)"/.exec(payload);
      reply.header('www-authenticate', m && m[1] !== 'missing' ? 'Bearer error="invalid_token"' : 'Bearer');
    }
    return payload;
  });
}
