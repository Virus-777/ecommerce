/** Return parcels: expected from approved Official Store returns, scanned in at the dock, handed to inspection. */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { ReturnDetail } from '../../../spec/returns.js';
import type { ReceiveParcelInput, ReturnParcel } from '../../../spec/warehouse.js';
import { actorText, addDays, looksLikeReturnRef, NIL_UUID, normalizeCode } from '../domain/rules.js';
import { returnParcelMachine } from '../domain/state-machines.js';
import type { ParcelRec, Where } from '../ports.js';
import { invalidField, notFound, type By, type Core } from './core.js';
import type { Views } from './views.js';

/** Days a parcel takes from the drop-off deadline to the dock, and without a deadline from approval */
const TRANSIT_DAYS = 7;
const NO_DEADLINE_DAYS = 21;

const itemsOf = (d: ReturnDetail) => d.items.map((i) => `${[i.title, ...Object.values(i.options ?? {})].filter(Boolean).join(', ')} × ${i.quantity}`);

export class Parcels {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  async list(q: { status?: ReturnParcel['status']; q?: string }, page: PageRequest): Promise<common.Page<ReturnParcel>> {
    const where: Where<ParcelRec> = {};
    if (q.status) where.status = q.status;
    const result = await this.repo.page('return_parcels', where, page, { order: { column: 'id', direction: 'desc' }, ...(q.q?.trim() ? { search: { columns: ['return_ref', 'order_ref', 'tracking_number'], term: q.q } } : {}) });
    return { ...result, items: await this.views.parcels(result.items) };
  }

  /** returns.return.approved: an Official Store return that comes back to the warehouse is expected at the dock */
  async onReturnApproved(e: EventPayload<'returns.return.approved'>): Promise<void> {
    if (e.ownerType !== 'official' || e.withoutReturn) return;
    if ((await this.repo.count('return_parcels', { return_id: e.returnId })) > 0) return;
    const today = this.core.today();
    const expectedBy = e.dropOffBy ? addDays(this.core.today(new Date(e.dropOffBy)), TRANSIT_DAYS) : addDays(today, NO_DEADLINE_DAYS);
    // the return's items by name and the order reference, for the dock; the event's own fields when returns does not answer
    const detail = (await this.core.soft('returns', 'approved return', (r) => r.getReturn(e.returnId)))?.detail ?? null;
    const orderRef =
      detail?.orderRef ??
      (await this.core.ctx
        .use('orders')
        .getOrder(e.orderId)
        .then((o) => o?.ref ?? null)
        .catch((err) => {
          this.core.ctx.log.info({ err, orderId: e.orderId }, 'warehouse: order of an approved return not found');
          return null;
        }));
    await this.repo.insert('return_parcels', {
      id: newId(),
      location_id: (await this.core.defaultLocation()) ?? NIL_UUID,
      return_id: e.returnId,
      return_ref: e.ref,
      order_ref: orderRef,
      tracking_number: e.trackingNumber ?? detail?.shipment?.trackingNumber ?? null,
      status: returnParcelMachine.initial,
      expected_by: expectedBy,
      expected_items: detail ? itemsOf(detail) : e.items.map((i) => `Item × ${i.quantity}`),
      unexpected: false,
      parcel_condition: null,
      photo_media_ids: [],
      note: null,
      received_by: null,
      received_at: null,
      handed_over_to: null,
      handed_over_at: null,
    });
  }

  /** The return behind a scanned code, through returns (a return reference) */
  private async returnFor(code: string): Promise<ReturnDetail | null> {
    if (!looksLikeReturnRef(code)) return null;
    const found = await this.core.soft('returns', 'return by reference', (r) => r.getReturnAdmin(code.trim().toUpperCase()));
    return found?.detail ?? null;
  }

  private async match(code: string): Promise<ParcelRec | undefined> {
    const c = code.trim();
    const upper = normalizeCode(c);
    if (isUuid(c)) {
      const byId = (await this.repo.find('return_parcels', { id: c }))[0] ?? (await this.repo.find('return_parcels', { return_id: c }, { orderBy: [['id', 'desc']] }))[0];
      if (byId) return byId;
    }
    return (await this.repo.find('return_parcels', { return_ref: upper }))[0] ?? (await this.repo.find('return_parcels', { tracking_number: [c, upper] }, { orderBy: [['id', 'desc']] }))[0];
  }

  /** Matches an expected parcel and records the receipt in returns; otherwise an unexpected parcel support is told about */
  async receive(body: ReceiveParcelInput, by: By): Promise<ReturnParcel> {
    const code = body.code?.trim() ?? '';
    if (!code) throw invalidField('code', 'Scan the return label or enter the return reference');
    if (!['intact', 'damaged', 'opened'].includes(body.parcelCondition)) throw invalidField('parcelCondition', 'Choose intact, damaged or opened');
    let parcel = await this.match(code);
    let detail: ReturnDetail | null = null;
    if (!parcel || !parcel.return_ref) {
      detail = await this.returnFor(code);
      if (detail && !parcel) parcel = (await this.repo.find('return_parcels', { return_id: detail.id }))[0];
    }
    if (parcel && parcel.status !== 'expected') throw this.core.error('PARCEL_ALREADY_RECEIVED', `This parcel was already received${parcel.return_ref ? ` (${parcel.return_ref})` : ''}`, { parcelId: parcel.id });
    const returnId = parcel?.return_id ?? (detail && detail.seller.ownerType === 'official' ? detail.id : null);
    const photos = [...new Set(body.photoIds ?? [])];
    const now = this.core.now();
    const id = parcel?.id ?? newId();
    const media = this.core.ctx.tryUse('media');
    if (media && photos.length) {
      for (const assetId of photos) await media.attach(assetId, { module: 'warehouse', kind: 'inspection_photo', refId: id, refLabel: `Return parcel ${detail?.ref ?? parcel?.return_ref ?? code}` }, { kind: 'staff', id: by.actor.id ?? null });
    }
    if (returnId) {
      const returns = this.core.ctx.tryUse('returns');
      if (returns) {
        try {
          detail = await returns.recordWarehouseReceipt(returnId, now.toISOString(), by.actor, looksLikeReturnRef(code) ? (parcel?.tracking_number ?? null) : code);
        } catch (err) {
          if (!isAppError(err) || err.code !== 'NOT_FOUND') throw err;
          this.core.ctx.log.warn({ returnId }, 'warehouse: expected parcel of a return returns does not know');
        }
      }
    }
    const tracking = looksLikeReturnRef(code) || isUuid(code) ? (detail?.shipment?.trackingNumber ?? parcel?.tracking_number ?? null) : code;
    const unexpected = !returnId;
    const location = parcel?.location_id ?? (await this.core.defaultLocation()) ?? NIL_UUID;
    const row = await this.repo.transaction(async (tx) => {
      const fields = {
        return_ref: detail?.ref ?? parcel?.return_ref ?? (looksLikeReturnRef(code) ? normalizeCode(code) : null),
        order_ref: detail?.orderRef ?? parcel?.order_ref ?? null,
        tracking_number: tracking,
        expected_items: detail ? itemsOf(detail) : (parcel?.expected_items ?? []),
        parcel_condition: body.parcelCondition,
        photo_media_ids: photos,
        note: body.note?.trim() || null,
        received_by: actorText(by.actor),
        received_at: now,
      };
      if (parcel) {
        const locked = (await tx.get('return_parcels', parcel.id, { forUpdate: true }))!;
        if (locked.status !== 'expected') throw this.core.error('PARCEL_ALREADY_RECEIVED', 'This parcel was already received', { parcelId: locked.id });
        return tx.update('return_parcels', parcel.id, { ...fields, status: returnParcelMachine.next('expected', 'receive') });
      }
      return tx.insert('return_parcels', {
        id,
        location_id: location,
        return_id: returnId,
        status: returnParcelMachine.next('expected', 'receive'),
        expected_by: null,
        unexpected,
        handed_over_to: null,
        handed_over_at: null,
        ...fields,
      });
    });
    await this.core.logScan({ context: 'returns', contextId: row.id, code, result: unexpected ? 'unexpected' : 'received', actor: by.actor });
    this.core.publish('warehouse.return_parcel.received', { parcelId: row.id, returnId: row.return_id, unexpected: row.unexpected, parcelCondition: body.parcelCondition, receivedAt: now.toISOString() }, by);
    if (unexpected) {
      await this.core.soft('workqueues', 'unexpected parcel', (w) =>
        w.raise({
          queueKey: 'warehouse.return_parcels',
          kind: 'unexpected_return_parcel',
          title: `Unexpected return parcel ${row.tracking_number ?? row.return_ref ?? code}`,
          summary: 'A parcel arrived at the warehouse with no approved Official Store return. Find the customer and the order.',
          subject: { type: 'other', id: row.id, ref: row.tracking_number ?? row.return_ref ?? null, label: 'Return parcel' },
          priority: body.parcelCondition === 'intact' ? 'normal' : 'high',
          dedupeKey: `return_parcel:${row.id}`,
        }),
      );
    }
    return (await this.views.parcels([row]))[0]!;
  }

  async handOver(id: string, body: { inspectorId?: string | null; note?: string | null }, by: By): Promise<ReturnParcel> {
    const p = await this.repo.get('return_parcels', id);
    if (!p) throw notFound('Return parcel');
    const status = returnParcelMachine.next(p.status as never, 'handOver');
    const inspector: common.Actor = body.inspectorId ? { kind: 'staff', id: body.inspectorId, name: null } : { kind: 'staff', id: null, name: 'Returns inspection' };
    const note = body.note?.trim();
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('return_parcels', id, { forUpdate: true }))!;
      if (locked.status !== 'received') throw new AppError('ILLEGAL_TRANSITION', `The parcel is ${locked.status.replace('_', ' ')}`, { machine: 'Return parcel', from: locked.status, event: 'handOver', allowed: [] });
      return tx.update('return_parcels', id, { status, handed_over_to: actorText(inspector), handed_over_at: this.core.now(), ...(note ? { note: locked.note ? `${locked.note}\n${note}` : note } : {}) });
    });
    this.core.publish('warehouse.return_parcel.handed_over', { parcelId: id, returnId: row.return_id, inspectorId: body.inspectorId ?? null }, by);
    return (await this.views.parcels([row]))[0]!;
  }

  /** Job: expected parcels past their date get a return_parcel_overdue item (warehouse.return_parcels; closed by workqueues when the parcel is received) */
  async overdue(): Promise<number> {
    const today = this.core.today();
    const late = await this.repo.find('return_parcels', { status: 'expected', expected_by: { op: '<', value: today } }, { orderBy: [['expected_by', 'asc']], limit: 500 });
    for (const p of late) {
      await this.core.soft('workqueues', 'overdue return parcel', (w) =>
        w.raise({
          queueKey: 'warehouse.return_parcels',
          kind: 'return_parcel_overdue',
          title: `Return parcel not received${p.return_ref ? `: ${p.return_ref}` : ''}`,
          summary: `Expected at the warehouse by ${p.expected_by}. Check the return shipment's tracking with the customer.`,
          // the parcel is the subject: workqueues closes the item on warehouse.return_parcel.received for this parcel
          subject: { type: 'other', id: p.id, ref: p.return_ref ?? p.tracking_number ?? null, label: 'Return parcel' },
          relatedSubjects: p.return_id ? [{ type: 'return', id: p.return_id, ref: p.return_ref }] : null,
          dedupeKey: `return_parcel_overdue:${p.id}`,
        }),
      );
    }
    if (late.length) this.core.ctx.log.info({ count: late.length }, 'warehouse: expected return parcels past their date');
    return late.length;
  }
}
