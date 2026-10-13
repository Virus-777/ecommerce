import createClient, { type Client } from 'openapi-fetch';
import { ApiError, isTokenProblem, toApiError } from './errors';
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
    const retry = input.clone();
    let res = await send(input, await session.token());
    if (res.status === 401) {
      let body: unknown;
      try {
        body = await res.clone().json();
      } catch {
        /* empty */
      }
      if (isTokenProblem(401, body)) res = await send(retry, await session.refresh());
    }
    return res;
  };
  return createClient<paths>({ baseUrl, fetch: authFetch });
}

/**
 * Unwraps an openapi-fetch result: returns the data or throws an ApiError built from the error envelope.
 *   const cart = await call(api.GET('/api/store/cart'));
 */
export async function call<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (error !== undefined || !response.ok) throw await toApiError(response);
  return data as T;
}

/** A new Idempotency-Key: one per user action, reused on retries of that action. */
export const newIdempotencyKey = (): string => crypto.randomUUID();

export { ApiError };
