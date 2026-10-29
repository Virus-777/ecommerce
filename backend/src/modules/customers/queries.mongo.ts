/**
 * The MongoDB half of customers' queries port (queries.ts): the search-term filter that was in the
 * repository before it became store-neutral. It is unchanged in meaning — the same `$or`, the same branches,
 * in the same order — and this file is deleted with MongoDB at the cutover (docs/10 §23 Y4).
 */
import { escapeRegExp } from '../../kernel/lib/text.js';
import type { KeysetOrder, PageRequest } from '../../kernel/lib/pagination.js';
import { contains, equalsIgnoringCase, whereFilter } from '../../kernel/mongo/filters.js';
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type * as common from '../../spec/common.js';
import type { CustomerRow } from './ports.js';
import type { CustomersQueries, CustomerTerm } from './queries.js';

/** The term's branches, any of which may match (the filter is on row fields; `page` maps `id` to `_id`) */
function termFilter(term: CustomerTerm): Filter {
  return {
    $or: [
      // first name and last name, as one text, contain the term
      { $expr: { $regexMatch: { input: { $concat: ['$first_name', ' ', '$last_name'] }, regex: escapeRegExp(term.text), options: 'i' } } },
      { email: contains(term.text) },
      { ref: equalsIgnoringCase(term.text) },
      // the phone's digits contain these digits (any separators between them)
      ...(term.digits ? [{ phone: { $regex: term.digits.split('').join('[^0-9]*') } }] : []),
      ...(term.extraIds.length ? [{ id: { $in: [...term.extraIds] } }] : []),
    ],
  };
}

export function mongoCustomersQueries(store: ModuleStore): CustomersQueries {
  const customers = store.table<CustomerRow>('customers');

  return {
    pageCustomersMatching(where: WhereWithOr<CustomerRow>, term: CustomerTerm, order: KeysetOrder, req: PageRequest): Promise<common.Page<CustomerRow>> {
      const filter = whereFilter(where as Readonly<Record<string, unknown>>);
      return customers.page({ $and: [filter, termFilter(term)] }, req, order);
    },
  };
}
