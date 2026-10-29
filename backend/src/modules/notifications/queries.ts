/**
 * The reads of this module that are not the same question in both databases (docs/10-mysql-migration.md §10.5e).
 *
 * Everything else lives in repository.ts, written once against `ctx.store`. What is here needs a **join**: the
 * inbox counts are counted over notices, while the read state, the archive state and the mention reason are
 * columns of `notice_recipients`. MongoDB asks it with `$lookup` and a `$group` of `$cond` sums; MySQL asks it
 * with one `LEFT JOIN` and `GROUP BY` — the same question and not the same sentence, so each store gets its
 * own implementation of this small interface and the service never knows which one it has.
 *
 * It is a **left** join, which is the whole reason this is not a `countBy`: customers and sellers get a
 * recipient row only the first time they read or archive a notice addressed to their workspace, so most of the
 * notices being counted have no recipient row at all and still count (unread, and open if they need action).
 *
 * This is one read outside a transaction, which is why nothing here takes one: the summary endpoints answer
 * from it directly and nothing is written from what it says.
 */
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { NoticeRow } from './ports.js';

/** The counts behind one inbox group's badge (`group_key`: orders, returns_refunds, cases, account, promotions) */
export interface InboxGroupCounts {
  group: string;
  total: number;
  unread: number;
  openActions: number;
  mentionsUnread: number;
}

export interface NotificationsQueries {
  /**
   * Per inbox group: how many notices there are, how many are unread, how many need action and are still open,
   * and how many are unread mentions — over the notices of one inbox (`base`, the repository's `#inboxBase`)
   * joined to `accountId`'s own recipient rows. Notices this account archived are left out of all four.
   */
  inboxCounts(base: WhereWithOr<NoticeRow>, accountId: string): Promise<InboxGroupCounts[]>;
}
