/**
 * Removal and disposal orders: the seller asks for stock back (or to dispose of it); staff approve (units move
 * to Removal pending; in inventory available → damaged_held, service_removal_reserved), process, ship and complete
 * them (inventory damaged_held → out, service_removal_completed) with the removal or disposal fee. Return-to-seller
 * removals are worked by staff with tracking typed in (decision D9). Offboarding removes everything; unsellable
 * units left too long are disposed.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { RemovalInput, RemovalOrder } from '../../../spec/fulfillment-service.js';
import { removalOrderMachine } from '../domain/state-machines.js';
import { addDays, qty } from '../domain/rules.js';
import type { Balances, FulfillmentServiceRepository, RemovalLineRec, RemovalRec, SkuRec } from '../ports.js';
import { invalid, notFound, Part, type By } from './core.js';

type State = RemovalOrder['state'];
type Action = 'approve' | 'startProcessing' | 'ship' | 'complete' | 'cancel';

const ENROLLED = ['approved', 'active', 'suspended', 'offboarding'];
const ACTION_LABEL: Record<Action, string> = { approve: 'Approved', startProcessing: 'Started processing', ship: 'Shipped', complete: 'Completed', cancel: 'Cancelled' };

export class RemovalsPart extends Part {
  async list(sellerId: string, page: PageRequest) {
    const res = await this.repo.page('removal_orders', { seller_id: sellerId }, page, { order: { column: 'created_at', direction: 'desc' } });
    return { ...res, items: await this.parts.views.removals(res.items) };
  }

  async listAdmin(q: { state?: string; sellerId?: string }, page: PageRequest) {
    const res = await this.repo.page('removal_orders', { ...(q.state ? { state: q.state } : {}), ...(q.sellerId ? { seller_id: q.sellerId } : {}) }, page, { order: { column: 'created_at', direction: 'desc' } });
    return { ...res, items: await this.parts.views.removals(res.items) };
  }

  async ownRemoval(sellerId: string | null, id: string): Promise<RemovalRec> {
    const row = isUuid(id) ? await this.repo.get('removal_orders', id) : undefined;
    if (!row || (sellerId && row.seller_id !== sellerId)) throw notFound('Removal order');
    return row;
  }

  /** Units of a group still free for a new removal: the balance less what requested removals already ask for */
  private async free(tx: FulfillmentServiceRepository, sellerId: string, balances: Balances): Promise<(skuId: string, group: 'available' | 'unsellable') => number> {
    const requested = await tx.find('removal_orders', { seller_id: sellerId, state: 'requested' });
    return (skuId, group) => qty(balances, skuId, group) - requested.flatMap((r) => r.lines).filter((l) => l.skuEnrollmentId === skuId && l.fromGroup === group).reduce((n, l) => n + l.quantity, 0);
  }

  async request(sellerId: string, input: RemovalInput, by: By): Promise<RemovalOrder> {
    const enrollment = await this.parts.enrollment.own(sellerId);
    if (!enrollment || !ENROLLED.includes(enrollment.state)) throw notFound('Enrollment');
    const issues: { path: string; message: string }[] = [];
    if (!input.lines?.length) issues.push({ path: 'lines', message: 'Choose the units to remove' });
    const seen = new Set<string>();
    input.lines?.forEach((l, i) => {
      if (!Number.isInteger(l.quantity) || l.quantity < 1) issues.push({ path: `lines[${i}].quantity`, message: 'Quantity must be at least 1' });
      if (seen.has(l.skuEnrollmentId)) issues.push({ path: `lines[${i}].skuEnrollmentId`, message: 'Each SKU appears once' });
      seen.add(l.skuEnrollmentId);
    });
    if (input.kind === 'return_to_seller' && !input.shipTo) issues.push({ path: 'shipTo', message: 'Enter the address to send the units to' });
    const skus = new Map((await this.repo.find('sku_enrollments', { id: [...seen].filter(isUuid), seller_id: sellerId })).map((s) => [s.id, s]));
    input.lines?.forEach((l, i) => {
      if (!skus.has(l.skuEnrollmentId)) issues.push({ path: `lines[${i}].skuEnrollmentId`, message: 'Not one of your enrolled SKUs' });
    });
    if (issues.length) throw invalid(issues);
    const lines: RemovalLineRec[] = input.lines.map((l) => ({ skuEnrollmentId: l.skuEnrollmentId, quantity: l.quantity, fromGroup: input.fromGroup }));
    const ref = await this.ctx.refs.next('RM', { digits: 4 });
    const row = await this.create(sellerId, input.kind, lines, input.kind === 'return_to_seller' ? (input.shipTo ?? null) : null, ref, skus, input.reason?.trim() || null);
    await this.core.audit(
      {
        action: 'fulfillment-service.removal.request',
        actionLabel: input.kind === 'dispose' ? 'Asked Marketly to dispose of stock' : 'Asked for stock back from Marketly',
        category: 'inventory',
        target: { type: 'removal_order', id: row.id, ref: row.ref, label: `Removal ${row.ref}`, sellerId, screen: 'seller/inventory' },
        after: { kind: row.kind, lines: row.lines, shipTo: row.ship_to },
        reason: row.reason,
        visibleToSeller: true,
      },
      by,
    );
    return (await this.parts.views.removals([row]))[0]!;
  }

  private async create(sellerId: string, kind: 'return_to_seller' | 'dispose', lines: RemovalLineRec[], shipTo: common.Address | null, ref: string, skus: Map<string, SkuRec>, reason: string | null): Promise<RemovalRec> {
    return this.repo.transaction(async (tx) => {
      await tx.lockSkus(lines.map((l) => l.skuEnrollmentId));
      const balances = await tx.balances(lines.map((l) => l.skuEnrollmentId));
      const free = await this.free(tx, sellerId, balances);
      const short = lines.filter((l) => free(l.skuEnrollmentId, l.fromGroup) < l.quantity);
      if (short.length) {
        throw this.core.error('INSUFFICIENT_STOCK', short.length === 1 ? `Not enough ${short[0]!.fromGroup} units of ${skus.get(short[0]!.skuEnrollmentId)?.sku ?? 'this SKU'}` : `Not enough units for ${short.length} SKUs`, {
          lines: short.map((l) => ({ skuEnrollmentId: l.skuEnrollmentId, requested: l.quantity, available: Math.max(0, free(l.skuEnrollmentId, l.fromGroup)) })),
        });
      }
      return tx.insert('removal_orders', { id: newId(), ref, seller_id: sellerId, kind, state: removalOrderMachine.initial, lines, ship_to: shipTo, tracking: null, reason, fee_amount: null, created_at: this.now(), approved_at: null, completed_at: null });
    });
  }

  /** Offboarding: everything still held (available and unsellable) leaves in removal orders of the chosen kind */
  async removeEverything(sellerId: string, kind: 'return_to_seller' | 'dispose', reason: string, by: By): Promise<RemovalRec[]> {
    const skus = await this.repo.find('sku_enrollments', { seller_id: sellerId });
    if (!skus.length) return [];
    const map = new Map(skus.map((s) => [s.id, s]));
    const balances = await this.repo.balances(skus.map((s) => s.id));
    const free = await this.free(this.repo, sellerId, balances);
    let shipTo: common.Address | null = null;
    if (kind === 'return_to_seller') shipTo = (await this.repo.findOne('inbound_shipments', { seller_id: sellerId }, { orderBy: [['created_at', 'desc']] }))?.ship_from ?? null;
    const out: RemovalRec[] = [];
    for (const group of ['available', 'unsellable'] as const) {
      const lines = skus.map((s) => ({ skuEnrollmentId: s.id, quantity: free(s.id, group), fromGroup: group })).filter((l) => l.quantity > 0);
      if (!lines.length) continue;
      const ref = await this.ctx.refs.next('RM', { digits: 4 });
      try {
        out.push(await this.create(sellerId, kind, lines, shipTo, ref, map, `Leaving the service: ${reason}`));
      } catch (err) {
        this.ctx.log.warn({ err, sellerId, group }, 'fulfillment-service: offboarding removal not created');
      }
    }
    void by;
    return out;
  }

  async cancel(sellerId: string, id: string, by: By): Promise<RemovalOrder> {
    await this.ownRemoval(sellerId, id);
    return (await this.parts.views.removals([await this.transition(id, 'cancel', {}, by)]))[0]!;
  }

  async advance(id: string, body: { action: Action; tracking?: string | null; reason?: string | null }, by: By): Promise<RemovalOrder> {
    const before = await this.ownRemoval(null, id);
    if (body.action === 'ship') {
      if (before.kind === 'dispose') throw new AppError('ILLEGAL_TRANSITION', 'A disposal completes without shipping', { machine: 'Removal order', from: before.state, event: 'ship' });
      if (!body.tracking?.trim()) throw invalid([{ path: 'tracking', message: 'Enter the tracking number' }]);
    }
    if (body.action === 'complete' && before.kind === 'return_to_seller' && before.state === 'processing') {
      throw new AppError('ILLEGAL_TRANSITION', 'Ship the units back to the seller before completing', { machine: 'Removal order', from: before.state, event: 'complete' });
    }
    const after = await this.transition(id, body.action, { tracking: body.tracking ?? null, reason: body.reason ?? null }, by);
    await this.core.audit(
      {
        action: `fulfillment-service.removal.${body.action}`,
        actionLabel: `${ACTION_LABEL[body.action]} a removal order`,
        category: 'inventory',
        target: { type: 'removal_order', id, ref: after.ref, label: `Removal ${after.ref}`, sellerId: after.seller_id, screen: 'ops/inventory' },
        before: { state: before.state },
        after: { state: after.state, tracking: after.tracking, fee: after.fee_amount },
        reason: body.reason?.trim() || null,
        visibleToSeller: true,
      },
      by,
    );
    return (await this.parts.views.removals([after]))[0]!;
  }

  private async transition(id: string, action: Action, o: { tracking?: string | null; reason?: string | null }, by: By): Promise<RemovalRec> {
    const before = (await this.repo.get('removal_orders', id))!;
    removalOrderMachine.next(before.state as State, action);
    const skus = new Map((await this.repo.find('sku_enrollments', { id: before.lines.map((l) => l.skuEnrollmentId) })).map((s) => [s.id, s]));
    const schedule = await this.core.currentSchedule();
    const ref = { kind: 'service_removal' as const, id, label: `Removal ${before.ref}` };
    // inventory first, so a refusal stops the step: approve takes available units out of sale, complete takes the units out of stock
    if (action === 'approve') {
      const balances = await this.repo.balances(before.lines.map((l) => l.skuEnrollmentId));
      const short = before.lines.filter((l) => qty(balances, l.skuEnrollmentId, l.fromGroup) < l.quantity);
      if (short.length) throw this.core.error('INSUFFICIENT_STOCK', 'Some units are no longer in that stock group', { lines: short.map((l) => ({ skuEnrollmentId: l.skuEnrollmentId, requested: l.quantity, available: qty(balances, l.skuEnrollmentId, l.fromGroup) })) });
      const location = await this.core.requireLocation();
      for (const l of before.lines.filter((x) => x.fromGroup === 'available')) {
        await this.core.moveStock({ key: `fs:removal-approve:${id}:${l.skuEnrollmentId}`, sku: skus.get(l.skuEnrollmentId)!, from: 'available', to: 'damaged_held', quantity: l.quantity, reasonCode: 'service_removal_reserved', ref, actor: by.actor }, { strict: true, location });
      }
    }
    if (action === 'complete') {
      const location = await this.core.requireLocation();
      for (const l of before.lines) {
        await this.core.moveStock({ key: `fs:removal-complete:${id}:${l.skuEnrollmentId}`, sku: skus.get(l.skuEnrollmentId)!, from: 'damaged_held', to: null, quantity: l.quantity, reasonCode: 'service_removal_completed', ref, actor: by.actor }, { strict: true, location });
      }
    }
    const result = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('removal_orders', id, { forUpdate: true }))!;
      const state = removalOrderMachine.next(locked.state as State, action);
      const mv = { sellerId: locked.seller_id, reference: locked.ref, actor: by.actor, reason: o.reason?.trim() || null };
      const patch: Partial<RemovalRec> = { state };
      if (action === 'approve') {
        await tx.lockSkus(locked.lines.map((l) => l.skuEnrollmentId));
        const balances = await tx.balances(locked.lines.map((l) => l.skuEnrollmentId));
        const short = locked.lines.filter((l) => qty(balances, l.skuEnrollmentId, l.fromGroup) < l.quantity);
        if (short.length) throw this.core.error('INSUFFICIENT_STOCK', 'Some units are no longer in that stock group', { lines: short.map((l) => ({ skuEnrollmentId: l.skuEnrollmentId, requested: l.quantity, available: qty(balances, l.skuEnrollmentId, l.fromGroup) })) });
        for (const l of locked.lines) await this.core.move(tx, { ...mv, skuEnrollmentId: l.skuEnrollmentId, movement: 'removal_reserved', quantity: l.quantity, from: l.fromGroup, to: 'removal_pending' });
        patch.approved_at = this.now();
      }
      let units = 0;
      if (action === 'complete') {
        let fee = 0;
        for (const l of locked.lines) {
          await this.core.move(tx, { ...mv, skuEnrollmentId: l.skuEnrollmentId, movement: locked.kind === 'dispose' ? 'disposed' : 'removed', quantity: l.quantity, from: 'removal_pending', to: null });
          units += l.quantity;
          const charge = await this.core.accrue(
            tx,
            { sellerId: locked.seller_id, rateType: locked.kind === 'dispose' ? 'disposal_per_unit' : 'removal_per_unit', sizeTier: skus.get(l.skuEnrollmentId)?.size_tier ?? 'any', units: l.quantity, reference: locked.ref, key: `removal:${locked.id}:${l.skuEnrollmentId}` },
            schedule.rates,
          );
          fee += charge?.amount ?? 0;
        }
        patch.completed_at = this.now();
        patch.fee_amount = fee;
      }
      if (action === 'ship') patch.tracking = o.tracking!.trim();
      const row = await tx.update('removal_orders', id, patch);
      return { row, units };
    });
    if (action === 'complete') {
      this.core.publish('fulfillment-service.removal.completed', { removalId: id, sellerId: result.row.seller_id, units: result.units }, by);
      await this.core.notifySeller(result.row.seller_id, 'seller.fulfillment.removal_completed', { removal: { ref: result.row.ref }, units: result.units }, { kind: 'queue', id, ref: result.row.ref, label: 'View removal', screen: 'seller/inventory' }, `fs:removal:${id}`);
    }
    return result.row;
  }

  /** Unsellable units the seller left longer than unsellableDisposalDays: a disposal order (with notice) */
  async disposeAbandoned(): Promise<number> {
    const days = await this.core.setting('unsellableDisposalDays', 60);
    const cutoff = this.core.dayStart(addDays(this.core.today(), -days));
    const skus = await this.repo.find('sku_enrollments', {}, { limit: 20_000 });
    if (!skus.length) return 0;
    const balances = await this.repo.balances(skus.map((s) => s.id));
    const bySeller = new Map<string, SkuRec[]>();
    for (const s of skus) if (qty(balances, s.id, 'unsellable') > 0) bySeller.set(s.seller_id, [...(bySeller.get(s.seller_id) ?? []), s]);
    let created = 0;
    for (const [sellerId, list] of bySeller) {
      const free = await this.free(this.repo, sellerId, balances);
      const lines: RemovalLineRec[] = [];
      for (const s of list) {
        const last = await this.repo.findOne('ownership_ledger', { sku_enrollment_id: s.id, to_group: 'unsellable' }, { orderBy: [['at', 'desc']] });
        if (!last || last.at >= cutoff) continue;
        const n = free(s.id, 'unsellable');
        if (n > 0) lines.push({ skuEnrollmentId: s.id, quantity: n, fromGroup: 'unsellable' });
      }
      if (!lines.length) continue;
      const ref = await this.ctx.refs.next('RM', { digits: 4 });
      try {
        const row = await this.create(sellerId, 'dispose', lines, null, ref, new Map(list.map((s) => [s.id, s])), `Unsellable units left over ${days} days`);
        created += 1;
        const units = lines.reduce((n, l) => n + l.quantity, 0);
        await this.core.notifySeller(sellerId, 'seller.fulfillment.disposal_scheduled', { units, days, removal: { ref: row.ref } }, { kind: 'queue', id: row.id, ref: row.ref, label: 'View removal', screen: 'seller/inventory' }, `fs:dispose:${row.id}`);
      } catch (err) {
        this.ctx.log.warn({ err, sellerId }, 'fulfillment-service: disposal order not created');
      }
    }
    return created;
  }
}
