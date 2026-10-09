/**
 * Removal and disposal orders: the seller asks for stock back (or to dispose of it); staff approve (units move
 * to Removal pending and leave the sellable quantity in inventory), process, ship and complete them, with the
 * removal or disposal fee. Offboarding removes everything; unsellable units left too long are disposed.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { RemovalInput, RemovalOrder } from '../../../spec/fulfillment-service.js';
import { removalOrderMachine } from '../domain/state-machines.js';
import { addDays, plural, qty } from '../domain/rules.js';
import type { Balances, FulfillmentServiceRepository, RemovalLineRec, RemovalRec, SkuRec } from '../ports.js';
import { invalid, notFound, Part, type By } from './core.js';

type State = RemovalOrder['state'];
type Action = 'approve' | 'startProcessing' | 'ship' | 'complete' | 'cancel';

const ENROLLED = ['approved', 'active', 'suspended', 'offboarding'];

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
    const row = await this.create(sellerId, input.kind, lines, input.kind === 'return_to_seller' ? (input.shipTo ?? null) : null, ref, skus);
    void by;
    return (await this.parts.views.removals([row]))[0]!;
  }

  private async create(sellerId: string, kind: 'return_to_seller' | 'dispose', lines: RemovalLineRec[], shipTo: common.Address | null, ref: string, skus: Map<string, SkuRec>): Promise<RemovalRec> {
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
      return tx.insert('removal_orders', { id: newId(), ref, seller_id: sellerId, kind, state: removalOrderMachine.initial, lines, ship_to: shipTo, tracking: null, created_at: this.now() });
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
        out.push(await this.create(sellerId, kind, lines, shipTo, ref, map));
      } catch (err) {
        this.ctx.log.warn({ err, sellerId, group }, 'fulfillment-service: offboarding removal not created');
      }
    }
    void reason;
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
    return (await this.parts.views.removals([await this.transition(id, body.action, { tracking: body.tracking ?? null, reason: body.reason ?? null }, by)]))[0]!;
  }

  private async transition(id: string, action: Action, o: { tracking?: string | null; reason?: string | null }, by: By): Promise<RemovalRec> {
    const before = (await this.repo.get('removal_orders', id))!;
    const skus = new Map((await this.repo.find('sku_enrollments', { id: before.lines.map((l) => l.skuEnrollmentId) })).map((s) => [s.id, s]));
    const schedule = await this.core.currentSchedule();
    const result = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('removal_orders', id, { forUpdate: true }))!;
      const state = removalOrderMachine.next(locked.state as State, action);
      const mv = { sellerId: locked.seller_id, reference: locked.ref, actor: by.actor, reason: o.reason?.trim() || null };
      if (action === 'approve') {
        await tx.lockSkus(locked.lines.map((l) => l.skuEnrollmentId));
        const balances = await tx.balances(locked.lines.map((l) => l.skuEnrollmentId));
        const short = locked.lines.filter((l) => qty(balances, l.skuEnrollmentId, l.fromGroup) < l.quantity);
        if (short.length) throw this.core.error('INSUFFICIENT_STOCK', 'Some units are no longer in that stock group', { lines: short.map((l) => ({ skuEnrollmentId: l.skuEnrollmentId, requested: l.quantity, available: qty(balances, l.skuEnrollmentId, l.fromGroup) })) });
        for (const l of locked.lines) await this.core.move(tx, { ...mv, skuEnrollmentId: l.skuEnrollmentId, movement: 'removal_reserved', quantity: l.quantity, from: l.fromGroup, to: 'removal_pending' });
      }
      let units = 0;
      if (action === 'complete') {
        for (const l of locked.lines) {
          await this.core.move(tx, { ...mv, skuEnrollmentId: l.skuEnrollmentId, movement: locked.kind === 'dispose' ? 'disposed' : 'removed', quantity: l.quantity, from: 'removal_pending', to: null });
          units += l.quantity;
          await this.core.accrue(
            tx,
            { sellerId: locked.seller_id, rateType: locked.kind === 'dispose' ? 'disposal_per_unit' : 'removal_per_unit', sizeTier: skus.get(l.skuEnrollmentId)?.size_tier ?? 'any', units: l.quantity, reference: locked.ref, key: `removal:${locked.id}:${l.skuEnrollmentId}` },
            schedule.rates,
          );
        }
      }
      const row = await tx.update('removal_orders', id, { state, ...(action === 'ship' ? { tracking: o.tracking!.trim() } : {}) });
      return { row, units };
    });
    if (action === 'approve') {
      // available units leave the seller's sellable quantity in inventory
      for (const l of result.row.lines.filter((x) => x.fromGroup === 'available')) {
        await this.core.adjustInventory(result.row.seller_id, skus.get(l.skuEnrollmentId)?.inventory_item_id ?? null, -l.quantity, id, by.actor).catch((err) => this.ctx.log.warn({ err, removalId: id }, 'fulfillment-service: removed units not taken out of inventory'));
      }
    }
    if (action === 'complete') this.core.publish('fulfillment-service.removal.completed', { removalId: id, sellerId: result.row.seller_id, units: result.units }, by);
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
        const row = await this.create(sellerId, 'dispose', lines, null, ref, new Map(list.map((s) => [s.id, s])));
        created += 1;
        const units = lines.reduce((n, l) => n + l.quantity, 0);
        await this.core.notifySeller(
          sellerId,
          'seller.platform.change_scheduled',
          { change: { summary: `${plural(units, 'unsellable unit')} left at Marketly's warehouse for over ${days} days will be disposed of (${row.ref}); ask for them back to keep them`, effective: 'when staff approve the disposal' } },
          { kind: 'queue', id: row.id, ref: row.ref, label: 'View removal', screen: 'seller/inventory' },
          `fulfillment-service:dispose:${row.id}`,
        );
      } catch (err) {
        this.ctx.log.warn({ err, sellerId }, 'fulfillment-service: disposal order not created');
      }
    }
    return created;
  }
}
