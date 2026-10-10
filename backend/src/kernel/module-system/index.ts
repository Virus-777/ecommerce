/**
 * Module system (architecture §3). A module is a folder with a manifest:
 *
 *   export default defineModule({ spec, version, migrations, graphql, register(ctx) { … } })
 *
 * `spec` is the generated copy of docs/api/spec/modules/<name>.json: name, launch phase,
 * dependencies, permissions, events, jobs, settings and endpoints all come from it.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import type { specs } from '../../spec/index.js';
import type { Config } from '../config/index.js';
import type { Principal } from '../auth/index.js';
import type { Database } from '../db/index.js';
import type { Inbox } from '../events/inbox.js';
import type { AppError } from '../errors/index.js';
import type { ModuleEvents } from '../events/index.js';
import type { ModuleResolvers } from '../graphql/index.js';
import type { RouteSet } from '../http/index.js';
import type { WebhookVerifier } from '../http/register.js';
import type { Clock } from '../lib/clock.js';
import type { RefGenerator } from '../lib/refs.js';
import type { Migration } from '../migrations/index.js';
import type { ModuleSpecDef } from '../spec/define.js';
import type { ModuleDbMap, PublicApiMap } from './public-apis.js';

export type { ModuleDbMap, PublicApiMap };

type Specs = typeof specs;
export type ModuleName = keyof Specs & string;
type SpecOf<N extends ModuleName> = Specs[N];

type DepsOf<N extends ModuleName> = SpecOf<N>['dependsOn'][number] & ModuleName;
type OptionalDepsOf<N extends ModuleName> = SpecOf<N>['optionalDeps'][number] & ModuleName;
type OwnEventsOf<N extends ModuleName> = keyof SpecOf<N>['events']['publishes'] & string;
type ConsumedEventsOf<N extends ModuleName> = keyof SpecOf<N>['events']['consumes'] & string;
type JobsOf<N extends ModuleName> = keyof SpecOf<N>['jobs'] & string;
type SettingsOf<N extends ModuleName> = SpecOf<N>['settings'];
type Widen<T> = T extends number ? number : T extends string ? string : T extends boolean ? boolean : T;
type ApiOf<N> = N extends keyof PublicApiMap ? PublicApiMap[N] : never;
type DbOf<N> = N extends keyof ModuleDbMap ? ModuleDbMap[N] : never;

export interface ModuleContext<N extends ModuleName> {
  readonly name: N;
  readonly spec: SpecOf<N>;
  /** Every module running in this process (settings catalogue, permission registry) */
  readonly modules: readonly ModuleName[];
  readonly config: Config;
  readonly log: FastifyBaseLogger;
  /** Query builder scoped to this module's own schema. Other modules' tables are off limits. */
  readonly db: Kysely<DbOf<N>>;
  /** The whole database (transactions, raw SQL). Use ctx.db for queries. */
  readonly database: Database;
  readonly clock: Clock;
  /** Publish this module's events, subscribe to the events its spec consumes */
  readonly events: ModuleEvents<OwnEventsOf<N>, ConsumedEventsOf<N>>;
  readonly jobs: {
    handle(name: JobsOf<N>, run: () => Promise<unknown>): void;
    runNow(name: JobsOf<N>): Promise<void>;
  };
  /** Runtime settings declared in the spec: value in force from the settings module, else the spec default */
  readonly settings: {
    get<K extends keyof SettingsOf<N> & string>(key: K): Promise<Widen<SettingsOf<N>[K] extends { default: infer D } ? D : unknown>>;
    /** Another module's setting by full key ('reports.maxExportRows'), read-only: the value in force, else that module's spec default */
    read(fullKey: string): Promise<unknown>;
  };
  /** An AppError with this module's status for the code (module codes are scoped; use it instead of new AppError for module codes) */
  error(code: keyof SpecOf<N>['errorCodes'] | (string & {}), message?: string, details?: unknown): AppError;
  /** Idempotent event handling: claim a key in the same transaction as the effects (kernel/events/inbox.ts) */
  readonly inbox: Inbox;
  /**
   * Whether a caller holds a permission, with the same answer their request got (staff through access,
   * seller members through their member access, development tokens through their dev claims). For public
   * API functions that receive the caller's principal from another module (exports, admin reads).
   */
  can(principal: Principal | null | undefined, permission: string): Promise<boolean>;
  /** Human references (MK-YYMMDD-NNNNN …) */
  readonly refs: RefGenerator;
  /** Offer this module's public API to other modules (in-process) */
  provide(api: ApiOf<N>): void;
  /** Public API of a module listed in this module's dependsOn */
  use<D extends DepsOf<N>>(module: D): ApiOf<D>;
  /** Public API of a module listed in optionalDeps; undefined when that module is disabled */
  tryUse<D extends OptionalDepsOf<N>>(module: D): ApiOf<D> | undefined;
  /**
   * Runs once every module has registered and provided its API, before the server takes requests:
   * the place to call other modules at startup (register a report dataset, warm a cache).
   */
  afterBoot(fn: () => Promise<unknown> | unknown): void;
  readonly http: {
    /** Handlers for this module's spec endpoints; every endpoint needs exactly one */
    routes(...sets: RouteSet[]): void;
    /** Verifies provider signatures on this module's webhooks (required when it has webhook endpoints) */
    webhookVerifier(verify: WebhookVerifier): void;
  };
  readonly graphql: {
    resolvers(resolvers: ModuleResolvers): void;
  };
}

export interface ModuleDefinition<S extends ModuleSpecDef = ModuleSpecDef> {
  readonly spec: S;
  /** Bump on every change; shown by npm run modules */
  readonly version: string;
  readonly migrations: Migration[];
  /** GraphQL fragment (graphql/schema.ts), when the module contributes to the read layer */
  readonly graphql?: string;
  register(ctx: ModuleContext<any>): void | Promise<void>;
}

export function defineModule<S extends ModuleSpecDef & { name: ModuleName }>(def: {
  spec: S;
  version: string;
  migrations: Migration[];
  graphql?: string;
  register(ctx: ModuleContext<S['name']>): void | Promise<void>;
}): ModuleDefinition<S> {
  return def as ModuleDefinition<S>;
}
