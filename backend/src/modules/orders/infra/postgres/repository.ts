import { sql, type Kysely } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { OrdersDb } from '../../../../spec/orders.js';
import { OPEN_GROUP } from '../../domain/rules.js';
import type { AdminOrderFilter, OrderRec, OrdersRepository, Recs, Table } from '../../ports.js';

/** jsonb columns per table: values are sent as JSON text (pg would turn JS arrays into PG arrays) */
const JSON_COLUMNS: Record<Table, readonly string[]> = {
  orders: ['delivery_address', 'policy_versions', 'coupon_codes'],
  seller_groups: ['delivery', 'dispatch_by_history'],
  order_items: ['product_snapshot', 'offer_snapshot', 'return_terms', 'discounts'],
  item_state_log: [],
  cancellations: ['items', 'decided_by', 'refund_preview'],
  shipment_refs: ['estimated_arrival', 'item_ids'],
  timeline: [],
  notes: [],
  documents: [],
  saved_filters: ['query'],
  order_facts: [],
};

const KEY: Partial<Record<Table, string>> = { shipment_refs: 'shipment_id' };
const keyOf = (t: Table) => KEY[t] ?? 'id';

function encode(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  const cols = JSON_COLUMNS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols.includes(k) ? (v === null ? null : JSON.stringify(v)) : v;
  }
  return out;
}

const isOp = (v: unknown): v is { op: string; value: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && 'op' in v;

function applyWhere(q: any, where: Record<string, unknown>, prefix = ''): any {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    const col = `${prefix}${k}`;
    if (v === null) q = q.where(col, 'is', null);
    else if (Array.isArray(v)) q = v.length ? q.where(col, 'in', v) : q.where(sql<boolean>`false`);
    else if (isOp(v)) q = q.where(col, v.op, v.value);
    else q = q.where(col, '=', v);
  }
  return q;
}

const like = (s: string) => `%${s.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`));

const IN_PROGRESS = ['payment_pending', 'confirmed', 'preparing', 'delayed', 'partly_shipped', 'shipped', 'partly_delivered'];
const DELIVERED = ['delivered', 'completed', 'partly_cancelled'];
const OPEN = [...OPEN_GROUP];

/** Postgres adapter for OrdersRepository. `db` is scoped to the `orders` schema. */
export function createPostgresOrdersRepository(db: Kysely<OrdersDb>, inbox?: Inbox): OrdersRepository {
  // generic table access: the row types are checked at the OrdersRepository boundary
  const d: any = db;

  const repo: OrdersRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresOrdersRepository(trx, inbox)));
    },

    /* ---------------------------------------------------------------- generic */
    async get(table, id, o) {
      let q = d.selectFrom(table).selectAll().where(keyOf(table), '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async find(table, where, o) {
      let q = applyWhere(d.selectFrom(table).selectAll(), where as Record<string, unknown>);
      for (const [c, dir] of o?.orderBy ?? []) q = q.orderBy(c, dir);
      if (o?.limit) q = q.limit(o.limit);
      if (o?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async count(table, where) {
      const r = await applyWhere(d.selectFrom(table).select(sql<number>`count(*)::int`.as('n')), where as Record<string, unknown>).executeTakeFirst();
      return (r as { n: number } | undefined)?.n ?? 0;
    },
    async insert(table, row) {
      return d.insertInto(table).values(encode(table, row as Record<string, unknown>)).returningAll().executeTakeFirstOrThrow();
    },
    async insertMany(table, rows) {
      if (!rows.length) return;
      await d
        .insertInto(table)
        .values(rows.map((r) => encode(table, r as Record<string, unknown>)))
        .execute();
    },
    async update(table, id, patch) {
      const values = encode(table, patch as Record<string, unknown>);
      if (!Object.keys(values).length) return (await repo.get(table, id))!;
      return d.updateTable(table).set(values).where(keyOf(table), '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async remove(table, id) {
      await d.deleteFrom(table).where(keyOf(table), '=', id).execute();
    },

    async claim(key) {
      if (!inbox) return true;
      return inbox.claim(db, key);
    },
    async insertOrderIfNew(row) {
      const r = await d
        .insertInto('orders')
        .values(encode('orders', row as unknown as Record<string, unknown>))
        .onConflict((oc: any) => oc.columns(['checkout_session_id', 'attempt_no']).doNothing())
        .returningAll()
        .executeTakeFirst();
      return (r as OrderRec | undefined) ?? null;
    },
    async insertFactIfNew(row) {
      const r = await d
        .insertInto('order_facts')
        .values(encode('order_facts', row as unknown as Record<string, unknown>))
        .onConflict((oc: any) => oc.columns(['order_id', 'kind', 'source_id']).doNothing())
        .returningAll()
        .executeTakeFirst();
      return r ?? null;
    },
    async upsertShipment(row) {
      const values = encode('shipment_refs', row as unknown as Record<string, unknown>);
      const { shipment_id: _id, order_id: _o, group_id: _g, ...rest } = values;
      return d
        .insertInto('shipment_refs')
        .values(values)
        .onConflict((oc: any) => oc.column('shipment_id').doUpdateSet(rest))
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    /* ---------------------------------------------------------------- store lists */
    async customerOrders(customerId, f, page) {
      let q = d.selectFrom('orders').selectAll().where('customer_id', '=', customerId);
      if (f.placedFrom) q = q.where('placed_at', '>=', f.placedFrom);
      if (f.placedTo) q = q.where('placed_at', '<', f.placedTo);
      if (f.tab === 'in_progress') q = q.where('display_status', 'in', IN_PROGRESS);
      if (f.tab === 'delivered') q = q.where('display_status', 'in', DELIVERED);
      if (f.tab === 'cancelled') q = q.where('display_status', '=', 'cancelled');
      if (f.tab === 'returns') q = q.where(sql<boolean>`exists (select 1 from orders.order_items i where i.order_id = orders.id and i.return_id is not null)`);
      if (f.q?.trim()) {
        const term = like(f.q);
        q = q.where(
          sql<boolean>`(lower(ref) like ${term} or exists (select 1 from orders.order_items i where i.order_id = orders.id and lower(i.product_snapshot->>'title') like ${term}))`,
        );
      }
      return paginate(q, page, { column: 'placed_at', direction: 'desc' }) as never;
    },
    async customerTabCounts(customerId, placedFrom) {
      let q = d
        .selectFrom('orders')
        .select([
          sql<number>`count(*)::int`.as('all'),
          sql<number>`count(*) filter (where display_status in (${list(IN_PROGRESS)}))::int`.as('inProgress'),
          sql<number>`count(*) filter (where display_status in (${list(DELIVERED)}))::int`.as('delivered'),
          sql<number>`count(*) filter (where exists (select 1 from orders.order_items i where i.order_id = orders.id and i.return_id is not null))::int`.as('returns'),
          sql<number>`count(*) filter (where display_status = 'cancelled')::int`.as('cancelled'),
        ])
        .where('customer_id', '=', customerId);
      if (placedFrom) q = q.where('placed_at', '>=', placedFrom);
      return q.executeTakeFirstOrThrow();
    },
    async delayedGroupsOfCustomer(customerId, now) {
      return d
        .selectFrom('seller_groups as g')
        .innerJoin('orders as o', 'o.id', 'g.order_id')
        .selectAll('g')
        .where('o.customer_id', '=', customerId)
        .where('o.lifecycle', '=', 'open')
        .where((eb: any) => eb.or([eb('g.status', '=', 'delayed'), eb.and([eb('g.status', 'in', OPEN), eb('g.dispatch_by', '<', now)])]))
        .orderBy('o.placed_at', 'desc')
        .execute();
    },

    /* ---------------------------------------------------------------- seller lists */
    async sellerGroups(sellerId, f, page, now) {
      let q = d.selectFrom('seller_groups as g').innerJoin('orders as o', 'o.id', 'g.order_id').selectAll('g').select('o.placed_at as placed_at').where('g.seller_id', '=', sellerId);
      if (f.tabs?.length) {
        const statuses = [...new Set(f.tabs.flatMap((t) => (t === 'cancellation_requests' ? [] : (TABS[t] ?? []))))];
        const pending = f.tabs.includes('cancellation_requests');
        q = q.where((eb: any) =>
          eb.or([
            ...(statuses.length ? [eb('g.status', 'in', statuses)] : []),
            ...(pending ? [sql<boolean>`exists (select 1 from orders.cancellations c where c.group_id = g.id and c.status = 'requested')`] : []),
            ...(!statuses.length && !pending ? [sql<boolean>`false`] : []),
          ]),
        );
      }
      if (f.placedFrom) q = q.where('o.placed_at', '>=', f.placedFrom);
      if (f.placedTo) q = q.where('o.placed_at', '<', f.placedTo);
      if (f.overdueOnly) q = q.where('g.status', 'in', OPEN).where('g.dispatch_by', '<', now);
      if (f.q?.trim()) {
        const term = like(f.q);
        q = q.where(
          sql<boolean>`(lower(o.ref) like ${term} or lower(o.contact_name) like ${term} or exists (select 1 from orders.order_items i where i.group_id = g.id and lower(coalesce(i.offer_snapshot->>'sellerSku', '')) like ${term}))`,
        );
      }
      const order =
        f.sort === 'newest'
          ? { column: 'o.placed_at', direction: 'desc' as const, id: 'g.id' }
          : f.sort === 'oldest'
            ? { column: 'o.placed_at', direction: 'asc' as const, id: 'g.id' }
            : { column: 'g.dispatch_by', direction: 'asc' as const, id: 'g.id' };
      return paginate(q, page, order) as never;
    },
    async sellerCounts(sellerId, now, endOfDay) {
      const r = await d
        .selectFrom('seller_groups as g')
        .select([
          sql<number>`count(*) filter (where g.status = 'new')::int`.as('new'),
          sql<number>`count(*) filter (where g.status in ('preparing', 'delayed', 'partly_shipped'))::int`.as('preparing'),
          sql<number>`count(*) filter (where g.status in ('shipped', 'partly_delivered'))::int`.as('shipped'),
          sql<number>`count(*) filter (where g.status in ('delivered', 'partly_cancelled', 'cancelled'))::int`.as('completed'),
          sql<number>`count(*) filter (where exists (select 1 from orders.cancellations c where c.group_id = g.id and c.status = 'requested'))::int`.as('cancellationRequests'),
          sql<number>`count(*) filter (where g.status in (${list(OPEN)}) and g.dispatch_by < ${now})::int`.as('overdue'),
          sql<number>`count(*) filter (where g.status in (${list(OPEN)}) and g.dispatch_by >= ${now} and g.dispatch_by < ${endOfDay})::int`.as('dueToday'),
        ])
        .where('g.seller_id', '=', sellerId)
        .executeTakeFirstOrThrow();
      return r;
    },
    async sellerTiles(sellerIds, now, endOfDay, since30d) {
      const out = new Map<string, { open: number; overdueDispatch: number; dueToday: number; cancellationRequests: number; cancellations30d: number }>();
      if (!sellerIds.length) return out;
      const rows = await d
        .selectFrom('seller_groups as g')
        .select([
          'g.seller_id as seller_id',
          sql<number>`count(distinct g.order_id) filter (where g.status not in ('delivered', 'cancelled', 'partly_cancelled'))::int`.as('open'),
          sql<number>`count(*) filter (where g.status in (${list(OPEN)}) and g.dispatch_by < ${now})::int`.as('overdueDispatch'),
          sql<number>`count(*) filter (where g.status in (${list(OPEN)}) and g.dispatch_by >= ${now} and g.dispatch_by < ${endOfDay})::int`.as('dueToday'),
          sql<number>`coalesce(sum((select count(*) from orders.cancellations c where c.group_id = g.id and c.status = 'requested' and c.initiated_by = 'customer')), 0)::int`.as('cancellationRequests'),
          sql<number>`coalesce(sum((select count(*) from orders.item_state_log l join orders.order_items i on i.id = l.item_id where i.group_id = g.id and l.to_state = 'cancelled' and l.at >= ${since30d})), 0)::int`.as('cancellations30d'),
        ])
        .where('g.seller_id', 'in', sellerIds)
        .groupBy('g.seller_id')
        .execute();
      for (const r of rows) out.set(r.seller_id, { open: r.open, overdueDispatch: r.overdueDispatch, dueToday: r.dueToday, cancellationRequests: r.cancellationRequests, cancellations30d: r.cancellations30d });
      return out;
    },

    /* ---------------------------------------------------------------- admin lists */
    async adminOrders(f, page, now) {
      return paginate(adminQuery(d, f, now).selectAll(), page, { column: 'placed_at', direction: 'desc' }) as never;
    },
    async adminCount(f, now) {
      const r = await adminQuery(d, f, now).select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
      return r?.n ?? 0;
    },
    async hasAcceptedOrder(who) {
      if (!who.customerId && !who.email?.trim()) return false;
      let q = d.selectFrom('orders').select('id').where('accepted_at', 'is not', null);
      if (who.customerId) q = q.where('customer_id', '=', who.customerId);
      else q = q.where(sql<boolean>`lower(contact_email) = ${who.email!.trim().toLowerCase()}`);
      return Boolean(await q.limit(1).executeTakeFirst());
    },
    async guestOrdersByEmail(email) {
      return d
        .selectFrom('orders')
        .selectAll()
        .where('customer_id', 'is', null)
        .where(sql<boolean>`lower(contact_email) = ${email.trim().toLowerCase()}`)
        .orderBy('placed_at', 'desc')
        .limit(100)
        .execute();
    },
    async ordersInLifecycle(lifecycles, afterId, limit) {
      let q = d.selectFrom('orders').selectAll().where('lifecycle', 'in', lifecycles);
      if (afterId) q = q.where('id', '>', afterId);
      return q.orderBy('id').limit(limit).execute();
    },
    async ordersWithOpenGroupsOfSeller(sellerId) {
      return d
        .selectFrom('seller_groups as g')
        .innerJoin('orders as o', 'o.id', 'g.order_id')
        .selectAll('g')
        .where('g.seller_id', '=', sellerId)
        .where('g.status', 'not in', ['delivered', 'cancelled', 'partly_cancelled'])
        .where('o.lifecycle', 'in', ['payment_pending', 'open'])
        .execute();
    },
    async countPurchased(customerId, offerId, since) {
      const r = await d
        .selectFrom('order_items as i')
        .innerJoin('orders as o', 'o.id', 'i.order_id')
        .select(sql<number>`coalesce(sum(i.quantity), 0)::int`.as('n'))
        .where('o.customer_id', '=', customerId)
        .where('i.offer_id', '=', offerId)
        .where('o.placed_at', '>=', since)
        .where('o.lifecycle', '<>', 'cancelled')
        .where('i.state', '<>', 'cancelled')
        .where('i.replacement_of_item_id', 'is', null)
        .executeTakeFirst();
      return r?.n ?? 0;
    },
    async verifiedPurchase(customerId, productId) {
      return d
        .selectFrom('order_items as i')
        .innerJoin('orders as o', 'o.id', 'i.order_id')
        .selectAll('i')
        .where('o.customer_id', '=', customerId)
        .where('i.product_id', '=', productId)
        .where('i.delivered_at', 'is not', null)
        .where('i.state', 'in', ['delivered', 'return_requested', 'returned', 'refunded'])
        .orderBy('i.delivered_at', 'asc')
        .limit(1)
        .executeTakeFirst();
    },
    async itemInfo(itemId) {
      return itemInfoQuery(d).where('i.id', '=', itemId).executeTakeFirst();
    },
    async deliveredItemsOf(customerId, since) {
      let q = itemInfoQuery(d).where('o.customer_id', '=', customerId).where('i.delivered_at', 'is not', null);
      if (since) q = q.where('i.delivered_at', '>=', since);
      return q.orderBy('i.delivered_at', 'desc').orderBy('i.id').limit(1000).execute();
    },
    async itemCountsForProducts(productIds) {
      if (!productIds.length) return [];
      return d
        .selectFrom('order_items')
        .select([
          'product_id',
          sql<number>`count(*) filter (where state not in ('delivered', 'return_requested', 'returned', 'cancelled', 'refunded'))::int`.as('open'),
          sql<number>`count(*) filter (where state in ('delivered', 'return_requested', 'returned', 'cancelled', 'refunded'))::int`.as('past'),
        ])
        .where('product_id', 'in', productIds)
        .groupBy('product_id')
        .execute();
    },
    async openInCategories(categoryIds, placedBefore) {
      if (!categoryIds.length) return { orders: 0, items: 0 };
      const r = await d
        .selectFrom('order_items as i')
        .innerJoin('orders as o', 'o.id', 'i.order_id')
        .select([sql<number>`count(distinct i.order_id)::int`.as('orders'), sql<number>`count(*)::int`.as('items')])
        .where(sql<boolean>`coalesce(i.category_id::text, i.product_snapshot->>'categoryId') in (${list(categoryIds)})`)
        .where('i.state', 'not in', ['delivered', 'return_requested', 'returned', 'cancelled', 'refunded'])
        .where('o.placed_at', '<', placedBefore)
        .where('o.lifecycle', 'in', ['payment_pending', 'open'])
        .executeTakeFirst();
      return { orders: r?.orders ?? 0, items: r?.items ?? 0 };
    },
    async timelinePage(orderId, visibility, page) {
      let q = d.selectFrom('timeline').selectAll().where('order_id', '=', orderId);
      if (visibility) q = q.where('visibility', '=', visibility);
      return paginate(q, page as PageRequest, { column: 'at', direction: 'desc' });
    },
    async dueCancellationRequests(now, limit) {
      return d.selectFrom('cancellations').selectAll().where('status', '=', 'requested').where('respond_by', '<=', now).orderBy('respond_by').limit(limit).execute();
    },
    async savedFiltersFor(staffId) {
      return d
        .selectFrom('saved_filters')
        .selectAll()
        .where((eb: any) => eb.or([eb('owner_staff_id', '=', staffId), eb('shared', '=', true)]))
        .orderBy('created_at')
        .execute();
    },
  };
  return repo;
}

const TABS: Record<string, string[]> = {
  new: ['new'],
  preparing: ['preparing', 'delayed', 'partly_shipped'],
  shipped: ['shipped', 'partly_delivered'],
  completed: ['delivered', 'partly_cancelled', 'cancelled'],
};

function itemInfoQuery(d: any): any {
  return d
    .selectFrom('order_items as i')
    .innerJoin('orders as o', 'o.id', 'i.order_id')
    .innerJoin('seller_groups as g', 'g.id', 'i.group_id')
    .select([
      'i.id',
      'i.order_id',
      'o.ref as order_ref',
      'i.group_id',
      'g.owner_type',
      'g.seller_id',
      'o.customer_id',
      'i.offer_id',
      'i.product_id',
      'i.variant_id',
      'i.stock_item_id',
      'i.category_id',
      'i.quantity',
      'i.state',
      'i.delivered_at',
      'i.return_window_ends_at',
    ]);
}

function adminQuery(d: any, f: AdminOrderFilter, now: Date): any {
  let q = d.selectFrom('orders');
  if (f.q?.trim()) {
    // decision S-D2: ref exactly or by prefix; contact name and email through their trigram indexes; tracking numbers
    const term = like(f.q);
    const prefix = `${f.q.trim().toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    q = q.where(
      sql<boolean>`(upper(ref) like ${prefix} or contact_name ilike ${term} or contact_email ilike ${term} or exists (select 1 from orders.shipment_refs s where s.order_id = orders.id and lower(coalesce(s.tracking_number, '')) like ${term}))`,
    );
  }
  if (f.sellerType === 'official') q = q.where(sql<boolean>`exists (select 1 from orders.seller_groups g where g.order_id = orders.id and g.owner_type = 'official')`);
  if (f.sellerType === 'marketplace') q = q.where(sql<boolean>`exists (select 1 from orders.seller_groups g where g.order_id = orders.id and g.owner_type = 'seller')`);
  if (f.sellerId) q = q.where(sql<boolean>`exists (select 1 from orders.seller_groups g where g.order_id = orders.id and g.seller_id = ${f.sellerId})`);
  if (f.customerId) q = q.where('customer_id', '=', f.customerId);
  if (f.placedFrom) q = q.where('placed_at', '>=', f.placedFrom);
  if (f.placedTo) q = q.where('placed_at', '<', f.placedTo);
  switch (f.fulfillmentStatus) {
    case 'new':
      q = q.where('display_status', '=', 'confirmed');
      break;
    case 'preparing':
      q = q.where('display_status', 'in', ['preparing', 'delayed']);
      break;
    case 'overdue':
      q = q.where(sql<boolean>`exists (select 1 from orders.seller_groups g where g.order_id = orders.id and g.status in (${list(OPEN)}) and g.dispatch_by < ${now})`);
      break;
    case 'shipped':
      q = q.where('display_status', 'in', ['shipped', 'partly_shipped']);
      break;
    case 'partly_delivered':
      q = q.where('display_status', '=', 'partly_delivered');
      break;
    case 'delivered':
      q = q.where('display_status', 'in', ['delivered', 'completed']);
      break;
    case 'cancellation_requested':
      q = q.where(sql<boolean>`exists (select 1 from orders.cancellations c where c.order_id = orders.id and c.status = 'requested')`);
      break;
    case 'cancelled':
      q = q.where('display_status', 'in', ['cancelled', 'partly_cancelled']);
      break;
  }
  switch (f.paymentState) {
    case 'pending_check':
      q = q.where('payment_state', '=', 'pending_check');
      break;
    case 'failed':
      q = q.where('payment_state', '=', 'failed');
      break;
    case 'refunded':
      q = q.where(sql<boolean>`refunded_total > 0 and refunded_total >= total`);
      break;
    case 'partly_refunded':
      q = q.where(sql<boolean>`refunded_total > 0 and refunded_total < total`);
      break;
    case 'captured':
      q = q.where(sql<boolean>`captured_total > 0 and refunded_total = 0`);
      break;
  }
  if (f.flag) q = q.where(sql<boolean>`flag_kinds @> array[${f.flag}]::text[]`);
  return q;
}

export type { Recs };
