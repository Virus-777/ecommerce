/**
 * The MongoDB half of notifications' queries port (queries.ts): the inbox-count pipeline that was in the
 * repository before it became store-neutral. It is unchanged in meaning — the same stages, in the same order,
 * with the same `$cond` sums — and this file is deleted with MongoDB at the cutover (docs/10 §23 Y4).
 */
import { whereFilter } from '../../kernel/mongo/filters.js';
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { NoticeRow } from './ports.js';
import type { InboxGroupCounts, NotificationsQueries } from './queries.js';

type Doc = Record<string, unknown>;

export function mongoNotificationsQueries(store: ModuleStore): NotificationsQueries {
  const notices = store.table<NoticeRow>('notices');

  return {
    async inboxCounts(base: WhereWithOr<NoticeRow>, accountId: string): Promise<InboxGroupCounts[]> {
      const isNull = (path: string): Doc => ({ $eq: [{ $ifNull: [path, null] }, null] });
      const rows = await notices.aggregate<{ _id: string; total: number; unread: number; openActions: number; mentionsUnread: number }>([
        { $match: notices.filter(whereFilter(base as Readonly<Record<string, unknown>>)) },
        {
          $lookup: {
            from: `${store.module}.notice_recipients`,
            let: { nid: '$_id' },
            pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$notice_id', '$$nid'] }, { $eq: ['$account_id', accountId] }] } } }, { $limit: 1 }],
            as: 'r',
          },
        },
        { $set: { r: { $first: '$r' } } },
        // archived notices leave the inbox and its counts; no recipient row of mine is not archived
        { $match: { 'r.archived_at': null } },
        {
          $group: {
            _id: '$group_key',
            total: { $sum: 1 },
            unread: { $sum: { $cond: [isNull('$r.read_at'), 1, 0] } },
            openActions: { $sum: { $cond: [{ $and: [{ $eq: ['$action_required', true] }, isNull('$resolved_at'), isNull('$expired_at')] }, 1, 0] } },
            mentionsUnread: { $sum: { $cond: [{ $and: [{ $eq: ['$r.reason', 'mention'] }, isNull('$r.read_at')] }, 1, 0] } },
          },
        },
      ]);
      return rows.map(({ _id, ...counts }) => ({ group: _id, ...counts }));
    },
  };
}
