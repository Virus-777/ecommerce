/**
 * Query cost limit (docs/api/graphql/README.md, Limits). Every selected field costs its `@cost(weight)`;
 * without one, a field returning a list costs 10 and any other field 1 (`__typename` is free). Fragments
 * count once per place they are spread, so aliases and repeated fragments add up. The cost of a request is
 * the sum over the operation it runs; above the limit the request is refused before anything resolves.
 */
import {
  getNamedType,
  getNullableType,
  GraphQLError,
  isListType,
  Kind,
  type ASTVisitor,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLField,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  isInterfaceType,
  isObjectType,
} from 'graphql';
import { directiveArg } from './compose.js';

export const LIST_WEIGHT = 10;

export function fieldWeight(field: GraphQLField<unknown, unknown>): number {
  const declared = directiveArg(field.astNode, 'cost', 'weight');
  if (typeof declared === 'number') return declared;
  return isListType(getNullableType(field.type)) ? LIST_WEIGHT : 1;
}

/** Cost of one selection set on `parent` (fragments expanded; a fragment spread inside itself counts once). */
function selectionCost(schema: GraphQLSchema, parent: GraphQLCompositeType, set: SelectionSetNode | undefined, fragments: Map<string, FragmentDefinitionNode>, stack: string[]): number {
  if (!set) return 0;
  let total = 0;
  for (const s of set.selections) {
    if (s.kind === Kind.FIELD) {
      if (s.name.value.startsWith('__')) continue;
      const field = isObjectType(parent) || isInterfaceType(parent) ? parent.getFields()[s.name.value] : undefined;
      if (!field) continue; // unknown fields fail validation on their own
      total += fieldWeight(field as GraphQLField<unknown, unknown>);
      total += selectionCost(schema, getNamedType(field.type) as GraphQLCompositeType, s.selectionSet, fragments, stack);
    } else if (s.kind === Kind.INLINE_FRAGMENT) {
      const on = s.typeCondition ? (schema.getType(s.typeCondition.name.value) as GraphQLCompositeType | undefined) : parent;
      total += selectionCost(schema, on ?? parent, s.selectionSet, fragments, stack);
    } else {
      const f = fragments.get(s.name.value);
      if (!f || stack.includes(f.name.value)) continue;
      const on = schema.getType(f.typeCondition.name.value) as GraphQLCompositeType | undefined;
      total += selectionCost(schema, on ?? parent, f.selectionSet, fragments, [...stack, f.name.value]);
    }
  }
  return total;
}

export function operationCost(schema: GraphQLSchema, op: OperationDefinitionNode, fragments: Map<string, FragmentDefinitionNode>): number {
  const root = op.operation === 'query' ? schema.getQueryType() : op.operation === 'mutation' ? schema.getMutationType() : schema.getSubscriptionType();
  return root ? selectionCost(schema, root, op.selectionSet, fragments, []) : 0;
}

/** Validation rule: refuses an operation whose cost is above `limit` (extensions.code QUERY_TOO_COMPLEX). */
export function costLimitRule(limit: number) {
  return (context: ValidationContext): ASTVisitor => ({
    Document: {
      leave(doc) {
        const fragments = new Map(doc.definitions.filter((d): d is FragmentDefinitionNode => d.kind === Kind.FRAGMENT_DEFINITION).map((f) => [f.name.value, f]));
        for (const op of doc.definitions) {
          if (op.kind !== Kind.OPERATION_DEFINITION) continue;
          const cost = operationCost(context.getSchema(), op, fragments);
          if (cost > limit) {
            context.reportError(
              new GraphQLError(`Query ${op.name?.value ?? '(anonymous)'} costs ${cost}, above the limit of ${limit}: ask for fewer fields or split the screen into several queries`, {
                nodes: [op],
                extensions: { code: 'QUERY_TOO_COMPLEX', details: { cost, limit } },
              }),
            );
          }
        }
      },
    },
  });
}
