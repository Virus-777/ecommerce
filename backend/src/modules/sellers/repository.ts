import type { PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import type { Patch, Store, StoreTable, WhereWithOr } from '../../kernel/store/index.js';
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
import type { ApplicationSignals, SellersQueries } from './queries.js';

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

const sortOf = (orderBy: [string, 'asc' | 'desc'][] | undefined): Record<string, 1 | -1> | undefined =>
  orderBy?.length ? Object.fromEntries(orderBy.map(([c, d]) => [c, d === 'desc' ? -1 : 1])) : undefined;

/** Seller statuses whose dispatch performance counts (countBelowDispatch) */
const LIVE_STATUSES = ['approved', 'restricted', 'suspended'];
const OPEN_APPLICATION_STATES = ['submitted', 'under_review', 'information_required'];

/**
 * The sellers module's tables, in whichever database holds this module's data (`ctx.store`,
 * BUILDING-MODULES §5c): generic access by table name for the simple reads and writes, and named methods for
 * the rest. Conditions are the neutral vocabulary, which keeps SQL's meaning of null on both stores.
 *
 * The reads that are not the same question in both databases — the two admin lists' search boxes, the
 * category filter, the latest snapshot per seller, the latest N snapshots, the duplicate-application check
 * and the performance facts per kind — are the queries port (queries.ts). It is passed down to the
 * transaction clone, although none of those reads happens inside a transaction today.
 */
export class SellersRepository {
  constructor(
    private readonly store: Store,
    private readonly queries: SellersQueries,
  ) {}

  transaction<R>(fn: (tx: SellersRepository) => Promise<R>): Promise<R> {
    return this.store.transaction((tx) => fn(new SellersRepository(tx, this.queries)));
  }

  #t<T extends Table>(name: T): StoreTable<Db[T]> {
    return this.store.table<Db[T]>(name);
  }

  /**
   * The admin seller list's filter, apart from the search box: the term is the queries port's, because
   * `contact.email` is a path inside a JSON document and a case-insensitive match on one is not in the
   * vocabulary (queries.ts). Each branch is about a different column, so one object says all of them.
   */
  async #sellerFilter(f: SellerListFilter): Promise<WhereWithOr<SellerRec>> {
    const where: WhereWithOr<SellerRec> = {};
    if (f.statuses?.length) where.status = f.statuses;
    // "not verified" is every state that is not `verified`. `verification_state` is NOT NULL, so `<>` and
    // `is not` cannot be told apart here and no test can: the plain comparison is the spec's reading.
    if (f.verified !== undefined) where.verification_state = f.verified ? 'verified' : { op: '<>', value: 'verified' };
    // the seller's application lists the category; an empty list matches nothing, as `$in: []` did
    if (f.categoryId) where.application_id = await this.queries.applicationIdsInCategory(f.categoryId);
    // the latest snapshot's dispatch reliability value is below the figure (no value: not below)
    if (f.onTimeBelow !== undefined) where.id = await this.queries.sellerIdsWithDispatchValueBelow(f.onTimeBelow);
    return where;
  }

  /* ---------------------------------------------------------------- generic table access */

  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined> {
    return this.#t(table).get(id, o);
  }

  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]> {
    return this.#t(table).getMany([...new Set(ids)]);
  }

  find<T extends Table>(table: T, where: WhereWithOr<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]> {
    return this.#t(table).find(where, { sort: sortOf(o?.orderBy), limit: o?.limit, forUpdate: o?.forUpdate });
  }

  findOne<T extends Table>(table: T, where: WhereWithOr<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined> {
    return this.#t(table).findOne(where, { sort: sortOf(o?.orderBy), forUpdate: o?.forUpdate });
  }

  count<T extends Table>(table: T, where: WhereWithOr<Db[T]>): Promise<number> {
    return this.#t(table).count(where);
  }

  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]> {
    return this.#t(table).insert(row);
  }

  async update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]> {
    const values = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
    const row = Object.keys(values).length ? await this.#t(table).update(id, values as Patch<Db[T]>) : await this.#t(table).get(id);
    return orThrow(row, `sellers: ${table} ${id}`);
  }

  async remove<T extends IdTable>(table: T, id: string): Promise<void> {
    await this.#t(table).delete(id);
  }

  page<T extends Table>(table: T, where: WhereWithOr<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc' }): Promise<common.Page<Db[T]>> {
    return this.#t(table).page(where, page, order);
  }

  /* ---------------------------------------------------------------- store profiles */

  getProfile(sellerId: string, o?: { forUpdate?: boolean }): Promise<ProfileRec | undefined> {
    return this.#t('store_profiles').get(sellerId, o);
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
    return this.#t('sellers').find({ store_name: { op: 'equals ignoring case', value: name.trim() } });
  }

  slugTaken(slug: string): Promise<boolean> {
    return this.#t('sellers').exists({ slug });
  }

  /**
   * The seller search box: the names, the contact email inside the `contact` document, and the reference.
   * One `or` of `contains` conditions, which both stores answer the same way — the collation does the case on
   * MySQL and a case-insensitive regex does it on MongoDB (§10.5e). It took a per-store query until the
   * vocabulary could say `contains` of a path into a document.
   */
  #sellerTerm(text: string): WhereWithOr<SellerRec> {
    const has = { op: 'contains' as const, value: text };
    return { or: [{ store_name: has }, { legal_name: has }, { 'contact.email': has }, { ref: has }] };
  }

  async listSellers(filter: SellerListFilter, page: PageRequest): Promise<common.Page<SellerRec>> {
    const where = await this.#sellerFilter(filter);
    const order = filter.sort === 'name' ? ({ column: 'store_name', direction: 'asc' } as const) : ({ column: 'created_at', direction: 'desc' } as const);
    const term = filter.q?.trim();
    return this.#t('sellers').page(term ? { and: [where, this.#sellerTerm(term)] } : where, page, order);
  }

  async allSellerIds(filter: SellerListFilter, limit: number): Promise<SellerRec[]> {
    const where = await this.#sellerFilter(filter);
    const term = filter.q?.trim();
    return this.#t('sellers').find(term ? { and: [where, this.#sellerTerm(term)] } : where, { sort: { created_at: -1 }, limit });
  }

  async countSellersByStatus(): Promise<Record<string, number>> {
    const rows = await this.#t('sellers').countBy(['status']);
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  countSellersCreatedSince(since: Date): Promise<number> {
    return this.#t('sellers').count({ approved_at: { op: '>=', value: since } });
  }

  async countBelowDispatch(): Promise<number> {
    const ids = await this.queries.sellerIdsWithDispatchStatusIn(['below', 'action_needed']);
    return ids.length ? this.#t('sellers').count({ id: ids, status: LIVE_STATUSES }) : 0;
  }

  /* ---------------------------------------------------------------- applications */

  async listApplications(f: ApplicationListFilter, page: PageRequest): Promise<common.Page<ApplicationRec>> {
    const and: WhereWithOr<ApplicationRec>[] = [];
    if (f.overdue !== undefined) {
      const open: WhereWithOr<ApplicationRec> = { state: OPEN_APPLICATION_STATES, decision_target_at: { op: '<', value: f.now } };
      // "not overdue" is the complement of that pair, which `$nor` said in one word and the neutral
      // vocabulary has no word for: De Morgan's law, and sound here because both columns are non-null on
      // every row this list can return (`state` is NOT NULL, and `decision_target_at` is filtered below).
      and.push(f.overdue ? open : { or: [{ state: { op: 'not in', value: OPEN_APPLICATION_STATES } }, { decision_target_at: { op: '>=', value: f.now } }] });
    }
    const where: WhereWithOr<ApplicationRec> = {
      submitted_at: { op: 'is not', value: null },
      decision_target_at: { op: 'is not', value: null },
      ...(f.state ? { state: f.state } : {}),
      ...(f.reviewerId ? { reviewer_id: f.reviewerId } : {}),
      ...(f.riskLevel ? { id: await this.#t('risk_reviews').distinct<string>('application_id', { level: f.riskLevel }) } : {}),
      ...(and.length ? { and } : {}),
    };
    const term = f.q?.trim();
    // the term searches three fields inside JSON documents as well as the reference, which the vocabulary
    // says since `contains` works on a path (§10.5e); it was a per-store query until then
    const has = { op: 'contains' as const, value: term ?? '' };
    const matching: WhereWithOr<ApplicationRec> = { or: [{ ref: has }, { 'account.storeName': has }, { 'business.legalName': has }, { 'account.contactName': has }] };
    return this.#t('applications').page(term ? { and: [where, matching] } : where, page, { column: 'decision_target_at', direction: 'asc' });
  }

  latestApplicationOf(accountId: string): Promise<ApplicationRec | undefined> {
    return this.#t('applications').findOne({ applicant_account_id: accountId }, { sort: { created_at: -1, id: -1 } });
  }

  /** Other applications (any state, so closed sellers too) sharing a work email, payout token, business or return address, or tax id hash */
  applicationsMatching(s: ApplicationSignals, excludeId: string): Promise<ApplicationRec[]> {
    if (!s.emails.length && !s.tokens.length && !s.addresses.length && !s.taxIdHashes?.length) return Promise.resolve([]);
    // every signal is sayable now that a path takes `equals ignoring case` and a list (§10.5e): an address
    // is a postal code *and* a line, of one element of the `or`, which is why each pair is its own branch
    const or: WhereWithOr<ApplicationRec>[] = [];
    // the application steps store `account.workEmail` lower-cased already (service/applications.ts), so this
    // is belt and braces — and it is what the filter means rather than what the data happens to be
    for (const email of s.emails) or.push({ 'account.workEmail': { op: 'equals ignoring case', value: email } });
    if (s.tokens.length) or.push({ 'payout.current.providerDestinationId': [...s.tokens] }, { 'payout.pendingChange.providerDestinationId': [...s.tokens] });
    for (const a of s.addresses) {
      const line = { op: 'equals ignoring case' as const, value: a.line1.trim() };
      or.push({ 'business.address.postalCode': a.postalCode.trim(), 'business.address.line1': line });
      or.push({ 'return_address.address.postalCode': a.postalCode.trim(), 'return_address.address.line1': line });
    }
    if (s.taxIdHashes?.length) or.push({ tax_id_hash: [...s.taxIdHashes] });
    return this.#t('applications').find({ id: { op: '<>', value: excludeId }, or }, { limit: 20 });
  }

  /* ---------------------------------------------------------------- members */

  activeMember(sellerId: string, accountId: string): Promise<MemberRec | undefined> {
    return this.#t('members').findOne({ account_id: accountId, seller_id: sellerId, status: 'active' });
  }

  /** Seeds template grants (domain/seed.ts) that are not there yet, by (template, permission); safe on concurrent starts */
  async seedTemplateGrants(rows: readonly TemplateGrantRec[]): Promise<void> {
    // no key named: both stores then check every unique index the spec gives the table, which here is the one
    // on (template, permission) and is the question meant (§5c)
    await this.#t('template_grants').insertManyIfAbsent(rows);
  }

  /* ---------------------------------------------------------------- performance */

  async insertPerformanceEvent(row: PerfEventRec): Promise<boolean> {
    const events = this.#t('performance_events');
    // unique (kind, subject_id): a fact without a subject is always new (a null never conflicts — MongoDB's
    // index is partial on a subject_id that is there, and a MySQL unique key ignores a NULL)
    if (row.subject_id === null) {
      await events.insert(row);
      return true;
    }
    // No key is named, so both stores check every unique index the spec gives the table — here the one above,
    // which is the question meant (§5c). Replacing this with a plain `insert` fails no test, because the
    // unique index refuses the duplicate either way: what `insertIfAbsent` adds is a quiet `false` in place
    // of a thrown duplicate-key error inside the event subscriber, and nothing asserts on that difference.
    return Boolean(await events.insertIfAbsent(row));
  }

  /** Count and value total per kind since a time (`kinds`: only those kinds) */
  async performanceFacts(sellerId: string, since: Date, kinds?: readonly PerfEventRec['kind'][]): Promise<PerformanceFacts[]> {
    const out = await this.queries.performanceFactsByKind(sellerId, since, kinds);
    const m = out.find((r) => r.kind === 'tracking_missing');
    if (m) {
      // missing tracking that was not confirmed valid later (a valid fact for the same shipment, any time)
      const events = this.#t('performance_events');
      const missing = await events.find({ seller_id: sellerId, kind: 'tracking_missing', occurred_at: { op: '>=', value: since } });
      const subjects = [...new Set(missing.map((e) => e.subject_id).filter((s): s is string => s !== null))];
      const valid = new Set(subjects.length ? await events.distinct<string>('subject_id', { kind: 'tracking_valid', subject_id: subjects }) : []);
      m.n = missing.filter((e) => e.subject_id === null || !valid.has(e.subject_id)).length;
    }
    return out;
  }

  async unresolvedCasesPastDeadline(sellerId: string, nowMs: number): Promise<number> {
    const events = this.#t('performance_events');
    const opened = await events.find({ seller_id: sellerId, kind: 'case_opened' });
    // deadline: the value recorded with the case (epoch **seconds**, its milliseconds the fraction — see
    // service/performance.ts onCaseOpened, and `value` is DECIMAL(14,4)), else 48 hours after it opened
    const late = opened.filter((o) => (o.value !== null ? Math.round(Number(o.value) * 1000) : o.occurred_at.getTime() + 172_800_000) < nowMs);
    if (!late.length) return 0;
    const subjects = [...new Set(late.map((o) => o.subject_id).filter((s): s is string => s !== null))];
    const resolved = new Set(subjects.length ? await events.distinct<string>('subject_id', { kind: 'case_resolved', subject_id: subjects }) : []);
    return late.filter((o) => o.subject_id === null || !resolved.has(o.subject_id)).length;
  }

  latestSnapshots(sellerIds: readonly string[], perSeller: number): Promise<SnapshotRec[]> {
    if (!sellerIds.length) return Promise.resolve([]);
    return this.queries.latestSnapshots(sellerIds, perSeller);
  }

  /* ---------------------------------------------------------------- jobs */

  async deleteDocumentsDue(today: string, limit: number): Promise<DocumentRec[]> {
    const docs = this.#t('application_documents');
    const rows = await docs.find({ delete_after: { op: '<=', value: today } }, { sort: { delete_after: 1 }, limit });
    if (rows.length) await docs.deleteMany({ id: rows.map((r) => r.id) });
    return rows;
  }
}
