/**
 * Builds API shapes (camelCase spec types) from repository rows, batching the lookups each list needs.
 * Reads only: no rules, no writes.
 */
import { isNotImplemented } from '../../kernel/errors/index.js';
import { dateInZone } from '../../kernel/lib/clock.js';
import { money, sum, type Money } from '../../kernel/lib/money.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type {
  Delivery,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderRow,
  Receipt,
  ReceiptLine,
  ReceiptSummary,
  Supplier,
  SupplierClaim,
  SupplierCue,
  SupplierItem,
} from '../../spec/purchasing.js';
import {
  expectedLabel,
  isLateOrShort,
  lineNote,
  locationOf,
  openQty,
  overOf,
  shortageOf,
} from './domain/rules.js';
import type { ClaimRow, DeliveryRow, PerformanceRow, PoEventRow, PoLineRow, PoRow, PurchasingRepository, ReceiptLineRow, ReceiptRow, StockDirectory, SupplierItemRow, SupplierRow } from './ports.js';

/** Location names are not available from inventory's public API (spec gap); the Official Store ships to its warehouse. */
export const SHIP_TO_NAME = 'Marketly warehouse';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const groupBy = <T>(items: readonly T[], key: (t: T) => string) => {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
};

export interface ViewDeps {
  repo: PurchasingRepository;
  ctx: ModuleContext<'purchasing'>;
  directory: StockDirectory;
}

export class PurchasingViews {
  constructor(private readonly deps: ViewDeps) {}

  private get ctx() {
    return this.deps.ctx;
  }
  private get repo() {
    return this.deps.repo;
  }
  today() {
    return dateInZone(this.ctx.clock.now(), this.ctx.config.market.timeZone);
  }

  /* ---------------------------------------------------------------- suppliers */

  supplierCue(s: SupplierRow | undefined, id: string): SupplierCue {
    return { id, name: s?.name ?? 'Unknown supplier', location: s ? s.location ?? (locationOf(s.address) || null) : null };
  }

  async suppliers(rows: readonly SupplierRow[]): Promise<Supplier[]> {
    const ids = rows.map((r) => r.id);
    const [open, perf] = await Promise.all([this.repo.openPurchaseOrderCounts(ids), this.repo.performanceOf(ids)]);
    return rows.map((r) => this.supplier(r, open.get(r.id) ?? 0, perf.get(r.id)));
  }

  supplier(r: SupplierRow, openPurchaseOrders: number, perf?: PerformanceRow): Supplier {
    return {
      id: r.id,
      name: r.name,
      location: r.location ?? locationOf(r.address),
      contactName: r.contactName,
      email: r.email,
      phone: r.phone,
      address: r.address,
      paymentTerms: r.paymentTerms,
      leadTimeDays: r.leadTimeDays,
      actualLeadTimeDays: perf?.avgLeadTimeDays ?? null,
      onTimePct: perf?.onTimePct ?? null,
      openPurchaseOrders,
      active: r.active,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async supplierItems(rows: readonly SupplierItemRow[]): Promise<SupplierItem[]> {
    const info = await this.describe(rows.map((r) => r.stockItemId));
    return rows.map((r) => ({
      stockItemId: r.stockItemId,
      sku: info.get(r.stockItemId)?.sku ?? '',
      label: info.get(r.stockItemId)?.label ?? 'Stock item',
      supplierSku: r.supplierSku,
      unitCost: money(r.unitCostAmount, r.currency),
      minOrderQuantity: r.minOrderQty,
      leadTimeDays: r.leadTimeDays,
      preferred: r.preferred,
    }));
  }

  /** SKU and label for display; a lookup failure shows the item without them rather than failing the page. */
  async describe(ids: readonly string[]) {
    try {
      return await this.deps.directory.describe(ids);
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'purchasing: stock item lookup failed; showing items without SKU and label');
      return new Map();
    }
  }

  /* ---------------------------------------------------------------- purchase orders */

  poLine(l: PoLineRow, currency: string, poExpected: string | null): PurchaseOrderLine {
    return {
      id: l.id,
      stockItemId: l.stockItemId,
      sku: l.sku,
      label: l.label,
      image: null,
      quantityOrdered: l.qtyOrdered,
      quantityReceived: l.qtyReceived,
      quantityDamaged: l.qtyDamaged,
      quantityClosed: l.qtyClosed,
      quantityOpen: openQty(l),
      unitCost: money(l.unitCostAmount, currency),
      lineTotal: money(l.unitCostAmount * l.qtyOrdered, currency),
      expectedDate: l.expectedDate,
      note: lineNote(l, poExpected),
    };
  }

  async purchaseOrderRows(pos: readonly PoRow[]): Promise<PurchaseOrderRow[]> {
    const ids = pos.map((p) => p.id);
    const [lines, suppliers, deliveries, notes] = await Promise.all([
      this.repo.linesOf(ids),
      this.repo.getSuppliers(pos.map((p) => p.supplierId)),
      this.repo.deliveriesOf(ids),
      Promise.all(pos.map((p) => this.approvalNote(p))),
    ]);
    const byPo = groupBy(lines, (l) => l.purchaseOrderId);
    const delayed = new Set(deliveries.filter((d) => d.status === 'delayed').map((d) => d.purchaseOrderId));
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const today = this.today();
    return pos.map((p, i) => {
      const ls = byPo.get(p.id) ?? [];
      return {
        id: p.id,
        ref: p.ref,
        supplierName: supplierById.get(p.supplierId)?.name ?? 'Unknown supplier',
        lineCount: ls.length,
        units: ls.reduce((n, l) => n + l.qtyOrdered, 0),
        total: money(p.totalAmount, p.currency),
        expectedLabel: expectedLabel(p.expectedDate, ls, p.status),
        status: p.status,
        approvalNote: notes[i] ?? null,
        lateOrShort: isLateOrShort(p.status, p.expectedDate, ls, delayed.has(p.id), today),
      };
    });
  }

  async purchaseOrder(p: PoRow): Promise<PurchaseOrder> {
    const [lines, supplier, deliveries, receipts, claims, events, approval, attachments] = await Promise.all([
      this.repo.linesOf([p.id]),
      this.repo.getSupplier(p.supplierId),
      this.repo.deliveriesOf([p.id]),
      this.repo.receiptsBy({ purchaseOrderIds: [p.id] }),
      this.repo.claimsBy({ purchaseOrderIds: [p.id] }),
      this.repo.eventsOf(p.id),
      this.approvalInfo(p),
      this.mediaRefs(p.attachmentIds, 'small'),
    ]);
    const receiptLines = await this.repo.receiptLines(receipts.map((r) => r.id));
    const linesByReceipt = groupBy(receiptLines, (l) => l.receiptId);
    const subtotal = money(lines.reduce((n, l) => n + l.unitCostAmount * l.qtyOrdered, 0), p.currency);
    const freight = money(p.freightAmount, p.currency);
    const claimViews = await this.claims(claims, { suppliers: supplier ? [supplier] : [], pos: [p] });
    return {
      id: p.id,
      ref: p.ref,
      supplier: this.supplierCue(supplier ?? undefined, p.supplierId),
      shipToLocationId: p.shipToLocationId,
      shipToName: SHIP_TO_NAME,
      status: p.status,
      approval,
      paymentTerms: p.paymentTerms,
      expectedDate: p.expectedDate,
      lines: lines.map((l) => this.poLine(l, p.currency, p.expectedDate)),
      linesSubtotal: subtotal,
      freight,
      total: money(subtotal.amount + freight.amount, p.currency),
      receivedValue: money(lines.reduce((n, l) => n + l.unitCostAmount * l.qtyReceived, 0), p.currency),
      claimsValue: sum(
        claims.filter((c) => c.status !== 'withdrawn' && c.status !== 'rejected').map((c) => money(c.amount, c.currency)),
        p.currency,
      ),
      deliveries: await this.deliveries(deliveries, { pos: [p], lines, supplier: supplier ?? undefined, receipts }),
      receipts: receipts.map((r) => this.receiptSummary(r, linesByReceipt.get(r.id) ?? [])),
      claims: claimViews,
      attachments,
      notes: p.notes,
      timeline: await this.timeline(events, [p.createdBy, ...receipts.map((r) => r.receivedBy)]),
      createdBy: p.createdBy,
      createdAt: p.createdAt.toISOString(),
      sentAt: iso(p.sentAt),
      closedAt: iso(p.closedAt),
    };
  }

  /** Timeline rows keep the actor's kind and id; names come from actors we already know, else access staff refs. */
  private async timeline(events: readonly PoEventRow[], knownActors: readonly common.Actor[]): Promise<common.TimelineEvent[]> {
    const names = new Map<string, string>();
    for (const a of knownActors) if (a.id && a.name) names.set(a.id, a.name);
    const unknown = [...new Set(events.filter((e) => e.actorKind === 'staff' && e.actorId && !names.has(e.actorId)).map((e) => e.actorId!))];
    const access = this.ctx.tryUse('access');
    if (access && unknown.length) {
      await Promise.all(
        unknown.map(async (id) => {
          try {
            const ref = await access.getStaffRef(id);
            if (ref?.name) names.set(id, ref.name);
          } catch (err) {
            if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'access.getStaffRef failed; timeline shows no name');
          }
        }),
      );
    }
    return events.map((e) => {
      const t = timelineEvent(e);
      return e.actorId && names.has(e.actorId) ? { ...t, actor: { ...t.actor!, name: names.get(e.actorId)! } } : t;
    });
  }

  /** ApprovalInfo from access; the local state when access is off or unbuilt. */
  async approvalInfo(p: PoRow): Promise<common.ApprovalInfo | null> {
    if (!p.approvalRequestId) return null;
    const access = this.ctx.tryUse('access');
    if (access) {
      try {
        return await access.approvalInfo(p.approvalRequestId);
      } catch (err) {
        if (!isNotImplemented(err)) this.ctx.log.warn({ err, requestId: p.approvalRequestId }, 'access.approvalInfo failed; showing the local approval state');
      }
    }
    const reason = p.approvalState === 'approved' ? 'Approved' : p.approvalState === 'rejected' ? 'Approval rejected' : 'Above your purchase limit: waiting for approval';
    return { required: true, reason, approvalRequestId: p.approvalRequestId, approvers: [] };
  }

  private async approvalNote(p: PoRow): Promise<string | null> {
    if (!p.approvalRequestId || p.status !== 'draft') return null;
    if (p.approvalState === 'rejected') return 'Approval rejected';
    if (p.approvalState !== 'pending') return null;
    const info = await this.approvalInfo(p);
    return info?.reason ?? 'Waiting for approval';
  }

  /* ---------------------------------------------------------------- deliveries */

  async deliveries(
    rows: readonly DeliveryRow[],
    known: { pos?: readonly PoRow[]; lines?: readonly PoLineRow[]; supplier?: SupplierRow; receipts?: readonly ReceiptRow[] } = {},
  ): Promise<Delivery[]> {
    if (!rows.length) return [];
    const poIds = [...new Set(rows.map((d) => d.purchaseOrderId))];
    const pos = known.pos ?? (await this.repo.getPurchaseOrders(poIds));
    const [lines, suppliers, receipts] = await Promise.all([
      known.lines ?? this.repo.linesOf(poIds),
      known.supplier ? [known.supplier] : this.repo.getSuppliers(pos.map((p) => p.supplierId)),
      known.receipts ?? this.repo.receiptsBy({ deliveryIds: rows.map((d) => d.id) }),
    ]);
    const poById = new Map(pos.map((p) => [p.id, p]));
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const lineCount = new Map<string, number>();
    for (const l of lines) lineCount.set(l.purchaseOrderId, (lineCount.get(l.purchaseOrderId) ?? 0) + 1);
    const receiptOf = new Map<string, ReceiptRow>();
    for (const r of receipts) if (r.status !== 'cancelled') receiptOf.set(r.deliveryId, r); // latest started wins (ordered by started_at)
    return rows.map((d) => {
      const po = poById.get(d.purchaseOrderId);
      return {
        id: d.id,
        purchaseOrderId: d.purchaseOrderId,
        purchaseOrderRef: po?.ref ?? '',
        supplierName: (po && supplierById.get(po.supplierId)?.name) ?? 'Unknown supplier',
        carrier: d.carrier,
        trackingRef: d.trackingRef,
        windowFrom: d.windowFrom.toISOString(),
        windowTo: d.windowTo.toISOString(),
        lineCount: lineCount.get(d.purchaseOrderId) ?? 0,
        units: d.units,
        status: d.status,
        delayReason: d.delayReason,
        arrivedAt: iso(d.arrivedAt),
        dock: d.dock,
        receiptId: receiptOf.get(d.id)?.id ?? null,
      };
    });
  }

  /* ---------------------------------------------------------------- receipts */

  receiptSummary(r: ReceiptRow, lines: readonly ReceiptLineRow[]): ReceiptSummary {
    return {
      id: r.id,
      ref: r.ref,
      status: r.status,
      received: lines.reduce((n, l) => n + l.received, 0),
      damaged: lines.reduce((n, l) => n + l.damaged, 0),
      shortage: lines.reduce((n, l) => n + shortageOf(l), 0),
      receivedBy: r.receivedBy,
      submittedAt: iso(r.submittedAt),
    };
  }

  async receipts(rows: readonly ReceiptRow[]): Promise<Receipt[]> {
    if (!rows.length) return [];
    const poIds = [...new Set(rows.map((r) => r.purchaseOrderId))];
    const [lines, pos, poLines] = await Promise.all([this.repo.receiptLines(rows.map((r) => r.id)), this.repo.getPurchaseOrders(poIds), this.repo.linesOf(poIds)]);
    const suppliers = await this.repo.getSuppliers(pos.map((p) => p.supplierId));
    const photos = new Map((await this.mediaRefs(lines.flatMap((l) => l.photoIds), 'small')).map((m) => [m.id, m]));
    const poById = new Map(pos.map((p) => [p.id, p]));
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const poLineById = new Map(poLines.map((l) => [l.id, l]));
    const byReceipt = groupBy(lines, (l) => l.receiptId);
    return rows.map((r) => {
      const po = poById.get(r.purchaseOrderId);
      const currency = po?.currency ?? this.ctx.config.market.currency;
      const ls = byReceipt.get(r.id) ?? [];
      const out: ReceiptLine[] = ls.map((l) => {
        const pl = poLineById.get(l.purchaseOrderLineId);
        return {
          purchaseOrderLineId: l.purchaseOrderLineId,
          stockItemId: l.stockItemId,
          sku: pl?.sku ?? '',
          label: pl?.label ?? 'Stock item',
          image: null,
          expected: l.expected,
          received: l.received,
          damaged: l.damaged,
          shortage: shortageOf(l),
          over: overOf(l),
          binCode: l.binCode,
          photos: l.photoIds.flatMap((id) => photos.get(id) ?? []),
          note: l.note,
        };
      });
      const received = ls.reduce((n, l) => n + l.received, 0);
      const damaged = ls.reduce((n, l) => n + l.damaged, 0);
      return {
        id: r.id,
        ref: r.ref,
        purchaseOrderId: r.purchaseOrderId,
        purchaseOrderRef: po?.ref ?? '',
        deliveryId: r.deliveryId,
        supplierName: (po && supplierById.get(po.supplierId)?.name) ?? 'Unknown supplier',
        locationId: r.locationId,
        status: r.status,
        lines: out,
        totals: {
          expected: ls.reduce((n, l) => n + l.expected, 0),
          received,
          damaged,
          shortage: ls.reduce((n, l) => n + shortageOf(l), 0),
          sellable: r.status === 'confirmed' ? received - damaged : null,
        },
        buyingCost: money(
          ls.reduce((n, l) => n + l.received * (poLineById.get(l.purchaseOrderLineId)?.unitCostAmount ?? 0), 0),
          currency,
        ),
        note: r.note,
        receivedBy: r.receivedBy,
        startedAt: r.startedAt.toISOString(),
        submittedAt: iso(r.submittedAt),
        confirmedBy: r.confirmedBy,
        confirmedAt: iso(r.confirmedAt),
      };
    });
  }

  /* ---------------------------------------------------------------- claims */

  async claims(rows: readonly ClaimRow[], known: { suppliers?: readonly SupplierRow[]; pos?: readonly PoRow[] } = {}): Promise<SupplierClaim[]> {
    if (!rows.length) return [];
    const supplierIds = rows.map((c) => c.supplierId);
    const poIds = rows.map((c) => c.purchaseOrderId);
    const [suppliers, pos] = await Promise.all([
      known.suppliers && supplierIds.every((id) => known.suppliers!.some((s) => s.id === id)) ? known.suppliers : this.repo.getSuppliers(supplierIds),
      known.pos && poIds.every((id) => known.pos!.some((p) => p.id === id)) ? known.pos : this.repo.getPurchaseOrders(poIds),
    ]);
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const poById = new Map(pos.map((p) => [p.id, p]));
    return rows.map((c) => ({
      id: c.id,
      ref: c.ref,
      supplierId: c.supplierId,
      supplierName: supplierById.get(c.supplierId)?.name ?? 'Unknown supplier',
      purchaseOrderId: c.purchaseOrderId,
      purchaseOrderRef: poById.get(c.purchaseOrderId)?.ref ?? '',
      receiptId: c.receiptId,
      kind: c.kind,
      lines: c.lines,
      amount: money(c.amount, c.currency),
      status: c.status,
      settlement: c.settlement,
      settledAmount: c.settledAmount === null ? null : money(c.settledAmount, c.currency),
      owner: c.owner,
      notes: c.notes,
      createdAt: c.createdAt.toISOString(),
      decidedAt: iso(c.decidedAt),
    }));
  }

  /* ---------------------------------------------------------------- media */

  /** MediaRefs for display; media being off or failing shows no files rather than failing the page. */
  async mediaRefs(ids: readonly string[], size: 'thumb' | 'small' | 'medium' = 'small'): Promise<common.MediaRef[]> {
    if (!ids.length) return [];
    const media = this.ctx.tryUse('media');
    if (!media) return [];
    try {
      return await media.refs([...ids], size);
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'media.refs failed; showing no files');
      return [];
    }
  }
}

export const timelineEvent = (e: PoEventRow): common.TimelineEvent => ({
  at: e.at.toISOString(),
  label: e.label,
  detail: e.detail,
  actor: { kind: e.actorKind as common.Actor['kind'], id: e.actorId, name: null },
});

export const asMoney = (amount: number, currency: string): Money => money(amount, currency);
