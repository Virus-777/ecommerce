/**
 * Receiving records: counting a delivery (bins suggested by warehouse, damage photos kept as inspection evidence),
 * submitting it to inventory (units wait in Incoming until confirmed), confirmation, and the receiving export.
 */
import { AppError, isAppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import { decodeCursor, encodeCursor, type Page, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as identity from '../../../spec/identity.js';
import type { ClaimLine, Receipt, ReceiptLineInput } from '../../../spec/purchasing.js';
import { checkDamagePhotos, checkOverReceipt, freightShares, INCOMING_PO_STATUSES, invalid, invalidMany, landedUnitCost, openQty, receiptHasIssues, RECEIVING_DATASET, receiveEvent, shortageOf } from '../domain/rules.js';
import { deliveryMachine, purchaseOrderMachine, receiptMachine } from '../domain/state-machines.js';
import type { ClaimRow, ReceiptLineRow, ReceiptRow } from '../ports.js';
import { clean, illegal, notFound, required, units, UNUSABLE_ASSET, type Caller, type Core } from './core.js';

const EXPORT_BATCH = 200;

export class Receipts {
  constructor(private readonly core: Core) {}

  /** Creates the receiving record with the open quantity of each line as expected. A receipt cancelled by mistake can be started again. */
  async startReceipt(deliveryId: string, by: Caller): Promise<Receipt> {
    const d = await this.core.repo.getDelivery(deliveryId);
    if (!d) throw notFound('Delivery');
    const counting = await this.core.repo.inProgressReceipt(deliveryId);
    if (counting) throw new AppError('RECEIPT_IN_PROGRESS', `${counting.ref} is already being counted for this delivery.`, { receiptId: counting.id });
    if (d.status !== 'receiving') deliveryMachine.next(d.status, 'startReceiving');
    const po = await this.core.repo.getPurchaseOrder(d.purchaseOrderId);
    if (!po) throw notFound('Purchase order');
    if (!INCOMING_PO_STATUSES.includes(po.status)) throw illegal(po.status, 'startReceiving', 'This purchase order has nothing left to receive.');
    const lines = (await this.core.repo.linesOf([po.id])).filter((l) => openQty(l) > 0);
    if (!lines.length) throw illegal(po.status, 'startReceiving', 'This purchase order has nothing left to receive.');
    const bins = await this.suggestBins(lines.map((l) => l.stockItemId), po.shipToLocationId);
    const ref = await this.core.nextRef('receipt');
    let receipt: ReceiptRow;
    try {
      receipt = await this.core.repo.transaction(async (tx) => {
        const cur = await tx.getDelivery(deliveryId, { forUpdate: true });
        if (!cur) throw notFound('Delivery');
        const open = await tx.inProgressReceipt(deliveryId);
        if (open) throw new AppError('RECEIPT_IN_PROGRESS', `${open.ref} is already being counted for this delivery.`, { receiptId: open.id });
        if (cur.status !== 'receiving') await tx.updateDelivery(deliveryId, { status: deliveryMachine.next(cur.status, 'startReceiving') });
        const id = newId();
        const r = await tx.insertReceipt(
          { id, ref, purchaseOrderId: po.id, deliveryId, locationId: po.shipToLocationId, status: receiptMachine.initial, note: null, receivedBy: by.actor, startedAt: this.core.now(), submittedAt: null, confirmedBy: null, confirmedAt: null, inboundId: null },
          lines.map((l) => ({ receiptId: id, purchaseOrderLineId: l.id, stockItemId: l.stockItemId, expected: openQty(l), received: 0, damaged: 0, binCode: bins.get(l.stockItemId) ?? null, photoIds: [], note: null })),
        );
        await tx.addEvent(this.core.event(po.id, `Receiving started · ${ref}`, null, by.actor));
        return r;
      });
    } catch (err) {
      // the partial unique index answers a concurrent start
      const again = isAppError(err) ? null : await this.core.repo.inProgressReceipt(deliveryId);
      if (again) throw new AppError('RECEIPT_IN_PROGRESS', `${again.ref} is already being counted for this delivery.`, { receiptId: again.id });
      throw err;
    }
    return (await this.core.views.receipts([receipt]))[0]!;
  }

  async listReceipts(query: { status?: Receipt['status']; withIssues?: boolean; purchaseOrderId?: string }, page: PageRequest): Promise<Page<Receipt>> {
    const p = await this.core.repo.listReceipts(query, page);
    return { ...p, items: await this.core.views.receipts(p.items) };
  }

  async getReceipt(id: string): Promise<Receipt> {
    const r = await this.core.repo.getReceipt(id);
    if (!r) throw notFound('Receiving record');
    return (await this.core.views.receipts([r]))[0]!;
  }

  async updateReceipt(id: string, body: { lines: ReceiptLineInput[]; note?: string | null }, _by: Caller): Promise<Receipt> {
    const receipt = await this.core.repo.getReceipt(id);
    if (!receipt) throw notFound('Receiving record');
    if (receipt.status !== 'in_progress') throw illegal(receipt.status, 'count', 'Counts can change only while receiving is in progress.');
    const [lines, poLines] = await Promise.all([this.core.repo.receiptLines([id]), this.core.repo.linesOf([receipt.purchaseOrderId])]);
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
    const pctAllowed = await this.core.ctx.settings.get('overReceiptAllowedPct');
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
    const after = await this.core.repo.transaction(async (tx) => {
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
    return (await this.core.views.receipts([after]))[0]!;
  }

  /** Finish counting: inventory keeps the units in Incoming until the Inventory Manager confirms; shortages update the PO. */
  async submitReceipt(id: string, body: { raiseClaims?: boolean | null }, by: Caller): Promise<Receipt> {
    const receipt = await this.core.repo.getReceipt(id);
    if (!receipt) throw notFound('Receiving record');
    receiptMachine.next(receipt.status, 'submit');
    const [po, delivery, lines, poLines] = await Promise.all([
      this.core.repo.getPurchaseOrder(receipt.purchaseOrderId),
      this.core.repo.getDelivery(receipt.deliveryId),
      this.core.repo.receiptLines([id]),
      this.core.repo.linesOf([receipt.purchaseOrderId]),
    ]);
    if (!po || !delivery) throw notFound('Purchase order');
    const supplier = await this.core.repo.getSupplier(po.supplierId);
    const [photosRequired, pctAllowed] = await Promise.all([this.core.ctx.settings.get('damagePhotosRequired'), this.core.ctx.settings.get('overReceiptAllowedPct')]);
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
      ? { shortage: lines.some((l) => shortageOf(l) > 0) ? await this.core.nextRef('claim') : null, damage: lines.some((l) => l.damaged > 0) ? await this.core.nextRef('claim') : null }
      : { shortage: null, damage: null };

    // inventory first (units wait in Incoming for confirmation); then the open quantities that still come
    const shares = freightShares(money(po.freightAmount, po.currency), poLines);
    const shareOf = new Map(poLines.map((l, i) => [l.id, shares[i]!]));
    const submittedAt = this.core.now();
    // the inbound id links the receipt to inventory's confirmation queue (G75)
    const inbound = await this.core.inventory().submitInbound({
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
    await this.core.inventory().expectIncoming(po.id, po.ref, po.shipToLocationId, this.core.incomingLines(afterLines, po.expectedDate, supplier));

    const totalOrdered = afterLines.reduce((n, l) => n + l.qtyOrdered, 0);
    const totalReceived = afterLines.reduce((n, l) => n + l.qtyReceived, 0);
    const shortUnits = lines.reduce((n, l) => n + shortageOf(l), 0);
    const damagedUnits = lines.reduce((n, l) => n + l.damaged, 0);
    const { after, claims } = await this.core.repo.transaction(async (tx) => {
      const cur = await tx.getReceipt(id, { forUpdate: true });
      if (!cur) throw notFound('Receiving record');
      const status = receiptMachine.next(cur.status, 'submit');
      const curPo = (await tx.getPurchaseOrder(po.id, { forUpdate: true }))!;
      if (curPo.status !== po.status) throw new AppError('CONFLICT', 'The purchase order changed meanwhile; reload and try again.');
      // `afterLines` was built from lines read before the purchase order was locked, so their qtyReceived and
      // qtyDamaged may be stale: read them again under the lock, in the same order closePurchaseOrder takes
      // (purchase order, then its lines — docs/10 §11.2 rules 1 and 3), and add this count to the current
      // value. Appendix C left this site open for Y2 because the fix is this restructuring, not a lock: the
      // `curPo.status` compare-and-set above only catches a concurrent receipt that moves the PO's status.
      // No test can tell: with one writer the stale base and the locked one hold the same numbers, and putting
      // the old version back leaves all 169 green. What it prevents is two receipts of one order losing units.
      const fresh = new Map((await tx.linesOf([po.id], { forUpdate: true })).map((l) => [l.id, l]));
      for (const l of afterLines) {
        const c = counted.get(l.id);
        if (!c || !(c.received || c.damaged)) continue;
        const base = fresh.get(l.id) ?? { qtyReceived: l.qtyReceived - c.received, qtyDamaged: l.qtyDamaged - c.damaged };
        await tx.updateLine(l.id, { qtyReceived: base.qtyReceived + c.received, qtyDamaged: base.qtyDamaged + c.damaged });
      }
      const curDelivery = (await tx.getDelivery(delivery.id, { forUpdate: true }))!;
      await tx.updateDelivery(delivery.id, { status: deliveryMachine.next(curDelivery.status, hasIssues ? 'completeWithIssues' : 'complete') });
      if (newPoStatus !== po.status) await tx.updatePurchaseOrder(po.id, { status: newPoStatus });
      const updated = await tx.updateReceipt(id, { status, submittedAt, receivedBy: by.actor, inboundId: inbound?.id ?? null });
      const label = newPoStatus === 'received' ? `Received in full · ${totalReceived} of ${totalOrdered}` : `Partly received · ${totalReceived} of ${totalOrdered}`;
      const detail = [receipt.ref, shortUnits ? `${shortUnits} short` : null, damagedUnits ? `${damagedUnits} damaged` : null].filter(Boolean).join(' · ');
      await tx.addEvent(this.core.event(po.id, anyReceived ? label : 'Delivery counted · nothing received', detail, by.actor));
      const claims: ClaimRow[] = [];
      const claimLine = (l: ReceiptLineRow, quantity: number): ClaimLine => {
        const pl = poLineById.get(l.purchaseOrderLineId)!;
        return { stockItemId: l.stockItemId, sku: pl.sku, quantity, unitCost: money(pl.unitCostAmount, po.currency) };
      };
      if (claimRefs.shortage) {
        claims.push(await this.core.insertClaim(tx, { ref: claimRefs.shortage, po: curPo, receiptId: id, kind: 'shortage', lines: lines.filter((l) => shortageOf(l) > 0).map((l) => claimLine(l, shortageOf(l))), owner: po.createdBy, notes: `Shortage on ${receipt.ref}` }));
      }
      if (claimRefs.damage) {
        claims.push(await this.core.insertClaim(tx, { ref: claimRefs.damage, po: curPo, receiptId: id, kind: 'damage', lines: lines.filter((l) => l.damaged > 0).map((l) => claimLine(l, l.damaged)), owner: po.createdBy, notes: `Damage on ${receipt.ref}` }));
      }
      return { after: updated, claims };
    });

    const view = (await this.core.views.receipts([after]))[0]!;
    this.core.ctx.events.publish(
      'purchasing.receipt.recorded',
      { receiptId: id, ref: after.ref, purchaseOrderId: po.id, locationId: after.locationId, lines: view.lines, hasIssues },
      { actor: by.actor, requestId: by.requestId },
    );
    if (newPoStatus !== po.status) this.core.statusChanged({ ...po, status: newPoStatus }, po.status, null, by);
    await this.core.audit(
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
    const receipt = await this.core.repo.getReceipt(id);
    if (!receipt) throw notFound('Receiving record');
    receiptMachine.next(receipt.status, 'cancel');
    const lines = await this.core.repo.receiptLines([id]);
    const after = await this.core.repo.transaction(async (tx) => {
      const cur = await tx.getReceipt(id, { forUpdate: true });
      if (!cur) throw notFound('Receiving record');
      const updated = await tx.updateReceipt(id, { status: receiptMachine.next(cur.status, 'cancel') });
      // the only receiving record of the delivery is gone: the delivery is back at the dock (Receiving → Arrived)
      const delivery = await tx.getDelivery(cur.deliveryId, { forUpdate: true });
      if (delivery?.status === 'receiving' && !(await tx.inProgressReceipt(cur.deliveryId))) await tx.updateDelivery(delivery.id, { status: deliveryMachine.next(delivery.status, 'reopen') });
      await tx.addEvent(this.core.event(cur.purchaseOrderId, `Receiving ${cur.ref} discarded`, reason, by.actor));
      return updated;
    });
    await this.detachPhotos(receipt, [...new Set(lines.flatMap((l) => l.photoIds))]);
    await this.core.audit(
      { action: 'purchasing.receipt.cancel', actionLabel: 'Discarded receiving record', category: 'other', target: { type: 'receipt', id, ref: receipt.ref, screen: 'ops/receiving' }, reason, before: { status: receipt.status }, after: { status: after.status } },
      by,
    );
    return (await this.core.views.receipts([after]))[0]!;
  }

  /**
   * inventory.receipt.confirmed: Mark the receipt confirmed (who made the stock sellable) and add it to the PO timeline.
   * Receipts of Fulfilled by Marketly inbound shipments (source.kind service_inbound) are fulfillment-service's, never ours.
   */
  async onReceiptConfirmedFromInventory(event: EventPayload<'inventory.receipt.confirmed'>, meta?: { at?: string }): Promise<void> {
    if (event.source?.kind === 'service_inbound') return;
    const receipt = await this.core.repo.getReceipt(event.receiptId);
    if (!receipt) {
      this.core.ctx.log.info({ receiptId: event.receiptId }, 'purchasing: confirmed receipt is not ours; ignored');
      return;
    }
    if (receipt.status === 'confirmed') return; // delivered twice
    if (!receiptMachine.can(receipt.status, 'confirm')) {
      this.core.ctx.log.warn({ receiptId: receipt.id, status: receipt.status }, 'purchasing: inventory confirmed a receipt that is not waiting for confirmation; ignored');
      return;
    }
    const sellable = (event.lines ?? []).reduce((n, l) => n + (l.sellable ?? 0), 0);
    const at = meta?.at ? new Date(meta.at) : this.core.now();
    const confirmed = await this.core.repo.transaction(async (tx) => {
      const cur = await tx.getReceipt(receipt.id, { forUpdate: true });
      if (!cur || !receiptMachine.can(cur.status, 'confirm')) return null;
      // receipts submitted before inboundId was kept get it here
      const after = await tx.updateReceipt(cur.id, { status: receiptMachine.next(cur.status, 'confirm'), confirmedBy: event.confirmedBy, confirmedAt: at, ...(cur.inboundId ? {} : { inboundId: event.inboundId ?? null }) });
      await tx.addEvent({ ...this.core.event(cur.purchaseOrderId, `Stock made available · ${cur.ref}`, `${units(sellable)} sellable`, event.confirmedBy), at });
      return after;
    });
    if (confirmed) await this.recordBuyingCost(confirmed, at);
  }

  /**
   * The Official Store's buying cost of a confirmed receipt (received units at their purchase order unit cost) goes to
   * finance's trading costs, for the margin and the Purchasing cost report. Finance keys it on the receipt and the
   * confirmation time, so a redelivered event records it once.
   */
  private async recordBuyingCost(receipt: ReceiptRow, at: Date) {
    const finance = this.core.ctx.tryUse('finance');
    if (!finance) return;
    const view = (await this.core.views.receipts([receipt]))[0];
    if (!view || view.buyingCost.amount <= 0) return;
    await finance.recordCompanyCost({ kind: 'buying_cost', amount: view.buyingCost, reference: { kind: 'receipt', id: receipt.id, ref: receipt.ref }, at: at.toISOString() });
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
    const rows = await this.core.repo.receiptsAfter(
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
    const receipts = await this.core.views.receipts(batch);
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
    const reports = this.core.ctx.tryUse('reports');
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
      if (!isNotImplemented(err)) this.core.ctx.log.warn({ err }, 'purchasing: could not register the receiving export with reports');
    }
  }

  /** Damage photos become inspection evidence of the receipt (media usage inspection_photo). */
  private async attachPhotos(receipt: ReceiptRow, ids: readonly string[]) {
    if (!ids.length) return;
    const media = this.core.ctx.tryUse('media');
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
    const media = this.core.ctx.tryUse('media');
    if (!media || !ids.length) return;
    for (const id of ids) {
      try {
        await media.detach(id, { module: 'purchasing', kind: 'inspection_photo', refId: receipt.id });
      } catch (err) {
        this.core.ctx.log.warn({ err, assetId: id }, 'purchasing: could not release a receipt photo');
      }
    }
  }

  /** Put-away bins suggested by warehouse; warehouse being off or unbuilt leaves them empty. */
  private async suggestBins(stockItemIds: readonly string[], locationId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const warehouse = this.core.ctx.tryUse('warehouse');
    if (!warehouse) return out;
    // one call per item (warehouse has no batch suggestion), side by side
    const ids = [...new Set(stockItemIds)];
    const bins = await Promise.all(
      ids.map((id) =>
        warehouse.suggestBin(id, locationId).catch((err) => {
          if (!isNotImplemented(err)) this.core.ctx.log.warn({ err }, 'warehouse.suggestBin failed; no bin suggested');
          return null;
        }),
      ),
    );
    ids.forEach((id, i) => {
      const code = bins[i]?.code;
      if (code) out.set(id, code);
    });
    return out;
  }
}
