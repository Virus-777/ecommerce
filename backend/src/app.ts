/**
 * buildApp(): kernel + enabled modules. Used by main.ts, the tests and the check tools.
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { devAuthenticator, moduleAuthenticator } from './kernel/auth/authenticators.js';
import type { Authenticator } from './kernel/auth/index.js';
import { loadConfig, type Config } from './kernel/config/index.js';
import { createDatabase, type Database } from './kernel/db/index.js';
import { registerErrorCodes } from './kernel/errors/index.js';
import { EventBus } from './kernel/events/index.js';
import { registerGraphQL, unusablePersistedQueries } from './kernel/graphql/index.js';
import { postgresIdempotencyStore } from './kernel/http/idempotency.js';
import { createOpenApiObjectTransform, createOpenApiTransform } from './kernel/http/openapi.js';
import { registerEndpoints } from './kernel/http/register.js';
import { createServer } from './kernel/http/server.js';
import { JobScheduler } from './kernel/jobs/index.js';
import { systemClock, type Clock } from './kernel/lib/clock.js';
import { createRefGenerator } from './kernel/lib/refs.js';
import { migrate } from './kernel/migrations/index.js';
import { bootModules, type BootResult } from './kernel/module-system/boot.js';
import { loadDefinitions } from './kernel/module-system/loader.js';
import { enabledModules } from './modules.config.js';
import { moduleLoaders } from './modules/index.js';
import * as common from './spec/common.js';
import { baseTypeDefs } from './spec/graphql.js';
import { specs } from './spec/index.js';

export interface BuildOptions {
  /** Environment to read the config from (default process.env) */
  env?: Record<string, string | undefined>;
  config?: Partial<Config>;
  /** Modules to run (default: MODULES env, else src/modules.config.ts) */
  modules?: string[];
  /** Bring your own database (tests share one); otherwise created from the config and closed with the app */
  database?: Database;
  clock?: Clock;
  /** Wrap the authenticator (tests) */
  authenticator?: (base: Authenticator) => Authenticator;
}

export interface Kernel {
  config: Config;
  database: Database;
  events: EventBus;
  jobs: JobScheduler;
  modules: string[];
  boot: BootResult;
  graphql: Awaited<ReturnType<typeof registerGraphQL>>;
  /** Persisted screen queries that select fields of a disabled module */
  unusableQueries: ReturnType<typeof unusablePersistedQueries>;
}

declare module 'fastify' {
  interface FastifyInstance {
    kernel: Kernel;
  }
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig(opts.env ?? process.env, opts.config);
  const app = createServer(config);

  /* ---------------------------------------------------------------- OpenAPI at /docs (generated from the same Zod schemas) */
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: common.info.title, version: common.info.version, description: common.info.description },
      servers: common.servers,
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', description: common.headers.Authorization },
          guestSession: { type: 'apiKey', in: 'header', name: 'X-Guest-Session' },
          webhookSignature: { type: 'apiKey', in: 'header', name: 'X-Signature', description: 'Provider signature, verified per provider' },
        },
      },
    },
    transform: createOpenApiTransform(common.apiTypes, ['/docs', '/health']) as never,
    transformObject: createOpenApiObjectTransform(common.apiTypes) as never,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  /* ---------------------------------------------------------------- kernel services */
  const database = opts.database ?? (await createDatabase({ url: config.databaseUrl, pgliteDir: config.pgliteDir }));
  const clock = opts.clock ?? systemClock;
  const events = new EventBus(app.log, { validatePayloads: config.env !== 'production' });
  const jobs = new JobScheduler(app.log, config.market.timeZone);
  const refs = createRefGenerator(database.kysely, clock, config.market.timeZone);
  for (const spec of Object.values(specs)) {
    registerErrorCodes(spec.errorCodes);
    for (const [name, e] of Object.entries(spec.events.publishes)) events.registerSchema(name, (e as { payload: () => never }).payload);
  }

  /* ---------------------------------------------------------------- modules */
  const enabled = opts.modules ?? config.modules ?? enabledModules;
  const defs = await loadDefinitions(enabled, moduleLoaders);
  if (config.migrateOnStart) {
    await migrate(
      database,
      defs.map((d) => ({ module: d.spec.name, schema: d.spec.name.replace(/-/g, '_'), migrations: d.migrations })),
      (m) => app.log.info(m),
    );
  }
  const boot = await bootModules(defs, { config, log: app.log, database, clock, events, jobs, refs });
  for (const w of boot.warnings) app.log.debug(w);

  const lookup = (m: 'identity' | 'access' | 'sellers') => (boot.apis.has(m) ? boot.apis.get(m) : undefined);
  let authenticator: Authenticator = moduleAuthenticator(lookup);
  if (config.devTokens) authenticator = devAuthenticator(config.devTokenSecret, authenticator);
  if (opts.authenticator) authenticator = opts.authenticator(authenticator);

  registerEndpoints(app, boot.endpoints, { config, authenticator, idempotency: postgresIdempotencyStore(database.kysely), webhookVerifiers: boot.webhookVerifiers });
  const graphql = await registerGraphQL(app, {
    config,
    baseTypeDefs,
    fragments: defs.filter((d) => d.graphql).map((d) => ({ module: d.spec.name, typeDefs: d.graphql! })),
    resolvers: boot.resolvers,
    authenticator,
  });
  const unusableQueries = unusablePersistedQueries(graphql);
  for (const q of unusableQueries) app.log.warn(`persisted GraphQL query ${q.area}/${q.name} cannot run with the enabled modules: ${q.errors[0]}`);

  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok', modules: defs.length, launchPhase: config.launchPhase }));

  app.decorate('kernel', { config, database, events, jobs, modules: defs.map((d) => d.spec.name), boot, graphql, unusableQueries });
  app.addHook('onReady', async () => {
    if (config.jobsEnabled) jobs.start();
  });
  app.addHook('onClose', async () => {
    jobs.stop();
    await events.drain();
    if (!opts.database) await database.close();
  });
  return app;
}
