/**
 * Supplier claims for shortages and damage: opened, sent to the supplier, settled, rejected or withdrawn.
 */
import { format as formatMoney, money, type Money } from '../../../kernel/lib/money.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type { ClaimInput, SupplierClaim } from '../../../spec/purchasing.js';
import { invalid, invalidMany } from '../domain/rules.js';
import { supplierClaimMachine } from '../domain/state-machines.js';
import type { ClaimRow } from '../ports.js';
import { clean, notFound, required, type Caller, type Core } from './core.js';

export class Claims {
  constructor(private readonly core: Core) {}

  async listClaims(query: { status?: SupplierClaim['status']; supplierId?: string }, page: PageRequest): Promise<Page<SupplierClaim>> {
    const p = await this.core.repo.listClaims(query, page);
    return { ...p, items: await this.core.views.claims(p.items) };
  }

  async createClaim(input: ClaimInput, by: Caller): Promise<SupplierClaim> {
    const po = await this.core.repo.getPurchaseOrder(input.purchaseOrderId);
    if (!po) throw invalid('purchaseOrderId', 'Choose an existing purchase order');
    if (po.status === 'draft' || po.status === 'cancelled') throw invalid('purchaseOrderId', 'Claims are opened on purchase orders that were sent to the supplier');
    if (input.receiptId) {
      const r = await this.core.repo.getReceipt(input.receiptId);
      if (!r || r.purchaseOrderId !== po.id) throw invalid('receiptId', 'The receiving record is not part of this purchase order');
    }
    const poLines = await this.core.repo.linesOf([po.id]);
    const issues: { path: string; message: string }[] = [];
    if (!input.lines?.length) issues.push({ path: 'lines', message: 'Add at least one line' });
    (input.lines ?? []).forEach((l, i) => {
      if (!poLines.some((p) => p.stockItemId === l.stockItemId)) issues.push({ path: `lines.${i}.stockItemId`, message: 'This item is not on the purchase order' });
      if (!Number.isInteger(l.quantity) || l.quantity < 1) issues.push({ path: `lines.${i}.quantity`, message: 'Claim at least 1 unit' });
      if (l.unitCost.currency !== po.currency) issues.push({ path: `lines.${i}.unitCost.currency`, message: `Use ${po.currency}` });
      if (l.unitCost.amount < 0) issues.push({ path: `lines.${i}.unitCost.amount`, message: 'Unit cost cannot be negative' });
    });
    if (issues.length) throw invalidMany('Some claim lines are invalid', issues);
    const ref = await this.core.nextRef('claim');
    const claim = await this.core.repo.transaction(async (tx) => {
      const cur = await tx.getPurchaseOrder(po.id, { forUpdate: true });
      if (!cur) throw notFound('Purchase order');
      return this.core.insertClaim(tx, {
        ref,
        po: cur,
        receiptId: input.receiptId ?? null,
        kind: input.kind,
        lines: input.lines.map((l) => ({ stockItemId: l.stockItemId, sku: l.sku || poLines.find((p) => p.stockItemId === l.stockItemId)!.sku, quantity: l.quantity, unitCost: l.unitCost })),
        owner: by.actor,
        notes: clean(input.notes),
      });
    });
    await this.core.audit({ action: 'purchasing.claim.create', actionLabel: 'Opened supplier claim', category: 'financial', target: claimTarget(claim), relatedTargets: [{ type: 'purchase_order', id: po.id, ref: po.ref }], after: claimSnapshot(claim) }, by);
    return (await this.core.views.claims([claim]))[0]!;
  }

  async submitClaim(id: string, body: { supplierReference?: string | null }, by: Caller): Promise<SupplierClaim> {
    const reference = clean(body.supplierReference);
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getClaim(id, { forUpdate: true });
      if (!before) throw notFound('Supplier claim');
      const status = supplierClaimMachine.next(before.status, 'submit');
      const after = await tx.updateClaim(id, { status, ...(reference ? { supplierReference: reference } : {}) });
      await tx.addEvent(this.core.event(before.purchaseOrderId, `Supplier claim ${before.ref} sent to supplier`, reference ? `Supplier reference ${reference}` : null, by.actor));
      return { before, after };
    });
    await this.core.audit({ action: 'purchasing.claim.submit', actionLabel: 'Sent supplier claim', category: 'financial', target: claimTarget(after), before: { status: before.status }, after: { status: after.status, supplierReference: reference } }, by);
    return (await this.core.views.claims([after]))[0]!;
  }

  async settleClaim(id: string, body: { settlement: 'credit_note' | 'refund' | 'replacement'; amount: Money; reason: string }, by: Caller): Promise<SupplierClaim> {
    const reason = required(body.reason, 'reason', 'Describe the settlement');
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getClaim(id, { forUpdate: true });
      if (!before) throw notFound('Supplier claim');
      const status = supplierClaimMachine.next(before.status, 'settle');
      if (body.amount.currency !== before.currency) throw invalid('amount.currency', `Use ${before.currency}`);
      if (body.amount.amount < 0) throw invalid('amount.amount', 'The settled amount cannot be negative');
      const after = await tx.updateClaim(id, { status, settlement: body.settlement, settledAmount: body.amount.amount, decidedAt: this.core.now(), notes: appendNote(before.notes, reason) });
      await tx.addEvent(this.core.event(before.purchaseOrderId, `Supplier claim ${before.ref} settled`, `${settlementLabel(body.settlement)} ${formatMoney(body.amount)} · ${reason}`, by.actor));
      return { before, after };
    });
    this.core.ctx.events.publish(
      'purchasing.claim.settled',
      { claimId: id, supplierId: after.supplierId, purchaseOrderId: after.purchaseOrderId, settlement: body.settlement, amount: body.amount },
      { actor: by.actor, requestId: by.requestId },
    );
    await this.core.audit(
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
    return (await this.core.views.claims([after]))[0]!;
  }

  async closeClaim(id: string, body: { outcome: 'rejected' | 'withdrawn'; reason: string }, by: Caller): Promise<SupplierClaim> {
    const reason = required(body.reason, 'reason', 'Say why the claim is closed');
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getClaim(id, { forUpdate: true });
      if (!before) throw notFound('Supplier claim');
      const status = supplierClaimMachine.next(before.status, body.outcome === 'rejected' ? 'reject' : 'withdraw');
      const after = await tx.updateClaim(id, { status, decidedAt: this.core.now(), notes: appendNote(before.notes, reason) });
      await tx.addEvent(this.core.event(before.purchaseOrderId, `Supplier claim ${before.ref} ${body.outcome === 'rejected' ? 'rejected by the supplier' : 'withdrawn'}`, reason, by.actor));
      return { before, after };
    });
    await this.core.audit(
      { action: `purchasing.claim.${body.outcome === 'rejected' ? 'reject' : 'withdraw'}`, actionLabel: body.outcome === 'rejected' ? 'Closed supplier claim as rejected' : 'Withdrew supplier claim', category: 'financial', target: claimTarget(after), reason, before: { status: before.status }, after: { status: after.status } },
      by,
    );
    return (await this.core.views.claims([after]))[0]!;
  }
}

const appendNote = (notes: string | null, line: string) => (notes ? `${notes}\n${line}` : line);
const settlementLabel = (s: string) => ({ credit_note: 'Credit note', refund: 'Refund', replacement: 'Replacement' })[s] ?? s;
const claimTarget = (c: ClaimRow) => ({ type: 'supplier_claim', id: c.id, ref: c.ref, screen: 'admin/purchasing' });
const claimSnapshot = (c: ClaimRow) => ({ kind: c.kind, status: c.status, amount: { amount: c.amount, currency: c.currency }, lines: c.lines });
