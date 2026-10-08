/**
 * GraphQL read layer (docs/api/graphql/README.md): read-only, one schema per area at
 * POST /graphql/store, /graphql/seller and /graphql/admin, composed at startup from the
 * enabled modules' fragments. No mutations, no subscriptions: writes stay on REST.
 *
 * Resolvers: the module named in a field's @source(module, fn) resolves it. Fields it has not
 * built yet answer NOT_IMPLEMENTED (partial data is allowed). @auth is enforced per field and
 * @phase(n) fields resolve to null until LAUNCH_PHASE reaches n. Resolvers may throw AppErrors:
 * their code reaches the client as `extensions.code`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { defaultFieldResolver, GraphQLError, isObjectType, NoSchemaIntrospectionCustomRule, parse, validate, validateSchema, type GraphQLFieldResolver, type GraphQLSchema } from 'graphql';
import mercurius from 'mercurius';
import { persistedQueries } from '../../spec/graphql.js';
import type { AuthChain } from '../auth/chain.js';
import type { Principal, RequestAuth } from '../auth/index.js';
import type { Config } from '../config/index.js';
import type { AuthKind } from '../spec/define.js';
import { AREAS, composeSchema, directiveArg, parseFragments, type Fragment, type GraphQLArea } from './compose.js';

export type { GraphQLArea, Fragment };

export interface GraphQLContext {
  area: GraphQLArea;
  principal: Principal | null;
  auth?: RequestAuth;
  requestId: string;
  request: FastifyRequest;
  /** Staff permission answers for this request (a permissioned field in a list is checked once) */
  permissions: Map<string, Promise<boolean>>;
}

/** Type name → field name → resolver, for fields whose @source names this module. */
export type ModuleResolvers = Record<string, Record<string, GraphQLFieldResolver<any, GraphQLContext, any>>>;

const MAX_DEPTH = 9;

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

const gqlError = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });

async function checkAuth(requires: string, permission: string | undefined, ctx: GraphQLContext, auth: AuthChain) {
  const p = ctx.principal;
  if (!KIND_OK[requires]?.(p)) throw gqlError('UNAUTHORIZED', 'Not available to this session');
  if (!permission || !p) return;
  if (p.kind !== 'staff' && p.kind !== 'seller') return;
  if (!ctx.permissions.has(permission)) ctx.permissions.set(permission, auth.can(ctx.auth, permission));
  if (!(await ctx.permissions.get(permission))) throw gqlError('FORBIDDEN', `Needs permission ${permission}`);
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

export function wireResolvers(schema: GraphQLSchema, resolvers: Map<string, ModuleResolvers>, launchPhase: number, auth: AuthChain) {
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
            throw gqlError('NOT_IMPLEMENTED', `${type.name}.${field.name} (${module}.${fn}) is designed but not built yet.`);
          });
      }
      const requires = (directiveArg(node, 'auth', 'requires') ?? directiveArg(type.astNode, 'auth', 'requires')) as string | undefined;
      if (requires) {
        const permission = (directiveArg(node, 'auth', 'permission') ?? directiveArg(type.astNode, 'auth', 'permission')) as string | undefined;
        const inner: GraphQLFieldResolver<any, GraphQLContext> = field.resolve ?? defaultFieldResolver;
        field.resolve = async (root, args, ctx, info) => {
          await checkAuth(requires, permission, ctx, auth);
          return inner(root, args, ctx, info);
        };
      }
    }
  }
  return { unresolved };
}

export interface GraphQLKernelOptions {
  config: Config;
  baseTypeDefs: string;
  fragments: Fragment[];
  resolvers: Map<string, ModuleResolvers>;
  auth: AuthChain;
}

export async function registerGraphQL(app: FastifyInstance, o: GraphQLKernelOptions) {
  const docs = parseFragments(o.baseTypeDefs, o.fragments);
  const out = {} as Record<GraphQLArea, { schema: GraphQLSchema; dropped: string[]; unresolved: string[] }>;
  for (const area of AREAS) {
    const { schema, dropped } = composeSchema(area, docs);
    const problems = validateSchema(schema);
    if (problems.length) throw new Error(`GraphQL ${area} schema is invalid with the enabled modules:\n${problems.map((p) => `  - ${p.message}`).join('\n')}`);
    if (area === 'admin') assertAdminRootAuth(schema);
    const { unresolved } = wireResolvers(schema, o.resolvers, o.config.launchPhase, o.auth);
    out[area] = { schema, dropped, unresolved };

    const persisted = Object.fromEntries(Object.entries(persistedQueries[area]).map(([id, q]) => [id, q.query]));
    const provider = o.config.graphqlPersistedOnly && area !== 'admin' ? mercurius.persistedQueryDefaults.preparedOnly : mercurius.persistedQueryDefaults.prepared;

    await app.register(async (scope) => {
      // the token was verified by the app-level middleware; here: audience, caller kind, seller context, staff 2-step
      scope.addHook('preHandler', async (request) => {
        await o.auth.checkCaller(request, { area, auth: AREA_AUTH[area] });
      });
      await scope.register(mercurius, {
        schema,
        path: `/graphql/${area}`,
        graphiql: false,
        queryDepth: MAX_DEPTH,
        // the schema is not discoverable in production; apps use persisted screen queries
        ...(o.config.env === 'production' ? { validationRules: [NoSchemaIntrospectionCustomRule] } : {}),
        persistedQueryProvider: provider(persisted),
        context: (request: FastifyRequest): GraphQLContext => ({
          area,
          principal: request.auth?.principal ?? null,
          auth: request.auth,
          requestId: request.id,
          request,
          permissions: new Map(),
        }),
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
