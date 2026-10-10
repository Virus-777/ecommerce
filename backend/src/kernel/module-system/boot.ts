/**
 * Creates each module's context, runs its register(), and checks the wiring against its spec:
 * every endpoint has a handler, events and jobs are the declared ones, dependencies are used
 * only if declared.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config/index.js';
import type { Database } from '../db/index.js';
import type { Principal } from '../auth/index.js';
import { isAppError, isNotImplemented, moduleError, notImplemented } from '../errors/index.js';
import { moduleInbox } from '../events/inbox.js';
import { moduleEvents, type EventBus } from '../events/index.js';
import type { ModuleResolvers } from '../graphql/index.js';
import type { FileRoute, ModuleFileRoute } from '../http/files.js';
import type { RouteSet } from '../http/index.js';
import { registrationsOf, type EndpointRegistration, type WebhookVerifier } from '../http/register.js';
import type { RateLimitStore } from '../auth/rate-limit.js';
import type { JobScheduler } from '../jobs/index.js';
import type { Clock } from '../lib/clock.js';
import type { RefGenerator } from '../lib/refs.js';
import { schemaOf } from '../migrations/index.js';
import type { ModuleSpecDef } from '../spec/define.js';
import type { ModuleContext, ModuleDefinition, ModuleName } from './index.js';
import { specOf } from './loader.js';

export interface KernelServices {
  config: Config;
  log: FastifyBaseLogger;
  database: Database;
  clock: Clock;
  events: EventBus;
  jobs: JobScheduler;
  refs: RefGenerator;
  /** Business rate limits (ctx.rateLimit), shared by every instance with the postgres store */
  rateLimits: RateLimitStore;
  /** Permission check for an in-process principal (set by the app once the auth chain exists) */
  can(principal: Principal | null | undefined, permission: string): Promise<boolean>;
}

export interface BootResult {
  endpoints: EndpointRegistration[];
  resolvers: Map<string, ModuleResolvers>;
  webhookVerifiers: Map<string, WebhookVerifier>;
  /** Modules serving files at GET /files/… (at most one) */
  fileRoutes: ModuleFileRoute[];
  /** Public APIs provided by enabled modules */
  apis: Map<string, object>;
  warnings: string[];
  /** Runs every module's afterBoot hooks; the app calls it once the APIs are final (tests install apiStubs first) */
  runAfterBoot(): Promise<void>;
}

type AnyApi = Record<string, (...args: unknown[]) => unknown>;

/** Calls a module's public API at call time, so load order never matters; refuses functions its spec doesn't declare. */
function apiProxy(target: string, caller: string, apis: Map<string, object>): object {
  const declared = new Set(specOf(target)!.publicApi);
  const fns = new Map<string, (...args: unknown[]) => unknown>();
  return new Proxy(
    {},
    {
      get(_, fn) {
        if (typeof fn !== 'string' || fn === 'then') return undefined;
        if (!declared.has(fn)) throw new Error(`${caller} calls ${target}.${fn}, which is not in ${target}'s spec publicApi`);
        let call = fns.get(fn);
        if (!call) {
          call = (...args) => {
            const api = apis.get(target) as AnyApi | undefined;
            if (typeof api?.[fn] !== 'function') throw notImplemented(`${target}.${fn}`);
            return api[fn](...args);
          };
          fns.set(fn, call);
        }
        return call;
      },
    },
  );
}

/** Every spec endpoint must have exactly one handler, in the spec's area. */
function checkRoutes(spec: ModuleSpecDef, sets: readonly RouteSet[]) {
  const handled = new Set<string>();
  for (const set of sets) {
    if (set.endpoints !== spec.endpoints) throw new Error(`${spec.name}: routes() was given another module's endpoints`);
    for (const id of Object.keys(set.handlers)) {
      const ep = spec.endpoints[id];
      if (!ep) throw new Error(`${spec.name}: handler "${id}" has no endpoint in the spec`);
      if (ep.area !== set.area) throw new Error(`${spec.name}: handler "${id}" is registered for ${set.area} but the spec puts it in ${ep.area}`);
      if (handled.has(id)) throw new Error(`${spec.name}: endpoint "${id}" has two handlers`);
      handled.add(id);
    }
  }
  const missing = Object.keys(spec.endpoints).filter((id) => !handled.has(id));
  if (missing.length) throw new Error(`${spec.name}: no handler for spec endpoints ${missing.join(', ')}`);
}

export async function bootModules(defs: ModuleDefinition[], k: KernelServices): Promise<BootResult> {
  const enabled = new Set(defs.map((d) => d.spec.name));
  const result: BootResult = { endpoints: [], resolvers: new Map(), webhookVerifiers: new Map(), fileRoutes: [], apis: new Map(), warnings: [], runAfterBoot: async () => {} };
  const { apis, resolvers, webhookVerifiers, warnings } = result;
  const proxies = new Map<string, object>();
  const afterBoot: { module: string; fn: () => unknown }[] = [];
  const modules = defs.map((d) => d.spec.name) as ModuleName[];
  const proxyFor = (target: string, caller: string) => {
    const key = `${caller}>${target}`;
    if (!proxies.has(key)) proxies.set(key, apiProxy(target, caller, apis));
    return proxies.get(key)!;
  };

  for (const { spec } of defs) {
    for (const [job, j] of Object.entries(spec.jobs)) k.jobs.declare({ name: job, module: spec.name, ...j });
  }

  for (const def of defs) {
    const { spec } = def;
    const name = spec.name;
    const sets: RouteSet[] = [];
    let provided = false;
    const ctx: ModuleContext<any> = {
      name,
      spec,
      modules,
      config: k.config,
      log: k.log.child({ module: name }),
      db: k.database.kysely.withSchema(schemaOf(name)),
      database: k.database,
      clock: k.clock,
      events: moduleEvents(k.events, spec),
      jobs: {
        handle: (job: string, run: () => Promise<unknown>) => k.jobs.handle(name, job, run),
        runNow: (job: string) => k.jobs.runNow(job),
      },
      settings: {
        async get(key: string) {
          const declared = spec.settings[key];
          if (!declared) throw new Error(`${name} reads setting ${key}, which is not in its spec settings`);
          const settings = name === 'settings' ? undefined : (apis.get('settings') as { get?: (key: string) => Promise<unknown> } | undefined);
          try {
            const v = await settings?.get?.(`${name}.${key}`);
            if (v != null) return v as never;
          } catch (err) {
            if (!isNotImplemented(err)) throw err; // until the settings module is built, the spec defaults apply
          }
          return declared.default as never;
        },
        async read(fullKey: string) {
          const dot = fullKey.indexOf('.');
          const owner = fullKey.slice(0, dot);
          const declared = specOf(owner)?.settings[fullKey.slice(dot + 1)];
          if (dot < 1 || !declared) throw new Error(`${name} reads setting ${fullKey}, which no module declares`);
          const settings = apis.get('settings') as { get?: (key: string) => Promise<unknown> } | undefined;
          try {
            const v = await settings?.get?.(fullKey);
            if (v != null) return v;
          } catch (err) {
            // settings not built yet, or the owning module is off: the owner's spec default applies
            if (!isNotImplemented(err) && !(isAppError(err) && err.code === 'UNKNOWN_SETTING')) throw err;
          }
          return declared.default;
        },
      },
      refs: k.refs,
      rateLimit: (key: string, l: { limit: number; windowMs: number; peek?: boolean }) => k.rateLimits.hit(name, key, l, { peek: l.peek }),
      inbox: moduleInbox(name),
      can: (principal, permission) => k.can(principal, permission),
      error: moduleError(name),
      provide(api: object) {
        if (provided) throw new Error(`${name} called provide() twice`);
        provided = true;
        apis.set(name, api);
      },
      use(dep: string) {
        if (!spec.dependsOn.includes(dep)) throw new Error(`${name} uses ${dep}, which is not in its spec dependsOn`);
        return proxyFor(dep, name) as never;
      },
      tryUse(dep: string) {
        if (!spec.optionalDeps.includes(dep)) throw new Error(`${name} uses ${dep}, which is not in its spec optionalDeps`);
        return enabled.has(dep) ? (proxyFor(dep, name) as never) : undefined;
      },
      afterBoot: (fn: () => unknown) => afterBoot.push({ module: name, fn }),
      http: {
        routes: (...s: RouteSet[]) => sets.push(...s),
        webhookVerifier: (v: WebhookVerifier) => webhookVerifiers.set(name, v),
        files: (route: FileRoute) => {
          const other = result.fileRoutes.find((r) => r.module !== name);
          if (other) throw new Error(`${name} serves /files, which ${other.module} already serves`);
          result.fileRoutes = [{ ...route, module: name }];
        },
      },
      graphql: {
        resolvers: (r: ModuleResolvers) => resolvers.set(name, { ...resolvers.get(name), ...r }),
      },
    };

    await def.register(ctx);

    checkRoutes(spec, sets);
    result.endpoints.push(...registrationsOf(name, spec.title, sets));
    if (!provided && spec.publicApi.length) warnings.push(`${name} declares a public API in its spec but never calls ctx.provide()`);
    if (Object.values(spec.endpoints).some((e) => e.area === 'webhooks') && !webhookVerifiers.has(name)) {
      warnings.push(`${name} has webhook endpoints but no signature verifier; they answer 401 until it sets one`);
    }
  }

  result.runAfterBoot = async () => {
    for (const { module, fn } of afterBoot.splice(0)) {
      try {
        await fn();
      } catch (err) {
        if (!isNotImplemented(err)) throw new Error(`${module}: afterBoot failed: ${(err as Error).message}`, { cause: err });
        warnings.push(`${module}: afterBoot skipped, a dependency is not built yet (${(err as Error).message})`);
      }
    }
  };
  for (const job of k.jobs.list()) if (!job.handled) warnings.push(`job ${job.name} (${job.module}) has no handler`);
  return result;
}
