/**
 * The MySQL half of notifications' queries port (queries.ts). The `$lookup` of the MongoDB side is one
 * `LEFT JOIN`, and the four `$cond` sums are four `SUM(<condition>)` over one `GROUP BY group_key` — which is
 * what §13.1 gives a `$group` with more than a count, and what §13.2's line for this module ("the inbox view")
 * asks for.
 *
 * **Why it does not read `notifications_v_inbox`.** The spec ships that view (§9.2) and it was the obvious
 * candidate, but it cannot answer this read: it is an *inner* join of `notice_recipients` to `notices`, while
 * an inbox is a *left* join — customers and sellers get a recipient row only the first time they read or
 * archive a notice addressed to their workspace, so most of the notices being counted have no recipient row
 * and still count. (Its `id` is also the recipient's, not the notice's, so a filter on notice ids would mean
 * something else.) The view is right for a staff inbox, where a recipient row always exists; it is left out
 * here rather than used for one owner kind and not the others.
 *
 * The notice half of the filter is the repository's own `#inboxBase`, in the neutral vocabulary, so it is
 * compiled with the kernel's `whereSql` and dropped into a derived table — where its unqualified column names
 * mean the notices table and nothing else, which is what keeps one filter written once for both stores.
 */
import { sql, type RawBuilder } from 'kysely';
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import { whereSql, type Sql, type WhereOptions } from '../../kernel/mysql/where.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { NotificationsTables } from '../../spec/notifications.js';
import type { NoticeRow } from './ports.js';
import type { InboxGroupCounts, NotificationsQueries } from './queries.js';

/** The recipient reason that makes a notice a mention (a column value, bound like any other) */
const MENTION = 'mention';

/**
 * A `{ sql, params }` fragment (kernel/mysql/where.ts) as a Kysely fragment: its `?` placeholders become
 * Kysely's own bound values, in order.
 *
 * `whereSql` never writes a value into the SQL text — every value it compares is bound, which is the rule
 * `check:boundaries` enforces — so every `?` in the text is a placeholder and their number has to match the
 * values. That is checked here rather than assumed: a mismatch would silently shift every parameter after it.
 */
function bound(fragment: Sql): RawBuilder<unknown> {
  const text = fragment.sql.split('?');
  if (text.length - 1 !== fragment.params.length) throw new Error(`notifications: a filter fragment with ${text.length - 1} placeholders for ${fragment.params.length} values`);
  const pieces: unknown[] = [sql.raw(text[0]!)];
  fragment.params.forEach((value, i) => pieces.push(sql.val(value), sql.raw(text[i + 1]!)));
  return sql.join(pieces, sql.raw(''));
}

/** What a count comes back as: SUM() is DECIMAL, which mysql2 hands over as a string */
interface CountsRow {
  group_key: string;
  total: number | string;
  unread: number | string;
  open_actions: number | string;
  mentions_unread: number | string;
}

export function mysqlNotificationsQueries(store: ModuleStore<NotificationsTables>): NotificationsQueries {
  const notices = store.table<NoticeRow>('notices');
  // the same reading of a filter the table itself uses: `link` is a JSON column, and a JSON column that cannot
  // be null holds `null` as a document rather than as SQL NULL (kernel/mysql/table.ts)
  const noticeWhere: WhereOptions = { json: new Set(notices.def.json), jsonNotNull: new Set(notices.def.json.filter((c) => !notices.def.nullable.includes(c))) };

  return {
    async inboxCounts(base: WhereWithOr<NoticeRow>, accountId: string): Promise<InboxGroupCounts[]> {
      const inbox = bound(whereSql(base, noticeWhere));
      const { rows } = await sql<CountsRow>`
        SELECT n.\`group_key\` AS \`group_key\`,
               COUNT(*) AS \`total\`,
               SUM(r.\`read_at\` IS NULL) AS \`unread\`,
               SUM(n.\`action_required\` = TRUE AND n.\`resolved_at\` IS NULL AND n.\`expired_at\` IS NULL) AS \`open_actions\`,
               SUM(r.\`reason\` = ${MENTION} AND r.\`read_at\` IS NULL) AS \`mentions_unread\`
          FROM (SELECT \`id\`, \`group_key\`, \`action_required\`, \`resolved_at\`, \`expired_at\`
                  FROM \`notifications_notices\`
                 WHERE ${inbox}) AS n
          LEFT JOIN \`notifications_notice_recipients\` AS r
                 ON r.\`notice_id\` = n.\`id\` AND r.\`account_id\` = ${accountId}
         WHERE r.\`archived_at\` IS NULL
         GROUP BY n.\`group_key\``.execute(store.db);
      return rows.map((r) => ({
        group: r.group_key,
        total: Number(r.total),
        unread: Number(r.unread),
        openActions: Number(r.open_actions),
        mentionsUnread: Number(r.mentions_unread),
      }));
    },
  };
}
