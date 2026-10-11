/**
 * GraphQL read layer (docs/api/graphql/README.md): read-only, one schema per area at
 * POST /graphql/store, /graphql/seller and /graphql/admin, composed at startup from the
 * enabled modules' fragments. No mutations, no subscriptions: writes stay on REST.
 *
 * Resolvers: the module named in a field's @source(module, fn) resolves it. Fields it has not
 * built yet answer NOT_IMPLEMENTED (partial data is allowed). @phase(n) fields resolve to null until
 * LAUNCH_PHASE reaches n. Resolvers may throw AppErrors: their code reaches the client as `extensions.code`.
 *
 * Central steps every field goes through (wireResolvers), so no resolver has to remember them:
 *   - deadline: the request's time budget (LIMITS.timeoutMs) — a field still running after it answers QUERY_TIMEOUT;
 *   - paging: `paging: PageInput` limits and `limit` / `…Limit` Int arguments are clamped to 1–LIMITS.maxPageSize;
 *   - @auth: wrong caller kind or a missing permission answers FORBIDDEN for that field (partial data).
 * Before anything resolves, a query above the depth or @cost limit is refused (QUERY_TOO_COMPLEX).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  defaultFieldResolver,
  getNamedType,
  getNullableType,
  GraphQLError,
  isInputObjectType,
  isListType,
  isObjectType,
  NoSchemaIntrospectionCustomRule,
  parse,
  validate,
  validateSchema,
  type GraphQLArgument,
  type GraphQLFieldResolver,
  type GraphQLSchema,
} from 'graphql';
import mercurius, { type MercuriusContext } from 'mercurius';
import { persistedQueries } from '../../spec/graphql.js';
import type { AuthChain } from '../auth/chain.js';
import { forbidden, type Principal, type RequestAuth } from '../auth/index.js';
import type { Config } from '../config/index.js';
import { AppError, codeForStatus } from '../errors/index.js';
import type { AuthKind } from '../spec/define.js';
import { AREAS, composeSchema, directiveArg, parseFragments, type Fragment, type GraphQLArea } from './compose.js';
import { costLimitRule } from './cost.js';

export type { GraphQLArea, Fragment };

export interface GraphQLContext {
  area: GraphQLArea;
  principal: Principal | null;
  auth?: RequestAuth;
  requestId: string;
  request: FastifyRequest;
  /** Staff permission answers for this request (a permissioned field in a list is checked once) */
  permissions: Map<string, Promise<boolean>>;
  /** Whether the caller holds a permission, as `can` in REST handlers (dev-token permissions included), memoized per request */
  can(permission: string): Promise<boolean>;
  /** The signed-in customer's customer id (own-customer record scope), null for anyone else */
  customerId(): Promise<string | null>;
  /** Epoch ms after which fields still resolving answer QUERY_TIMEOUT */
  deadline?: number;
}

/** Type name → field name → resolver, for fields whose @source names this module. */
export type ModuleResolvers = Record<string, Record<string, GraphQLFieldResolver<any, GraphQLContext, any>>>;

/** The documented limits (docs/api/graphql/README.md, Limits). */
export const LIMITS = Object.freeze({
  /** Selection depth */
  maxDepth: 9,
  /** Sum of the selected fields' @cost weights (lists 10, other fields 1); the biggest screen query costs about 700 */
  maxCost: 1500,
  /** Items per page: PageInput.limit and `limit` / `…Limit` arguments are clamped to 1–100 */
  maxPageSize: 100,
  /** Time budget of one request; fields still running after it answer QUERY_TIMEOUT */
  timeoutMs: 10_000,
});
export type GraphQLLimits = { -readonly [K in keyof typeof LIMITS]: number };

/** Who may call each endpoint as a whole (the token itself is verified by the app-level middleware); fields narrow it with @auth */
const AREA_AUTH: Record<GraphQLArea, AuthKind> = { store: 'visitor', seller: 'seller', admin: 'staff' };

const KIND_OK: Record<string, (p: Principal | null) => boolean> = {
  ANYONE: () => true,
  SHOPPER: (p) => p?.kind === 'customer' || p?.kind === 'visitor',
  CUSTOMER: (p) => p?.kind === 'customer',
  // fields shared by the seller and admin schemas: staff are checked against the permission instead
  SELLER: (p) => p?.kind === 'seller' || p?.kind === 'staff',
  STAFF: (p) => p?.kind === 'staff',
};

/**
 * Field-level refusals are FORBIDDEN inside a partial (HTTP 200) response, never UNAUTHORIZED: the token is
 * fine, so a client must not refresh it. A guest asking for a signed-in customer's field gets
 * details.reason `sign_in_required` (show sign-in); any other kind `wrong_caller`.
 */
async function checkAuth(requires: string, permission: string | undefined, ctx: GraphQLContext) {
  const p = ctx.principal;
  if (!KIND_OK[requires]?.(p)) {
    const signIn = !p || p.kind === 'visitor';
    throw new AppError('FORBIDDEN', signIn ? 'Sign in to see this' : 'Not available to this kind of session', { reason: signIn ? 'sign_in_required' : 'wrong_caller', requires });
  }
  if (!permission || !p) return;
  if (p.kind !== 'staff' && p.kind !== 'seller') return;
  if (!(await ctx.can(permission))) throw forbidden(permission, `Needs permission ${permission}`);
}

/** Admin-only root fields must say who may read them (@auth), so nothing in the admin schema is open by accident. */
function assertAdminRootAuth(schema: GraphQLSchema) {
  const missing = Object.values(schema.getQueryType()?.getFields() ?? {})
    .filter((f) => f.name !== 'ping')
    .filter((f) => {
      const areas = directiveArg(f.astNode, 'areas', 'in') as string[] | undefined;
      return areas?.length === 1 && areas[0] === 'ADMIN' && !directiveArg(f.astNode, 'auth', 'requires');
    })
    .map((f) => f.name);
  if (missing.length) throw new Error(`Admin GraphQL root fields without @auth: ${missing.join(', ')}`);
}

/* ---------------------------------------------------------------- central field steps */

const timeoutError = (timeoutMs: number) => new AppError('QUERY_TIMEOUT', `The query took longer than ${timeoutMs / 1000} s; ask for less or try again`, { timeoutMs }, 503);

/** Runs a field resolver within the request's deadline (fields that start after it fail at once). */
function withinDeadline(inner: GraphQLFieldResolver<any, GraphQLContext>, timeoutMs: number): GraphQLFieldResolver<any, GraphQLContext> {
  return (root, args, ctx, info) => {
    const left = (ctx.deadline ?? Infinity) - Date.now();
    if (left <= 0) throw timeoutError(timeoutMs);
    const out = inner(root, args, ctx, info);
    if (!(out instanceof Promise) || left === Infinity) return out;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(timeoutError(timeoutMs)), left);
      out.then(
        (v) => (clearTimeout(timer), resolve(v)),
        (e) => (clearTimeout(timer), reject(e)),
      );
    });
  };
}

const clamp = (n: unknown, max: number) => (typeof n === 'number' ? Math.min(Math.max(Math.trunc(n), 1), max) : n);

/** Paging arguments of a field: PageInput arguments (their `limit`) and Int arguments named limit / …Limit */
function pagingArgs(args: readonly GraphQLArgument[]) {
  const pageInputs: string[] = [];
  const limits: string[] = [];
  for (const a of args) {
    const t = getNullableType(a.type);
    const named = getNamedType(a.type);
    if (isInputObjectType(named) && named.name === 'PageInput' && !isListType(t)) pageInputs.push(a.name);
    else if (named.name === 'Int' && !isListType(t) && (a.name === 'limit' || a.name.endsWith('Limit'))) limits.push(a.name);
  }
  return { pageInputs, limits };
}

function clampingPaging(inner: GraphQLFieldResolver<any, GraphQLContext>, p: { pageInputs: string[]; limits: string[] }, max: number): GraphQLFieldResolver<any, GraphQLContext> {
  return (root, args: Record<string, unknown>, ctx, info) => {
    const next = { ...args };
    for (const k of p.limits) next[k] = clamp(next[k], max);
    for (const k of p.pageInputs) {
      const v = next[k] as Record<string, unknown> | null | undefined;
      if (v && typeof v === 'object' && v.limit != null) next[k] = { ...v, limit: clamp(v.limit, max) };
    }
    return inner(root, next, ctx, info);
  };
}

export function wireResolvers(schema: GraphQLSchema, resolvers: Map<string, ModuleResolvers>, launchPhase: number, limits: Pick<GraphQLLimits, 'maxPageSize' | 'timeoutMs'> = LIMITS) {
  const unresolved: string[] = [];
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith('__')) continue;
    const typePhase = directiveArg(type.astNode, 'phase', 'n') as number | undefined;
    for (const field of Object.values(type.getFields())) {
      const node = field.astNode;
      const phase = (directiveArg(node, 'phase', 'n') as number | undefined) ?? typePhase;
      if (phase && phase > launchPhase) {
        field.resolve = () => null;
        continue;
      }
      if (type.name === 'Query' && field.name === 'ping') field.resolve = () => 'pong';
      const module = directiveArg(node, 'source', 'module') as string | undefined;
      if (module) {
        const fn = directiveArg(node, 'source', 'fn') as string;
        const own = resolvers.get(module)?.[type.name]?.[field.name];
        if (!own) unresolved.push(`${type.name}.${field.name}`);
        field.resolve =
          own ??
          (() => {
            throw new GraphQLError(`${type.name}.${field.name} (${module}.${fn}) is designed but not built yet.`, { extensions: { code: 'NOT_IMPLEMENTED' } });
          });
      }
      const resolverOf = () => field.resolve ?? (defaultFieldResolver as GraphQLFieldResolver<any, GraphQLContext>);
      const requires = (directiveArg(node, 'auth', 'requires') ?? directiveArg(type.astNode, 'auth', 'requires')) as string | undefined;
      if (requires) {
        const permission = (directiveArg(node, 'auth', 'permission') ?? directiveArg(type.astNode, 'auth', 'permission')) as string | undefined;
        const inner = resolverOf();
        field.resolve = async (root, args, ctx, info) => {
          await checkAuth(requires, permission, ctx);
          return inner(root, args, ctx, info);
        };
      }
      const paging = pagingArgs(field.args);
      if (paging.pageInputs.length || paging.limits.length) field.resolve = clampingPaging(resolverOf(), paging, limits.maxPageSize);
      if (module || requires) field.resolve = withinDeadline(resolverOf(), limits.timeoutMs);
    }
  }
  return { unresolved };
}

/* ---------------------------------------------------------------- persisted queries */

interface GraphQLBody {
  query?: unknown;
  persisted?: boolean;
  extensions?: { persistedQuery?: { version?: unknown; sha256Hash?: unknown } } | null;
}

const apqHash = (b: GraphQLBody) => {
  const pq = b.extensions?.persistedQuery;
  return pq && pq.version === 1 && typeof pq.sha256Hash === 'string' ? pq.sha256Hash : null;
};

/**
 * Persisted screen queries by manifest id, in both request formats:
 *   - mercurius: `{ "persisted": true, "query": "<id>" }`;
 *   - Apollo (Apollo Kotlin, automatic persisted queries): `{ "extensions": { "persistedQuery": { "version": 1, "sha256Hash": "<id>" } } }`,
 *     also as GET with `extensions` in the query string. A retry that adds the query text still runs the manifest's text.
 * With `only` (store and seller in production) nothing else runs: free query text is refused.
 * Unknown ids answer `PersistedQueryNotFound` (the message Apollo clients look for).
 */
export function persistedQueryProvider(queries: Record<string, string>, only: boolean) {
  return {
    isPersistedQuery: (b: GraphQLBody) => only || b.persisted === true || (!b.query && Boolean(b.extensions?.persistedQuery)),
    getHash: (b: GraphQLBody) => (b.persisted ? (typeof b.query === 'string' ? b.query : false) : (apqHash(b) ?? false)),
    getQueryFromHash: async (hash: string) => (Object.hasOwn(queries, hash) ? queries[hash] : undefined),
    notFoundError: 'PersistedQueryNotFound',
    notSupportedError: 'PersistedQueryNotSupported',
  };
}

/* ---------------------------------------------------------------- errors */

/** Mercurius's own errors → the error codes clients see in extensions.code */
const MERCURIUS_CODES: Record<string, string> = {
  MER_ERR_GQL_PERSISTED_QUERY_NOT_FOUND: 'PERSISTED_QUERY_NOT_FOUND',
  MER_ERR_GQL_PERSISTED_QUERY_NOT_SUPPORTED: 'PERSISTED_QUERY_NOT_SUPPORTED',
  MER_ERR_GQL_QUERY_DEPTH: 'QUERY_TOO_COMPLEX',
};

type AnyError = Error & { code?: string; statusCode?: number; extensions?: Record<string, unknown>; errors?: unknown[]; originalError?: AnyError | null };

/** Gives every error an extensions.code: its own (AppError, cost rule), mercurius', by HTTP status, or the fallback. */
function coded(e: AnyError, fallback: string, production: boolean): GraphQLError {
  const g = e instanceof GraphQLError ? e : new GraphQLError(e.message, { originalError: e, extensions: e.extensions });
  if (g.extensions?.code) return g;
  const orig = (g.originalError ?? e) as AnyError;
  const status = orig.statusCode;
  const code = MERCURIUS_CODES[orig.code ?? ''] ?? (typeof status === 'number' && status >= 400 && status < 500 ? codeForStatus(status) : fallback);
  const message = code === 'INTERNAL_ERROR' && production ? 'Something went wrong. Include the X-Request-Id when reporting it.' : g.message;
  return new GraphQLError(message, { nodes: g.nodes, source: g.source, positions: g.positions, path: g.path, originalError: g.originalError, extensions: { ...g.extensions, code } });
}

function errorFormatter(production: boolean) {
  return (execution: { data?: unknown; errors: readonly AnyError[]; statusCode?: number }, ctx: MercuriusContext) => {
    const first = execution.errors[0];
    const statusCode = execution.data ? 200 : (execution.statusCode ?? (execution.errors.length === 1 && typeof first?.originalError?.statusCode === 'number' ? first.originalError.statusCode : (first?.statusCode ?? 200)));
    // validation (and variable) failures arrive as one mercurius error holding the list
    const errors = execution.errors.flatMap((e) => {
      const inner = e.originalError?.errors ?? (e instanceof GraphQLError ? undefined : e.errors);
      return Array.isArray(inner) ? inner.map((x) => coded(x as AnyError, 'VALIDATION_FAILED', production)) : [coded(e, 'INTERNAL_ERROR', production)];
    });
    return mercurius.defaultErrorFormatter({ data: execution.data as never, errors, statusCode } as never, ctx);
  };
}

/* ---------------------------------------------------------------- registration */

export interface GraphQLKernelOptions {
  config: Config;
  baseTypeDefs: string;
  fragments: Fragment[];
  resolvers: Map<string, ModuleResolvers>;
  auth: AuthChain;
  /** Override the documented limits (tests) */
  limits?: Partial<GraphQLLimits>;
  /** Persisted queries per area, id → query text (default: the generated manifests) */
  persisted?: Record<GraphQLArea, Record<string, string>>;
}

export async function registerGraphQL(app: FastifyInstance, o: GraphQLKernelOptions) {
  const limits: GraphQLLimits = { ...LIMITS, ...o.limits };
  const production = o.config.env === 'production';
  const docs = parseFragments(o.baseTypeDefs, o.fragments);
  const out = {} as Record<GraphQLArea, { schema: GraphQLSchema; dropped: string[]; unresolved: string[] }>;
  for (const area of AREAS) {
    const { schema, dropped } = composeSchema(area, docs);
    const problems = validateSchema(schema);
    if (problems.length) throw new Error(`GraphQL ${area} schema is invalid with the enabled modules:\n${problems.map((p) => `  - ${p.message}`).join('\n')}`);
    if (area === 'admin') assertAdminRootAuth(schema);
    const { unresolved } = wireResolvers(schema, o.resolvers, o.config.launchPhase, limits);
    out[area] = { schema, dropped, unresolved };

    const persisted = o.persisted?.[area] ?? Object.fromEntries(Object.entries(persistedQueries[area]).map(([id, q]) => [id, q.query]));

    await app.register(async (scope) => {
      // the token was verified by the app-level middleware; here: audience, caller kind, seller context, staff 2-step
      scope.addHook('preHandler', async (request) => {
        await o.auth.checkCaller(request, { area, auth: AREA_AUTH[area] });
      });
      await scope.register(mercurius, {
        schema,
        path: `/graphql/${area}`,
        graphiql: false,
        queryDepth: limits.maxDepth,
        // the schema is not discoverable in production; apps use persisted screen queries
        validationRules: [costLimitRule(limits.maxCost), ...(production ? [NoSchemaIntrospectionCustomRule] : [])],
        persistedQueryProvider: persistedQueryProvider(persisted, o.config.graphqlPersistedOnly && area !== 'admin') as never,
        errorFormatter: errorFormatter(production) as never,
        context: (request: FastifyRequest): GraphQLContext => {
          const permissions = new Map<string, Promise<boolean>>();
          return {
            area,
            principal: request.auth?.principal ?? null,
            auth: request.auth,
            requestId: request.id,
            request,
            permissions,
            can: (permission: string) => {
              if (!permissions.has(permission)) permissions.set(permission, o.auth.can(request.auth, permission));
              return permissions.get(permission)!;
            },
            customerId: () => o.auth.customerIdOf(request.auth?.principal),
            deadline: Date.now() + limits.timeoutMs,
          };
        },
      });
    });
  }
  return out;
}

/** Persisted screen queries that can't run with the enabled modules (they select fields of a disabled one). */
export function unusablePersistedQueries(schemas: Record<GraphQLArea, { schema: GraphQLSchema }>) {
  return AREAS.flatMap((area) =>
    Object.values(persistedQueries[area])
      .map((q) => ({ area, name: q.name, errors: validate(schemas[area].schema, parse(q.query)).map((e) => e.message) }))
      .filter((q) => q.errors.length),
  );
}
