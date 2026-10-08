/**
 * Creates each module's context, runs its register(), and checks the wiring against its spec:
 * every endpoint has a handler, events and jobs are the declared ones, dependencies are used
 * only if declared.
 */
import type { FastifyBaseLogger } from 'fastify';
import { specs } from '../../spec/index.js';
import type { Config } from '../config/index.js';
import type { Database } from '../db/index.js';
import { AppError, notImplemented } from '../errors/index.js';
import { moduleEvents, type EventBus } from '../events/index.js';
import type { ModuleResolvers } from '../graphql/index.js';
import type { RouteSet } from '../http/index.js';
import type { EndpointRegistration, WebhookVerifier } from '../http/register.js';
import type { JobScheduler } from '../jobs/index.js';
import type { Clock } from '../lib/clock.js';
import type { RefGenerator } from '../lib/refs.js';
import type { ModuleSpecDef } from '../spec/define.js';
import type { ModuleContext, ModuleDefinition } from './index.js';

export interface KernelServices {
  config: Config;
  log: FastifyBaseLogger;
  database: Database;
  clock: Clock;
  events: EventBus;
  jobs: JobScheduler;
  refs: RefGenerator;
}

export interface BootResult {
  endpoints: EndpointRegistration[];
  resolvers: Map<string, ModuleResolvers>;
  webhookVerifiers: Map<string, WebhookVerifier>;
  /** Public APIs provided by enabled modules */
  apis: Map<string, object>;
  warnings: string[];
}

const allSpecs = specs as unknown as Record<string, ModuleSpecDef>;

/** Proxy that calls a module's public API at call time, so load order never matters for calls. */
function apiProxy(target: string, caller: string, apis: Map<string, object>): object {
  const declared = new Set(allSpecs[target]!.publicApi);
  return new Proxy(
    {},
    {
      get(_, fn) {
        if (typeof fn !== 'string' || fn === 'then') return undefined;
        if (!declared.has(fn)) throw new Error(`${caller} calls ${target}.${fn}, which is not in ${target}'s spec publicApi`);
        return (...args: unknown[]) => {
          const api = apis.get(target) as Record<string, (...a: unknown[]) => unknown> | undefined;
          if (!api || typeof api[fn] !== 'function') throw notImplemented(`${target}.${fn}`);
          return api[fn]!(...args);
        };
      },
    },
  );
}

export async function bootModules(defs: ModuleDefinition[], k: KernelServices): Promise<BootResult> {
  const enabled = new Set(defs.map((d) => d.spec.name));
  const apis = new Map<string, object>();
  const endpoints: EndpointRegistration[] = [];
  const resolvers = new Map<string, ModuleResolvers>();
  const webhookVerifiers = new Map<string, WebhookVerifier>();
  const warnings: string[] = [];

  for (const def of defs) {
    const spec = def.spec;
    const name = spec.name;
    for (const [job, j] of Object.entries(spec.jobs)) k.jobs.declare({ name: job, module: name, schedule: j.schedule, does: j.does });
  }

  for (const def of defs) {
    const spec = def.spec;
    const name = spec.name;
    const sets: RouteSet[] = [];
    let provided = false;
    const log = k.log.child({ module: name });
    const ctx: ModuleContext<any> = {
      name,
      spec,
      config: k.config,
      log,
      db: k.database.kysely.withSchema(name.replace(/-/g, '_')),
      database: k.database,
      clock: k.clock,
      events: moduleEvents(k.events, name, Object.keys(spec.events.publishes), Object.keys(spec.events.consumes)),
      jobs: {
        handle: (job: string, run: () => Promise<unknown>) => k.jobs.handle(name, job, run),
        runNow: (job: string) => k.jobs.runNow(job),
      },
      settings: {
        async get(key: string) {
          const declared = spec.settings[key];
          if (!declared) throw new Error(`${name} reads setting ${key}, which is not in its spec settings`);
          const settings = apis.get('settings') as { get?: (key: string) => Promise<unknown> } | undefined;
          if (settings?.get && name !== 'settings') {
            try {
              const v = await settings.get(`${name}.${key}`);
              if (v !== undefined && v !== null) return v as never;
            } catch (err) {
              // Until the settings module is built, the spec defaults apply
              if (!(err instanceof AppError && err.code === 'NOT_IMPLEMENTED')) throw err;
            }
          }
          return declared.default as never;
        },
      },
      refs: k.refs,
      provide(api: object) {
        if (provided) throw new Error(`${name} called provide() twice`);
        provided = true;
        apis.set(name, api);
      },
      use(dep: string) {
        if (!spec.dependsOn.includes(dep)) throw new Error(`${name} uses ${dep}, which is not in its spec dependsOn`);
        return apiProxy(dep, name, apis) as never;
      },
      tryUse(dep: string) {
        if (!spec.optionalDeps.includes(dep)) throw new Error(`${name} uses ${dep}, which is not in its spec optionalDeps`);
        return enabled.has(dep) ? (apiProxy(dep, name, apis) as never) : undefined;
      },
      http: {
        routes: (...s: RouteSet[]) => sets.push(...s),
        webhookVerifier: (v: WebhookVerifier) => webhookVerifiers.set(name, v),
      },
      graphql: {
        resolvers: (r: ModuleResolvers) => resolvers.set(name, { ...(resolvers.get(name) ?? {}), ...r }),
      },
    };

    await def.register(ctx);

    // every spec endpoint must have exactly one handler
    const handled = new Map<string, RouteSet>();
    for (const set of sets) {
      if (set.endpoints !== spec.endpoints) throw new Error(`${name}: routes() was given another module's endpoints`);
      for (const id of Object.keys(set.handlers)) {
        const ep = spec.endpoints[id];
        if (!ep) throw new Error(`${name}: handler "${id}" has no endpoint in the spec`);
        if (ep.area !== set.area) throw new Error(`${name}: handler "${id}" is registered for ${set.area} but the spec puts it in ${ep.area}`);
        if (handled.has(id)) throw new Error(`${name}: endpoint "${id}" has two handlers`);
        handled.set(id, set);
      }
    }
    const missing = Object.keys(spec.endpoints).filter((id) => !handled.has(id));
    if (missing.length) throw new Error(`${name}: no handler for spec endpoints ${missing.join(', ')}`);
    for (const [id, set] of handled) {
      endpoints.push({ module: name, moduleTitle: spec.title, moduleErrorCodes: spec.errorCodes, id, def: spec.endpoints[id]!, handler: set.handlers[id]! });
    }

    if (!provided && spec.publicApi.length) warnings.push(`${name} declares a public API in its spec but never calls ctx.provide()`);
    if (Object.values(spec.endpoints).some((e) => e.area === 'webhooks') && !webhookVerifiers.has(name)) {
      warnings.push(`${name} has webhook endpoints but no signature verifier; they answer 401 until it sets one`);
    }
  }

  for (const job of k.jobs.list()) if (!job.handled) warnings.push(`job ${job.name} (${job.module}) has no handler`);
  return { endpoints, resolvers, webhookVerifiers, apis, warnings };
}
