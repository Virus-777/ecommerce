/**
 * buildApp(): kernel + enabled modules. Used by main.ts, the tests and the check tools.
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { moduleAuthorities, type Authorities } from './kernel/auth/authorities.js';
import { mongoWebhookEventLog, mysqlWebhookEventLog, REFRESH_COOKIE_AUDIENCES, refreshCookieName, refreshCookieScheme, refreshCookieText, type AuthChain, type WebhookVerifier } from './kernel/auth/chain.js';
import { memoryRateLimitStore, mongoRateLimitStore, mysqlRateLimitStore, PURGE_RATE_LIMITS_JOB } from './kernel/auth/rate-limit.js';
import { fileLinkSecret } from './kernel/auth/file-links.js';
import { createAuthChain } from './kernel/auth/setup.js';
import type { Principal } from './kernel/auth/index.js';
import type { KeyRing } from './kernel/auth/tokens.js';
import { loadConfig, type Config } from './kernel/config/index.js';
import { registerErrorCodes } from './kernel/errors/index.js';
import { EventBus } from './kernel/events/index.js';
import { registerGraphQL, unusablePersistedQueries } from './kernel/graphql/index.js';
import { installCompression } from './kernel/http/compression.js';
import { registerDevRoutes } from './kernel/http/dev-routes.js';
import { registerFileRoutes } from './kernel/http/files.js';
import { mongoIdempotencyStore, mysqlIdempotencyStore, type IdempotencyStore } from './kernel/http/idempotency.js';
import { createOpenApiObjectTransform, createOpenApiTransform } from './kernel/http/openapi.js';
import { registerEndpoints } from './kernel/http/register.js';
import { createServer } from './kernel/http/server.js';
import type { PublicApiMap } from './kernel/module-system/public-apis.js';
import { createJobScheduler, type JobScheduler } from './kernel/jobs/index.js';
import { systemClock, type Clock } from './kernel/lib/clock.js';
import { mongoRefGenerator, mysqlRefGenerator, type RefGenerator } from './kernel/lib/refs.js';
import { connectMongo, type MongoStore } from './kernel/mongo/index.js';
import { migrateMongo, mongoUnits } from './kernel/mongo/schema.js';
import { connectMysql, type MysqlStore } from './kernel/mysql/index.js';
import { purgeExpired, purgeSummary, PURGE_EXPIRED_JOB } from './kernel/mysql/purge.js';
import { migrateMysql } from './kernel/mysql/schema.js';
import { bootModules, type BootResult } from './kernel/module-system/boot.js';
import { allSpecs, loadDefinitions } from './kernel/module-system/loader.js';
import { enabledModules } from './modules.config.js';
import { graphqlFragments, moduleLoaders, mysqlSchemas } from './modules/index.js';
import * as common from './spec/common.js';
import { baseTypeDefs } from './spec/graphql.js';

export interface BuildOptions {
  /** Environment to read the config from (default process.env) */
  env?: Record<string, string | undefined>;
  config?: Partial<Config>;
  /** Modules to run (default: MODULES env, else src/modules.config.ts) */
  modules?: string[];
  /** Bring your own MongoDB store (tests; two apps given one store share its database); otherwise connected from the config (MONGODB_URI, or an embedded replica set) and closed with the app */
  mongo?: MongoStore;
  /** Bring your own MySQL store (tests); otherwise connected from MYSQL_URL when MYSQL_MODULES names a module, and closed with the app */
  mysql?: MysqlStore;
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
  mongo: MongoStore;
  /** Where this process has one; tests reach a MySQL module's tables through it, as they do ctx.mongo (§10.6) */
  mysql?: MysqlStore;
  events: EventBus;
  jobs: JobScheduler;
  /** The kernel's own stores as KERNEL_STORE chose them (docs/10 §12), so the boot's choice can be seen and used */
  refs: RefGenerator;
  idempotency: IdempotencyStore;
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
  // the same answers in fewer bytes (kernel/http/compression.ts); installed before the routes below, which is
  // how the plugin reaches them
  await installCompression(app, config);

  // independent startup work runs in parallel: the database connection and the module imports
  const [mongo, defs] = await Promise.all([
    opts.mongo ?? connectMongo({ uri: config.mongo.uri, dataDir: config.mongo.dataDir, port: config.mongo.port, watch: { log: app.log, slowMs: config.mongo.slowTransactionMs } }),
    loadDefinitions(opts.modules ?? config.modules ?? enabledModules, moduleLoaders),
  ]);

  // MySQL, for the modules whose data has moved and for the kernel's own data where KERNEL_STORE says so
  // (docs/10 §12, §23 Y1). Nothing pointed there, no connection: a process that needs none opens none, which
  // is what keeps the two databases side by side rather than both required.
  const kernelOnMysql = config.kernelStore === 'mysql';
  // what points the kernel's own data there, for the error below. A module named in MYSQL_MODULES also needs a
  // connection, but it is bootModules that refuses that one, naming the module (§10.5a)
  const kernelAskedBy = [
    kernelOnMysql ? 'KERNEL_STORE=mysql' : '',
    config.jobsBackend === 'mysql' ? 'JOBS_BACKEND=mysql' : '',
    config.rateLimitStore === 'mysql' ? 'RATE_LIMIT_STORE=mysql' : '',
  ].filter(Boolean);
  const mysql =
    opts.mysql ??
    ((config.mysqlModules.length || kernelAskedBy.length) && config.mysql
      ? await connectMysql({ url: config.mysql.url, poolSize: config.mysql.poolSize, watch: { log: app.log, slowMs: config.mysql.slowTransactionMs } })
      : undefined);
  const mysqlDb = (): MysqlStore => {
    if (!mysql) throw new Error(`${kernelAskedBy.join(' and ')} keeps the kernel's data in MySQL, but MYSQL_URL is not set`);
    return mysql;
  };
  // asked for it, got no connection: stop here, naming the setting. Left to fail where the store is first used
  // it would come out of the job scheduler or of the auth chain's first rate-limit check, as something else
  if (kernelAskedBy.length) mysqlDb();
  // The eleven kernel tables are the kernel's own prerequisite, not a schema migration: a module's table
  // missing means `npm run migrate` was not run, while a kernel table missing means nothing works at all.
  // Eleven IF NOT EXISTS statements, whichever way MIGRATE_ON_START is set.
  if (mysql) await mysql.createKernelTables();

  /* ---------------------------------------------------------------- OpenAPI (generated from the same Zod schemas); Swagger UI in development */
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: common.info,
      servers: common.servers,
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', description: common.headers.Authorization },
          ...Object.fromEntries(REFRESH_COOKIE_AUDIENCES.map((a) => [refreshCookieScheme(a), { type: 'apiKey', in: 'cookie', name: refreshCookieName(a), description: refreshCookieText(a) }])),
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
    mongo,
    mysql,
    workers: config.jobsEnabled,
    // "on boot" jobs (registries synced from the enabled modules) run again when the deploy or the module set changes
    deployId: createHash('sha256')
      .update([config.deployId ?? '', ...defs.map((d) => `${d.spec.name}@${d.version}`)].join('\n'))
      .digest('hex')
      .slice(0, 16),
  });
  const refs = kernelOnMysql ? mysqlRefGenerator(mysqlDb(), clock, config.market.timeZone) : mongoRefGenerator(mongo, clock, config.market.timeZone);
  // rate-limit windows: in a database every instance counts together; ended windows are purged by a kernel job
  const rateLimits =
    config.rateLimitStore === 'mysql' ? mysqlRateLimitStore(mysqlDb(), clock) : config.rateLimitStore === 'mongo' ? mongoRateLimitStore(mongo, clock) : memoryRateLimitStore(clock);
  jobs.declare(PURGE_RATE_LIMITS_JOB);
  jobs.handle('kernel', PURGE_RATE_LIMITS_JOB.name, () => rateLimits.purge());
  // MongoDB expired its own rows with TTL indexes; MySQL has nothing of the kind, so one kernel job deletes
  // them in batches (§12). Declared wherever this process has MySQL at all, not only with the kernel there:
  // finished job runs and claimed event keys start landing in those tables as soon as anything does.
  if (mysql) {
    jobs.declare(PURGE_EXPIRED_JOB);
    jobs.handle('kernel', PURGE_EXPIRED_JOB.name, async () => app.log.info(purgeSummary(await purgeExpired(mysql, clock))));
  }
  for (const spec of Object.values(allSpecs)) registerErrorCodes(spec.name, spec.errorCodes);
  events.registerSpecs(Object.values(allSpecs));

  /* ---------------------------------------------------------------- modules */
  if (config.migrateOnStart) {
    // the kernel's and every module's collections, validators and indexes, then pending data migrations
    await migrateMongo(mongo, mongoUnits(defs), (m) => app.log.info(m));
    // and, for the modules on MySQL, their tables there. Only theirs: a table of a module still on MongoDB
    // has no business being created, and migrate reports anything in the database that no unit claims.
    if (mysql) {
      const units = await Promise.all(
        defs.filter((d) => config.mysqlModules.includes(d.spec.name)).map(async (d) => (await mysqlSchemas[d.spec.name as keyof typeof mysqlSchemas]!()).unit),
      );
      await migrateMysql(mysql, units, (m) => app.log.info(m));
    }
  }
  // modules get permission checks before the auth chain exists (it needs their APIs): bind it late
  let authChain: AuthChain | undefined;
  const can = async (principal: Principal | null | undefined, permission: string) => (authChain ? authChain.canPrincipal(principal, permission) : false);
  const boot = await bootModules(defs, { config, log: app.log, mongo, mysql, clock, events, jobs, refs, rateLimits, can, stubbed: Object.keys(opts.apiStubs ?? {}) });
  for (const w of boot.warnings) app.log.debug(w);
  for (const [m, v] of Object.entries(opts.webhookVerifiers ?? {})) if (!boot.webhookVerifiers.has(m)) boot.webhookVerifiers.set(m, v);
  for (const [m, stub] of Object.entries(opts.apiStubs ?? {})) boot.apis.set(m, withStubs(boot.apis.get(m), stub as object));
  await boot.runAfterBoot();

  /* ---------------------------------------------------------------- authorization: a token on every request, verified here */
  // GET /files/…: the token is the signed link, verified with the serving module's file-link key
  const fileRoutes = boot.fileRoutes;
  const fileRouteOf = (bucket: string) => fileRoutes.find((r) => r.buckets?.includes(bucket)) ?? fileRoutes.find((r) => !r.buckets);
  const { auth, revocations } = await createAuthChain({
    fileLinks: fileRoutes.length
      ? {
          secret: (bucket) => {
            const r = fileRouteOf(bucket);
            return r && fileLinkSecret(config, r.module);
          },
          permanentBuckets: new Set(fileRoutes.flatMap((r) => r.permanentBuckets)),
        }
      : undefined,
    config,
    clock,
    log: app.log,
    webhookEvents: kernelOnMysql ? mysqlWebhookEventLog(mysqlDb()) : mongoWebhookEventLog(mongo),
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

  const idempotency = kernelOnMysql ? mysqlIdempotencyStore(mysqlDb(), clock) : mongoIdempotencyStore(mongo, clock);
  registerEndpoints(app, boot.endpoints, { config, auth, idempotency, sessionCookie: boot.sessionCookie });
  registerFileRoutes(app, fileRoutes);
  // test tooling under /api/dev: only with development tokens (never in production), hidden from OpenAPI
  if (config.devTokens) registerDevRoutes(app, boot.devRoutes);
  const graphql = await registerGraphQL(app, {
    config,
    baseTypeDefs,
    // every module's fragment, on or off: screen queries stay valid and fields of modules that are off answer null
    fragments: await Promise.all(Object.entries(graphqlFragments).map(async ([module, load]) => ({ module, typeDefs: (await load()).typeDefs }))),
    enabledModules: new Set(defs.map((d) => d.spec.name)),
    resolvers: boot.resolvers,
    auth,
  });
  const unusableQueries = unusablePersistedQueries(graphql);
  for (const q of unusableQueries) app.log.warn(`persisted GraphQL query ${q.area}/${q.name} cannot run with the enabled modules: ${q.errors[0]}`);

  app.decorate('kernel', {
    config,
    mongo,
    mysql,
    events,
    jobs,
    refs,
    idempotency,
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
    if (!opts.mongo) await mongo.close();
    if (mysql && !opts.mysql) await mysql.close();
  });
  return app;
}
