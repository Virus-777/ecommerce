import { sql, type Kysely } from 'kysely';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { WishlistDb } from '../../../../spec/wishlist.js';
import type { AlertCandidate, AlertRow, ItemRow, ListWithCount, WishlistRepository } from '../../ports.js';

const NONE = '00000000-0000-0000-0000-000000000000';
const ids = (list: readonly string[]) => (list.length ? [...list] : [NONE]);

/** bigint columns may come back as strings; money amounts are safe integers */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const item = <T extends ItemRow | undefined>(r: T): T => (r ? ({ ...r, price_when_saved: num(r.price_when_saved) } as T) : r);
const alert = <T extends AlertRow | undefined>(r: T): T =>
  r ? ({ ...r, target_price: num(r.target_price), reference_price: num(r.reference_price), triggered_price: num(r.triggered_price) } as T) : r;

/** Postgres adapter for WishlistRepository. `db` is scoped to the `wishlist` schema. */
export function createPostgresWishlistRepository(db: Kysely<WishlistDb>): WishlistRepository {
  const variantIs = <Q extends { where: (...a: any[]) => any }>(q: Q, variantId: string | null, column = 'variant_id'): Q =>
    (variantId === null ? q.where(column as never, 'is', null) : q.where(column as never, '=', variantId as never)) as Q;

  const candidateQuery = () =>
    db
      .selectFrom('alerts as a')
      .leftJoin('items as i', 'i.id', 'a.item_id')
      .selectAll('a')
      .select('i.offer_id as item_offer_id');

  const repo: WishlistRepository = {
    transaction: (fn) => db.transaction().execute((trx) => fn(createPostgresWishlistRepository(trx))),

    /* ---------------------------------------------------------------- lists */
    async ensureDefaultList(row) {
      await db
        .insertInto('lists')
        .values(row)
        .onConflict((oc) => oc.column('customer_id').where('is_default', '=', true).doNothing())
        .execute();
      return (await db.selectFrom('lists').selectAll().where('customer_id', '=', row.customer_id).where('is_default', '=', true).executeTakeFirst())!;
    },
    async getList(customerId, id, lock) {
      let q = db.selectFrom('lists').selectAll().where('id', '=', id).where('customer_id', '=', customerId);
      if (lock?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    getListByShareToken: (token) => db.selectFrom('lists').selectAll().where('share_token', '=', token).executeTakeFirst(),
    async listLists(customerId) {
      const rows = await db
        .selectFrom('lists as l')
        .selectAll('l')
        .select(sql<number>`(select count(*)::int from wishlist.items i where i.list_id = l.id)`.as('item_count'))
        .where('l.customer_id', '=', customerId)
        .orderBy('l.is_default', 'desc')
        .orderBy('l.created_at', 'asc')
        .orderBy('l.id', 'asc')
        .execute();
      return rows.map((r) => ({ ...r, item_count: Number(r.item_count) })) as ListWithCount[];
    },
    async countLists(customerId) {
      const r = await db.selectFrom('lists').select(sql<number>`count(*)::int`.as('n')).where('customer_id', '=', customerId).executeTakeFirst();
      return Number(r?.n ?? 0);
    },
    insertList: async (row) => (await db.insertInto('lists').values(row).returningAll().executeTakeFirst())!,
    updateList: async (id, patch) => (await db.updateTable('lists').set(patch).where('id', '=', id).returningAll().executeTakeFirst())!,
    async deleteList(id) {
      await db.deleteFrom('lists').where('id', '=', id).execute();
    },

    /* ---------------------------------------------------------------- items */
    async getItem(customerId, id, lock) {
      let q = db.selectFrom('items').selectAll().where('id', '=', id).where('customer_id', '=', customerId);
      if (lock?.forUpdate) q = q.forUpdate();
      return item(await q.executeTakeFirst());
    },
    async findItem(listId, productId, variantId) {
      const q = variantIs(db.selectFrom('items').selectAll().where('list_id', '=', listId).where('product_id', '=', productId), variantId);
      return item(await q.executeTakeFirst());
    },
    async findCustomerItem(customerId, productId, variantId) {
      const q = variantIs(
        db
          .selectFrom('items as i')
          .innerJoin('lists as l', 'l.id', 'i.list_id')
          .selectAll('i')
          .where('i.customer_id', '=', customerId)
          .where('i.product_id', '=', productId),
        variantId,
        'i.variant_id',
      );
      return item(await q.orderBy('l.is_default', 'desc').orderBy('i.added_at', 'asc').executeTakeFirst());
    },
    async countItems(listId) {
      const r = await db.selectFrom('items').select(sql<number>`count(*)::int`.as('n')).where('list_id', '=', listId).executeTakeFirst();
      return Number(r?.n ?? 0);
    },
    insertItem: async (row) => item((await db.insertInto('items').values(row).returningAll().executeTakeFirst())!),
    updateItem: async (id, patch) => item((await db.updateTable('items').set(patch).where('id', '=', id).returningAll().executeTakeFirst())!),
    async deleteItem(id) {
      await db.deleteFrom('items').where('id', '=', id).execute();
    },
    async pageItems(listId, page) {
      const p = await paginate(db.selectFrom('items').selectAll().where('list_id', '=', listId), page, { column: 'added_at', direction: 'desc' });
      return { ...p, items: p.items.map((r) => item(r as ItemRow)) };
    },
    async allItems(listId, limit) {
      return (await db.selectFrom('items').selectAll().where('list_id', '=', listId).orderBy('added_at', 'desc').orderBy('id', 'desc').limit(limit).execute()).map(item);
    },
    async savedProductIds(customerId, productIds) {
      const rows = await db.selectFrom('items').select('product_id').distinct().where('customer_id', '=', customerId).where('product_id', 'in', ids(productIds)).execute();
      return rows.map((r) => r.product_id);
    },
    async countSavers(productId) {
      const r = await db.selectFrom('items').select(sql<number>`count(distinct customer_id)::int`.as('n')).where('product_id', '=', productId).executeTakeFirst();
      return Number(r?.n ?? 0);
    },
    itemsOfProduct: async (productId) => (await db.selectFrom('items').selectAll().where('product_id', '=', productId).execute()).map(item),
    async clearOffer(offerId) {
      const r = await db.updateTable('items').set({ offer_id: null }).where('offer_id', '=', offerId).executeTakeFirst();
      return Number(r.numUpdatedRows ?? 0);
    },
    async productIdsForVariant(variantId) {
      const rows = await db
        .selectFrom('alerts')
        .select('product_id')
        .where('variant_id', '=', variantId)
        .union(db.selectFrom('items').select('product_id').where('variant_id', '=', variantId))
        .execute();
      return [...new Set(rows.map((r) => r.product_id))];
    },

    /* ---------------------------------------------------------------- alerts */
    async getAlert(customerId, id, lock) {
      let q = db.selectFrom('alerts').selectAll().where('id', '=', id).where('customer_id', '=', customerId);
      if (lock?.forUpdate) q = q.forUpdate();
      return alert(await q.executeTakeFirst());
    },
    async getAlertById(id, lock) {
      let q = db.selectFrom('alerts').selectAll().where('id', '=', id);
      if (lock?.forUpdate) q = q.forUpdate();
      return alert(await q.executeTakeFirst());
    },
    async alertsOfItems(itemIds) {
      return (await db.selectFrom('alerts').selectAll().where('item_id', 'in', ids(itemIds)).where('state', '!=', 'removed').execute()).map(alert);
    },
    async pageAlerts(customerId, state, page) {
      let q = db.selectFrom('alerts').selectAll().where('customer_id', '=', customerId);
      q = state ? q.where('state', '=', state) : q.where('state', '!=', 'removed');
      const p = await paginate(q, page, { column: 'created_at', direction: 'desc' });
      return { ...p, items: p.items.map((r) => alert(r as AlertRow)) };
    },
    async allAlerts(customerId, limit) {
      return (
        await db.selectFrom('alerts').selectAll().where('customer_id', '=', customerId).where('state', '!=', 'removed').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute()
      ).map(alert);
    },
    async countActiveAlerts(customerId) {
      const r = await db.selectFrom('alerts').select(sql<number>`count(*)::int`.as('n')).where('customer_id', '=', customerId).where('state', '=', 'active').executeTakeFirst();
      return Number(r?.n ?? 0);
    },
    async findEquivalentAlert(customerId, a) {
      let q = db.selectFrom('alerts').selectAll().where('customer_id', '=', customerId).where('product_id', '=', a.productId).where('kind', '=', a.kind).where('state', '!=', 'removed');
      q = variantIs(q, a.variantId);
      q = variantIs(q, a.sellerId, 'seller_id');
      return alert(await q.orderBy('created_at', 'asc').executeTakeFirst());
    },
    insertAlert: async (row) => alert((await db.insertInto('alerts').values(row).returningAll().executeTakeFirst())!),
    updateAlert: async (id, patch) => alert((await db.updateTable('alerts').set(patch).where('id', '=', id).returningAll().executeTakeFirst())!),
    async removeAlertsOfItem(itemId) {
      const r = await db.updateTable('alerts').set({ state: 'removed', item_id: null }).where('item_id', '=', itemId).executeTakeFirst();
      return Number(r.numUpdatedRows ?? 0);
    },
    async candidates(productId, kind, states) {
      let q = candidateQuery().where('a.product_id', '=', productId).where('a.state', 'in', states);
      if (kind) q = q.where('a.kind', '=', kind);
      return (await q.orderBy('a.id').execute()).map((r) => alert(r as AlertCandidate));
    },
    async dueForRearm(before, limit) {
      return (
        await db
          .selectFrom('alerts')
          .selectAll()
          .where('kind', '=', 'price_drop')
          .where('state', '=', 'triggered')
          .where((eb) => eb.or([eb('last_notified_at', 'is', null), eb('last_notified_at', '<=', before)]))
          .orderBy('id')
          .limit(limit)
          .execute()
      ).map(alert);
    },
    async customersPausedFor(reason, limit) {
      const rows = await db.selectFrom('alerts').select('customer_id').distinct().where('state', '=', 'paused').where('paused_reason', '=', reason).orderBy('customer_id').limit(limit).execute();
      return rows.map((r) => r.customer_id);
    },
    async pausedFor(customerId, reason) {
      return (await db.selectFrom('alerts').selectAll().where('customer_id', '=', customerId).where('state', '=', 'paused').where('paused_reason', '=', reason).execute()).map(alert);
    },
    async activePriceAlertsAfter(afterId, limit) {
      let q = candidateQuery().where('a.kind', '=', 'price_drop').where('a.state', '=', 'active');
      if (afterId) q = q.where('a.id', '>', afterId);
      return (await q.orderBy('a.id').limit(limit).execute()).map((r) => alert(r as AlertCandidate));
    },

    /* ---------------------------------------------------------------- insights */
    async insights({ from, to, limit }) {
      let saves = db.selectFrom('items').select(['product_id', sql<number>`count(distinct customer_id)::int`.as('saves')]).groupBy('product_id');
      if (from) saves = saves.where('added_at', '>=', from);
      if (to) saves = saves.where('added_at', '<', to);
      const savedRows = await saves.execute();
      const alertRows = await db
        .selectFrom('alerts')
        .select([
          'product_id',
          sql<number>`count(*) filter (where kind = 'price_drop')::int`.as('price'),
          sql<number>`count(*) filter (where kind = 'back_in_stock')::int`.as('stock'),
        ])
        .where('state', '=', 'active')
        .groupBy('product_id')
        .execute();
      const out = new Map<string, { product_id: string; saves: number; active_price_alerts: number; active_stock_alerts: number }>();
      const row = (id: string) => {
        let r = out.get(id);
        if (!r) out.set(id, (r = { product_id: id, saves: 0, active_price_alerts: 0, active_stock_alerts: 0 }));
        return r;
      };
      for (const s of savedRows) row(s.product_id).saves = Number(s.saves);
      for (const a of alertRows) {
        const r = row(a.product_id);
        r.active_price_alerts = Number(a.price);
        r.active_stock_alerts = Number(a.stock);
      }
      return [...out.values()]
        .sort((a, b) => b.saves - a.saves || b.active_price_alerts + b.active_stock_alerts - (a.active_price_alerts + a.active_stock_alerts) || a.product_id.localeCompare(b.product_id))
        .slice(0, limit);
    },
  };
  return repo;
}
