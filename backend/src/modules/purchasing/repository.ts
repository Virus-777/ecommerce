import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import { contains, type Filter, type ModuleStore } from '../../kernel/mongo/index.js';
import type * as common from '../../spec/common.js';
import type { ClaimLine, PurchasingDb } from '../../spec/purchasing.js';
import { actorText, parseActor, SUBMITTED_RECEIPT_STATUSES, type ClaimKind, type ClaimStatus, type DeliveryStatus, type PoStatus, type ReceiptStatus } from './domain/rules.js';
import type {
  ClaimFilter,
  ClaimRow,
  DeliveryFilter,
  DeliveryRow,
  PerformanceInputs,
  PerformanceRow,
  PoEventRow,
  PoFilter,
  PoLineRow,
  PoRow,
  ReceiptFilter,
  ReceiptLineRow,
  ReceiptRow,
  SupplierItemRow,
  SupplierRow,
} from './ports.js';

type T<K extends keyof PurchasingDb> = PurchasingDb[K];

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...new Set(values)] });
const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const asDateOrNull = (v: Date | string | null): Date | null => (v === null ? null : asDate(v));

/* ------------------------------------------------------------------ mappers */

const toSupplier = (r: T<'suppliers'>): SupplierRow => ({
  id: r.id,
  name: r.name,
  location: r.location,
  contactName: r.contact_name,
  email: r.email,
  phone: r.phone,
  address: (r.address as common.Address | null) ?? null,
  paymentTerms: r.payment_terms,
  leadTimeDays: r.lead_time_days,
  returnAuthorizationRequired: r.return_authorization_required,
  active: r.active,
  notes: r.notes,
  createdAt: asDate(r.created_at),
});

const supplierCols = (p: Partial<SupplierRow>) => {
  const c: Partial<T<'suppliers'>> = {};
  if (p.name !== undefined) c.name = p.name;
  if (p.location !== undefined) c.location = p.location;
  if (p.contactName !== undefined) c.contact_name = p.contactName;
  if (p.email !== undefined) c.email = p.email;
  if (p.phone !== undefined) c.phone = p.phone;
  if (p.address !== undefined) c.address = p.address as never;
  if (p.paymentTerms !== undefined) c.payment_terms = p.paymentTerms;
  if (p.leadTimeDays !== undefined) c.lead_time_days = p.leadTimeDays;
  if (p.returnAuthorizationRequired !== undefined) c.return_authorization_required = p.returnAuthorizationRequired;
  if (p.active !== undefined) c.active = p.active;
  if (p.notes !== undefined) c.notes = p.notes;
  return c;
};

const toItem = (r: T<'supplier_items'>): SupplierItemRow => ({
  supplierId: r.supplier_id,
  stockItemId: r.stock_item_id,
  supplierSku: r.supplier_sku,
  unitCostAmount: Number(r.unit_cost_amount),
  currency: r.currency.trim(),
  minOrderQty: r.min_order_qty,
  leadTimeDays: r.lead_time_days,
  preferred: r.preferred,
  updatedAt: asDate(r.updated_at),
});

const toPerformance = (r: T<'supplier_performance'>): PerformanceRow => ({
  supplierId: r.supplier_id,
  windowDays: r.window_days,
  onTimePct: num(r.on_time_pct),
  avgLeadTimeDays: num(r.avg_lead_time_days),
  shortageRatePct: num(r.shortage_rate_pct),
  damageRatePct: num(r.damage_rate_pct),
  deliveries: r.deliveries,
  computedAt: asDate(r.computed_at),
});

const toPo = (r: T<'purchase_orders'>): PoRow => ({
  id: r.id,
  ref: r.ref,
  supplierId: r.supplier_id,
  shipToLocationId: r.ship_to_location_id,
  status: r.status as PoStatus,
  paymentTerms: r.payment_terms,
  expectedDate: r.expected_date,
  freightAmount: Number(r.freight_amount),
  currency: r.currency.trim(),
  totalAmount: Number(r.total_amount),
  approvalRequestId: r.approval_request_id,
  approvalState: r.approval_state,
  notes: r.notes,
  attachmentIds: ids(r.attachment_media_ids),
  createdBy: parseActor(r.created_by) ?? { kind: 'system', id: null, name: null },
  createdAt: asDate(r.created_at),
  sentAt: asDateOrNull(r.sent_at),
  closedAt: asDateOrNull(r.closed_at),
  closeReason: r.close_reason,
});

const poCols = (p: Partial<PoRow>) => {
  const c: Partial<T<'purchase_orders'>> = {};
  if (p.supplierId !== undefined) c.supplier_id = p.supplierId;
  if (p.shipToLocationId !== undefined) c.ship_to_location_id = p.shipToLocationId;
  if (p.status !== undefined) c.status = p.status;
  if (p.paymentTerms !== undefined) c.payment_terms = p.paymentTerms;
  if (p.expectedDate !== undefined) c.expected_date = p.expectedDate;
  if (p.freightAmount !== undefined) c.freight_amount = p.freightAmount;
  if (p.currency !== undefined) c.currency = p.currency;
  if (p.totalAmount !== undefined) c.total_amount = p.totalAmount;
  if (p.approvalRequestId !== undefined) c.approval_request_id = p.approvalRequestId;
  if (p.approvalState !== undefined) c.approval_state = p.approvalState;
  if (p.notes !== undefined) c.notes = p.notes;
  if (p.attachmentIds !== undefined) c.attachment_media_ids = [...p.attachmentIds] as never;
  if (p.sentAt !== undefined) c.sent_at = p.sentAt;
  if (p.closedAt !== undefined) c.closed_at = p.closedAt;
  if (p.closeReason !== undefined) c.close_reason = p.closeReason;
  return c;
};

const toLine = (r: T<'purchase_order_lines'>): PoLineRow => ({
  id: r.id,
  purchaseOrderId: r.purchase_order_id,
  stockItemId: r.stock_item_id,
  sku: r.sku,
  label: r.label,
  qtyOrdered: r.qty_ordered,
  qtyReceived: r.qty_received,
  qtyDamaged: r.qty_damaged,
  qtyClosed: r.qty_closed,
  unitCostAmount: Number(r.unit_cost_amount),
  expectedDate: r.expected_date,
});

const toEvent = (r: T<'purchase_order_events'>): PoEventRow => ({
  id: r.id,
  purchaseOrderId: r.purchase_order_id,
  label: r.label,
  detail: r.detail,
  actorKind: r.actor_kind,
  actorId: r.actor_id,
  at: asDate(r.at),
});

const toDelivery = (r: T<'deliveries'>): DeliveryRow => ({
  id: r.id,
  purchaseOrderId: r.purchase_order_id,
  carrier: r.carrier,
  trackingRef: r.tracking_ref,
  windowFrom: asDate(r.window_from),
  windowTo: asDate(r.window_to),
  units: r.units,
  status: r.status as DeliveryStatus,
  delayReason: r.delay_reason,
  arrivedAt: asDateOrNull(r.arrived_at),
  dock: r.dock,
});

const deliveryCols = (p: Partial<DeliveryRow>) => {
  const c: Partial<T<'deliveries'>> = {};
  if (p.carrier !== undefined) c.carrier = p.carrier;
  if (p.trackingRef !== undefined) c.tracking_ref = p.trackingRef;
  if (p.windowFrom !== undefined) c.window_from = p.windowFrom;
  if (p.windowTo !== undefined) c.window_to = p.windowTo;
  if (p.units !== undefined) c.units = p.units;
  if (p.status !== undefined) c.status = p.status;
  if (p.delayReason !== undefined) c.delay_reason = p.delayReason;
  if (p.arrivedAt !== undefined) c.arrived_at = p.arrivedAt;
  if (p.dock !== undefined) c.dock = p.dock;
  return c;
};

const toReceipt = (r: T<'receipts'>): ReceiptRow => ({
  id: r.id,
  ref: r.ref,
  purchaseOrderId: r.purchase_order_id,
  deliveryId: r.delivery_id,
  locationId: r.location_id,
  status: r.status as ReceiptStatus,
  note: r.note,
  receivedBy: parseActor(r.received_by) ?? { kind: 'system', id: null, name: null },
  startedAt: asDate(r.started_at),
  submittedAt: asDateOrNull(r.submitted_at),
  confirmedBy: parseActor(r.confirmed_by),
  confirmedAt: asDateOrNull(r.confirmed_at),
  inboundId: r.inbound_id ?? null,
});

const toReceiptLine = (r: T<'receipt_lines'>): ReceiptLineRow => ({
  receiptId: r.receipt_id,
  purchaseOrderLineId: r.purchase_order_line_id,
  stockItemId: r.stock_item_id,
  expected: r.expected,
  received: r.received,
  damaged: r.damaged,
  binCode: r.bin_code,
  photoIds: ids(r.photo_media_ids),
  note: r.note,
});

const toClaim = (r: T<'supplier_claims'>): ClaimRow => ({
  id: r.id,
  ref: r.ref,
  supplierId: r.supplier_id,
  purchaseOrderId: r.purchase_order_id,
  receiptId: r.receipt_id,
  kind: r.kind as ClaimKind,
  lines: (Array.isArray(r.lines) ? r.lines : []) as unknown as ClaimLine[],
  amount: Number(r.amount),
  currency: r.currency.trim(),
  status: r.status as ClaimStatus,
  settlement: r.settlement as ClaimRow['settlement'],
  settledAmount: num(r.settled_amount),
  supplierReference: r.supplier_reference,
  owner: parseActor(r.owner_id) ?? { kind: 'system', id: null, name: null },
  notes: r.notes,
  createdAt: asDate(r.created_at),
  decidedAt: asDateOrNull(r.decided_at),
});

const mapPage = <A, B>(p: Page<A>, f: (a: A) => B): Page<B> => ({ ...p, items: p.items.map(f) });

/** Statuses of a purchase order that may still be late or short */
const OPEN_INCOMING: readonly PoStatus[] = ['sent', 'partly_received'];

function claimFilter(filter: ClaimFilter): Filter {
  const and: Filter[] = [];
  if (filter.status) and.push({ status: filter.status });
  if (filter.statuses) and.push({ status: oneOf(filter.statuses) });
  if (filter.supplierId) and.push({ supplier_id: filter.supplierId });
  if (filter.purchaseOrderIds) and.push({ purchase_order_id: oneOf(filter.purchaseOrderIds) });
  return and.length ? { $and: and } : {};
}

/* ------------------------------------------------------------------ repository */

type ForUpdate = { forUpdate?: boolean };

/**
 * purchasing.suppliers, purchasing.supplier_items, purchasing.supplier_performance, purchasing.purchase_orders,
 * purchasing.purchase_order_lines, purchasing.purchase_order_events, purchasing.deliveries, purchasing.receipts,
 * purchasing.receipt_lines, purchasing.supplier_claims (MongoDB, docs/04-mongodb-migration.md). Rows are mapped to
 * the domain terms of ports.ts (camelCase, actors parsed) on the way out.
 */
export class PurchasingRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      suppliers: store.table<T<'suppliers'>>('suppliers'),
      items: store.table<T<'supplier_items'>>('supplier_items'),
      performance: store.table<T<'supplier_performance'>>('supplier_performance'),
      pos: store.table<T<'purchase_orders'>>('purchase_orders'),
      lines: store.table<T<'purchase_order_lines'>>('purchase_order_lines'),
      events: store.table<T<'purchase_order_events'>>('purchase_order_events'),
      deliveries: store.table<T<'deliveries'>>('deliveries'),
      receipts: store.table<T<'receipts'>>('receipts'),
      receiptLines: store.table<T<'receipt_lines'>>('receipt_lines'),
      claims: store.table<T<'supplier_claims'>>('supplier_claims'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<R>(fn: (tx: PurchasingRepository) => Promise<R>): Promise<R> {
    return this.store.transaction((tx) => fn(new PurchasingRepository(tx)));
  }

  /** Purchase orders late or short (the exists-subqueries as two reads): open, with open units, and partly received, with a delayed delivery or past their expected date */
  async #lateOrShortIds(today: string): Promise<string[]> {
    const pos = await this.#t.pos.find({ status: oneOf(OPEN_INCOMING) });
    if (!pos.length) return [];
    const poIds = pos.map((p) => p.id);
    const [lines, delayedIds] = await Promise.all([this.#t.lines.find({ purchase_order_id: oneOf(poIds) }), this.#t.deliveries.distinct<string>('purchase_order_id', { purchase_order_id: oneOf(poIds), status: 'delayed' })]);
    const openLines = new Map<string, T<'purchase_order_lines'>[]>();
    for (const l of lines) {
      if (l.qty_ordered - l.qty_received - l.qty_closed <= 0) continue;
      const list = openLines.get(l.purchase_order_id);
      if (list) list.push(l);
      else openLines.set(l.purchase_order_id, [l]);
    }
    const delayed = new Set(delayedIds);
    return pos
      .filter((po) => {
        const open = openLines.get(po.id) ?? [];
        if (!open.length) return false;
        if (po.status === 'partly_received' || delayed.has(po.id)) return true;
        return open.some((l) => {
          const expected = l.expected_date ?? po.expected_date;
          return expected !== null && expected < today;
        });
      })
      .map((po) => po.id);
  }

  async #receiptFilter(filter: ReceiptFilter): Promise<Filter> {
    const and: Filter[] = [];
    if (filter.status) and.push({ status: filter.status });
    if (filter.purchaseOrderId) and.push({ purchase_order_id: filter.purchaseOrderId });
    if (filter.from) and.push({ started_at: { $gte: filter.from } });
    if (filter.to) and.push({ started_at: { $lt: filter.to } });
    if (filter.withIssues !== undefined) {
      const withIssues = await this.#t.receiptLines.distinct<string>('receipt_id', { $or: [{ $expr: { $ne: ['$received', '$expected'] } }, { damaged: { $gt: 0 } }] });
      and.push({ id: filter.withIssues ? oneOf(withIssues) : { $nin: withIssues } });
    }
    return and.length ? { $and: and } : {};
  }

  /* ---------------------------------------------------------------- suppliers */

  async insertSupplier(row: SupplierRow): Promise<SupplierRow> {
    return toSupplier(
      await this.#t.suppliers.insert({
        id: row.id,
        name: row.name,
        location: row.location,
        contact_name: row.contactName,
        email: row.email,
        phone: row.phone,
        address: row.address as never,
        payment_terms: row.paymentTerms,
        lead_time_days: row.leadTimeDays,
        return_authorization_required: row.returnAuthorizationRequired,
        active: row.active,
        notes: row.notes,
        created_at: row.createdAt,
      }),
    );
  }

  async updateSupplier(id: string, patch: Partial<Omit<SupplierRow, 'id' | 'createdAt'>>): Promise<SupplierRow> {
    const cols = supplierCols(patch);
    if (!Object.keys(cols).length) return (await this.getSupplier(id))!;
    return toSupplier(orThrow(await this.#t.suppliers.update(id, cols), `purchasing: supplier ${id}`));
  }

  async getSupplier(id: string, opts?: ForUpdate): Promise<SupplierRow | null> {
    const r = await this.#t.suppliers.get(id, { forUpdate: opts?.forUpdate });
    return r ? toSupplier(r) : null;
  }

  async getSuppliers(supplierIds: readonly string[]): Promise<SupplierRow[]> {
    return (await this.#t.suppliers.getMany([...new Set(supplierIds)])).map(toSupplier);
  }

  async listSuppliers(filter: { q?: string; active?: boolean }, page: PageRequest): Promise<Page<SupplierRow>> {
    const and: Filter[] = [];
    if (filter.active !== undefined) and.push({ active: filter.active });
    const q = filter.q?.trim();
    if (q) and.push({ $or: [{ name: contains(q) }, { contact_name: contains(q) }, { location: contains(q) }, { email: contains(q) }] });
    return mapPage(await this.#t.suppliers.page(and.length ? { $and: and } : {}, page, { column: 'name', direction: 'asc' }), toSupplier);
  }

  async openPurchaseOrderCounts(supplierIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!supplierIds.length) return out;
    const rows = await this.#t.pos.aggregate<{ _id: string; n: number }>([
      { $match: { supplier_id: { $in: [...new Set(supplierIds)] }, status: { $in: ['draft', 'sent', 'partly_received'] } } },
      { $group: { _id: '$supplier_id', n: { $sum: 1 } } },
    ]);
    for (const r of rows) out.set(r._id, Number(r.n));
    return out;
  }

  /* ---------------------------------------------------------------- price lists */

  async supplierItems(supplierId: string): Promise<SupplierItemRow[]> {
    return (await this.#t.items.find({ supplier_id: supplierId }, { sort: { updated_at: 1, stock_item_id: 1 } })).map(toItem);
  }

  async replaceSupplierItems(supplierId: string, rows: readonly SupplierItemRow[]): Promise<void> {
    await this.#t.items.deleteMany({ supplier_id: supplierId });
    await this.#t.items.insertMany(
      rows.map((r) => ({
        supplier_id: supplierId,
        stock_item_id: r.stockItemId,
        supplier_sku: r.supplierSku,
        unit_cost_amount: r.unitCostAmount,
        currency: r.currency,
        min_order_qty: r.minOrderQty,
        lead_time_days: r.leadTimeDays,
        preferred: r.preferred,
        updated_at: r.updatedAt,
      })),
    );
  }

  /** Unset preferred on other suppliers' rows for these stock items */
  async clearPreferred(stockItemIds: readonly string[], exceptSupplierId: string): Promise<void> {
    if (!stockItemIds.length) return;
    await this.#t.items.updateMany({ stock_item_id: oneOf(stockItemIds), supplier_id: { $ne: exceptSupplierId }, preferred: true }, { preferred: false });
  }

  /** Rows of active suppliers for these stock items (all stock items when omitted, preferred only when asked) */
  async itemsForStock(filter: { stockItemIds?: readonly string[]; preferredOnly?: boolean; supplierId?: string }): Promise<SupplierItemRow[]> {
    if (filter.stockItemIds && !filter.stockItemIds.length) return [];
    // the join with suppliers: active suppliers only
    const active = await this.#t.suppliers.distinct<string>('id', { active: true, ...(filter.supplierId ? { id: filter.supplierId } : {}) });
    const rows = await this.#t.items.find(
      {
        supplier_id: oneOf(active),
        ...(filter.stockItemIds ? { stock_item_id: oneOf(filter.stockItemIds) } : {}),
        ...(filter.preferredOnly ? { preferred: true } : {}),
      },
      { sort: { preferred: -1, unit_cost_amount: 1, updated_at: -1 } },
    );
    return rows.map(toItem);
  }

  /* ---------------------------------------------------------------- performance */

  async performanceOf(supplierIds: readonly string[]): Promise<Map<string, PerformanceRow>> {
    const out = new Map<string, PerformanceRow>();
    if (!supplierIds.length) return out;
    for (const r of await this.#t.performance.find({ supplier_id: oneOf(supplierIds) })) out.set(r.supplier_id, toPerformance(r));
    return out;
  }

  async savePerformance(row: PerformanceRow): Promise<void> {
    await this.#t.performance.upsert({
      supplier_id: row.supplierId,
      window_days: row.windowDays,
      on_time_pct: row.onTimePct === null ? null : String(row.onTimePct),
      avg_lead_time_days: row.avgLeadTimeDays === null ? null : String(row.avgLeadTimeDays),
      shortage_rate_pct: row.shortageRatePct === null ? null : String(row.shortageRatePct),
      damage_rate_pct: row.damageRatePct === null ? null : String(row.damageRatePct),
      deliveries: row.deliveries,
      computed_at: row.computedAt,
    });
  }

  async performanceInputs(since: Date): Promise<PerformanceInputs[]> {
    const poCollection = `${this.store.module}.purchase_orders`;
    const deliveries = await this.#t.deliveries.aggregate<{ _id: string; deliveries: number; on_time: number; lead_ms: number; lead_n: number }>([
      { $match: { arrived_at: { $gte: since } } },
      { $lookup: { from: poCollection, localField: 'purchase_order_id', foreignField: '_id', as: 'po' } },
      { $unwind: '$po' },
      {
        $group: {
          _id: '$po.supplier_id',
          deliveries: { $sum: 1 },
          on_time: { $sum: { $cond: [{ $lte: ['$arrived_at', '$window_to'] }, 1, 0] } },
          lead_ms: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$po.sent_at', null] }, null] }, 0, { $subtract: ['$arrived_at', '$po.sent_at'] }] } },
          lead_n: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$po.sent_at', null] }, null] }, 0, 1] } },
        },
      },
    ]);
    const counts = await this.#t.receipts.aggregate<{ _id: string; expected: number; received: number; shortage: number; damaged: number }>([
      { $match: { status: { $in: [...SUBMITTED_RECEIPT_STATUSES] }, submitted_at: { $gte: since } } },
      { $lookup: { from: poCollection, localField: 'purchase_order_id', foreignField: '_id', as: 'po' } },
      { $unwind: '$po' },
      { $lookup: { from: `${this.store.module}.receipt_lines`, localField: '_id', foreignField: 'receipt_id', as: 'l' } },
      { $unwind: '$l' },
      {
        $group: {
          _id: '$po.supplier_id',
          expected: { $sum: '$l.expected' },
          received: { $sum: '$l.received' },
          shortage: { $sum: { $max: [{ $subtract: ['$l.expected', '$l.received'] }, 0] } },
          damaged: { $sum: '$l.damaged' },
        },
      },
    ]);
    const out = new Map<string, PerformanceInputs>();
    const get = (id: string) => {
      let v = out.get(id);
      if (!v) out.set(id, (v = { supplierId: id, deliveries: 0, onTime: 0, leadTimeMsTotal: 0, leadTimeCount: 0, expected: 0, received: 0, shortage: 0, damaged: 0 }));
      return v;
    };
    for (const d of deliveries) Object.assign(get(d._id), { deliveries: Number(d.deliveries), onTime: Number(d.on_time), leadTimeMsTotal: Number(d.lead_ms), leadTimeCount: Number(d.lead_n) });
    for (const c of counts) Object.assign(get(c._id), { expected: Number(c.expected), received: Number(c.received), shortage: Number(c.shortage), damaged: Number(c.damaged) });
    return [...out.values()];
  }

  supplierIds(): Promise<string[]> {
    return this.#t.suppliers.distinct<string>('id');
  }

  /* ---------------------------------------------------------------- purchase orders */

  async insertPurchaseOrder(row: PoRow): Promise<PoRow> {
    return toPo(
      await this.#t.pos.insert({
        id: row.id,
        ref: row.ref,
        supplier_id: row.supplierId,
        ship_to_location_id: row.shipToLocationId,
        status: row.status,
        payment_terms: row.paymentTerms,
        expected_date: row.expectedDate,
        freight_amount: row.freightAmount,
        currency: row.currency,
        total_amount: row.totalAmount,
        approval_request_id: row.approvalRequestId,
        approval_state: row.approvalState,
        notes: row.notes,
        attachment_media_ids: [...row.attachmentIds] as never,
        created_by: actorText(row.createdBy),
        created_at: row.createdAt,
        sent_at: row.sentAt,
        closed_at: row.closedAt,
        close_reason: row.closeReason,
      }),
    );
  }

  async updatePurchaseOrder(id: string, patch: Partial<Omit<PoRow, 'id' | 'ref' | 'createdAt' | 'createdBy'>>): Promise<PoRow> {
    const cols = poCols(patch);
    if (!Object.keys(cols).length) return (await this.getPurchaseOrder(id))!;
    return toPo(orThrow(await this.#t.pos.update(id, cols), `purchasing: purchase order ${id}`));
  }

  async getPurchaseOrder(id: string, opts?: ForUpdate): Promise<PoRow | null> {
    const r = await this.#t.pos.get(id, { forUpdate: opts?.forUpdate });
    return r ? toPo(r) : null;
  }

  async getPurchaseOrders(poIds: readonly string[]): Promise<PoRow[]> {
    return (await this.#t.pos.getMany([...new Set(poIds)])).map(toPo);
  }

  async purchaseOrderByApproval(requestId: string, opts?: ForUpdate): Promise<PoRow | null> {
    const r = await this.#t.pos.findOne({ approval_request_id: requestId }, { forUpdate: opts?.forUpdate });
    return r ? toPo(r) : null;
  }

  async listPurchaseOrders(filter: PoFilter, page: PageRequest): Promise<Page<PoRow>> {
    const and: Filter[] = [];
    if (filter.status) and.push({ status: filter.status });
    if (filter.supplierId) and.push({ supplier_id: filter.supplierId });
    if (filter.awaitingApproval !== undefined) and.push({ approval_state: filter.awaitingApproval ? 'pending' : { $ne: 'pending' } });
    const q = filter.q?.trim();
    if (q) {
      // the ref, the supplier's name, or a line's SKU or label
      const suppliers = await this.#t.suppliers.distinct<string>('id', { name: contains(q) });
      const byLine = await this.#t.lines.distinct<string>('purchase_order_id', { $or: [{ sku: contains(q) }, { label: contains(q) }] });
      and.push({ $or: [{ ref: contains(q) }, { supplier_id: oneOf(suppliers) }, { id: oneOf(byLine) }] });
    }
    if (filter.lateOrShort !== undefined) {
      const late = await this.#lateOrShortIds(filter.today);
      and.push({ id: filter.lateOrShort ? oneOf(late) : { $nin: late } });
    }
    return mapPage(await this.#t.pos.page(and.length ? { $and: and } : {}, page, { column: 'created_at', direction: 'desc' }), toPo);
  }

  async purchaseOrdersBy(filter: { statuses?: readonly PoStatus[]; supplierId?: string; locationId?: string; limit?: number }): Promise<PoRow[]> {
    const rows = await this.#t.pos.find(
      {
        ...(filter.statuses ? { status: oneOf(filter.statuses) } : {}),
        ...(filter.supplierId ? { supplier_id: filter.supplierId } : {}),
        ...(filter.locationId ? { ship_to_location_id: filter.locationId } : {}),
      },
      { sort: { created_at: -1, id: -1 }, ...(filter.limit ? { limit: filter.limit } : {}) },
    );
    return rows.map(toPo);
  }

  async insertLines(rows: readonly PoLineRow[]): Promise<void> {
    await this.#t.lines.insertMany(
      rows.map((r) => ({
        id: r.id,
        purchase_order_id: r.purchaseOrderId,
        stock_item_id: r.stockItemId,
        sku: r.sku,
        label: r.label,
        qty_ordered: r.qtyOrdered,
        qty_received: r.qtyReceived,
        qty_damaged: r.qtyDamaged,
        qty_closed: r.qtyClosed,
        unit_cost_amount: r.unitCostAmount,
        expected_date: r.expectedDate,
      })),
    );
  }

  async deleteLines(purchaseOrderId: string): Promise<void> {
    await this.#t.lines.deleteMany({ purchase_order_id: purchaseOrderId });
  }

  async linesOf(poIds: readonly string[]): Promise<PoLineRow[]> {
    if (!poIds.length) return [];
    return (await this.#t.lines.find({ purchase_order_id: oneOf(poIds) }, { sort: { id: 1 } })).map(toLine);
  }

  async updateLine(id: string, patch: Partial<Pick<PoLineRow, 'qtyReceived' | 'qtyDamaged' | 'qtyClosed' | 'expectedDate'>>): Promise<void> {
    const c: Partial<T<'purchase_order_lines'>> = {};
    if (patch.qtyReceived !== undefined) c.qty_received = patch.qtyReceived;
    if (patch.qtyDamaged !== undefined) c.qty_damaged = patch.qtyDamaged;
    if (patch.qtyClosed !== undefined) c.qty_closed = patch.qtyClosed;
    if (patch.expectedDate !== undefined) c.expected_date = patch.expectedDate;
    if (!Object.keys(c).length) return;
    await this.#t.lines.update(id, c);
  }

  /** Lines on purchase orders in these statuses for one stock item */
  async linesForStock(stockItemIds: readonly string[], statuses: readonly PoStatus[]): Promise<(PoLineRow & { ref: string; status: PoStatus; poExpectedDate: string | null })[]> {
    if (!stockItemIds.length) return [];
    const lines = await this.#t.lines.find({ stock_item_id: oneOf(stockItemIds) });
    if (!lines.length) return [];
    const pos = new Map((await this.#t.pos.find({ id: oneOf(lines.map((l) => l.purchase_order_id)), status: oneOf(statuses) })).map((p) => [p.id, p]));
    return lines
      .filter((l) => pos.has(l.purchase_order_id))
      .sort((a, b) => pos.get(a.purchase_order_id)!.created_at.getTime() - pos.get(b.purchase_order_id)!.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((l) => {
        const po = pos.get(l.purchase_order_id)!;
        return { ...toLine(l), ref: po.ref, status: po.status as PoStatus, poExpectedDate: po.expected_date };
      });
  }

  async addEvent(row: PoEventRow): Promise<void> {
    await this.#t.events.insert({ id: row.id, purchase_order_id: row.purchaseOrderId, label: row.label, detail: row.detail, actor_kind: row.actorKind, actor_id: row.actorId, at: row.at });
  }

  async eventsOf(purchaseOrderId: string): Promise<PoEventRow[]> {
    return (await this.#t.events.find({ purchase_order_id: purchaseOrderId }, { sort: { at: -1, id: -1 } })).map(toEvent);
  }

  /* ---------------------------------------------------------------- deliveries */

  async insertDelivery(row: DeliveryRow): Promise<DeliveryRow> {
    return toDelivery(
      await this.#t.deliveries.insert({
        id: row.id,
        purchase_order_id: row.purchaseOrderId,
        carrier: row.carrier,
        tracking_ref: row.trackingRef,
        window_from: row.windowFrom,
        window_to: row.windowTo,
        units: row.units,
        status: row.status,
        delay_reason: row.delayReason,
        arrived_at: row.arrivedAt,
        dock: row.dock,
      }),
    );
  }

  async updateDelivery(id: string, patch: Partial<Omit<DeliveryRow, 'id' | 'purchaseOrderId'>>): Promise<DeliveryRow> {
    const cols = deliveryCols(patch);
    if (!Object.keys(cols).length) return (await this.getDelivery(id))!;
    return toDelivery(orThrow(await this.#t.deliveries.update(id, cols), `purchasing: delivery ${id}`));
  }

  async getDelivery(id: string, opts?: ForUpdate): Promise<DeliveryRow | null> {
    const r = await this.#t.deliveries.get(id, { forUpdate: opts?.forUpdate });
    return r ? toDelivery(r) : null;
  }

  async deliveriesOf(poIds: readonly string[]): Promise<DeliveryRow[]> {
    if (!poIds.length) return [];
    return (await this.#t.deliveries.find({ purchase_order_id: oneOf(poIds) }, { sort: { window_from: 1, id: 1 } })).map(toDelivery);
  }

  async listDeliveries(filter: DeliveryFilter, page: PageRequest): Promise<Page<DeliveryRow>> {
    const and: Filter[] = [];
    if (filter.status) and.push({ status: filter.status });
    if (filter.purchaseOrderId) and.push({ purchase_order_id: filter.purchaseOrderId });
    if (filter.from) and.push({ window_from: { $gte: filter.from } });
    if (filter.to) and.push({ window_from: { $lt: filter.to } });
    return mapPage(await this.#t.deliveries.page(and.length ? { $and: and } : {}, page, { column: 'window_from', direction: 'asc' }), toDelivery);
  }

  async deliveriesBy(filter: { statuses?: readonly DeliveryStatus[]; from?: Date; to?: Date; windowToBefore?: Date; locationId?: string; limit?: number }): Promise<DeliveryRow[]> {
    const and: Filter[] = [];
    if (filter.statuses) and.push({ status: oneOf(filter.statuses) });
    if (filter.from) and.push({ window_from: { $gte: filter.from } });
    if (filter.to) and.push({ window_from: { $lt: filter.to } });
    if (filter.windowToBefore) and.push({ window_to: { $lt: filter.windowToBefore } });
    if (filter.locationId) and.push({ purchase_order_id: oneOf(await this.#t.pos.distinct<string>('id', { ship_to_location_id: filter.locationId })) });
    const rows = await this.#t.deliveries.find(and.length ? { $and: and } : {}, { sort: { window_from: 1, id: 1 }, ...(filter.limit ? { limit: filter.limit } : {}) });
    return rows.map(toDelivery);
  }

  cancelPendingDeliveries(purchaseOrderId: string, reason: string): Promise<number> {
    return this.#t.deliveries.updateMany({ purchase_order_id: purchaseOrderId, status: oneOf(['expected', 'delayed']) }, { status: 'cancelled', delay_reason: reason });
  }

  /* ---------------------------------------------------------------- receipts */

  async insertReceipt(row: ReceiptRow, lines: readonly ReceiptLineRow[]): Promise<ReceiptRow> {
    const r = await this.#t.receipts.insert({
      id: row.id,
      ref: row.ref,
      purchase_order_id: row.purchaseOrderId,
      delivery_id: row.deliveryId,
      location_id: row.locationId,
      status: row.status,
      note: row.note,
      received_by: actorText(row.receivedBy),
      started_at: row.startedAt,
      submitted_at: row.submittedAt,
      confirmed_by: row.confirmedBy ? actorText(row.confirmedBy) : null,
      confirmed_at: row.confirmedAt,
      inbound_id: row.inboundId ?? null,
    });
    await this.#t.receiptLines.insertMany(
      lines.map((l) => ({
        receipt_id: row.id,
        purchase_order_line_id: l.purchaseOrderLineId,
        stock_item_id: l.stockItemId,
        expected: l.expected,
        received: l.received,
        damaged: l.damaged,
        bin_code: l.binCode,
        photo_media_ids: [...l.photoIds] as never,
        note: l.note,
      })),
    );
    return toReceipt(r);
  }

  async updateReceipt(id: string, patch: Partial<Omit<ReceiptRow, 'id' | 'ref' | 'purchaseOrderId' | 'deliveryId' | 'startedAt'>>): Promise<ReceiptRow> {
    const c: Partial<T<'receipts'>> = {};
    if (patch.locationId !== undefined) c.location_id = patch.locationId;
    if (patch.status !== undefined) c.status = patch.status;
    if (patch.note !== undefined) c.note = patch.note;
    if (patch.receivedBy !== undefined) c.received_by = actorText(patch.receivedBy);
    if (patch.submittedAt !== undefined) c.submitted_at = patch.submittedAt;
    if (patch.confirmedBy !== undefined) c.confirmed_by = patch.confirmedBy ? actorText(patch.confirmedBy) : null;
    if (patch.confirmedAt !== undefined) c.confirmed_at = patch.confirmedAt;
    if (patch.inboundId !== undefined) c.inbound_id = patch.inboundId;
    if (!Object.keys(c).length) return (await this.getReceipt(id))!;
    return toReceipt(orThrow(await this.#t.receipts.update(id, c), `purchasing: receipt ${id}`));
  }

  async getReceipt(id: string, opts?: ForUpdate): Promise<ReceiptRow | null> {
    const r = await this.#t.receipts.get(id, { forUpdate: opts?.forUpdate });
    return r ? toReceipt(r) : null;
  }

  async receiptsBy(filter: { purchaseOrderIds?: readonly string[]; deliveryIds?: readonly string[]; statuses?: readonly ReceiptStatus[]; submittedFrom?: Date; locationId?: string }): Promise<ReceiptRow[]> {
    if (filter.purchaseOrderIds && !filter.purchaseOrderIds.length) return [];
    if (filter.deliveryIds && !filter.deliveryIds.length) return [];
    const rows = await this.#t.receipts.find(
      {
        ...(filter.purchaseOrderIds ? { purchase_order_id: oneOf(filter.purchaseOrderIds) } : {}),
        ...(filter.deliveryIds ? { delivery_id: oneOf(filter.deliveryIds) } : {}),
        ...(filter.statuses ? { status: oneOf(filter.statuses) } : {}),
        ...(filter.submittedFrom ? { submitted_at: { $gte: filter.submittedFrom } } : {}),
        ...(filter.locationId ? { location_id: filter.locationId } : {}),
      },
      { sort: { started_at: 1, id: 1 } },
    );
    return rows.map(toReceipt);
  }

  async inProgressReceipt(deliveryId: string): Promise<ReceiptRow | null> {
    const r = await this.#t.receipts.findOne({ delivery_id: deliveryId, status: 'in_progress' });
    return r ? toReceipt(r) : null;
  }

  async listReceipts(filter: ReceiptFilter, page: PageRequest): Promise<Page<ReceiptRow>> {
    return mapPage(await this.#t.receipts.page(await this.#receiptFilter(filter), page, { column: 'started_at', direction: 'desc' }), toReceipt);
  }

  async receiptsAfter(filter: ReceiptFilter, after: { startedAt: Date; id: string } | null, limit: number): Promise<ReceiptRow[]> {
    const base = await this.#receiptFilter(filter);
    const f = after ? { $and: [base, { $or: [{ started_at: { $gt: after.startedAt } }, { started_at: after.startedAt, id: { $gt: after.id } }] }] } : base;
    return (await this.#t.receipts.find(f, { sort: { started_at: 1, id: 1 }, limit })).map(toReceipt);
  }

  async receiptLines(receiptIds: readonly string[]): Promise<ReceiptLineRow[]> {
    if (!receiptIds.length) return [];
    const rows = await this.#t.receiptLines.find({ receipt_id: oneOf(receiptIds) }, { sort: { purchase_order_line_id: 1 } });
    // the join with purchase_order_lines: lines whose order line exists, in the order line's id order
    const existing = new Set(await this.#t.lines.distinct<string>('id', { id: oneOf(rows.map((r) => r.purchase_order_line_id)) }));
    return rows.filter((r) => existing.has(r.purchase_order_line_id)).map(toReceiptLine);
  }

  async updateReceiptLine(receiptId: string, purchaseOrderLineId: string, patch: Partial<Pick<ReceiptLineRow, 'received' | 'damaged' | 'binCode' | 'photoIds' | 'note'>>): Promise<void> {
    const c: Partial<T<'receipt_lines'>> = {};
    if (patch.received !== undefined) c.received = patch.received;
    if (patch.damaged !== undefined) c.damaged = patch.damaged;
    if (patch.binCode !== undefined) c.bin_code = patch.binCode;
    if (patch.photoIds !== undefined) c.photo_media_ids = [...patch.photoIds] as never;
    if (patch.note !== undefined) c.note = patch.note;
    if (!Object.keys(c).length) return;
    await this.#t.receiptLines.updateMany({ receipt_id: receiptId, purchase_order_line_id: purchaseOrderLineId }, c);
  }

  /* ---------------------------------------------------------------- claims */

  async insertClaim(row: ClaimRow): Promise<ClaimRow> {
    return toClaim(
      await this.#t.claims.insert({
        id: row.id,
        ref: row.ref,
        supplier_id: row.supplierId,
        purchase_order_id: row.purchaseOrderId,
        receipt_id: row.receiptId,
        kind: row.kind,
        lines: row.lines as never,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        settlement: row.settlement,
        settled_amount: row.settledAmount,
        supplier_reference: row.supplierReference,
        owner_id: actorText(row.owner),
        notes: row.notes,
        created_at: row.createdAt,
        decided_at: row.decidedAt,
      }),
    );
  }

  async updateClaim(id: string, patch: Partial<Pick<ClaimRow, 'status' | 'settlement' | 'settledAmount' | 'supplierReference' | 'notes' | 'decidedAt'>>): Promise<ClaimRow> {
    const c: Partial<T<'supplier_claims'>> = {};
    if (patch.status !== undefined) c.status = patch.status;
    if (patch.settlement !== undefined) c.settlement = patch.settlement;
    if (patch.settledAmount !== undefined) c.settled_amount = patch.settledAmount;
    if (patch.supplierReference !== undefined) c.supplier_reference = patch.supplierReference;
    if (patch.notes !== undefined) c.notes = patch.notes;
    if (patch.decidedAt !== undefined) c.decided_at = patch.decidedAt;
    if (!Object.keys(c).length) return (await this.getClaim(id))!;
    return toClaim(orThrow(await this.#t.claims.update(id, c), `purchasing: claim ${id}`));
  }

  async getClaim(id: string, opts?: ForUpdate): Promise<ClaimRow | null> {
    const r = await this.#t.claims.get(id, { forUpdate: opts?.forUpdate });
    return r ? toClaim(r) : null;
  }

  async claimsBy(filter: ClaimFilter): Promise<ClaimRow[]> {
    return (await this.#t.claims.find(claimFilter(filter), { sort: { created_at: -1, id: -1 } })).map(toClaim);
  }

  async listClaims(filter: ClaimFilter, page: PageRequest): Promise<Page<ClaimRow>> {
    return mapPage(await this.#t.claims.page(claimFilter(filter), page, { column: 'created_at', direction: 'desc' }), toClaim);
  }
}
