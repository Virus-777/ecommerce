/**
 * GraphQL read layer (docs/api/graphql/README.md): read-only, one schema per area at
 * POST /graphql/store, /graphql/seller and /graphql/admin, composed at startup from the
 * enabled modules' fragments. No mutations, no subscriptions: writes stay on REST.
 *
 * Resolvers: the module named in a field's @source(module, fn) resolves it. Fields it has not
 * built yet answer NOT_IMPLEMENTED (partial data is allowed). @auth is enforced per field and
 * @phase(n) fields resolve to null until LAUNCH_PHASE reaches n.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ConstDirectiveNode, GraphQLFieldResolver, GraphQLSchema } from 'graphql';
import mercurius from 'mercurius';
import { persistedQueries } from '../../spec/graphql.js';
import { authorize, type Authenticator, type AuthResult, type Principal } from '../auth/index.js';
import type { Config } from '../config/index.js';
import { isAppError } from '../errors/index.js';
import { composeSchema, type Fragment, type GraphQLArea } from './compose.js';
import { graphql } from './runtime.js';

const { defaultFieldResolver, GraphQLError, isObjectType, validateSchema } = graphql;

export type { GraphQLArea, Fragment };

export interface GraphQLContext {
  area: GraphQLArea;
  principal: Principal | null;
  sellerAccess?: AuthResult['sellerAccess'];
  requestId: string;
  request: FastifyRequest;
}

/** Type name → field name → resolver, for fields whose @source names this module. */
export type ModuleResolvers = Record<string, Record<string, GraphQLFieldResolver<any, GraphQLContext, any>>>;

const MAX_DEPTH = 9;

const dirArg = (d: ConstDirectiveNode | undefined, name: string) => {
  const v = d?.arguments?.find((a) => a.name.value === name)?.value;
  if (!v) return undefined;
  if (v.kind === 'StringValue' || v.kind === 'EnumValue') return v.value;
  if (v.kind === 'IntValue') return Number(v.value);
  return undefined;
};
const directive = (node: { directives?: readonly ConstDirectiveNode[] } | null | undefined, name: string) => node?.directives?.find((d) => d.name.value === name);

const gqlError = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });

function checkAuth(requires: string, permission: string | undefined, ctx: GraphQLContext, authenticator: Authenticator): Promise<void> | void {
  const p = ctx.principal;
  const kindOk =
    requires === 'ANYONE' ||
    (requires === 'SHOPPER' && (p?.kind === 'customer' || p?.kind === 'guest')) ||
    (requires === 'CUSTOMER' && p?.kind === 'customer') ||
    (requires === 'SELLER' && p?.kind === 'seller') ||
    (requires === 'STAFF' && p?.kind === 'staff');
  // seller-and-admin fields: staff callers are checked against the permission, sellers are limited to their own account
  if (!kindOk && !(requires === 'SELLER' && p?.kind === 'staff')) throw gqlError('UNAUTHORIZED', 'Not available to this session');
  if (!permission || !p) return;
  if (p.kind === 'staff') {
    return authenticator.hasPermission(p, permission).then((ok) => {
      if (!ok) throw gqlError('FORBIDDEN', `Needs permission ${permission}`);
    });
  }
  if (p.kind === 'seller' && ctx.sellerAccess && !ctx.sellerAccess.isOwner && !ctx.sellerAccess.permissions.includes(permission)) {
    throw gqlError('FORBIDDEN', `Needs permission ${permission}`);
  }
}

export function wireResolvers(schema: GraphQLSchema, resolvers: Map<string, ModuleResolvers>, launchPhase: number, authenticator: Authenticator) {
  const unresolved: string[] = [];
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith('__')) continue;
    const typeAuth = directive(type.astNode, 'auth');
    const typePhase = dirArg(directive(type.astNode, 'phase'), 'n') as number | undefined;
    for (const field of Object.values(type.getFields())) {
      const node = field.astNode;
      const src = directive(node, 'source');
      const auth = directive(node, 'auth') ?? typeAuth;
      const phase = (dirArg(directive(node, 'phase'), 'n') as number | undefined) ?? typePhase;
      let resolve: GraphQLFieldResolver<any, GraphQLContext, any> = field.resolve ?? defaultFieldResolver;
      if (type.name === 'Query' && field.name === 'ping') resolve = () => 'pong';
      else if (src) {
        const module = String(dirArg(src, 'module'));
        const fn = String(dirArg(src, 'fn'));
        const own = resolvers.get(module)?.[type.name]?.[field.name];
        if (own) resolve = own;
        else {
          unresolved.push(`${type.name}.${field.name}`);
          resolve = () => {
            throw gqlError('NOT_IMPLEMENTED', `${type.name}.${field.name} (${module}.${fn}) is designed but not built yet.`);
          };
        }
      }
      if (phase && phase > launchPhase) {
        field.resolve = () => null;
        continue;
      }
      if (auth) {
        const requires = String(dirArg(auth, 'requires'));
        const permission = dirArg(auth, 'permission') as string | undefined;
        const inner = resolve;
        resolve = async (root, args, ctx, info) => {
          await checkAuth(requires, permission, ctx, authenticator);
          return inner(root, args, ctx, info);
        };
      }
      const inner = resolve;
      field.resolve = async (root, args, ctx, info) => {
        try {
          return await inner(root, args, ctx, info);
        } catch (err) {
          if (isAppError(err)) throw new GraphQLError(err.message, { extensions: { code: err.code, ...(err.details ? { details: err.details } : {}) } });
          throw err;
        }
      };
    }
  }
  return { unresolved };
}

export interface GraphQLKernelOptions {
  config: Config;
  baseTypeDefs: string;
  fragments: Fragment[];
  resolvers: Map<string, ModuleResolvers>;
  authenticator: Authenticator;
}

export async function registerGraphQL(app: FastifyInstance, o: GraphQLKernelOptions) {
  const out: Record<string, { schema: GraphQLSchema; dropped: string[]; unresolved: string[] }> = {};
  for (const area of ['store', 'seller', 'admin'] as const) {
    const { schema, dropped } = composeSchema(area, o.baseTypeDefs, o.fragments);
    const problems = validateSchema(schema);
    if (problems.length) throw new Error(`GraphQL ${area} schema is invalid with the enabled modules:\n${problems.map((p) => `  - ${p.message}`).join('\n')}`);
    const { unresolved } = wireResolvers(schema, o.resolvers, o.config.launchPhase, o.authenticator);
    out[area] = { schema, dropped, unresolved };

    const persisted = Object.fromEntries(Object.entries(persistedQueries[area]).map(([id, q]) => [id, q.query]));
    const persistedOnly = o.config.graphqlPersistedOnly && area !== 'admin';
    const endpointAuth = area === 'store' ? ('anyone' as const) : area === 'seller' ? ('seller' as const) : ('staff' as const);

    await app.register(async (scope) => {
      scope.addHook('preHandler', async (request) => {
        if (request.url.startsWith(`/graphql/${area}`)) request.auth = await authorize(request, { area, auth: endpointAuth }, o.authenticator);
      });
      await scope.register(mercurius, {
        schema,
        path: `/graphql/${area}`,
        graphiql: false,
        queryDepth: MAX_DEPTH,
        persistedQueryProvider: persistedOnly ? mercurius.persistedQueryDefaults.preparedOnly(persisted) : mercurius.persistedQueryDefaults.prepared(persisted),
        context: (request: FastifyRequest): GraphQLContext => ({
          area,
          principal: request.auth?.principal ?? null,
          sellerAccess: request.auth?.sellerAccess,
          requestId: request.id,
          request,
        }),
        errorFormatter: (execution, ctx) => {
          const formatted = mercurius.defaultErrorFormatter(execution, ctx);
          return { statusCode: formatted.statusCode === 500 && execution.data ? 200 : formatted.statusCode, response: formatted.response };
        },
        // Session problems keep the REST status (401/403) and carry the REST error code
        errorHandler: (err: Error & { errors?: Error[] }, _request, reply) => {
          if (isAppError(err)) {
            void reply.code(err.status).send({ data: null, errors: [{ message: err.message, extensions: { code: err.code, ...(err.details ? { details: err.details } : {}) } }] });
            return;
          }
          const { statusCode, response } = mercurius.defaultErrorFormatter({ errors: (err.errors ?? [err]) as never }, null as never);
          void reply.code(statusCode ?? 500).send(response);
        },
      });
    });
  }
  return out;
}

/** Persisted screen queries that can't run with the enabled modules (they select fields of a disabled one). */
export function unusablePersistedQueries(schemas: Record<string, { schema: GraphQLSchema }>) {
  const out: { area: string; name: string; errors: string[] }[] = [];
  for (const area of ['store', 'seller', 'admin'] as const) {
    for (const q of Object.values(persistedQueries[area])) {
      const errors = graphql.validate(schemas[area]!.schema, graphql.parse(q.query)).map((e) => e.message);
      if (errors.length) out.push({ area, name: q.name, errors });
    }
  }
  return out;
}
