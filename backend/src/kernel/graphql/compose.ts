/**
 * Composes one GraphQL schema per area from base.graphql and the fragments of the enabled modules,
 * with the same rules as docs/api/tools/graphql.mjs:
 *   - @areas(in: […]) keeps a type or field only in the listed areas (no @areas = all three);
 *   - fields whose types come from a disabled module are dropped, repeatedly, until the schema is stable.
 */
import type { DefinitionNode, DocumentNode, GraphQLSchema, TypeNode } from 'graphql';
import { graphql } from './runtime.js';

const { buildASTSchema, Kind, parse, visit } = graphql;

export type GraphQLArea = 'store' | 'seller' | 'admin';

const DEF_KINDS = new Set<string>([Kind.OBJECT_TYPE_DEFINITION, Kind.ENUM_TYPE_DEFINITION, Kind.INPUT_OBJECT_TYPE_DEFINITION, Kind.UNION_TYPE_DEFINITION, Kind.INTERFACE_TYPE_DEFINITION, Kind.SCALAR_TYPE_DEFINITION]);
const EXT_KINDS = new Set<string>([Kind.OBJECT_TYPE_EXTENSION, Kind.ENUM_TYPE_EXTENSION, Kind.INPUT_OBJECT_TYPE_EXTENSION, Kind.UNION_TYPE_EXTENSION, Kind.INTERFACE_TYPE_EXTENSION]);
const BUILTIN = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

type Node = { kind: string; directives?: readonly { name: { value: string }; arguments?: readonly { name: { value: string }; value: { kind: string; values?: readonly { value?: string }[] } }[] }[] };

function areasOf(node: Node): string[] | null {
  const d = node.directives?.find((x) => x.name.value === 'areas');
  const v = d?.arguments?.find((a) => a.name.value === 'in')?.value;
  return v?.kind === Kind.LIST ? (v.values ?? []).map((x) => String(x.value)) : null;
}

function filterForArea(doc: DocumentNode, area: GraphQLArea): DocumentNode {
  const A = area.toUpperCase();
  return visit(doc, {
    enter(node) {
      const n = node as unknown as Node;
      if ((DEF_KINDS.has(n.kind) || EXT_KINDS.has(n.kind) || n.kind === Kind.FIELD_DEFINITION || n.kind === Kind.ENUM_VALUE_DEFINITION || n.kind === Kind.INPUT_VALUE_DEFINITION) && n.directives) {
        const a = areasOf(n);
        if (a && !a.includes(A)) return null;
      }
      return undefined;
    },
  });
}

type WithFields = DefinitionNode & { name: { value: string }; fields?: readonly { name: { value: string }; type: TypeNode; arguments?: readonly { type: TypeNode }[] }[] };

function pruneMissing(defs: DefinitionNode[], dropped: string[]): DefinitionNode[] {
  for (;;) {
    const defined = new Set(defs.filter((d) => DEF_KINDS.has(d.kind)).map((d) => (d as WithFields).name.value));
    const ok = (t: TypeNode) => {
      let n: TypeNode = t;
      while (n.kind !== Kind.NAMED_TYPE) n = n.type;
      return BUILTIN.has(n.name.value) || defined.has(n.name.value);
    };
    let changed = false;
    const next: DefinitionNode[] = [];
    for (const raw of defs) {
      const d = raw as WithFields;
      if (EXT_KINDS.has(d.kind) && !defined.has(d.name.value)) {
        dropped.push(`${d.name.value} (all fields added by this fragment)`);
        changed = true;
        continue;
      }
      if (!d.fields) {
        next.push(d);
        continue;
      }
      const fields = d.fields.filter((f) => {
        const keep = ok(f.type) && (f.arguments ?? []).every((a) => ok(a.type));
        if (!keep) {
          dropped.push(`${d.name.value}.${f.name.value}`);
          changed = true;
        }
        return keep;
      });
      if (fields.length || !EXT_KINDS.has(d.kind)) next.push({ ...d, fields } as unknown as DefinitionNode);
      else changed = true;
    }
    defs = next;
    if (!changed) return defs;
  }
}

export interface Fragment {
  module: string;
  typeDefs: string;
}

export interface Composed {
  schema: GraphQLSchema;
  /** Which module contributed each field: "Type.field" → module */
  fieldOwner: Map<string, string>;
  dropped: string[];
}

export function composeSchema(area: GraphQLArea, baseTypeDefs: string, fragments: Fragment[]): Composed {
  const parsed = [{ module: 'base', doc: parse(baseTypeDefs) }, ...fragments.map((f) => ({ module: f.module, doc: parse(f.typeDefs) }))];
  const fieldOwner = new Map<string, string>();
  for (const { module, doc } of parsed) {
    for (const d of doc.definitions as WithFields[]) for (const f of d.fields ?? []) fieldOwner.set(`${d.name.value}.${f.name.value}`, module);
  }
  let defs = parsed
    .map((p) => filterForArea(p.doc, area))
    .flatMap((d) => [...d.definitions])
    .filter((d) => !(d.kind === Kind.OBJECT_TYPE_EXTENSION && !((d as WithFields).fields ?? []).length));
  const dropped: string[] = [];
  defs = pruneMissing(defs, dropped);
  const schema = buildASTSchema({ kind: Kind.DOCUMENT, definitions: defs }, { assumeValidSDL: false });
  return { schema, fieldOwner, dropped };
}
