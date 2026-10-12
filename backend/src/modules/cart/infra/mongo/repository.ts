import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter } from '../../../../kernel/mongo/table.js';
import type { CartAggregate, CartRepository, CartRow, ItemRow, MergeRow, NoticeRow, OwnerKey, QueueRow, SavedRow } from '../../ports.js';

/** MongoDB adapter for CartRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoCartRepository(store: ModuleStore): CartRepository {
  const t = {
    carts: store.table<CartRow>('carts'),
    items: store.table<ItemRow>('cart_items'),
    notices: store.table<NoticeRow>('cart_item_notices'),
    saved: store.table<SavedRow>('saved_items'),
    merges: store.table<MergeRow>('cart_merges'),
    queue: store.table<QueueRow>('recheck_queue'),
  };

  const ownerFilter = (owner: OwnerKey): Filter =>
    owner.kind === 'customer' ? { owner_kind: 'customer', customer_id: owner.customerId } : { owner_kind: 'guest', guest_session_id: owner.guestSessionId };

  /** Line count, subtotal of lines without an open blocking notice and open notice count per cart (two reads instead of the subqueries) */
  async function aggregates(carts: CartRow[]): Promise<CartAggregate[]> {
    if (!carts.length) return [];
    const items = await t.items.find({ cart_id: { $in: carts.map((c) => c.id) } });
    const open = items.length ? await t.notices.find({ item_id: { $in: items.map((i) => i.id) }, resolved_at: null }) : [];
    const blocked = new Set(open.filter((n) => n.severity === 'blocking').map((n) => n.item_id));
    const openPerItem = new Map<string, number>();
    for (const n of open) openPerItem.set(n.item_id, (openPerItem.get(n.item_id) ?? 0) + 1);
    return carts.map((cart) => {
      const lines = items.filter((i) => i.cart_id === cart.id);
      return {
        cart,
        itemCount: lines.reduce((s, i) => s + i.quantity, 0),
        itemsSubtotal: lines.filter((i) => !blocked.has(i.id)).reduce((s, i) => s + i.quantity * i.accepted_price, 0),
        openNotices: lines.reduce((s, i) => s + (openPerItem.get(i.id) ?? 0), 0),
      };
    });
  }

  const orThrow = <R>(row: R | undefined, what: string): R => {
    if (!row) throw new Error(`cart: ${what} not found`);
    return row;
  };

  const repo: CartRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoCartRepository(tx))),

    /* ---------------------------------------------------------------- carts */
    getActiveCart: (owner, lock) => t.carts.findOne({ status: 'active', ...ownerFilter(owner) }, { forUpdate: lock?.forUpdate }),
    getCart: (id, lock) => t.carts.get(id, { forUpdate: lock?.forUpdate }),
    async getGuestCart(guestSessionId, lock) {
      // the active cart first, else the most recently updated one
      const owner = { owner_kind: 'guest', guest_session_id: guestSessionId };
      return (await t.carts.findOne({ ...owner, status: 'active' }, { sort: { updated_at: -1 }, forUpdate: lock?.forUpdate })) ?? t.carts.findOne(owner, { sort: { updated_at: -1 }, forUpdate: lock?.forUpdate });
    },
    async insertCart(row) {
      // one active cart per owner (unique partial indexes): on conflict do nothing
      const key = row.status !== 'active' ? ['id'] : row.owner_kind === 'customer' ? ['customer_id', 'status'] : ['guest_session_id', 'status'];
      try {
        return await t.carts.insertIfAbsent(row, key);
      } catch (err) {
        // two first adds racing outside a transaction: the other one's cart won
        if (!store.inTransaction && (err as { code?: number }).code === 11000) return undefined;
        throw err;
      }
    },
    updateCart: async (id, patch) => orThrow(await t.carts.update(id, patch), `cart ${id}`),
    listExpiredCarts: (now, limit) => t.carts.find({ status: 'active', expires_at: { $lte: now } }, { sort: { expires_at: 1 }, limit }),
    async listCartsAdmin(filter, page) {
      const res = await t.carts.page(
        {
          ...(filter.customerId ? { customer_id: filter.customerId } : {}),
          ...(filter.guestSessionId ? { guest_session_id: filter.guestSessionId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
        },
        page,
        { column: 'updated_at', direction: 'desc' },
      );
      return { ...res, items: await aggregates(res.items) };
    },
    async aggregateCart(cartId) {
      const cart = await t.carts.get(cartId);
      return cart ? (await aggregates([cart]))[0] : undefined;
    },

    /* ---------------------------------------------------------------- lines */
    listItems: (cartId) => t.items.find({ cart_id: cartId }, { sort: { added_at: 1, id: 1 } }),
    getItem: (cartId, itemId, lock) => t.items.findOne({ cart_id: cartId, id: itemId }, { forUpdate: lock?.forUpdate }),
    getItemByOffer: (cartId, offerId) => t.items.findOne({ cart_id: cartId, offer_id: offerId }),
    countItems: (cartId) => t.items.count({ cart_id: cartId }),
    insertItem: (row) => t.items.insert(row),
    updateItem: async (id, patch) => orThrow(await t.items.update(id, patch), `cart item ${id}`),
    async moveItems(itemIds, toCartId, at) {
      if (!itemIds.length) return;
      await t.items.updateMany({ id: { $in: itemIds } }, { cart_id: toCartId, updated_at: at });
    },
    async deleteItems(itemIds) {
      if (!itemIds.length) return;
      await t.queue.deleteMany({ item_id: { $in: itemIds } });
      await t.notices.deleteMany({ item_id: { $in: itemIds } });
      await t.items.deleteMany({ id: { $in: itemIds } });
    },
    getItemsByIds: (itemIds) => t.items.getMany(itemIds),
    async findActiveItems(match) {
      const or: Filter[] = [];
      if (match.offerIds?.length) or.push({ offer_id: { $in: match.offerIds } });
      if (match.stockItemIds?.length) or.push({ stock_item_id: { $in: match.stockItemIds } });
      if (match.sellerIds?.length) or.push({ seller_id: { $in: match.sellerIds } });
      if (match.productIds?.length) or.push({ product_id: { $in: match.productIds } });
      if (!or.length) return [];
      const items = await t.items.find({ $or: or });
      if (!items.length) return [];
      const active = new Set(await t.carts.distinct<string>('id', { id: { $in: [...new Set(items.map((i) => i.cart_id))] }, status: 'active' }));
      return items.filter((i) => active.has(i.cart_id));
    },
    async countActiveCartsWithOffer(offerId) {
      const cartIds = await t.items.distinct<string>('cart_id', { offer_id: offerId });
      return cartIds.length ? t.carts.count({ id: { $in: cartIds }, status: 'active' }) : 0;
    },

    /* ---------------------------------------------------------------- notices */
    listNotices: (itemIds) => t.notices.find({ item_id: { $in: itemIds } }, { sort: { detected_at: 1, id: 1 } }),
    insertNotices: (rows) => t.notices.insertMany(rows),
    async resolveNotices(ids, at) {
      if (!ids.length) return;
      await t.notices.updateMany({ id: { $in: ids }, resolved_at: null }, { resolved_at: at });
    },
    async acceptNotices(ids, at) {
      if (!ids.length) return;
      await t.notices.updateMany({ id: { $in: ids }, resolved_at: null }, { accepted_at: at, resolved_at: at });
    },
    async countAttentionLines(cartId) {
      const itemIds = await t.items.distinct<string>('id', { cart_id: cartId });
      if (!itemIds.length) return 0;
      return (await t.notices.distinct<string>('item_id', { item_id: { $in: itemIds }, resolved_at: null, severity: { $in: ['warning', 'blocking'] } })).length;
    },

    /* ---------------------------------------------------------------- merges */
    async insertMerge(row) {
      await t.merges.insert(row);
    },
    getMergeFrom: (fromCartId) => t.merges.findOne({ from_cart_id: fromCartId }, { sort: { at: -1 } }),
    listMerges: (cartId) => t.merges.find({ $or: [{ from_cart_id: cartId }, { into_cart_id: cartId }] }, { sort: { at: -1 } }),

    /* ---------------------------------------------------------------- recheck queue */
    async enqueue(itemIds, reason, at) {
      if (!itemIds.length) return;
      await t.queue.upsertMany([...new Set(itemIds)].map((item_id) => ({ item_id, reason, queued_at: at })));
    },
    takeQueue: (limit) => t.queue.find({}, { sort: { queued_at: 1 }, limit }),
    async dequeue(itemIds) {
      if (!itemIds.length) return;
      await t.queue.deleteMany({ item_id: { $in: itemIds } });
    },

    /* ---------------------------------------------------------------- saved for later */
    listSaved: (owner, page) => t.saved.page(ownerFilter(owner), page, { column: 'saved_at', direction: 'desc' }),
    getSaved: (owner, id) => t.saved.findOne({ id, ...ownerFilter(owner) }),
    findSavedByOffer: (owner, offerId) => t.saved.findOne({ offer_id: offerId, ...ownerFilter(owner) }),
    countSaved: (owner) => t.saved.count(ownerFilter(owner)),
    async insertSaved(row) {
      await t.saved.insert(row);
    },
    async updateSaved(id, patch) {
      await t.saved.update(id, patch);
    },
    async deleteSaved(id) {
      await t.saved.delete(id);
    },
    async moveGuestSaved(guestSessionId, customerId) {
      // the customer's own row wins for an offer both saved (unique customer_id, offer_id)
      const guest = { owner_kind: 'guest', guest_session_id: guestSessionId };
      const customerOffers = await t.saved.distinct<string>('offer_id', { owner_kind: 'customer', customer_id: customerId });
      if (customerOffers.length) await t.saved.deleteMany({ ...guest, offer_id: { $in: customerOffers } });
      return t.saved.updateMany(guest, { owner_kind: 'customer', customer_id: customerId, guest_session_id: null });
    },
  };
  return repo;
}
