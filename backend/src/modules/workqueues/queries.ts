/**
 * The reads of this module that are not the same question in both databases (docs/10-mysql-migration.md §10.5e).
 *
 * Everything else lives in repository.ts, written once against `ctx.store`. Three reads are here, and each is a
 * different reason (§13.1):
 *
 *  - `queueCounts` is a `GROUP BY` with **more than a count**: open, overdue and due-soon of the same rows, which
 *    is three measures over one pass. MongoDB asks it with `$cond` sums, MySQL with `SUM(<condition>)`;
 *  - `oldestOpen` is **the first row per key** — the oldest open item of each queue. MongoDB asks it with `$sort`
 *    + `$group $first`, MySQL with `ROW_NUMBER() OVER (PARTITION BY … ORDER BY …) = 1`;
 *  - `pageByComputed` pages a list ordered by a value **neither store stores**: the rank of a priority word, or an
 *    amount with "no amount" placed last. MongoDB computes it with `$addFields` and pages the pipeline, MySQL
 *    computes it in the `SELECT` list and pages it with `Table.pageQuery`.
 *
 * What is **not** here, on purpose: "how many active items per queue / per kind" is `table.countBy(['queue_key'], …)`,
 * which both stores answer identically and the seam therefore carries (§10.5e), and so is the one `distinct`.
 *
 * All three are reads **outside** a transaction — every caller is a dashboard, a list or the day-end report — which
 * is why none of them takes one. That matters: a port query inside a transaction would have to be bound to its
 * connection, and these are not. The one read that does need a lock (`activeMatching`, under `closeMatching`'s
 * transaction) stays in the repository for exactly that reason.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { Page } from '../../spec/common.js';
import type { ItemRow, OldestRow, QueueCountRow } from './ports.js';

/**
 * Which computed value a list is ordered by, descending. Both are a function of one stored column, which is what
 * makes a keyset cursor over them as stable as one over the column itself:
 *
 *  - `priority`: the rank of the priority word (urgent 3, high 2, normal 1, anything else 0), so that the four
 *    words sort by urgency instead of alphabetically (`high` < `low` < `normal` < `urgent` is not an order anyone
 *    asked for);
 *  - `amount`: `amount_minor` with null read as -1, which puts the items with no amount last in a descending sort.
 *    `amount_minor` is a count of minor units and is never negative, so -1 is below every real value.
 */
export type ComputedSort = 'priority' | 'amount';

export interface WorkqueuesQueries {
  /**
   * Per queue, over the items whose state is one of `states`: how many there are, how many are due at or before
   * `now` (overdue) and how many are due after `now` but at or before `soon` (due soon). Only queues with at least
   * one such item appear.
   */
  queueCounts(f: { states: readonly string[]; now: Date; soon: Date }): Promise<QueueCountRow[]>;

  /** The oldest item in each queue whose state is one of `states`, by queue key */
  oldestOpen(f: { states: readonly string[] }): Promise<OldestRow[]>;

  /** A page of the items matching `where`, ordered by a computed value (descending) and then by id */
  pageByComputed(where: WhereWithOr<ItemRow>, by: ComputedSort, req: PageRequest): Promise<Page<ItemRow>>;
}
