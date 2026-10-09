/**
 * Seller enrollment under the service terms: application (with the terms and fee schedule version accepted),
 * staff decisions with a capacity allowance, activation on the first received inbound shipment, suspension,
 * reinstatement, offboarding (stock must leave before close) and the sellers module's suspensions and closures.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Capacity, Enrollment, EnrollmentInput } from '../../../spec/fulfillment-service.js';
import { serviceEnrollmentMachine } from '../domain/state-machines.js';
import { actorText, plural, SYSTEM } from '../domain/rules.js';
import type { EnrollmentRec, FulfillmentServiceRepository } from '../ports.js';
import { invalid, notFound, Part, SYSTEM_BY, type By } from './core.js';

type State = Enrollment['state'];

/** Allowance granted on approval when the reviewer sets none (example values) */
const DEFAULT_CAPACITY = { maxCubicFeet: 200, maxSkus: 100 };

export class EnrollmentPart extends Part {
  async own(sellerId: string): Promise<EnrollmentRec | undefined> {
    return this.repo.findOne('enrollments', { seller_id: sellerId });
  }

  async getOwn(sellerId: string): Promise<Enrollment> {
    const row = await this.own(sellerId);
    if (!row) throw notFound('Enrollment');
    return this.parts.views.enrollment(row);
  }

  /* ---------------------------------------------------------------- seller */

  async apply(sellerId: string, input: EnrollmentInput, by: By): Promise<Enrollment> {
    const issues: { path: string; message: string }[] = [];
    if (!Number.isInteger(input.expectedSkus) || input.expectedSkus < 1) issues.push({ path: 'expectedSkus', message: 'Enter how many SKUs you plan to store, at least 1' });
    if (!Number.isInteger(input.expectedMonthlyUnits) || input.expectedMonthlyUnits < 0) issues.push({ path: 'expectedMonthlyUnits', message: 'Expected monthly units must be 0 or more' });
    if (!input.termsVersion?.trim()) issues.push({ path: 'termsVersion', message: 'Say which service terms you accept' });
    if (issues.length) throw invalid(issues);
    if (!input.acceptTerms) throw this.core.error('TERMS_NOT_ACCEPTED', 'Accept the service terms and the fee schedule to apply');
    // the fee schedule accepted must be the one in force or the one announced
    await this.core.syncSchedules();
    const current = await this.core.currentSchedule();
    const upcoming = await this.repo.find('fee_schedules', { state: 'scheduled', effective_at: { op: '>', value: this.now() } });
    const versions = [current.version, ...upcoming.map((s) => s.version)];
    if (!versions.includes(input.feeScheduleVersion)) {
      throw this.core.error('TERMS_NOT_ACCEPTED', `Accept the current fee schedule (${current.version})`, { feeScheduleVersion: input.feeScheduleVersion, current: current.version });
    }
    const now = this.now();
    const actor = actorText(by.actor);
    const row = await this.repo.transaction(async (tx) => {
      const existing = await tx.findOne('enrollments', { seller_id: sellerId }, { forUpdate: true });
      if (existing) {
        const state = serviceEnrollmentMachine.next(existing.state as State, 'resubmit');
        return tx.update('enrollments', existing.id, { state, terms_version: input.termsVersion.trim(), fee_schedule_version: input.feeScheduleVersion, accepted_at: now, accepted_by: actor, max_skus: input.expectedSkus, reason: input.contactNote?.trim() || null });
      }
      return tx.insert('enrollments', {
        id: newId(),
        seller_id: sellerId,
        state: serviceEnrollmentMachine.initial,
        terms_version: input.termsVersion.trim(),
        fee_schedule_version: input.feeScheduleVersion,
        accepted_at: now,
        accepted_by: actor,
        // the requested SKU count until a reviewer sets the allowance; no storage before approval
        max_cubic_feet: '0',
        max_skus: input.expectedSkus,
        reason: input.contactNote?.trim() || null,
        reviewer_id: null,
        created_at: now,
        decided_at: null,
      });
    });
    this.core.publish('fulfillment-service.enrollment.submitted', { enrollmentId: row.id, sellerId }, by);
    return this.parts.views.enrollment(row);
  }

  /** Stop using the service: offboarding, with removal orders for the stock still held */
  async offboard(sellerId: string, body: { reason: string; removal: 'return_to_seller' | 'dispose' }, by: By): Promise<Enrollment> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Tell us why you are leaving the service' }]);
    const existing = await this.own(sellerId);
    if (!existing) throw notFound('Enrollment');
    const row = await this.transition(existing.id, 'offboard', reason, by);
    await this.parts.removals.removeEverything(sellerId, body.removal, reason, by);
    return this.parts.views.enrollment(row);
  }

  /* ---------------------------------------------------------------- staff */

  async listAdmin(q: { state?: string; q?: string }, page: PageRequest) {
    const where: Record<string, unknown> = {};
    if (q.state) where.state = q.state;
    const term = q.q?.trim();
    if (term) {
      const found = (await this.core.soft('sellers', 'search sellers', (s) => s.searchSellers({ search: term }, { limit: 100 }))) ?? { items: [] };
      const ids = found.items.map((s) => s.id);
      if (/^[0-9a-f-]{36}$/i.test(term)) ids.push(term.toLowerCase());
      where.seller_id = ids;
    }
    const res = await this.repo.page('enrollments', where, page, { order: { column: 'created_at', direction: 'desc' } });
    return { ...res, items: await this.parts.views.enrollments(res.items) };
  }

  async decide(id: string, body: { decision: 'approve' | 'reject' | 'request_info'; reason: string; capacity?: Capacity | null }, by: By): Promise<Enrollment> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Give the reason the seller will see' }]);
    if (body.capacity) {
      const issues: { path: string; message: string }[] = [];
      if (!(Number.isFinite(body.capacity.maxCubicFeet) && body.capacity.maxCubicFeet > 0)) issues.push({ path: 'capacity.maxCubicFeet', message: 'Storage allowance must be above 0 cubic feet' });
      if (!Number.isInteger(body.capacity.maxSkus) || body.capacity.maxSkus < 1) issues.push({ path: 'capacity.maxSkus', message: 'SKU allowance must be at least 1' });
      if (issues.length) throw invalid(issues);
    }
    const event = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : 'requestInfo';
    const row = await this.transition(id, event, reason, by, (before) =>
      body.decision === 'approve' ? { max_cubic_feet: String(body.capacity?.maxCubicFeet ?? DEFAULT_CAPACITY.maxCubicFeet), max_skus: body.capacity?.maxSkus ?? Math.max(before.max_skus, DEFAULT_CAPACITY.maxSkus) } : {},
    );
    return this.parts.views.enrollment(row);
  }

  async changeStatus(id: string, body: { action: 'suspend' | 'reinstate' | 'offboard' | 'close'; reason: string; affectedActivity?: string | null; appealRoute?: string | null }, by: By): Promise<Enrollment> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Give the reason the seller will see' }]);
    const text = [reason, body.affectedActivity ? `Affects: ${body.affectedActivity}` : null, body.appealRoute ? `Appeal: ${body.appealRoute}` : null].filter(Boolean).join(' · ');
    if (body.action === 'close') {
      const before = await this.repo.get('enrollments', id);
      if (!before) throw notFound('Enrollment');
      serviceEnrollmentMachine.next(before.state as State, 'close');
      const units = await this.parts.stock.unitsHeld(before.seller_id);
      if (units > 0) throw this.core.error('STOCK_REMAINING', `${plural(units, 'unit')} of this seller are still in our warehouse; remove or dispose of them first`, { units });
      const open = await this.repo.count('inbound_shipments', { seller_id: before.seller_id, state: ['submitted', 'in_transit', 'arrived', 'receiving'] });
      if (open) throw this.core.error('STOCK_REMAINING', `${plural(open, 'inbound shipment')} still on the way to our warehouse`, { inbound: open });
    }
    const event = body.action;
    const row = await this.transition(id, event, text, by);
    if (body.action === 'close') {
      // the offers stop showing 'Ships from Marketly'
      await this.repo.updateWhere('sku_enrollments', { seller_id: row.seller_id, state: 'active' }, { state: 'inactive' });
      await this.repo.updateWhere('sku_enrollments', { seller_id: row.seller_id, state: ['pending', 'approved'] }, { state: 'rejected', restriction_reason: 'Enrollment closed' });
    }
    return this.parts.views.enrollment(row);
  }

  /** One state change with its event (fulfillment-service.enrollment.decided) */
  async transition(id: string, event: string, reason: string | null, by: By, extra: (before: EnrollmentRec) => Partial<EnrollmentRec> = () => ({})): Promise<EnrollmentRec> {
    const row = await this.repo.transaction(async (tx) => {
      const before = await tx.get('enrollments', id, { forUpdate: true });
      if (!before) throw notFound('Enrollment');
      const state = serviceEnrollmentMachine.next(before.state as State, event as never);
      return tx.update('enrollments', id, { ...extra(before), state, reason, reviewer_id: by.actor.kind === 'seller' ? before.reviewer_id : actorText(by.actor), decided_at: this.now() });
    });
    this.core.publish('fulfillment-service.enrollment.decided', { enrollmentId: row.id, sellerId: row.seller_id, state: row.state, reason }, by);
    return row;
  }

  /** The first received units activate an approved enrollment (inside the receiving transaction; event after) */
  async activateIfApproved(tx: FulfillmentServiceRepository, sellerId: string): Promise<EnrollmentRec | null> {
    const e = await tx.findOne('enrollments', { seller_id: sellerId }, { forUpdate: true });
    if (!e || e.state !== 'approved') return null;
    return tx.update('enrollments', e.id, { state: serviceEnrollmentMachine.next('approved', 'activate'), decided_at: this.now() });
  }

  activated(row: EnrollmentRec, by: { actor?: common.Actor; requestId?: string }) {
    this.core.publish('fulfillment-service.enrollment.decided', { enrollmentId: row.id, sellerId: row.seller_id, state: row.state, reason: 'First inbound shipment received' }, by);
  }

  /** Enrollment that may plan inbound shipments and enroll SKUs */
  async requireOpen(sellerId: string, what: string): Promise<EnrollmentRec> {
    const e = await this.own(sellerId);
    if (!e) throw new AppError('ILLEGAL_TRANSITION', `Apply for storage and shipping by Marketly before you ${what}`, { machine: 'Service enrollment', from: null, event: what });
    if (e.state !== 'approved' && e.state !== 'active') {
      const why = e.state === 'suspended' ? 'Your fulfillment service is suspended' : e.state === 'offboarding' || e.state === 'closed' ? 'You are leaving the fulfillment service' : 'Your fulfillment service application is not approved yet';
      throw new AppError('ILLEGAL_TRANSITION', `${why}: you can't ${what} now`, { machine: 'Service enrollment', from: e.state, event: what });
    }
    return e;
  }

  /* ---------------------------------------------------------------- sellers module */

  /** sellers.seller.suspended: no new inbound or service-offer sales; accepted orders and returns go on */
  async onSellerSuspended(e: EventPayload<'sellers.seller.suspended'>): Promise<void> {
    const row = await this.own(e.sellerId);
    if (!row || !serviceEnrollmentMachine.can(row.state as State, 'suspend')) return;
    await this.transition(row.id, 'suspend', `Seller account suspended: ${e.reason}`, SYSTEM_BY).catch((err) => this.ignoreIllegal(err));
  }

  /** sellers.seller.closed: offboarding starts and the seller is asked to remove the stock */
  async onSellerClosed(e: EventPayload<'sellers.seller.closed'>): Promise<void> {
    const row = await this.own(e.sellerId);
    if (!row) return;
    if (serviceEnrollmentMachine.can(row.state as State, 'offboard')) {
      await this.transition(row.id, 'offboard', 'Seller account closed', { actor: e.closedBy ?? SYSTEM }).catch((err) => this.ignoreIllegal(err));
    } else if (serviceEnrollmentMachine.can(row.state as State, 'reject')) {
      await this.transition(row.id, 'reject', 'Seller account closed', { actor: e.closedBy ?? SYSTEM }).catch((err) => this.ignoreIllegal(err));
      return;
    } else return;
    const units = await this.parts.stock.unitsHeld(e.sellerId);
    if (units > 0) {
      const days = await this.core.setting('unsellableDisposalDays', 60);
      await this.core.notifySeller(
        e.sellerId,
        'seller.platform.change_scheduled',
        { change: { summary: `Your account closed: ask for your ${plural(units, 'unit')} at Marketly's warehouse back or have them disposed of`, effective: `${days} days` } },
        { kind: 'queue', id: row.id, label: 'Request removal', screen: 'seller/inventory' },
        `fulfillment-service:offboarding:${row.id}`,
      );
    }
  }

  private ignoreIllegal(err: unknown) {
    if (err instanceof AppError && err.code === 'ILLEGAL_TRANSITION') return;
    throw err;
  }
}
