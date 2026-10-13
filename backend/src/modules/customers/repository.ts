import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type {
  ActionRow,
  AddressRow,
  ConsentRow,
  CustomerRow,
  CustomersRepository,
  CustomerStanding,
  DataRequestRow,
  GuestBuyerRow,
  LookupAttemptRow,
  NoteRow,
  PreferencesRow,
  RestrictionRow,
  ViewOwner,
  ViewRow,
} from './ports.js';

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...values] });
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** SQL `like '%x%'` on a column (case-sensitive, as LIKE is) */
const contains = (x: string) => ({ $regex: escapeRegExp(x) });
/** SQL `lower(col) = lower(x)` */
const equalsIgnoringCase = (x: string) => ({ $regex: `^${escapeRegExp(x)}$`, $options: 'i' });

function found<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`customers: ${what} not found`);
  return row;
}

/** Restrictions in force at `now`: active, without an end or ending later */
const inForce = (now: Date): Filter => ({ state: 'active', $or: [{ ends_at: null }, { ends_at: { $gt: now } }] });

/** MongoDB adapter for CustomersRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoCustomersRepository(store: ModuleStore): CustomersRepository {
  const t = {
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

  /** Customers with their active blocks (a join is two reads: the customers, then their restrictions in force) */
  async function standingsOf(rows: CustomerRow[], now: Date): Promise<CustomerStanding[]> {
    if (!rows.length) return [];
    const restrictions = await t.restrictions.find({ customer_id: oneOf(rows.map((r) => r.id)), scope: oneOf(['ordering', 'messaging', 'account']), ...inForce(now) });
    return rows.map((row) => {
      const own = restrictions.filter((r) => r.customer_id === row.id);
      const messaging = own.filter((r) => r.scope === 'messaging' || r.scope === 'account');
      const until = messaging.some((r) => r.ends_at === null) ? null : messaging.reduce<Date | null>((max, r) => (r.ends_at && (!max || r.ends_at > max) ? r.ends_at : max), null);
      return { row, orderBlock: own.some((r) => r.scope === 'ordering' || r.scope === 'account'), messageBlock: messaging.length > 0, messageBlockUntil: until };
    });
  }
  const owned = (owner: ViewOwner): Filter => ({ owner_kind: owner.kind, owner_id: owner.id });

  const repo: CustomersRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoCustomersRepository(tx))),
    claim: (key) => store.claim(key),

    /* ---------------------------------------------------------------- customers */
    getCustomer: (id, o) => t.customers.get(id, o),
    getCustomerByUserId: (userId, o) => t.customers.findOne({ user_id: userId }, o),
    getCustomers: async (ids) => (ids.length ? t.customers.getMany([...new Set(ids)]) : []),
    findCustomerByEmail: (email) => t.customers.findOne({ email, account_status: { $ne: 'closed' } }, { sort: { created_at: 1 } }),
    async standingById(id, now) {
      const row = await t.customers.get(id);
      return row ? (await standingsOf([row], now))[0] : undefined;
    },
    async standingByUserId(userId, now) {
      const row = await t.customers.findOne({ user_id: userId });
      return row ? (await standingsOf([row], now))[0] : undefined;
    },
    async standings(ids, now) {
      if (!ids.length) return [];
      return standingsOf(await t.customers.getMany([...new Set(ids)]), now);
    },
    async insertCustomer(row) {
      return Boolean(await t.customers.insertIfAbsent(row, ['user_id']));
    },
    updateCustomer: async (id, patch) => found(await t.customers.update(id, patch), `customer ${id}`),
    searchCustomers(f, page) {
      const and: Filter[] = [];
      const term = f.q?.trim();
      if (term) {
        const lower = term.toLowerCase();
        const digits = term.replace(/[^\d]/g, '');
        and.push({
          $or: [
            // lower(first_name || ' ' || last_name) like '%term%'
            { $expr: { $regexMatch: { input: { $concat: ['$first_name', ' ', '$last_name'] }, regex: escapeRegExp(lower), options: 'i' } } },
            // email is stored lower-case
            { email: contains(lower) },
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
          return t.customers.page(filter, page, { column: 'total_spend_minor', direction: 'desc' });
        case 'orders':
          return t.customers.page(filter, page, { column: 'order_count', direction: 'desc' });
        case 'name':
          return t.customers.page(filter, page, { column: 'last_name', direction: 'asc' });
        default:
          return t.customers.page(filter, page, { column: 'created_at', direction: 'desc' });
      }
    },

    /* ---------------------------------------------------------------- addresses */
    // default first, then the most recently used (never used last), then the newest
    listAddresses: (customerId) => t.addresses.find({ customer_id: customerId, deleted_at: null }, { sort: { is_default: -1, last_used_at: -1, created_at: -1 } }),
    getAddress: (customerId, id, o) => t.addresses.findOne({ id, customer_id: customerId, deleted_at: null }, o),
    countAddresses: (customerId) => t.addresses.count({ customer_id: customerId, deleted_at: null }),
    insertAddress: (row) => t.addresses.insert(row),
    updateAddress: async (id, patch) => found(await t.addresses.update(id, patch), `address ${id}`),
    async clearDefaultAddress(customerId, now) {
      await t.addresses.updateMany({ customer_id: customerId, is_default: true }, { is_default: false, updated_at: now });
    },
    defaultAddresses: async (customerIds) => (customerIds.length ? t.addresses.find({ customer_id: oneOf([...new Set(customerIds)]), is_default: true, deleted_at: null }) : []),
    async anonymiseAddresses(customerId, now) {
      await t.addresses.updateMany(
        { customer_id: customerId },
        { label: null, name: 'Removed', line1: 'Removed', line2: null, city: 'Removed', postal_code: '00000', phone: null, delivery_instructions: null, is_default: false, deleted_at: now, updated_at: now },
      );
    },

    /* ---------------------------------------------------------------- marketing consent */
    getPreferences: (customerId) => t.preferences.get(customerId),
    upsertPreferences: (row) => t.preferences.upsert(row),
    async insertConsent(rows) {
      await t.consent.insertMany(rows);
    },
    consentLog: (customerId) => t.consent.find({ customer_id: customerId }, { sort: { at: -1, id: -1 } }),

    /* ---------------------------------------------------------------- recently viewed */
    async upsertView(row) {
      const key = ['owner_kind', 'owner_id', 'product_id'];
      if (await t.views.insertIfAbsent(row, key)) return;
      // the owner viewed it before: the newest view wins (viewed_at is the greatest; variant, title and image follow it)
      await t.views.updateOne(
        { owner_kind: row.owner_kind, owner_id: row.owner_id, product_id: row.product_id, viewed_at: { $lte: row.viewed_at } },
        { viewed_at: row.viewed_at, variant_id: row.variant_id, title: row.title, image_media_id: row.image_media_id },
      );
    },
    listViews: (owner, limit) => t.views.find(owned(owner), { sort: { viewed_at: -1, id: -1 }, limit }),
    async trimViews(owner, keep) {
      const keepIds = (await t.views.find(owned(owner), { sort: { viewed_at: -1, id: -1 }, limit: keep })).map((v) => v.id);
      return t.views.deleteMany({ ...owned(owner), id: { $nin: keepIds } });
    },
    deleteViews: (owner, productId) => t.views.deleteMany({ ...owned(owner), ...(productId ? { product_id: productId } : {}) }),
    async repointProduct(from, to, variantId) {
      let moved = 0;
      for (;;) {
        const dups = await t.views.find({ product_id: from }, { limit: 500 });
        if (!dups.length) return moved;
        const owners = [...new Set(dups.map((d) => d.owner_id))];
        const kept = await t.views.find({ product_id: to, owner_id: oneOf(owners) });
        const keptBy = new Map(kept.map((k) => [`${k.owner_kind}:${k.owner_id}`, k]));
        for (const d of dups) {
          const k = keptBy.get(`${d.owner_kind}:${d.owner_id}`);
          if (k) {
            // the owner viewed both: one row stays, with the newest view
            if (d.viewed_at > k.viewed_at) await t.views.update(k.id, { viewed_at: d.viewed_at });
            await t.views.delete(d.id);
          } else {
            await t.views.update(d.id, { product_id: to, variant_id: variantId });
          }
          moved++;
        }
      }
    },
    pruneViews: (before, guestBefore) => t.views.deleteMany({ $or: [{ viewed_at: { $lt: before } }, { owner_kind: 'guest', viewed_at: { $lt: guestBefore } }] }),

    /* ---------------------------------------------------------------- restrictions */
    listRestrictions: (customerId, o) => t.restrictions.find({ customer_id: customerId, ...(o?.activeAt ? inForce(o.activeAt) : {}) }, { sort: { starts_at: -1, id: -1 } }),
    getRestriction: (customerId, id, o) => t.restrictions.findOne({ id, customer_id: customerId }, o),
    findRestrictionByEnforcement: (customerId, enforcementId) => t.restrictions.findOne({ customer_id: customerId, trust_enforcement_id: enforcementId }),
    activeRestrictionsByEnforcement: (enforcementId) => t.restrictions.find({ trust_enforcement_id: enforcementId, state: 'active' }),
    insertRestriction: (row) => t.restrictions.insert(row),
    updateRestriction: async (id, patch) => found(await t.restrictions.update(id, patch), `restriction ${id}`),
    dueRestrictions: (now, limit) => t.restrictions.find({ state: 'active', ends_at: { $ne: null, $lte: now } }, { sort: { ends_at: 1 }, limit }),
    countActiveRestrictions: (customerId, now) => t.restrictions.count({ customer_id: customerId, ...inForce(now) }),

    /* ---------------------------------------------------------------- actions and notes */
    insertAction: (row) => t.actions.insert(row),
    listActions: (customerId, page) => t.actions.page({ customer_id: customerId }, page, { column: 'at', direction: 'desc' }),
    recentActions: (customerId, limit) => t.actions.find({ customer_id: customerId }, { sort: { at: -1, id: -1 }, limit }),
    insertNote: (row) => t.notes.insert(row),
    listNotes: (customerId) => t.notes.find({ customer_id: customerId }, { sort: { created_at: -1, id: -1 } }),

    /* ---------------------------------------------------------------- guest buyers */
    getGuestBuyer: (emailNormalized, o) => t.guests.findOne({ email_normalized: emailNormalized }, o),
    async insertGuestBuyer(row) {
      await t.guests.insert(row);
    },
    async updateGuestBuyer(id, patch) {
      await t.guests.update(id, patch);
    },
    deleteGuestBuyer: (emailNormalized) => t.guests.deleteMany({ email_normalized: emailNormalized }),
    listGuestBuyers(f, page) {
      const and: Filter[] = [];
      const term = f.q?.trim();
      if (term) {
        const lower = term.toLowerCase();
        and.push({ $or: [{ email_normalized: contains(lower) }, { name: { $regex: escapeRegExp(lower), $options: 'i' } }, { last_order_ref: equalsIgnoringCase(term) }] });
      }
      if (f.orderedFrom || f.orderedTo) and.push({ last_order_at: { ...(f.orderedFrom ? { $gte: f.orderedFrom } : {}), ...(f.orderedTo ? { $lt: f.orderedTo } : {}) } });
      return t.guests.page(and.length ? { $and: and } : {}, page, { column: 'last_order_at', direction: 'desc' });
    },

    /* ---------------------------------------------------------------- data requests */
    insertDataRequest: (row) => t.dataRequests.insert(row),
    getDataRequest: (id, o) => t.dataRequests.findOne({ id, ...(o?.customerId ? { customer_id: o.customerId } : {}) }, { forUpdate: o?.forUpdate }),
    updateDataRequest: async (id, patch) => found(await t.dataRequests.update(id, patch), `data request ${id}`),
    listDataRequests: (customerId) => t.dataRequests.find({ customer_id: customerId }, { sort: { requested_at: -1, id: -1 } }),
    openDataRequest: (customerId, kind) =>
      t.dataRequests.findOne({ customer_id: customerId, kind, state: oneOf(kind === 'export' ? ['requested', 'processing', 'failed'] : ['requested']) }),
    countExportsSince: (customerId, since) => t.dataRequests.count({ customer_id: customerId, kind: 'export', state: { $ne: 'cancelled' }, requested_at: { $gte: since } }),
    // locked for this run (lock-by-write: a second run conflicts and retries after this one commits)
    exportsToBuild: (limit) => t.dataRequests.find({ kind: 'export', state: oneOf(['requested', 'processing']) }, { sort: { requested_at: 1 }, limit, forUpdate: true }),
    readyExportsExpiring: (now, limit) => t.dataRequests.find({ kind: 'export', state: 'ready', expires_at: { $lte: now } }, { sort: { expires_at: 1 }, limit }),
    closuresDue: (now, limit) => t.dataRequests.find({ kind: 'closure', state: 'requested', scheduled_for: { $lte: now } }, { sort: { scheduled_for: 1 }, limit }),
    async searchDataRequests(f, page) {
      const result = await t.dataRequests.page(
        {
          ...(f.kind ? { kind: f.kind } : {}),
          ...(f.state ? { state: f.state } : {}),
          ...(f.overdueAt ? { $and: [{ due_by: { $lt: f.overdueAt } }, { state: oneOf(['requested', 'processing', 'failed']) }] } : {}),
        },
        page,
        { column: 'due_by', direction: 'asc' },
      );
      // the customer's name (an inner join: every request has its customer)
      const customers = new Map((await repo.getCustomers(result.items.map((r) => r.customer_id))).map((c) => [c.id, c]));
      return {
        ...result,
        items: result.items.flatMap((r) => {
          const c = customers.get(r.customer_id);
          return c ? [{ ...r, customer_first_name: c.first_name, customer_last_name: c.last_name }] : [];
        }),
      };
    },

    /* ---------------------------------------------------------------- guest order lookups */
    async insertLookupAttempt(row) {
      await t.lookups.insert(row);
    },
    countLookupAttempts: (by, since) =>
      t.lookups.count({ at: { $gte: since }, ...(by.emailHash ? { email_hash: by.emailHash } : {}), ...(by.ip ? { ip: by.ip } : {}) }),
  };
  return repo;
}
