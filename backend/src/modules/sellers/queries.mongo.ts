/**
 * The MongoDB half of the sellers queries port (queries.ts): the pipelines that were in the repository
 * before it became store-neutral, unchanged in meaning — the same stages in the same order. This file is
 * deleted whole with MongoDB at the cutover (docs/10 §23, Y4).
 *
 * It was four queries longer: the two search boxes and the duplicate-application check went back into the
 * repository once the vocabulary could say `contains` and `equals ignoring case` of a path into a document
 * (§10.5e), which is what the port is *for* — it holds what is not the same question in both databases, and
 * those four had stopped being that.
 */
import { type Filter, type ModuleStore } from '../../kernel/mongo/index.js';
import type { ApplicationRec, PerfEventRec, PerformanceFacts, SnapshotRec } from './ports.js';
import type { SellersQueries } from './queries.js';

/** Decimal128 (raw aggregation values) or a number as a JS number */
const num = (v: unknown) => (v == null ? 0 : Number(String(v)));

export function mongoSellersQueries(store: ModuleStore): SellersQueries {
  const applications = store.table<ApplicationRec>('applications');
  const events = store.table<PerfEventRec>('performance_events');
  const snapshots = store.table<SnapshotRec>('performance_snapshots');

  /** Seller ids by their latest performance snapshot (DISTINCT ON (seller_id) … ORDER BY computed_at DESC) */
  const latestSnapshotMetric = async (match: Filter): Promise<string[]> => {
    const rows = await snapshots.aggregate<{ _id: string }>([
      { $sort: { seller_id: 1, computed_at: -1 } },
      { $group: { _id: '$seller_id', metrics: { $first: '$metrics' } } },
      { $match: match },
      { $project: { _id: 1 } },
    ]);
    return rows.map((r) => r._id);
  };

  return {
    /** the seller's application lists the category (business.categoryIds @> [categoryId]) */
    applicationIdsInCategory(categoryId: string): Promise<string[]> {
      return applications.distinct<string>('id', { 'business.categoryIds': categoryId });
    },

    /** the latest snapshot's dispatch reliability value is below the figure (no value: not below) */
    sellerIdsWithDispatchValueBelow(value: number): Promise<string[]> {
      return latestSnapshotMetric({ 'metrics.dispatch_reliability.value': { $type: 'number', $lt: value } });
    },

    sellerIdsWithDispatchStatusIn(statuses: readonly string[]): Promise<string[]> {
      return latestSnapshotMetric({ 'metrics.dispatch_reliability.status': { $in: [...statuses] } });
    },

    async performanceFactsByKind(sellerId: string, since: Date, kinds?: readonly string[]): Promise<PerformanceFacts[]> {
      const rows = await events.aggregate<{ _id: string; n: number; total: unknown }>([
        { $match: { seller_id: sellerId, ...(kinds ? { kind: { $in: [...kinds] } } : {}), occurred_at: { $gte: since } } },
        { $group: { _id: '$kind', n: { $sum: 1 }, total: { $sum: '$value' } } },
      ]);
      return rows.map((r) => ({ kind: r._id, n: r.n, total: num(r.total) }));
    },

    async latestSnapshots(sellerIds: readonly string[], perSeller: number): Promise<SnapshotRec[]> {
      const docs = await snapshots.aggregate([
        { $match: { seller_id: { $in: [...new Set(sellerIds)] } } },
        { $setWindowFields: { partitionBy: '$seller_id', sortBy: { computed_at: -1 }, output: { rn: { $documentNumber: {} } } } },
        { $match: { rn: { $lte: perSeller } } },
        { $sort: { seller_id: 1, computed_at: -1 } },
        { $unset: 'rn' },
      ]);
      return docs.map((d) => snapshots.fromDoc(d));
    },
  };
}
