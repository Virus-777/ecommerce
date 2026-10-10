import type { Principal } from '../../kernel/auth/index.js';
import { AppError, isAppError, isNotImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { dateInZone, zonedTimeToUtc } from '../../kernel/lib/clock.js';
import { newId } from '../../kernel/lib/ids.js';
import { format as formatMoney, money, type Money } from '../../kernel/lib/money.js';
import { decodeCursor, encodeCursor, pageOf, type Page, type PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as audit from '../../spec/audit.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type {
  ClaimInput,
  ClaimLine,
  Delivery,
  DeliveryInput,
  DeliveryUpdate,
  PurchaseOrder,
  PurchaseOrderInput,
  PurchaseOrderLineInput,
  PurchaseOrderRow,
  PurchaseOrderShipTo,
  PurchaseOrderUpdate,
  PurchasingPublicApi,
  PurchasingSummary,
  Receipt,
  ReceiptLineInput,
  ReceivingStats,
  ReorderSuggestion,
  Supplier,
  SupplierClaim,
  SupplierDetail,
  SupplierInput,
  SupplierItem,
  SupplierItemInput,
} from '../../spec/purchasing.js';
import type { Location } from '../../spec/inventory.js';
import {
  ACTIVE_CLAIM_STATUSES,
  addDays,
  checkDamagePhotos,
  checkOverReceipt,
  days,
  freightShares,
  INCOMING_PO_STATUSES,
  invalid,
  invalidMany,
  isLateOrShort,
  landedUnitCost,
  locationOf,
  minDate,
  OPEN_PO_STATUSES,
  openQty,
  overOf,
  parseRefFormat,
  pct,
  receiptHasIssues,
  RECEIVING_DATASET,
  receiveEvent,
  refStem,
  SEND_ACTION,
  shortageOf,
  shortDate,
  startOfWeek,
  SUBMITTED_RECEIPT_STATUSES,
  suggestedQuantity,
  SYSTEM,
  type ClaimKind,
  type PoStatus,
  type RefFormat,
} from './domain/rules.js';
import { deliveryMachine, purchaseOrderMachine, receiptMachine, supplierClaimMachine } from './domain/state-machines.js';
import { createInventoryStockDirectory } from './infra/inventory/stock-directory.js';
import type { ClaimRow, PoEventRow, PoLineRow, PoRow, PurchasingRepository, ReceiptLineRow, ReceiptRow, StockDirectory, StockInfo, SupplierItemRow, SupplierRow } from './ports.js';
import { PurchasingViews } from './views.js';

export interface PurchasingServiceDeps {
  repo: PurchasingRepository;
  ctx: ModuleContext<'purchasing'>;
  /** Defaults to the inventory-backed directory */
  directory?: StockDirectory;
}

/** Who is acting (from the HTTP handler input). */
export interface Caller {
  principal: Principal;
  actor: common.Actor;
  requestId?: string;
}

interface NewLine {
  stockItemId: string;
  sku: string;
  label: string;
  quantity: number;
  unitCostAmount: number;
  expectedDate: string | null;
}

const DEFAULT_PAYMENT_TERMS = 'Net 30 from invoice';
const PO_REF: RefFormat = { prefix: 'PUR', period: 'YYMM', digits: 4 };
const RECEIPT_REF: RefFormat = { prefix: 'REC', period: 'YYMMDD', digits: 2 };
const CLAIM_REF: RefFormat = { prefix: 'CLM', period: 'YYMMDD', digits: 3 };
const LATE_BATCH = 200;
const EXPORT_BATCH = 200;
const RECENT_POS = 10;
const SHORTAGE_LOOKBACK_DAYS = 180;
const UNUSABLE_ASSET = ['removed', 'deleted', 'expired', 'rejected'];
/** Sales velocity window for reorder suggestions (inventory.getSalesRate) */
const SALES_RATE_DAYS = 30;
/** Suppliers deliver to company warehouses only (not seller virtual locations) */
const isCompanyWarehouse = (l: Location) => l.ownerType === 'official' && l.kind === 'warehouse';

const clean = (s: string | null | undefined): string | null => {
  const t = typeof s === 'string' ? s.trim() : '';
  return t ? t : null;
};
const required = (s: string | null | undefined, path: string, message: string): string => {
  const t = clean(s);
  if (!t) throw invalid(path, message);
  return t;
};
const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
const illegal = (from: string, event: string, message: string) => new AppError('ILLEGAL_TRANSITION', message, { from, event });
const units = (n: number) => `${n} unit${n === 1 ? '' : 's'}`;
const poTarget = (po: PoRow, supplierName?: string) => ({ type: 'purchase_order', id: po.id, ref: po.ref, label: supplierName ?? po.ref, screen: 'admin/purchasing' });

/**
 * Purchasing use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to an endpoint, a publicApi function, a consumed event or a job in docs/api/spec/modules/purchasing.json.
 *
 * Calls to other modules (inventory, access, media, settings, references) happen outside database
 * transactions: the in-process database serializes transactions, so a nested call would wait on itself.
 */
export class PurchasingService implements PurchasingPublicApi {
  readonly views: PurchasingViews;
  readonly directory: StockDirectory;
  /** Company stock items inventory reported low (inventory.stock.low), candidates for reorder suggestions */
  readonly #lowStock = new Map<string, StockInfo>();
  #lastSuggestions: { at: Date; count: number } | null = null;

  constructor(protected readonly deps: PurchasingServiceDeps) {
    this.directory =
      deps.directory ??
      createInventoryStockDirectory({ inventory: () => deps.ctx.use('inventory') });
    this.views = new PurchasingViews({ repo: deps.repo, ctx: deps.ctx, directory: this.directory });
  }

  private get ctx() {
    return this.deps.ctx;
  }
  private get repo() {
    return this.deps.repo;
  }
  private now() {
    return this.ctx.clock.now();
  }
  private today() {
    return dateInZone(this.now(), this.ctx.config.market.timeZone);
  }
  private get currency() {
    return this.ctx.config.market.currency;
  }
  private inventory() {
    return this.ctx.use('inventory');
  }

  /* ================================================================ public API (in-process) */

  /** Used when a return outcome is 'return to supplier' */
  async getPreferredSupplier(stockItemId: string): Promise<{ supplierId: string; name: string; supplierSku: string | null; unitCost: common.Money; returnAuthorizationRequired: boolean } | null> {
    const items = await this.repo.itemsForStock({ stockItemIds: [stockItemId] });
    const best = items[0]; // preferred first, then cheapest
    if (!best) return null;
    const supplier = await this.repo.getSupplier(best.supplierId);
    if (!supplier) return null;
    return { supplierId: supplier.id, name: supplier.name, supplierSku: best.supplierSku, unitCost: money(best.unitCostAmount, best.currency), returnAuthorizationRequired: supplier.returnAuthorizationRequired };
  }

  /** Incoming detail for stock screens and restock estimates */
  async getOpenPurchaseOrders(stockItemId: string): Promise<{ purchaseOrderId: string; ref: string; quantityOpen: number; expectedDate: string | null }[]> {
    const lines = await this.repo.linesForStock([stockItemId], INCOMING_PO_STATUSES);
    const byPo = new Map<string, { purchaseOrderId: string; ref: string; quantityOpen: number; expectedDate: string | null }>();
    for (const l of lines) {
      const open = openQty(l);
      if (!open) continue;
      const due = l.expectedDate ?? l.poExpectedDate;
      const cur = byPo.get(l.purchaseOrderId);
      if (cur) {
        cur.quantityOpen += open;
        cur.expectedDate = minDate([cur.expectedDate, due]);
      } else byPo.set(l.purchaseOrderId, { purchaseOrderId: l.purchaseOrderId, ref: l.ref, quantityOpen: open, expectedDate: due });
    }
    return [...byPo.values()].sort((a, b) => (a.expectedDate ?? '9999').localeCompare(b.expectedDate ?? '9999'));
  }

  /** Export rows for reports dataset purchasing.admin.receiving (receiving records), one row per counted line */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== RECEIVING_DATASET) throw invalid('dataset', `purchasing serves only the ${RECEIVING_DATASET} dataset`);
    if (principal?.kind !== 'staff') throw new AppError('FORBIDDEN', 'Receiving records are exported by staff only', { permission: 'purchasing.orders.view' });
    const f = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const status = typeof f.status === 'string' && receiptMachine.isState(f.status) ? f.status : undefined;
    const date = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);
    let after: { startedAt: Date; id: string } | null = null;
    if (cursor) {
      const [at, id] = decodeCursor(cursor);
      if (typeof at !== 'string' || typeof id !== 'string') throw invalid('cursor', 'not a cursor from this export');
      after = { startedAt: new Date(at), id };
    }
    const rows = await this.repo.receiptsAfter(
      {
        status,
        withIssues: typeof f.withIssues === 'boolean' ? f.withIssues : undefined,
        purchaseOrderId: typeof f.purchaseOrderId === 'string' ? f.purchaseOrderId : undefined,
        from: date(f.from),
        to: date(f.to),
      },
      after,
      EXPORT_BATCH + 1,
    );
    const batch = rows.slice(0, EXPORT_BATCH);
    const receipts = await this.views.receipts(batch);
    const out = receipts.flatMap((r) =>
      r.lines.map((l) => ({
        receiptRef: r.ref,
        receiptStatus: r.status,
        purchaseOrderRef: r.purchaseOrderRef,
        supplierName: r.supplierName,
        locationId: r.locationId,
        sku: l.sku,
        label: l.label,
        expected: l.expected,
        received: l.received,
        damaged: l.damaged,
        shortage: l.shortage,
        over: l.over,
        binCode: l.binCode ?? null,
        note: l.note ?? null,
        receivedBy: r.receivedBy.name ?? r.receivedBy.id ?? null,
        startedAt: r.startedAt,
        submittedAt: r.submittedAt ?? null,
        confirmedBy: r.confirmedBy?.name ?? r.confirmedBy?.id ?? null,
        confirmedAt: r.confirmedAt ?? null,
      })),
    );
    const last = batch.at(-1);
    return rows.length > EXPORT_BATCH && last ? { rows: out, nextCursor: encodeCursor([last.startedAt.toISOString(), last.id]) } : { rows: out };
  }

  /** Registers the receiving export with reports (at boot). Reports being off or unbuilt is not an error. */
  async registerExportDataset(): Promise<void> {
    const reports = this.ctx.tryUse('reports');
    if (!reports) return;
    try {
      await reports.registerDataset({
        key: RECEIVING_DATASET,
        owner: 'purchasing',
        title: 'Receiving records',
        permission: 'purchasing.orders.view',
        audience: 'staff',
        screens: ['ops/receiving'],
        available: true,
        phase: 1,
        columns: [
          ['receiptRef', 'Receipt'], ['receiptStatus', 'Status'], ['purchaseOrderRef', 'Purchase order'], ['supplierName', 'Supplier'], ['locationId', 'Location'],
          ['sku', 'SKU'], ['label', 'Item'], ['expected', 'Expected'], ['received', 'Received'], ['damaged', 'Damaged'], ['shortage', 'Shortage'], ['over', 'Over'],
          ['binCode', 'Bin'], ['note', 'Note'], ['receivedBy', 'Received by'], ['startedAt', 'Started'], ['submittedAt', 'Submitted'], ['confirmedBy', 'Confirmed by'], ['confirmedAt', 'Confirmed'],
        ].map(([key, label]) => ({ key, label })),
      });
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'purchasing: could not register the receiving export with reports');
    }
  }

  /* ================================================================ summary */

  async getSummary(): Promise<PurchasingSummary> {
    const pos = await this.repo.purchaseOrdersBy({ statuses: OPEN_PO_STATUSES });
    const ids = pos.map((p) => p.id);
    const [lines, deliveries, stock, suggestions] = await Promise.all([
      this.repo.linesOf(ids),
      this.repo.deliveriesOf(ids),
      this.inventory().getStockSummary(),
      this.suggestions({}),
    ]);
    const today = this.today();
    const byPo = groupBy(lines, (l) => l.purchaseOrderId);
    const delayed = new Set(deliveries.filter((d) => d.status === 'delayed').map((d) => d.purchaseOrderId));
    let incomingUnits = 0;
    const arrivals: string[] = [];
    const late: { ref: string; open: number }[] = [];
    for (const p of pos) {
      const ls = byPo.get(p.id) ?? [];
      if (!INCOMING_PO_STATUSES.includes(p.status)) continue;
      const open = ls.reduce((n, l) => n + openQty(l), 0);
      incomingUnits += open;
      for (const l of ls) if (openQty(l) > 0) arrivals.push(l.expectedDate ?? p.expectedDate ?? '');
      if (isLateOrShort(p.status, p.expectedDate, ls, delayed.has(p.id), today)) late.push({ ref: p.ref, open });
    }
    for (const d of deliveries) if (d.status === 'expected' || d.status === 'delayed') arrivals.push(dateInZone(d.windowFrom, this.ctx.config.market.timeZone));
    const nextArrival = minDate(arrivals.filter((d) => d && d >= today));
    return {
      openPurchaseOrders: pos.length,
      committed: money(
        pos.reduce((n, p) => n + p.totalAmount, 0),
        this.currency,
      ),
      incomingUnits,
      nextArrival,
      lateOrShort: late.length,
      lateOrShortNote: late.length ? `${late[0]!.ref} · ${units(late[0]!.open)}${late.length > 1 ? ` and ${late.length - 1} more` : ''}` : null,
      lowStockItems: (stock?.lowStockCount ?? 0) + (stock?.outOfStockCount ?? 0),
      reorderSuggested: suggestions.length,
    };
  }

  /* ================================================================ suppliers */

  async listSuppliers(query: { q?: string; active?: boolean }, page: PageRequest): Promise<Page<Supplier>> {
    const p = await this.repo.listSuppliers(query, page);
    return { ...p, items: await this.views.suppliers(p.items) };
  }

  async getSupplier(id: string): Promise<SupplierDetail> {
    const s = await this.repo.getSupplier(id);
    if (!s) throw notFound('Supplier');
    const [items, perf, open, pos, claims, windowDays] = await Promise.all([
      this.repo.supplierItems(id),
      this.repo.performanceOf([id]),
      this.repo.openPurchaseOrderCounts([id]),
      this.repo.purchaseOrdersBy({ supplierId: id, limit: RECENT_POS }),
      this.repo.claimsBy({ supplierId: id, statuses: ACTIVE_CLAIM_STATUSES }),
      this.ctx.settings.get('performanceWindowDays'),
    ]);
    const p = perf.get(id);
    return {
      supplier: this.views.supplier(s, open.get(id) ?? 0, p),
      items: await this.views.supplierItems(items),
      performance: {
        windowDays: p?.windowDays ?? windowDays,
        onTimePct: p?.onTimePct ?? null,
        avgLeadTimeDays: p?.avgLeadTimeDays ?? null,
        shortageRatePct: p?.shortageRatePct ?? null,
        damageRatePct: p?.damageRatePct ?? null,
        deliveries: p?.deliveries ?? 0,
      },
      recentPurchaseOrders: await this.views.purchaseOrderRows(pos),
      openClaims: await this.views.claims(claims, { suppliers: [s] }),
    };
  }

  async createSupplier(input: SupplierInput, by: Caller): Promise<Supplier> {
    const name = required(input.name, 'name', 'Enter the supplier name');
    if (input.leadTimeDays != null && input.leadTimeDays < 0) throw invalid('leadTimeDays', 'Lead time cannot be negative');
    const row = await this.repo.insertSupplier({
      id: newId(),
      name,
      location: locationOf(input.address) || null,
      contactName: clean(input.contactName),
      email: clean(input.email),
      phone: clean(input.phone),
      address: input.address ?? null,
      paymentTerms: clean(input.paymentTerms) ?? DEFAULT_PAYMENT_TERMS,
      leadTimeDays: input.leadTimeDays ?? 0,
      returnAuthorizationRequired: input.returnAuthorizationRequired ?? false,
      active: input.active ?? true,
      notes: clean(input.notes),
      createdAt: this.now(),
    });
    await this.audit({ action: 'purchasing.supplier.create', actionLabel: 'Added supplier', category: 'other', target: supplierTarget(row), after: supplierSnapshot(row) }, by);
    return this.views.supplier(row, 0);
  }

  async updateSupplier(id: string, input: SupplierInput, by: Caller): Promise<Supplier> {
    const name = required(input.name, 'name', 'Enter the supplier name');
    if (input.leadTimeDays != null && input.leadTimeDays < 0) throw invalid('leadTimeDays', 'Lead time cannot be negative');
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.getSupplier(id, { forUpdate: true });
      if (!before) throw notFound('Supplier');
      const patch: Partial<SupplierRow> = { name };
      if (input.contactName !== undefined) patch.contactName = clean(input.contactName);
      if (input.email !== undefined) patch.email = clean(input.email);
      if (input.phone !== undefined) patch.phone = clean(input.phone);
      if (input.address !== undefined) {
        patch.address = input.address ?? null;
        patch.location = locationOf(input.address) || null;
      }
      if (input.paymentTerms !== undefined) patch.paymentTerms = clean(input.paymentTerms) ?? before.paymentTerms;
      if (input.leadTimeDays != null) patch.leadTimeDays = input.leadTimeDays;
      if (input.notes !== undefined) patch.notes = clean(input.notes);
      if (input.active != null) patch.active = input.active;
      if (input.returnAuthorizationRequired != null) patch.returnAuthorizationRequired = input.returnAuthorizationRequired;
      return { before, after: await tx.updateSupplier(id, patch) };
    });
    const deactivated = before.active && !after.active;
    await this.audit(
      {
        action: deactivated ? 'purchasing.supplier.deactivate' : 'purchasing.supplier.update',
        actionLabel: deactivated ? 'Deactivated supplier' : !before.active && after.active ? 'Reactivated supplier' : 'Edited supplier',
        category: 'other',
        target: supplierTarget(after),
        before: supplierSnapshot(before),
        after: supplierSnapshot(after),
      },
      by,
    );
    const [open, perf] = await Promise.all([this.repo.openPurchaseOrderCounts([id]), this.repo.performanceOf([id])]);
    return this.views.supplier(after, open.get(id) ?? 0, perf.get(id));
  }

  async putSupplierItems(id: string, items: SupplierItemInput[], by: Caller): Promise<SupplierItem[]> {
    const supplier = await this.repo.getSupplier(id);
    if (!supplier) throw notFound('Supplier');
    const issues: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    (items ?? []).forEach((it, i) => {
      if (seen.has(it.stockItemId)) issues.push({ path: `items.${i}.stockItemId`, message: 'This item is already on the price list' });
      seen.add(it.stockItemId);
      if (it.unitCost.currency !== this.currency) issues.push({ path: `items.${i}.unitCost.currency`, message: `Buying costs are in ${this.currency}` });
      if (it.unitCost.amount < 0) issues.push({ path: `items.${i}.unitCost.amount`, message: 'Unit cost cannot be negative' });
      if (it.minOrderQuantity != null && it.minOrderQuantity < 1) issues.push({ path: `items.${i}.minOrderQuantity`, message: 'Minimum order is at least 1' });
      if (it.leadTimeDays != null && it.leadTimeDays < 0) issues.push({ path: `items.${i}.leadTimeDays`, message: 'Lead time cannot be negative' });
    });
    if (issues.length) throw invalidMany('Some price list rows are invalid', issues);
    if (items.length) await this.requireCompanyStock(items.map((i) => i.stockItemId));
    const now = this.now();
    const rows: SupplierItemRow[] = items.map((it) => ({
      supplierId: id,
      stockItemId: it.stockItemId,
      supplierSku: clean(it.supplierSku),
      unitCostAmount: it.unitCost.amount,
      currency: it.unitCost.currency,
      minOrderQty: it.minOrderQuantity ?? null,
      leadTimeDays: it.leadTimeDays ?? null,
      preferred: it.preferred ?? false,
      updatedAt: now,
    }));
    const before = await this.repo.transaction(async (tx) => {
      if (!(await tx.getSupplier(id, { forUpdate: true }))) throw notFound('Supplier');
      const before = await tx.supplierItems(id);
      await tx.replaceSupplierItems(id, rows);
      // one preferred supplier per SKU: choosing this one unsets the others
      await tx.clearPreferred(rows.filter((r) => r.preferred).map((r) => r.stockItemId), id);
      return before;
    });
    await this.audit(
      {
        action: 'purchasing.supplier.price_list_replace',
        actionLabel: 'Replaced supplier price list',
        category: 'other',
        target: supplierTarget(supplier),
        before: before.map(itemSnapshot),
        after: rows.map(itemSnapshot),
        beforeText: `${before.length} item${before.length === 1 ? '' : 's'}`,
        afterText: `${rows.length} item${rows.length === 1 ? '' : 's'}`,
      },
      by,
    );
    return this.views.supplierItems(await this.repo.supplierItems(id));
  }

  /* ================================================================ purchase orders */

  async listPurchaseOrders(
    query: { q?: string; status?: PoStatus; supplierId?: string; lateOrShort?: boolean; awaitingApproval?: boolean },
    page: PageRequest,
  ): Promise<Page<PurchaseOrderRow>> {
    const p = await this.repo.listPurchaseOrders({ ...query, today: this.today() }, page);
    return { ...p, items: await this.views.purchaseOrderRows(p.items) };
  }

  async getPurchaseOrder(id: string): Promise<PurchaseOrder> {
    const po = await this.repo.getPurchaseOrder(id);
    if (!po) throw notFound('Purchase order');
    return this.views.purchaseOrder(po);
  }

  async createPurchaseOrder(input: PurchaseOrderInput, by: Caller): Promise<PurchaseOrder> {
    const supplier = await this.repo.getSupplier(input.supplierId);
    if (!supplier) throw invalid('supplierId', 'Choose an existing supplier');
    if (!supplier.active) throw new AppError('SUPPLIER_INACTIVE', `${supplier.name} is deactivated.`, { supplierId: supplier.id });
    const lines = await this.prepareLines(input.lines);
    const freight = input.freight ? this.amountOf(input.freight, 'freight') : 0;
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    await this.checkAttachments(attachmentIds);
    const po = await this.createDraft(
      {
        supplier,
        shipToLocationId: input.shipToLocationId,
        lines,
        freightAmount: freight,
        paymentTerms: clean(input.paymentTerms) ?? supplier.paymentTerms,
        expectedDate: input.expectedDate ?? null,
        notes: clean(input.notes),
        attachmentIds,
      },
      by,
    );
    await this.syncAttachments(po, [], attachmentIds);
    return this.views.purchaseOrder(po);
  }

  async updatePurchaseOrder(id: string, body: PurchaseOrderUpdate, by: Caller): Promise<PurchaseOrder> {
    const before = await this.repo.getPurchaseOrder(id);
    if (!before) throw notFound('Purchase order');
    const draft = before.status === 'draft';
    const incoming = INCOMING_PO_STATUSES.includes(before.status);
    const newLinesInput = body.lines ?? undefined;
    const freightGiven = body.freight != null && body.freight.amount !== before.freightAmount;
    const termsGiven = body.paymentTerms != null && clean(body.paymentTerms) !== before.paymentTerms;
    if (!draft && (newLinesInput || freightGiven || termsGiven)) {
      throw illegal(before.status, 'edit', 'Lines, freight and payment terms change only on a draft. After sending, update expected dates and notes.');
    }
    const datesGiven = body.expectedDate !== undefined || (body.lineExpectedDates != null && Object.keys(body.lineExpectedDates).length > 0);
    if (datesGiven && !draft && !incoming) throw illegal(before.status, 'reschedule', 'Expected dates change only while units are still to come.');
    if (newLinesInput && body.lineExpectedDates && Object.keys(body.lineExpectedDates).length) {
      throw invalid('lineExpectedDates', 'Set expected dates on the new lines instead');
    }

    const oldLines = await this.repo.linesOf([id]);
    const newLines = newLinesInput ? await this.prepareLines(newLinesInput) : null;
    const lineDates = body.lineExpectedDates ?? {};
    const unknownLines = Object.keys(lineDates).filter((lid) => !oldLines.some((l) => l.id === lid));
    if (unknownLines.length) throw invalidMany('Some lines are not on this purchase order', unknownLines.map((lid) => ({ path: `lineExpectedDates.${lid}`, message: 'Not a line of this purchase order' })));
    const freightAmount = body.freight != null ? this.amountOf(body.freight, 'freight') : before.freightAmount;
    const attachmentIds = body.attachmentIds != null ? [...new Set(body.attachmentIds)] : undefined;
    if (attachmentIds) await this.checkAttachments(attachmentIds.filter((a) => !before.attachmentIds.includes(a)));

    const expectedDate = body.expectedDate !== undefined ? (body.expectedDate ?? null) : before.expectedDate;
    const subtotal = newLines ? newLines.reduce((n, l) => n + l.unitCostAmount * l.quantity, 0) : oldLines.reduce((n, l) => n + l.unitCostAmount * l.qtyOrdered, 0);
    const totalAmount = subtotal + freightAmount;
    const totalChanged = draft && totalAmount !== before.totalAmount;
    const dropApproval = totalChanged && before.approvalState === 'pending' && before.approvalRequestId;

    // Incoming in inventory follows new dates of a sent order (external call before the local commit)
    const changedLineDates = oldLines.filter((l) => l.id in lineDates && (lineDates[l.id] ?? null) !== l.expectedDate);
    const datesChanged = expectedDate !== before.expectedDate || changedLineDates.length > 0;
    if (incoming && datesChanged) {
      const supplier = await this.repo.getSupplier(before.supplierId);
      const projected = oldLines.map((l) => ({ ...l, expectedDate: l.id in lineDates ? (lineDates[l.id] ?? null) : l.expectedDate }));
      await this.inventory().expectIncoming(before.id, before.ref, before.shipToLocationId, this.incomingLines(projected, expectedDate, supplier));
    }

    const after = await this.repo.transaction(async (tx) => {
      const cur = await tx.getPurchaseOrder(id, { forUpdate: true });
      if (!cur || cur.status !== before.status) throw new AppError('CONFLICT', 'The purchase order changed meanwhile; reload and try again.');
      const patch: Partial<PoRow> = { expectedDate };
      if (body.notes !== undefined) patch.notes = clean(body.notes);
      if (attachmentIds) patch.attachmentIds = attachmentIds;
      if (draft) {
        patch.freightAmount = freightAmount;
        patch.totalAmount = totalAmount;
        if (body.paymentTerms != null) patch.paymentTerms = clean(body.paymentTerms) ?? cur.paymentTerms;
        if (dropApproval) Object.assign(patch, { approvalRequestId: null, approvalState: null });
      }
      if (newLines) {
        await tx.deleteLines(id);
        await tx.insertLines(newLines.map((l) => this.lineRow(id, l)));
      }
      for (const l of changedLineDates) await tx.updateLine(l.id, { expectedDate: lineDates[l.id] ?? null });
      const updated = await tx.updatePurchaseOrder(id, patch);
      if (draft) await tx.addEvent(this.event(id, 'Draft edited', totalChanged ? `Total ${formatMoney(money(totalAmount, cur.currency))}` : null, by.actor));
      else if (datesChanged) await tx.addEvent(this.event(id, 'Expected date changed', rescheduleText(expectedDate, before.expectedDate, changedLineDates.length, lineDates), by.actor));
      if (dropApproval) await tx.addEvent(this.event(id, 'Approval request withdrawn', 'The order changed after approval was requested', by.actor));
      return updated;
    });

    if (dropApproval) await this.cancelApprovalQuietly(before.approvalRequestId!, by.actor, 'The purchase order changed after approval was requested');
    if (attachmentIds) await this.syncAttachments(after, before.attachmentIds, attachmentIds);
    if (incoming && datesChanged) {
      this.ctx.events.publish(
        'purchasing.delivery.rescheduled',
        {
          deliveryId: null,
          purchaseOrderId: after.id,
          ref: after.ref,
          windowFrom: null,
          windowTo: null,
          reason: rescheduleText(expectedDate, before.expectedDate, changedLineDates.length, lineDates) || 'Expected dates changed',
        },
        { actor: by.actor, requestId: by.requestId },
      );
    }
    await this.audit(
      {
        action: 'purchasing.purchase_order.update',
        actionLabel: draft ? 'Edited draft purchase order' : 'Updated purchase order dates and notes',
        category: 'financial',
        target: poTarget(after),
        before: poSnapshot(before),
        after: poSnapshot(after),
      },
      by,
    );
    return this.views.purchaseOrder(after);
  }

  async sendPurchaseOrder(id: string, body: { emailSupplier?: boolean | null; message?: string | null }, by: Caller): Promise<PurchaseOrder> {
    const po = await this.repo.getPurchaseOrder(id);
    if (!po) throw notFound('Purchase order');
    purchaseOrderMachine.next(po.status, 'send');
    const [lines, supplier] = await Promise.all([this.repo.linesOf([id]), this.repo.getSupplier(po.supplierId)]);
    if (!supplier) throw notFound('Supplier');
    if (!supplier.active) throw new AppError('SUPPLIER_INACTIVE', `${supplier.name} is deactivated.`, { supplierId: supplier.id });
    if (!lines.length) throw invalid('lines', 'Add at least one line before sending');
    if (body.emailSupplier && !supplier.email) throw invalid('emailSupplier', `${supplier.name} has no email address; add one or send the order another way`);
    const total = money(po.totalAmount, po.currency);

    const access = this.ctx.tryUse('access');
    if (!access) throw new AppError('APPROVAL_REQUIRED', 'Purchase limits are unavailable right now, so the order cannot be sent.', { action: SEND_ACTION });
    const check = await access.check(by.principal, SEND_ACTION, { money: total });
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot send purchase orders', { action: SEND_ACTION });

    if (check.decision === 'allowed') {
      if (po.approvalState === 'pending' && po.approvalRequestId) await this.cancelApprovalQuietly(po.approvalRequestId, by.actor, 'Sent within the purchase limit');
      const sent = await this.dispatch(id, { actor: by.actor, requestId: by.requestId, emailSupplier: !!body.emailSupplier, message: clean(body.message), approval: 'clear', approvalNote: check.reason || null });
      return this.views.purchaseOrder(sent);
    }

    // above the buyer's limit: stays Draft with an approval request; sent automatically once approved
    const request = await access.requestApproval({
      action: SEND_ACTION,
      target: { type: 'purchase_order', id: po.id, ref: po.ref, label: `${po.ref} · ${supplier.name}`, screen: 'admin/purchasing' },
      amount: total,
      summary: `Purchase order ${po.ref} of ${formatMoney(total)} to ${supplier.name}`,
      details: { emailSupplier: !!body.emailSupplier, message: clean(body.message), lines: lines.map((l) => ({ sku: l.sku, label: l.label, quantity: l.qtyOrdered, unitCost: money(l.unitCostAmount, po.currency) })) },
      reason: clean(body.message) ?? `Send purchase order ${po.ref} to ${supplier.name}`,
      requestedBy: by.principal,
    });
    const after = await this.repo.transaction(async (tx) => {
      const cur = await tx.getPurchaseOrder(id, { forUpdate: true });
      if (!cur) throw notFound('Purchase order');
      purchaseOrderMachine.next(cur.status, 'send');
      const updated = await tx.updatePurchaseOrder(id, { approvalRequestId: request.id, approvalState: 'pending' });
      if (cur.approvalRequestId !== request.id || cur.approvalState !== 'pending') await tx.addEvent(this.event(id, 'Approval requested', check.reason || 'Above the purchase limit', by.actor));
      return updated;
    });
    await this.audit(
      {
        action: 'purchasing.purchase_order.approval_requested',
        actionLabel: 'Requested approval to send purchase order',
        category: 'financial',
        target: poTarget(after, supplier.name),
        after: { total, approvalRequestId: request.id },
        afterText: `${formatMoney(total)} · ${check.reason}`,
        approvalRequestId: request.id,
      },
      by,
    );
    return this.views.purchaseOrder(after);
  }

  async cancelPurchaseOrder(id: string, body: { reason: string }, by: Caller): Promise<PurchaseOrder> {
    const reason = required(body.reason, 'reason', 'Say why the purchase order is cancelled');
    const po = await this.repo.getPurchaseOrder(id);
    if (!po) throw notFound('Purchase order');
    purchaseOrderMachine.next(po.status, 'cancel');
    const wasSent = po.status === 'sent';
    if (wasSent) {
      await this.assertNothingReceived(this.repo, id);
      await this.inventory().cancelIncoming(id);
    }
    let after: PoRow;
    try {
      after = await this.repo.transaction(async (tx) => {
        const cur = await tx.getPurchaseOrder(id, { forUpdate: true });
        if (!cur) throw notFound('Purchase order');
        const status = purchaseOrderMachine.next(cur.status, 'cancel');
        if (cur.status === 'sent') await this.assertNothingReceived(tx, id);
        const updated = await tx.updatePurchaseOrder(id, { status, closedAt: this.now(), closeReason: reason });
        await tx.cancelPendingDeliveries(id, 'Purchase order cancelled');
        await tx.addEvent(this.event(id, 'Cancelled', reason, by.actor));
        return updated;
      });
    } catch (err) {
      if (wasSent) await this.reExpect(po).catch((e) => this.ctx.log.error({ err: e, purchaseOrderId: id }, 'purchasing: could not restore Incoming after a failed cancel'));
      throw err;
    }
    if (po.approvalState === 'pending' && po.approvalRequestId) await this.cancelApprovalQuietly(po.approvalRequestId, by.actor, reason);
    this.statusChanged(after, po.status, reason, by);
    await this.audit({ action: 'purchasing.purchase_order.cancel', actionLabel: 'Cancelled purchase order', category: 'financial', target: poTarget(after), reason, before: { status: po.status }, after: { status: after.status } }, by);
    return this.views.purchaseOrder(after);
  }

  async closePurchaseOrder(id: string, body: { reason: string; raiseShortageClaim?: boolean | null }, by: Caller): Promise<PurchaseOrder> {
    const reason = required(body.reason, 'reason', 'Say why the remaining units will not arrive');
    const po = await this.repo.getPurchaseOrder(id);
    if (!po) throw notFound('Purchase order');
    purchaseOrderMachine.next(po.status, 'closeShort');
    const counting = (await this.repo.receiptsBy({ purchaseOrderIds: [id], statuses: ['in_progress'] }))[0];
    if (counting) throw illegal(po.status, 'closeShort', `Finish or cancel receiving ${counting.ref} first.`);
    const lines = await this.repo.linesOf([id]);
    const open = lines.filter((l) => openQty(l) > 0).map((l) => ({ line: l, qty: openQty(l) }));
    const claimRef = body.raiseShortageClaim && open.length ? await this.nextRef('claim') : null;
    if (open.length) await this.inventory().cancelIncoming(id, open.map((o) => ({ stockItemId: o.line.stockItemId, quantity: o.qty })));
    const closedUnits = open.reduce((n, o) => n + o.qty, 0);
    const { after, claim } = await this.repo.transaction(async (tx) => {
      const cur = await tx.getPurchaseOrder(id, { forUpdate: true });
      if (!cur) throw notFound('Purchase order');
      const status = purchaseOrderMachine.next(cur.status, 'closeShort');
      for (const o of open) await tx.updateLine(o.line.id, { qtyClosed: o.line.qtyClosed + o.qty });
      const updated = await tx.updatePurchaseOrder(id, { status, closedAt: this.now(), closeReason: reason });
      await tx.cancelPendingDeliveries(id, 'Purchase order closed short');
      await tx.addEvent(this.event(id, `Closed short · ${units(closedUnits)} will not arrive`, reason, by.actor));
      let claim: ClaimRow | null = null;
      if (claimRef) {
        claim = await this.insertClaim(tx, {
          ref: claimRef,
          po: cur,
          receiptId: null,
          kind: 'shortage',
          lines: open.map((o) => ({ stockItemId: o.line.stockItemId, sku: o.line.sku, quantity: o.qty, unitCost: money(o.line.unitCostAmount, cur.currency) })),
          owner: by.actor,
          notes: reason,
        });
      }
      return { after: updated, claim };
    });
    this.statusChanged(after, po.status, reason, by);
    await this.audit(
      {
        action: 'purchasing.purchase_order.close_short',
        actionLabel: 'Closed purchase order short',
        category: 'financial',
        target: poTarget(after),
        reason,
        before: { status: po.status },
        after: { status: after.status, closedUnits, claimId: claim?.id ?? null },
        afterText: `${units(closedUnits)} will not arrive${claim ? ` · claim ${claim.ref}` : ''}`,
      },
      by,
    );
    return this.views.purchaseOrder(after);
  }

  /* ================================================================ reorder suggestions */

  async listReorderSuggestions(query: { supplierId?: string }, page: PageRequest): Promise<Page<ReorderSuggestion>> {
    return pageOf(await this.suggestions({ supplierId: query.supplierId }), page);
  }

  async createFromSuggestions(body: { stockItemIds: string[]; quantities?: Record<string, number> | null; shipToLocationId?: string | null }, by: Caller): Promise<PurchaseOrder[]> {
    const ids = [...new Set(body.stockItemIds ?? [])];
    if (!ids.length) throw invalid('stockItemIds', 'Choose at least one item');
    const quantities = body.quantities ?? {};
    const qIssues = Object.entries(quantities).flatMap(([k, v]) =>
      !ids.includes(k) ? [{ path: `quantities.${k}`, message: 'Not one of the chosen items' }] : !Number.isInteger(v) || v < 1 ? [{ path: `quantities.${k}`, message: 'Order at least 1 unit' }] : [],
    );
    if (qIssues.length) throw invalidMany('Some quantities are invalid', qIssues);
    const suggestions = new Map((await this.suggestions({ stockItemIds: ids, includeAll: true })).map((s) => [s.stockItemId, s]));
    const noSupplier = ids.filter((i) => !suggestions.get(i)?.supplier);
    if (noSupplier.length) throw invalidMany('Some items have no supplier on a price list', noSupplier.map((i) => ({ path: `stockItemIds.${ids.indexOf(i)}`, message: 'No active supplier sells this item; add it to a price list first' })));
    const info = await this.requireCompanyStock(ids);
    // every draft ships to the chosen company warehouse, or inventory's default one (never copied from an earlier PO)
    const shipTo = (await this.shipToLocation(body.shipToLocationId ?? null)).id;
    const items = await this.repo.itemsForStock({ stockItemIds: ids });
    const bySupplier = new Map<string, string[]>();
    for (const id of ids) {
      const sid = suggestions.get(id)!.supplier!.id;
      bySupplier.set(sid, [...(bySupplier.get(sid) ?? []), id]);
    }
    const suppliers = new Map((await this.repo.getSuppliers([...bySupplier.keys()])).map((s) => [s.id, s]));
    for (const s of suppliers.values()) if (!s.active) throw new AppError('SUPPLIER_INACTIVE', `${s.name} is deactivated.`, { supplierId: s.id });
    const today = this.today();
    const created: PoRow[] = [];
    for (const [supplierId, stockIds] of bySupplier) {
      const supplier = suppliers.get(supplierId)!;
      const lines: NewLine[] = stockIds.map((sid) => {
        const item = items.find((i) => i.stockItemId === sid && i.supplierId === supplierId)!;
        return {
          stockItemId: sid,
          sku: info.get(sid)!.sku,
          label: info.get(sid)!.label,
          quantity: quantities[sid] ?? suggestions.get(sid)!.suggestedQuantity,
          unitCostAmount: item.unitCostAmount,
          expectedDate: addDays(today, item.leadTimeDays ?? supplier.leadTimeDays),
        };
      });
      created.push(
        await this.createDraft(
          { supplier, shipToLocationId: shipTo, lines, freightAmount: 0, paymentTerms: supplier.paymentTerms, expectedDate: null, notes: null, attachmentIds: [] },
          by,
          'Created from reorder suggestions',
        ),
      );
    }
    return Promise.all(created.map((p) => this.views.purchaseOrder(p)));
  }

  /**
   * Company stock at or below its reorder point after incoming and drafted units, with the preferred
   * (else cheapest) supplier. Candidates: SKUs on a preferred price list row and SKUs inventory reported low.
   */
  async suggestions(filter: { supplierId?: string; stockItemIds?: string[]; includeAll?: boolean }): Promise<ReorderSuggestion[]> {
    const candidates = new Set<string>(filter.stockItemIds ?? []);
    if (!filter.stockItemIds) {
      for (const i of await this.repo.itemsForStock({ preferredOnly: true, supplierId: filter.supplierId })) candidates.add(i.stockItemId);
      for (const id of this.#lowStock.keys()) candidates.add(id);
    }
    if (!candidates.size) return [];
    const ids = [...candidates];
    const items = await this.repo.itemsForStock({ stockItemIds: ids });
    const best = new Map<string, SupplierItemRow>();
    for (const i of items) if (!best.has(i.stockItemId)) best.set(i.stockItemId, i); // preferred first, then cheapest
    const scoped = filter.supplierId ? ids.filter((id) => best.get(id)?.supplierId === filter.supplierId) : ids;
    if (!scoped.length) return [];
    const [availability, onOrder, coverDays, suppliers, rates] = await Promise.all([
      this.inventory().getAvailability(scoped),
      this.repo.linesForStock(scoped, OPEN_PO_STATUSES),
      this.ctx.settings.get('reorderCoverDays'),
      this.repo.getSuppliers([...new Set(scoped.flatMap((id) => (best.get(id) ? [best.get(id)!.supplierId] : [])))]),
      // units sold per day over the last 30 days (inventory.getSalesRate)
      this.inventory().getSalesRate(scoped, SALES_RATE_DAYS),
    ]);
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    const out: (ReorderSuggestion & { gap: number })[] = [];
    const pending: string[] = [];
    for (const id of scoped) {
      const a = availability?.[id];
      if (!a) continue;
      const reorderPoint = a.lowStockThreshold ?? null;
      const lines = onOrder.filter((l) => l.stockItemId === id);
      const incoming = lines.filter((l) => l.status !== 'draft').reduce((n, l) => n + openQty(l), 0);
      const drafted = lines.filter((l) => l.status === 'draft').reduce((n, l) => n + l.qtyOrdered, 0);
      if (!filter.includeAll && (reorderPoint === null || a.available + incoming + drafted > reorderPoint)) continue;
      const item = best.get(id);
      const supplier = item ? supplierById.get(item.supplierId) : undefined;
      const avgDailySales = rates?.[id] ? Math.round(rates[id]!.avgDailySales * 100) / 100 : null;
      const qty = suggestedQuantity({ available: a.available, incoming: incoming + drafted, reorderPoint: reorderPoint ?? 0, avgDailySales, coverDays, minOrderQuantity: item?.minOrderQty ?? null });
      pending.push(id);
      out.push({
        stockItemId: id,
        sku: '',
        label: '',
        available: a.available,
        reorderPoint,
        incoming,
        avgDailySales,
        suggestedQuantity: qty,
        supplier: supplier ? this.views.supplierCue(supplier, supplier.id) : null,
        unitCost: item ? money(item.unitCostAmount, item.currency) : null,
        estimatedCost: item ? money(item.unitCostAmount * qty, item.currency) : null,
        gap: a.available + incoming - (reorderPoint ?? 0),
      });
    }
    const info = await this.views.describe(pending);
    for (const s of out) {
      const i = info.get(s.stockItemId) ?? this.#lowStock.get(s.stockItemId);
      s.sku = i?.sku ?? '';
      s.label = i?.label ?? 'Stock item';
    }
    return out.sort((a, b) => a.gap - b.gap || a.sku.localeCompare(b.sku)).map(({ gap: _gap, ...s }) => s);
  }

  /* ================================================================ deliveries */

  async listDeliveries(query: { date?: string; status?: Delivery['status']; purchaseOrderId?: string }, page: PageRequest): Promise<Page<Delivery>> {
    const tz = this.ctx.config.market.timeZone;
    const range = query.date ? { from: zonedTimeToUtc(query.date, '00:00', tz), to: zonedTimeToUtc(addDays(query.date, 1), '00:00', tz) } : {};
    const p = await this.repo.listDeliveries({ status: query.status, purchaseOrderId: query.purchaseOrderId, ...range }, page);
    return { ...p, items: await this.views.deliveries(p.items) };
  }

  async addDelivery(purchaseOrderId: string, input: DeliveryInput, by: Caller): Promise<Delivery> {
    const po = await this.repo.getPurchaseOrder(purchaseOrderId);
    if (!po) throw notFound('Purchase order');
    if (!INCOMING_PO_STATUSES.includes(po.status)) throw illegal(po.status, 'addDelivery', 'Deliveries are added to sent purchase orders with units still to come.');
    const from = new Date(input.windowFrom);
    const to = new Date(input.windowTo);
    if (to < from) throw invalid('windowTo', 'The arrival window ends before it starts');
    if (input.units != null && input.units < 1) throw invalid('units', 'A delivery brings at least 1 unit');
    const lines = await this.repo.linesOf([purchaseOrderId]);
    const open = lines.reduce((n, l) => n + openQty(l), 0);
    const row = await this.repo.transaction(async (tx) => {
      const cur = await tx.getPurchaseOrder(purchaseOrderId, { forUpdate: true });
      if (!cur || !INCOMING_PO_STATUSES.includes(cur.status)) throw illegal(cur?.status ?? po.status, 'addDelivery', 'Deliveries are added to sent purchase orders with units still to come.');
      const d = await tx.insertDelivery({
        id: newId(),
        purchaseOrderId,
        carrier: clean(input.carrier),
        trackingRef: clean(input.trackingRef),
        windowFrom: from,
        windowTo: to,
        units: input.units ?? open,
        status: deliveryMachine.initial,
        delayReason: null,
        arrivedAt: null,
        dock: null,
      });
      const day = shortDate(dateInZone(from, this.ctx.config.market.timeZone));
      await tx.addEvent(this.event(purchaseOrderId, `Delivery expected ${day}`, [clean(input.carrier), clean(input.trackingRef), clean(input.note)].filter(Boolean).join(' · ') || null, by.actor));
      return d;
    });
    return (await this.views.deliveries([row]))[0]!;
  }

  async updateDelivery(id: string, body: DeliveryUpdate, by: Caller): Promise<Delivery> {
    const reason = required(body.reason, 'reason', 'Say why the delivery changed');
    const d = await this.repo.getDelivery(id);
    if (!d) throw notFound('Delivery');
    const po = await this.repo.getPurchaseOrder(d.purchaseOrderId);
    if (!po) throw notFound('Purchase order');
    const after = await this.repo.transaction(async (tx) => {
      const cur = await tx.getDelivery(id, { forUpdate: true });
      if (!cur) throw notFound('Delivery');
      const windowFrom = body.windowFrom != null ? new Date(body.windowFrom) : cur.windowFrom;
      const windowTo = body.windowTo != null ? new Date(body.windowTo) : cur.windowTo;
      if (windowTo < windowFrom) throw invalid('windowTo', 'The arrival window ends before it starts');
      const moved = windowFrom.getTime() !== cur.windowFrom.getTime() || windowTo.getTime() !== cur.windowTo.getTime();
      let status = cur.status;
      if (body.delayed === true) status = cur.status === 'delayed' ? deliveryStillOpen(cur.status) : deliveryMachine.next(cur.status, 'delay');
      else if (moved || body.delayed === false) status = deliveryMachine.next(cur.status, 'reschedule');
      else if (cur.status !== 'expected' && cur.status !== 'delayed') throw illegal(cur.status, 'reschedule', 'Only deliveries still to arrive can change.');
      const updated = await tx.updateDelivery(id, {
        windowFrom,
        windowTo,
        status,
        delayReason: reason,
        ...(body.carrier !== undefined ? { carrier: clean(body.carrier) } : {}),
        ...(body.trackingRef !== undefined ? { trackingRef: clean(body.trackingRef) } : {}),
      });
      const label = status === 'delayed' ? 'Delivery delayed' : moved ? `Delivery rescheduled to ${shortDate(dateInZone(windowFrom, this.ctx.config.market.timeZone))}` : 'Delivery updated';
      await tx.addEvent(this.event(cur.purchaseOrderId, label, reason, by.actor));
      return updated;
    });
    this.ctx.events.publish(
      'purchasing.delivery.rescheduled',
      { deliveryId: id, purchaseOrderId: po.id, ref: po.ref, windowFrom: after.windowFrom.toISOString(), windowTo: after.windowTo.toISOString(), reason },
      { actor: by.actor, requestId: by.requestId },
    );
    return (await this.views.deliveries([after]))[0]!;
  }

  async arriveDelivery(id: string, body: { dock?: string | null; arrivedAt?: string | null; note?: string | null }, by: Caller): Promise<Delivery> {
    const now = this.now();
    const arrivedAt = body.arrivedAt ? new Date(body.arrivedAt) : now;
    if (arrivedAt.getTime() > now.getTime() + 5 * 60_000) throw invalid('arrivedAt', 'The arrival time is in the future');
    const dock = clean(body.dock);
    const { after, po } = await this.repo.transaction(async (tx) => {
      const cur = await tx.getDelivery(id, { forUpdate: true });
      if (!cur) throw notFound('Delivery');
      const status = deliveryMachine.next(cur.status, 'arrive');
      const po = await tx.getPurchaseOrder(cur.purchaseOrderId);
      if (!po) throw notFound('Purchase order');
      const updated = await tx.updateDelivery(id, { status, arrivedAt, dock });
      await tx.addEvent(this.event(po.id, dock ? `Delivery arrived · ${dockText(dock)}` : 'Delivery arrived', clean(body.note), by.actor));
      return { after: updated, po };
    });
    this.ctx.events.publish(
      'purchasing.delivery.arrived',
      { deliveryId: id, purchaseOrderId: po.id, ref: po.ref, arrivedAt: arrivedAt.toISOString(), dock },
      { actor: by.actor, requestId: by.requestId },
    );
    return (await this.views.deliveries([after], { pos: [po] }))[0]!;
  }

  /** Creates the receiving record with the open quantity of each line as expected. A receipt cancelled by mistake can be started again. */
  async startReceipt(deliveryId: string, by: Caller): Promise<Receipt> {
    const d = await this.repo.getDelivery(deliveryId);
    if (!d) throw notFound('Delivery');
    const counting = await this.repo.inProgressReceipt(deliveryId);
    if (counting) throw new AppError('RECEIPT_IN_PROGRESS', `${counting.ref} is already being counted for this delivery.`, { receiptId: counting.id });
    if (d.status !== 'receiving') deliveryMachine.next(d.status, 'startReceiving');
    const po = await this.repo.getPurchaseOrder(d.purchaseOrderId);
    if (!po) throw notFound('Purchase order');
    if (!INCOMING_PO_STATUSES.includes(po.status)) throw illegal(po.status, 'startReceiving', 'This purchase order has nothing left to receive.');
    const lines = (await this.repo.linesOf([po.id])).filter((l) => openQty(l) > 0);
    if (!lines.length) throw illegal(po.status, 'startReceiving', 'This purchase order has nothing left to receive.');
    const bins = await this.suggestBins(lines.map((l) => l.stockItemId), po.shipToLocationId);
    const ref = await this.nextRef('receipt');
    let receipt: ReceiptRow;
    try {
      receipt = await this.repo.transaction(async (tx) => {
        const cur = await tx.getDelivery(deliveryId, { forUpdate: true });
        if (!cur) throw notFound('Delivery');
        const open = await tx.inProgressReceipt(deliveryId);
        if (open) throw new AppError('RECEIPT_IN_PROGRESS', `${open.ref} is already being counted for this delivery.`, { receiptId: open.id });
        if (cur.status !== 'receiving') await tx.updateDelivery(deliveryId, { status: deliveryMachine.next(cur.status, 'startReceiving') });
        const id = newId();
        const r = await tx.insertReceipt(
          { id, ref, purchaseOrderId: po.id, deliveryId, locationId: po.shipToLocationId, status: receiptMachine.initial, note: null, receivedBy: by.actor, startedAt: this.now(), submittedAt: null, confirmedBy: null, confirmedAt: null },
          lines.map((l) => ({ receiptId: id, purchaseOrderLineId: l.id, stockItemId: l.stockItemId, expected: openQty(l), received: 0, damaged: 0, binCode: bins.get(l.stockItemId) ?? null, photoIds: [], note: null })),
        );
        await tx.addEvent(this.event(po.id, `Receiving started · ${ref}`, null, by.actor));
        return r;
      });
    } catch (err) {
      // the partial unique index answers a concurrent start
      const again = isAppError(err) ? null : await this.repo.inProgressReceipt(deliveryId);
      if (again) throw new AppError('RECEIPT_IN_PROGRESS', `${again.ref} is already being counted for this delivery.`, { receiptId: again.id });
      throw err;
    }
    return (await this.views.receipts([receipt]))[0]!;
  }

  async getReceivingStats(query: { date?: string; locationId?: string }): Promise<ReceivingStats> {
    const tz = this.ctx.config.market.timeZone;
    const date = query.date ?? this.today();
    const dayStart = zonedTimeToUtc(date, '00:00', tz);
    const dayEnd = zonedTimeToUtc(addDays(date, 1), '00:00', tz);
    const weekStart = zonedTimeToUtc(startOfWeek(date), '00:00', tz);
    const monthAgo = zonedTimeToUtc(addDays(date, -29), '00:00', tz);
    const shortageFrom = zonedTimeToUtc(addDays(date, -SHORTAGE_LOOKBACK_DAYS), '00:00', tz);
    const loc = query.locationId;
    const [today, pending, receiving, recent] = await Promise.all([
      this.repo.deliveriesBy({ from: dayStart, to: dayEnd, locationId: loc }),
      this.repo.deliveriesBy({ statuses: ['expected', 'delayed', 'arrived'], locationId: loc }),
      this.repo.deliveriesBy({ statuses: ['receiving'], locationId: loc }),
      this.repo.receiptsBy({ statuses: SUBMITTED_RECEIPT_STATUSES, submittedFrom: shortageFrom, locationId: loc }),
    ]);
    const expectedToday = today.filter((d) => d.status !== 'cancelled');
    const arrived = pending.filter((d) => d.status === 'arrived').sort((a, b) => (a.arrivedAt?.getTime() ?? 0) - (b.arrivedAt?.getTime() ?? 0));
    const oldest = arrived[0];
    const oldestPo = oldest ? await this.repo.getPurchaseOrder(oldest.purchaseOrderId) : null;

    const lines = await this.repo.receiptLines(recent.map((r) => r.id));
    const linesByReceipt = groupBy(lines, (l) => l.receiptId);
    const inWindow = (r: ReceiptRow, from: Date) => !!r.submittedAt && r.submittedAt >= from && r.submittedAt < dayEnd;
    const week = recent.filter((r) => inWindow(r, weekStart));
    const month = recent.filter((r) => inWindow(r, monthAgo));
    const deliveries = new Map((await this.repo.deliveriesBy({ statuses: ['received', 'received_with_issues'], locationId: loc })).map((d) => [d.id, d]));
    const monthDeliveries = new Set(month.map((r) => r.deliveryId));
    const completed = [...monthDeliveries].filter((id) => deliveries.get(id)?.status === 'received').length;
    const withIssues = [...monthDeliveries].filter((id) => deliveries.get(id)?.status === 'received_with_issues').length;

    // open shortages: lines short or damaged that no settled or rejected claim covers
    const claims = await this.repo.claimsBy({ purchaseOrderIds: [...new Set(recent.map((r) => r.purchaseOrderId))] });
    const covered = new Set(claims.filter((c) => c.status === 'settled' || c.status === 'rejected').flatMap((c) => c.lines.map((l) => `${c.receiptId ?? c.purchaseOrderId}:${l.stockItemId}`)));
    const openLines = recent.flatMap((r) =>
      (linesByReceipt.get(r.id) ?? []).filter((l) => (shortageOf(l) > 0 || l.damaged > 0) && !covered.has(`${r.id}:${l.stockItemId}`) && !covered.has(`${r.purchaseOrderId}:${l.stockItemId}`)).map(() => r),
    );
    let shortageOwner: common.Actor | null = null;
    if (openLines.length) {
      const poIds = new Set(openLines.map((r) => r.purchaseOrderId));
      const active = claims.find((c) => ACTIVE_CLAIM_STATUSES.includes(c.status) && poIds.has(c.purchaseOrderId));
      shortageOwner = active?.owner ?? (await this.repo.getPurchaseOrder(openLines[0]!.purchaseOrderId))?.createdBy ?? null;
    }
    return {
      date,
      expectedToday: expectedToday.length,
      expectedTodayUnits: expectedToday.reduce((n, d) => n + d.units, 0),
      arrivedNotReceived: arrived.length,
      arrivedNote: oldest && oldestPo ? `${oldestPo.ref} ${oldest.dock ? `at ${dockText(oldest.dock)}` : 'at the dock'}` : null,
      receivedThisWeek: new Set(week.map((r) => r.deliveryId)).size,
      receivedThisWeekUnits: week.reduce((n, r) => n + (linesByReceipt.get(r.id) ?? []).reduce((m, l) => m + l.received, 0), 0),
      openShortages: openLines.length,
      shortageOwner,
      tabCounts: { expected: pending.length, receiving: receiving.length, receivedWithIssues: withIssues, completed: completed + withIssues },
    };
  }

  /* ================================================================ receipts */

  async listReceipts(query: { status?: Receipt['status']; withIssues?: boolean; purchaseOrderId?: string }, page: PageRequest): Promise<Page<Receipt>> {
    const p = await this.repo.listReceipts(query, page);
    return { ...p, items: await this.views.receipts(p.items) };
  }

  async getReceipt(id: string): Promise<Receipt> {
    const r = await this.repo.getReceipt(id);
    if (!r) throw notFound('Receiving record');
    return (await this.views.receipts([r]))[0]!;
  }

  async updateReceipt(id: string, body: { lines: ReceiptLineInput[]; note?: string | null }, by: Caller): Promise<Receipt> {
    const receipt = await this.repo.getReceipt(id);
    if (!receipt) throw notFound('Receiving record');
    if (receipt.status !== 'in_progress') throw illegal(receipt.status, 'count', 'Counts can change only while receiving is in progress.');
    const [lines, poLines] = await Promise.all([this.repo.receiptLines([id]), this.repo.linesOf([receipt.purchaseOrderId])]);
    const byLine = new Map(lines.map((l) => [l.purchaseOrderLineId, l]));
    const poLineById = new Map(poLines.map((l) => [l.id, l]));
    const issues: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    (body.lines ?? []).forEach((l, i) => {
      if (!byLine.has(l.purchaseOrderLineId)) issues.push({ path: `lines.${i}.purchaseOrderLineId`, message: 'Not a line of this receiving record' });
      if (seen.has(l.purchaseOrderLineId)) issues.push({ path: `lines.${i}.purchaseOrderLineId`, message: 'This line appears twice' });
      seen.add(l.purchaseOrderLineId);
      if (!Number.isInteger(l.received) || l.received < 0) issues.push({ path: `lines.${i}.received`, message: 'Received is zero or more' });
      if (!Number.isInteger(l.damaged) || l.damaged < 0) issues.push({ path: `lines.${i}.damaged`, message: 'Damaged is zero or more' });
      else if (l.damaged > l.received) issues.push({ path: `lines.${i}.damaged`, message: 'Damaged units are part of the received units' });
    });
    if (issues.length) throw invalidMany('Some counts are invalid', issues);
    const pctAllowed = await this.ctx.settings.get('overReceiptAllowedPct');
    checkOverReceipt(
      body.lines.map((l) => ({ purchaseOrderLineId: l.purchaseOrderLineId, received: l.received, qtyOrdered: poLineById.get(l.purchaseOrderLineId)!.qtyOrdered, alreadyReceived: poLineById.get(l.purchaseOrderLineId)!.qtyReceived })),
      pctAllowed,
    );
    // damage photos: attach new ones as inspection evidence, release removed ones
    const added: string[] = [];
    const removed: string[] = [];
    for (const l of body.lines) {
      if (l.photoIds == null) continue;
      const old = byLine.get(l.purchaseOrderLineId)!.photoIds;
      added.push(...l.photoIds.filter((p) => !old.includes(p)));
      removed.push(...old.filter((p) => !l.photoIds!.includes(p)));
    }
    await this.attachPhotos(receipt, [...new Set(added)]);
    const after = await this.repo.transaction(async (tx) => {
      const cur = await tx.getReceipt(id, { forUpdate: true });
      if (!cur || cur.status !== 'in_progress') throw illegal(cur?.status ?? receipt.status, 'count', 'Counts can change only while receiving is in progress.');
      for (const l of body.lines) {
        await tx.updateReceiptLine(id, l.purchaseOrderLineId, {
          received: l.received,
          damaged: l.damaged,
          ...(l.binCode !== undefined ? { binCode: clean(l.binCode) } : {}),
          ...(l.photoIds != null ? { photoIds: [...new Set(l.photoIds)] } : {}),
          ...(l.note !== undefined ? { note: clean(l.note) } : {}),
        });
      }
      return body.note !== undefined ? tx.updateReceipt(id, { note: clean(body.note) }) : cur;
    });
    await this.detachPhotos(receipt, [...new Set(removed)]);
    return (await this.views.receipts([after]))[0]!;
  }

  /** Finish counting: inventory keeps the units in Incoming until the Inventory Manager confirms; shortages update the PO. */
  async submitReceipt(id: string, body: { raiseClaims?: boolean | null }, by: Caller): Promise<Receipt> {
    const receipt = await this.repo.getReceipt(id);
    if (!receipt) throw notFound('Receiving record');
    receiptMachine.next(receipt.status, 'submit');
    const [po, delivery, lines, poLines] = await Promise.all([
      this.repo.getPurchaseOrder(receipt.purchaseOrderId),
      this.repo.getDelivery(receipt.deliveryId),
      this.repo.receiptLines([id]),
      this.repo.linesOf([receipt.purchaseOrderId]),
    ]);
    if (!po || !delivery) throw notFound('Purchase order');
    const supplier = await this.repo.getSupplier(po.supplierId);
    const [photosRequired, pctAllowed] = await Promise.all([this.ctx.settings.get('damagePhotosRequired'), this.ctx.settings.get('overReceiptAllowedPct')]);
    checkDamagePhotos(lines, photosRequired);
    const poLineById = new Map(poLines.map((l) => [l.id, l]));
    checkOverReceipt(lines.map((l) => ({ purchaseOrderLineId: l.purchaseOrderLineId, received: l.received, qtyOrdered: poLineById.get(l.purchaseOrderLineId)!.qtyOrdered, alreadyReceived: poLineById.get(l.purchaseOrderLineId)!.qtyReceived })), pctAllowed);

    const counted = new Map(lines.map((l) => [l.purchaseOrderLineId, l]));
    const afterLines = poLines.map((l) => ({ ...l, qtyReceived: l.qtyReceived + (counted.get(l.id)?.received ?? 0), qtyDamaged: l.qtyDamaged + (counted.get(l.id)?.damaged ?? 0) }));
    const anyReceived = lines.some((l) => l.received > 0);
    const poEvent = anyReceived ? receiveEvent(afterLines) : null;
    const newPoStatus = poEvent ? purchaseOrderMachine.next(po.status, poEvent) : po.status;
    const hasIssues = receiptHasIssues(lines);
    deliveryMachine.next(delivery.status, hasIssues ? 'completeWithIssues' : 'complete');
    const claimRefs = body.raiseClaims
      ? { shortage: lines.some((l) => shortageOf(l) > 0) ? await this.nextRef('claim') : null, damage: lines.some((l) => l.damaged > 0) ? await this.nextRef('claim') : null }
      : { shortage: null, damage: null };

    // inventory first (units wait in Incoming for confirmation); then the open quantities that still come
    const shares = freightShares(money(po.freightAmount, po.currency), poLines);
    const shareOf = new Map(poLines.map((l, i) => [l.id, shares[i]!]));
    const submittedAt = this.now();
    await this.inventory().submitInbound({
      receiptId: receipt.id,
      receiptRef: receipt.ref,
      purchaseOrderId: po.id,
      purchaseOrderRef: po.ref,
      supplierName: supplier?.name ?? 'Unknown supplier',
      locationId: receipt.locationId,
      receivedBy: by.actor,
      receivedAt: submittedAt.toISOString(),
      lines: lines.map((l) => {
        const pl = poLineById.get(l.purchaseOrderLineId)!;
        return {
          stockItemId: l.stockItemId,
          expected: l.expected,
          received: l.received,
          damaged: l.damaged,
          ...(l.binCode ? { binCode: l.binCode } : {}),
          unitCost: landedUnitCost(pl.unitCostAmount, pl.qtyOrdered, shareOf.get(pl.id)!),
        };
      }),
    });
    await this.inventory().expectIncoming(po.id, po.ref, po.shipToLocationId, this.incomingLines(afterLines, po.expectedDate, supplier));

    const totalOrdered = afterLines.reduce((n, l) => n + l.qtyOrdered, 0);
    const totalReceived = afterLines.reduce((n, l) => n + l.qtyReceived, 0);
    const shortUnits = lines.reduce((n, l) => n + shortageOf(l), 0);
    const damagedUnits = lines.reduce((n, l) => n + l.damaged, 0);
    const { after, claims } = await this.repo.transaction(async (tx) => {
      const cur = await tx.getReceipt(id, { forUpdate: true });
      if (!cur) throw notFound('Receiving record');
      const status = receiptMachine.next(cur.status, 'submit');
      const curPo = (await tx.getPurchaseOrder(po.id, { forUpdate: true }))!;
      if (curPo.status !== po.status) throw new AppError('CONFLICT', 'The purchase order changed meanwhile; reload and try again.');
      for (const l of afterLines) {
        const c = counted.get(l.id);
        if (c && (c.received || c.damaged)) await tx.updateLine(l.id, { qtyReceived: l.qtyReceived, qtyDamaged: l.qtyDamaged });
      }
      const curDelivery = (await tx.getDelivery(delivery.id, { forUpdate: true }))!;
      await tx.updateDelivery(delivery.id, { status: deliveryMachine.next(curDelivery.status, hasIssues ? 'completeWithIssues' : 'complete') });
      if (newPoStatus !== po.status) await tx.updatePurchaseOrder(po.id, { status: newPoStatus });
      const updated = await tx.updateReceipt(id, { status, submittedAt, receivedBy: by.actor });
      const label = newPoStatus === 'received' ? `Received in full · ${totalReceived} of ${totalOrdered}` : `Partly received · ${totalReceived} of ${totalOrdered}`;
      const detail = [receipt.ref, shortUnits ? `${shortUnits} short` : null, damagedUnits ? `${damagedUnits} damaged` : null].filter(Boolean).join(' · ');
      await tx.addEvent(this.event(po.id, anyReceived ? label : 'Delivery counted · nothing received', detail, by.actor));
      const claims: ClaimRow[] = [];
      const claimLine = (l: ReceiptLineRow, quantity: number): ClaimLine => {
        const pl = poLineById.get(l.purchaseOrderLineId)!;
        return { stockItemId: l.stockItemId, sku: pl.sku, quantity, unitCost: money(pl.unitCostAmount, po.currency) };
      };
      if (claimRefs.shortage) {
        claims.push(await this.insertClaim(tx, { ref: claimRefs.shortage, po: curPo, receiptId: id, kind: 'shortage', lines: lines.filter((l) => shortageOf(l) > 0).map((l) => claimLine(l, shortageOf(l))), owner: po.createdBy, notes: `Shortage on ${receipt.ref}` }));
      }
      if (claimRefs.damage) {
        claims.push(await this.insertClaim(tx, { ref: claimRefs.damage, po: curPo, receiptId: id, kind: 'damage', lines: lines.filter((l) => l.damaged > 0).map((l) => claimLine(l, l.damaged)), owner: po.createdBy, notes: `Damage on ${receipt.ref}` }));
      }
      return { after: updated, claims };
    });

    const view = (await this.views.receipts([after]))[0]!;
    this.ctx.events.publish(
      'purchasing.receipt.recorded',
      { receiptId: id, ref: after.ref, purchaseOrderId: po.id, locationId: after.locationId, lines: view.lines, hasIssues },
      { actor: by.actor, requestId: by.requestId },
    );
    if (newPoStatus !== po.status) this.statusChanged({ ...po, status: newPoStatus }, po.status, null, by);
    await this.audit(
      {
        action: 'purchasing.receipt.submit',
        actionLabel: 'Submitted receiving record',
        category: 'other',
        target: { type: 'receipt', id, ref: after.ref, label: `${po.ref} · ${supplier?.name ?? ''}`.trim(), screen: 'ops/receiving' },
        relatedTargets: [{ type: 'purchase_order', id: po.id, ref: po.ref }, ...claims.map((c) => ({ type: 'supplier_claim', id: c.id, ref: c.ref }))],
        after: { totals: view.totals, hasIssues, claims: claims.map((c) => c.ref) },
        afterText: `${view.totals.received} received · ${view.totals.damaged} damaged · ${view.totals.shortage} short`,
      },
      by,
    );
    return view;
  }

  async cancelReceipt(id: string, body: { reason: string }, by: Caller): Promise<Receipt> {
    const reason = required(body.reason, 'reason', 'Say why the receiving record is discarded');
    const receipt = await this.repo.getReceipt(id);
    if (!receipt) throw notFound('Receiving record');
    receiptMachine.next(receipt.status, 'cancel');
    const lines = await this.repo.receiptLines([id]);
    const after = await this.repo.transaction(async (tx) => {
      const cur = await tx.getReceipt(id, { forUpdate: true });
      if (!cur) throw notFound('Receiving record');
      const updated = await tx.updateReceipt(id, { status: receiptMachine.next(cur.status, 'cancel') });
      // the only receiving record of the delivery is gone: the delivery is back at the dock (Receiving → Arrived)
      const delivery = await tx.getDelivery(cur.deliveryId, { forUpdate: true });
      if (delivery?.status === 'receiving' && !(await tx.inProgressReceipt(cur.deliveryId))) await tx.updateDelivery(delivery.id, { status: deliveryMachine.next(delivery.status, 'reopen') });
      await tx.addEvent(this.event(cur.purchaseOrderId, `Receiving ${cur.ref} discarded`, reason, by.actor));
      return updated;
    });
    await this.detachPhotos(receipt, [...new Set(lines.flatMap((l) => l.photoIds))]);
    await this.audit(
      { action: 'purchasing.receipt.cancel', actionLabel: 'Discarded receiving record', category: 'other', target: { type: 'receipt', id, ref: receipt.ref, screen: 'ops/receiving' }, reason, before: { status: receipt.status }, after: { status: after.status } },
      by,
    );
    return (await this.views.receipts([after]))[0]!;
  }

  /* ================================================================ claims */

  async listClaims(query: { status?: SupplierClaim['status']; supplierId?: string }, page: PageRequest): Promise<Page<SupplierClaim>> {
    const p = await this.repo.listClaims(query, page);
    return { ...p, items: await this.views.claims(p.items) };
  }

  async createClaim(input: ClaimInput, by: Caller): Promise<SupplierClaim> {
    const po = await this.repo.getPurchaseOrder(input.purchaseOrderId);
    if (!po) throw invalid('purchaseOrderId', 'Choose an existing purchase order');
    if (po.status === 'draft' || po.status === 'cancelled') throw invalid('purchaseOrderId', 'Claims are opened on purchase orders that were sent to the supplier');
    if (input.receiptId) {
      const r = await this.repo.getReceipt(input.receiptId);
      if (!r || r.purchaseOrderId !== po.id) throw invalid('receiptId', 'The receiving record is not part of this purchase order');
    }
    const poLines = await this.repo.linesOf([po.id]);
    const issues: { path: string; message: string }[] = [];
    if (!input.lines?.length) issues.push({ path: 'lines', message: 'Add at least one line' });
    (input.lines ?? []).forEach((l, i) => {
      if (!poLines.some((p) => p.stockItemId === l.stockItemId)) issues.push({ path: `lines.${i}.stockItemId`, message: 'This item is not on the purchase order' });
      if (!Number.isInteger(l.quantity) || l.quantity < 1) issues.push({ path: `lines.${i}.quantity`, message: 'Claim at least 1 unit' });
      if (l.unitCost.currency !== po.currency) issues.push({ path: `lines.${i}.unitCost.currency`, message: `Use ${po.currency}` });
      if (l.unitCost.amount < 0) issues.push({ path: `lines.${i}.unitCost.amount`, message: 'Unit cost cannot be negative' });
    });
    if (issues.length) throw invalidMany('Some claim lines are invalid', issues);
    const ref = await this.nextRef('claim');
    const claim = await this.repo.transaction(async (tx) => {
      const cur = await tx.getPurchaseOrder(po.id, { forUpdate: true });
      if (!cur) throw notFound('Purchase order');
      return this.insertClaim(tx, {
        ref,
        po: cur,
        receiptId: input.receiptId ?? null,
        kind: input.kind,
        lines: input.lines.map((l) => ({ stockItemId: l.stockItemId, sku: l.sku || poLines.find((p) => p.stockItemId === l.stockItemId)!.sku, quantity: l.quantity, unitCost: l.unitCost })),
        owner: by.actor,
        notes: clean(input.notes),
      });
    });
    await this.audit({ action: 'purchasing.claim.create', actionLabel: 'Opened supplier claim', category: 'financial', target: claimTarget(claim), relatedTargets: [{ type: 'purchase_order', id: po.id, ref: po.ref }], after: claimSnapshot(claim) }, by);
    return (await this.views.claims([claim]))[0]!;
  }

  async submitClaim(id: string, body: { supplierReference?: string | null }, by: Caller): Promise<SupplierClaim> {
    const reference = clean(body.supplierReference);
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.getClaim(id, { forUpdate: true });
      if (!before) throw notFound('Supplier claim');
      const status = supplierClaimMachine.next(before.status, 'submit');
      const after = await tx.updateClaim(id, { status, ...(reference ? { supplierReference: reference } : {}) });
      await tx.addEvent(this.event(before.purchaseOrderId, `Supplier claim ${before.ref} sent to supplier`, reference ? `Supplier reference ${reference}` : null, by.actor));
      return { before, after };
    });
    await this.audit({ action: 'purchasing.claim.submit', actionLabel: 'Sent supplier claim', category: 'financial', target: claimTarget(after), before: { status: before.status }, after: { status: after.status, supplierReference: reference } }, by);
    return (await this.views.claims([after]))[0]!;
  }

  async settleClaim(id: string, body: { settlement: 'credit_note' | 'refund' | 'replacement'; amount: Money; reason: string }, by: Caller): Promise<SupplierClaim> {
    const reason = required(body.reason, 'reason', 'Describe the settlement');
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.getClaim(id, { forUpdate: true });
      if (!before) throw notFound('Supplier claim');
      const status = supplierClaimMachine.next(before.status, 'settle');
      if (body.amount.currency !== before.currency) throw invalid('amount.currency', `Use ${before.currency}`);
      if (body.amount.amount < 0) throw invalid('amount.amount', 'The settled amount cannot be negative');
      const after = await tx.updateClaim(id, { status, settlement: body.settlement, settledAmount: body.amount.amount, decidedAt: this.now(), notes: appendNote(before.notes, reason) });
      await tx.addEvent(this.event(before.purchaseOrderId, `Supplier claim ${before.ref} settled`, `${settlementLabel(body.settlement)} ${formatMoney(body.amount)} · ${reason}`, by.actor));
      return { before, after };
    });
    this.ctx.events.publish(
      'purchasing.claim.settled',
      { claimId: id, supplierId: after.supplierId, purchaseOrderId: after.purchaseOrderId, settlement: body.settlement, amount: body.amount },
      { actor: by.actor, requestId: by.requestId },
    );
    await this.audit(
      {
        action: 'purchasing.claim.settle',
        actionLabel: 'Recorded supplier claim settlement',
        category: 'financial',
        target: claimTarget(after),
        reason,
        before: { status: before.status, amount: money(before.amount, before.currency) },
        after: { status: after.status, settlement: body.settlement, settledAmount: body.amount },
        afterText: `${settlementLabel(body.settlement)} ${formatMoney(body.amount)}`,
      },
      by,
    );
    return (await this.views.claims([after]))[0]!;
  }

  async closeClaim(id: string, body: { outcome: 'rejected' | 'withdrawn'; reason: string }, by: Caller): Promise<SupplierClaim> {
    const reason = required(body.reason, 'reason', 'Say why the claim is closed');
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.getClaim(id, { forUpdate: true });
      if (!before) throw notFound('Supplier claim');
      const status = supplierClaimMachine.next(before.status, body.outcome === 'rejected' ? 'reject' : 'withdraw');
      const after = await tx.updateClaim(id, { status, decidedAt: this.now(), notes: appendNote(before.notes, reason) });
      await tx.addEvent(this.event(before.purchaseOrderId, `Supplier claim ${before.ref} ${body.outcome === 'rejected' ? 'rejected by the supplier' : 'withdrawn'}`, reason, by.actor));
      return { before, after };
    });
    await this.audit(
      { action: `purchasing.claim.${body.outcome === 'rejected' ? 'reject' : 'withdraw'}`, actionLabel: body.outcome === 'rejected' ? 'Closed supplier claim as rejected' : 'Withdrew supplier claim', category: 'financial', target: claimTarget(after), reason, before: { status: before.status }, after: { status: after.status } },
      by,
    );
    return (await this.views.claims([after]))[0]!;
  }

  /* ================================================================ events consumed */

  /**
   * inventory.receipt.confirmed: Mark the receipt confirmed (who made the stock sellable) and add it to the PO timeline.
   * Receipts of Fulfilled by Marketly inbound shipments (source.kind service_inbound) are fulfillment-service's, never ours.
   */
  async onReceiptConfirmedFromInventory(event: EventPayload<'inventory.receipt.confirmed'>, meta?: { at?: string }): Promise<void> {
    if (event.source?.kind === 'service_inbound') return;
    const receipt = await this.repo.getReceipt(event.receiptId);
    if (!receipt) {
      this.ctx.log.info({ receiptId: event.receiptId }, 'purchasing: confirmed receipt is not ours; ignored');
      return;
    }
    if (receipt.status === 'confirmed') return; // delivered twice
    if (!receiptMachine.can(receipt.status, 'confirm')) {
      this.ctx.log.warn({ receiptId: receipt.id, status: receipt.status }, 'purchasing: inventory confirmed a receipt that is not waiting for confirmation; ignored');
      return;
    }
    const sellable = (event.lines ?? []).reduce((n, l) => n + (l.sellable ?? 0), 0);
    const at = meta?.at ? new Date(meta.at) : this.now();
    await this.repo.transaction(async (tx) => {
      const cur = await tx.getReceipt(receipt.id, { forUpdate: true });
      if (!cur || !receiptMachine.can(cur.status, 'confirm')) return;
      await tx.updateReceipt(cur.id, { status: receiptMachine.next(cur.status, 'confirm'), confirmedBy: event.confirmedBy, confirmedAt: at });
      await tx.addEvent({ ...this.event(cur.purchaseOrderId, `Stock made available · ${cur.ref}`, `${units(sellable)} sellable`, event.confirmedBy), at });
    });
  }

  /** inventory.stock.low: Refresh reorder suggestions for company stock items */
  async onStockLowFromInventory(event: EventPayload<'inventory.stock.low'>): Promise<void> {
    if (event.ownerType !== 'official') return; // sellers buy their own stock
    const info: StockInfo = { stockItemId: event.stockItemId, sku: event.sku, label: event.label, ownerType: 'official' };
    this.#lowStock.set(event.stockItemId, info);
  }

  /** access.approval.decided: Send an approved PO; record a rejection on the PO timeline */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    if (event.actionKey !== SEND_ACTION) return;
    const po = await this.repo.purchaseOrderByApproval(event.requestId);
    if (!po) {
      this.ctx.log.info({ requestId: event.requestId }, 'purchasing: approval for an unknown purchase order; ignored');
      return;
    }
    const decider = event.decidedBy ?? SYSTEM;
    if (event.outcome !== 'approved') {
      const state = event.outcome === 'rejected' ? ('rejected' as const) : null;
      await this.repo.transaction(async (tx) => {
        const cur = await tx.getPurchaseOrder(po.id, { forUpdate: true });
        if (!cur || cur.approvalRequestId !== event.requestId || cur.approvalState !== 'pending') return; // already recorded
        await tx.updatePurchaseOrder(po.id, { approvalState: state });
        const label = event.outcome === 'rejected' ? 'Approval rejected' : event.outcome === 'expired' ? 'Approval request expired' : 'Approval request cancelled';
        await tx.addEvent(this.event(po.id, label, event.reason ?? null, decider));
      });
      return;
    }
    if (po.status !== 'draft' || po.approvalState !== 'pending') return; // sent already, or a decision for an older request
    const requester = await this.staffActor(event.requestedById);
    let details: { emailSupplier?: boolean; message?: string | null } = {};
    const access = this.ctx.tryUse('access');
    try {
      details = ((await access?.getApproval(event.requestId))?.details ?? {}) as typeof details;
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'access.getApproval failed; sending without the supplier email choice');
    }
    try {
      await this.dispatch(po.id, {
        actor: requester,
        emailSupplier: !!details.emailSupplier,
        message: details.message ?? null,
        approval: 'approved',
        approvalNote: `Approved by ${decider.name ?? 'the approver'}`,
        approvalRequestId: event.requestId,
      });
    } catch (err) {
      if (!isAppError(err)) throw err;
      // approved but cannot go out (e.g. supplier deactivated meanwhile): keep the draft and say why
      await this.repo.transaction(async (tx) => {
        await tx.updatePurchaseOrder(po.id, { approvalState: 'approved' });
        await tx.addEvent(this.event(po.id, 'Approved, but not sent', err.message, decider));
      });
    }
  }

  /* ================================================================ jobs */

  /** Job purchasing.flag-late-deliveries (every 30 min): Deliveries past windowTo + grace without arrival → delayed; publish purchasing.delivery.late (work queue for the Purchasing Manager) */
  async flagLateDeliveries(): Promise<number> {
    const grace = await this.ctx.settings.get('deliveryLateGraceMinutes');
    const cutoff = new Date(this.now().getTime() - grace * 60_000);
    const seen = new Set<string>();
    let flagged = 0;
    for (;;) {
      const batch = (await this.repo.deliveriesBy({ statuses: ['expected'], windowToBefore: cutoff, limit: LATE_BATCH })).filter((d) => !seen.has(d.id));
      if (!batch.length) break;
      for (const d of batch) {
        seen.add(d.id);
        const done = await this.repo.transaction(async (tx) => {
          const cur = await tx.getDelivery(d.id, { forUpdate: true });
          if (!cur || cur.status !== 'expected' || cur.windowTo >= cutoff) return null;
          await tx.updateDelivery(d.id, { status: deliveryMachine.next(cur.status, 'delay'), delayReason: 'Arrival window passed without check-in' });
          await tx.addEvent(this.event(cur.purchaseOrderId, 'Delivery late', 'Arrival window passed without check-in', SYSTEM));
          return tx.getPurchaseOrder(cur.purchaseOrderId);
        });
        if (!done) continue;
        const supplier = await this.repo.getSupplier(done.supplierId);
        this.ctx.events.publish('purchasing.delivery.late', { deliveryId: d.id, purchaseOrderId: done.id, ref: done.ref, supplierName: supplier?.name ?? 'Unknown supplier' }, { actor: SYSTEM });
        flagged++;
      }
      if (batch.length < LATE_BATCH) break;
    }
    return flagged;
  }

  /** Job purchasing.supplier-performance (nightly 02:30 market time): Recompute on-time %, average lead time, shortage and damage rates per supplier over the window */
  async supplierPerformance(): Promise<number> {
    const windowDays = await this.ctx.settings.get('performanceWindowDays');
    const now = this.now();
    const inputs = new Map((await this.repo.performanceInputs(new Date(now.getTime() - windowDays * 86_400_000))).map((i) => [i.supplierId, i]));
    const ids = await this.repo.supplierIds();
    for (const id of ids) {
      const i = inputs.get(id);
      await this.repo.savePerformance({
        supplierId: id,
        windowDays,
        onTimePct: i ? pct(i.onTime, i.deliveries) : null,
        avgLeadTimeDays: i && i.leadTimeCount ? days(i.leadTimeMsTotal / i.leadTimeCount) : null,
        shortageRatePct: i ? pct(i.shortage, i.expected) : null,
        damageRatePct: i ? pct(i.damaged, i.received) : null,
        deliveries: i?.deliveries ?? 0,
        computedAt: now,
      });
    }
    return ids.length;
  }

  /** Job purchasing.reorder-suggestions (hourly): Rebuild suggestions from inventory low stock, incoming quantities and 30-day sales velocity */
  async reorderSuggestions(): Promise<number> {
    const list = await this.suggestions({});
    // items back above their reorder point leave the low-stock candidates
    if (this.#lowStock.size) {
      const availability = await this.inventory().getAvailability([...this.#lowStock.keys()]);
      for (const id of [...this.#lowStock.keys()]) {
        const a = availability?.[id];
        if (!a || (a.lowStockThreshold !== null && a.available > a.lowStockThreshold)) this.#lowStock.delete(id);
      }
    }
    this.#lastSuggestions = { at: this.now(), count: list.length };
    this.ctx.log.info({ suggestions: list.length }, 'purchasing: reorder suggestions rebuilt');
    return list.length;
  }

  get lastSuggestions() {
    return this.#lastSuggestions;
  }

  /* ================================================================ internals */

  private async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: { actor: common.Actor; requestId?: string }) {
    await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
  }

  private event(purchaseOrderId: string, label: string, detail: string | null, actor: common.Actor): PoEventRow {
    return { id: newId(), purchaseOrderId, label, detail, actorKind: actor.kind, actorId: actor.id ?? null, at: this.now() };
  }

  private statusChanged(po: PoRow, from: string, reason: string | null, by: { actor: common.Actor; requestId?: string }) {
    this.ctx.events.publish('purchasing.purchase_order.status_changed', { purchaseOrderId: po.id, ref: po.ref, from, to: po.status, reason }, { actor: by.actor, requestId: by.requestId });
  }

  private async nextRef(kind: 'po' | 'receipt' | 'claim'): Promise<string> {
    const f =
      kind === 'po'
        ? parseRefFormat(await this.ctx.settings.get('purchaseOrderRefFormat'), PO_REF)
        : kind === 'receipt'
          ? parseRefFormat(await this.ctx.settings.get('receiptRefFormat'), RECEIPT_REF)
          : CLAIM_REF;
    return this.ctx.refs.next(refStem(f, this.today()), { daily: false, digits: f.digits });
  }

  private amountOf(m: Money, path: string): number {
    if (m.currency !== this.currency) throw invalid(`${path}.currency`, `Use ${this.currency}`);
    if (m.amount < 0) throw invalid(`${path}.amount`, 'The amount cannot be negative');
    return m.amount;
  }

  /** Validated lines with SKU and label from inventory (company stock only). */
  private async prepareLines(lines: PurchaseOrderLineInput[] | undefined): Promise<NewLine[]> {
    if (!lines?.length) throw invalid('lines', 'Add at least one line');
    const issues: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      if (!Number.isInteger(l.quantity) || l.quantity < 1) issues.push({ path: `lines.${i}.quantity`, message: 'Order at least 1 unit' });
      if (l.unitCost.currency !== this.currency) issues.push({ path: `lines.${i}.unitCost.currency`, message: `Buying costs are in ${this.currency}` });
      if (l.unitCost.amount < 0) issues.push({ path: `lines.${i}.unitCost.amount`, message: 'Unit cost cannot be negative' });
      if (seen.has(l.stockItemId)) issues.push({ path: `lines.${i}.stockItemId`, message: 'This item is already on the order' });
      seen.add(l.stockItemId);
    });
    if (issues.length) throw invalidMany('Some lines are invalid', issues);
    const info = await this.requireCompanyStock(lines.map((l) => l.stockItemId));
    return lines.map((l) => ({
      stockItemId: l.stockItemId,
      sku: info.get(l.stockItemId)!.sku,
      label: info.get(l.stockItemId)!.label,
      quantity: l.quantity,
      unitCostAmount: l.unitCost.amount,
      expectedDate: l.expectedDate ?? null,
    }));
  }

  private async requireCompanyStock(ids: readonly string[]): Promise<Map<string, StockInfo>> {
    const unique = [...new Set(ids)];
    const info = await this.directory.describe(unique);
    const bad = unique.filter((id) => {
      const i = info.get(id);
      return !i || i.ownerType === 'seller';
    });
    if (bad.length) throw new AppError('STOCK_ITEM_NOT_COMPANY', 'Only Official Store stock items can be bought from suppliers.', { stockItemIds: bad });
    return info;
  }

  private lineRow(purchaseOrderId: string, l: NewLine): PoLineRow {
    return { id: newId(), purchaseOrderId, stockItemId: l.stockItemId, sku: l.sku, label: l.label, qtyOrdered: l.quantity, qtyReceived: 0, qtyDamaged: 0, qtyClosed: 0, unitCostAmount: l.unitCostAmount, expectedDate: l.expectedDate };
  }

  private async createDraft(
    input: { supplier: SupplierRow; shipToLocationId: string; lines: NewLine[]; freightAmount: number; paymentTerms: string; expectedDate: string | null; notes: string | null; attachmentIds: string[] },
    by: Caller,
    origin?: string,
  ): Promise<PoRow> {
    const ref = await this.nextRef('po');
    const subtotal = input.lines.reduce((n, l) => n + l.unitCostAmount * l.quantity, 0);
    const id = newId();
    const po = await this.repo.transaction(async (tx) => {
      const row = await tx.insertPurchaseOrder({
        id,
        ref,
        supplierId: input.supplier.id,
        shipToLocationId: input.shipToLocationId,
        status: purchaseOrderMachine.initial,
        paymentTerms: input.paymentTerms,
        expectedDate: input.expectedDate,
        freightAmount: input.freightAmount,
        currency: this.currency,
        totalAmount: subtotal + input.freightAmount,
        approvalRequestId: null,
        approvalState: null,
        notes: input.notes,
        attachmentIds: input.attachmentIds,
        createdBy: by.actor,
        createdAt: this.now(),
        sentAt: null,
        closedAt: null,
        closeReason: null,
      });
      await tx.insertLines(input.lines.map((l) => this.lineRow(id, l)));
      await tx.addEvent(this.event(id, 'Draft created', origin ?? null, by.actor));
      return row;
    });
    const total = money(po.totalAmount, po.currency);
    await this.audit(
      {
        action: 'purchasing.purchase_order.create',
        actionLabel: 'Created draft purchase order',
        category: 'financial',
        target: poTarget(po, input.supplier.name),
        after: poSnapshot(po),
        afterText: `${input.supplier.name} · ${input.lines.length} line${input.lines.length === 1 ? '' : 's'} · ${formatMoney(total)}`,
        reason: origin ?? null,
      },
      by,
    );
    return po;
  }

  /** Lines for inventory.expectIncoming: open quantities (lines with nothing open are left out). */
  private incomingLines(lines: readonly PoLineRow[], poExpected: string | null, supplier: SupplierRow | null | undefined) {
    const fallback = addDays(this.today(), supplier?.leadTimeDays ?? 0);
    return lines.filter((l) => openQty(l) > 0).map((l) => ({ stockItemId: l.stockItemId, quantity: openQty(l), expectedDate: l.expectedDate ?? poExpected ?? fallback }));
  }

  private async reExpect(po: PoRow) {
    const [lines, supplier] = await Promise.all([this.repo.linesOf([po.id]), this.repo.getSupplier(po.supplierId)]);
    await this.inventory().expectIncoming(po.id, po.ref, po.shipToLocationId, this.incomingLines(lines, po.expectedDate, supplier));
  }

  /** Sends a draft: Incoming in inventory, status Sent, events, supplier email, audit. */
  private async dispatch(
    id: string,
    o: { actor: common.Actor; requestId?: string; emailSupplier: boolean; message: string | null; approval: 'approved' | 'clear'; approvalNote: string | null; approvalRequestId?: string },
  ): Promise<PoRow> {
    const po = await this.repo.getPurchaseOrder(id);
    if (!po) throw notFound('Purchase order');
    purchaseOrderMachine.next(po.status, 'send');
    const [lines, supplier] = await Promise.all([this.repo.linesOf([id]), this.repo.getSupplier(po.supplierId)]);
    if (!supplier) throw notFound('Supplier');
    if (!supplier.active) throw new AppError('SUPPLIER_INACTIVE', `${supplier.name} is deactivated.`, { supplierId: supplier.id });
    const shipTo = await this.shipToOf(po.shipToLocationId);
    await this.inventory().expectIncoming(po.id, po.ref, po.shipToLocationId, this.incomingLines(lines, po.expectedDate, supplier));
    let after: PoRow;
    try {
      after = await this.repo.transaction(async (tx) => {
        const cur = await tx.getPurchaseOrder(id, { forUpdate: true });
        if (!cur) throw notFound('Purchase order');
        const status = purchaseOrderMachine.next(cur.status, 'send');
        const approval = o.approval === 'approved' ? { approvalState: 'approved' as const } : { approvalRequestId: null, approvalState: null };
        const updated = await tx.updatePurchaseOrder(id, { status, sentAt: this.now(), ...approval });
        await tx.addEvent(this.event(id, 'Sent to supplier', o.approvalNote, o.actor));
        return updated;
      });
    } catch (err) {
      await this.inventory()
        .cancelIncoming(id)
        .catch((e) => this.ctx.log.error({ err: e, purchaseOrderId: id }, 'purchasing: could not remove Incoming after a failed send'));
      throw err;
    }
    const total = money(after.totalAmount, after.currency);
    this.ctx.events.publish(
      'purchasing.purchase_order.sent',
      {
        purchaseOrderId: id,
        ref: after.ref,
        supplierId: supplier.id,
        supplierName: supplier.name,
        supplierEmail: supplier.email ?? null,
        // notifications emails the purchase order to the supplier when the buyer asked for it
        emailSupplier: o.emailSupplier,
        message: o.message,
        locationId: after.shipToLocationId,
        shipTo,
        total,
        lines: lines.map((l) => this.views.poLine(l, after.currency, after.expectedDate)),
      },
      { actor: o.actor, requestId: o.requestId },
    );
    this.statusChanged(after, po.status, null, o);
    if (o.emailSupplier) await this.noteSupplierEmail(after, supplier, o.actor);
    await this.audit(
      {
        action: 'purchasing.purchase_order.send',
        actionLabel: 'Sent purchase order to supplier',
        category: 'financial',
        target: poTarget(after, supplier.name),
        before: { status: po.status },
        after: { status: after.status, total },
        afterText: `${formatMoney(total)} to ${supplier.name}`,
        approvalRequestId: o.approvalRequestId ?? null,
        approvalNote: o.approvalNote,
      },
      o,
    );
    return after;
  }

  /**
   * The supplier email goes out through notifications, which consumes purchasing.purchase_order.sent
   * (emailSupplier, supplierEmail, message). The timeline says where it was sent, or why it was not.
   */
  private async noteSupplierEmail(po: PoRow, supplier: SupplierRow, actor: common.Actor) {
    const notifying = (this.ctx.modules as readonly string[]).includes('notifications');
    const sent = notifying && Boolean(supplier.email);
    const detail = sent ? null : notifying ? 'The supplier has no email address' : 'Notifications are off';
    await this.repo.addEvent(this.event(po.id, sent ? `Emailed to ${supplier.email}` : 'Supplier email not sent', detail, actor));
  }

  private async cancelApprovalQuietly(requestId: string, actor: common.Actor, reason: string) {
    try {
      await this.ctx.tryUse('access')?.cancelApproval(requestId, actor, reason);
    } catch (err) {
      this.ctx.log.warn({ err, requestId }, 'purchasing: could not withdraw the approval request');
    }
  }

  private async assertNothingReceived(repo: PurchasingRepository, purchaseOrderId: string) {
    const [lines, receipts] = await Promise.all([repo.linesOf([purchaseOrderId]), repo.receiptsBy({ purchaseOrderIds: [purchaseOrderId] })]);
    const live = receipts.filter((r) => r.status !== 'cancelled');
    if (lines.some((l) => l.qtyReceived > 0) || live.length) {
      throw new AppError('PO_HAS_RECEIPTS', 'Units were already received or are being counted; close the purchase order short instead of cancelling.', { receiptIds: live.map((r) => r.id) });
    }
  }

  private async insertClaim(
    tx: PurchasingRepository,
    c: { ref: string; po: PoRow; receiptId: string | null; kind: ClaimKind; lines: ClaimLine[]; owner: common.Actor; notes: string | null },
  ): Promise<ClaimRow> {
    const amount = c.lines.reduce((n, l) => n + l.unitCost.amount * l.quantity, 0);
    const claim = await tx.insertClaim({
      id: newId(),
      ref: c.ref,
      supplierId: c.po.supplierId,
      purchaseOrderId: c.po.id,
      receiptId: c.receiptId,
      kind: c.kind,
      lines: c.lines,
      amount,
      currency: c.po.currency,
      status: supplierClaimMachine.initial,
      settlement: null,
      settledAmount: null,
      supplierReference: null,
      owner: c.owner,
      notes: c.notes,
      createdAt: this.now(),
      decidedAt: null,
    });
    await tx.addEvent(this.event(c.po.id, `Supplier claim ${c.ref} opened`, `${c.kind.replace('_', ' ')} · ${formatMoney(money(amount, c.po.currency))}`, c.owner));
    return claim;
  }

  /**
   * The company warehouse a draft ships to: the given location (known, active, a company warehouse) or
   * inventory's default location. VALIDATION_FAILED otherwise.
   */
  private async shipToLocation(locationId: string | null): Promise<Location> {
    const inventory = this.inventory();
    if (!locationId) {
      const def = await inventory.getDefaultLocation();
      if (!def || !isCompanyWarehouse(def)) throw invalid('shipToLocationId', 'There is no default company warehouse yet; choose where the supplier delivers');
      return def;
    }
    const loc = (await inventory.getLocations({ ownerType: 'official', activeOnly: false })).find((l) => l.id === locationId);
    if (!loc) throw invalid('shipToLocationId', 'Unknown stock location');
    if (!loc.active) throw invalid('shipToLocationId', `${loc.name} is not active`);
    if (!isCompanyWarehouse(loc)) throw invalid('shipToLocationId', `${loc.name} is not a company warehouse`);
    return loc;
  }

  /** Where the supplier delivers, for purchasing.purchase_order.sent (names, address and time zone come from inventory) */
  private async shipToOf(locationId: string): Promise<PurchaseOrderShipTo> {
    const loc = (await this.inventory().getLocations({ ownerType: 'official', activeOnly: false })).find((l) => l.id === locationId);
    if (!loc) {
      this.ctx.log.warn({ locationId }, 'purchasing: the ship-to location is unknown to inventory');
      return { locationId, code: '', name: 'Company warehouse', address: null, timeZone: this.ctx.config.market.timeZone };
    }
    return { locationId: loc.id, code: loc.code, name: loc.name, address: loc.address ?? null, timeZone: loc.timeZone };
  }

  /**
   * Purchase order attachments are supplier documents: attached in media (usage supplier_document, refId
   * the PO) when added and detached when removed, so the media orphan sweep never deletes them.
   */
  private async syncAttachments(po: PoRow, before: readonly string[], after: readonly string[]) {
    const media = this.ctx.tryUse('media');
    if (!media) return;
    const added = after.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !after.includes(id));
    for (const id of added) {
      const asset = await media.getAsset(id);
      if (!asset) continue;
      await media.attach(id, { module: 'purchasing', kind: 'supplier_document', refId: po.id, refLabel: po.ref }, asset.owner);
    }
    for (const id of removed) await media.detach(id, { module: 'purchasing', kind: 'supplier_document', refId: po.id });
  }

  /** PO attachments are supplier documents in media: they must exist, be usable and belong to staff or the platform. */
  private async checkAttachments(ids: readonly string[]) {
    if (!ids.length) return;
    const media = this.ctx.tryUse('media');
    if (!media) return; // cannot verify while media is off; the ids are kept
    const assets = await Promise.all(ids.map((id) => media.getAsset(id)));
    const bad = ids.filter((_, i) => {
      const a = assets[i];
      return !a || UNUSABLE_ASSET.includes(a.status) || (a.owner.kind !== 'staff' && a.owner.kind !== 'platform');
    });
    if (bad.length) throw invalidMany('Some files cannot be attached', bad.map((id) => ({ path: 'attachmentIds', message: `File ${id} is missing or not available` })));
  }

  /** Damage photos become inspection evidence of the receipt (media usage inspection_photo). */
  private async attachPhotos(receipt: ReceiptRow, ids: readonly string[]) {
    if (!ids.length) return;
    const media = this.ctx.tryUse('media');
    if (!media) return;
    for (const id of ids) {
      const asset = await media.getAsset(id);
      if (!asset || UNUSABLE_ASSET.includes(asset.status) || (asset.owner.kind !== 'staff' && asset.owner.kind !== 'platform')) {
        throw invalid('lines.photoIds', `Photo ${id} is missing or not available`);
      }
      await media.attach(id, { module: 'purchasing', kind: 'inspection_photo', refId: receipt.id, refLabel: receipt.ref }, asset.owner);
    }
  }

  private async detachPhotos(receipt: ReceiptRow, ids: readonly string[]) {
    const media = this.ctx.tryUse('media');
    if (!media || !ids.length) return;
    for (const id of ids) {
      try {
        await media.detach(id, { module: 'purchasing', kind: 'inspection_photo', refId: receipt.id });
      } catch (err) {
        this.ctx.log.warn({ err, assetId: id }, 'purchasing: could not release a receipt photo');
      }
    }
  }

  /** Put-away bins suggested by warehouse; warehouse being off or unbuilt leaves them empty. */
  private async suggestBins(stockItemIds: readonly string[], locationId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const warehouse = this.ctx.tryUse('warehouse');
    if (!warehouse) return out;
    for (const id of new Set(stockItemIds)) {
      try {
        const bin = await warehouse.suggestBin(id, locationId);
        if (bin?.code) out.set(id, bin.code);
      } catch (err) {
        if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'warehouse.suggestBin failed; no bin suggested');
        if (isNotImplemented(err)) break;
      }
    }
    return out;
  }

  private async staffActor(accountId: string): Promise<common.Actor> {
    const access = this.ctx.tryUse('access');
    try {
      const ref = await access?.getStaffRef(accountId);
      return { kind: 'staff', id: accountId, name: ref?.name ?? null };
    } catch {
      return { kind: 'staff', id: accountId, name: null };
    }
  }
}

/* ------------------------------------------------------------------ helpers */

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

/** A delayed delivery marked delayed again stays delayed (no transition). */
const deliveryStillOpen = <S extends string>(s: S): S => s;

const dockText = (dock: string) => (/^dock\b/i.test(dock) ? dock : `dock ${dock}`);
const appendNote = (notes: string | null, line: string) => (notes ? `${notes}\n${line}` : line);
const settlementLabel = (s: string) => ({ credit_note: 'Credit note', refund: 'Refund', replacement: 'Replacement' })[s] ?? s;

function rescheduleText(expected: string | null, before: string | null, lineCount: number, lineDates: Record<string, string | null | undefined>): string {
  const parts: string[] = [];
  if (expected !== before) parts.push(expected ? `Expected ${shortDate(expected)}` : 'Expected date cleared');
  if (lineCount) {
    const dates = [...new Set(Object.values(lineDates).filter((d): d is string => !!d))];
    parts.push(`${lineCount} line${lineCount === 1 ? '' : 's'} moved${dates.length === 1 ? ` to ${shortDate(dates[0]!)}` : ''}`);
  }
  return parts.join(' · ');
}

const supplierTarget = (s: SupplierRow) => ({ type: 'supplier', id: s.id, label: s.name, screen: 'admin/purchasing' });
const supplierSnapshot = (s: SupplierRow) => ({ name: s.name, contactName: s.contactName, email: s.email, phone: s.phone, paymentTerms: s.paymentTerms, leadTimeDays: s.leadTimeDays, active: s.active });
const itemSnapshot = (i: SupplierItemRow) => ({ stockItemId: i.stockItemId, supplierSku: i.supplierSku, unitCost: { amount: i.unitCostAmount, currency: i.currency }, minOrderQuantity: i.minOrderQty, leadTimeDays: i.leadTimeDays, preferred: i.preferred });
const poSnapshot = (p: PoRow) => ({ status: p.status, total: { amount: p.totalAmount, currency: p.currency }, freight: { amount: p.freightAmount, currency: p.currency }, paymentTerms: p.paymentTerms, expectedDate: p.expectedDate, notes: p.notes });
const claimTarget = (c: ClaimRow) => ({ type: 'supplier_claim', id: c.id, ref: c.ref, screen: 'admin/purchasing' });
const claimSnapshot = (c: ClaimRow) => ({ kind: c.kind, status: c.status, amount: { amount: c.amount, currency: c.currency }, lines: c.lines });
