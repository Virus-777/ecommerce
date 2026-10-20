/** Put-away of received purchase deliveries: tasks per received line with suggested bins, labels, bin scans. */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Principal } from '../../../spec/identity.js';
import type { FileLink, PutawayTask } from '../../../spec/warehouse.js';
import { renderPdf } from '../../../kernel/lib/pdf.js';
import { renderZpl } from '../domain/zpl.js';
import { actorText, QUARANTINE, STORAGE_KINDS } from '../domain/rules.js';
import { putAwayTaskMachine } from '../domain/state-machines.js';
import type { Where } from '../../../kernel/mongo/index.js';
import type { PutawayRec } from '../ports.js';
import type { Bins } from './bins.js';
import { Batch, invalidField, notFound, type By, type Core } from './core.js';
import type { Views } from './views.js';

const MAX_LABELS = 1000;

export class Putaway {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly bins: Bins,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  async list(q: { status?: 'open' | 'done'; receiptId?: string }, page: PageRequest): Promise<common.Page<PutawayTask>> {
    const where: Where<PutawayRec> = {};
    if (q.status) where.status = q.status;
    if (q.receiptId) where.receipt_id = q.receiptId;
    const result = await this.repo.page('putaway_tasks', where, page, { order: { column: 'receipt_ref', direction: 'desc' } });
    return { ...result, items: await this.views.putaways(result.items) };
  }

  /** purchasing.receipt.recorded: a task per received line for sellable units, and one to quarantine for damaged units */
  async onReceiptRecorded(e: EventPayload<'purchasing.receipt.recorded'>): Promise<void> {
    await this.createTasks(e);
  }

  /**
   * fulfillment-service.inbound.received: a Fulfilled by Marketly receiving record is put away like a purchase
   * receipt (sellable units to the suggested bin, damaged units to quarantine); receipt_id = the receiving record,
   * receipt_ref = the IB- reference, at the service location. Idempotent per receiptId.
   */
  async onInboundReceived(e: EventPayload<'fulfillment-service.inbound.received'>): Promise<void> {
    await this.createTasks({ receiptId: e.receiptId, ref: e.ref, locationId: e.locationId, lines: e.lines.map((l) => ({ stockItemId: l.stockItemId, received: l.received, damaged: l.damaged })) });
  }

  /** Tasks of one receipt (once per receiptId): received − damaged to the suggested bin, damaged to a quarantine bin */
  private async createTasks(e: { receiptId: string; ref: string; locationId: string; lines: { stockItemId: string; received: number; damaged: number; binCode?: string | null }[] }): Promise<void> {
    if ((await this.repo.count('putaway_tasks', { receipt_id: e.receiptId })) > 0) return;
    const quarantines = await this.repo.find('bins', { location_id: e.locationId, kind: 'quarantine', active: true }, { orderBy: [['code', 'asc']], limit: 100 });
    const rows: PutawayRec[] = [];
    for (const l of e.lines) {
      const bin = await this.bins.suggest(l.stockItemId, e.locationId);
      const sellable = Math.max(0, l.received - l.damaged);
      if (sellable > 0) rows.push(this.task(e, l.stockItemId, sellable, bin?.code ?? l.binCode ?? null));
      // damaged units: a quarantine bin in the item's zone, else the first one, else any quarantine bin at put-away
      const quarantine = quarantines.find((q) => bin && q.zone === bin.zone) ?? quarantines[0];
      if (l.damaged > 0) rows.push(this.task(e, l.stockItemId, l.damaged, quarantine?.code ?? QUARANTINE));
    }
    if (!rows.length) return;
    await this.repo.transaction(async (tx) => {
      if ((await tx.count('putaway_tasks', { receipt_id: e.receiptId })) > 0) return;
      await tx.insertMany('putaway_tasks', rows);
    });
  }

  private task(e: { receiptId: string; ref: string; locationId: string }, stockItemId: string, quantity: number, suggested: string | null): PutawayRec {
    return { id: newId(), receipt_id: e.receiptId, receipt_ref: e.ref, location_id: e.locationId, stock_item_id: stockItemId, quantity, suggested_bin_code: suggested, bin_code: null, status: putAwayTaskMachine.initial, done_by: null, done_at: null };
  }

  /** Scans the bin; fewer units than the task splits it (the rest stays open for another bin) */
  async complete(id: string, body: { binCode: string; quantity: number }, by: By): Promise<PutawayTask> {
    const t = await this.repo.get('putaway_tasks', id);
    if (!t) throw notFound('Put-away task');
    putAwayTaskMachine.next(t.status as never, 'complete');
    if (!Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > t.quantity) throw invalidField('quantity', `Between 1 and ${t.quantity} units`);
    const code = body.binCode?.trim() ?? '';
    const bin = code ? await this.bins.byScan(code, t.location_id) : undefined;
    const damaged = t.suggested_bin_code === QUARANTINE || (t.suggested_bin_code ? (await this.repo.find('bins', { location_id: t.location_id, code: t.suggested_bin_code }))[0]?.kind === 'quarantine' : false);
    const refuse = async (message: string) => {
      await this.core.logScan({ context: 'putaway', contextId: id, code, result: 'wrong_bin', actor: by.actor });
      return this.core.error('SCAN_MISMATCH', message, { expected: t.suggested_bin_code, scanned: code });
    };
    if (!bin || !bin.active) throw await refuse('Unknown bin at this location');
    if (damaged && bin.kind !== 'quarantine') throw await refuse('Damaged units go to a quarantine bin');
    if (!damaged && !STORAGE_KINDS.includes(bin.kind)) throw await refuse(`${bin.code} is a ${bin.kind} bin; put stock in a pick or bulk bin`);
    const batch = new Batch(by);
    const now = this.core.now();
    await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('putaway_tasks', id, { forUpdate: true }))!;
      if (locked.status !== 'open') throw new AppError('ILLEGAL_TRANSITION', 'This put-away task is already done', { machine: 'Put-away task', from: locked.status, event: 'complete', allowed: [] });
      if (body.quantity > locked.quantity) throw invalidField('quantity', `Between 1 and ${locked.quantity} units`);
      if (body.quantity < locked.quantity) await tx.insert('putaway_tasks', { ...locked, id: newId(), quantity: locked.quantity - body.quantity });
      await tx.update('putaway_tasks', id, { quantity: body.quantity, status: putAwayTaskMachine.next('open', 'complete'), bin_code: bin.code, done_by: actorText(by.actor), done_at: now });
      let primary = false;
      if (STORAGE_KINDS.includes(bin.kind)) {
        const existing = await tx.find('bin_assignments', { stock_item_id: t.stock_item_id }, { forUpdate: true });
        const here = existing.find((a) => a.bin_id === bin.id);
        primary = here?.primary_bin ?? !existing.some((a) => a.primary_bin);
        if (!here) await tx.insert('bin_assignments', { stock_item_id: t.stock_item_id, bin_id: bin.id, primary_bin: primary, assigned_at: now });
      }
      await this.core.logScan({ context: 'putaway', contextId: id, code, result: `put away ${body.quantity}`, actor: by.actor }, tx);
      batch.push('warehouse.bin.assigned', { stockItemId: t.stock_item_id, binId: bin.id, binCode: bin.code, primary });
    });
    this.core.flush(batch);
    return (await this.views.putaways([(await this.repo.get('putaway_tasks', id))!]))[0]!;
  }

  /** Item and put-away labels of a receipt (SKU barcode, label, suggested bin, quantity); reprinting changes nothing */
  async labels(q: { receiptId: string; taskIds?: string[]; perUnit?: boolean; format?: 'pdf' | 'zpl' }, principal?: Principal | null): Promise<FileLink> {
    let tasks = await this.repo.find('putaway_tasks', { receipt_id: q.receiptId }, { orderBy: [['suggested_bin_code', 'asc']] });
    if (q.taskIds?.length) tasks = tasks.filter((t) => q.taskIds!.includes(t.id));
    if (!tasks.length) throw notFound('Put-away tasks for this receipt');
    const info = await this.core.stockInfo(tasks.map((t) => t.stock_item_id));
    const labels: { barcode: string; lines: string[] }[] = [];
    for (const t of tasks) {
      const i = info.get(t.stock_item_id);
      const sku = i?.sku ?? t.stock_item_id.slice(0, 8).toUpperCase();
      const copies = q.perUnit ? t.quantity : 1;
      for (let n = 0; n < copies && labels.length < MAX_LABELS; n++) {
        labels.push({ barcode: sku, lines: [sku, i?.label ?? '', `Bin ${t.bin_code ?? t.suggested_bin_code ?? 'to choose'}`, q.perUnit ? `Unit ${n + 1} of ${t.quantity} - ${t.receipt_ref}` : `Qty ${t.quantity} - ${t.receipt_ref}`] });
      }
    }
    const ref = tasks[0]!.receipt_ref;
    if (q.format === 'zpl') return this.core.fileLink({ fileName: `putaway-${ref}.zpl`, contentType: 'text/plain', bytes: renderZpl(labels), principal, reason: 'Put-away labels' });
    const pages = labels.map((l) => [{ text: l.lines[0]!, bold: true, size: 18 }, { text: l.lines[1]!, size: 10 }, { text: l.lines[2]!, bold: true, size: 14, gap: 6 }, { text: l.lines[3]!, size: 10 }, { text: `||| ${l.barcode} |||`, size: 16, gap: 10 }]);
    return this.core.fileLink({ fileName: `putaway-${ref}.pdf`, contentType: 'application/pdf', bytes: renderPdf(pages, { page: 'label' }), principal, reason: 'Put-away labels' });
  }
}
