import { sql, type Kysely } from 'kysely';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { CartDb } from '../../../../spec/cart.js';
import type { CartAggregate, CartRepository, CartRow, NoticeRow, OwnerKey } from '../../ports.js';

const NONE = '00000000-0000-0000-0000-000000000000';
const ids = (list: string[]) => (list.length ? list : [NONE]);

/** jsonb columns are written as JSON text (the driver would turn arrays into Postgres arrays) */
const jsonCols = ['destination', 'coupon_codes', 'report', 'previous', 'current'] as const;
function encode<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const c of jsonCols) if (c in out && out[c] !== null && out[c] !== undefined) out[c] = JSON.stringify(out[c]);
  return out as T;
}

/** Postgres adapter for CartRepository. `db` is scoped to the `cart` schema. */
export function createPostgresCartRepository(db: Kysely<CartDb>): CartRepository {
  const ownerWhere = <Q extends { where: (...a: any[]) => any }>(q: Q, owner: OwnerKey, prefix = ''): Q =>
    owner.kind === 'customer'
      ? (q.where(`${prefix}owner_kind` as never, '=', 'customer' as never).where(`${prefix}customer_id` as never, '=', owner.customerId as never) as Q)
      : (q.where(`${prefix}owner_kind` as never, '=', 'guest' as never).where(`${prefix}guest_session_id` as never, '=', owner.guestSessionId as never) as Q);

  /** Carts with line counts, subtotal of lines without blocking notices and open notice count */
  const aggregateQuery = () =>
    db
      .selectFrom('carts as c')
      .selectAll('c')
      .select([
        sql<number>`(select coalesce(sum(i.quantity), 0)::int from cart.cart_items i where i.cart_id = c.id)`.as('agg_item_count'),
        sql<number>`(select coalesce(sum(i.quantity * i.accepted_price), 0)::bigint from cart.cart_items i where i.cart_id = c.id
          and not exists (select 1 from cart.cart_item_notices n where n.item_id = i.id and n.resolved_at is null and n.severity = 'blocking'))`.as('agg_subtotal'),
        sql<number>`(select count(*)::int from cart.cart_item_notices n join cart.cart_items i on i.id = n.item_id
          where i.cart_id = c.id and n.resolved_at is null)`.as('agg_open_notices'),
      ]);
  const toAggregate = (r: Record<string, unknown>): CartAggregate => {
    const { agg_item_count, agg_subtotal, agg_open_notices, ...cart } = r;
    return { cart: cart as CartRow, itemCount: Number(agg_item_count), itemsSubtotal: Number(agg_subtotal), openNotices: Number(agg_open_notices) };
  };

  const repo: CartRepository = {
    transaction: (fn) => db.transaction().execute((trx) => fn(createPostgresCartRepository(trx))),

    /* ---------------------------------------------------------------- carts */
    async getActiveCart(owner, lock) {
      let q = ownerWhere(db.selectFrom('carts').selectAll().where('status', '=', 'active'), owner);
      if (lock?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getCart(id, lock) {
      let q = db.selectFrom('carts').selectAll().where('id', '=', id);
      if (lock?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getGuestCart(guestSessionId, lock) {
      let q = db
        .selectFrom('carts')
        .selectAll()
        .where('owner_kind', '=', 'guest')
        .where('guest_session_id', '=', guestSessionId)
        .orderBy(sql`(status = 'active')`, 'desc')
        .orderBy('updated_at', 'desc')
        .limit(1);
      if (lock?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async insertCart(row) {
      return db.insertInto('carts').values(encode(row)).onConflict((oc) => oc.doNothing()).returningAll().executeTakeFirst();
    },
    async updateCart(id, patch) {
      return db.updateTable('carts').set(encode(patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async listExpiredCarts(now, limit) {
      return db.selectFrom('carts').selectAll().where('status', '=', 'active').where('expires_at', '<=', now).orderBy('expires_at').limit(limit).execute();
    },
    async listCartsAdmin(filter, page: PageRequest) {
      let q = aggregateQuery();
      if (filter.customerId) q = q.where('c.customer_id', '=', filter.customerId);
      if (filter.guestSessionId) q = q.where('c.guest_session_id', '=', filter.guestSessionId);
      if (filter.status) q = q.where('c.status', '=', filter.status);
      const res = await paginate(q, page, { column: 'c.updated_at', direction: 'desc', id: 'c.id' });
      return { ...res, items: res.items.map((r) => toAggregate(r as Record<string, unknown>)) };
    },
    async aggregateCart(cartId) {
      const r = await aggregateQuery().where('c.id', '=', cartId).executeTakeFirst();
      return r ? toAggregate(r as Record<string, unknown>) : undefined;
    },

    /* ---------------------------------------------------------------- lines */
    async listItems(cartId) {
      return db.selectFrom('cart_items').selectAll().where('cart_id', '=', cartId).orderBy('added_at').orderBy('id').execute();
    },
    async getItem(cartId, itemId, lock) {
      let q = db.selectFrom('cart_items').selectAll().where('cart_id', '=', cartId).where('id', '=', itemId);
      if (lock?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getItemByOffer(cartId, offerId) {
      return db.selectFrom('cart_items').selectAll().where('cart_id', '=', cartId).where('offer_id', '=', offerId).executeTakeFirst();
    },
    async countItems(cartId) {
      const r = await db.selectFrom('cart_items').select(sql<number>`count(*)::int`.as('n')).where('cart_id', '=', cartId).executeTakeFirst();
      return Number(r?.n ?? 0);
    },
    async insertItem(row) {
      return db.insertInto('cart_items').values(row).returningAll().executeTakeFirstOrThrow();
    },
    async updateItem(id, patch) {
      return db.updateTable('cart_items').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async moveItems(itemIds, toCartId, at) {
      if (!itemIds.length) return;
      await db.updateTable('cart_items').set({ cart_id: toCartId, updated_at: at }).where('id', 'in', itemIds).execute();
    },
    async deleteItems(itemIds) {
      if (!itemIds.length) return;
      await db.deleteFrom('recheck_queue').where('item_id', 'in', itemIds).execute();
      await db.deleteFrom('cart_item_notices').where('item_id', 'in', itemIds).execute();
      await db.deleteFrom('cart_items').where('id', 'in', itemIds).execute();
    },
    async getItemsByIds(itemIds) {
      if (!itemIds.length) return [];
      return db.selectFrom('cart_items').selectAll().where('id', 'in', itemIds).execute();
    },
    async findActiveItems(match) {
      const conds: ReturnType<typeof sql<boolean>>[] = [];
      if (match.offerIds?.length) conds.push(sql<boolean>`i.offer_id in (${sql.join(match.offerIds)})`);
      if (match.stockItemIds?.length) conds.push(sql<boolean>`i.stock_item_id in (${sql.join(match.stockItemIds)})`);
      if (match.sellerIds?.length) conds.push(sql<boolean>`i.seller_id in (${sql.join(match.sellerIds)})`);
      if (match.productIds?.length) conds.push(sql<boolean>`i.product_id in (${sql.join(match.productIds)})`);
      if (!conds.length) return [];
      return db
        .selectFrom('cart_items as i')
        .innerJoin('carts as c', 'c.id', 'i.cart_id')
        .selectAll('i')
        .where('c.status', '=', 'active')
        .where(sql<boolean>`(${sql.join(conds, sql` or `)})`)
        .execute();
    },
    async countActiveCartsWithOffer(offerId) {
      const r = await db
        .selectFrom('cart_items as i')
        .innerJoin('carts as c', 'c.id', 'i.cart_id')
        .select(sql<number>`count(distinct c.id)::int`.as('n'))
        .where('c.status', '=', 'active')
        .where('i.offer_id', '=', offerId)
        .executeTakeFirst();
      return Number(r?.n ?? 0);
    },

    /* ---------------------------------------------------------------- notices */
    async listNotices(itemIds) {
      if (!itemIds.length) return [];
      return db.selectFrom('cart_item_notices').selectAll().where('item_id', 'in', itemIds).orderBy('detected_at').orderBy('id').execute();
    },
    async insertNotices(rows: NoticeRow[]) {
      if (!rows.length) return;
      await db.insertInto('cart_item_notices').values(rows.map(encode)).execute();
    },
    async resolveNotices(list, at) {
      if (!list.length) return;
      await db.updateTable('cart_item_notices').set({ resolved_at: at }).where('id', 'in', list).where('resolved_at', 'is', null).execute();
    },
    async acceptNotices(list, at) {
      if (!list.length) return;
      await db.updateTable('cart_item_notices').set({ accepted_at: at, resolved_at: at }).where('id', 'in', list).where('resolved_at', 'is', null).execute();
    },
    async countAttentionLines(cartId) {
      const r = await db
        .selectFrom('cart_items as i')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('i.cart_id', '=', cartId)
        .where(sql<boolean>`exists (select 1 from cart.cart_item_notices n where n.item_id = i.id and n.resolved_at is null and n.severity in ('warning', 'blocking'))`)
        .executeTakeFirst();
      return Number(r?.n ?? 0);
    },

    /* ---------------------------------------------------------------- merges */
    async insertMerge(row) {
      await db.insertInto('cart_merges').values(encode(row)).execute();
    },
    async getMergeFrom(fromCartId) {
      return db.selectFrom('cart_merges').selectAll().where('from_cart_id', '=', fromCartId).orderBy('at', 'desc').limit(1).executeTakeFirst();
    },
    async listMerges(cartId) {
      return db.selectFrom('cart_merges').selectAll().where((eb) => eb.or([eb('from_cart_id', '=', cartId), eb('into_cart_id', '=', cartId)])).orderBy('at', 'desc').execute();
    },

    /* ---------------------------------------------------------------- recheck queue */
    async enqueue(itemIds, reason, at) {
      if (!itemIds.length) return;
      await db
        .insertInto('recheck_queue')
        .values([...new Set(itemIds)].map((item_id) => ({ item_id, reason, queued_at: at })))
        .onConflict((oc) => oc.column('item_id').doUpdateSet({ reason, queued_at: at }))
        .execute();
    },
    async takeQueue(limit) {
      return db.selectFrom('recheck_queue').selectAll().orderBy('queued_at').limit(limit).execute();
    },
    async dequeue(itemIds) {
      if (!itemIds.length) return;
      await db.deleteFrom('recheck_queue').where('item_id', 'in', ids(itemIds)).execute();
    },

    /* ---------------------------------------------------------------- saved for later */
    async listSaved(owner, page) {
      return paginate(ownerWhere(db.selectFrom('saved_items').selectAll(), owner), page, { column: 'saved_at', direction: 'desc' });
    },
    async getSaved(owner, id) {
      return ownerWhere(db.selectFrom('saved_items').selectAll().where('id', '=', id), owner).executeTakeFirst();
    },
    async findSavedByOffer(owner, offerId) {
      return ownerWhere(db.selectFrom('saved_items').selectAll().where('offer_id', '=', offerId), owner).executeTakeFirst();
    },
    async countSaved(owner) {
      const r = await ownerWhere(db.selectFrom('saved_items').select(sql<number>`count(*)::int`.as('n')), owner).executeTakeFirst();
      return Number(r?.n ?? 0);
    },
    async insertSaved(row) {
      await db.insertInto('saved_items').values(row).execute();
    },
    async updateSaved(id, patch) {
      await db.updateTable('saved_items').set(patch).where('id', '=', id).execute();
    },
    async deleteSaved(id) {
      await db.deleteFrom('saved_items').where('id', '=', id).execute();
    },
  };
  return repo;
}
