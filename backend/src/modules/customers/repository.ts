import { orThrow } from '../../kernel/lib/or-throw.js';
import type { KeysetOrder, PageRequest } from '../../kernel/lib/pagination.js';
import type { Store, StoreTable, WhereWithOr } from '../../kernel/store/index.js';
import type * as common from '../../spec/common.js';
import type {
  ActionRow,
  AddressRow,
  ConsentRow,
  CustomerRow,
  CustomerSearch,
  CustomerStanding,
  DataRequestRow,
  DataRequestSearch,
  GuestBuyerRow,
  GuestBuyerSearch,
  LookupAttemptRow,
  NoteRow,
  PreferencesRow,
  RestrictionRow,
  ViewOwner,
  ViewRow,
} from './ports.js';
import type { CustomersQueries } from './queries.js';

/** Restrictions in force at `now`: active, without an end or ending later */
const inForce = (now: Date): WhereWithOr<RestrictionRow> => ({ state: 'active', or: [{ ends_at: null }, { ends_at: { op: '>', value: now } }] });

const owned = (owner: ViewOwner): WhereWithOr<ViewRow> => ({ owner_kind: owner.kind, owner_id: owner.id });

/** The customer list's sort orders; `newest` is also what a missing or unknown sort means */
const CUSTOMER_ORDER: Record<string, KeysetOrder> = {
  spend: { column: 'total_spend_minor', direction: 'desc' },
  orders: { column: 'order_count', direction: 'desc' },
  name: { column: 'last_name', direction: 'asc' },
  newest: { column: 'created_at', direction: 'desc' },
};

/**
 * customers.customers, customers.addresses, customers.marketing_preferences, customers.consent_log,
 * customers.recently_viewed, customers.account_restrictions, customers.account_actions, customers.guest_buyers,
 * customers.customer_notes, customers.data_requests, customers.guest_lookup_attempts — in MySQL or in MongoDB,
 * whichever `MYSQL_MODULES` chose at boot (docs/10-mysql-migration.md §10.5, BUILDING-MODULES.md §5c).
 *
 * The staff search box is the one read that is not the same sentence in both databases; it lives in the
 * module's queries port (queries.ts) and the repository builds the rest of its filter as usual.
 */
export class CustomersRepository {
  readonly #t: {
    customers: StoreTable<CustomerRow>;
    addresses: StoreTable<AddressRow>;
    preferences: StoreTable<PreferencesRow>;
    consent: StoreTable<ConsentRow>;
    views: StoreTable<ViewRow>;
    restrictions: StoreTable<RestrictionRow>;
    actions: StoreTable<ActionRow>;
    guests: StoreTable<GuestBuyerRow>;
    notes: StoreTable<NoteRow>;
    dataRequests: StoreTable<DataRequestRow>;
    lookups: StoreTable<LookupAttemptRow>;
  };

  constructor(
    private readonly store: Store,
    private readonly queries: CustomersQueries,
  ) {
    this.#t = {
      customers: store.table<CustomerRow>('customers'),
      addresses: store.table<AddressRow>('addresses'),
      preferences: store.table<PreferencesRow>('marketing_preferences'),
      consent: store.table<ConsentRow>('consent_log'),
      views: store.table<ViewRow>('recently_viewed'),
      restrictions: store.table<RestrictionRow>('account_restrictions'),
      actions: store.table<ActionRow>('account_actions'),
      guests: store.table<GuestBuyerRow>('guest_buyers'),
      notes: store.table<NoteRow>('customer_notes'),
      dataRequests: store.table<DataRequestRow>('data_requests'),
      lookups: store.table<LookupAttemptRow>('guest_lookup_attempts'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<R>(fn: (tx: CustomersRepository) => Promise<R>): Promise<R> {
    return this.store.transaction((tx) => fn(new CustomersRepository(tx, this.queries)));
  }

  /** Customers with their active blocks (a join is two reads: the customers, then their restrictions in force) */
  async #standingsOf(rows: CustomerRow[], now: Date): Promise<CustomerStanding[]> {
    if (!rows.length) return [];
    const restrictions = await this.#t.restrictions.find({ customer_id: rows.map((r) => r.id), scope: ['ordering', 'messaging', 'reviews', 'account'], ...inForce(now) });
    return rows.map((row) => {
      const own = restrictions.filter((r) => r.customer_id === row.id);
      const messaging = own.filter((r) => r.scope === 'messaging' || r.scope === 'account');
      const until = messaging.some((r) => r.ends_at === null) ? null : messaging.reduce<Date | null>((max, r) => (r.ends_at && (!max || r.ends_at > max) ? r.ends_at : max), null);
      return { row, orderBlock: own.some((r) => r.scope === 'ordering' || r.scope === 'account'), messageBlock: messaging.length > 0, messageBlockUntil: until, reviewBlock: own.some((r) => r.scope === 'reviews' || r.scope === 'account') };
    });
  }

  /** Inbox (store.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ---------------------------------------------------------------- customers */
  getCustomer(id: string, o?: { forUpdate?: boolean }): Promise<CustomerRow | undefined> {
    return this.#t.customers.get(id, o);
  }

  getCustomerByUserId(userId: string, o?: { forUpdate?: boolean }): Promise<CustomerRow | undefined> {
    return this.#t.customers.findOne({ user_id: userId }, o);
  }

  async getCustomers(ids: readonly string[]): Promise<CustomerRow[]> {
    return ids.length ? this.#t.customers.getMany([...new Set(ids)]) : [];
  }

  // `<>` is the spec's reading (`account_status <> 'closed'`). account_status is NOT NULL, so it cannot be
  // told apart from `is not` here: no test can distinguish the two, and none pretends to
  findCustomerByEmail(email: string): Promise<CustomerRow | undefined> {
    return this.#t.customers.findOne({ email, account_status: { op: '<>', value: 'closed' } }, { sort: { created_at: 1 } });
  }

  async standingById(id: string, now: Date): Promise<CustomerStanding | undefined> {
    const row = await this.#t.customers.get(id);
    return row ? (await this.#standingsOf([row], now))[0] : undefined;
  }

  async standingByUserId(userId: string, now: Date): Promise<CustomerStanding | undefined> {
    const row = await this.#t.customers.findOne({ user_id: userId });
    return row ? (await this.#standingsOf([row], now))[0] : undefined;
  }

  async standings(ids: readonly string[], now: Date): Promise<CustomerStanding[]> {
    if (!ids.length) return [];
    return this.#standingsOf(await this.#t.customers.getMany([...new Set(ids)]), now);
  }

  /** Inserts unless the user already has a customer; true when inserted */
  async insertCustomer(row: CustomerRow): Promise<boolean> {
    // no key named: both stores then check every unique index the spec gives the table, which is the question
    // meant (user_id is unique, and so is ref — a row duplicating either is not one this wants inserted).
    // No test covers this, and none honestly can: only a race between two registrations of one account
    // reaches the absent branch, and a duplicate raised inside an event handler is logged rather than
    // returned, so the end state a test can see is the same either way. Naming a column that is not a key
    // *is* covered — MySQL refuses it by name, which is what tranche A's notifications hit.
    return Boolean(await this.#t.customers.insertIfAbsent(row));
  }

  async updateCustomer(id: string, patch: Partial<CustomerRow>): Promise<CustomerRow> {
    return orThrow(await this.#t.customers.update(id, patch), `customers: customer ${id}`);
  }

  searchCustomers(f: CustomerSearch, page: PageRequest): Promise<common.Page<CustomerRow>> {
    const where: WhereWithOr<CustomerRow> = {};
    // the conditions one object cannot hold two of: two dates on created_at, an id list beside onlyIds
    const and: WhereWithOr<CustomerRow>[] = [];
    // onlyIds is "these customers and no others", so an empty list is nobody — what an empty IN already means
    if (f.onlyIds) where.id = [...f.onlyIds];
    if (f.excludeIds?.length) and.push({ id: { op: 'not in', value: [...f.excludeIds] } });
    if (f.statuses?.length) where.account_status = [...f.statuses];
    // `is not` null is "has a value", which is what MongoDB's own `$ne: null` meant on these nullable
    // columns; `<>` null is SQL's reading of the same spelling and would match nothing at all
    if (f.verification === 'not_verified') where.email_verified_at = null;
    if (f.verification === 'email_only') {
      where.email_verified_at = { op: 'is not', value: null };
      where.phone_verified_at = null;
    }
    if (f.verification === 'email_and_phone') {
      where.email_verified_at = { op: 'is not', value: null };
      where.phone_verified_at = { op: 'is not', value: null };
    }
    if (f.joinedFrom) and.push({ created_at: { op: '>=', value: f.joinedFrom } });
    if (f.joinedTo) and.push({ created_at: { op: '<', value: f.joinedTo } });
    if (and.length) where.and = and;
    const order = CUSTOMER_ORDER[f.sort ?? 'newest'] ?? CUSTOMER_ORDER.newest!;
    const term = f.q?.trim();
    if (!term) return this.#t.customers.page(where, page, order);
    // the full name as one text, and the phone's digits whatever separates them: the module's queries port
    const digits = term.replace(/[^\d]/g, '');
    return this.queries.pageCustomersMatching(where, { text: term, digits: digits.length >= 4 ? digits : null, extraIds: f.extraIds ?? [] }, order, page);
  }

  /* ---------------------------------------------------------------- addresses */
  // default first, then the most recently used (never used last), then the newest
  listAddresses(customerId: string, o?: { forUpdate?: boolean }): Promise<AddressRow[]> {
    return this.#t.addresses.find({ customer_id: customerId, deleted_at: null }, { sort: { is_default: -1, last_used_at: -1, created_at: -1 }, forUpdate: o?.forUpdate });
  }

  getAddress(customerId: string, id: string, o?: { forUpdate?: boolean }): Promise<AddressRow | undefined> {
    return this.#t.addresses.findOne({ id, customer_id: customerId, deleted_at: null }, o);
  }

  countAddresses(customerId: string): Promise<number> {
    return this.#t.addresses.count({ customer_id: customerId, deleted_at: null });
  }

  insertAddress(row: AddressRow): Promise<AddressRow> {
    return this.#t.addresses.insert(row);
  }

  async updateAddress(id: string, patch: Partial<AddressRow>): Promise<AddressRow> {
    return orThrow(await this.#t.addresses.update(id, patch), `customers: address ${id}`);
  }

  async clearDefaultAddress(customerId: string, now: Date): Promise<void> {
    await this.#t.addresses.updateMany({ customer_id: customerId, is_default: true }, { is_default: false, updated_at: now });
  }

  async defaultAddresses(customerIds: readonly string[]): Promise<AddressRow[]> {
    return customerIds.length ? this.#t.addresses.find({ customer_id: [...new Set(customerIds)], is_default: true, deleted_at: null }) : [];
  }

  /**
   * Addresses for the geocoding backfill: never geocoded, or not placed and last tried before `retryBefore`.
   * Defaults first (they are the customers' locations), oldest first; `skip` leaves out ones already tried this run.
   */
  addressesToGeocode(retryBefore: Date, limit: number, skip: readonly string[] = []): Promise<AddressRow[]> {
    return this.#t.addresses.find(
      { deleted_at: null, or: [{ geocoded_at: null }, { lat: null, geocoded_at: { op: '<', value: retryBefore } }], ...(skip.length ? { id: { op: 'not in', value: [...skip] } } : {}) },
      { sort: { is_default: -1, created_at: 1 }, limit },
    );
  }

  /** Overwrites personal fields of every address and soft-deletes them (closure) */
  async anonymiseAddresses(customerId: string, now: Date): Promise<void> {
    await this.#t.addresses.updateMany(
      { customer_id: customerId },
      { label: null, name: 'Removed', line1: 'Removed', line2: null, city: 'Removed', postal_code: '00000', phone: null, delivery_instructions: null, lat: null, lng: null, geocode_precision: null, is_default: false, deleted_at: now, updated_at: now },
    );
  }

  /* ---------------------------------------------------------------- marketing consent */
  getPreferences(customerId: string, o?: { forUpdate?: boolean }): Promise<PreferencesRow | undefined> {
    return this.#t.preferences.get(customerId, o);
  }

  upsertPreferences(row: PreferencesRow): Promise<PreferencesRow> {
    return this.#t.preferences.upsert(row);
  }

  async insertConsent(rows: ConsentRow[]): Promise<void> {
    await this.#t.consent.insertMany(rows);
  }

  consentLog(customerId: string): Promise<ConsentRow[]> {
    return this.#t.consent.find({ customer_id: customerId }, { sort: { at: -1, id: -1 } });
  }

  /* ---------------------------------------------------------------- recently viewed */
  async upsertView(row: ViewRow): Promise<void> {
    // no key named: both stores check every unique index the spec gives the table, and
    // (owner_kind, owner_id, product_id) is the only one besides the primary key, which a fresh id cannot hit
    if (await this.#t.views.insertIfAbsent(row)) return;
    // the owner viewed it before: the newest view wins (viewed_at is the greatest; variant, title and image follow it)
    await this.#t.views.updateOne(
      { owner_kind: row.owner_kind, owner_id: row.owner_id, product_id: row.product_id, viewed_at: { op: '<=', value: row.viewed_at } },
      { viewed_at: row.viewed_at, variant_id: row.variant_id, title: row.title, image_media_id: row.image_media_id },
    );
  }

  listViews(owner: ViewOwner, limit: number): Promise<ViewRow[]> {
    return this.#t.views.find(owned(owner), { sort: { viewed_at: -1, id: -1 }, limit });
  }

  /** Keeps the owner's `keep` newest views; usually there is nothing past them, and one read says so */
  async trimViews(owner: ViewOwner, keep: number): Promise<number> {
    // `keep + 1` rows rather than the one row at offset `keep`: StoreFindOptions.skip is MongoDB's spelling
    // and the MySQL table reads `offset`, so a `skip` here is silently dropped on MySQL (reported)
    const rows = await this.#t.views.find(owned(owner), { sort: { viewed_at: -1, id: -1 }, limit: keep + 1 });
    const first = rows[keep];
    if (!first) return 0;
    // the first view past the kept ones and every older one, in the same (viewed_at, id) order
    return this.#t.views.deleteMany({ ...owned(owner), or: [{ viewed_at: { op: '<', value: first.viewed_at } }, { viewed_at: first.viewed_at, id: { op: '<=', value: first.id } }] });
  }

  deleteViews(owner: ViewOwner, productId?: string): Promise<number> {
    return this.#t.views.deleteMany({ ...owned(owner), ...(productId ? { product_id: productId } : {}) });
  }

  async repointProduct(from: string, to: string, variantId: string | null): Promise<number> {
    let moved = 0;
    for (;;) {
      // read for update: every row of both batches is written back in this transaction (§11.2 rule 1)
      const dups = await this.#t.views.find({ product_id: from }, { limit: 500, forUpdate: true });
      if (!dups.length) return moved;
      const owners = [...new Set(dups.map((d) => d.owner_id))];
      const kept = await this.#t.views.find({ product_id: to, owner_id: owners }, { forUpdate: true });
      const keptBy = new Map(kept.map((k) => [`${k.owner_kind}:${k.owner_id}`, k]));
      for (const d of dups) {
        const k = keptBy.get(`${d.owner_kind}:${d.owner_id}`);
        if (k) {
          // the owner viewed both: one row stays, with the newest view
          if (d.viewed_at > k.viewed_at) await this.#t.views.update(k.id, { viewed_at: d.viewed_at });
          await this.#t.views.delete(d.id);
        } else {
          await this.#t.views.update(d.id, { product_id: to, variant_id: variantId });
        }
        moved++;
      }
    }
  }

  pruneViews(before: Date, guestBefore: Date): Promise<number> {
    return this.#t.views.deleteMany({ or: [{ viewed_at: { op: '<', value: before } }, { owner_kind: 'guest', viewed_at: { op: '<', value: guestBefore } }] });
  }

  /* ---------------------------------------------------------------- restrictions */
  listRestrictions(customerId: string, o?: { activeAt?: Date }): Promise<RestrictionRow[]> {
    return this.#t.restrictions.find({ customer_id: customerId, ...(o?.activeAt ? inForce(o.activeAt) : {}) }, { sort: { starts_at: -1, id: -1 } });
  }

  getRestriction(customerId: string, id: string, o?: { forUpdate?: boolean }): Promise<RestrictionRow | undefined> {
    return this.#t.restrictions.findOne({ id, customer_id: customerId }, o);
  }

  findRestrictionByEnforcement(customerId: string, enforcementId: string): Promise<RestrictionRow | undefined> {
    return this.#t.restrictions.findOne({ customer_id: customerId, trust_enforcement_id: enforcementId });
  }

  /** Active restrictions a trust enforcement created, any customer */
  activeRestrictionsByEnforcement(enforcementId: string): Promise<RestrictionRow[]> {
    return this.#t.restrictions.find({ trust_enforcement_id: enforcementId, state: 'active' });
  }

  insertRestriction(row: RestrictionRow): Promise<RestrictionRow> {
    return this.#t.restrictions.insert(row);
  }

  async updateRestriction(id: string, patch: Partial<RestrictionRow>): Promise<RestrictionRow> {
    return orThrow(await this.#t.restrictions.update(id, patch), `customers: restriction ${id}`);
  }

  /**
   * Active restrictions whose end has passed. The filter was `{ $ne: null, $lte: now }`; the `$ne: null` is
   * what MongoDB needed spelling out and SQL never did — a comparison against a date matches no null on
   * either store (kernel/store/store.test.ts proves it on both), so `<=` alone reads the same rows.
   *
   * No test of this module can tell: `expireRestrictions` re-reads each row under its lock and skips it
   * unless `!cur.ends_at || cur.ends_at > now` is false, so this filter narrows the batch and cannot change
   * the outcome — deleting the comparison altogether leaves every test green.
   */
  dueRestrictions(now: Date, limit: number): Promise<RestrictionRow[]> {
    return this.#t.restrictions.find({ state: 'active', ends_at: { op: '<=', value: now } }, { sort: { ends_at: 1 }, limit });
  }

  countActiveRestrictions(customerId: string, now: Date): Promise<number> {
    return this.#t.restrictions.count({ customer_id: customerId, ...inForce(now) });
  }

  /* ---------------------------------------------------------------- actions and notes */
  insertAction(row: ActionRow): Promise<ActionRow> {
    return this.#t.actions.insert(row);
  }

  listActions(customerId: string, page: PageRequest): Promise<common.Page<ActionRow>> {
    return this.#t.actions.page({ customer_id: customerId }, page, { column: 'at', direction: 'desc' });
  }

  recentActions(customerId: string, limit: number): Promise<ActionRow[]> {
    return this.#t.actions.find({ customer_id: customerId }, { sort: { at: -1, id: -1 }, limit });
  }

  insertNote(row: NoteRow): Promise<NoteRow> {
    return this.#t.notes.insert(row);
  }

  listNotes(customerId: string): Promise<NoteRow[]> {
    return this.#t.notes.find({ customer_id: customerId }, { sort: { created_at: -1, id: -1 } });
  }

  /* ---------------------------------------------------------------- guest buyers */
  getGuestBuyer(emailNormalized: string, o?: { forUpdate?: boolean }): Promise<GuestBuyerRow | undefined> {
    return this.#t.guests.findOne({ email_normalized: emailNormalized }, o);
  }

  async insertGuestBuyer(row: GuestBuyerRow): Promise<void> {
    await this.#t.guests.insert(row);
  }

  async updateGuestBuyer(id: string, patch: Partial<GuestBuyerRow>): Promise<void> {
    await this.#t.guests.update(id, patch);
  }

  deleteGuestBuyer(emailNormalized: string): Promise<number> {
    return this.#t.guests.deleteMany({ email_normalized: emailNormalized });
  }

  listGuestBuyers(f: GuestBuyerSearch, page: PageRequest): Promise<common.Page<GuestBuyerRow>> {
    const where: WhereWithOr<GuestBuyerRow> = {};
    const term = f.q?.trim();
    // three per-column conditions, each of which the vocabulary says literally: no concatenation here
    if (term) where.or = [{ email_normalized: { op: 'contains', value: term } }, { name: { op: 'contains', value: term } }, { last_order_ref: { op: 'equals ignoring case', value: term } }];
    // two conditions on last_order_at, which one object cannot hold
    const and: WhereWithOr<GuestBuyerRow>[] = [];
    if (f.orderedFrom) and.push({ last_order_at: { op: '>=', value: f.orderedFrom } });
    if (f.orderedTo) and.push({ last_order_at: { op: '<', value: f.orderedTo } });
    if (and.length) where.and = and;
    return this.#t.guests.page(where, page, { column: 'last_order_at', direction: 'desc' });
  }

  /* ---------------------------------------------------------------- data requests */
  insertDataRequest(row: DataRequestRow): Promise<DataRequestRow> {
    return this.#t.dataRequests.insert(row);
  }

  getDataRequest(id: string, o?: { customerId?: string; forUpdate?: boolean }): Promise<DataRequestRow | undefined> {
    return this.#t.dataRequests.findOne({ id, ...(o?.customerId ? { customer_id: o.customerId } : {}) }, { forUpdate: o?.forUpdate });
  }

  async updateDataRequest(id: string, patch: Partial<DataRequestRow>): Promise<DataRequestRow> {
    return orThrow(await this.#t.dataRequests.update(id, patch), `customers: data request ${id}`);
  }

  listDataRequests(customerId: string): Promise<DataRequestRow[]> {
    return this.#t.dataRequests.find({ customer_id: customerId }, { sort: { requested_at: -1, id: -1 } });
  }

  /** The open request of a kind (requested or processing; failed exports count as open too) */
  openDataRequest(customerId: string, kind: 'export' | 'closure', o?: { forUpdate?: boolean }): Promise<DataRequestRow | undefined> {
    return this.#t.dataRequests.findOne({ customer_id: customerId, kind, state: kind === 'export' ? ['requested', 'processing', 'failed'] : ['requested'] }, o);
  }

  // `<>` is the spec's reading and `state` is NOT NULL, so `is not` would count the same rows: no test can
  // tell the two apart here
  countExportsSince(customerId: string, since: Date): Promise<number> {
    return this.#t.dataRequests.count({ customer_id: customerId, kind: 'export', state: { op: '<>', value: 'cancelled' }, requested_at: { op: '>=', value: since } });
  }

  // locked for this run (lock-by-write: a second run conflicts and retries after this one commits)
  /** Exports to build: requested ones and retried (processing) ones, oldest first, locked for this run */
  exportsToBuild(limit: number): Promise<DataRequestRow[]> {
    return this.#t.dataRequests.find({ kind: 'export', state: ['requested', 'processing'] }, { sort: { requested_at: 1 }, limit, forUpdate: true });
  }

  readyExportsExpiring(now: Date, limit: number): Promise<DataRequestRow[]> {
    return this.#t.dataRequests.find({ kind: 'export', state: 'ready', expires_at: { op: '<=', value: now } }, { sort: { expires_at: 1 }, limit });
  }

  closuresDue(now: Date, limit: number): Promise<DataRequestRow[]> {
    return this.#t.dataRequests.find({ kind: 'closure', state: 'requested', scheduled_for: { op: '<=', value: now } }, { sort: { scheduled_for: 1 }, limit });
  }

  async searchDataRequests(f: DataRequestSearch, page: PageRequest): Promise<common.Page<DataRequestRow & { customer_first_name: string; customer_last_name: string }>> {
    const where: WhereWithOr<DataRequestRow> = {};
    if (f.kind) where.kind = f.kind;
    if (f.state) where.state = f.state;
    // `state` a second time, which one object cannot hold: overdue is "past due and still open"
    if (f.overdueAt) where.and = [{ due_by: { op: '<', value: f.overdueAt } }, { state: ['requested', 'processing', 'failed'] }];
    const result = await this.#t.dataRequests.page(where, page, { column: 'due_by', direction: 'asc' });
    // the customer's name (an inner join: every request has its customer)
    const customers = new Map((await this.getCustomers(result.items.map((r) => r.customer_id))).map((c) => [c.id, c]));
    return {
      ...result,
      items: result.items.flatMap((r) => {
        const c = customers.get(r.customer_id);
        return c ? [{ ...r, customer_first_name: c.first_name, customer_last_name: c.last_name }] : [];
      }),
    };
  }

  /* ---------------------------------------------------------------- guest order lookups */
  async insertLookupAttempt(row: LookupAttemptRow): Promise<void> {
    await this.#t.lookups.insert(row);
  }

  countLookupAttempts(by: { emailHash?: string; ip?: string }, since: Date): Promise<number> {
    return this.#t.lookups.count({ at: { op: '>=', value: since }, ...(by.emailHash ? { email_hash: by.emailHash } : {}), ...(by.ip ? { ip: by.ip } : {}) });
  }
}
