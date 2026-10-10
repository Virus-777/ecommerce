/**
 * Response headers and CORS for the API (docs/03-auth-middleware.md §5, §17):
 *   - CORS: an allowlist of origins per app; credentials only on the refresh path (HttpOnly refresh cookie);
 *   - every API response: Cache-Control private, no-store (every request carries a token), nosniff, no referrer;
 *   - 401 for a bad token carries WWW-Authenticate, the only signal that a refresh can help.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { REFRESH_COOKIE_PATH } from '../auth/chain.js';
import { FILES_PREFIX } from '../auth/file-links.js';
import type { Config } from '../config/index.js';

/** Refresh and sign-out: the only paths the refresh cookie is sent to, so the only ones with credentialed CORS */
const REFRESH_PATH = `${REFRESH_COOKIE_PATH}/`;

function areaOf(url: string): 'store' | 'seller' | 'admin' | 'public' | undefined {
  const m = /^\/(?:api|graphql)\/(store|seller|admin|public)\b/.exec(url);
  return m?.[1] as never;
}

function allowedOrigin(config: Config, request: FastifyRequest): string | undefined {
  const origin = request.headers.origin;
  if (!origin) return undefined;
  const area = areaOf(request.url);
  const o = config.cors;
  // signed file links are opened by every app (no credentials: the link is the token)
  const anyApp = area === 'public' || request.url.startsWith(FILES_PREFIX);
  const allowed = anyApp ? [...o.store, ...o.seller, ...o.admin] : area ? o[area] : [];
  return allowed.includes(origin) ? origin : undefined;
}

export function installSecurity(app: FastifyInstance, config: Config) {
  app.addHook('onRequest', async (request, reply) => {
    const origin = allowedOrigin(config, request);
    if (origin) {
      reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
      if (request.url.startsWith(REFRESH_PATH)) reply.header('access-control-allow-credentials', 'true');
    }
    // CORS preflight carries no token by design; answer it here, before authentication
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
      if (origin) {
        reply
          .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE')
          .header('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-app-proof, x-step-up-code, x-client, x-request-id')
          .header('access-control-max-age', '600');
      }
      return reply.code(204).send();
    }
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
