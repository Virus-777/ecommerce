import { sql, type Kysely } from 'kysely';
import { paginate, type Page, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type * as common from '../../../../spec/common.js';
import type { ClaimLine, PurchasingDb } from '../../../../spec/purchasing.js';
import { actorText, parseActor, SUBMITTED_RECEIPT_STATUSES, type ClaimKind, type ClaimStatus, type DeliveryStatus, type PoStatus, type ReceiptStatus } from '../../domain/rules.js';
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
  PurchasingRepository,
  ReceiptFilter,
  ReceiptLineRow,
  ReceiptRow,
  SupplierItemRow,
  SupplierRow,
} from '../../ports.js';

type Db = Kysely<PurchasingDb>;
type T<K extends keyof PurchasingDb> = PurchasingDb[K];

const json = (v: unknown): any => JSON.stringify(v ?? null);
const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
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
  if (p.address !== undefined) c.address = p.address === null ? null : json(p.address);
  if (p.paymentTerms !== undefined) c.payment_terms = p.paymentTerms;
  if (p.leadTimeDays !== undefined) c.lead_time_days = p.leadTimeDays;
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
  if (p.attachmentIds !== undefined) c.attachment_media_ids = json(p.attachmentIds);
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
  owner: parseActor(r.owner_id) ?? { kind: 'system', id: null, name: null },
  notes: r.notes,
  createdAt: asDate(r.created_at),
  decidedAt: asDateOrNull(r.decided_at),
});

const mapPage = <A, B>(p: Page<A>, f: (a: A) => B): Page<B> => ({ ...p, items: p.items.map(f) });

/* ------------------------------------------------------------------ repository */

/** Postgres adapter for PurchasingRepository. `db` is scoped to the `purchasing` schema. */
export function createPostgresPurchasingRepository(db: Db, inTransaction = false): PurchasingRepository {
  const repo: PurchasingRepository = {
    async transaction(fn) {
      if (inTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresPurchasingRepository(trx, true)));
    },

    /* ---------------------------------------------------------------- suppliers */

    async insertSupplier(row) {
      const r = await db
        .insertInto('suppliers')
        .values({
          id: row.id,
          name: row.name,
          location: row.location,
          contact_name: row.contactName,
          email: row.email,
          phone: row.phone,
          address: row.address === null ? null : json(row.address),
          payment_terms: row.paymentTerms,
          lead_time_days: row.leadTimeDays,
          active: row.active,
          notes: row.notes,
          created_at: row.createdAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toSupplier(r);
    },

    async updateSupplier(id, patch) {
      const cols = supplierCols(patch);
      if (!Object.keys(cols).length) return (await repo.getSupplier(id))!;
      const r = await db.updateTable('suppliers').set(cols).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      return toSupplier(r);
    },

    async getSupplier(id, opts) {
      let q = db.selectFrom('suppliers').selectAll().where('id', '=', id);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toSupplier(r) : null;
    },

    async getSuppliers(supplierIds) {
      if (!supplierIds.length) return [];
      const rows = await db.selectFrom('suppliers').selectAll().where('id', 'in', [...new Set(supplierIds)]).execute();
      return rows.map(toSupplier);
    },

    async listSuppliers(filter, page) {
      let q = db.selectFrom('suppliers').selectAll();
      if (filter.active !== undefined) q = q.where('active', '=', filter.active);
      if (filter.q?.trim()) {
        const like = `%${likeEscape(filter.q.trim())}%`;
        q = q.where((eb) => eb.or([eb('name', 'ilike', like), eb('contact_name', 'ilike', like), eb('location', 'ilike', like), eb('email', 'ilike', like)]));
      }
      return mapPage(await paginate(q, page, { column: 'name', direction: 'asc' }), toSupplier);
    },

    async openPurchaseOrderCounts(supplierIds) {
      const out = new Map<string, number>();
      if (!supplierIds.length) return out;
      const rows = await db
        .selectFrom('purchase_orders')
        .select(['supplier_id', sql<number>`count(*)::int`.as('n')])
        .where('supplier_id', 'in', [...new Set(supplierIds)])
        .where('status', 'in', ['draft', 'sent', 'partly_received'])
        .groupBy('supplier_id')
        .execute();
      for (const r of rows) out.set(r.supplier_id, Number(r.n));
      return out;
    },

    /* ---------------------------------------------------------------- price lists */

    async supplierItems(supplierId) {
      const rows = await db.selectFrom('supplier_items').selectAll().where('supplier_id', '=', supplierId).orderBy('updated_at', 'asc').orderBy('stock_item_id').execute();
      return rows.map(toItem);
    },

    async replaceSupplierItems(supplierId, rows) {
      await db.deleteFrom('supplier_items').where('supplier_id', '=', supplierId).execute();
      if (!rows.length) return;
      await db
        .insertInto('supplier_items')
        .values(
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
        )
        .execute();
    },

    async clearPreferred(stockItemIds, exceptSupplierId) {
      if (!stockItemIds.length) return;
      await db.updateTable('supplier_items').set({ preferred: false }).where('stock_item_id', 'in', [...new Set(stockItemIds)]).where('supplier_id', '<>', exceptSupplierId).where('preferred', '=', true).execute();
    },

    async itemsForStock(filter) {
      if (filter.stockItemIds && !filter.stockItemIds.length) return [];
      let q = db
        .selectFrom('supplier_items as i')
        .innerJoin('suppliers as s', 's.id', 'i.supplier_id')
        .selectAll('i')
        .where('s.active', '=', true);
      if (filter.stockItemIds) q = q.where('i.stock_item_id', 'in', [...new Set(filter.stockItemIds)]);
      if (filter.preferredOnly) q = q.where('i.preferred', '=', true);
      if (filter.supplierId) q = q.where('i.supplier_id', '=', filter.supplierId);
      const rows = await q.orderBy('i.preferred', 'desc').orderBy('i.unit_cost_amount', 'asc').orderBy('i.updated_at', 'desc').execute();
      return rows.map(toItem);
    },

    /* ---------------------------------------------------------------- performance */

    async performanceOf(supplierIds) {
      const out = new Map<string, PerformanceRow>();
      if (!supplierIds.length) return out;
      const rows = await db.selectFrom('supplier_performance').selectAll().where('supplier_id', 'in', [...new Set(supplierIds)]).execute();
      for (const r of rows) out.set(r.supplier_id, toPerformance(r));
      return out;
    },

    async savePerformance(row) {
      const values = {
        supplier_id: row.supplierId,
        window_days: row.windowDays,
        on_time_pct: row.onTimePct === null ? null : String(row.onTimePct),
        avg_lead_time_days: row.avgLeadTimeDays === null ? null : String(row.avgLeadTimeDays),
        shortage_rate_pct: row.shortageRatePct === null ? null : String(row.shortageRatePct),
        damage_rate_pct: row.damageRatePct === null ? null : String(row.damageRatePct),
        deliveries: row.deliveries,
        computed_at: row.computedAt,
      };
      const { supplier_id: _id, ...rest } = values;
      await db.insertInto('supplier_performance').values(values).onConflict((oc) => oc.column('supplier_id').doUpdateSet(rest)).execute();
    },

    async performanceInputs(since) {
      const deliveries = await db
        .selectFrom('deliveries as d')
        .innerJoin('purchase_orders as po', 'po.id', 'd.purchase_order_id')
        .select([
          'po.supplier_id as supplier_id',
          sql<number>`count(*)::int`.as('deliveries'),
          sql<number>`count(*) filter (where d.arrived_at <= d.window_to)::int`.as('on_time'),
          sql<number>`coalesce(sum(extract(epoch from (d.arrived_at - po.sent_at)) * 1000) filter (where po.sent_at is not null), 0)::float8`.as('lead_ms'),
          sql<number>`count(*) filter (where po.sent_at is not null)::int`.as('lead_n'),
        ])
        .where('d.arrived_at', 'is not', null)
        .where('d.arrived_at', '>=', since)
        .groupBy('po.supplier_id')
        .execute();
      const counts = await db
        .selectFrom('receipt_lines as l')
        .innerJoin('receipts as r', 'r.id', 'l.receipt_id')
        .innerJoin('purchase_orders as po', 'po.id', 'r.purchase_order_id')
        .select([
          'po.supplier_id as supplier_id',
          sql<number>`coalesce(sum(l.expected), 0)::int`.as('expected'),
          sql<number>`coalesce(sum(l.received), 0)::int`.as('received'),
          sql<number>`coalesce(sum(greatest(l.expected - l.received, 0)), 0)::int`.as('shortage'),
          sql<number>`coalesce(sum(l.damaged), 0)::int`.as('damaged'),
        ])
        .where('r.status', 'in', [...SUBMITTED_RECEIPT_STATUSES])
        .where('r.submitted_at', '>=', since)
        .groupBy('po.supplier_id')
        .execute();
      const out = new Map<string, PerformanceInputs>();
      const get = (id: string) => {
        let v = out.get(id);
        if (!v) out.set(id, (v = { supplierId: id, deliveries: 0, onTime: 0, leadTimeMsTotal: 0, leadTimeCount: 0, expected: 0, received: 0, shortage: 0, damaged: 0 }));
        return v;
      };
      for (const d of deliveries) Object.assign(get(d.supplier_id), { deliveries: Number(d.deliveries), onTime: Number(d.on_time), leadTimeMsTotal: Number(d.lead_ms), leadTimeCount: Number(d.lead_n) });
      for (const c of counts) Object.assign(get(c.supplier_id), { expected: Number(c.expected), received: Number(c.received), shortage: Number(c.shortage), damaged: Number(c.damaged) });
      return [...out.values()];
    },

    async supplierIds() {
      return (await db.selectFrom('suppliers').select('id').execute()).map((r) => r.id);
    },

    /* ---------------------------------------------------------------- purchase orders */

    async insertPurchaseOrder(row) {
      const r = await db
        .insertInto('purchase_orders')
        .values({
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
          attachment_media_ids: json(row.attachmentIds),
          created_by: actorText(row.createdBy),
          created_at: row.createdAt,
          sent_at: row.sentAt,
          closed_at: row.closedAt,
          close_reason: row.closeReason,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toPo(r);
    },

    async updatePurchaseOrder(id, patch) {
      const cols = poCols(patch);
      if (!Object.keys(cols).length) return (await repo.getPurchaseOrder(id))!;
      const r = await db.updateTable('purchase_orders').set(cols).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      return toPo(r);
    },

    async getPurchaseOrder(id, opts) {
      let q = db.selectFrom('purchase_orders').selectAll().where('id', '=', id);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toPo(r) : null;
    },

    async getPurchaseOrders(poIds) {
      if (!poIds.length) return [];
      return (await db.selectFrom('purchase_orders').selectAll().where('id', 'in', [...new Set(poIds)]).execute()).map(toPo);
    },

    async purchaseOrderByApproval(requestId, opts) {
      let q = db.selectFrom('purchase_orders').selectAll().where('approval_request_id', '=', requestId);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toPo(r) : null;
    },

    async listPurchaseOrders(filter, page) {
      let q = db.selectFrom('purchase_orders as po').selectAll('po');
      if (filter.status) q = q.where('po.status', '=', filter.status);
      if (filter.supplierId) q = q.where('po.supplier_id', '=', filter.supplierId);
      if (filter.awaitingApproval !== undefined) {
        q = filter.awaitingApproval
          ? q.where('po.approval_state', '=', 'pending')
          : q.where((eb) => eb.or([eb('po.approval_state', 'is', null), eb('po.approval_state', '<>', 'pending')]));
      }
      if (filter.q?.trim()) {
        const like = `%${likeEscape(filter.q.trim())}%`;
        q = q.where((eb) =>
          eb.or([
            eb('po.ref', 'ilike', like),
            eb.exists(eb.selectFrom('suppliers as s').select(sql`1`.as('x')).whereRef('s.id', '=', 'po.supplier_id').where('s.name', 'ilike', like)),
            eb.exists(eb.selectFrom('purchase_order_lines as l').select(sql`1`.as('x')).whereRef('l.purchase_order_id', '=', 'po.id').where((e) => e.or([e('l.sku', 'ilike', like), e('l.label', 'ilike', like)]))),
          ]),
        );
      }
      if (filter.lateOrShort !== undefined) {
        const today = filter.today;
        q = q.where((eb) => {
          const openLine = eb
            .selectFrom('purchase_order_lines as l')
            .select(sql`1`.as('x'))
            .whereRef('l.purchase_order_id', '=', 'po.id')
            .where(sql<boolean>`l.qty_ordered - l.qty_received - l.qty_closed > 0`);
          const late = eb.and([
            eb('po.status', 'in', ['sent', 'partly_received']),
            eb.exists(openLine),
            eb.or([
              eb('po.status', '=', 'partly_received'),
              eb.exists(eb.selectFrom('deliveries as d').select(sql`1`.as('x')).whereRef('d.purchase_order_id', '=', 'po.id').where('d.status', '=', 'delayed')),
              eb.exists(openLine.where(sql<boolean>`coalesce(l.expected_date, po.expected_date) < ${today}::date`)),
            ]),
          ]);
          return filter.lateOrShort ? late : eb.not(late);
        });
      }
      return mapPage(await paginate(q, page, { column: 'po.created_at', direction: 'desc', id: 'po.id' }), toPo);
    },

    async purchaseOrdersBy(filter) {
      let q = db.selectFrom('purchase_orders').selectAll();
      if (filter.statuses) q = q.where('status', 'in', [...filter.statuses]);
      if (filter.supplierId) q = q.where('supplier_id', '=', filter.supplierId);
      if (filter.locationId) q = q.where('ship_to_location_id', '=', filter.locationId);
      q = q.orderBy('created_at', 'desc').orderBy('id', 'desc');
      if (filter.limit) q = q.limit(filter.limit);
      return (await q.execute()).map(toPo);
    },

    async insertLines(rows) {
      if (!rows.length) return;
      await db
        .insertInto('purchase_order_lines')
        .values(
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
        )
        .execute();
    },

    async deleteLines(purchaseOrderId) {
      await db.deleteFrom('purchase_order_lines').where('purchase_order_id', '=', purchaseOrderId).execute();
    },

    async linesOf(poIds) {
      if (!poIds.length) return [];
      const rows = await db.selectFrom('purchase_order_lines').selectAll().where('purchase_order_id', 'in', [...new Set(poIds)]).orderBy('id').execute();
      return rows.map(toLine);
    },

    async updateLine(id, patch) {
      const c: Partial<T<'purchase_order_lines'>> = {};
      if (patch.qtyReceived !== undefined) c.qty_received = patch.qtyReceived;
      if (patch.qtyDamaged !== undefined) c.qty_damaged = patch.qtyDamaged;
      if (patch.qtyClosed !== undefined) c.qty_closed = patch.qtyClosed;
      if (patch.expectedDate !== undefined) c.expected_date = patch.expectedDate;
      if (!Object.keys(c).length) return;
      await db.updateTable('purchase_order_lines').set(c).where('id', '=', id).execute();
    },

    async linesForStock(stockItemIds, statuses) {
      if (!stockItemIds.length) return [];
      const rows = await db
        .selectFrom('purchase_order_lines as l')
        .innerJoin('purchase_orders as po', 'po.id', 'l.purchase_order_id')
        .selectAll('l')
        .select(['po.ref as po_ref', 'po.status as po_status', 'po.expected_date as po_expected_date', 'po.created_at as po_created_at'])
        .where('l.stock_item_id', 'in', [...new Set(stockItemIds)])
        .where('po.status', 'in', [...statuses])
        .orderBy('po.created_at', 'asc')
        .orderBy('l.id')
        .execute();
      return rows.map((r) => ({ ...toLine(r), ref: r.po_ref, status: r.po_status as PoStatus, poExpectedDate: r.po_expected_date }));
    },

    async knownStock(stockItemIds) {
      const out = new Map<string, { sku: string; label: string }>();
      if (!stockItemIds.length) return out;
      const rows = await db
        .selectFrom('purchase_order_lines as l')
        .innerJoin('purchase_orders as po', 'po.id', 'l.purchase_order_id')
        .select(['l.stock_item_id', 'l.sku', 'l.label'])
        .where('l.stock_item_id', 'in', [...new Set(stockItemIds)])
        .orderBy('po.created_at', 'asc')
        .execute();
      for (const r of rows) out.set(r.stock_item_id, { sku: r.sku, label: r.label }); // latest wins
      return out;
    },

    async addEvent(row) {
      await db
        .insertInto('purchase_order_events')
        .values({ id: row.id, purchase_order_id: row.purchaseOrderId, label: row.label, detail: row.detail, actor_kind: row.actorKind, actor_id: row.actorId, at: row.at })
        .execute();
    },

    async eventsOf(purchaseOrderId) {
      const rows = await db.selectFrom('purchase_order_events').selectAll().where('purchase_order_id', '=', purchaseOrderId).orderBy('at', 'desc').orderBy('id', 'desc').execute();
      return rows.map(toEvent);
    },

    /* ---------------------------------------------------------------- deliveries */

    async insertDelivery(row) {
      const r = await db
        .insertInto('deliveries')
        .values({
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
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDelivery(r);
    },

    async updateDelivery(id, patch) {
      const cols = deliveryCols(patch);
      if (!Object.keys(cols).length) return (await repo.getDelivery(id))!;
      return toDelivery(await db.updateTable('deliveries').set(cols).where('id', '=', id).returningAll().executeTakeFirstOrThrow());
    },

    async getDelivery(id, opts) {
      let q = db.selectFrom('deliveries').selectAll().where('id', '=', id);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toDelivery(r) : null;
    },

    async deliveriesOf(poIds) {
      if (!poIds.length) return [];
      const rows = await db.selectFrom('deliveries').selectAll().where('purchase_order_id', 'in', [...new Set(poIds)]).orderBy('window_from', 'asc').orderBy('id').execute();
      return rows.map(toDelivery);
    },

    async listDeliveries(filter: DeliveryFilter, page) {
      let q = db.selectFrom('deliveries').selectAll();
      if (filter.status) q = q.where('status', '=', filter.status);
      if (filter.purchaseOrderId) q = q.where('purchase_order_id', '=', filter.purchaseOrderId);
      if (filter.from) q = q.where('window_from', '>=', filter.from);
      if (filter.to) q = q.where('window_from', '<', filter.to);
      return mapPage(await paginate(q, page, { column: 'window_from', direction: 'asc' }), toDelivery);
    },

    async deliveriesBy(filter) {
      let q = db.selectFrom('deliveries as d').selectAll('d');
      if (filter.statuses) q = q.where('d.status', 'in', [...filter.statuses]);
      if (filter.from) q = q.where('d.window_from', '>=', filter.from);
      if (filter.to) q = q.where('d.window_from', '<', filter.to);
      if (filter.windowToBefore) q = q.where('d.window_to', '<', filter.windowToBefore);
      if (filter.locationId) {
        const loc = filter.locationId;
        q = q.where((eb) => eb.exists(eb.selectFrom('purchase_orders as po').select(sql`1`.as('x')).whereRef('po.id', '=', 'd.purchase_order_id').where('po.ship_to_location_id', '=', loc)));
      }
      q = q.orderBy('d.window_from', 'asc').orderBy('d.id');
      if (filter.limit) q = q.limit(filter.limit);
      return (await q.execute()).map(toDelivery);
    },

    async cancelPendingDeliveries(purchaseOrderId, reason) {
      const r = await db
        .updateTable('deliveries')
        .set({ status: 'cancelled', delay_reason: reason })
        .where('purchase_order_id', '=', purchaseOrderId)
        .where('status', 'in', ['expected', 'delayed'])
        .executeTakeFirst();
      return Number(r.numUpdatedRows ?? 0);
    },

    /* ---------------------------------------------------------------- receipts */

    async insertReceipt(row, lines) {
      const r = await db
        .insertInto('receipts')
        .values({
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
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (lines.length) {
        await db
          .insertInto('receipt_lines')
          .values(
            lines.map((l) => ({
              receipt_id: row.id,
              purchase_order_line_id: l.purchaseOrderLineId,
              stock_item_id: l.stockItemId,
              expected: l.expected,
              received: l.received,
              damaged: l.damaged,
              bin_code: l.binCode,
              photo_media_ids: json(l.photoIds),
              note: l.note,
            })),
          )
          .execute();
      }
      return toReceipt(r);
    },

    async updateReceipt(id, patch) {
      const c: Partial<T<'receipts'>> = {};
      if (patch.locationId !== undefined) c.location_id = patch.locationId;
      if (patch.status !== undefined) c.status = patch.status;
      if (patch.note !== undefined) c.note = patch.note;
      if (patch.receivedBy !== undefined) c.received_by = actorText(patch.receivedBy);
      if (patch.submittedAt !== undefined) c.submitted_at = patch.submittedAt;
      if (patch.confirmedBy !== undefined) c.confirmed_by = patch.confirmedBy ? actorText(patch.confirmedBy) : null;
      if (patch.confirmedAt !== undefined) c.confirmed_at = patch.confirmedAt;
      if (!Object.keys(c).length) return (await repo.getReceipt(id))!;
      return toReceipt(await db.updateTable('receipts').set(c).where('id', '=', id).returningAll().executeTakeFirstOrThrow());
    },

    async getReceipt(id, opts) {
      let q = db.selectFrom('receipts').selectAll().where('id', '=', id);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toReceipt(r) : null;
    },

    async receiptsBy(filter) {
      if (filter.purchaseOrderIds && !filter.purchaseOrderIds.length) return [];
      if (filter.deliveryIds && !filter.deliveryIds.length) return [];
      let q = db.selectFrom('receipts').selectAll();
      if (filter.purchaseOrderIds) q = q.where('purchase_order_id', 'in', [...new Set(filter.purchaseOrderIds)]);
      if (filter.deliveryIds) q = q.where('delivery_id', 'in', [...new Set(filter.deliveryIds)]);
      if (filter.statuses) q = q.where('status', 'in', [...filter.statuses]);
      if (filter.submittedFrom) q = q.where('submitted_at', '>=', filter.submittedFrom);
      if (filter.locationId) q = q.where('location_id', '=', filter.locationId);
      return (await q.orderBy('started_at', 'asc').orderBy('id').execute()).map(toReceipt);
    },

    async inProgressReceipt(deliveryId) {
      const r = await db.selectFrom('receipts').selectAll().where('delivery_id', '=', deliveryId).where('status', '=', 'in_progress').executeTakeFirst();
      return r ? toReceipt(r) : null;
    },

    async listReceipts(filter, page) {
      return mapPage(await paginate(receiptQuery(filter), page, { column: 'r.started_at', direction: 'desc', id: 'r.id' }), toReceipt);
    },

    async receiptsAfter(filter, after, limit) {
      let q = receiptQuery(filter);
      if (after) q = q.where(sql<boolean>`(r.started_at, r.id) > (${after.startedAt}, ${after.id})`);
      return (await q.orderBy('r.started_at', 'asc').orderBy('r.id', 'asc').limit(limit).execute()).map(toReceipt);
    },

    async receiptLines(receiptIds) {
      if (!receiptIds.length) return [];
      const rows = await db
        .selectFrom('receipt_lines as rl')
        .innerJoin('purchase_order_lines as l', 'l.id', 'rl.purchase_order_line_id')
        .selectAll('rl')
        .where('rl.receipt_id', 'in', [...new Set(receiptIds)])
        .orderBy('l.id')
        .execute();
      return rows.map(toReceiptLine);
    },

    async updateReceiptLine(receiptId, purchaseOrderLineId, patch) {
      const c: Partial<T<'receipt_lines'>> = {};
      if (patch.received !== undefined) c.received = patch.received;
      if (patch.damaged !== undefined) c.damaged = patch.damaged;
      if (patch.binCode !== undefined) c.bin_code = patch.binCode;
      if (patch.photoIds !== undefined) c.photo_media_ids = json(patch.photoIds);
      if (patch.note !== undefined) c.note = patch.note;
      if (!Object.keys(c).length) return;
      await db.updateTable('receipt_lines').set(c).where('receipt_id', '=', receiptId).where('purchase_order_line_id', '=', purchaseOrderLineId).execute();
    },

    /* ---------------------------------------------------------------- claims */

    async insertClaim(row) {
      const r = await db
        .insertInto('supplier_claims')
        .values({
          id: row.id,
          ref: row.ref,
          supplier_id: row.supplierId,
          purchase_order_id: row.purchaseOrderId,
          receipt_id: row.receiptId,
          kind: row.kind,
          lines: json(row.lines),
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          settlement: row.settlement,
          settled_amount: row.settledAmount,
          owner_id: actorText(row.owner),
          notes: row.notes,
          created_at: row.createdAt,
          decided_at: row.decidedAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toClaim(r);
    },

    async updateClaim(id, patch) {
      const c: Partial<T<'supplier_claims'>> = {};
      if (patch.status !== undefined) c.status = patch.status;
      if (patch.settlement !== undefined) c.settlement = patch.settlement;
      if (patch.settledAmount !== undefined) c.settled_amount = patch.settledAmount;
      if (patch.notes !== undefined) c.notes = patch.notes;
      if (patch.decidedAt !== undefined) c.decided_at = patch.decidedAt;
      if (!Object.keys(c).length) return (await repo.getClaim(id))!;
      return toClaim(await db.updateTable('supplier_claims').set(c).where('id', '=', id).returningAll().executeTakeFirstOrThrow());
    },

    async getClaim(id, opts) {
      let q = db.selectFrom('supplier_claims').selectAll().where('id', '=', id);
      if (opts?.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toClaim(r) : null;
    },

    async claimsBy(filter) {
      return (await claimQuery(filter).orderBy('created_at', 'desc').orderBy('id', 'desc').execute()).map(toClaim);
    },

    async listClaims(filter, page) {
      return mapPage(await paginate(claimQuery(filter), page, { column: 'created_at', direction: 'desc' }), toClaim);
    },
  };

  function receiptQuery(filter: ReceiptFilter) {
    let q = db.selectFrom('receipts as r').selectAll('r');
    if (filter.status) q = q.where('r.status', '=', filter.status);
    if (filter.purchaseOrderId) q = q.where('r.purchase_order_id', '=', filter.purchaseOrderId);
    if (filter.from) q = q.where('r.started_at', '>=', filter.from);
    if (filter.to) q = q.where('r.started_at', '<', filter.to);
    if (filter.withIssues !== undefined) {
      const issues = (eb: any) =>
        eb.exists(eb.selectFrom('receipt_lines as rl').select(sql`1`.as('x')).whereRef('rl.receipt_id', '=', 'r.id').where(sql<boolean>`(rl.received <> rl.expected or rl.damaged > 0)`));
      q = q.where((eb) => (filter.withIssues ? issues(eb) : eb.not(issues(eb))));
    }
    return q;
  }

  function claimQuery(filter: ClaimFilter) {
    let q = db.selectFrom('supplier_claims').selectAll();
    if (filter.status) q = q.where('status', '=', filter.status);
    if (filter.statuses) q = q.where('status', 'in', [...filter.statuses]);
    if (filter.supplierId) q = q.where('supplier_id', '=', filter.supplierId);
    if (filter.purchaseOrderIds) q = filter.purchaseOrderIds.length ? q.where('purchase_order_id', 'in', [...new Set(filter.purchaseOrderIds)]) : q.where(sql<boolean>`false`);
    return q;
  }

  return repo;
}
