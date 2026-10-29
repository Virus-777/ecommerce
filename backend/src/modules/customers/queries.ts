/**
 * The one read of this module that is not the same *sentence* in both databases (docs/10 §10.5e).
 *
 * Everything else lives in repository.ts, written once against `ctx.store`. What is here is the staff search
 * box over customers, which asks two things the neutral vocabulary cannot say:
 *
 *  - **the full name as one text.** `q` is matched against `first_name + ' ' + last_name`, so "zelda qu"
 *    finds Zelda Quartz. An `or` of per-column `contains` is *not* the same question — neither column holds
 *    "zelda qu" — and admin.test.ts searches exactly that term, so the concatenation is the behaviour and not
 *    an implementation detail. MongoDB says it with `$expr` + `$regexMatch` over `$concat`; MySQL says it with
 *    `CONCAT_WS(' ', …) LIKE ? COLLATE utf8mb4_0900_as_ci`, which matches the same rows (literal, ignoring
 *    case). §13.2's eventual answer is the FULLTEXT ngram index the spec already carries
 *    (`ft_customers_customers_4`); it is not used here, because an ngram MATCH does not answer the same rows
 *    as a substring match and that is a central decision, not a conversion.
 *  - **the phone's digits, whatever separates them.** Four or more typed digits match a phone with any
 *    non-digit run between them (`555` `-` `0199`): a regex on both stores, and the vocabulary has no regex.
 *
 * The rest of the search — the id lists, the statuses, the verification state and the joined-between dates —
 * is an ordinary `WhereWithOr` built in the repository and passed through, so the filter, the sort and the
 * paging stay written once. Without a term the repository pages the table itself and never comes here.
 *
 * This is a read outside a transaction, which is why it does not take one.
 */
import type { KeysetOrder, PageRequest } from '../../kernel/lib/pagination.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type * as common from '../../spec/common.js';
import type { CustomerRow } from './ports.js';

/** What a staff member typed in the customer search box, as the three questions it asks */
export interface CustomerTerm {
  /** The term, trimmed. Matched literally and ignoring case against the full name, the email and the ref */
  text: string;
  /** The term's digits when there are at least four of them, for the phone search; null when there are not */
  digits: string | null;
  /** Customer ids another module resolved from the same term (an order reference), which widen the match */
  extraIds: readonly string[];
}

export interface CustomersQueries {
  /**
   * A page of customers that match `where` **and** the search term, in `order`. The term's branches are
   * ORed with each other and ANDed with `where`, which is what the one filter did before it was split.
   */
  pageCustomersMatching(where: WhereWithOr<CustomerRow>, term: CustomerTerm, order: KeysetOrder, req: PageRequest): Promise<common.Page<CustomerRow>>;
}
