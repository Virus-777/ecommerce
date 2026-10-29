/**
 * The MySQL half of customers' queries port (queries.ts): the search term as one extra condition on an
 * ordinary `Table` read (`ReadOptions.and`, §10.5), so the rest of the filter, the keyset cursor, the sort
 * and the row conversion stay where they are written once.
 *
 * The two branches that are not the neutral vocabulary's:
 *
 *  - `CONCAT_WS(' ', first_name, last_name) LIKE '%term%'` with the `as_ci` collation, which is what
 *    MongoDB's `$regexMatch` over `$concat` with `options: 'i'` asked: the term matched literally (the `%`,
 *    `_` and `\` a staff member typed are escaped), ignoring case. Both columns are NOT NULL, so CONCAT_WS's
 *    skipping of nulls can never show — and nor could `$concat`'s null-in-null-out.
 *  - `phone REGEXP '5[^0-9]*5[^0-9]*5…'`. The session collation is `utf8mb4_0900_bin`, so REGEXP is
 *    case-sensitive, exactly as the MongoDB `$regex` with no `i` was; digits have no case either way. A null
 *    phone does not match, as a missing field did not.
 *
 * This read does not use the FULLTEXT ngram index the spec carries for these columns: a `MATCH … AGAINST`
 * does not answer the same rows as a substring match (an ngram tokeniser decides what a token is), and
 * changing the question is a central decision rather than part of a conversion (docs/10 §10.5e, §13.2).
 */
import { escapeLike } from '../../kernel/lib/text.js';
import type { KeysetOrder, PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import { contains, equalsIgnoringCase, raw, type Sql } from '../../kernel/mysql/where.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type * as common from '../../spec/common.js';
import type { CustomersTables } from '../../spec/customers.js';
import type { CustomerRow } from './ports.js';
import type { CustomersQueries, CustomerTerm } from './queries.js';

/** `as_ci` ignores case but not accents, which is the rule the MongoDB regexes applied (§5.2) */
const CI = 'COLLATE utf8mb4_0900_as_ci';

/** Any one of the branches: the OR the one filter held before the search was split out */
const anyOf = (parts: readonly Sql[]): Sql => ({ sql: parts.map((p) => `(${p.sql})`).join(' OR '), params: parts.flatMap((p) => p.params) });

/** `customers_customers` is not aliased in a `Table` read, so the columns need no qualifier */
function termSql(term: CustomerTerm): Sql {
  const parts: Sql[] = [
    // first name and last name, as one text, contain the term
    raw(`CONCAT_WS(' ', \`first_name\`, \`last_name\`) LIKE ? ${CI}`, [`%${escapeLike(term.text.trim())}%`]),
    contains('email', term.text),
    equalsIgnoringCase('ref', term.text),
  ];
  // the phone's digits contain these digits (any separators between them)
  if (term.digits) parts.push(raw('`phone` REGEXP ?', [term.digits.split('').join('[^0-9]*')]));
  if (term.extraIds.length) parts.push(raw(`\`id\` IN (${term.extraIds.map(() => '?').join(', ')})`, [...term.extraIds]));
  return anyOf(parts);
}

export function mysqlCustomersQueries(store: ModuleStore<CustomersTables>): CustomersQueries {
  const customers = store.table<CustomerRow>('customers');

  return {
    pageCustomersMatching(where: WhereWithOr<CustomerRow>, term: CustomerTerm, order: KeysetOrder, req: PageRequest): Promise<common.Page<CustomerRow>> {
      return customers.page(where, req, order, { and: termSql(term) });
    },
  };
}
