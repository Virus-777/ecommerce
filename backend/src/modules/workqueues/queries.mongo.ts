/**
 * The MongoDB half of workqueues' queries port (queries.ts): the three pipelines that were in the repository
 * before it became store-neutral. They are unchanged in meaning — the same stages, in the same order, with the
 * same sorts — and this file is deleted whole with MongoDB at the cutover (docs/10 §23 Y4).
 */
import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import { whereFilter } from '../../kernel/mongo/filters.js';
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { Page } from '../../spec/common.js';
import { priorityRank } from './domain/catalog.js';
import type { ItemRow, OldestRow, QueueCountRow } from './ports.js';
import type { ComputedSort, WorkqueuesQueries } from './queries.js';

type Doc = Record<string, unknown>;

/** The computed sort value as a pipeline expression, and as the same number read off a row (for the cursor) */
const COMPUTED: Record<ComputedSort, { expr: unknown; of: (row: ItemRow) => number }> = {
  priority: {
    expr: { $switch: { branches: [{ case: { $eq: ['$priority', 'urgent'] }, then: 3 }, { case: { $eq: ['$priority', 'high'] }, then: 2 }, { case: { $eq: ['$priority', 'normal'] }, then: 1 }], default: 0 } },
    of: (r) => priorityRank(r.priority),
  },
  amount: { expr: { $ifNull: ['$amount_minor', -1] }, of: (r) => r.amount_minor ?? -1 },
};

export function mongoWorkqueuesQueries(store: ModuleStore): WorkqueuesQueries {
  const items = store.table<ItemRow>('items');
  /** A neutral filter as a MongoDB filter on **row** fields (`table.count` and friends map them themselves) */
  const filterOf = (where: WhereWithOr<ItemRow>): Filter => whereFilter(where as Readonly<Record<string, unknown>>);

  return {
    async queueCounts({ states, now, soon }): Promise<QueueCountRow[]> {
      const rows = await items.aggregate<{ _id: string; open: number; overdue: number; due_soon: number }>([
        { $match: items.filter({ state: { $in: [...states] } }) },
        {
          $group: {
            _id: '$queue_key',
            open: { $sum: 1 },
            overdue: { $sum: { $cond: [{ $lte: ['$due_at', now] }, 1, 0] } },
            due_soon: { $sum: { $cond: [{ $and: [{ $gt: ['$due_at', now] }, { $lte: ['$due_at', soon] }] }, 1, 0] } },
          },
        },
      ]);
      return rows.map((r): QueueCountRow => ({ queue_key: r._id, open: r.open, overdue: r.overdue, due_soon: r.due_soon }));
    },

    async oldestOpen({ states }): Promise<OldestRow[]> {
      const rows = await items.aggregate<{ _id: string; first: { _id: string; ref: string; subject_ref?: string | null; opened_at: Date } }>([
        { $match: items.filter({ state: { $in: [...states] } }) },
        { $sort: { queue_key: 1, opened_at: 1, _id: 1 } },
        { $group: { _id: '$queue_key', first: { $first: { _id: '$_id', ref: '$ref', subject_ref: '$subject_ref', opened_at: '$opened_at' } } } },
        { $sort: { _id: 1 } },
      ]);
      return rows.map((r): OldestRow => ({ queue_key: r._id, id: r.first._id, ref: r.first.ref, subject_ref: r.first.subject_ref ?? null, opened_at: r.first.opened_at }));
    },

    /** A page ordered by the computed value (descending), then by id: keyset on (value, id) */
    async pageByComputed(where: WhereWithOr<ItemRow>, by: ComputedSort, req: PageRequest): Promise<Page<ItemRow>> {
      const { expr, of } = COMPUTED[by];
      // `aggregate` is given document fields, so the filter is mapped here; `count` maps the row fields itself
      const f = filterOf(where);
      const match = items.filter(f);
      const cursorOf = (row: ItemRow) => encodeCursor([of(row), row.id]);
      const run = async (extra: Doc[]) => {
        const docs = await items.aggregate<Doc>([{ $match: match }, { $addFields: { _sort: expr } }, ...extra]);
        return docs.map(({ _sort: _s, ...doc }) => items.fromDoc(doc));
      };
      const sort = { $sort: { _sort: -1, _id: -1 } };
      if (req.mode === 'page') {
        const [total, rows] = await Promise.all([items.count(f), run([sort, { $skip: (req.page - 1) * req.limit }, { $limit: req.limit }])]);
        const totalPages = Math.max(1, Math.ceil(total / req.limit));
        const last = rows.at(-1);
        return { items: rows, nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
      }
      const after: Doc[] = [];
      if (req.cursor) {
        const [v, id] = decodeCursor(req.cursor);
        const n = Number(v);
        after.push({ $match: { $or: [{ _sort: { $lt: n } }, { _sort: n, _id: { $lt: id } }] } });
      }
      const rows = await run([...after, sort, { $limit: req.limit + 1 }]);
      const page = rows.slice(0, req.limit);
      return { items: page, nextCursor: rows.length > req.limit ? cursorOf(page.at(-1)!) : null };
    },
  };
}
