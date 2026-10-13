/**
 * Shared plumbing of the purchasing use cases: the dependencies, time and currency, audit entries, the purchase order
 * timeline, references, company stock checks, drafts (created by hand or from reorder suggestions), supplier claims
 * (opened by hand, on close short or on a receipt) and the Incoming lines inventory is told about. The use cases live
 * in the part classes (suppliers, purchase orders, reorder suggestions, deliveries, receipts, claims, summary).
 *
 * Calls to other modules (inventory, access, media, settings, references) happen outside database transactions.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { format as formatMoney, money } from '../../../kernel/lib/money.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { ClaimLine } from '../../../spec/purchasing.js';
import { addDays, invalid, openQty, parseRefFormat, refStem, type ClaimKind, type RefFormat } from '../domain/rules.js';
import { purchaseOrderMachine, supplierClaimMachine } from '../domain/state-machines.js';
import { createInventoryStockDirectory } from '../providers/stock-directory.js';
import type { ClaimRow, PoEventRow, PoLineRow, PoRow, StockDirectory, StockInfo, SupplierRow } from '../ports.js';
import type { PurchasingRepository } from '../repository.js';
import { PurchasingViews } from '../views.js';

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

/** A purchase order line before it is stored */
export interface NewLine {
  stockItemId: string;
  sku: string;
  label: string;
  quantity: number;
  unitCostAmount: number;
  expectedDate: string | null;
}

const PO_REF: RefFormat = { prefix: 'PUR', period: 'YYMM', digits: 4 };
const RECEIPT_REF: RefFormat = { prefix: 'REC', period: 'YYMMDD', digits: 2 };
const CLAIM_REF: RefFormat = { prefix: 'CLM', period: 'YYMMDD', digits: 3 };

/** Media statuses that make a file unusable as a supplier document or damage photo */
export const UNUSABLE_ASSET = ['removed', 'deleted', 'expired', 'rejected'];

export const clean = (s: string | null | undefined): string | null => {
  const t = typeof s === 'string' ? s.trim() : '';
  return t ? t : null;
};
export const required = (s: string | null | undefined, path: string, message: string): string => {
  const t = clean(s);
  if (!t) throw invalid(path, message);
  return t;
};
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const illegal = (from: string, event: string, message: string) => new AppError('ILLEGAL_TRANSITION', message, { from, event });
export const units = (n: number) => `${n} unit${n === 1 ? '' : 's'}`;
export const poTarget = (po: PoRow, supplierName?: string) => ({ type: 'purchase_order', id: po.id, ref: po.ref, label: supplierName ?? po.ref, screen: 'admin/purchasing' });
export const poSnapshot = (p: PoRow) => ({ status: p.status, total: { amount: p.totalAmount, currency: p.currency }, freight: { amount: p.freightAmount, currency: p.currency }, paymentTerms: p.paymentTerms, expectedDate: p.expectedDate, notes: p.notes });
export const dockText = (dock: string) => (/^dock\b/i.test(dock) ? dock : `dock ${dock}`);

export function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

export class Core {
  readonly repo: PurchasingRepository;
  readonly ctx: ModuleContext<'purchasing'>;
  readonly directory: StockDirectory;
  readonly views: PurchasingViews;

  constructor(deps: PurchasingServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
    this.directory = deps.directory ?? createInventoryStockDirectory({ inventory: () => deps.ctx.use('inventory') });
    this.views = new PurchasingViews({ repo: deps.repo, ctx: deps.ctx, directory: this.directory });
  }

  now() {
    return this.ctx.clock.now();
  }
  today() {
    return dateInZone(this.now(), this.ctx.config.market.timeZone);
  }
  get currency() {
    return this.ctx.config.market.currency;
  }
  inventory() {
    return this.ctx.use('inventory');
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: { actor: common.Actor; requestId?: string }) {
    await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
  }

  /** A purchase order timeline entry, dated now */
  event(purchaseOrderId: string, label: string, detail: string | null, actor: common.Actor): PoEventRow {
    return { id: newId(), purchaseOrderId, label, detail, actorKind: actor.kind, actorId: actor.id ?? null, at: this.now() };
  }

  statusChanged(po: PoRow, from: string, reason: string | null, by: { actor: common.Actor; requestId?: string }) {
    this.ctx.events.publish('purchasing.purchase_order.status_changed', { purchaseOrderId: po.id, ref: po.ref, from, to: po.status, reason }, { actor: by.actor, requestId: by.requestId });
  }

  async nextRef(kind: 'po' | 'receipt' | 'claim'): Promise<string> {
    const f =
      kind === 'po'
        ? parseRefFormat(await this.ctx.settings.get('purchaseOrderRefFormat'), PO_REF)
        : kind === 'receipt'
          ? parseRefFormat(await this.ctx.settings.get('receiptRefFormat'), RECEIPT_REF)
          : CLAIM_REF;
    return this.ctx.refs.next(refStem(f, this.today()), { daily: false, digits: f.digits });
  }

  async requireCompanyStock(ids: readonly string[]): Promise<Map<string, StockInfo>> {
    const unique = [...new Set(ids)];
    const info = await this.directory.describe(unique);
    const bad = unique.filter((id) => {
      const i = info.get(id);
      return !i || i.ownerType === 'seller';
    });
    if (bad.length) throw new AppError('STOCK_ITEM_NOT_COMPANY', 'Only Official Store stock items can be bought from suppliers.', { stockItemIds: bad });
    return info;
  }

  lineRow(purchaseOrderId: string, l: NewLine): PoLineRow {
    return { id: newId(), purchaseOrderId, stockItemId: l.stockItemId, sku: l.sku, label: l.label, qtyOrdered: l.quantity, qtyReceived: 0, qtyDamaged: 0, qtyClosed: 0, unitCostAmount: l.unitCostAmount, expectedDate: l.expectedDate };
  }

  async createDraft(
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
  incomingLines(lines: readonly PoLineRow[], poExpected: string | null, supplier: SupplierRow | null | undefined) {
    const fallback = addDays(this.today(), supplier?.leadTimeDays ?? 0);
    return lines.filter((l) => openQty(l) > 0).map((l) => ({ stockItemId: l.stockItemId, quantity: openQty(l), expectedDate: l.expectedDate ?? poExpected ?? fallback }));
  }

  async insertClaim(
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
}
