import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { escapeRegExp } from '../../kernel/lib/text.js';
import { contains, equalsIgnoringCase, type Filter, type ModuleStore } from '../../kernel/mongo/index.js';
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

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...values] });

/** Restrictions in force at `now`: active, without an end or ending later */
const inForce = (now: Date): Filter => ({ state: 'active', $or: [{ ends_at: null }, { ends_at: { $gt: now } }] });

const owned = (owner: ViewOwner): Filter => ({ owner_kind: owner.kind, owner_id: owner.id });

/**
 * customers.customers, customers.addresses, customers.marketing_preferences, customers.consent_log,
 * customers.recently_viewed, customers.account_restrictions, customers.account_actions, customers.guest_buyers,
 * customers.customer_notes, customers.data_requests, customers.guest_lookup_attempts (MongoDB,
 * docs/04-mongodb-migration.md).
 */
export class CustomersRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
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
    return this.store.transaction((tx) => fn(new CustomersRepository(tx)));
  }

  /** Customers with their active blocks (a join is two reads: the customers, then their restrictions in force) */
  async #standingsOf(rows: CustomerRow[], now: Date): Promise<CustomerStanding[]> {
    if (!rows.length) return [];
    const restrictions = await this.#t.restrictions.find({ customer_id: oneOf(rows.map((r) => r.id)), scope: oneOf(['ordering', 'messaging', 'account']), ...inForce(now) });
    return rows.map((row) => {
      const own = restrictions.filter((r) => r.customer_id === row.id);
      const messaging = own.filter((r) => r.scope === 'messaging' || r.scope === 'account');
      const until = messaging.some((r) => r.ends_at === null) ? null : messaging.reduce<Date | null>((max, r) => (r.ends_at && (!max || r.ends_at > max) ? r.ends_at : max), null);
      return { row, orderBlock: own.some((r) => r.scope === 'ordering' || r.scope === 'account'), messageBlock: messaging.length > 0, messageBlockUntil: until };
    });
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
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

  findCustomerByEmail(email: string): Promise<CustomerRow | undefined> {
    return this.#t.customers.findOne({ email, account_status: { $ne: 'closed' } }, { sort: { created_at: 1 } });
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
    return Boolean(await this.#t.customers.insertIfAbsent(row, ['user_id']));
  }

  async updateCustomer(id: string, patch: Partial<CustomerRow>): Promise<CustomerRow> {
    return orThrow(await this.#t.customers.update(id, patch), `customers: customer ${id}`);
  }

  searchCustomers(f: CustomerSearch, page: PageRequest): Promise<common.Page<CustomerRow>> {
    const and: Filter[] = [];
    const term = f.q?.trim();
    if (term) {
      const digits = term.replace(/[^\d]/g, '');
      and.push({
        $or: [
          // first name and last name, as one text, contain the term
          { $expr: { $regexMatch: { input: { $concat: ['$first_name', ' ', '$last_name'] }, regex: escapeRegExp(term), options: 'i' } } },
          { email: contains(term) },
          { ref: equalsIgnoringCase(term) },
          // the phone's digits contain these digits (any separators between them)
          ...(digits.length >= 4 ? [{ phone: { $regex: digits.split('').join('[^0-9]*') } }] : []),
          ...(f.extraIds?.length ? [{ id: oneOf(f.extraIds) }] : []),
        ],
      });
    }
    if (f.onlyIds) and.push({ id: oneOf(f.onlyIds) });
    if (f.excludeIds?.length) and.push({ id: { $nin: f.excludeIds } });
    if (f.statuses?.length) and.push({ account_status: oneOf(f.statuses) });
    if (f.verification === 'not_verified') and.push({ email_verified_at: null });
    if (f.verification === 'email_only') and.push({ email_verified_at: { $ne: null }, phone_verified_at: null });
    if (f.verification === 'email_and_phone') and.push({ email_verified_at: { $ne: null }, phone_verified_at: { $ne: null } });
    if (f.joinedFrom || f.joinedTo) and.push({ created_at: { ...(f.joinedFrom ? { $gte: f.joinedFrom } : {}), ...(f.joinedTo ? { $lt: f.joinedTo } : {}) } });
    const filter = and.length ? { $and: and } : {};
    switch (f.sort) {
      case 'spend':
        return this.#t.customers.page(filter, page, { column: 'total_spend_minor', direction: 'desc' });
      case 'orders':
        return this.#t.customers.page(filter, page, { column: 'order_count', direction: 'desc' });
      case 'name':
        return this.#t.customers.page(filter, page, { column: 'last_name', direction: 'asc' });
      default:
        return this.#t.customers.page(filter, page, { column: 'created_at', direction: 'desc' });
    }
  }

  /* ---------------------------------------------------------------- addresses */
  // default first, then the most recently used (never used last), then the newest
  listAddresses(customerId: string): Promise<AddressRow[]> {
    return this.#t.addresses.find({ customer_id: customerId, deleted_at: null }, { sort: { is_default: -1, last_used_at: -1, created_at: -1 } });
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
    return customerIds.length ? this.#t.addresses.find({ customer_id: oneOf([...new Set(customerIds)]), is_default: true, deleted_at: null }) : [];
  }

  /** Overwrites personal fields of every address and soft-deletes them (closure) */
  async anonymiseAddresses(customerId: string, now: Date): Promise<void> {
    await this.#t.addresses.updateMany(
      { customer_id: customerId },
      { label: null, name: 'Removed', line1: 'Removed', line2: null, city: 'Removed', postal_code: '00000', phone: null, delivery_instructions: null, is_default: false, deleted_at: now, updated_at: now },
    );
  }

  /* ---------------------------------------------------------------- marketing consent */
  getPreferences(customerId: string): Promise<PreferencesRow | undefined> {
    return this.#t.preferences.get(customerId);
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
    const key = ['owner_kind', 'owner_id', 'product_id'];
    if (await this.#t.views.insertIfAbsent(row, key)) return;
    // the owner viewed it before: the newest view wins (viewed_at is the greatest; variant, title and image follow it)
    await this.#t.views.updateOne(
      { owner_kind: row.owner_kind, owner_id: row.owner_id, product_id: row.product_id, viewed_at: { $lte: row.viewed_at } },
      { viewed_at: row.viewed_at, variant_id: row.variant_id, title: row.title, image_media_id: row.image_media_id },
    );
  }

  listViews(owner: ViewOwner, limit: number): Promise<ViewRow[]> {
    return this.#t.views.find(owned(owner), { sort: { viewed_at: -1, id: -1 }, limit });
  }

  async trimViews(owner: ViewOwner, keep: number): Promise<number> {
    const keepIds = (await this.#t.views.find(owned(owner), { sort: { viewed_at: -1, id: -1 }, limit: keep })).map((v) => v.id);
    return this.#t.views.deleteMany({ ...owned(owner), id: { $nin: keepIds } });
  }

  deleteViews(owner: ViewOwner, productId?: string): Promise<number> {
    return this.#t.views.deleteMany({ ...owned(owner), ...(productId ? { product_id: productId } : {}) });
  }

  async repointProduct(from: string, to: string, variantId: string | null): Promise<number> {
    let moved = 0;
    for (;;) {
      const dups = await this.#t.views.find({ product_id: from }, { limit: 500 });
      if (!dups.length) return moved;
      const owners = [...new Set(dups.map((d) => d.owner_id))];
      const kept = await this.#t.views.find({ product_id: to, owner_id: oneOf(owners) });
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
    return this.#t.views.deleteMany({ $or: [{ viewed_at: { $lt: before } }, { owner_kind: 'guest', viewed_at: { $lt: guestBefore } }] });
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

  /** Active restrictions whose end has passed */
  dueRestrictions(now: Date, limit: number): Promise<RestrictionRow[]> {
    return this.#t.restrictions.find({ state: 'active', ends_at: { $ne: null, $lte: now } }, { sort: { ends_at: 1 }, limit });
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
    const and: Filter[] = [];
    const term = f.q?.trim();
    if (term) {
      and.push({ $or: [{ email_normalized: contains(term) }, { name: contains(term) }, { last_order_ref: equalsIgnoringCase(term) }] });
    }
    if (f.orderedFrom || f.orderedTo) and.push({ last_order_at: { ...(f.orderedFrom ? { $gte: f.orderedFrom } : {}), ...(f.orderedTo ? { $lt: f.orderedTo } : {}) } });
    return this.#t.guests.page(and.length ? { $and: and } : {}, page, { column: 'last_order_at', direction: 'desc' });
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
  openDataRequest(customerId: string, kind: 'export' | 'closure'): Promise<DataRequestRow | undefined> {
    return this.#t.dataRequests.findOne({ customer_id: customerId, kind, state: oneOf(kind === 'export' ? ['requested', 'processing', 'failed'] : ['requested']) });
  }

  countExportsSince(customerId: string, since: Date): Promise<number> {
    return this.#t.dataRequests.count({ customer_id: customerId, kind: 'export', state: { $ne: 'cancelled' }, requested_at: { $gte: since } });
  }

  // locked for this run (lock-by-write: a second run conflicts and retries after this one commits)
  /** Exports to build: requested ones and retried (processing) ones, oldest first, locked for this run */
  exportsToBuild(limit: number): Promise<DataRequestRow[]> {
    return this.#t.dataRequests.find({ kind: 'export', state: oneOf(['requested', 'processing']) }, { sort: { requested_at: 1 }, limit, forUpdate: true });
  }

  readyExportsExpiring(now: Date, limit: number): Promise<DataRequestRow[]> {
    return this.#t.dataRequests.find({ kind: 'export', state: 'ready', expires_at: { $lte: now } }, { sort: { expires_at: 1 }, limit });
  }

  closuresDue(now: Date, limit: number): Promise<DataRequestRow[]> {
    return this.#t.dataRequests.find({ kind: 'closure', state: 'requested', scheduled_for: { $lte: now } }, { sort: { scheduled_for: 1 }, limit });
  }

  async searchDataRequests(f: DataRequestSearch, page: PageRequest): Promise<common.Page<DataRequestRow & { customer_first_name: string; customer_last_name: string }>> {
    const result = await this.#t.dataRequests.page(
      {
        ...(f.kind ? { kind: f.kind } : {}),
        ...(f.state ? { state: f.state } : {}),
        ...(f.overdueAt ? { $and: [{ due_by: { $lt: f.overdueAt } }, { state: oneOf(['requested', 'processing', 'failed']) }] } : {}),
      },
      page,
      { column: 'due_by', direction: 'asc' },
    );
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
    return this.#t.lookups.count({ at: { $gte: since }, ...(by.emailHash ? { email_hash: by.emailHash } : {}), ...(by.ip ? { ip: by.ip } : {}) });
  }
}
