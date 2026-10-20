/**
 * Hand-written module files, created once by `npm run gen` / `npm run module:new` when missing.
 * After that they belong to the developer; the generator never overwrites them.
 * Each file is a thunk, so content is only built for files that are actually missing.
 */
import { camel, commentText, doc, mergeConsumes, pascal, pascalWords, type CommonSpec, type ModuleSpec } from './spec.js';
import { translateSignature, type TypeContext } from './types.js';

const handlerName = (event: string) => {
  const [source, ...rest] = event.split('.');
  return `on${pascalWords(rest.join('.'))}From${pascal(source!)}`;
};
const jobMethod = (job: string) => camel(job.split('.').slice(1).join('-').replace(/[^a-z0-9-]/gi, '-'));
const machineName = (name: string) => `${camel(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))}Machine`;

export interface ScaffoldInput {
  mod: ModuleSpec;
  common: CommonSpec;
  types: TypeContext;
  hasFragment: boolean;
  /** GraphQL fields this module resolves: Type.field → publicApi function */
  sourceFields: { field: string; fn: string }[];
}

export function scaffoldFiles({ mod, common, types, hasFragment, sourceFields }: ScaffoldInput): Record<string, () => string> {
  const P = pascal(mod.name);
  const n = mod.name;
  const areas = Object.keys(common.areas).filter((a) => mod.endpoints.some((e) => e.area === a));
  const consumes = mergeConsumes(mod);
  const jobs = mod.jobs ?? [];
  const files: Record<string, () => string> = {};

  files['module.ts'] = () => {
    const wiring = [
      ...(consumes.length ? ['', '// Events this module reacts to (spec events.consumes)', ...consumes.map((c) => `ctx.events.on(${JSON.stringify(c.name)}, (e) => service.${handlerName(c.name)}(e.payload));`)] : []),
      ...(jobs.length ? ['', '// Background jobs (spec jobs)', ...jobs.map((j) => `ctx.jobs.handle(${JSON.stringify(j.name)}, () => service.${jobMethod(j.name)}());`)] : []),
    ];
    return `import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/${n}.js';
${hasFragment ? `import { resolvers } from './graphql/resolvers.js';\n` : ''}${areas.map((a) => `import { ${a}Routes } from './http/${a}.js';`).join('\n')}
import { ${P}Repository } from './repository.js';
import { schemas } from './schema.js';
import { ${P}Service } from './service.js';

/**
 * ${mod.title}: ${commentText(mod.summary)}
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/${n}.json through \`spec\`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '0.1.0',
  schemas,
  register(ctx) {
    const service = new ${P}Service({ repo: new ${P}Repository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(${areas.map((a) => `${a}Routes(service)`).join(', ')});${hasFragment ? '\n    ctx.graphql.resolvers(resolvers(service));' : ''}${wiring.map((l) => (l ? `\n    ${l}` : '\n')).join('')}
  },
});
`;
  };

  files['contract.ts'] = () => `/**
 * Public surface of the ${n} module: the ONLY file other modules may import from this folder
 * (\`npm run check:boundaries\`). Types, event payloads and the public API come from the spec.
 */
export type * from '../../spec/${n}.js';
`;

  files['repository.ts'] = () => {
    const tables = (mod.tables ?? []).map((t) => `${n}.${t.name}`);
    return `import type { ModuleStore } from '../../kernel/mongo/index.js';

/**
 * The ${n} module's collections: ${tables.join(', ') || '(none)'}. One Table per spec table
 * (store.table(name)); the kernel helpers are listed in backend/docs/BUILDING-MODULES.md §5b.
 */
export class ${P}Repository {
  constructor(private readonly store: ModuleStore) {}

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: ${P}Repository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new ${P}Repository(tx)));
  }
}
`;
  };

  files['domain/state-machines.ts'] = () => {
    const machines = mod.stateMachines ?? [];
    if (!machines.length) return `/** This module declares no status flows in its spec. */\nexport {};\n`;
    return `/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/${n}.js';
${machines.map((m) => `\n${doc(`${m.name}: ${m.field}${m.notes ? `. ${m.notes}` : ''}`)}export const ${machineName(m.name)} = createStateMachine(${JSON.stringify(m.name)}, spec.stateMachines[${JSON.stringify(m.name)}]);`).join('\n')}
`;
  };

  /** A stub's parameters, each named _name: they are unused until the method is built (tsc noUnusedParameters) */
  const unusedParams = (params: string) => {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= params.length; i++) {
      const c = params[i];
      if (c === '{' || c === '<' || c === '(' || c === '[') depth++;
      else if (c === '}' || (c === '>' && params[i - 1] !== '=') || c === ')' || c === ']') depth--;
      else if ((c === ',' && depth === 0) || i === params.length) {
        const one = params.slice(start, i).trim();
        if (one) out.push(one.replace(/^(\.\.\.)?([A-Za-z]\w*)/, '$1_$2'));
        start = i + 1;
      }
    }
    return out.join(', ');
  };

  files['service.ts'] = () => {
    const methods = (title: string, list: string[]) => (list.length ? `\n  /* ---------------- ${title} */\n\n${list.join('\n\n')}\n` : '');
    const stub = (what: string) => `{\n    throw notImplemented(${JSON.stringify(what)});\n  }`;
    const api = (mod.publicApi ?? []).map((f) => {
      const s = translateSignature(f.signature, types, `${n}.publicApi.${f.name}`);
      return `${doc(f.desc, '  ')}  async ${f.name}${s.generics}(${unusedParams(s.params)}): Promise<${s.returns}> ${stub(`${n}.${f.name}`)}`;
    });
    const consumers = consumes.map((c) => `${doc(`${c.name}: ${c.does}`, '  ')}  async ${handlerName(c.name)}(_event: EventPayload<${JSON.stringify(c.name)}>): Promise<void> ${stub(`${n} consumer of ${c.name}`)}`);
    const jobMethods = jobs.map((j) => `${doc(`Job ${j.name} (${j.schedule}): ${j.does}`, '  ')}  async ${jobMethod(j.name)}(): Promise<void> ${stub(`job ${j.name}`)}`);
    const ownTypes = Object.keys(mod.types ?? {}).filter((t) => api.some((x) => new RegExp(`\\b${t}\\b`).test(x)));
    const specImports = [...types.imports].filter((m) => m !== n).sort();
    return `import { notImplemented } from '../../kernel/errors/index.js';
${consumes.length ? `import type { EventPayload } from '../../kernel/events/index.js';\n` : ''}import type { ModuleContext } from '../../kernel/module-system/index.js';
${specImports.map((m) => `import type * as ${camel(m)} from '../../spec/${m}.js';\n`).join('')}import type { ${[`${P}PublicApi`, ...ownTypes].join(', ')} } from '../../spec/${n}.js';
import type { ${P}Repository } from './repository.js';

export interface ${P}ServiceDeps {
  repo: ${P}Repository;
  ctx: ModuleContext<'${n}'>;
}

/**
 * ${mod.title} use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/${n}.json.
 */
export class ${P}Service implements ${P}PublicApi {
  constructor(protected readonly deps: ${P}ServiceDeps) {}
${methods('public API (in-process)', api)}${methods('events consumed', consumers)}${methods('jobs', jobMethods)}}
`;
  };

  for (const area of areas) {
    files[`http/${area}.ts`] = () => `import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/${n}.js';
import type { ${P}Service } from '../service.js';

/**
 * ${common.areas[area]!.title}: ${common.areas[area]!.prefix.replace('{module}', n)}/…  (docs/api/modules/${n}.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const ${area}Routes = (_service: ${P}Service) =>
  routes(endpoints, '${area}', {
${mod.endpoints
  .filter((e) => e.area === area)
  .map((e) => `${doc(`${e.method} ${e.path}: ${e.summary}`, '    ')}    ${e.id}: notImplemented,`)
  .join('\n')}
  });
`;
  }

  if (hasFragment) {
    files['graphql/resolvers.ts'] = () => `import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { ${P}Service } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (\`@source(module: "${n}", …)\` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.${sourceFields.length ? `\n *\n * Fields to resolve:\n${sourceFields.map((s) => ` *   ${s.field} → service.${s.fn}`).join('\n')}` : ''}
 */
export const resolvers = (_service: ${P}Service): ModuleResolvers => ({});
`;
  }

  files[`${n}.test.ts`] = () => `import { describeModule } from '../../testing/module-suite.js';

// Boots ${n} with its dependencies on the in-memory MongoDB and checks it against its spec:
// routes, auth, collections and wiring. Add behaviour tests below as the module is built.
describeModule('${n}');
`;

  return files;
}
