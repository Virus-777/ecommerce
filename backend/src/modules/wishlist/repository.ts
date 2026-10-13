import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { AlertCandidate, AlertRow, ItemRow, ListRow, ListWithCount, WishlistRepository } from './ports.js';

/** MongoDB adapter for WishlistRepository (docs/04-mongodb-migration.md): wishlist.lists, wishlist.items, wishlist.alerts. */
export function createMongoWishlistRepository(store: ModuleStore): WishlistRepository {
  const t = {
    lists: store.table<ListRow>('lists'),
    items: store.table<ItemRow>('items'),
    alerts: store.table<AlertRow>('alerts'),
  };

  /** Alerts with the saved offer of their item (a left join: two reads) */
  async function withItemOffer(alerts: AlertRow[]): Promise<AlertCandidate[]> {
    const itemIds = [...new Set(alerts.map((a) => a.item_id).filter((id): id is string => id !== null))];
    const offers = new Map((await t.items.getMany(itemIds)).map((i) => [i.id, i.offer_id]));
    return alerts.map((a) => ({ ...a, item_offer_id: a.item_id ? (offers.get(a.item_id) ?? null) : null }));
  }

  const repo: WishlistRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoWishlistRepository(tx))),
    claim: (key) => store.claim(key),

    /* ---------------------------------------------------------------- lists */
    async ensureDefaultList(row) {
      // one default list per customer (unique customer_id where is_default): on conflict do nothing
      // (outside a transaction two concurrent upserts can still race to a duplicate key: the other one won)
      await t.lists.insertIfAbsent(row, ['customer_id', 'is_default']).catch((err: unknown) => {
        if (store.inTransaction || (err as { code?: number }).code !== 11000) throw err;
      });
      return (await t.lists.findOne({ customer_id: row.customer_id, is_default: true }))!;
    },
    getList: (customerId, id, lock) => t.lists.findOne({ id, customer_id: customerId }, { forUpdate: lock?.forUpdate }),
    getListByShareToken: (token) => t.lists.findOne({ share_token: token }),
    async listLists(customerId) {
      const lists = await t.lists.find({ customer_id: customerId }, { sort: { is_default: -1, created_at: 1, id: 1 } });
      const counts = new Map(
        (await t.items.aggregate<{ _id: string; n: number }>([{ $match: { list_id: { $in: lists.map((l) => l.id) } } }, { $group: { _id: '$list_id', n: { $sum: 1 } } }])).map((r) => [r._id, r.n]),
      );
      return lists.map((l): ListWithCount => ({ ...l, item_count: counts.get(l.id) ?? 0 }));
    },
    countLists: (customerId) => t.lists.count({ customer_id: customerId }),
    insertList: (row) => t.lists.insert(row),
    updateList: async (id, patch) => (await t.lists.update(id, patch))!,
    async deleteList(id) {
      await t.lists.delete(id);
    },

    /* ---------------------------------------------------------------- items */
    getItem: (customerId, id, lock) => t.items.findOne({ id, customer_id: customerId }, { forUpdate: lock?.forUpdate }),
    findItem: (listId, productId, variantId) => t.items.findOne({ list_id: listId, product_id: productId, variant_id: variantId }),
    async findCustomerItem(customerId, productId, variantId) {
      // default list first, then the oldest (a join on lists in SQL: two reads)
      const items = await t.items.find({ customer_id: customerId, product_id: productId, variant_id: variantId }, { sort: { added_at: 1 } });
      if (items.length <= 1) return items[0];
      const defaults = new Set((await t.lists.find({ id: { $in: [...new Set(items.map((i) => i.list_id))] }, is_default: true })).map((l) => l.id));
      return items.find((i) => defaults.has(i.list_id)) ?? items[0];
    },
    countItems: (listId) => t.items.count({ list_id: listId }),
    insertItem: (row) => t.items.insert(row),
    updateItem: async (id, patch) => (await t.items.update(id, patch))!,
    async deleteItem(id) {
      await t.items.delete(id);
    },
    pageItems: (listId, page) => t.items.page({ list_id: listId }, page, { column: 'added_at', direction: 'desc' }),
    allItems: (listId, limit) => t.items.find({ list_id: listId }, { sort: { added_at: -1, id: -1 }, limit }),
    savedProductIds: (customerId, productIds) => t.items.distinct<string>('product_id', { customer_id: customerId, product_id: { $in: productIds } }),
    async countSavers(productId) {
      return (await t.items.distinct('customer_id', { product_id: productId })).length;
    },
    itemsOfProduct: (productId) => t.items.find({ product_id: productId }),
    clearOffer: (offerId) => t.items.updateMany({ offer_id: offerId }, { offer_id: null }),
    async productIdsForVariant(variantId) {
      const fromAlerts = await t.alerts.distinct<string>('product_id', { variant_id: variantId });
      const fromItems = await t.items.distinct<string>('product_id', { variant_id: variantId });
      return [...new Set([...fromAlerts, ...fromItems])];
    },

    /* ---------------------------------------------------------------- alerts */
    getAlert: (customerId, id, lock) => t.alerts.findOne({ id, customer_id: customerId }, { forUpdate: lock?.forUpdate }),
    getAlertById: (id, lock) => t.alerts.get(id, { forUpdate: lock?.forUpdate }),
    alertsOfItems: (itemIds) => t.alerts.find({ item_id: { $in: itemIds }, state: { $ne: 'removed' } }),
    pageAlerts: (customerId, state, page) => t.alerts.page({ customer_id: customerId, state: state ?? { $ne: 'removed' } }, page, { column: 'created_at', direction: 'desc' }),
    allAlerts: (customerId, limit) => t.alerts.find({ customer_id: customerId, state: { $ne: 'removed' } }, { sort: { created_at: -1, id: -1 }, limit }),
    countActiveAlerts: (customerId) => t.alerts.count({ customer_id: customerId, state: 'active' }),
    findEquivalentAlert: (customerId, a) =>
      t.alerts.findOne(
        { customer_id: customerId, product_id: a.productId, kind: a.kind, state: { $ne: 'removed' }, variant_id: a.variantId, seller_id: a.sellerId },
        { sort: { created_at: 1 } },
      ),
    insertAlert: (row) => t.alerts.insert(row),
    updateAlert: async (id, patch) => (await t.alerts.update(id, patch))!,
    removeAlertsOfItem: (itemId) => t.alerts.updateMany({ item_id: itemId }, { state: 'removed', item_id: null }),
    async candidates(productId, kind, states) {
      return withItemOffer(await t.alerts.find({ product_id: productId, state: { $in: states }, ...(kind ? { kind } : {}) }, { sort: { id: 1 } }));
    },
    dueForRearm: (before, limit) =>
      t.alerts.find({ kind: 'price_drop', state: 'triggered', $or: [{ last_notified_at: null }, { last_notified_at: { $lte: before } }] }, { sort: { id: 1 }, limit }),
    async customersPausedFor(reason, limit) {
      const rows = await t.alerts.aggregate<{ _id: string }>([
        { $match: { state: 'paused', paused_reason: reason } },
        { $group: { _id: '$customer_id' } },
        { $sort: { _id: 1 } },
        { $limit: limit },
      ]);
      return rows.map((r) => r._id);
    },
    pausedFor: (customerId, reason) => t.alerts.find({ customer_id: customerId, state: 'paused', paused_reason: reason }),
    async activeAlertsAfter(kind, afterId, limit) {
      return withItemOffer(await t.alerts.find({ kind, state: 'active', ...(afterId ? { id: { $gt: afterId } } : {}) }, { sort: { id: 1 }, limit }));
    },

    /* ---------------------------------------------------------------- customer data */
    async customerData(customerIds) {
      const lists = await t.lists.find({ customer_id: { $in: customerIds } }, { sort: { created_at: 1, id: 1 } });
      const items = await t.items.find({ customer_id: { $in: customerIds } }, { sort: { added_at: 1, id: 1 } });
      const alerts = await t.alerts.find({ customer_id: { $in: customerIds }, state: { $ne: 'removed' } }, { sort: { created_at: 1, id: 1 } });
      return { lists, items, alerts };
    },
    async deleteCustomerData(customerIds) {
      const alerts = await t.alerts.deleteMany({ customer_id: { $in: customerIds } });
      const items = await t.items.deleteMany({ customer_id: { $in: customerIds } });
      const lists = await t.lists.deleteMany({ customer_id: { $in: customerIds } });
      return { alerts, items, lists };
    },

    /* ---------------------------------------------------------------- insights */
    async insights({ from, to, limit }) {
      const added = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
      const savedRows = await t.items.aggregate<{ _id: string; saves: number }>([
        ...(from || to ? [{ $match: { added_at: added } }] : []),
        { $group: { _id: { p: '$product_id', c: '$customer_id' } } },
        { $group: { _id: '$_id.p', saves: { $sum: 1 } } },
      ]);
      const alertRows = await t.alerts.aggregate<{ _id: string; price: number; stock: number }>([
        { $match: { state: 'active' } },
        {
          $group: {
            _id: '$product_id',
            price: { $sum: { $cond: [{ $eq: ['$kind', 'price_drop'] }, 1, 0] } },
            stock: { $sum: { $cond: [{ $eq: ['$kind', 'back_in_stock'] }, 1, 0] } },
          },
        },
      ]);
      const out = new Map<string, { product_id: string; saves: number; active_price_alerts: number; active_stock_alerts: number }>();
      const row = (id: string) => {
        let r = out.get(id);
        if (!r) out.set(id, (r = { product_id: id, saves: 0, active_price_alerts: 0, active_stock_alerts: 0 }));
        return r;
      };
      for (const s of savedRows) row(s._id).saves = s.saves;
      for (const a of alertRows) {
        const r = row(a._id);
        r.active_price_alerts = a.price;
        r.active_stock_alerts = a.stock;
      }
      return [...out.values()]
        .sort((a, b) => b.saves - a.saves || b.active_price_alerts + b.active_stock_alerts - (a.active_price_alerts + a.active_stock_alerts) || a.product_id.localeCompare(b.product_id))
        .slice(0, limit);
    },
  };
  return repo;
}
