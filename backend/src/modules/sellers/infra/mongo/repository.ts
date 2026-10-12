import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter, Sort, Table as MongoTable } from '../../../../kernel/mongo/table.js';
import type { ApplicationListFilter, Db, PerformanceFacts, SellerListFilter, SellersRepository, SnapshotRec, Table, Where } from '../../ports.js';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ILIKE '%term%' on a field */
const contains = (term: string) => ({ $regex: escapeRegExp(term.trim()), $options: 'i' });

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

/** A column condition (ports Cond) as a MongoDB condition, with SQL's meaning (`<>` skips nulls) */
function cond(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return { $in: v };
  if (isOp(v)) {
    switch (v.op) {
      case '<':
        return { $lt: v.value };
      case '<=':
        return { $lte: v.value };
      case '>':
        return { $gt: v.value };
      case '>=':
        return { $gte: v.value };
      case '<>':
        return { $nin: [v.value, null] };
      case 'is not':
        return { $ne: v.value };
      default:
        throw new Error(`sellers: unknown operator ${v.op}`);
    }
  }
  return v;
}

function where(w: Record<string, unknown>): Filter {
  const out: Filter = {};
  for (const [k, v] of Object.entries(w)) if (v !== undefined) out[k] = cond(v);
  return out;
}

const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined): Sort | undefined =>
  orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

/** Decimal128 (raw aggregation values) or a number as a JS number */
const num = (v: unknown) => (v == null ? 0 : Number(String(v)));

/** Seller statuses whose dispatch performance counts (countBelowDispatch) */
const LIVE_STATUSES = ['approved', 'restricted', 'suspended'];
const OPEN_APPLICATION_STATES = ['submitted', 'under_review', 'information_required'];

/** MongoDB adapter for SellersRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoSellersRepository(store: ModuleStore): SellersRepository {
  const t = <T extends Table>(name: T) => store.table<Db[T]>(name) as MongoTable<Db[T]>;
  const sellers = t('sellers');
  const applications = t('applications');
  const snapshots = t('performance_snapshots');
  const events = t('performance_events');

  /** seller ids by their latest performance snapshot (DISTINCT ON (seller_id) … ORDER BY computed_at DESC) */
  const latestSnapshotMetric = async (match: Filter, sellerIds?: string[]) => {
    const rows = await snapshots.aggregate<{ _id: string }>([
      ...(sellerIds ? [{ $match: { seller_id: { $in: sellerIds } } }] : []),
      { $sort: { seller_id: 1, computed_at: -1 } },
      { $group: { _id: '$seller_id', metrics: { $first: '$metrics' } } },
      { $match: match },
      { $project: { _id: 1 } },
    ]);
    return rows.map((r) => r._id);
  };

  const sellerFilter = async (f: SellerListFilter): Promise<Filter> => {
    const and: Filter[] = [];
    if (f.q?.trim()) {
      const term = contains(f.q);
      and.push({ $or: [{ store_name: term }, { legal_name: term }, { 'contact.email': term }, { ref: term }] });
    }
    if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
    if (f.verified !== undefined) and.push({ verification_state: f.verified ? 'verified' : { $ne: 'verified' } });
    if (f.categoryId) {
      // the seller's application lists the category (business.categoryIds @> [categoryId])
      const ids = await applications.distinct<string>('id', { 'business.categoryIds': f.categoryId });
      and.push({ application_id: { $in: ids } });
    }
    if (f.onTimeBelow !== undefined) {
      // the latest snapshot's dispatch reliability value is below the figure (no value: not below)
      const ids = await latestSnapshotMetric({ 'metrics.dispatch_reliability.value': { $type: 'number', $lt: f.onTimeBelow } });
      and.push({ id: { $in: ids } });
    }
    return and.length ? { $and: and } : {};
  };

  const repo: SellersRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoSellersRepository(tx))),

    /* ---------------------------------------------------------------- generic */
    get: (table, id, o) => t(table).get(id, o),
    getMany: (table, ids) => t(table).getMany([...new Set(ids)]),
    find: (table, w, o) => t(table).find(where(w as Record<string, unknown>), { sort: sortOf(o?.orderBy), limit: o?.limit, forUpdate: o?.forUpdate }),
    findOne: (table, w, o) => t(table).findOne(where(w as Record<string, unknown>), { sort: sortOf(o?.orderBy), forUpdate: o?.forUpdate }),
    count: (table, w) => t(table).count(where(w as Record<string, unknown>)),
    insert: (table, row) => t(table).insert(row),
    async update(table, id, patch) {
      const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
      const row = Object.keys(values).length ? await t(table).update(id, values) : await t(table).get(id);
      if (!row) throw new Error(`sellers: ${table} ${id} not found`);
      return row;
    },
    async remove(table, id) {
      await t(table).delete(id);
    },
    page: (table, w, page, order) => t(table).page(where(w as Record<string, unknown>), page, order),

    /* ---------------------------------------------------------------- store profiles */
    getProfile: (sellerId) => t('store_profiles').get(sellerId),
    upsertProfile: (row) => t('store_profiles').upsert(row),

    /* ---------------------------------------------------------------- sellers */
    sellerBySlug: (slug) => sellers.findOne({ slug }),
    sellersByStoreName: (name) => sellers.find({ store_name: { $regex: `^${escapeRegExp(name.trim())}$`, $options: 'i' } }),
    slugTaken: (slug) => sellers.exists({ slug }),
    async listSellers(filter, page) {
      const f = await sellerFilter(filter);
      if (filter.sort === 'name') return sellers.page(f, page, { column: 'store_name', direction: 'asc' });
      return sellers.page(f, page, { column: 'created_at', direction: 'desc' });
    },
    async allSellerIds(filter, limit) {
      return sellers.find(await sellerFilter(filter), { sort: { created_at: -1 }, limit });
    },
    async countSellersByStatus() {
      const rows = await sellers.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
      return Object.fromEntries(rows.map((r) => [r._id, r.n]));
    },
    countSellersCreatedSince: (since) => sellers.count({ approved_at: { $gte: since } }),
    async countBelowDispatch() {
      const ids = await latestSnapshotMetric({ 'metrics.dispatch_reliability.status': { $in: ['below', 'action_needed'] } });
      return ids.length ? sellers.count({ id: { $in: ids }, status: { $in: LIVE_STATUSES } }) : 0;
    },

    /* ---------------------------------------------------------------- applications */
    async listApplications(f: ApplicationListFilter, page) {
      const and: Filter[] = [{ submitted_at: { $ne: null } }, { decision_target_at: { $ne: null } }];
      if (f.state) and.push({ state: f.state });
      if (f.reviewerId) and.push({ reviewer_id: f.reviewerId });
      if (f.riskLevel) and.push({ id: { $in: await t('risk_reviews').distinct<string>('application_id', { level: f.riskLevel }) } });
      if (f.overdue !== undefined) {
        const open = { state: { $in: OPEN_APPLICATION_STATES }, decision_target_at: { $lt: f.now } };
        and.push(f.overdue ? open : { $nor: [open] });
      }
      if (f.q?.trim()) {
        const term = contains(f.q);
        and.push({ $or: [{ ref: term }, { 'account.storeName': term }, { 'business.legalName': term }, { 'account.contactName': term }] });
      }
      return applications.page({ $and: and }, page, { column: 'decision_target_at', direction: 'asc' });
    },
    latestApplicationOf: (accountId) => applications.findOne({ applicant_account_id: accountId }, { sort: { created_at: -1, id: -1 } }),
    async applicationsMatching(s, excludeId) {
      const lower = (path: string) => ({ $toLower: { $ifNull: [path, ''] } });
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
      if (!or.length) return [];
      return applications.find({ id: { $ne: excludeId }, $or: or }, { limit: 20 });
    },

    /* ---------------------------------------------------------------- members */
    activeMember: (sellerId, accountId) => t('members').findOne({ account_id: accountId, seller_id: sellerId, status: 'active' }),
    async seedTemplateGrants(rows) {
      await t('template_grants').insertManyIfAbsent(rows, ['template', 'permission']);
    },

    /* ---------------------------------------------------------------- performance */
    async insertPerformanceEvent(row) {
      // unique (kind, subject_id): a fact without a subject is always new (a null never conflicts)
      if (row.subject_id === null) {
        await events.insert(row);
        return true;
      }
      return Boolean(await events.insertIfAbsent(row, ['kind', 'subject_id']));
    },
    async performanceFacts(sellerId, since): Promise<PerformanceFacts[]> {
      const rows = await events.aggregate<{ _id: string; n: number; total: unknown }>([
        { $match: { seller_id: sellerId, occurred_at: { $gte: since } } },
        { $group: { _id: '$kind', n: { $sum: 1 }, total: { $sum: '$value' } } },
      ]);
      const out = rows.map((r) => ({ kind: r._id, n: r.n, total: num(r.total) }));
      const m = out.find((r) => r.kind === 'tracking_missing');
      if (m) {
        // missing tracking that was not confirmed valid later (a valid fact for the same shipment, any time)
        const missing = await events.find({ seller_id: sellerId, kind: 'tracking_missing', occurred_at: { $gte: since } });
        const subjects = [...new Set(missing.map((e) => e.subject_id).filter((s): s is string => s !== null))];
        const valid = new Set(subjects.length ? await events.distinct<string>('subject_id', { kind: 'tracking_valid', subject_id: { $in: subjects } }) : []);
        m.n = missing.filter((e) => e.subject_id === null || !valid.has(e.subject_id)).length;
      }
      return out;
    },
    async unresolvedCasesPastDeadline(sellerId, nowMs) {
      const opened = await events.find({ seller_id: sellerId, kind: 'case_opened' });
      // deadline: the value recorded with the case (epoch ms), else 48 hours after it opened
      const late = opened.filter((o) => (o.value !== null ? Number(o.value) : o.occurred_at.getTime() + 172_800_000) < nowMs);
      if (!late.length) return 0;
      const subjects = [...new Set(late.map((o) => o.subject_id).filter((s): s is string => s !== null))];
      const resolved = new Set(subjects.length ? await events.distinct<string>('subject_id', { kind: 'case_resolved', subject_id: { $in: subjects } }) : []);
      return late.filter((o) => o.subject_id === null || !resolved.has(o.subject_id)).length;
    },
    async latestSnapshots(sellerIds, perSeller): Promise<SnapshotRec[]> {
      if (!sellerIds.length) return [];
      const docs = await snapshots.aggregate([
        { $match: { seller_id: { $in: [...new Set(sellerIds)] } } },
        { $setWindowFields: { partitionBy: '$seller_id', sortBy: { computed_at: -1 }, output: { rn: { $documentNumber: {} } } } },
        { $match: { rn: { $lte: perSeller } } },
        { $sort: { seller_id: 1, computed_at: -1 } },
        { $unset: 'rn' },
      ]);
      return docs.map((d) => snapshots.fromDoc(d));
    },

    /* ---------------------------------------------------------------- jobs */
    async deleteDocumentsDue(today, limit) {
      const docs = t('application_documents');
      const rows = await docs.find({ delete_after: { $lte: today } }, { sort: { delete_after: 1 }, limit });
      if (rows.length) await docs.deleteMany({ id: { $in: rows.map((r) => r.id) } });
      return rows;
    },
  };
  return repo;
}
