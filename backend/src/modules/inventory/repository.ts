import { zonedDayRange } from '../../kernel/lib/clock.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { isDuplicateKey, type Store, type StoreFindOptions, type StoreTable, type WhereWithOr } from '../../kernel/store/index.js';
import type { Page } from '../../spec/common.js';
import type { IdTable, ItemFilter, ItemListFilter, Lock, MovementFilter, NewRow, Patch, Row, Table } from './ports.js';
import type { InventoryQueries } from './queries.js';

/**
 * `nullsLast` — "every row whose column is null sorts after every value" — is implemented by both stores
 * (`kernel/mongo/table.ts`, `kernel/mysql/table.ts`) with the same meaning, but `StoreFindOptions` does not
 * name it. It is one read here (`expectations`, undated deliveries last) and two in modules not yet converted
 * (support, wallet), so it is reported as a kernel ask rather than worked around per store.
 */
type ReadOptions = StoreFindOptions;

/**
 * json columns. The service writes some of them as JSON.stringify(…), so a string written to one of these is
 * parsed here and stored as the value it encodes.
 */
const JSON_COLUMNS: Partial<Record<Table, readonly string[]>> = {
  locations: ['address'],
  stock_movements: ['after'],
  discrepancies: ['photo_media_ids'],
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
 * transfers, transfer_lines, stock_counts, count_lines, valuation_snapshots: one table per spec table, in
 * whichever database holds this module's data (`ctx.store`, BUILDING-MODULES §5c).
 *
 * The three reads that are not the same question in both databases — the stock list's quantity filters, the
 * latest ledger rows per item, and units per item by reason code — are the queries port (queries.ts).
 */
export class InventoryRepository {
  readonly #t;

  constructor(
    private readonly store: Store,
    private readonly queries: InventoryQueries,
  ) {
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
    return this.store.transaction((tx) => fn(new InventoryRepository(tx, this.queries)));
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
    // (snapshot_date, stock_group) is the table's whole primary key, so this is "replace that day's row"
    await this.#t.snapshots.upsertMany(rows, { key: ['snapshot_date', 'stock_group'] });
  }

  valuationSnapshots(fromDate: string, toDate: string): Promise<Row<'valuation_snapshots'>[]> {
    // `between` is inclusive at both ends, which is what the pair of $gte / $lte conditions meant
    return this.#t.snapshots.find({ snapshot_date: { op: 'between', value: [fromDate, toDate] } }, { sort: { snapshot_date: 1, stock_group: 1 } });
  }

  /* ---------------------------------------------------------------- rows by id (tables with an id column) */

  // generic table access: the row types are checked by the method signatures
  #table(name: Table): StoreTable<any> {
    return this.store.table(name);
  }

  get<T extends IdTable>(table: T, id: string, lock?: Lock): Promise<Row<T> | undefined> {
    return this.#table(table).get(id, { forUpdate: lock?.forUpdate });
  }

  insert<T extends IdTable>(table: T, row: NewRow<T>): Promise<Row<T>> {
    return this.#table(table).insert(jsonValues(table, row as Record<string, unknown>));
  }

  /**
   * Inserts a row unless one of its table's unique keys is taken: the row, or undefined.
   *
   * No key is named, which is the portable spelling (§5c): both stores then check every unique index the spec
   * gives the table, which is the question every caller here asks ("is it there already?"). Naming one would
   * also be wrong for `stock_items`, whose unique key is `(owner_type, seller_id, sku)` in the spec but a
   * *functional* index over `COALESCE(seller_id, …)` in MySQL — the `settings_change_keys` trap of §10.5a.
   */
  insertIfAbsent<T extends IdTable>(table: T, row: NewRow<T>): Promise<Row<T> | undefined> {
    return this.#table(table).insertIfAbsent(jsonValues(table, row as Record<string, unknown>));
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
      { ...(f.ownerType ? { owner_type: f.ownerType } : {}), ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.sellerIds ? { seller_id: f.sellerIds } : {}), ...(f.ids ? { id: f.ids } : {}) },
      { sort: { is_default: -1, code: 1 } },
    );
  }

  locationByCode(code: string): Promise<Row<'locations'> | undefined> {
    return this.#t.locations.findOne({ code });
  }

  /* ---------------------------------------------------------------- stock items */

  #itemFilter(f: ItemFilter): WhereWithOr<Row<'stock_items'>> {
    return {
      ...(f.ownerType ? { owner_type: f.ownerType } : {}),
      ...(f.sellerId ? { seller_id: f.sellerId } : {}),
      ...(f.ids ? { id: f.ids } : {}),
      ...(f.skus ? { sku: f.skus } : {}),
      ...(f.offerIds ? { offer_id: f.offerIds } : {}),
      ...(f.variantIds ? { variant_id: f.variantIds } : {}),
      ...(f.productIds ? { product_id: f.productIds } : {}),
      ...(f.includeArchived ? {} : { archived: false }),
    };
  }

  /**
   * Stock items of a list (filters on aggregated quantities): the item filter, and when the list filters by stock
   * state or group, the ids of the items whose quantities pass — which is a join and a GROUP BY with four
   * measures, so it belongs to the queries port (queries.ts) and not to the neutral vocabulary.
   */
  async #itemListFilter(f: ItemListFilter): Promise<WhereWithOr<Row<'stock_items'>>> {
    // `and` rather than one object: the item filter may already name `id`, and the location filter names it too
    const and: WhereWithOr<Row<'stock_items'>>[] = [this.#itemFilter(f)];
    const q = f.q?.trim();
    if (q) and.push({ or: [{ sku: { op: 'contains', value: q } }, { label: { op: 'contains', value: q } }, { primary_bin_code: { op: 'contains', value: q } }] });
    const zone = f.zone?.trim();
    if (zone) and.push({ primary_bin_code: { op: 'starts with', value: zone } });
    if (f.locationId) and.push({ id: await this.#t.levels.distinct<string>('stock_item_id', { location_id: f.locationId }) });
    const byGroup = f.filter === 'low_or_out' || f.filter === 'has_damaged_or_held' || f.filter === 'has_returned' || f.filter === 'has_incoming';
    if (!f.state && !byGroup) return { and };
    return { id: await this.queries.itemIdsByQuantities({ and }, { ...(f.state ? { state: f.state } : {}), ...(f.filter ? { filter: f.filter } : {}), defaultThreshold: f.defaultThreshold }) };
  }

  items(f: ItemFilter): Promise<Row<'stock_items'>[]> {
    return this.#t.items.find(this.#itemFilter(f), { sort: { sku: 1, id: 1 } });
  }

  /**
   * These items (archived ones included, unknown ids skipped), **locked** in id order — the primary key, which
   * is the order §11.2 rule 3 asks for, and the first thing `StockTx` takes before it touches the levels.
   *
   * The lock is not optional and not decoration: `StockTx.finish` reads `low_since` to decide whether the
   * cooldown has passed before writing it, `move` compares `updated_at` before writing it, and `setArchived`
   * reads `archived` and writes the opposite — three read-modify-writes on the item row, all of which the
   * read-modify-write detector refused (§11.2 rule 2) and all of which were latent lost updates on MongoDB,
   * where a second writer conflicted and retried instead.
   */
  itemsForUpdate(ids: string[]): Promise<Row<'stock_items'>[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.#t.items.getMany([...new Set(ids)].sort(), { forUpdate: true, sort: { id: 1 } });
  }

  /** Archives items matching the filter; returns the ones changed */
  async archiveItems(f: { sellerId?: string; offerId?: string }, at: Date): Promise<Row<'stock_items'>[]> {
    if (!f.sellerId && !f.offerId) return [];
    const filter: WhereWithOr<Row<'stock_items'>> = { archived: false, ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.offerId ? { offer_id: f.offerId } : {}) };
    const rows = await this.#t.items.find(filter);
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    await this.#t.items.updateMany({ ...filter, id: ids }, { archived: true, updated_at: at });
    return this.#t.items.find({ id: ids, archived: true, updated_at: at });
  }

  /** Ids of a page of items (filters on aggregated quantities), sorted by SKU */
  async pageItemIds(f: ItemListFilter, page: PageRequest): Promise<Page<{ id: string }>> {
    const p = await this.#t.items.page(await this.#itemListFilter(f), page, { column: 'sku', direction: 'asc' });
    return { ...p, items: p.items.map((r) => ({ id: r.id })) };
  }

  /** Ids for exports and digests, sorted by SKU, a page at a time */
  async itemIds(f: ItemListFilter, limit: number, offset: number): Promise<string[]> {
    return (await this.#t.items.find(await this.#itemListFilter(f), { sort: { sku: 1, id: 1 }, limit, offset })).map((r) => r.id);
  }

  /* ---------------------------------------------------------------- stock levels */

  /**
   * Levels of these items; with forUpdate the rows are locked in (item, location) order — the table's primary
   * key order, and the order §11.2 rule 3 names for this module. Two transactions that lock the same rows in
   * different orders deadlock, so the sort is written out rather than left to the store's default.
   */
  async levels(itemIds: string[], lock?: Lock): Promise<Row<'stock_levels'>[]> {
    if (!itemIds.length) return [];
    return this.#t.levels.find({ stock_item_id: itemIds }, { sort: { stock_item_id: 1, location_id: 1 }, forUpdate: lock?.forUpdate });
  }

  /** Creates a zero level row when missing */
  async ensureLevel(itemId: string, locationId: string, at: Date): Promise<void> {
    await this.#t.levels.insertIfAbsent({
      stock_item_id: itemId,
      location_id: locationId,
      available: 0,
      reserved: 0,
      incoming: 0,
      damaged_held: 0,
      returned: 0,
      version: 0,
      updated_at: at,
    });
  }

  /** Writes quantities if the version still matches; false on a concurrent change */
  async updateLevel(itemId: string, locationId: string, v: Omit<Row<'stock_levels'>, 'stock_item_id' | 'location_id' | 'version'>, expectedVersion: number): Promise<boolean> {
    // conditional on the version: nothing matches after a concurrent change (§11.2 rule 6 — a compare-and-set,
    // unchanged by the move: on MySQL it is the same guarded WHERE with an affected-rows check)
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
    return this.#t.levels.find({ stock_item_id: ids, ...(f.locationId ? { location_id: f.locationId } : {}) });
  }

  /* ---------------------------------------------------------------- movement ledger (append-only) */

  insertMovement(row: NewRow<'stock_movements'>): Promise<Row<'stock_movements'>> {
    return this.#t.movements.insert(jsonValues('stock_movements', row as Record<string, unknown>));
  }

  async pageMovements(f: MovementFilter, page: PageRequest): Promise<Page<Row<'stock_movements'>>> {
    const and: WhereWithOr<Row<'stock_movements'>>[] = [];
    if (f.stockItemIds) and.push({ stock_item_id: f.stockItemIds });
    if (f.sellerId || f.ownerType || f.sku) {
      // joined with stock_items: archived items included
      const ids = await this.#t.items.distinct<string>('id', { ...(f.sellerId ? { seller_id: f.sellerId } : {}), ...(f.ownerType ? { owner_type: f.ownerType } : {}), ...(f.sku ? { sku: f.sku } : {}) });
      and.push({ stock_item_id: ids });
    }
    if (f.reasonCode) and.push({ reason_code: f.reasonCode });
    if (f.referenceKind) and.push({ ref_kind: f.referenceKind });
    const days = zonedDayRange(f, f.timeZone ?? 'UTC');
    // two conditions on `at`, which one object cannot hold
    if (days.start) and.push({ at: { op: '>=', value: days.start } });
    if (days.end) and.push({ at: { op: '<', value: days.end } });
    return this.#t.movements.page(and.length ? { and } : {}, page, { column: 'at', direction: 'desc' });
  }

  /** Latest movements per item (limit each) */
  recentMovements(itemIds: string[], limit: number): Promise<Row<'stock_movements'>[]> {
    return this.queries.recentMovements(itemIds, limit);
  }

  /** Ledger rows by id */
  async movements(ids: string[]): Promise<Row<'stock_movements'>[]> {
    if (!ids.length) return [];
    return this.#t.movements.getMany([...new Set(ids)]);
  }

  async movementsByRef(refKind: string, refIds: string[]): Promise<Row<'stock_movements'>[]> {
    if (!refIds.length) return [];
    return this.#t.movements.find({ ref_kind: refKind, ref_id: refIds }, { sort: { at: 1, id: 1 } });
  }

  /** Units moved with these reason codes since a time, per item */
  unitsByReasonSince(itemIds: string[], since: Date, reasonCodes: string[]): Promise<Map<string, number>> {
    return this.queries.unitsByReasonSince(itemIds, since, reasonCodes);
  }

  /**
   * An order's replacement and exchange allocations (allocateForOrder: source other than checkout).
   *
   * `<>` and not `is not`: `source` is NOT NULL, so no row has none and the two readings pick exactly the same
   * rows — no test can tell them apart. `<>` is the spec's reading of the condition, and what `$nin: [x, null]`
   * was spelling by hand.
   */
  allocationsForShipments(orderId: string): Promise<Row<'reservations'>[]> {
    return this.#t.reservations.find({ order_id: orderId, source: { op: '<>', value: 'checkout' } }, { sort: { created_at: 1 } });
  }

  /** Units that left stock through dispatch since a time, per item */
  dispatchedSince(itemIds: string[], since: Date): Promise<Map<string, number>> {
    return this.queries.unitsByReasonSince(itemIds, since, ['dispatched']);
  }

  /* ---------------------------------------------------------------- incoming */

  /** Expected deliveries by expected date (undated last), then id */
  expectations(f: { sourceKind?: string; sourceId?: string; itemIds?: string[]; openOnly?: boolean }, lock?: Lock): Promise<Row<'incoming_expectations'>[]> {
    const o: ReadOptions = { sort: { expected_date: 1, id: 1 }, nullsLast: ['expected_date'], forUpdate: lock?.forUpdate };
    return this.#t.expectations.find(
      {
        ...(f.sourceKind ? { source_kind: f.sourceKind as Row<'incoming_expectations'>['source_kind'] } : {}),
        ...(f.sourceId ? { source_id: f.sourceId } : {}),
        ...(f.itemIds ? { stock_item_id: f.itemIds } : {}),
        ...(f.openOnly ? { quantity_open: { op: '>' as const, value: 0 } } : {}),
      },
      o,
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
    return this.#t.lines.find({ reservation_id: ids }, { sort: { id: 1 }, forUpdate: lock?.forUpdate });
  }

  /**
   * The reservations that have a line on these items in these states — the ids a caller locks *before* reading
   * the lines it means to write.
   *
   * A `distinct` and not a `linesWhere`, on purpose: reading the whole line rows first and locking them after
   * is what §11.2 rule 2 calls too late, and the detector reports the earlier read however well the second one
   * is locked ("a value computed from the first read is as stale as it ever was"). The ids are all that step
   * needs.
   */
  lineReservationIds(f: { itemIds: string[]; states: string[] }): Promise<string[]> {
    return this.#t.lines.distinct<string>('reservation_id', { stock_item_id: f.itemIds, state: f.states });
  }

  linesWhere(f: { orderItemIds?: string[]; itemIds?: string[]; states?: string[] }, lock?: Lock): Promise<Row<'reservation_lines'>[]> {
    return this.#t.lines.find(
      {
        ...(f.orderItemIds ? { order_item_id: f.orderItemIds } : {}),
        ...(f.itemIds ? { stock_item_id: f.itemIds } : {}),
        ...(f.states ? { state: f.states } : {}),
      },
      { sort: { id: 1 }, forUpdate: lock?.forUpdate },
    );
  }

  async pageReservations(f: { orderId?: string; stockItemId?: string; state?: string }, page: PageRequest): Promise<Page<Row<'reservations'>>> {
    const where: WhereWithOr<Row<'reservations'>> = { ...(f.orderId ? { order_id: f.orderId } : {}), ...(f.state ? { state: f.state } : {}) };
    if (f.stockItemId) where.id = await this.#t.lines.distinct<string>('reservation_id', { stock_item_id: f.stockItemId });
    return this.#t.reservations.page(where, page, { column: 'created_at', direction: 'desc' });
  }

  /** Held reservations past their expiry */
  dueHolds(now: Date, limit: number): Promise<Row<'reservations'>[]> {
    return this.#t.reservations.find({ state: 'held', expires_at: { op: '<=', value: now } }, { sort: { expires_at: 1 }, limit });
  }

  /** Allocations open since before a time */
  staleAllocations(before: Date, limit: number): Promise<Row<'reservations'>[]> {
    return this.#t.reservations.find({ state: 'allocated', updated_at: { op: '<', value: before } }, { sort: { updated_at: 1 }, limit });
  }

  /* ---------------------------------------------------------------- adjustments and held stock */

  adjustmentByApproval(approvalRequestId: string): Promise<Row<'adjustments'> | undefined> {
    return this.#t.adjustments.findOne({ approval_request_id: approvalRequestId });
  }

  adjustmentsWhere(f: { itemIds?: string[]; states?: string[] }): Promise<Row<'adjustments'>[]> {
    return this.#t.adjustments.find({ ...(f.itemIds ? { stock_item_id: f.itemIds } : {}), ...(f.states ? { state: f.states } : {}) }, { sort: { created_at: -1, id: -1 } });
  }

  pageAdjustments(f: { state?: string; stockItemId?: string }, page: PageRequest): Promise<Page<Row<'adjustments'>>> {
    return this.#t.adjustments.page({ ...(f.state ? { state: f.state } : {}), ...(f.stockItemId ? { stock_item_id: f.stockItemId } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }

  openHeld(itemId: string, locationId: string, lock?: Lock): Promise<Row<'held_stock'>[]> {
    return this.#t.held.find({ stock_item_id: itemId, location_id: locationId, released_at: null }, { sort: { review_date: 1, id: 1 }, forUpdate: lock?.forUpdate });
  }

  dueHeld(date: string, limit: number): Promise<Row<'held_stock'>[]> {
    return this.#t.held.find({ released_at: null, review_date: { op: '<=', value: date } }, { sort: { review_date: 1, id: 1 }, limit });
  }

  /* ---------------------------------------------------------------- inbound receipts */

  inboundByReceipt(receiptId: string): Promise<Row<'inbound_receipts'> | undefined> {
    return this.#t.inbound.findOne({ receipt_id: receiptId });
  }

  async inboundLines(ids: string[]): Promise<Row<'inbound_lines'>[]> {
    if (!ids.length) return [];
    return this.#t.inboundLines.find({ inbound_id: ids }, { sort: { inbound_id: 1, stock_item_id: 1 } });
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

  /** With forUpdate the rows are locked in inspection order, for a caller that adds to `quantity` */
  returnOutcomesWhere(f: { returnId?: string; ids?: string[] }, lock?: Lock): Promise<Row<'return_outcomes'>[]> {
    return this.#t.outcomes.find({ ...(f.returnId ? { return_id: f.returnId } : {}), ...(f.ids ? { id: f.ids } : {}) }, { sort: { inspected_at: 1 }, forUpdate: lock?.forUpdate });
  }

  pageReturnOutcomes(f: { state?: string }, page: PageRequest): Promise<Page<Row<'return_outcomes'>>> {
    return this.#t.outcomes.page(f.state ? { state: f.state } : {}, page, { column: 'inspected_at', direction: 'desc' });
  }

  /* ---------------------------------------------------------------- discrepancies */

  discrepanciesWhere(f: { itemIds?: string[]; states?: string[]; kinds?: string[] }): Promise<Row<'discrepancies'>[]> {
    return this.#t.discrepancies.find(
      { ...(f.itemIds ? { stock_item_id: f.itemIds } : {}), ...(f.states ? { state: f.states } : {}), ...(f.kinds ? { kind: f.kinds } : {}) },
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
