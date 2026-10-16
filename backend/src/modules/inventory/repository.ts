import { zonedDayRange } from '../../kernel/lib/clock.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { contains, isDuplicateKey, startsWith, type ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter, Table as Collection } from '../../kernel/mongo/table.js';
import type { Page } from '../../spec/common.js';
import type { IdTable, ItemFilter, ItemListFilter, Lock, MovementFilter, NewRow, Patch, Row, Table } from './ports.js';

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...values] });

/**
 * json columns. The service writes some of them as JSON.stringify(…), so a string written to one of these is
 * parsed here and stored as the value it encodes.
 */
const JSON_COLUMNS: Partial<Record<Table, readonly string[]>> = {
  locations: ['address'],
  stock_movements: ['after'],
  discrepancies: ['photo_media_ids'],
};

/** The unique key insertIfAbsent checks (on conflict (key) do nothing), per table; a clash on another key still fails */
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

/** An update refused by a unique index (for stock items: another item of the same owner has the SKU) */
export class DuplicateKeyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('a unique index refused the update', options);
  }
}

/**
 * inventory.locations, stock_items, stock_levels, stock_movements, incoming_expectations, reservations,
 * reservation_lines, adjustments, held_stock, inbound_receipts, inbound_lines, return_outcomes, discrepancies,
 * transfers, transfer_lines, stock_counts, count_lines, valuation_snapshots: one collection per spec table.
 */
export class InventoryRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    const table = <T extends Table>(name: T) => store.table<Row<T>>(name);
    this.#t = {
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
  }

  /** Runs fn in one database transaction with a repository bound to it */
  transaction<T>(fn: (tx: InventoryRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new InventoryRepository(tx)));
  }

  /**
   * Claims an event consumer's key (kernel inbox) on this repository's connection: inside a transaction the
   * claim commits with the effects. false when the key was already handled.
   */
  claimEvent(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /** Whether an event consumer's key was already claimed (read-only) */
  seenEvent(key: string): Promise<boolean> {
    return this.store.seen(key);
  }

  /** Writes one market day's valuation per stock group (a second run that day replaces it) */
  async saveValuationSnapshot(rows: Row<'valuation_snapshots'>[]): Promise<void> {
    await this.#t.snapshots.upsertMany(rows, { key: ['snapshot_date', 'stock_group'] });
  }

  valuationSnapshots(fromDate: string, toDate: string): Promise<Row<'valuation_snapshots'>[]> {
    return this.#t.snapshots.find({ snapshot_date: { $gte: fromDate, $lte: toDate } }, { sort: { snapshot_date: 1, stock_group: 1 } });
  }

  /* ---------------------------------------------------------------- rows by id (tables with an id column) */

  // generic table access: the row types are checked by the method signatures
  #table(name: Table): Collection<any> {
    return this.store.table(name);
  }

  get<T extends IdTable>(table: T, id: string, lock?: Lock): Promise<Row<T> | undefined> {
    return this.#table(table).get(id, { forUpdate: lock?.forUpdate });
  }

  insert<T extends IdTable>(table: T, row: NewRow<T>): Promise<Row<T>> {
    return this.#table(table).insert(jsonValues(table, row as Record<string, unknown>));
  }

  /** Inserts a row unless its table's conflict key (CONFLICT_KEY, else the id) is taken: the row, or undefined */
  insertIfAbsent<T extends IdTable>(table: T, row: NewRow<T>): Promise<Row<T> | undefined> {
    return this.#table(table).insertIfAbsent(jsonValues(table, row as Record<string, unknown>), CONFLICT_KEY[table] ?? ['id']);
  }

  /** Throws DuplicateKeyError when a unique index refuses the change */
  async update<T extends IdTable>(table: T, id: string, patch: Patch<T>): Promise<Row<T>> {
    let row: Row<T> | undefined;
    try {
      row = await this.#table(table).update(id, jsonValues(table, patch as Record<string, unknown>));
    } catch (err) {
      if (isDuplicateKey(err)) throw new DuplicateKeyError({ cause: err });
      throw err;
    }
    if (!row) throw new Error(`inventory: ${table} ${id} not found`);
    return row;
  }

  /* ---------------------------------------------------------------- locations */

  locations(f: { ownerType?: 'official' | 'seller'; sellerId?: string; sellerIds?: string[]; ids?: string[] }): Promise<Row<'locations'>[]> {
    return this.#t.locations.find(
      { ...(f.ownerType ? { owner_type: f.ownerType } : {}), ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.sellerIds ? { seller_id: oneOf(f.sellerIds) } : {}), ...(f.ids ? { id: oneOf(f.ids) } : {}) },
      { sort: { is_default: -1, code: 1 } },
    );
  }

  locationByCode(code: string): Promise<Row<'locations'> | undefined> {
    return this.#t.locations.findOne({ code });
  }

  /* ---------------------------------------------------------------- stock items */

  #itemFilter(f: ItemFilter): Filter {
    return {
      ...(f.ownerType ? { owner_type: f.ownerType } : {}),
      ...(f.sellerId ? { seller_id: f.sellerId } : {}),
      ...(f.ids ? { id: oneOf(f.ids) } : {}),
      ...(f.skus ? { sku: oneOf(f.skus) } : {}),
      ...(f.offerIds ? { offer_id: oneOf(f.offerIds) } : {}),
      ...(f.variantIds ? { variant_id: oneOf(f.variantIds) } : {}),
      ...(f.productIds ? { product_id: oneOf(f.productIds) } : {}),
      ...(f.includeArchived ? {} : { archived: false }),
    };
  }

  /**
   * Stock items of a list (filters on aggregated quantities): the item filter, and when the list filters by stock
   * state or group, the ids of the items whose quantities pass (one aggregation over items, their levels and the
   * levels' locations).
   */
  async #itemListFilter(f: ItemListFilter): Promise<Filter> {
    const t = this.#t;
    const and: Filter[] = [this.#itemFilter(f)];
    const q = f.q?.trim();
    if (q) {
      const like = contains(q);
      and.push({ $or: [{ sku: like }, { label: like }, { primary_bin_code: like }] });
    }
    const zone = f.zone?.trim();
    if (zone) and.push({ primary_bin_code: startsWith(zone) });
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
          from: t.levels.name,
          localField: '_id',
          foreignField: 'stock_item_id',
          as: 'lv',
          pipeline: [
            { $lookup: { from: t.locations.name, localField: 'location_id', foreignField: '_id', as: 'loc' } },
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
          _threshold: { $ifNull: ['$low_stock_threshold', f.defaultThreshold] },
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

  items(f: ItemFilter): Promise<Row<'stock_items'>[]> {
    return this.#t.items.find(this.#itemFilter(f), { sort: { sku: 1, id: 1 } });
  }

  /** Archives items matching the filter; returns the ones changed */
  async archiveItems(f: { sellerId?: string; offerId?: string }, at: Date): Promise<Row<'stock_items'>[]> {
    if (!f.sellerId && !f.offerId) return [];
    const filter = { archived: false, ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.offerId ? { offer_id: f.offerId } : {}) };
    const rows = await this.#t.items.find(filter);
    if (!rows.length) return [];
    await this.#t.items.updateMany({ ...filter, id: oneOf(rows.map((r) => r.id)) }, { archived: true, updated_at: at });
    return this.#t.items.find({ id: oneOf(rows.map((r) => r.id)), archived: true, updated_at: at });
  }

  /** Ids of a page of items (filters on aggregated quantities), sorted by SKU */
  async pageItemIds(f: ItemListFilter, page: PageRequest): Promise<Page<{ id: string }>> {
    const p = await this.#t.items.page(await this.#itemListFilter(f), page, { column: 'sku', direction: 'asc' });
    return { ...p, items: p.items.map((r) => ({ id: r.id })) };
  }

  /** Ids for exports and digests, sorted by SKU */
  async itemIds(f: ItemListFilter, limit: number, offset: number): Promise<string[]> {
    return (await this.#t.items.find(await this.#itemListFilter(f), { sort: { sku: 1, id: 1 }, limit, skip: offset })).map((r) => r.id);
  }

  /* ---------------------------------------------------------------- stock levels */

  /** Levels of these items; with forUpdate the rows are locked in (item, location) order */
  async levels(itemIds: string[], lock?: Lock): Promise<Row<'stock_levels'>[]> {
    if (!itemIds.length) return [];
    return this.#t.levels.find({ stock_item_id: oneOf(itemIds) }, { sort: { stock_item_id: 1, location_id: 1 }, forUpdate: lock?.forUpdate });
  }

  /** Creates a zero level row when missing */
  async ensureLevel(itemId: string, locationId: string, at: Date): Promise<void> {
    await this.#t.levels.insertIfAbsent(
      { stock_item_id: itemId, location_id: locationId, available: 0, reserved: 0, incoming: 0, damaged_held: 0, returned: 0, version: 0, updated_at: at },
      ['stock_item_id', 'location_id'],
    );
  }

  /** Writes quantities if the version still matches; false on a concurrent change */
  async updateLevel(itemId: string, locationId: string, v: Omit<Row<'stock_levels'>, 'stock_item_id' | 'location_id' | 'version'>, expectedVersion: number): Promise<boolean> {
    // conditional on the version: nothing matches after a concurrent change
    const row = await this.#t.levels.updateOne(
      { stock_item_id: itemId, location_id: locationId, version: expectedVersion },
      { available: v.available, reserved: v.reserved, incoming: v.incoming, damaged_held: v.damaged_held, returned: v.returned, updated_at: v.updated_at, version: expectedVersion + 1 },
    );
    return !!row;
  }

  /** Totals per location (summaries) */
  async levelTotals(f: { ownerType: 'official' | 'seller'; sellerId?: string; locationId?: string }): Promise<Row<'stock_levels'>[]> {
    const ids = await this.#t.items.distinct<string>('id', { owner_type: f.ownerType, archived: false, ...(f.sellerId ? { seller_id: f.sellerId } : {}) });
    if (!ids.length) return [];
    return this.#t.levels.find({ stock_item_id: oneOf(ids), ...(f.locationId ? { location_id: f.locationId } : {}) });
  }

  /* ---------------------------------------------------------------- movement ledger (append-only) */

  insertMovement(row: NewRow<'stock_movements'>): Promise<Row<'stock_movements'>> {
    return this.#t.movements.insert(jsonValues('stock_movements', row as Record<string, unknown>));
  }

  async pageMovements(f: MovementFilter, page: PageRequest): Promise<Page<Row<'stock_movements'>>> {
    const and: Filter[] = [];
    if (f.stockItemIds) and.push({ stock_item_id: oneOf(f.stockItemIds) });
    if (f.sellerId || f.ownerType || f.sku) {
      // joined with stock_items: archived items included
      const ids = await this.#t.items.distinct<string>('id', { ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.ownerType ? { owner_type: f.ownerType } : {}), ...(f.sku ? { sku: f.sku } : {}) });
      and.push({ stock_item_id: oneOf(ids) });
    }
    if (f.reasonCode) and.push({ reason_code: f.reasonCode });
    if (f.referenceKind) and.push({ ref_kind: f.referenceKind });
    const days = zonedDayRange(f, f.timeZone ?? 'UTC');
    if (days.start) and.push({ at: { $gte: days.start } });
    if (days.end) and.push({ at: { $lt: days.end } });
    return this.#t.movements.page(and.length ? { $and: and } : {}, page, { column: 'at', direction: 'desc' });
  }

  /** Latest movements per item (limit each) */
  async recentMovements(itemIds: string[], limit: number): Promise<Row<'stock_movements'>[]> {
    if (!itemIds.length) return [];
    const docs = await this.#t.movements.aggregate([
      { $match: { stock_item_id: { $in: itemIds } } },
      { $sort: { at: -1, _id: -1 } },
      // the first `limit` of each item in that order
      { $group: { _id: '$stock_item_id', rows: { $firstN: { input: '$$ROOT', n: limit } } } },
      { $unwind: '$rows' },
      { $replaceRoot: { newRoot: '$rows' } },
      { $sort: { at: -1, _id: -1 } },
    ]);
    return docs.map((d) => this.#t.movements.fromDoc(d));
  }

  /** Ledger rows by id */
  async movements(ids: string[]): Promise<Row<'stock_movements'>[]> {
    if (!ids.length) return [];
    return this.#t.movements.getMany([...new Set(ids)]);
  }

  async movementsByRef(refKind: string, refIds: string[]): Promise<Row<'stock_movements'>[]> {
    if (!refIds.length) return [];
    return this.#t.movements.find({ ref_kind: refKind, ref_id: oneOf(refIds) }, { sort: { at: 1, id: 1 } });
  }

  /** Units moved with these reason codes since a time, per item */
  async unitsByReasonSince(itemIds: string[], since: Date, reasonCodes: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!itemIds.length || !reasonCodes.length) return out;
    const rows = await this.#t.movements.aggregate<{ _id: string; n: number }>([
      { $match: { stock_item_id: { $in: itemIds }, reason_code: { $in: reasonCodes }, at: { $gte: since } } },
      { $group: { _id: '$stock_item_id', n: { $sum: '$quantity' } } },
    ]);
    for (const r of rows) out.set(r._id, Number(r.n));
    return out;
  }

  /** An order's replacement and exchange allocations (allocateForOrder: source other than checkout) */
  allocationsForShipments(orderId: string): Promise<Row<'reservations'>[]> {
    return this.#t.reservations.find({ order_id: orderId, source: { $nin: ['checkout', null] } }, { sort: { created_at: 1 } });
  }

  /** Units that left stock through dispatch since a time, per item */
  async dispatchedSince(itemIds: string[], since: Date): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!itemIds.length) return out;
    const rows = await this.#t.movements.aggregate<{ _id: string; n: number }>([
      { $match: { stock_item_id: { $in: itemIds }, reason_code: 'dispatched', at: { $gte: since } } },
      { $group: { _id: '$stock_item_id', n: { $sum: '$quantity' } } },
    ]);
    for (const r of rows) out.set(r._id, Number(r.n));
    return out;
  }

  /* ---------------------------------------------------------------- incoming */

  /** Expected deliveries by expected date (undated last), then id */
  expectations(f: { sourceKind?: string; sourceId?: string; itemIds?: string[]; openOnly?: boolean }, lock?: Lock): Promise<Row<'incoming_expectations'>[]> {
    return this.#t.expectations.find(
      {
        ...(f.sourceKind ? { source_kind: f.sourceKind } : {}),
        ...(f.sourceId ? { source_id: f.sourceId } : {}),
        ...(f.itemIds ? { stock_item_id: oneOf(f.itemIds) } : {}),
        ...(f.openOnly ? { quantity_open: { $gt: 0 } } : {}),
      },
      { sort: { expected_date: 1, id: 1 }, nullsLast: ['expected_date'], forUpdate: lock?.forUpdate },
    );
  }

  /* ---------------------------------------------------------------- reservations */

  /** A reservation by its idempotency key within its source (checkout holds, replacement or exchange allocations) */
  reservationByKey(source: Row<'reservations'>['source'], key: string): Promise<Row<'reservations'> | undefined> {
    return this.#t.reservations.findOne({ source, key });
  }

  /** Reservations by id (unknown ids left out) */
  async reservations(ids: string[]): Promise<Row<'reservations'>[]> {
    if (!ids.length) return [];
    return this.#t.reservations.getMany([...new Set(ids)]);
  }

  reservationsByOrder(orderId: string, lock?: Lock): Promise<Row<'reservations'>[]> {
    return this.#t.reservations.find({ order_id: orderId }, { sort: { created_at: 1, id: 1 }, forUpdate: lock?.forUpdate });
  }

  /** New reservation lines in one round trip */
  async insertLines(rows: Row<'reservation_lines'>[]): Promise<void> {
    if (rows.length) await this.#t.lines.insertMany(rows);
  }

  async lines(ids: string[], lock?: Lock): Promise<Row<'reservation_lines'>[]> {
    if (!ids.length) return [];
    return this.#t.lines.find({ reservation_id: oneOf(ids) }, { sort: { id: 1 }, forUpdate: lock?.forUpdate });
  }

  linesWhere(f: { orderItemIds?: string[]; itemIds?: string[]; states?: string[] }, lock?: Lock): Promise<Row<'reservation_lines'>[]> {
    return this.#t.lines.find(
      {
        ...(f.orderItemIds ? { order_item_id: oneOf(f.orderItemIds) } : {}),
        ...(f.itemIds ? { stock_item_id: oneOf(f.itemIds) } : {}),
        ...(f.states ? { state: oneOf(f.states) } : {}),
      },
      { sort: { id: 1 }, forUpdate: lock?.forUpdate },
    );
  }

  async pageReservations(f: { orderId?: string; stockItemId?: string; state?: string }, page: PageRequest): Promise<Page<Row<'reservations'>>> {
    const filter: Filter = { ...(f.orderId ? { order_id: f.orderId } : {}), ...(f.state ? { state: f.state } : {}) };
    if (f.stockItemId) filter.id = oneOf(await this.#t.lines.distinct<string>('reservation_id', { stock_item_id: f.stockItemId }));
    return this.#t.reservations.page(filter, page, { column: 'created_at', direction: 'desc' });
  }

  /** Held reservations past their expiry */
  dueHolds(now: Date, limit: number): Promise<Row<'reservations'>[]> {
    return this.#t.reservations.find({ state: 'held', expires_at: { $lte: now } }, { sort: { expires_at: 1 }, limit });
  }

  /** Allocations open since before a time */
  staleAllocations(before: Date, limit: number): Promise<Row<'reservations'>[]> {
    return this.#t.reservations.find({ state: 'allocated', updated_at: { $lt: before } }, { sort: { updated_at: 1 }, limit });
  }

  /* ---------------------------------------------------------------- adjustments and held stock */

  adjustmentByApproval(approvalRequestId: string): Promise<Row<'adjustments'> | undefined> {
    return this.#t.adjustments.findOne({ approval_request_id: approvalRequestId });
  }

  adjustmentsWhere(f: { itemIds?: string[]; states?: string[] }): Promise<Row<'adjustments'>[]> {
    return this.#t.adjustments.find({ ...(f.itemIds ? { stock_item_id: oneOf(f.itemIds) } : {}), ...(f.states ? { state: oneOf(f.states) } : {}) }, { sort: { created_at: -1, id: -1 } });
  }

  pageAdjustments(f: { state?: string; stockItemId?: string }, page: PageRequest): Promise<Page<Row<'adjustments'>>> {
    return this.#t.adjustments.page({ ...(f.state ? { state: f.state } : {}), ...(f.stockItemId ? { stock_item_id: f.stockItemId } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }

  openHeld(itemId: string, locationId: string, lock?: Lock): Promise<Row<'held_stock'>[]> {
    return this.#t.held.find({ stock_item_id: itemId, location_id: locationId, released_at: null }, { sort: { review_date: 1, id: 1 }, forUpdate: lock?.forUpdate });
  }

  dueHeld(date: string, limit: number): Promise<Row<'held_stock'>[]> {
    return this.#t.held.find({ released_at: null, review_date: { $lte: date } }, { sort: { review_date: 1, id: 1 }, limit });
  }

  /* ---------------------------------------------------------------- inbound receipts */

  inboundByReceipt(receiptId: string): Promise<Row<'inbound_receipts'> | undefined> {
    return this.#t.inbound.findOne({ receipt_id: receiptId });
  }

  async inboundLines(ids: string[]): Promise<Row<'inbound_lines'>[]> {
    if (!ids.length) return [];
    return this.#t.inboundLines.find({ inbound_id: oneOf(ids) }, { sort: { inbound_id: 1, stock_item_id: 1 } });
  }

  async insertInboundLines(rows: NewRow<'inbound_lines'>[]): Promise<void> {
    await this.#t.inboundLines.insertMany(rows);
  }

  async updateInboundLine(inboundId: string, itemId: string, patch: Patch<'inbound_lines'>): Promise<void> {
    await this.#t.inboundLines.updateMany({ inbound_id: inboundId, stock_item_id: itemId }, patch);
  }

  pageInbound(f: { state?: string; source?: Row<'inbound_receipts'>['source_kind'] }, page: PageRequest): Promise<Page<Row<'inbound_receipts'>>> {
    return this.#t.inbound.page({ ...(f.state ? { state: f.state } : {}), ...(f.source ? { source_kind: f.source } : {}) }, page, { column: 'received_at', direction: 'desc' });
  }

  /** Receipts of one source (a purchase order or a Fulfilled by Marketly inbound shipment), oldest first */
  inboundWhere(f: { sourceKind: Row<'inbound_receipts'>['source_kind']; sourceId: string; state?: string }): Promise<Row<'inbound_receipts'>[]> {
    return this.#t.inbound.find({ source_kind: f.sourceKind, source_id: f.sourceId, ...(f.state ? { state: f.state } : {}) }, { sort: { received_at: 1, id: 1 } });
  }

  /* ---------------------------------------------------------------- return outcomes */

  returnOutcomesWhere(f: { returnId?: string; ids?: string[] }): Promise<Row<'return_outcomes'>[]> {
    return this.#t.outcomes.find({ ...(f.returnId ? { return_id: f.returnId } : {}), ...(f.ids ? { id: oneOf(f.ids) } : {}) }, { sort: { inspected_at: 1 } });
  }

  pageReturnOutcomes(f: { state?: string }, page: PageRequest): Promise<Page<Row<'return_outcomes'>>> {
    return this.#t.outcomes.page(f.state ? { state: f.state } : {}, page, { column: 'inspected_at', direction: 'desc' });
  }

  /* ---------------------------------------------------------------- discrepancies */

  discrepanciesWhere(f: { itemIds?: string[]; states?: string[]; kinds?: string[] }): Promise<Row<'discrepancies'>[]> {
    return this.#t.discrepancies.find(
      { ...(f.itemIds ? { stock_item_id: oneOf(f.itemIds) } : {}), ...(f.states ? { state: oneOf(f.states) } : {}), ...(f.kinds ? { kind: oneOf(f.kinds) } : {}) },
      { sort: { reported_at: -1, id: -1 } },
    );
  }

  pageDiscrepancies(f: { state?: string; kind?: string }, page: PageRequest): Promise<Page<Row<'discrepancies'>>> {
    return this.#t.discrepancies.page({ ...(f.state ? { state: f.state } : {}), ...(f.kind ? { kind: f.kind } : {}) }, page, { column: 'reported_at', direction: 'desc' });
  }

  /* ---------------------------------------------------------------- transfers and counts (phase 4) */

  transferLines(transferId: string): Promise<Row<'transfer_lines'>[]> {
    return this.#t.transferLines.find({ transfer_id: transferId }, { sort: { stock_item_id: 1 } });
  }

  async insertTransferLines(rows: NewRow<'transfer_lines'>[]): Promise<void> {
    await this.#t.transferLines.insertMany(rows);
  }

  async updateTransferLine(transferId: string, itemId: string, patch: Patch<'transfer_lines'>): Promise<void> {
    await this.#t.transferLines.updateMany({ transfer_id: transferId, stock_item_id: itemId }, patch);
  }

  /** Newest first: ids are UUIDv7, time-sortable */
  pageTransfers(f: { state?: string }, page: PageRequest): Promise<Page<Row<'transfers'>>> {
    return this.#t.transfers.page(f.state ? { state: f.state } : {}, page, { column: 'id', direction: 'desc' });
  }

  countLines(countId: string): Promise<Row<'count_lines'>[]> {
    return this.#t.countLines.find({ count_id: countId }, { sort: { stock_item_id: 1 } });
  }

  async insertCountLines(rows: NewRow<'count_lines'>[]): Promise<void> {
    await this.#t.countLines.insertMany(rows);
  }

  async updateCountLine(countId: string, itemId: string, patch: Patch<'count_lines'>): Promise<void> {
    await this.#t.countLines.updateMany({ count_id: countId, stock_item_id: itemId }, patch);
  }
}
