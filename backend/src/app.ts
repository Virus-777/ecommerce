/**
 * buildApp(): kernel + enabled modules. Used by main.ts, the tests and the check tools.
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { moduleAuthorities, type Authorities } from './kernel/auth/authorities.js';
import { REFRESH_COOKIE, type AuthChain, type WebhookVerifier } from './kernel/auth/chain.js';
import { memoryRateLimitStore, postgresRateLimitStore, PURGE_RATE_LIMITS_JOB } from './kernel/auth/rate-limit.js';
import { fileLinkSecret } from './kernel/auth/file-links.js';
import { createAuthChain } from './kernel/auth/setup.js';
import type { Principal } from './kernel/auth/index.js';
import type { KeyRing } from './kernel/auth/tokens.js';
import { loadConfig, type Config } from './kernel/config/index.js';
import { createDatabase, type Database } from './kernel/db/index.js';
import { registerErrorCodes } from './kernel/errors/index.js';
import { EventBus } from './kernel/events/index.js';
import { registerGraphQL, unusablePersistedQueries } from './kernel/graphql/index.js';
import { registerFileRoute } from './kernel/http/files.js';
import { postgresIdempotencyStore } from './kernel/http/idempotency.js';
import { createOpenApiObjectTransform, createOpenApiTransform } from './kernel/http/openapi.js';
import { registerEndpoints } from './kernel/http/register.js';
import { createServer } from './kernel/http/server.js';
import type { PublicApiMap } from './kernel/module-system/public-apis.js';
import { createJobScheduler, type JobScheduler } from './kernel/jobs/index.js';
import { systemClock, type Clock } from './kernel/lib/clock.js';
import { createRefGenerator } from './kernel/lib/refs.js';
import { migrate, migrationUnits } from './kernel/migrations/index.js';
import { bootModules, type BootResult } from './kernel/module-system/boot.js';
import { allSpecs, loadDefinitions } from './kernel/module-system/loader.js';
import { enabledModules } from './modules.config.js';
import { moduleLoaders } from './modules/index.js';
import * as common from './spec/common.js';
import { baseTypeDefs } from './spec/graphql.js';

export interface BuildOptions {
  /** Environment to read the config from (default process.env) */
  env?: Record<string, string | undefined>;
  config?: Partial<Config>;
  /** Modules to run (default: MODULES env, else src/modules.config.ts) */
  modules?: string[];
  /** Bring your own database (tests share one); otherwise created from the config and closed with the app */
  database?: Database;
  clock?: Clock;
  /** Wrap the authorities (tests) */
  authorities?: (base: Authorities) => Authorities;
  /** Verifiers for modules that don't register their own yet (tests) */
  webhookVerifiers?: Record<string, WebhookVerifier>;
  /**
   * Tests: replace public API functions of enabled modules, e.g. a dependency built in a later
   * tranche: { identity: { getAccount: async () => ({ … }) } }. Functions not listed keep the module's own.
   */
  apiStubs?: { [M in keyof PublicApiMap]?: Partial<PublicApiMap[M]> };
}

export interface Kernel {
  config: Config;
  database: Database;
  events: EventBus;
  jobs: JobScheduler;
  modules: string[];
  boot: BootResult;
  auth: AuthChain;
  /** Development and tests: the key that signs dev tokens */
  devSigner?: KeyRing['dev'];
  graphql: Awaited<ReturnType<typeof registerGraphQL>>;
  /** Persisted screen queries that select fields of a disabled module */
  unusableQueries: ReturnType<typeof unusablePersistedQueries>;
  /** Served on the internal health port (main.ts), not on the public API */
  health(): { status: 'ok'; modules: number; launchPhase: number };
}

declare module 'fastify' {
  interface FastifyInstance {
    kernel: Kernel;
  }
}

/**
 * A module's API as other modules see it, with some functions replaced. Callers through the API get the stubs; the
 * module's own methods stay bound to the module object, so a service class with #private fields keeps working when
 * one of its methods runs next to a stubbed one (a Proxy as `this` would make its private fields throw "Receiver must
 * be an instance"). The module itself is untouched: its routes, consumers and `this.fn()` calls run its own code.
 * Assigning a function through the API (a test replacing it later) sets it on the module object, and over a stub of
 * the same name.
 */
export function withStubs(api: object | undefined, stub: object): object {
  const stubs = stub as Record<PropertyKey, unknown>;
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(api ?? {}, {
    get: (target, key) => {
      if (key in stubs) return stubs[key];
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!bound.has(key)) bound.set(key, (value as (...args: unknown[]) => unknown).bind(target));
      return bound.get(key);
    },
    has: (target, key) => key in stubs || key in target,
    set: (target, key, value) => {
      bound.delete(key);
      if (key in stubs) stubs[key] = value;
      return Reflect.set(target, key, value);
    },
  });
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig(opts.env ?? process.env, opts.config);
  const app = createServer(config);

  // independent startup work runs in parallel: the database and the module imports
  const [database, defs] = await Promise.all([
    opts.database ?? createDatabase({ url: config.databaseUrl, pgliteDir: config.pgliteDir }),
    loadDefinitions(opts.modules ?? config.modules ?? enabledModules, moduleLoaders),
  ]);

  /* ---------------------------------------------------------------- OpenAPI (generated from the same Zod schemas); Swagger UI in development */
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: common.info,
      servers: common.servers,
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', description: common.headers.Authorization },
          refreshCookie: { type: 'apiKey', in: 'cookie', name: REFRESH_COOKIE, description: 'Website refresh token (HttpOnly; Secure; SameSite=Strict; Path=/api/public/identity/sessions, sent only to refresh and sign-out). Android sends refreshToken in the body instead.' },
          appProof: { type: 'apiKey', in: 'header', name: 'X-App-Proof', description: common.headers['X-App-Proof'] },
          webhookSignature: { type: 'apiKey', in: 'header', name: 'X-Signature', description: 'Provider signature, verified per provider' },
        },
      },
    },
    transform: createOpenApiTransform(common.apiTypes, ['/docs']),
    transformObject: createOpenApiObjectTransform(common.apiTypes),
  });
  if (config.docsEnabled) await app.register(swaggerUi, { routePrefix: '/docs' });

  /* ---------------------------------------------------------------- kernel services */
  const clock = opts.clock ?? systemClock;
  const events = new EventBus(app.log, { validatePayloads: config.env !== 'production', clock });
  const jobs = await createJobScheduler(app.log, {
    backend: config.jobsBackend,
    timeZone: config.market.timeZone,
    clock,
    connectionString: config.databaseUrl,
    workers: config.jobsEnabled,
    // "on boot" jobs (registries synced from the enabled modules) run again when the deploy or the module set changes
    deployId: createHash('sha256')
      .update([config.deployId ?? '', ...defs.map((d) => `${d.spec.name}@${d.version}`)].join('\n'))
      .digest('hex')
      .slice(0, 16),
  });
  const refs = createRefGenerator(database.kysely, clock, config.market.timeZone);
  // rate-limit windows: in PostgreSQL every instance counts together; ended windows are purged by a kernel job
  const rateLimits = config.rateLimitStore === 'postgres' ? postgresRateLimitStore(database.kysely, clock) : memoryRateLimitStore(clock);
  jobs.declare(PURGE_RATE_LIMITS_JOB);
  jobs.handle('kernel', PURGE_RATE_LIMITS_JOB.name, () => rateLimits.purge());
  for (const spec of Object.values(allSpecs)) registerErrorCodes(spec.name, spec.errorCodes);
  events.registerSpecs(Object.values(allSpecs));

  /* ---------------------------------------------------------------- modules */
  if (config.migrateOnStart) await migrate(database, migrationUnits(defs), (m) => app.log.info(m));
  // modules get permission checks before the auth chain exists (it needs their APIs): bind it late
  let authChain: AuthChain | undefined;
  const can = async (principal: Principal | null | undefined, permission: string) => (authChain ? authChain.canPrincipal(principal, permission) : false);
  const boot = await bootModules(defs, { config, log: app.log, database, clock, events, jobs, refs, rateLimits, can, stubbed: Object.keys(opts.apiStubs ?? {}) });
  for (const w of boot.warnings) app.log.debug(w);
  for (const [m, v] of Object.entries(opts.webhookVerifiers ?? {})) if (!boot.webhookVerifiers.has(m)) boot.webhookVerifiers.set(m, v);
  for (const [m, stub] of Object.entries(opts.apiStubs ?? {})) boot.apis.set(m, withStubs(boot.apis.get(m), stub as object));
  await boot.runAfterBoot();

  /* ---------------------------------------------------------------- authorization: a token on every request, verified here */
  // GET /files/…: the token is the signed link, verified with the serving module's file-link key
  const fileRoute = boot.fileRoutes[0];
  const { auth, revocations } = await createAuthChain({
    fileLinks: fileRoute && { secret: fileLinkSecret(config, fileRoute.module), permanentBuckets: new Set(fileRoute.permanentBuckets) },
    config,
    clock,
    log: app.log,
    db: database.kysely,
    authorities: moduleAuthorities((m) => boot.apis.get(m) as never),
    wrap: opts.authorities,
    webhookVerifiers: boot.webhookVerifiers,
    ownerOnly: new Set(Object.values(allSpecs).flatMap((s) => s.permissions.filter((p) => p.ownerOnly).map((p) => p.key))),
    limits: rateLimits,
  });
  authChain = auth;
  auth.install(app);
  // answers cached by the chain are dropped when their owners announce a change
  for (const name of ['access.role.changed', 'access.coverage.changed', 'access.away.started', 'access.away.ended']) events.subscribe('kernel', name, () => auth.invalidate('permissions'));
  for (const name of ['sellers.member.permissions_changed', 'sellers.member.removed', 'sellers.seller.closed']) events.subscribe('kernel', name, () => auth.invalidate('members'));

  registerEndpoints(app, boot.endpoints, { config, auth, idempotency: postgresIdempotencyStore(database.kysely, clock) });
  if (fileRoute) registerFileRoute(app, fileRoute);
  const graphql = await registerGraphQL(app, {
    config,
    baseTypeDefs,
    fragments: defs.flatMap((d) => (d.graphql ? [{ module: d.spec.name, typeDefs: d.graphql }] : [])),
    resolvers: boot.resolvers,
    auth,
  });
  const unusableQueries = unusablePersistedQueries(graphql);
  for (const q of unusableQueries) app.log.warn(`persisted GraphQL query ${q.area}/${q.name} cannot run with the enabled modules: ${q.errors[0]}`);

  app.decorate('kernel', {
    config,
    database,
    events,
    jobs,
    modules: defs.map((d) => d.spec.name),
    boot,
    auth,
    devSigner: auth.k.keys.dev,
    graphql,
    unusableQueries,
    health: () => ({ status: 'ok' as const, modules: defs.length, launchPhase: config.launchPhase }),
  });
  app.addHook('onReady', async () => {
    revocations.start();
    if (config.jobsEnabled) await jobs.start();
  });
  app.addHook('onClose', async () => {
    revocations.stop();
    await jobs.stop();
    await events.drain();
    if (!opts.database) await database.close();
  });
  return app;
}
