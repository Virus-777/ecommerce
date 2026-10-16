import type { PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import { contains, equalsIgnoringCase, whereFilter, type Filter, type ModuleStore, type Sort, type Table as MongoTable, type Where } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type {
  ApplicationListFilter,
  ApplicationRec,
  Db,
  DocumentRec,
  IdTable,
  MemberRec,
  PerfEventRec,
  PerformanceFacts,
  ProfileRec,
  SellerListFilter,
  SellerRec,
  SnapshotRec,
  Table,
  TemplateGrantRec,
} from './ports.js';

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined): Sort | undefined =>
  orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

/** Decimal128 (raw aggregation values) or a number as a JS number */
const num = (v: unknown) => (v == null ? 0 : Number(String(v)));

/** Seller statuses whose dispatch performance counts (countBelowDispatch) */
const LIVE_STATUSES = ['approved', 'restricted', 'suspended'];
const OPEN_APPLICATION_STATES = ['submitted', 'under_review', 'information_required'];

/**
 * The sellers module's collections (MongoDB, docs/04-mongodb-migration.md): generic access by table name for the
 * simple reads and writes, and named queries for the rest. `Where` conditions keep SQL's meaning of null
 * (kernel whereFilter).
 */
export class SellersRepository {
  constructor(private readonly store: ModuleStore) {}

  transaction<R>(fn: (tx: SellersRepository) => Promise<R>): Promise<R> {
    return this.store.transaction((tx) => fn(new SellersRepository(tx)));
  }

  #t<T extends Table>(name: T): MongoTable<Db[T]> {
    return this.store.table<Db[T]>(name);
  }

  /** seller ids by their latest performance snapshot (DISTINCT ON (seller_id) … ORDER BY computed_at DESC) */
  async #latestSnapshotMetric(match: Filter, sellerIds?: string[]): Promise<string[]> {
    const rows = await this.#t('performance_snapshots').aggregate<{ _id: string }>([
      ...(sellerIds ? [{ $match: { seller_id: { $in: sellerIds } } }] : []),
      { $sort: { seller_id: 1, computed_at: -1 } },
      { $group: { _id: '$seller_id', metrics: { $first: '$metrics' } } },
      { $match: match },
      { $project: { _id: 1 } },
    ]);
    return rows.map((r) => r._id);
  }

  async #sellerFilter(f: SellerListFilter): Promise<Filter> {
    const and: Filter[] = [];
    if (f.q?.trim()) {
      const term = contains(f.q);
      and.push({ $or: [{ store_name: term }, { legal_name: term }, { 'contact.email': term }, { ref: term }] });
    }
    if (f.statuses?.length) and.push({ status: { $in: f.statuses } });
    if (f.verified !== undefined) and.push({ verification_state: f.verified ? 'verified' : { $ne: 'verified' } });
    if (f.categoryId) {
      // the seller's application lists the category (business.categoryIds @> [categoryId])
      const ids = await this.#t('applications').distinct<string>('id', { 'business.categoryIds': f.categoryId });
      and.push({ application_id: { $in: ids } });
    }
    if (f.onTimeBelow !== undefined) {
      // the latest snapshot's dispatch reliability value is below the figure (no value: not below)
      const ids = await this.#latestSnapshotMetric({ 'metrics.dispatch_reliability.value': { $type: 'number', $lt: f.onTimeBelow } });
      and.push({ id: { $in: ids } });
    }
    return and.length ? { $and: and } : {};
  }

  /* ---------------------------------------------------------------- generic table access */

  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined> {
    return this.#t(table).get(id, o);
  }

  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]> {
    return this.#t(table).getMany([...new Set(ids)]);
  }

  find<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]> {
    return this.#t(table).find(whereFilter(where), { sort: sortOf(o?.orderBy), limit: o?.limit, forUpdate: o?.forUpdate });
  }

  findOne<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined> {
    return this.#t(table).findOne(whereFilter(where), { sort: sortOf(o?.orderBy), forUpdate: o?.forUpdate });
  }

  count<T extends Table>(table: T, where: Where<Db[T]>): Promise<number> {
    return this.#t(table).count(whereFilter(where));
  }

  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]> {
    return this.#t(table).insert(row);
  }

  async update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]> {
    const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
    const row = Object.keys(values).length ? await this.#t(table).update(id, values) : await this.#t(table).get(id);
    return orThrow(row, `sellers: ${table} ${id}`);
  }

  async remove<T extends IdTable>(table: T, id: string): Promise<void> {
    await this.#t(table).delete(id);
  }

  page<T extends Table>(table: T, where: Where<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc' }): Promise<common.Page<Db[T]>> {
    return this.#t(table).page(whereFilter(where), page, order);
  }

  /* ---------------------------------------------------------------- store profiles */

  getProfile(sellerId: string): Promise<ProfileRec | undefined> {
    return this.#t('store_profiles').get(sellerId);
  }

  getProfiles(sellerIds: readonly string[]): Promise<ProfileRec[]> {
    return this.#t('store_profiles').getMany([...new Set(sellerIds)]);
  }

  upsertProfile(row: ProfileRec): Promise<ProfileRec> {
    return this.#t('store_profiles').upsert(row);
  }

  /* ---------------------------------------------------------------- sellers */

  sellerBySlug(slug: string): Promise<SellerRec | undefined> {
    return this.#t('sellers').findOne({ slug });
  }

  sellersByStoreName(name: string): Promise<SellerRec[]> {
    return this.#t('sellers').find({ store_name: equalsIgnoringCase(name.trim()) });
  }

  slugTaken(slug: string): Promise<boolean> {
    return this.#t('sellers').exists({ slug });
  }

  async listSellers(filter: SellerListFilter, page: PageRequest): Promise<common.Page<SellerRec>> {
    const f = await this.#sellerFilter(filter);
    if (filter.sort === 'name') return this.#t('sellers').page(f, page, { column: 'store_name', direction: 'asc' });
    return this.#t('sellers').page(f, page, { column: 'created_at', direction: 'desc' });
  }

  async allSellerIds(filter: SellerListFilter, limit: number): Promise<SellerRec[]> {
    return this.#t('sellers').find(await this.#sellerFilter(filter), { sort: { created_at: -1 }, limit });
  }

  async countSellersByStatus(): Promise<Record<string, number>> {
    const rows = await this.#t('sellers').aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }

  countSellersCreatedSince(since: Date): Promise<number> {
    return this.#t('sellers').count({ approved_at: { $gte: since } });
  }

  async countBelowDispatch(): Promise<number> {
    const ids = await this.#latestSnapshotMetric({ 'metrics.dispatch_reliability.status': { $in: ['below', 'action_needed'] } });
    return ids.length ? this.#t('sellers').count({ id: { $in: ids }, status: { $in: LIVE_STATUSES } }) : 0;
  }

  /* ---------------------------------------------------------------- applications */

  async listApplications(f: ApplicationListFilter, page: PageRequest): Promise<common.Page<ApplicationRec>> {
    const and: Filter[] = [{ submitted_at: { $ne: null } }, { decision_target_at: { $ne: null } }];
    if (f.state) and.push({ state: f.state });
    if (f.reviewerId) and.push({ reviewer_id: f.reviewerId });
    if (f.riskLevel) and.push({ id: { $in: await this.#t('risk_reviews').distinct<string>('application_id', { level: f.riskLevel }) } });
    if (f.overdue !== undefined) {
      const open = { state: { $in: OPEN_APPLICATION_STATES }, decision_target_at: { $lt: f.now } };
      and.push(f.overdue ? open : { $nor: [open] });
    }
    if (f.q?.trim()) {
      const term = contains(f.q);
      and.push({ $or: [{ ref: term }, { 'account.storeName': term }, { 'business.legalName': term }, { 'account.contactName': term }] });
    }
    return this.#t('applications').page({ $and: and }, page, { column: 'decision_target_at', direction: 'asc' });
  }

  latestApplicationOf(accountId: string): Promise<ApplicationRec | undefined> {
    return this.#t('applications').findOne({ applicant_account_id: accountId }, { sort: { created_at: -1, id: -1 } });
  }

  /** Other applications (any state, so closed sellers too) sharing a work email, payout token, business or return address, or tax id hash */
  async applicationsMatching(
    s: { emails: string[]; tokens: string[]; addresses: { line1: string; postalCode: string }[]; taxIdHashes?: string[] },
    excludeId: string,
  ): Promise<ApplicationRec[]> {
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
    return this.#t('applications').find({ id: { $ne: excludeId }, $or: or }, { limit: 20 });
  }

  /* ---------------------------------------------------------------- members */

  activeMember(sellerId: string, accountId: string): Promise<MemberRec | undefined> {
    return this.#t('members').findOne({ account_id: accountId, seller_id: sellerId, status: 'active' });
  }

  /** Seeds template grants (domain/seed.ts) that are not there yet, by (template, permission); safe on concurrent starts */
  async seedTemplateGrants(rows: readonly TemplateGrantRec[]): Promise<void> {
    await this.#t('template_grants').insertManyIfAbsent(rows, ['template', 'permission']);
  }

  /* ---------------------------------------------------------------- performance */

  async insertPerformanceEvent(row: PerfEventRec): Promise<boolean> {
    const events = this.#t('performance_events');
    // unique (kind, subject_id): a fact without a subject is always new (a null never conflicts)
    if (row.subject_id === null) {
      await events.insert(row);
      return true;
    }
    return Boolean(await events.insertIfAbsent(row, ['kind', 'subject_id']));
  }

  /** Count and value total per kind since a time (`kinds`: only those kinds) */
  async performanceFacts(sellerId: string, since: Date, kinds?: readonly PerfEventRec['kind'][]): Promise<PerformanceFacts[]> {
    const events = this.#t('performance_events');
    const rows = await events.aggregate<{ _id: string; n: number; total: unknown }>([
      { $match: { seller_id: sellerId, ...(kinds ? { kind: { $in: [...kinds] } } : {}), occurred_at: { $gte: since } } },
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
  }

  async unresolvedCasesPastDeadline(sellerId: string, nowMs: number): Promise<number> {
    const events = this.#t('performance_events');
    const opened = await events.find({ seller_id: sellerId, kind: 'case_opened' });
    // deadline: the value recorded with the case (epoch ms), else 48 hours after it opened
    const late = opened.filter((o) => (o.value !== null ? Number(o.value) : o.occurred_at.getTime() + 172_800_000) < nowMs);
    if (!late.length) return 0;
    const subjects = [...new Set(late.map((o) => o.subject_id).filter((s): s is string => s !== null))];
    const resolved = new Set(subjects.length ? await events.distinct<string>('subject_id', { kind: 'case_resolved', subject_id: { $in: subjects } }) : []);
    return late.filter((o) => o.subject_id === null || !resolved.has(o.subject_id)).length;
  }

  async latestSnapshots(sellerIds: readonly string[], perSeller: number): Promise<SnapshotRec[]> {
    if (!sellerIds.length) return [];
    const snapshots = this.#t('performance_snapshots');
    const docs = await snapshots.aggregate([
      { $match: { seller_id: { $in: [...new Set(sellerIds)] } } },
      { $setWindowFields: { partitionBy: '$seller_id', sortBy: { computed_at: -1 }, output: { rn: { $documentNumber: {} } } } },
      { $match: { rn: { $lte: perSeller } } },
      { $sort: { seller_id: 1, computed_at: -1 } },
      { $unset: 'rn' },
    ]);
    return docs.map((d) => snapshots.fromDoc(d));
  }

  /* ---------------------------------------------------------------- jobs */

  async deleteDocumentsDue(today: string, limit: number): Promise<DocumentRec[]> {
    const docs = this.#t('application_documents');
    const rows = await docs.find({ delete_after: { $lte: today } }, { sort: { delete_after: 1 }, limit });
    if (rows.length) await docs.deleteMany({ id: { $in: rows.map((r) => r.id) } });
    return rows;
  }
}
