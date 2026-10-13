/**
 * Composes one GraphQL schema per area from base.graphql and the fragments of the enabled modules,
 * with the same rules as docs/api/tools/graphql.mjs:
 *   - @areas(in: […]) keeps a type or field only in the listed areas (no @areas = all three);
 *   - fields whose types come from a disabled module are dropped, repeatedly, until the schema is stable.
 */
import {
  buildASTSchema,
  isTypeDefinitionNode,
  isTypeExtensionNode,
  Kind,
  parse,
  specifiedScalarTypes,
  valueFromASTUntyped,
  visit,
  type ConstDirectiveNode,
  type DefinitionNode,
  type DocumentNode,
  type GraphQLSchema,
  type TypeNode,
} from 'graphql';

export type GraphQLArea = 'store' | 'seller' | 'admin';
export const AREAS: readonly GraphQLArea[] = ['store', 'seller', 'admin'];

type WithDirectives = { readonly directives?: readonly ConstDirectiveNode[] } | null | undefined;

const BUILTIN = new Set(specifiedScalarTypes.map((t) => t.name));
const FILTERED = new Set<string>([Kind.FIELD_DEFINITION, Kind.ENUM_VALUE_DEFINITION, Kind.INPUT_VALUE_DEFINITION]);

/** Argument of a directive on a schema node, e.g. directiveArg(field.astNode, 'source', 'module') */
export function directiveArg(node: WithDirectives, directive: string, arg: string): unknown {
  const value = node?.directives?.find((d) => d.name.value === directive)?.arguments?.find((a) => a.name.value === arg)?.value;
  return value && valueFromASTUntyped(value);
}

function filterForArea(doc: DocumentNode, area: GraphQLArea): DocumentNode {
  const A = area.toUpperCase();
  return visit(doc, {
    enter(node) {
      if (!(isTypeDefinitionNode(node) || isTypeExtensionNode(node) || FILTERED.has(node.kind))) return;
      const areas = directiveArg(node as WithDirectives, 'areas', 'in') as string[] | undefined;
      if (areas && !areas.includes(A)) return null;
    },
  });
}

type WithFields = DefinitionNode & { name: { value: string }; fields?: readonly { name: { value: string }; type: TypeNode; arguments?: readonly { type: TypeNode }[] }[] };

const namedType = (t: TypeNode): string => (t.kind === Kind.NAMED_TYPE ? t.name.value : namedType(t.type));

/** Drops extensions of missing types and fields whose types are missing, until nothing changes. */
function pruneMissing(input: readonly DefinitionNode[]) {
  const dropped: string[] = [];
  let defs = input;
  for (let changed = true; changed; ) {
    changed = false;
    const defined = new Set(defs.filter(isTypeDefinitionNode).map((d) => d.name.value));
    const ok = (t: TypeNode) => BUILTIN.has(namedType(t)) || defined.has(namedType(t));
    const next: DefinitionNode[] = [];
    for (const d of defs as WithFields[]) {
      if (isTypeExtensionNode(d) && !defined.has(d.name.value)) {
        dropped.push(`${d.name.value} (all fields added by this fragment)`);
        changed = true;
        continue;
      }
      if (!d.fields) {
        next.push(d);
        continue;
      }
      const fields = d.fields.filter((f) => ok(f.type) && (f.arguments ?? []).every((a) => ok(a.type)));
      if (fields.length !== d.fields.length) {
        changed = true;
        for (const f of d.fields) if (!fields.includes(f)) dropped.push(`${d.name.value}.${f.name.value}`);
      }
      if (fields.length || !isTypeExtensionNode(d)) next.push({ ...d, fields } as unknown as DefinitionNode);
    }
    defs = next;
  }
  return { defs, dropped };
}

export interface Fragment {
  module: string;
  typeDefs: string;
}

/** Type name → the module whose fragment defines it (not extends it) */
export function typeOwners(fragments: readonly Fragment[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const f of fragments) for (const d of parse(f.typeDefs).definitions) if (d.kind === Kind.OBJECT_TYPE_DEFINITION) owners.set(d.name.value, f.module);
  return owners;
}

/** Parse base.graphql and the fragments once; each area is composed from the parsed documents. */
export const parseFragments = (baseTypeDefs: string, fragments: readonly Fragment[]): DocumentNode[] => [parse(baseTypeDefs), ...fragments.map((f) => parse(f.typeDefs))];

export function composeSchema(area: GraphQLArea, docs: readonly DocumentNode[]): { schema: GraphQLSchema; dropped: string[] } {
  const all = docs.flatMap((d) => filterForArea(d, area).definitions).filter((d) => !(d.kind === Kind.OBJECT_TYPE_EXTENSION && !d.fields?.length));
  const { defs, dropped } = pruneMissing(all);
  return { schema: buildASTSchema({ kind: Kind.DOCUMENT, definitions: defs }), dropped };
}
