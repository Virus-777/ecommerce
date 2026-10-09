import { sql, type Kysely } from 'kysely';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import type { InventoryDb } from '../../../../spec/inventory.js';
import type { IdTable, InventoryRepository, ItemFilter, ItemListFilter, Lock, NewRow, Patch, Row } from '../../ports.js';


/** Postgres adapter for InventoryRepository. `db` is scoped to the `inventory` schema. */
export function createPostgresInventoryRepository(db: Kysely<InventoryDb>, inbox?: Inbox): InventoryRepository {
  // dynamic table names: the generic helpers below are typed by the interface
  const anyDb = db as unknown as Kysely<any>;

  const applyItemFilter = <Q extends { where: (...a: any[]) => any }>(q: Q, f: ItemFilter, col = (c: string) => c): Q => {
    let out = q;
    if (f.ownerType) out = out.where(col('owner_type'), '=', f.ownerType);
    if (f.sellerId) out = out.where(col('seller_id'), '=', f.sellerId);
    if (f.ids) out = out.where(col('id'), 'in', f.ids.length ? f.ids : ['00000000-0000-0000-0000-000000000000']);
    if (f.skus) out = out.where(col('sku'), 'in', f.skus.length ? f.skus : ['']);
    if (f.offerIds) out = out.where(col('offer_id'), 'in', f.offerIds.length ? f.offerIds : ['00000000-0000-0000-0000-000000000000']);
    if (f.variantIds) out = out.where(col('variant_id'), 'in', f.variantIds.length ? f.variantIds : ['00000000-0000-0000-0000-000000000000']);
    if (f.productIds) out = out.where(col('product_id'), 'in', f.productIds.length ? f.productIds : ['00000000-0000-0000-0000-000000000000']);
    if (!f.includeArchived) out = out.where(col('archived'), '=', false);
    return out;
  };

  /** Stock items with their aggregated quantities, for lists filtered by state and groups */
  const itemListQuery = (f: ItemListFilter) => {
    const agg = db
      .selectFrom('stock_levels as l')
      .innerJoin('locations as loc', 'loc.id', 'l.location_id')
      .select([
        'l.stock_item_id',
        sql<number>`coalesce(sum(l.available) filter (where loc.sellable and loc.active), 0)::int`.as('sell_avail'),
        sql<number>`sum(l.damaged_held)::int`.as('damaged'),
        sql<number>`sum(l.returned)::int`.as('ret'),
        sql<number>`sum(l.incoming)::int`.as('inc'),
      ])
      .groupBy('l.stock_item_id')
      .as('a');
    let q = applyItemFilter(db.selectFrom('stock_items as i').leftJoin(agg, 'a.stock_item_id', 'i.id'), f, (c) => `i.${c}`);
    const threshold = sql`coalesce(i.low_stock_threshold, case when i.owner_type = 'seller' then ${f.defaultSellerThreshold}::int else null end)`;
    const state = sql`(case when coalesce(a.sell_avail, 0) <= 0 then 'out_of_stock' when ${threshold} is not null and a.sell_avail <= ${threshold} then 'low_stock' else 'in_stock' end)`;
    if (f.q?.trim()) {
      const like = `%${f.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      q = q.where(sql<boolean>`(i.sku ilike ${like} or i.label ilike ${like} or i.primary_bin_code ilike ${like})`);
    }
    if (f.zone?.trim()) q = q.where(sql<boolean>`i.primary_bin_code ilike ${`${f.zone.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`);
    if (f.locationId) q = q.where(sql<boolean>`exists (select 1 from inventory.stock_levels x where x.stock_item_id = i.id and x.location_id = ${f.locationId})`);
    if (f.state) q = q.where(sql<boolean>`${state} = ${f.state}`);
    if (f.filter === 'low_or_out') q = q.where(sql<boolean>`${state} <> 'in_stock'`);
    if (f.filter === 'has_damaged_or_held') q = q.where(sql<boolean>`coalesce(a.damaged, 0) > 0`);
    if (f.filter === 'has_returned') q = q.where(sql<boolean>`coalesce(a.ret, 0) > 0`);
    if (f.filter === 'has_incoming') q = q.where(sql<boolean>`coalesce(a.inc, 0) > 0`);
    return q.select(['i.id', 'i.sku']);
  };

  const repo: InventoryRepository = {
    transaction: (fn) => db.transaction().execute((trx) => fn(createPostgresInventoryRepository(trx, inbox))),
    async claimEvent(key) {
      if (!inbox) throw new Error('inventory: the repository was created without the kernel inbox');
      return inbox.claim(anyDb, key);
    },

    /* ---------------------------------------------------------------- generic */
    async get<T extends IdTable>(table: T, id: string, lock?: Lock) {
      let q = anyDb.selectFrom(table).selectAll().where('id', '=', id);
      if (lock?.forUpdate) q = q.forUpdate();
      return (await q.executeTakeFirst()) as Row<T> | undefined;
    },
    async insert<T extends IdTable>(table: T, row: NewRow<T>, opts?: { ignoreConflict?: boolean }) {
      if (opts?.ignoreConflict) {
        return (await anyDb
          .insertInto(table)
          .values(row as never)
          .onConflict((oc) => oc.doNothing())
          .returningAll()
          .executeTakeFirst()) as Row<T> | undefined;
      }
      return (await anyDb.insertInto(table).values(row as never).returningAll().executeTakeFirstOrThrow()) as Row<T>;
    },
    async update<T extends IdTable>(table: T, id: string, patch: Patch<T>) {
      return (await anyDb
        .updateTable(table as string)
        .set(patch as never)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()) as Row<T>;
    },

    /* ---------------------------------------------------------------- locations */
    async locations(f) {
      let q = db.selectFrom('locations').selectAll();
      if (f.ownerType) q = q.where('owner_type', '=', f.ownerType);
      if (f.sellerId) q = q.where('seller_id', '=', f.sellerId);
      if (f.ids) q = q.where('id', 'in', f.ids.length ? f.ids : ['00000000-0000-0000-0000-000000000000']);
      return q.orderBy('is_default', 'desc').orderBy('code').execute();
    },
    locationByCode: (code) => db.selectFrom('locations').selectAll().where('code', '=', code).executeTakeFirst(),

    /* ---------------------------------------------------------------- items */
    items: (f) => applyItemFilter(db.selectFrom('stock_items').selectAll(), f).orderBy('sku').orderBy('id').execute(),
    async archiveItems(f, at) {
      if (!f.sellerId && !f.offerId) return [];
      return db
        .updateTable('stock_items')
        .set({ archived: true, updated_at: at })
        .where('archived', '=', false)
        .$if(!!f.sellerId, (q) => q.where('seller_id', '=', f.sellerId!))
        .$if(!!f.offerId, (q) => q.where('offer_id', '=', f.offerId!))
        .returningAll()
        .execute();
    },
    pageItemIds: (f, page) => paginate(itemListQuery(f), page, { column: 'i.sku', direction: 'asc', id: 'i.id' }) as never,
    async itemIds(f, limit, offset) {
      const rows = await itemListQuery(f).orderBy('i.sku').orderBy('i.id').limit(limit).offset(offset).execute();
      return rows.map((r) => r.id);
    },

    /* ---------------------------------------------------------------- levels */
    async levels(itemIds, lock) {
      if (!itemIds.length) return [];
      let q = db.selectFrom('stock_levels').selectAll().where('stock_item_id', 'in', itemIds).orderBy('stock_item_id').orderBy('location_id');
      if (lock?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async ensureLevel(itemId, locationId, at) {
      await db
        .insertInto('stock_levels')
        .values({ stock_item_id: itemId, location_id: locationId, available: 0, reserved: 0, incoming: 0, damaged_held: 0, returned: 0, version: 0, updated_at: at })
        .onConflict((oc) => oc.columns(['stock_item_id', 'location_id']).doNothing())
        .execute();
    },
    async updateLevel(itemId, locationId, v, expectedVersion) {
      const res = await db
        .updateTable('stock_levels')
        .set({ available: v.available, reserved: v.reserved, incoming: v.incoming, damaged_held: v.damaged_held, returned: v.returned, updated_at: v.updated_at, version: expectedVersion + 1 })
        .where('stock_item_id', '=', itemId)
        .where('location_id', '=', locationId)
        .where('version', '=', expectedVersion)
        .executeTakeFirst();
      return Number(res.numUpdatedRows) === 1;
    },
    async levelTotals(f) {
      let q = db
        .selectFrom('stock_levels as l')
        .innerJoin('stock_items as i', 'i.id', 'l.stock_item_id')
        .selectAll('l')
        .where('i.owner_type', '=', f.ownerType)
        .where('i.archived', '=', false);
      if (f.sellerId) q = q.where('i.seller_id', '=', f.sellerId);
      if (f.locationId) q = q.where('l.location_id', '=', f.locationId);
      return q.execute();
    },

    /* ---------------------------------------------------------------- movements */
    insertMovement: (row) => db.insertInto('stock_movements').values(row).returningAll().executeTakeFirstOrThrow(),
    pageMovements(f, page: PageRequest) {
      let q = db.selectFrom('stock_movements as m').innerJoin('stock_items as i', 'i.id', 'm.stock_item_id').selectAll('m');
      if (f.stockItemIds) q = q.where('m.stock_item_id', 'in', f.stockItemIds.length ? f.stockItemIds : ['00000000-0000-0000-0000-000000000000']);
      if (f.sellerId) q = q.where('i.seller_id', '=', f.sellerId);
      if (f.ownerType) q = q.where('i.owner_type', '=', f.ownerType);
      if (f.sku) q = q.where('i.sku', '=', f.sku);
      if (f.reasonCode) q = q.where('m.reason_code', '=', f.reasonCode);
      if (f.referenceKind) q = q.where('m.ref_kind', '=', f.referenceKind);
      if (f.from) q = q.where('m.at', '>=', new Date(`${f.from}T00:00:00Z`));
      if (f.to) q = q.where('m.at', '<', new Date(new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000));
      return paginate(q, page, { column: 'm.at', direction: 'desc', id: 'm.id' }) as never;
    },
    async recentMovements(itemIds, limit) {
      if (!itemIds.length) return [];
      const rows = await sql<Row<'stock_movements'>>`
        select * from (
          select m.*, row_number() over (partition by m.stock_item_id order by m.at desc, m.id desc) as rn
          from inventory.stock_movements m where m.stock_item_id in (${sql.join(itemIds)})
        ) t where t.rn <= ${limit} order by t.at desc, t.id desc`.execute(db);
      return rows.rows.map(({ rn: _rn, ...r }: Row<'stock_movements'> & { rn?: unknown }) => r as Row<'stock_movements'>);
    },
    async movementsByRef(refKind, refIds) {
      if (!refIds.length) return [];
      return db.selectFrom('stock_movements').selectAll().where('ref_kind', '=', refKind).where('ref_id', 'in', refIds).orderBy('at').orderBy('id').execute();
    },
    async dispatchedSince(itemIds, since) {
      const out = new Map<string, number>();
      if (!itemIds.length) return out;
      const rows = await db
        .selectFrom('stock_movements')
        .select(['stock_item_id', sql<number>`sum(quantity)::int`.as('n')])
        .where('stock_item_id', 'in', itemIds)
        .where('reason_code', '=', 'dispatched')
        .where('at', '>=', since)
        .groupBy('stock_item_id')
        .execute();
      for (const r of rows) out.set(r.stock_item_id, r.n);
      return out;
    },

    /* ---------------------------------------------------------------- incoming */
    async expectations(f, lock) {
      let q = db.selectFrom('incoming_expectations').selectAll();
      if (f.sourceKind) q = q.where('source_kind', '=', f.sourceKind as 'purchase_order' | 'transfer');
      if (f.sourceId) q = q.where('source_id', '=', f.sourceId);
      if (f.itemIds) q = q.where('stock_item_id', 'in', f.itemIds.length ? f.itemIds : ['00000000-0000-0000-0000-000000000000']);
      if (f.openOnly) q = q.where('quantity_open', '>', 0);
      q = q.orderBy(sql`expected_date asc nulls last`).orderBy('id');
      if (lock?.forUpdate) q = q.forUpdate();
      return q.execute();
    },

    /* ---------------------------------------------------------------- reservations */
    reservationByKey: (key) => db.selectFrom('reservations').selectAll().where('key', '=', key).executeTakeFirst(),
    async reservationsByOrder(orderId, lock) {
      let q = db.selectFrom('reservations').selectAll().where('order_id', '=', orderId).orderBy('created_at').orderBy('id');
      if (lock?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async lines(ids, lock) {
      if (!ids.length) return [];
      let q = db.selectFrom('reservation_lines').selectAll().where('reservation_id', 'in', ids).orderBy('id');
      if (lock?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async linesWhere(f, lock) {
      let q = db.selectFrom('reservation_lines').selectAll();
      if (f.orderItemIds) q = q.where('order_item_id', 'in', f.orderItemIds.length ? f.orderItemIds : ['00000000-0000-0000-0000-000000000000']);
      if (f.itemIds) q = q.where('stock_item_id', 'in', f.itemIds.length ? f.itemIds : ['00000000-0000-0000-0000-000000000000']);
      if (f.states) q = q.where('state', 'in', f.states);
      q = q.orderBy('id');
      if (lock?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    pageReservations(f, page) {
      let q = db.selectFrom('reservations as r').selectAll('r');
      if (f.orderId) q = q.where('r.order_id', '=', f.orderId);
      if (f.state) q = q.where('r.state', '=', f.state);
      if (f.stockItemId) q = q.where(sql<boolean>`exists (select 1 from inventory.reservation_lines x where x.reservation_id = r.id and x.stock_item_id = ${f.stockItemId})`);
      return paginate(q, page, { column: 'r.created_at', direction: 'desc', id: 'r.id' }) as never;
    },
    dueHolds: (now, limit) => db.selectFrom('reservations').selectAll().where('state', '=', 'held').where('expires_at', '<=', now).orderBy('expires_at').limit(limit).execute(),
    staleAllocations: (before, limit) => db.selectFrom('reservations').selectAll().where('state', '=', 'allocated').where('updated_at', '<', before).orderBy('updated_at').limit(limit).execute(),

    /* ---------------------------------------------------------------- adjustments and held stock */
    adjustmentByApproval: (id) => db.selectFrom('adjustments').selectAll().where('approval_request_id', '=', id).executeTakeFirst(),
    async adjustmentsWhere(f) {
      let q = db.selectFrom('adjustments').selectAll();
      if (f.itemIds) q = q.where('stock_item_id', 'in', f.itemIds.length ? f.itemIds : ['00000000-0000-0000-0000-000000000000']);
      if (f.states) q = q.where('state', 'in', f.states);
      return q.orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
    },
    pageAdjustments(f, page) {
      let q = db.selectFrom('adjustments').selectAll();
      if (f.state) q = q.where('state', '=', f.state);
      if (f.stockItemId) q = q.where('stock_item_id', '=', f.stockItemId);
      return paginate(q, page, { column: 'created_at', direction: 'desc' }) as never;
    },
    async openHeld(itemId, locationId, lock) {
      let q = db.selectFrom('held_stock').selectAll().where('stock_item_id', '=', itemId).where('location_id', '=', locationId).where('released_at', 'is', null).orderBy('review_date').orderBy('id');
      if (lock?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    dueHeld: (date, limit) => db.selectFrom('held_stock').selectAll().where('released_at', 'is', null).where('review_date', '<=', date).orderBy('review_date').orderBy('id').limit(limit).execute(),

    /* ---------------------------------------------------------------- inbound */
    inboundByReceipt: (receiptId) => db.selectFrom('inbound_receipts').selectAll().where('receipt_id', '=', receiptId).executeTakeFirst(),
    async inboundLines(ids) {
      if (!ids.length) return [];
      return db.selectFrom('inbound_lines').selectAll().where('inbound_id', 'in', ids).orderBy('inbound_id').orderBy('stock_item_id').execute();
    },
    async insertInboundLines(rows) {
      if (rows.length) await db.insertInto('inbound_lines').values(rows).execute();
    },
    async updateInboundLine(inboundId, itemId, patch) {
      await db.updateTable('inbound_lines').set(patch).where('inbound_id', '=', inboundId).where('stock_item_id', '=', itemId).execute();
    },
    pageInbound(f, page) {
      let q = db.selectFrom('inbound_receipts').selectAll();
      if (f.state) q = q.where('state', '=', f.state);
      return paginate(q, page, { column: 'received_at', direction: 'desc' }) as never;
    },

    /* ---------------------------------------------------------------- return outcomes */
    async returnOutcomesWhere(f) {
      let q = db.selectFrom('return_outcomes').selectAll();
      if (f.returnId) q = q.where('return_id', '=', f.returnId);
      if (f.ids) q = q.where('id', 'in', f.ids.length ? f.ids : ['00000000-0000-0000-0000-000000000000']);
      return q.orderBy('inspected_at').execute();
    },
    pageReturnOutcomes(f, page) {
      let q = db.selectFrom('return_outcomes').selectAll();
      if (f.state) q = q.where('state', '=', f.state);
      return paginate(q, page, { column: 'inspected_at', direction: 'desc' }) as never;
    },

    /* ---------------------------------------------------------------- discrepancies */
    async discrepanciesWhere(f) {
      let q = db.selectFrom('discrepancies').selectAll();
      if (f.itemIds) q = q.where('stock_item_id', 'in', f.itemIds.length ? f.itemIds : ['00000000-0000-0000-0000-000000000000']);
      if (f.states) q = q.where('state', 'in', f.states);
      if (f.kinds) q = q.where('kind', 'in', f.kinds);
      return q.orderBy('reported_at', 'desc').orderBy('id', 'desc').execute();
    },
    pageDiscrepancies(f, page) {
      let q = db.selectFrom('discrepancies').selectAll();
      if (f.state) q = q.where('state', '=', f.state);
      if (f.kind) q = q.where('kind', '=', f.kind);
      return paginate(q, page, { column: 'reported_at', direction: 'desc' }) as never;
    },

    /* ---------------------------------------------------------------- transfers and counts */
    transferLines: (id) => db.selectFrom('transfer_lines').selectAll().where('transfer_id', '=', id).orderBy('stock_item_id').execute(),
    async insertTransferLines(rows) {
      if (rows.length) await db.insertInto('transfer_lines').values(rows).execute();
    },
    async updateTransferLine(transferId, itemId, patch) {
      await db.updateTable('transfer_lines').set(patch).where('transfer_id', '=', transferId).where('stock_item_id', '=', itemId).execute();
    },
    pageTransfers(f, page) {
      let q = db.selectFrom('transfers').selectAll();
      if (f.state) q = q.where('state', '=', f.state);
      // ids are UUIDv7: time-sortable
      return paginate(q, page, { column: 'id', direction: 'desc' }) as never;
    },
    countLines: (id) => db.selectFrom('count_lines').selectAll().where('count_id', '=', id).orderBy('stock_item_id').execute(),
    async insertCountLines(rows) {
      if (rows.length) await db.insertInto('count_lines').values(rows).execute();
    },
    async updateCountLine(countId, itemId, patch) {
      await db.updateTable('count_lines').set(patch).where('count_id', '=', countId).where('stock_item_id', '=', itemId).execute();
    },
  };
  return repo;
}
