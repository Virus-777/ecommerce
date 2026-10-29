/**
 * The MongoDB half of the sellers queries port (queries.ts): the pipelines, the regex searches and the
 * `$expr` comparisons that were in the repository before it became store-neutral. They are unchanged in
 * meaning — the same stages in the same order — and this file is deleted whole with MongoDB at the cutover
 * (docs/10 §23, Y4).
 */
import type { KeysetOrder, PageRequest } from '../../kernel/lib/pagination.js';
import { contains, whereFilter, type Filter, type ModuleStore } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type { ApplicationRec, PerfEventRec, PerformanceFacts, SellerRec, SnapshotRec } from './ports.js';
import type { ApplicationSignals, SellersQueries } from './queries.js';

/** Decimal128 (raw aggregation values) or a number as a JS number */
const num = (v: unknown) => (v == null ? 0 : Number(String(v)));

/** `lower(<path>)`, with a missing field read as the empty string, as the `$expr` comparisons were written */
const lower = (path: string) => ({ $toLower: { $ifNull: [path, ''] } });

export function mongoSellersQueries(store: ModuleStore): SellersQueries {
  const sellers = store.table<SellerRec>('sellers');
  const applications = store.table<ApplicationRec>('applications');
  const events = store.table<PerfEventRec>('performance_events');
  const snapshots = store.table<SnapshotRec>('performance_snapshots');

  /** The search box over a seller's names, contact email and reference */
  const sellerTerm = (term: string): Filter => {
    const t = contains(term);
    return { $or: [{ store_name: t }, { legal_name: t }, { 'contact.email': t }, { ref: t }] };
  };

  /** The search box over an application's reference, store name, legal name and contact name */
  const applicationTerm = (term: string): Filter => {
    const t = contains(term);
    return { $or: [{ ref: t }, { 'account.storeName': t }, { 'business.legalName': t }, { 'account.contactName': t }] };
  };

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
    pageSellersMatching(where, term: string, req: PageRequest, order: KeysetOrder): Promise<common.Page<SellerRec>> {
      return sellers.page({ $and: [whereFilter(where), sellerTerm(term)] }, req, order);
    },

    findSellersMatching(where, term: string, limit: number): Promise<SellerRec[]> {
      return sellers.find({ $and: [whereFilter(where), sellerTerm(term)] }, { sort: { created_at: -1 }, limit });
    },

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

    pageApplicationsMatching(where, term: string, req: PageRequest): Promise<common.Page<ApplicationRec>> {
      return applications.page({ $and: [whereFilter(where), applicationTerm(term)] }, req, { column: 'decision_target_at', direction: 'asc' });
    },

    applicationsMatching(s: ApplicationSignals, excludeId: string): Promise<ApplicationRec[]> {
      const or: Filter[] = [];
      if (s.emails.length) or.push({ $expr: { $in: [lower('$account.workEmail'), s.emails.map((e) => e.toLowerCase())] } });
      if (s.tokens.length) or.push({ 'payout.current.providerDestinationId': { $in: s.tokens } }, { 'payout.pendingChange.providerDestinationId': { $in: s.tokens } });
      for (const a of s.addresses) {
        const line1 = a.line1.toLowerCase().trim();
        const postalCode = a.postalCode.trim();
        or.push({ 'business.address.postalCode': postalCode, $expr: { $eq: [lower('$business.address.line1'), line1] } });
        or.push({ 'return_address.address.postalCode': postalCode, $expr: { $eq: [lower('$return_address.address.line1'), line1] } });
      }
      if (s.taxIdHashes?.length) or.push({ tax_id_hash: { $in: s.taxIdHashes } });
      return applications.find({ id: { $ne: excludeId }, $or: or }, { limit: 20 });
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
