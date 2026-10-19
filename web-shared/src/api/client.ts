import createClient, { type Client } from 'openapi-fetch';
import { ApiError, apiErrorFrom, isTokenProblem, reasonOf, toApiError, type ErrorBody } from './errors';
import type { paths } from './openapi';
import type { Session } from './session';

export type Api = Client<paths>;

/**
 * Typed REST client for one app (paths and bodies come from docs/api/openapi.json, generated into openapi.d.ts).
 * Every request carries the session's bearer token and `X-Client: web`; a 401 with a token_* reason
 * refreshes once and retries (docs/api/README.md, Client rules).
 */
export function createApi(session: Session, baseUrl = ''): Api {
  const authFetch = async (input: Request): Promise<Response> => {
    // Only the identity cookie routes (session.ts) send credentials; ordinary API calls don't, because the
    // API allows credentials on those routes only (docs/api/README.md, Browsers).
    const send = async (req: Request, token: string) => {
      const r = new Request(req);
      r.headers.set('Authorization', `Bearer ${token}`);
      r.headers.set('X-Client', 'web');
      return fetch(r);
    };
    const bodyOf = async (r: Response): Promise<unknown> => {
      try {
        return await r.clone().json();
      } catch {
        return undefined;
      }
    };
    const retry = input.clone();
    let res = await send(input, await session.token());
    if (res.status === 401) {
      let body = await bodyOf(res);
      if (isTokenProblem(401, body)) {
        res = await send(retry, await session.refresh());
        body = res.status === 401 ? await bodyOf(res) : undefined;
      }
      endIfUnauthorized(session, res.status, body);
    }
    return res;
  };
  return createClient<paths>({ baseUrl, fetch: authFetch });
}

/**
 * Call after the last try of any API request (REST, GraphQL, uploads). Still refused by the auth middleware (code
 * UNAUTHORIZED; not a wrong password, which is INVALID_CREDENTIALS) for a reason a refresh can't fix (session_idle,
 * or token_* again after refreshing): the session decides whether that ends it (the Admin Center goes to its
 * sign-in; the other apps carry on).
 */
export function endIfUnauthorized(session: Session, status: number, body: unknown): void {
  if (status === 401 && (body as ErrorBody | undefined)?.error?.code === 'UNAUTHORIZED') session.unauthorized(reasonOf(body));
}

/**
 * Unwraps an openapi-fetch result: returns the data or throws an ApiError built from the error envelope.
 *   const cart = await call(api.GET('/api/store/cart'));
 */
export async function call<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  // openapi-fetch has already read the body into `error`: build the ApiError from it (the response can't be
  // read or cloned again, so toApiError(response) would lose the code, message and details).
  if (error !== undefined || !response.ok) throw error !== undefined ? apiErrorFrom(response, error) : await toApiError(response);
  return data as T;
}

/** A new Idempotency-Key: one per user action, reused on retries of that action. */
export const newIdempotencyKey = (): string => crypto.randomUUID();

export { ApiError };
