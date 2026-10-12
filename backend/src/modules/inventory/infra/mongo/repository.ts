import { zonedDayRange } from '../../../../kernel/lib/clock.js';
import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter, Table as Collection } from '../../../../kernel/mongo/table.js';
import type { IdTable, InventoryRepository, ItemFilter, ItemListFilter, Lock, Row, Table } from '../../ports.js';

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...values] });
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * json columns. The service writes some of them as JSON.stringify(…), so a string written to one of these is
 * parsed here and stored as the value it encodes.
 */
const JSON_COLUMNS: Partial<Record<Table, readonly string[]>> = {
  locations: ['address'],
  stock_movements: ['after'],
  discrepancies: ['photo_media_ids'],
};

/** The unique key an insert with ignoreConflict (on conflict do nothing) may meet, per table */
const CONFLICT_KEY: Partial<Record<Table, readonly string[]>> = {
  locations: ['code'],
  stock_items: ['owner_type', 'seller_id', 'sku'],
  reservations: ['source', 'key'],
  inbound_receipts: ['receipt_id'],
  return_outcomes: ['return_id', 'stock_item_id'],
};

function jsonValues<T extends Record<string, unknown>>(table: Table, row: T): T {
  const cols = JSON_COLUMNS[table];
  if (!cols) return row;
  const out: Record<string, unknown> = { ...row };
  for (const c of cols) if (typeof out[c] === 'string') out[c] = JSON.parse(out[c] as string);
  return out as T;
}

/** MongoDB adapter for InventoryRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoInventoryRepository(store: ModuleStore): InventoryRepository {
  const table = <T extends Table>(name: T) => store.table<Row<T>>(name);
  const t = {
    locations: table('locations'),
    items: table('stock_items'),
    levels: table('stock_levels'),
    movements: table('stock_movements'),
    expectations: table('incoming_expectations'),
    reservations: table('reservations'),
    lines: table('reservation_lines'),
    adjustments: table('adjustments'),
    held: table('held_stock'),
    inbound: table('inbound_receipts'),
    inboundLines: table('inbound_lines'),
    outcomes: table('return_outcomes'),
    discrepancies: table('discrepancies'),
    transfers: table('transfers'),
    transferLines: table('transfer_lines'),
    countLines: table('count_lines'),
    snapshots: table('valuation_snapshots'),
  };

  const itemFilter = (f: ItemFilter): Filter => ({
    ...(f.ownerType ? { owner_type: f.ownerType } : {}),
    ...(f.sellerId ? { seller_id: f.sellerId } : {}),
    ...(f.ids ? { id: oneOf(f.ids) } : {}),
    ...(f.skus ? { sku: oneOf(f.skus) } : {}),
    ...(f.offerIds ? { offer_id: oneOf(f.offerIds) } : {}),
    ...(f.variantIds ? { variant_id: oneOf(f.variantIds) } : {}),
    ...(f.productIds ? { product_id: oneOf(f.productIds) } : {}),
    ...(f.includeArchived ? {} : { archived: false }),
  });

  /**
   * Stock items of a list (filters on aggregated quantities): the item filter, and when the list filters by stock
   * state or group, the ids of the items whose quantities pass (one aggregation over items, their levels and the
   * levels' locations, as the SQL join did).
   */
  async function itemListFilter(f: ItemListFilter): Promise<Filter> {
    const and: Filter[] = [itemFilter(f)];
    const q = f.q?.trim();
    if (q) {
      const like = { $regex: escapeRegExp(q), $options: 'i' };
      and.push({ $or: [{ sku: like }, { label: like }, { primary_bin_code: like }] });
    }
    const zone = f.zone?.trim();
    if (zone) and.push({ primary_bin_code: { $regex: `^${escapeRegExp(zone)}`, $options: 'i' } });
    if (f.locationId) and.push({ id: oneOf(await t.levels.distinct<string>('stock_item_id', { location_id: f.locationId })) });
    const byGroup = f.filter === 'low_or_out' || f.filter === 'has_damaged_or_held' || f.filter === 'has_returned' || f.filter === 'has_incoming';
    if (!f.state && !byGroup) return { $and: and };

    // sellable rule (domain/rules sellsFrom): a seller item sells from its service location when set, else from its
    // own location; company stock from company locations
    const sellable = {
      $and: [
        '$$l.sellable',
        '$$l.active',
        {
          $cond: [
            { $eq: ['$owner_type', 'seller'] },
            { $cond: [{ $eq: [{ $ifNull: ['$service_location_id', null] }, null] }, { $eq: ['$$l.loc_owner', 'seller'] }, { $eq: ['$$l.loc_id', '$service_location_id'] }] },
            { $eq: ['$$l.loc_owner', 'official'] },
          ],
        },
      ],
    };
    const conditions: Filter[] = [];
    if (f.state) conditions.push({ _state: f.state });
    if (f.filter === 'low_or_out') conditions.push({ _state: { $ne: 'in_stock' } });
    if (f.filter === 'has_damaged_or_held') conditions.push({ _damaged: { $gt: 0 } });
    if (f.filter === 'has_returned') conditions.push({ _returned: { $gt: 0 } });
    if (f.filter === 'has_incoming') conditions.push({ _incoming: { $gt: 0 } });
    const match: Filter = { $and: conditions };
    const rows = await t.items.aggregate<{ _id: string }>([
      { $match: t.items.filter({ $and: and }) },
      {
        $lookup: {
          from: t.levels.model.collection.collectionName,
          localField: '_id',
          foreignField: 'stock_item_id',
          as: 'lv',
          pipeline: [
            { $lookup: { from: t.locations.model.collection.collectionName, localField: 'location_id', foreignField: '_id', as: 'loc' } },
            { $unwind: '$loc' },
            { $project: { available: 1, damaged_held: 1, returned: 1, incoming: 1, loc_id: '$loc._id', sellable: '$loc.sellable', active: '$loc.active', loc_owner: '$loc.owner_type' } },
          ],
        },
      },
      {
        $addFields: {
          _sell: { $sum: { $map: { input: { $filter: { input: '$lv', as: 'l', cond: sellable } }, as: 'l', in: '$$l.available' } } },
          _damaged: { $sum: '$lv.damaged_held' },
          _returned: { $sum: '$lv.returned' },
          _incoming: { $sum: '$lv.incoming' },
          _threshold: { $ifNull: ['$low_stock_threshold', { $cond: [{ $eq: ['$owner_type', 'seller'] }, f.defaultSellerThreshold, null] }] },
        },
      },
      {
        $addFields: {
          _state: {
            $switch: {
              branches: [
                { case: { $lte: ['$_sell', 0] }, then: 'out_of_stock' },
                { case: { $and: [{ $ne: ['$_threshold', null] }, { $lte: ['$_sell', '$_threshold'] }] }, then: 'low_stock' },
              ],
              default: 'in_stock',
            },
          },
        },
      },
      { $match: match },
      { $project: { _id: 1 } },
    ]);
    return { id: oneOf(rows.map((r) => r._id)) };
  }

  const repo: InventoryRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoInventoryRepository(tx))),
    claimEvent: (key) => store.claim(key),
    seenEvent: (key) => store.seen(key),
    async saveValuationSnapshot(rows) {
      // a second run on the same market day replaces the day's rows
      await t.snapshots.upsertMany(rows, { key: ['snapshot_date', 'stock_group'] });
    },
    valuationSnapshots: (from, to) => t.snapshots.find({ snapshot_date: { $gte: from, $lte: to } }, { sort: { snapshot_date: 1, stock_group: 1 } }),

    /* ---------------------------------------------------------------- generic */
    get: <T extends IdTable>(name: T, id: string, lock?: Lock) => table(name).get(id, { forUpdate: lock?.forUpdate }),
    async insert(name, row, opts) {
      const values = jsonValues(name, row as Record<string, unknown>);
      const c = table(name) as Collection<any>;
      if (opts?.ignoreConflict) return c.insertIfAbsent(values, CONFLICT_KEY[name] ?? ['id']);
      return c.insert(values);
    },
    async update(name, id, patch) {
      const row = await (table(name) as Collection<any>).update(id, jsonValues(name, patch as Record<string, unknown>));
      if (!row) throw new Error(`inventory: ${name} ${id} not found`);
      return row;
    },

    /* ---------------------------------------------------------------- locations */
    locations: (f) =>
      t.locations.find(
        { ...(f.ownerType ? { owner_type: f.ownerType } : {}), ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.ids ? { id: oneOf(f.ids) } : {}) },
        { sort: { is_default: -1, code: 1 } },
      ),
    locationByCode: (code) => t.locations.findOne({ code }),

    /* ---------------------------------------------------------------- items */
    items: (f) => t.items.find(itemFilter(f), { sort: { sku: 1, id: 1 } }),
    async archiveItems(f, at) {
      if (!f.sellerId && !f.offerId) return [];
      const filter = { archived: false, ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.offerId ? { offer_id: f.offerId } : {}) };
      const rows = await t.items.find(filter);
      if (!rows.length) return [];
      await t.items.updateMany({ ...filter, id: oneOf(rows.map((r) => r.id)) }, { archived: true, updated_at: at });
      return t.items.find({ id: oneOf(rows.map((r) => r.id)), archived: true, updated_at: at });
    },
    async pageItemIds(f, page) {
      const p = await t.items.page(await itemListFilter(f), page, { column: 'sku', direction: 'asc' });
      return { ...p, items: p.items.map((r) => ({ id: r.id })) };
    },
    async itemIds(f, limit, offset) {
      return (await t.items.find(await itemListFilter(f), { sort: { sku: 1, id: 1 }, limit, skip: offset })).map((r) => r.id);
    },

    /* ---------------------------------------------------------------- levels */
    async levels(itemIds, lock) {
      if (!itemIds.length) return [];
      return t.levels.find({ stock_item_id: oneOf(itemIds) }, { sort: { stock_item_id: 1, location_id: 1 }, forUpdate: lock?.forUpdate });
    },
    async ensureLevel(itemId, locationId, at) {
      await t.levels.insertIfAbsent(
        { stock_item_id: itemId, location_id: locationId, available: 0, reserved: 0, incoming: 0, damaged_held: 0, returned: 0, version: 0, updated_at: at },
        ['stock_item_id', 'location_id'],
      );
    },
    async updateLevel(itemId, locationId, v, expectedVersion) {
      // conditional on the version: nothing matches after a concurrent change
      const row = await t.levels.updateOne(
        { stock_item_id: itemId, location_id: locationId, version: expectedVersion },
        { available: v.available, reserved: v.reserved, incoming: v.incoming, damaged_held: v.damaged_held, returned: v.returned, updated_at: v.updated_at, version: expectedVersion + 1 },
      );
      return !!row;
    },
    async levelTotals(f) {
      const ids = await t.items.distinct<string>('id', { owner_type: f.ownerType, archived: false, ...(f.sellerId ? { seller_id: f.sellerId } : {}) });
      if (!ids.length) return [];
      return t.levels.find({ stock_item_id: oneOf(ids), ...(f.locationId ? { location_id: f.locationId } : {}) });
    },

    /* ---------------------------------------------------------------- movements */
    insertMovement: (row) => t.movements.insert(jsonValues('stock_movements', row as Record<string, unknown>)),
    async pageMovements(f, page) {
      const and: Filter[] = [];
      if (f.stockItemIds) and.push({ stock_item_id: oneOf(f.stockItemIds) });
      if (f.sellerId || f.ownerType || f.sku) {
        // the join with stock_items: archived items included
        const ids = await t.items.distinct<string>('id', { ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.ownerType ? { owner_type: f.ownerType } : {}), ...(f.sku ? { sku: f.sku } : {}) });
        and.push({ stock_item_id: oneOf(ids) });
      }
      if (f.reasonCode) and.push({ reason_code: f.reasonCode });
      if (f.referenceKind) and.push({ ref_kind: f.referenceKind });
      const days = zonedDayRange(f, f.timeZone ?? 'UTC');
      if (days.start) and.push({ at: { $gte: days.start } });
      if (days.end) and.push({ at: { $lt: days.end } });
      return t.movements.page(and.length ? { $and: and } : {}, page, { column: 'at', direction: 'desc' });
    },
    async recentMovements(itemIds, limit) {
      if (!itemIds.length) return [];
      const docs = await t.movements.aggregate([
        { $match: { stock_item_id: { $in: itemIds } } },
        { $sort: { at: -1, _id: -1 } },
        // the first `limit` of each item in that order (row_number() over (partition by item order by at desc, id desc))
        { $group: { _id: '$stock_item_id', rows: { $firstN: { input: '$$ROOT', n: limit } } } },
        { $unwind: '$rows' },
        { $replaceRoot: { newRoot: '$rows' } },
        { $sort: { at: -1, _id: -1 } },
      ]);
      return docs.map((d) => t.movements.fromDoc(d));
    },
    async movementsByRef(refKind, refIds) {
      if (!refIds.length) return [];
      return t.movements.find({ ref_kind: refKind, ref_id: oneOf(refIds) }, { sort: { at: 1, id: 1 } });
    },
    async unitsByReasonSince(itemIds, since, reasonCodes) {
      const out = new Map<string, number>();
      if (!itemIds.length || !reasonCodes.length) return out;
      const rows = await t.movements.aggregate<{ _id: string; n: number }>([
        { $match: { stock_item_id: { $in: itemIds }, reason_code: { $in: reasonCodes }, at: { $gte: since } } },
        { $group: { _id: '$stock_item_id', n: { $sum: '$quantity' } } },
      ]);
      for (const r of rows) out.set(r._id, Number(r.n));
      return out;
    },
    allocationsForShipments: (orderId) => t.reservations.find({ order_id: orderId, source: { $nin: ['checkout', null] } }, { sort: { created_at: 1 } }),
    async dispatchedSince(itemIds, since) {
      const out = new Map<string, number>();
      if (!itemIds.length) return out;
      const rows = await t.movements.aggregate<{ _id: string; n: number }>([
        { $match: { stock_item_id: { $in: itemIds }, reason_code: 'dispatched', at: { $gte: since } } },
        { $group: { _id: '$stock_item_id', n: { $sum: '$quantity' } } },
      ]);
      for (const r of rows) out.set(r._id, Number(r.n));
      return out;
    },

    /* ---------------------------------------------------------------- incoming */
    async expectations(f, lock) {
      const rows = await t.expectations.find(
        {
          ...(f.sourceKind ? { source_kind: f.sourceKind } : {}),
          ...(f.sourceId ? { source_id: f.sourceId } : {}),
          ...(f.itemIds ? { stock_item_id: oneOf(f.itemIds) } : {}),
          ...(f.openOnly ? { quantity_open: { $gt: 0 } } : {}),
        },
        { sort: { expected_date: 1, id: 1 }, forUpdate: lock?.forUpdate },
      );
      // expected_date asc nulls last (MongoDB sorts nulls first)
      return [...rows.filter((r) => r.expected_date !== null), ...rows.filter((r) => r.expected_date === null)];
    },

    /* ---------------------------------------------------------------- reservations */
    reservationByKey: (source, key) => t.reservations.findOne({ source, key }),
    reservationsByOrder: (orderId, lock) => t.reservations.find({ order_id: orderId }, { sort: { created_at: 1, id: 1 }, forUpdate: lock?.forUpdate }),
    async lines(ids, lock) {
      if (!ids.length) return [];
      return t.lines.find({ reservation_id: oneOf(ids) }, { sort: { id: 1 }, forUpdate: lock?.forUpdate });
    },
    linesWhere: (f, lock) =>
      t.lines.find(
        {
          ...(f.orderItemIds ? { order_item_id: oneOf(f.orderItemIds) } : {}),
          ...(f.itemIds ? { stock_item_id: oneOf(f.itemIds) } : {}),
          ...(f.states ? { state: oneOf(f.states) } : {}),
        },
        { sort: { id: 1 }, forUpdate: lock?.forUpdate },
      ),
    async pageReservations(f, page) {
      const filter: Filter = { ...(f.orderId ? { order_id: f.orderId } : {}), ...(f.state ? { state: f.state } : {}) };
      if (f.stockItemId) filter.id = oneOf(await t.lines.distinct<string>('reservation_id', { stock_item_id: f.stockItemId }));
      return t.reservations.page(filter, page, { column: 'created_at', direction: 'desc' });
    },
    dueHolds: (now, limit) => t.reservations.find({ state: 'held', expires_at: { $lte: now } }, { sort: { expires_at: 1 }, limit }),
    staleAllocations: (before, limit) => t.reservations.find({ state: 'allocated', updated_at: { $lt: before } }, { sort: { updated_at: 1 }, limit }),

    /* ---------------------------------------------------------------- adjustments and held stock */
    adjustmentByApproval: (id) => t.adjustments.findOne({ approval_request_id: id }),
    adjustmentsWhere: (f) =>
      t.adjustments.find({ ...(f.itemIds ? { stock_item_id: oneOf(f.itemIds) } : {}), ...(f.states ? { state: oneOf(f.states) } : {}) }, { sort: { created_at: -1, id: -1 } }),
    pageAdjustments: (f, page) =>
      t.adjustments.page({ ...(f.state ? { state: f.state } : {}), ...(f.stockItemId ? { stock_item_id: f.stockItemId } : {}) }, page, { column: 'created_at', direction: 'desc' }),
    openHeld: (itemId, locationId, lock) =>
      t.held.find({ stock_item_id: itemId, location_id: locationId, released_at: null }, { sort: { review_date: 1, id: 1 }, forUpdate: lock?.forUpdate }),
    dueHeld: (date, limit) => t.held.find({ released_at: null, review_date: { $lte: date } }, { sort: { review_date: 1, id: 1 }, limit }),

    /* ---------------------------------------------------------------- inbound */
    inboundByReceipt: (receiptId) => t.inbound.findOne({ receipt_id: receiptId }),
    async inboundLines(ids) {
      if (!ids.length) return [];
      return t.inboundLines.find({ inbound_id: oneOf(ids) }, { sort: { inbound_id: 1, stock_item_id: 1 } });
    },
    async insertInboundLines(rows) {
      await t.inboundLines.insertMany(rows);
    },
    async updateInboundLine(inboundId, itemId, patch) {
      await t.inboundLines.updateMany({ inbound_id: inboundId, stock_item_id: itemId }, patch);
    },
    pageInbound: (f, page) =>
      t.inbound.page({ ...(f.state ? { state: f.state } : {}), ...(f.source ? { source_kind: f.source } : {}) }, page, { column: 'received_at', direction: 'desc' }),
    inboundWhere: (f) =>
      t.inbound.find({ source_kind: f.sourceKind, source_id: f.sourceId, ...(f.state ? { state: f.state } : {}) }, { sort: { received_at: 1, id: 1 } }),

    /* ---------------------------------------------------------------- return outcomes */
    returnOutcomesWhere: (f) =>
      t.outcomes.find({ ...(f.returnId ? { return_id: f.returnId } : {}), ...(f.ids ? { id: oneOf(f.ids) } : {}) }, { sort: { inspected_at: 1 } }),
    pageReturnOutcomes: (f, page) => t.outcomes.page(f.state ? { state: f.state } : {}, page, { column: 'inspected_at', direction: 'desc' }),

    /* ---------------------------------------------------------------- discrepancies */
    discrepanciesWhere: (f) =>
      t.discrepancies.find(
        { ...(f.itemIds ? { stock_item_id: oneOf(f.itemIds) } : {}), ...(f.states ? { state: oneOf(f.states) } : {}), ...(f.kinds ? { kind: oneOf(f.kinds) } : {}) },
        { sort: { reported_at: -1, id: -1 } },
      ),
    pageDiscrepancies: (f, page) =>
      t.discrepancies.page({ ...(f.state ? { state: f.state } : {}), ...(f.kind ? { kind: f.kind } : {}) }, page, { column: 'reported_at', direction: 'desc' }),

    /* ---------------------------------------------------------------- transfers and counts */
    transferLines: (id) => t.transferLines.find({ transfer_id: id }, { sort: { stock_item_id: 1 } }),
    async insertTransferLines(rows) {
      await t.transferLines.insertMany(rows);
    },
    async updateTransferLine(transferId, itemId, patch) {
      await t.transferLines.updateMany({ transfer_id: transferId, stock_item_id: itemId }, patch);
    },
    // ids are UUIDv7: time-sortable
    pageTransfers: (f, page) => t.transfers.page(f.state ? { state: f.state } : {}, page, { column: 'id', direction: 'desc' }),
    countLines: (id) => t.countLines.find({ count_id: id }, { sort: { stock_item_id: 1 } }),
    async insertCountLines(rows) {
      await t.countLines.insertMany(rows);
    },
    async updateCountLine(countId, itemId, patch) {
      await t.countLines.updateMany({ count_id: countId, stock_item_id: itemId }, patch);
    },
  };
  return repo;
}
