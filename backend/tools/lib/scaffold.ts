/**
 * Hand-written module files, created once by `npm run gen` / `npm run module:new` when missing.
 * After that they belong to the developer; the generator never overwrites them.
 */
import { eventTypeName } from './emit.js';
import { migrationSql, planTables } from './sql.js';
import { camel, pascal, snake, type ModuleSpec } from './spec.js';
import { translateSignature, TypeContext } from './types.js';

const AREA_TITLES: Record<string, string> = { store: 'Store API', seller: 'Seller API', admin: 'Admin API', public: 'Public API', webhooks: 'Webhooks' };
const AREA_PREFIX: Record<string, string> = { store: '/api/store', seller: '/api/seller', admin: '/api/admin', public: '/api/public', webhooks: '/webhooks' };

const handlerName = (event: string) => `on${event.split('.').slice(1).map((p) => pascal(p.replace(/_/g, '-'))).join('')}From${pascal(event.split('.')[0]!)}`;
const jobMethod = (job: string) => camel(job.split('.').slice(1).join('-').replace(/[^a-z0-9-]/gi, '-'));
const oneLine = (s: string) => s.replace(/\s+/g, ' ').replace(/\*\//g, '* /');

export function areasOf(mod: ModuleSpec) {
  return ['store', 'seller', 'admin', 'public', 'webhooks'].filter((a) => mod.endpoints.some((e) => e.area === a));
}

export function scaffoldFiles(mod: ModuleSpec, ctxFactory: () => TypeContext, hasFragment: boolean, sourceFragments: { field: string; fn: string }[]): Record<string, string> {
  const P = pascal(mod.name);
  const n = mod.name;
  const files: Record<string, string> = {};
  const areas = areasOf(mod);
  const consumes = mergeConsumes(mod);
  const jobs = mod.jobs ?? [];

  /* ---------------- module.ts */
  files['module.ts'] = `import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/${n}.js';
${hasFragment ? `import { resolvers } from './graphql/resolvers.js';\nimport { typeDefs } from './graphql/schema.js';\n` : ''}${areas.map((a) => `import { ${a}Routes } from './http/${a}.js';`).join('\n')}
import { migrations } from './infra/postgres/migrations/index.js';
import { createPostgres${P}Repository } from './infra/postgres/repository.js';
import { ${P}Service } from './service.js';

/**
 * ${mod.title}: ${oneLine(mod.summary)}
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/${n}.json through \`spec\`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '0.1.0',
  migrations,${hasFragment ? '\n  graphql: typeDefs,' : ''}
  register(ctx) {
    const repo = createPostgres${P}Repository(ctx.db);
    const service = new ${P}Service({ repo, ctx });
    ctx.provide(service);
    ctx.http.routes(${areas.map((a) => `${a}Routes(service)`).join(', ')});${hasFragment ? '\n    ctx.graphql.resolvers(resolvers(service));' : ''}
${consumes.length ? `\n    // Events this module reacts to (spec events.consumes)\n${consumes.map((c) => `    ctx.events.on(${JSON.stringify(c.name)}, (e) => service.${handlerName(c.name)}(e.payload));`).join('\n')}\n` : ''}${jobs.length ? `\n    // Background jobs (spec jobs)\n${jobs.map((j) => `    ctx.jobs.handle(${JSON.stringify(j.name)}, () => service.${jobMethod(j.name)}());`).join('\n')}\n` : ''}  },
});
`;

  /* ---------------- contract.ts */
  files['contract.ts'] = `/**
 * Public surface of the ${n} module: the ONLY file other modules may import from this folder
 * (\`npm run check:boundaries\`). Types, event payloads and the public API come from the spec.
 */
export type { ${P}PublicApi } from '../../spec/${n}.js';
export type * from '../../spec/${n}.js';
`;

  /* ---------------- permissions.ts */
  files['permissions.ts'] = `/** Permission keys and approval actions this module declares (spec permissions, approvalActions). */
import { spec } from '../../spec/${n}.js';

export const permissions = spec.permissions;
export const approvalActions = spec.approvalActions;
`;

  /* ---------------- ports.ts */
  const tableNames = (mod.tables ?? []).map((t) => `${snake(n)}.${t.name}`);
  files['ports.ts'] = `/**
 * What the ${n} service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: ${tableNames.length ? tableNames.join(', ') : '(none)'}. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ${P}Repository {}
`;

  /* ---------------- infra/postgres */
  files['infra/postgres/repository.ts'] = `import type { Kysely } from 'kysely';
import type { ${P}Db } from '../../../../spec/${n}.js';
import type { ${P}Repository } from '../../ports.js';

/** Postgres adapter for ${P}Repository. \`db\` is scoped to the \`${snake(n)}\` schema. */
export function createPostgres${P}Repository(db: Kysely<${P}Db>): ${P}Repository {
  void db;
  return {};
}
`;
  const problems: string[] = [];
  const plans = planTables(mod, problems);
  const sql = migrationSql(mod, plans, problems);
  files['infra/postgres/migrations/0001_init.ts'] = `import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/${n}.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ \`
${sql.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}
\`,
};
`;
  files['infra/postgres/migrations/index.ts'] = `import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init];
`;

  /* ---------------- domain */
  const machines = mod.stateMachines ?? [];
  files['domain/state-machines.ts'] = machines.length
    ? `/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/${n}.js';
${machines.map((m) => `\n/** ${oneLine(m.name)}: ${m.field}${m.notes ? `. ${oneLine(m.notes)}` : ''} */\nexport const ${camel(m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))}Machine = createStateMachine(${JSON.stringify(m.name)}, spec.stateMachines[${JSON.stringify(m.name)}]);`).join('\n')}
`
    : `/** This module declares no status flows in its spec. */\nexport {};\n`;

  /* ---------------- service.ts */
  const tctx = ctxFactory();
  const apiMethods = (mod.publicApi ?? []).map((f) => {
    const s = translateSignature(f.signature, tctx, `${n}.publicApi.${f.name}`);
    return `  /** ${oneLine(f.desc)} */\n  async ${f.name}${s.generics}(${s.params}): Promise<${s.returns}> {\n    throw notImplemented('${n}.${f.name}');\n  }`;
  });
  const imports = [...tctx.imports].filter((m) => m !== n).sort();
  const consumeMethods = consumes.map((c) => `  /** ${c.name}: ${oneLine(c.does)} */\n  async ${handlerName(c.name)}(event: EventPayload<${JSON.stringify(c.name)}>): Promise<void> {\n    void event;\n    throw notImplemented('${n} consumer of ${c.name}');\n  }`);
  const jobMethods = jobs.map((j) => `  /** Job ${j.name} (${oneLine(j.schedule)}): ${oneLine(j.does)} */\n  async ${jobMethod(j.name)}(): Promise<void> {\n    throw notImplemented('job ${j.name}');\n  }`);
  files['service.ts'] = `import { notImplemented } from '../../kernel/errors/index.js';
${consumes.length ? `import type { EventPayload } from '../../kernel/events/index.js';\n` : ''}import type { ModuleContext } from '../../kernel/module-system/index.js';
${imports.map((m) => (m === 'common' ? `import type * as common from '../../spec/common.js';` : `import type * as ${camel(m)} from '../../spec/${m}.js';`)).join('\n')}
import type { ${[`${P}PublicApi`, ...Object.keys(mod.types ?? {}).filter((t) => apiMethods.some((x) => new RegExp(`\\b${t}\\b`).test(x)))].join(', ')} } from '../../spec/${n}.js';
import type { ${P}Repository } from './ports.js';

export interface ${P}ServiceDeps {
  repo: ${P}Repository;
  ctx: ModuleContext<'${n}'>;
}

/**
 * ${mod.title} use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/${n}.json.
 */
export class ${P}Service implements ${P}PublicApi {
  readonly #deps: ${P}ServiceDeps;

  constructor(deps: ${P}ServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): ${P}ServiceDeps {
    return this.#deps;
  }
${apiMethods.length ? `\n  /* ---------------- public API (in-process) */\n\n${apiMethods.join('\n\n')}\n` : ''}${consumeMethods.length ? `\n  /* ---------------- events consumed */\n\n${consumeMethods.join('\n\n')}\n` : ''}${jobMethods.length ? `\n  /* ---------------- jobs */\n\n${jobMethods.join('\n\n')}\n` : ''}}
`;

  /* ---------------- http/<area>.ts */
  for (const area of areas) {
    const eps = mod.endpoints.filter((e) => e.area === area);
    files[`http/${area}.ts`] = `import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/${n}.js';
import type { ${P}Service } from '../service.js';

/**
 * ${AREA_TITLES[area]}: ${AREA_PREFIX[area]}/${n}/…  (docs/api/modules/${n}.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const ${area}Routes = (service: ${P}Service) => {
  void service;
  return routes(endpoints, '${area}', {
${eps.map((e) => `    /** ${e.method} ${e.path}: ${oneLine(e.summary)} */\n    ${e.id}: notImplemented,`).join('\n')}
  });
};
`;
  }

  /* ---------------- graphql */
  if (hasFragment) {
    files['graphql/resolvers.ts'] = `import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { ${P}Service } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (\`@source(module: "${n}", …)\` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
${sourceFragments.length ? ` *\n * Fields to resolve:\n${sourceFragments.map((s) => ` *   ${s.field} → service.${s.fn}`).join('\n')}\n` : ''} */
export const resolvers = (service: ${P}Service): ModuleResolvers => {
  void service;
  return {};
};
`;
  }

  /* ---------------- test */
  files[`${n}.test.ts`] = `import { describeModule } from '../../testing/module-suite.js';

// Boots ${n} with its dependencies on in-memory PostgreSQL and checks it against its spec:
// routes, auth, tables and wiring. Add behaviour tests below as the module is built.
describeModule('${n}');
`;
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v])) as Record<string, string> & { problems?: never };
}

/** One handler per consumed event, even when the spec lists an event twice with two reactions. */
export function mergeConsumes(mod: ModuleSpec) {
  const byName = new Map<string, string[]>();
  for (const c of mod.events?.consumes ?? []) byName.set(c.name, [...(byName.get(c.name) ?? []), c.does]);
  return [...byName].map(([name, does]) => ({ name, does: does.join(' Also: ') }));
}

export { handlerName, jobMethod, eventTypeName };
