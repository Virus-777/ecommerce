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

type Manifest = Record<string, { id: string }>;
/** Persisted ids per area (src/api/graphql/<area>/manifest.json, copied from the backend by gen-api). */
const MANIFESTS: Partial<Record<string, Manifest>> = Object.fromEntries(
  Object.entries(import.meta.glob<Manifest>('./graphql/*/manifest.json', { eager: true, import: 'default' })).map(([path, m]) => [path.split('/')[2], m]),
);
/** The persisted query texts, loaded in development only, to spot pages that changed them. */
const TEXTS: Record<string, () => Promise<string>> = import.meta.env.DEV ? import.meta.glob<string>('./graphql/*/*.graphql', { query: '?raw', import: 'default' }) : {};
const squash = (s: string) => s.replace(/#[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const warned = new Set<string>();
const warnOnce = (key: string, text: string) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[graphql] ${key}: ${text}`);
};

/** Development only: whether a page sends a persisted query with changed text (production runs the persisted text). */
async function changedText(area: Audience, operationName: string, query: string) {
  const load = TEXTS[`./graphql/${area}/${operationName}.graphql`];
  return !!load && squash(await load()) !== squash(query);
}

/**
 * Runs a GraphQL screen query on the app's endpoint (/graphql/store, /graphql/seller, /graphql/admin).
 * An operation in the area's manifest is sent as its persisted id (Apollo's format, as the Android app sends it):
 * production store and seller GraphQL accept persisted ids only (GRAPHQL_PERSISTED_ONLY), and run the manifest's
 * text. Anything else goes as text, which only development and the admin area accept. Development also sends text
 * when a page changed a persisted query (and warns: production won't have the added fields). Partial data is
 * allowed: only a missing `data` throws.
 */
export function createGraphql(session: Session, baseUrl = '') {
  const area: Audience = session.audience;
  return async function gql<T, V extends Record<string, unknown> = Record<string, unknown>>(query: string, variables?: V, operationName?: string): Promise<GqlResult<T>> {
    let id = operationName ? MANIFESTS[area]?.[operationName]?.id : undefined;
    if (import.meta.env.DEV) {
      const name = operationName ?? query.trim().slice(0, 48);
      if (id && operationName && (await changedText(area, operationName, query))) {
        id = undefined;
        warnOnce(`${area}/${name}`, 'the page changed this persisted query; production runs the persisted text, so the added fields will be missing there.');
      } else if (!id && area !== 'admin') {
        warnOnce(`${area}/${name}`, `not a persisted query; production refuses query text on /graphql/${area}.`);
      }
    }
    const payload = id ? { extensions: { persistedQuery: { version: 1, sha256Hash: id } }, variables, operationName } : { query, variables, operationName };
    const send = async (token: string) =>
      fetch(`${baseUrl}/graphql/${area}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Client': 'web' },
        body: JSON.stringify(payload),
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
