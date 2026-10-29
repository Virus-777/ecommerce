/**
 * The MongoDB half of media's queries port (queries.ts): the `$lookup` pipelines that were in the repository
 * before it became store-neutral. They are unchanged in meaning — the same stages, the same order — and this
 * file is deleted with MongoDB at the cutover (docs/10 §23 Y4).
 */
import { decodeCursor, encodeCursor, type PageRequest } from '../../kernel/lib/pagination.js';
import { whereFilter } from '../../kernel/mongo/filters.js';
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { Page } from '../../spec/common.js';
import type { AssetRow } from './ports.js';
import type { MediaQueries, PhashCandidate, UsageState } from './queries.js';

type Doc = Record<string, unknown>;

/**
 * The usages of each asset, looked up by the indexed asset_id (both collections are this module's), with only
 * the fields the condition needs.
 */
const USAGES = 'media.usages';
const lookupUsages = (as: string, fields: Doc = { detached_at: 1 }): Doc => ({ $lookup: { from: USAGES, localField: '_id', foreignField: 'asset_id', pipeline: [{ $project: fields }], as } });
/** No usage with detached_at null */
const noActiveUse = (as: string): Doc => ({ [as]: { $not: { $elemMatch: { detached_at: null } } } });
const activeUse = (as: string): Doc => ({ [as]: { $elemMatch: { detached_at: null } } });

export function mongoMediaQueries(store: ModuleStore): MediaQueries {
  const assets = store.table<AssetRow>('assets');
  const filterOf = (where: WhereWithOr<AssetRow>): Filter => assets.filter(whereFilter(where as Readonly<Record<string, unknown>>));

  /** Assets matching `filter` (document fields) and a condition on their usages, in `sort` order */
  const withUsages = async (filter: Filter, usage: Doc, sort: Record<string, 1 | -1>, o: { skip?: number; limit?: number; fields?: Doc } = {}): Promise<AssetRow[]> => {
    const docs = await assets.aggregate<Doc>([
      { $match: filter },
      { $sort: sort },
      lookupUsages('_u', o.fields),
      { $match: usage },
      ...(o.skip ? [{ $skip: o.skip }] : []),
      ...(o.limit !== undefined ? [{ $limit: o.limit }] : []),
      { $project: { _u: 0 } },
    ]);
    return docs.map((d) => assets.fromDoc(d));
  };

  return {
    async pageByUsage(where, state: UsageState, req: PageRequest): Promise<Page<AssetRow>> {
      const usage = state === 'active' ? activeUse('_u') : noActiveUse('_u');
      const sort = { created_at: -1, _id: -1 } as const;
      const cursorOf = (r: AssetRow) => encodeCursor([r.created_at.toISOString(), r.id]);
      const filter = filterOf(where);
      if (req.mode === 'page') {
        const [counted] = await assets.aggregate<{ n: number }>([{ $match: filter }, lookupUsages('_u'), { $match: usage }, { $count: 'n' }]);
        const total = counted?.n ?? 0;
        const items = await withUsages(filter, usage, sort, { skip: (req.page - 1) * req.limit, limit: req.limit });
        const totalPages = Math.max(1, Math.ceil(total / req.limit));
        const last = items.at(-1);
        return { items, nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
      }
      let f = filter;
      if (req.cursor) {
        const [at, id] = decodeCursor(req.cursor);
        const v = new Date(at as string);
        f = { $and: [filter, { $or: [{ created_at: { $lt: v } }, { created_at: v, _id: { $lt: id } }] }] };
      }
      const rows = await withUsages(f, usage, sort, { limit: req.limit + 1 });
      const items = rows.slice(0, req.limit);
      return { items, nextCursor: rows.length > req.limit ? cursorOf(items.at(-1)!) : null };
    },

    orphans({ cutoff, now, excludePurposes, limit }) {
      return withUsages(
        assets.filter({
          status: { $in: ['ready', 'rejected'] },
          $or: [{ retain_until: null }, { retain_until: { $lte: now } }],
          ...(excludePurposes.length ? { purpose: { $nin: [...excludePurposes] } } : {}),
        }),
        {
          $or: [
            // never attached to anything after the grace period
            { created_at: { $lt: cutoff }, _u: { $size: 0 } },
            // marked for deletion (seller or customer account closed) and no longer used
            { expires_at: { $ne: null, $lte: now }, ...noActiveUse('_u') },
          ],
        },
        { created_at: 1 },
        { limit },
      );
    },

    expiredGenerated({ now, purposes, limit }) {
      return withUsages(
        assets.filter({ status: 'ready', purpose: { $in: [...purposes] }, expires_at: { $lte: now }, $or: [{ retain_until: null }, { retain_until: { $lte: now } }] }),
        noActiveUse('_u'),
        { expires_at: 1 },
        { limit },
      );
    },

    async phashCandidates(f): Promise<PhashCandidate[]> {
      const kinds = f.usageKinds?.length ? [...f.usageKinds] : null;
      const docs = await assets.aggregate<{ _id: string; phash: number; created_at: Date }>([
        {
          $match: assets.filter({
            phash: { $ne: null },
            id: { $ne: f.excludeId },
            status: 'ready',
            kind: 'image',
            // private files (evidence, documents, originals of private purposes) are never offered
            visibility: 'public',
            ...(f.ownerKind ? { owner_kind: f.ownerKind } : {}),
            ...(f.ownerId ? { owner_id: f.ownerId } : {}),
          }),
        },
        ...(kinds ? [lookupUsages('_u', { detached_at: 1, kind: 1 }), { $match: { _u: { $elemMatch: { detached_at: null, kind: { $in: kinds } } } } }] : []),
        { $project: { phash: 1, created_at: 1 } },
      ]);
      return docs.map((d) => ({ id: d._id, phash: Number(d.phash), created_at: d.created_at }));
    },
  };
}
