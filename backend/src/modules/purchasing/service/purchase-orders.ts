/**
 * Purchase orders: drafts, edits, sending (within the buyer's purchase limit, or after approval in access), cancel and
 * close short, supplier documents, and the Incoming units inventory shows for open orders.
 */
import { AppError, isAppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { format as formatMoney, money, type Money } from '../../../kernel/lib/money.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { PurchaseOrder, PurchaseOrderInput, PurchaseOrderLineInput, PurchaseOrderRow, PurchaseOrderShipTo, PurchaseOrderUpdate } from '../../../spec/purchasing.js';
import { INCOMING_PO_STATUSES, invalid, invalidMany, minDate, openQty, SEND_ACTION, shortDate, SYSTEM, type PoStatus } from '../domain/rules.js';
import { purchaseOrderMachine } from '../domain/state-machines.js';
import type { ClaimRow, PoRow, SupplierRow } from '../ports.js';
import type { PurchasingRepository } from '../repository.js';
import { clean, illegal, notFound, poSnapshot, poTarget, required, units, UNUSABLE_ASSET, type Caller, type Core, type NewLine } from './core.js';

export class PurchaseOrders {
  constructor(private readonly core: Core) {}

  /** Incoming detail for stock screens and restock estimates */
  async getOpenPurchaseOrders(stockItemId: string): Promise<{ purchaseOrderId: string; ref: string; quantityOpen: number; expectedDate: string | null }[]> {
    const lines = await this.core.repo.linesForStock([stockItemId], INCOMING_PO_STATUSES);
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

  async listPurchaseOrders(
    query: { q?: string; status?: PoStatus; supplierId?: string; lateOrShort?: boolean; awaitingApproval?: boolean },
    page: PageRequest,
  ): Promise<Page<PurchaseOrderRow>> {
    const p = await this.core.repo.listPurchaseOrders({ ...query, today: this.core.today() }, page);
    return { ...p, items: await this.core.views.purchaseOrderRows(p.items) };
  }

  async getPurchaseOrder(id: string): Promise<PurchaseOrder> {
    const po = await this.core.repo.getPurchaseOrder(id);
    if (!po) throw notFound('Purchase order');
    return this.core.views.purchaseOrder(po);
  }

  async createPurchaseOrder(input: PurchaseOrderInput, by: Caller): Promise<PurchaseOrder> {
    const supplier = await this.core.repo.getSupplier(input.supplierId);
    if (!supplier) throw invalid('supplierId', 'Choose an existing supplier');
    if (!supplier.active) throw new AppError('SUPPLIER_INACTIVE', `${supplier.name} is deactivated.`, { supplierId: supplier.id });
    const lines = await this.prepareLines(input.lines);
    const freight = input.freight ? this.amountOf(input.freight, 'freight') : 0;
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    await this.checkAttachments(attachmentIds);
    const po = await this.core.createDraft(
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
    return this.core.views.purchaseOrder(po);
  }

  async updatePurchaseOrder(id: string, body: PurchaseOrderUpdate, by: Caller): Promise<PurchaseOrder> {
    const before = await this.core.repo.getPurchaseOrder(id);
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

    const oldLines = await this.core.repo.linesOf([id]);
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
      const supplier = await this.core.repo.getSupplier(before.supplierId);
      const projected = oldLines.map((l) => ({ ...l, expectedDate: l.id in lineDates ? (lineDates[l.id] ?? null) : l.expectedDate }));
      await this.core.inventory().expectIncoming(before.id, before.ref, before.shipToLocationId, this.core.incomingLines(projected, expectedDate, supplier));
    }

    const after = await this.core.repo.transaction(async (tx) => {
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
        await tx.insertLines(newLines.map((l) => this.core.lineRow(id, l)));
      }
      for (const l of changedLineDates) await tx.updateLine(l.id, { expectedDate: lineDates[l.id] ?? null });
      const updated = await tx.updatePurchaseOrder(id, patch);
      if (draft) await tx.addEvent(this.core.event(id, 'Draft edited', totalChanged ? `Total ${formatMoney(money(totalAmount, cur.currency))}` : null, by.actor));
      else if (datesChanged) await tx.addEvent(this.core.event(id, 'Expected date changed', rescheduleText(expectedDate, before.expectedDate, changedLineDates.length, lineDates), by.actor));
      if (dropApproval) await tx.addEvent(this.core.event(id, 'Approval request withdrawn', 'The order changed after approval was requested', by.actor));
      return updated;
    });

    if (dropApproval) await this.cancelApprovalQuietly(before.approvalRequestId!, by.actor, 'The purchase order changed after approval was requested');
    if (attachmentIds) await this.syncAttachments(after, before.attachmentIds, attachmentIds);
    if (incoming && datesChanged) {
      this.core.ctx.events.publish(
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
    await this.core.audit(
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
    return this.core.views.purchaseOrder(after);
  }

  async sendPurchaseOrder(id: string, body: { emailSupplier?: boolean | null; message?: string | null }, by: Caller): Promise<PurchaseOrder> {
    const po = await this.core.repo.getPurchaseOrder(id);
    if (!po) throw notFound('Purchase order');
    purchaseOrderMachine.next(po.status, 'send');
    const [lines, supplier] = await Promise.all([this.core.repo.linesOf([id]), this.core.repo.getSupplier(po.supplierId)]);
    if (!supplier) throw notFound('Supplier');
    if (!supplier.active) throw new AppError('SUPPLIER_INACTIVE', `${supplier.name} is deactivated.`, { supplierId: supplier.id });
    if (!lines.length) throw invalid('lines', 'Add at least one line before sending');
    if (body.emailSupplier && !supplier.email) throw invalid('emailSupplier', `${supplier.name} has no email address; add one or send the order another way`);
    const total = money(po.totalAmount, po.currency);

    const access = this.core.ctx.tryUse('access');
    if (!access) throw new AppError('APPROVAL_REQUIRED', 'Purchase limits are unavailable right now, so the order cannot be sent.', { action: SEND_ACTION });
    const check = await access.check(by.principal, SEND_ACTION, { money: total });
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot send purchase orders', { action: SEND_ACTION });

    if (check.decision === 'allowed') {
      if (po.approvalState === 'pending' && po.approvalRequestId) await this.cancelApprovalQuietly(po.approvalRequestId, by.actor, 'Sent within the purchase limit');
      const sent = await this.dispatch(id, { actor: by.actor, requestId: by.requestId, emailSupplier: !!body.emailSupplier, message: clean(body.message), approval: 'clear', approvalNote: check.reason || null });
      return this.core.views.purchaseOrder(sent);
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
    const after = await this.core.repo.transaction(async (tx) => {
      const cur = await tx.getPurchaseOrder(id, { forUpdate: true });
      if (!cur) throw notFound('Purchase order');
      purchaseOrderMachine.next(cur.status, 'send');
      const updated = await tx.updatePurchaseOrder(id, { approvalRequestId: request.id, approvalState: 'pending' });
      if (cur.approvalRequestId !== request.id || cur.approvalState !== 'pending') await tx.addEvent(this.core.event(id, 'Approval requested', check.reason || 'Above the purchase limit', by.actor));
      return updated;
    });
    await this.core.audit(
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
    return this.core.views.purchaseOrder(after);
  }

  async cancelPurchaseOrder(id: string, body: { reason: string }, by: Caller): Promise<PurchaseOrder> {
    const reason = required(body.reason, 'reason', 'Say why the purchase order is cancelled');
    const po = await this.core.repo.getPurchaseOrder(id);
    if (!po) throw notFound('Purchase order');
    purchaseOrderMachine.next(po.status, 'cancel');
    const wasSent = po.status === 'sent';
    if (wasSent) {
      await this.assertNothingReceived(this.core.repo, id);
      await this.core.inventory().cancelIncoming(id);
    }
    let after: PoRow;
    try {
      after = await this.core.repo.transaction(async (tx) => {
        const cur = await tx.getPurchaseOrder(id, { forUpdate: true });
        if (!cur) throw notFound('Purchase order');
        const status = purchaseOrderMachine.next(cur.status, 'cancel');
        if (cur.status === 'sent') await this.assertNothingReceived(tx, id);
        const updated = await tx.updatePurchaseOrder(id, { status, closedAt: this.core.now(), closeReason: reason });
        await tx.cancelPendingDeliveries(id, 'Purchase order cancelled');
        await tx.addEvent(this.core.event(id, 'Cancelled', reason, by.actor));
        return updated;
      });
    } catch (err) {
      if (wasSent) await this.reExpect(po).catch((e) => this.core.ctx.log.error({ err: e, purchaseOrderId: id }, 'purchasing: could not restore Incoming after a failed cancel'));
      throw err;
    }
    if (po.approvalState === 'pending' && po.approvalRequestId) await this.cancelApprovalQuietly(po.approvalRequestId, by.actor, reason);
    this.core.statusChanged(after, po.status, reason, by);
    await this.core.audit({ action: 'purchasing.purchase_order.cancel', actionLabel: 'Cancelled purchase order', category: 'financial', target: poTarget(after), reason, before: { status: po.status }, after: { status: after.status } }, by);
    return this.core.views.purchaseOrder(after);
  }

  async closePurchaseOrder(id: string, body: { reason: string; raiseShortageClaim?: boolean | null }, by: Caller): Promise<PurchaseOrder> {
    const reason = required(body.reason, 'reason', 'Say why the remaining units will not arrive');
    const po = await this.core.repo.getPurchaseOrder(id);
    if (!po) throw notFound('Purchase order');
    purchaseOrderMachine.next(po.status, 'closeShort');
    const counting = (await this.core.repo.receiptsBy({ purchaseOrderIds: [id], statuses: ['in_progress'] }))[0];
    if (counting) throw illegal(po.status, 'closeShort', `Finish or cancel receiving ${counting.ref} first.`);
    const lines = await this.core.repo.linesOf([id]);
    const open = lines.filter((l) => openQty(l) > 0).map((l) => ({ line: l, qty: openQty(l) }));
    const claimRef = body.raiseShortageClaim && open.length ? await this.core.nextRef('claim') : null;
    if (open.length) await this.core.inventory().cancelIncoming(id, open.map((o) => ({ stockItemId: o.line.stockItemId, quantity: o.qty })));
    const closedUnits = open.reduce((n, o) => n + o.qty, 0);
    const { after, claim } = await this.core.repo.transaction(async (tx) => {
      const cur = await tx.getPurchaseOrder(id, { forUpdate: true });
      if (!cur) throw notFound('Purchase order');
      const status = purchaseOrderMachine.next(cur.status, 'closeShort');
      // `open` was built from lines read before the purchase order was locked, so their qtyClosed may be stale:
      // read them again under the lock and add to the current value (docs/10 §11.2 rule 1)
      const fresh = new Map((await tx.linesOf([id], { forUpdate: true })).map((l) => [l.id, l]));
      for (const o of open) await tx.updateLine(o.line.id, { qtyClosed: (fresh.get(o.line.id)?.qtyClosed ?? o.line.qtyClosed) + o.qty });
      const updated = await tx.updatePurchaseOrder(id, { status, closedAt: this.core.now(), closeReason: reason });
      await tx.cancelPendingDeliveries(id, 'Purchase order closed short');
      await tx.addEvent(this.core.event(id, `Closed short · ${units(closedUnits)} will not arrive`, reason, by.actor));
      let claim: ClaimRow | null = null;
      if (claimRef) {
        claim = await this.core.insertClaim(tx, {
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
    this.core.statusChanged(after, po.status, reason, by);
    await this.core.audit(
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
    return this.core.views.purchaseOrder(after);
  }

  /** access.approval.decided: Send an approved PO; record a rejection on the PO timeline */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    if (event.actionKey !== SEND_ACTION) return;
    const po = await this.core.repo.purchaseOrderByApproval(event.requestId);
    if (!po) {
      this.core.ctx.log.info({ requestId: event.requestId }, 'purchasing: approval for an unknown purchase order; ignored');
      return;
    }
    const decider = event.decidedBy ?? SYSTEM;
    if (event.outcome !== 'approved') {
      const state = event.outcome === 'rejected' ? ('rejected' as const) : null;
      await this.core.repo.transaction(async (tx) => {
        const cur = await tx.getPurchaseOrder(po.id, { forUpdate: true });
        if (!cur || cur.approvalRequestId !== event.requestId || cur.approvalState !== 'pending') return; // already recorded
        await tx.updatePurchaseOrder(po.id, { approvalState: state });
        const label = event.outcome === 'rejected' ? 'Approval rejected' : event.outcome === 'expired' ? 'Approval request expired' : 'Approval request cancelled';
        await tx.addEvent(this.core.event(po.id, label, event.reason ?? null, decider));
      });
      return;
    }
    if (po.status !== 'draft' || po.approvalState !== 'pending') return; // sent already, or a decision for an older request
    const requester = await this.staffActor(event.requestedById);
    let details: { emailSupplier?: boolean; message?: string | null } = {};
    const access = this.core.ctx.tryUse('access');
    try {
      details = ((await access?.getApproval(event.requestId))?.details ?? {}) as typeof details;
    } catch (err) {
      if (!isNotImplemented(err)) this.core.ctx.log.warn({ err }, 'access.getApproval failed; sending without the supplier email choice');
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
      await this.core.repo.transaction(async (tx) => {
        await tx.updatePurchaseOrder(po.id, { approvalState: 'approved' });
        await tx.addEvent(this.core.event(po.id, 'Approved, but not sent', err.message, decider));
      });
    }
  }

  private amountOf(m: Money, path: string): number {
    if (m.currency !== this.core.currency) throw invalid(`${path}.currency`, `Use ${this.core.currency}`);
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
      if (l.unitCost.currency !== this.core.currency) issues.push({ path: `lines.${i}.unitCost.currency`, message: `Buying costs are in ${this.core.currency}` });
      if (l.unitCost.amount < 0) issues.push({ path: `lines.${i}.unitCost.amount`, message: 'Unit cost cannot be negative' });
      if (seen.has(l.stockItemId)) issues.push({ path: `lines.${i}.stockItemId`, message: 'This item is already on the order' });
      seen.add(l.stockItemId);
    });
    if (issues.length) throw invalidMany('Some lines are invalid', issues);
    const info = await this.core.requireCompanyStock(lines.map((l) => l.stockItemId));
    return lines.map((l) => ({
      stockItemId: l.stockItemId,
      sku: info.get(l.stockItemId)!.sku,
      label: info.get(l.stockItemId)!.label,
      quantity: l.quantity,
      unitCostAmount: l.unitCost.amount,
      expectedDate: l.expectedDate ?? null,
    }));
  }

  private async reExpect(po: PoRow) {
    const [lines, supplier] = await Promise.all([this.core.repo.linesOf([po.id]), this.core.repo.getSupplier(po.supplierId)]);
    await this.core.inventory().expectIncoming(po.id, po.ref, po.shipToLocationId, this.core.incomingLines(lines, po.expectedDate, supplier));
  }

  /** Sends a draft: Incoming in inventory, status Sent, events, supplier email, audit. */
  private async dispatch(
    id: string,
    o: { actor: common.Actor; requestId?: string; emailSupplier: boolean; message: string | null; approval: 'approved' | 'clear'; approvalNote: string | null; approvalRequestId?: string },
  ): Promise<PoRow> {
    const po = await this.core.repo.getPurchaseOrder(id);
    if (!po) throw notFound('Purchase order');
    purchaseOrderMachine.next(po.status, 'send');
    const [lines, supplier] = await Promise.all([this.core.repo.linesOf([id]), this.core.repo.getSupplier(po.supplierId)]);
    if (!supplier) throw notFound('Supplier');
    if (!supplier.active) throw new AppError('SUPPLIER_INACTIVE', `${supplier.name} is deactivated.`, { supplierId: supplier.id });
    const shipTo = await this.shipToOf(po.shipToLocationId);
    await this.core.inventory().expectIncoming(po.id, po.ref, po.shipToLocationId, this.core.incomingLines(lines, po.expectedDate, supplier));
    let after: PoRow;
    try {
      after = await this.core.repo.transaction(async (tx) => {
        const cur = await tx.getPurchaseOrder(id, { forUpdate: true });
        if (!cur) throw notFound('Purchase order');
        const status = purchaseOrderMachine.next(cur.status, 'send');
        const approval = o.approval === 'approved' ? { approvalState: 'approved' as const } : { approvalRequestId: null, approvalState: null };
        const updated = await tx.updatePurchaseOrder(id, { status, sentAt: this.core.now(), ...approval });
        await tx.addEvent(this.core.event(id, 'Sent to supplier', o.approvalNote, o.actor));
        return updated;
      });
    } catch (err) {
      await this.core.inventory()
        .cancelIncoming(id)
        .catch((e) => this.core.ctx.log.error({ err: e, purchaseOrderId: id }, 'purchasing: could not remove Incoming after a failed send'));
      throw err;
    }
    const total = money(after.totalAmount, after.currency);
    this.core.ctx.events.publish(
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
        lines: lines.map((l) => this.core.views.poLine(l, after.currency, after.expectedDate)),
      },
      { actor: o.actor, requestId: o.requestId },
    );
    this.core.statusChanged(after, po.status, null, o);
    if (o.emailSupplier) await this.noteSupplierEmail(after, supplier, o.actor);
    await this.core.audit(
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
    const notifying = (this.core.ctx.modules as readonly string[]).includes('notifications');
    const sent = notifying && Boolean(supplier.email);
    const detail = sent ? null : notifying ? 'The supplier has no email address' : 'Notifications are off';
    await this.core.repo.addEvent(this.core.event(po.id, sent ? `Emailed to ${supplier.email}` : 'Supplier email not sent', detail, actor));
  }

  private async cancelApprovalQuietly(requestId: string, actor: common.Actor, reason: string) {
    try {
      await this.core.ctx.tryUse('access')?.cancelApproval(requestId, actor, reason);
    } catch (err) {
      this.core.ctx.log.warn({ err, requestId }, 'purchasing: could not withdraw the approval request');
    }
  }

  private async assertNothingReceived(repo: PurchasingRepository, purchaseOrderId: string) {
    const [lines, receipts] = await Promise.all([repo.linesOf([purchaseOrderId]), repo.receiptsBy({ purchaseOrderIds: [purchaseOrderId] })]);
    const live = receipts.filter((r) => r.status !== 'cancelled');
    if (lines.some((l) => l.qtyReceived > 0) || live.length) {
      throw new AppError('PO_HAS_RECEIPTS', 'Units were already received or are being counted; close the purchase order short instead of cancelling.', { receiptIds: live.map((r) => r.id) });
    }
  }

  /** Where the supplier delivers, for purchasing.purchase_order.sent (names, address and time zone come from inventory) */
  private async shipToOf(locationId: string): Promise<PurchaseOrderShipTo> {
    const loc = (await this.core.inventory().getLocations({ ownerType: 'official', activeOnly: false })).find((l) => l.id === locationId);
    if (!loc) {
      this.core.ctx.log.warn({ locationId }, 'purchasing: the ship-to location is unknown to inventory');
      return { locationId, code: '', name: 'Company warehouse', address: null, timeZone: this.core.ctx.config.market.timeZone };
    }
    return { locationId: loc.id, code: loc.code, name: loc.name, address: loc.address ?? null, timeZone: loc.timeZone };
  }

  /**
   * Purchase order attachments are supplier documents: attached in media (usage supplier_document, refId
   * the PO) when added and detached when removed, so the media orphan sweep never deletes them.
   */
  private async syncAttachments(po: PoRow, before: readonly string[], after: readonly string[]) {
    const media = this.core.ctx.tryUse('media');
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
    const media = this.core.ctx.tryUse('media');
    if (!media) return; // cannot verify while media is off; the ids are kept
    const assets = await Promise.all(ids.map((id) => media.getAsset(id)));
    const bad = ids.filter((_, i) => {
      const a = assets[i];
      return !a || UNUSABLE_ASSET.includes(a.status) || (a.owner.kind !== 'staff' && a.owner.kind !== 'platform');
    });
    if (bad.length) throw invalidMany('Some files cannot be attached', bad.map((id) => ({ path: 'attachmentIds', message: `File ${id} is missing or not available` })));
  }

  private async staffActor(accountId: string): Promise<common.Actor> {
    const access = this.core.ctx.tryUse('access');
    try {
      const ref = await access?.getStaffRef(accountId);
      return { kind: 'staff', id: accountId, name: ref?.name ?? null };
    } catch {
      return { kind: 'staff', id: accountId, name: null };
    }
  }
}

function rescheduleText(expected: string | null, before: string | null, lineCount: number, lineDates: Record<string, string | null | undefined>): string {
  const parts: string[] = [];
  if (expected !== before) parts.push(expected ? `Expected ${shortDate(expected)}` : 'Expected date cleared');
  if (lineCount) {
    const dates = [...new Set(Object.values(lineDates).filter((d): d is string => !!d))];
    parts.push(`${lineCount} line${lineCount === 1 ? '' : 's'} moved${dates.length === 1 ? ` to ${shortDate(dates[0]!)}` : ''}`);
  }
  return parts.join(' · ');
}
