import { ApiError, isTokenProblem } from './errors';
import type { Audience, Session } from './session';

interface GqlResponse<T> {
  data?: T | null;
  errors?: Array<{ message: string; path?: Array<string | number>; extensions?: { code?: string; [k: string]: unknown } }>;
}

export interface GqlResult<T> {
  data: T | null;
  /** Field-level errors (e.g. FORBIDDEN on one field): the rest of the data still answers. */
  errors: NonNullable<GqlResponse<T>['errors']>;
}

/**
 * Runs a GraphQL screen query on the app's endpoint (/graphql/store, /graphql/seller, /graphql/admin).
 * Development sends the query text (GRAPHQL_PERSISTED_ONLY is off); production sends the persisted id
 * from docs/api/graphql/operations/<area>/manifest.json. Partial data is allowed: only a missing
 * `data` throws.
 */
export function createGraphql(session: Session, baseUrl = '') {
  const area: Audience = session.audience;
  return async function gql<T, V extends Record<string, unknown> = Record<string, unknown>>(query: string, variables?: V, operationName?: string): Promise<GqlResult<T>> {
    const send = async (token: string) =>
      fetch(`${baseUrl}/graphql/${area}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Client': 'web' },
        body: JSON.stringify({ query, variables, operationName }),
      });
    let res = await send(await session.token());
    let body = (await res.json().catch(() => ({}))) as GqlResponse<T> & { error?: { code: string; message: string; details?: Record<string, unknown> } };
    if (isTokenProblem(res.status, body)) {
      res = await send(await session.refresh());
      body = (await res.json().catch(() => ({}))) as typeof body;
    }
    if (body.error) throw new ApiError(res.status, body.error.code, body.error.message, body.error.details ?? {}, res.headers.get('x-request-id'));
    if (!body.data) {
      const first = body.errors?.[0];
      throw new ApiError(res.status, first?.extensions?.code ?? 'GRAPHQL_ERROR', first?.message ?? 'GraphQL request failed', {}, res.headers.get('x-request-id'));
    }
    return { data: body.data, errors: body.errors ?? [] };
  };
}
