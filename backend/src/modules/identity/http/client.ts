/**
 * HTTP details the identity handlers share: who is calling (for devices and activity) and the
 * website's refresh cookie. Services never see the request or reply.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from '../../../kernel/auth/index.js';
import type { Actor } from '../../../spec/common.js';
import { clientInfo, type Caller, type WithCookie } from '../service.js';

/** The kernel reads this cookie on the refresh and sign-out endpoints (kernel/auth/chain.ts). */
export const REFRESH_COOKIE = '__Host-mk_refresh';
/**
 * Browsers only accept a `__Host-` cookie with `Path=/` (and Secure, no Domain), so the cookie
 * can't be narrowed to /api/public/identity/sessions/ without renaming it; it is HttpOnly and
 * SameSite=Strict, and only the refresh and sign-out endpoints read it.
 */
const COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Strict';

export function caller(input: { principal: Principal | null; actor: Actor; requestId: string; request: FastifyRequest }): Caller {
  return { principal: input.principal, actor: input.actor, requestId: input.requestId, client: clientInfo(input.request) };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** The refresh token as the middleware read it: the website's cookie first, else the Android body field */
export function refreshTokenOf(request: FastifyRequest, body: { refreshToken?: string | null } | undefined): { token: string; via: 'cookie' | 'body' } | null {
  const fromCookie = readCookie(request.headers.cookie, REFRESH_COOKIE);
  if (fromCookie) return { token: fromCookie, via: 'cookie' };
  return body?.refreshToken ? { token: body.refreshToken, via: 'body' } : null;
}

/** Sets or clears the refresh cookie and returns the response body. */
export function send<T>(reply: FastifyReply, out: WithCookie<T>): T {
  if (out.cookie === 'clear') reply.header('set-cookie', `${REFRESH_COOKIE}=; Max-Age=0; ${COOKIE_ATTRS}`);
  else if (out.cookie) reply.header('set-cookie', `${REFRESH_COOKIE}=${encodeURIComponent(out.cookie.token)}; Max-Age=${out.cookie.maxAgeSeconds}; ${COOKIE_ATTRS}`);
  return out.result;
}
