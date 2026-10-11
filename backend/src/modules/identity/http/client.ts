/**
 * HTTP details the identity handlers share: who is calling (for devices and activity) and the
 * website's refresh cookie. Services never see the request or reply.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { REFRESH_COOKIE_PATH, refreshCookieName, refreshCookieOf, type RefreshCookieAudience } from '../../../kernel/auth/chain.js';
import type { Principal } from '../../../kernel/auth/index.js';
import type { Actor } from '../../../spec/common.js';
import { clientInfo, type Caller, type WithCookie } from '../service.js';

/**
 * The website's refresh cookies, one per app (`__Secure-mk_refresh_store`, `_seller`, `_admin`), so signing
 * into one app doesn't replace another's session in the same browser. The kernel reads the one the body's
 * `audience` names on the refresh and sign-out endpoints (kernel/auth/chain.ts). They are HttpOnly, Secure,
 * SameSite=Strict and scoped to REFRESH_COOKIE_PATH, so browsers send them only to
 * /api/public/identity/sessions/* (refresh and sign-out). Responses that start, rotate or end a session set or
 * clear the cookie of that session's app.
 */
export { REFRESH_COOKIE_PATH, refreshCookieName };

/**
 * Every endpoint whose handler calls send() below, i.e. may set or clear the cookie. Browsers call them
 * with credentials (`credentials: 'include'`), so the kernel answers them with credentialed CORS for the
 * app's origins; without it a cross-origin website never receives its refresh cookie.
 */
export const SESSION_COOKIE_ENDPOINTS = [
  'startAppSession',
  'signIn',
  'verifySecondFactor',
  'externalSignIn',
  'confirmVerification',
  'acceptInvitation',
  'confirmInvitationTwoStep',
  'refreshSession',
  'signOut',
  'switchSellerContext',
] as const;

const COOKIE_ATTRS = `Path=${REFRESH_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;

export function caller(input: { principal: Principal | null; actor: Actor; requestId: string; request: FastifyRequest }): Caller {
  return { principal: input.principal, actor: input.actor, requestId: input.requestId, client: clientInfo(input.request) };
}

/** The refresh token as the middleware read it: the named app's cookie first, else the Android body field */
export function refreshTokenOf(
  request: FastifyRequest,
  body: { refreshToken?: string | null } | undefined,
): { token: string; via: 'cookie'; audience: RefreshCookieAudience } | { token: string; via: 'body' } | null {
  const fromCookie = refreshCookieOf(request);
  if (fromCookie) return { token: fromCookie.token, via: 'cookie', audience: fromCookie.audience };
  return body?.refreshToken ? { token: body.refreshToken, via: 'body' } : null;
}

/** Sets or clears the refresh cookie of the session's app and returns the response body; `read` is the app whose cookie the request used (cleared on 'clear'). */
export function send<T>(reply: FastifyReply, out: WithCookie<T>, read?: RefreshCookieAudience): T {
  if (out.cookie === 'clear') {
    if (read) reply.header('set-cookie', `${refreshCookieName(read)}=; Max-Age=0; ${COOKIE_ATTRS}`);
  } else if (out.cookie) {
    reply.header('set-cookie', `${refreshCookieName(out.cookie.audience)}=${encodeURIComponent(out.cookie.token)}; Max-Age=${out.cookie.maxAgeSeconds}; ${COOKIE_ATTRS}`);
  }
  return out.result;
}
