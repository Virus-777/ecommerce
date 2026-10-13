/**
 * Seller enrollment under the service terms: application (with the terms and fee schedule version accepted),
 * staff decisions with a capacity allowance, activation when the first service receipt is confirmed, suspension,
 * reinstatement, offboarding (stock must leave before close) and the sellers module's suspensions, reinstatements
 * and closures. Every suspend, reinstate, offboard and close tells offers through
 * fulfillment-service.offer.service_changed for each active SKU (decision D5).
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Capacity, Enrollment, EnrollmentInput } from '../../../spec/fulfillment-service.js';
import { serviceEnrollmentMachine } from '../domain/state-machines.js';
import { actorText, plural, SYSTEM } from '../domain/rules.js';
import type { EnrollmentRec, SkuRec } from '../ports.js';
import type { FulfillmentServiceRepository } from '../repository.js';
import { invalid, notFound, Part, SYSTEM_BY, type By } from './core.js';

type State = Enrollment['state'];

/** Allowance granted on approval when the reviewer sets none (example values) */
const DEFAULT_CAPACITY = { maxCubicFeet: 200, maxSkus: 100 };

const LABEL: Record<string, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  information_required: 'Information requested',
  active: 'Active',
  suspended: 'Suspended',
  offboarding: 'Offboarding',
  closed: 'Closed',
};

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
    (input.categories ?? []).forEach((c, i) => {
      if (!isUuid(c)) issues.push({ path: `categories[${i}]`, message: 'Choose categories from the catalog' });
    });
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
    const application = {
      terms_version: input.termsVersion.trim(),
      fee_schedule_version: input.feeScheduleVersion,
      accepted_at: now,
      accepted_by: actor,
      expected_skus: input.expectedSkus,
      expected_monthly_units: input.expectedMonthlyUnits,
      categories: [...new Set(input.categories ?? [])],
      contact_note: input.contactNote?.trim() || null,
    };
    const { row, before } = await this.repo.transaction(async (tx) => {
      const existing = await tx.findOne('enrollments', { seller_id: sellerId }, { forUpdate: true });
      if (existing) {
        const state = serviceEnrollmentMachine.next(existing.state as State, 'resubmit');
        return { row: await tx.update('enrollments', existing.id, { ...application, state }), before: existing };
      }
      const row = await tx.insert('enrollments', {
        id: newId(),
        seller_id: sellerId,
        state: serviceEnrollmentMachine.initial,
        ...application,
        // no storage and no SKU allowance before a reviewer approves one
        max_cubic_feet: '0',
        max_skus: 0,
        reason: null,
        seller_suspension_id: null,
        reviewer_id: null,
        created_at: now,
        decided_at: null,
      });
      return { row, before: null };
    });
    this.core.publish('fulfillment-service.enrollment.submitted', { enrollmentId: row.id, sellerId }, by);
    const names = await this.core.sellerNames([sellerId]);
    await this.core.notifyStaff('seller_manager', 'staff.fulfillment.enrollment_submitted', { seller: { name: names.get(sellerId) ?? 'A seller' }, enrollment: { expectedSkus: row.expected_skus, expectedMonthlyUnits: row.expected_monthly_units } }, { kind: 'queue', id: row.id, ref: names.get(sellerId) ?? null, label: 'Review application', screen: 'admin/sellers' }, `fs:enrollment:${row.id}:submitted`);
    await this.core.raise({
      queueKey: 'fulfillment.enrollments',
      kind: 'application_waiting',
      title: `Fulfilled by Marketly application: ${names.get(sellerId) ?? 'seller'}`,
      summary: `${plural(row.expected_skus, 'SKU')}, about ${plural(row.expected_monthly_units, 'unit')} a month${row.contact_note ? ` · ${row.contact_note}` : ''}`,
      subject: { type: 'application', id: row.id, label: 'Fulfillment service enrollment' },
      sellerId,
      dedupeKey: `fs_enrollment:${row.id}`,
    });
    await this.core.audit({ action: 'fulfillment-service.enrollment.apply', actionLabel: before ? 'Resubmitted the fulfillment service application' : 'Applied for the fulfillment service', category: 'other', target: { type: 'fulfillment_enrollment', id: row.id, label: 'Fulfillment service enrollment', sellerId: row.seller_id, screen: 'admin/sellers' }, before: before ? summary(before) : null, after: summary(row), visibleToSeller: true }, by);
    return this.parts.views.enrollment(row);
  }

  /** Stop using the service: offboarding, with removal orders for the stock still held */
  async offboard(sellerId: string, body: { reason: string; removal: 'return_to_seller' | 'dispose' }, by: By): Promise<Enrollment> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Tell us why you are leaving the service' }]);
    const existing = await this.own(sellerId);
    if (!existing) throw notFound('Enrollment');
    const row = await this.transition(existing.id, 'offboard', reason, by);
    const removals = await this.parts.removals.removeEverything(sellerId, body.removal, reason, by);
    await this.offboardingNotice(row, removals.map((r) => r.ref));
    await this.core.audit({ action: 'fulfillment-service.enrollment.offboard', actionLabel: 'Started leaving the fulfillment service', category: 'other', target: { type: 'fulfillment_enrollment', id: row.id, label: 'Fulfillment service enrollment', sellerId: row.seller_id, screen: 'admin/sellers' }, before: summary(existing), after: { ...summary(row), removals: removals.map((r) => r.ref), removal: body.removal }, reason, visibleToSeller: true }, by);
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
    const before = isUuid(id) ? await this.repo.get('enrollments', id) : undefined;
    if (!before) throw notFound('Enrollment');
    const event = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : 'requestInfo';
    const row = await this.transition(id, event, reason, by, () =>
      body.decision === 'approve' ? { max_cubic_feet: String(body.capacity?.maxCubicFeet ?? DEFAULT_CAPACITY.maxCubicFeet), max_skus: body.capacity?.maxSkus ?? DEFAULT_CAPACITY.maxSkus } : {},
    );
    await this.core.resolveWork(`fs_enrollment:${id}`, `${LABEL[row.state] ?? row.state}: ${reason}`, by.actor);
    await this.core.audit({ action: 'fulfillment-service.enrollment.decide', actionLabel: `${LABEL[row.state] ?? row.state} a fulfillment service application`, category: 'seller_enforcement', target: { type: 'fulfillment_enrollment', id, label: 'Fulfillment service enrollment', sellerId: row.seller_id, screen: 'admin/sellers' }, before: summary(before), after: summary(row), reason, visibleToSeller: true }, by);
    return this.parts.views.enrollment(row);
  }

  async changeStatus(id: string, body: { action: 'suspend' | 'reinstate' | 'offboard' | 'close'; reason: string; affectedActivity?: string | null; appealRoute?: string | null }, by: By): Promise<Enrollment> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Give the reason the seller will see' }]);
    const text = [reason, body.affectedActivity ? `Affects: ${body.affectedActivity}` : null, body.appealRoute ? `Appeal: ${body.appealRoute}` : null].filter(Boolean).join(' · ');
    const before = isUuid(id) ? await this.repo.get('enrollments', id) : undefined;
    if (!before) throw notFound('Enrollment');
    if (body.action === 'close') {
      serviceEnrollmentMachine.next(before.state as State, 'close');
      const units = await this.parts.stock.unitsHeld(before.seller_id);
      if (units > 0) throw this.core.error('STOCK_REMAINING', `${plural(units, 'unit')} of this seller are still in our warehouse; remove or dispose of them first`, { units });
      const open = await this.repo.count('inbound_shipments', { seller_id: before.seller_id, state: ['submitted', 'in_transit', 'arrived', 'receiving'] });
      if (open) throw this.core.error('STOCK_REMAINING', `${plural(open, 'inbound shipment')} still on the way to our warehouse`, { inbound: open });
    }
    // a staff reinstatement also ends a suspension the sellers module started
    const row = await this.transition(id, body.action, text, by, () => (body.action === 'reinstate' ? { seller_suspension_id: null } : {}));
    if (body.action === 'offboard') {
      const refs = (await this.repo.find('removal_orders', { seller_id: row.seller_id, state: ['requested', 'approved', 'processing', 'shipped'] })).map((r) => r.ref);
      await this.offboardingNotice(row, refs);
    }
    await this.core.audit({
      action: `fulfillment-service.enrollment.${body.action}`,
      actionLabel: `${LABEL[row.state] ?? row.state}: fulfillment service enrollment`,
      category: 'seller_enforcement',
      target: { type: 'fulfillment_enrollment', id, label: 'Fulfillment service enrollment', sellerId: row.seller_id, screen: 'admin/sellers' },
      before: summary(before),
      after: summary(row),
      reason: text,
      visibleToSeller: true,
    }, by);
    return this.parts.views.enrollment(row);
  }

  /**
   * One state change with its event (fulfillment-service.enrollment.decided), the seller's notice and, when the
   * service sellability of the SKUs changes, offer.service_changed per active SKU (close: the SKUs end and the item
   * sells from the seller's own location again).
   */
  async transition(id: string, event: string, reason: string | null, by: By, extra: (before: EnrollmentRec) => Partial<EnrollmentRec> = () => ({})): Promise<EnrollmentRec> {
    const { row, closedSkus } = await this.repo.transaction(async (tx) => {
      const before = await tx.get('enrollments', id, { forUpdate: true });
      if (!before) throw notFound('Enrollment');
      const state = serviceEnrollmentMachine.next(before.state as State, event as never);
      const row = await tx.update('enrollments', id, { ...extra(before), state, reason, reviewer_id: by.actor.kind === 'seller' ? before.reviewer_id : actorText(by.actor), decided_at: this.now() });
      let closedSkus: SkuRec[] = [];
      if (event === 'close') {
        closedSkus = await tx.find('sku_enrollments', { seller_id: row.seller_id, state: 'active' });
        await tx.updateWhere('sku_enrollments', { seller_id: row.seller_id, state: 'active' }, { state: 'inactive' });
        await tx.updateWhere('sku_enrollments', { seller_id: row.seller_id, state: ['pending', 'approved'] }, { state: 'rejected', restriction_reason: 'Enrollment closed' });
      }
      return { row, closedSkus };
    });
    this.core.publish('fulfillment-service.enrollment.decided', { enrollmentId: row.id, sellerId: row.seller_id, state: row.state, reason }, by);
    if (event === 'suspend' || event === 'reinstate' || event === 'offboard') {
      const active = await this.repo.find('sku_enrollments', { seller_id: row.seller_id, state: 'active' });
      const reasonCode = event === 'suspend' ? 'enrollment_suspended' : event === 'reinstate' ? 'enrollment_reinstated' : 'enrollment_offboarding';
      this.core.serviceChanged(active, { fulfilledBy: 'marketly_service', sellable: event === 'reinstate', reason: reasonCode }, by);
    }
    if (closedSkus.length) {
      // the items sell from the seller's own location again (decision D4), then offers hears it
      const done: SkuRec[] = [];
      for (const s of closedSkus) if (await this.core.setServiceLocation(s, null, by.actor, { strict: false })) done.push(s);
      this.core.serviceChanged(done, { fulfilledBy: 'seller', sellable: true, reason: 'enrollment_closed' }, by);
    }
    if (by.actor.kind !== 'seller') {
      await this.core.notifySeller(row.seller_id, 'seller.fulfillment.enrollment_decided', { enrollment: { state: row.state, stateLabel: LABEL[row.state] ?? row.state }, reason: reason ?? '' }, { kind: 'queue', id: row.id, label: 'View enrollment', screen: 'seller/inventory' }, `fs:enrollment:${row.id}:${row.state}`);
    }
    return row;
  }

  /** The first confirmed receipt activates an approved enrollment (inside the confirmation transaction; event after) */
  async activateIfApproved(tx: FulfillmentServiceRepository, sellerId: string): Promise<EnrollmentRec | null> {
    const e = await tx.findOne('enrollments', { seller_id: sellerId }, { forUpdate: true });
    if (!e || e.state !== 'approved') return null;
    return tx.update('enrollments', e.id, { state: serviceEnrollmentMachine.next('approved', 'activate'), decided_at: this.now() });
  }

  async activated(row: EnrollmentRec, by: { actor?: common.Actor; requestId?: string }) {
    const reason = 'First inbound stock confirmed at our warehouse';
    this.core.publish('fulfillment-service.enrollment.decided', { enrollmentId: row.id, sellerId: row.seller_id, state: row.state, reason }, by);
    await this.core.notifySeller(row.seller_id, 'seller.fulfillment.enrollment_decided', { enrollment: { state: row.state, stateLabel: LABEL[row.state] ?? row.state }, reason }, { kind: 'queue', id: row.id, label: 'View enrollment', screen: 'seller/inventory' }, `fs:enrollment:${row.id}:${row.state}`);
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

  private async offboardingNotice(row: EnrollmentRec, refs: readonly string[]) {
    await this.core.notifySeller(row.seller_id, 'seller.fulfillment.offboarding', { removal: { refs: refs.length ? refs.join(', ') : 'none yet: request the removal of your stock' } }, { kind: 'queue', id: row.id, label: 'View removals', screen: 'seller/inventory' }, `fs:offboarding:${row.id}`);
  }

  /* ---------------------------------------------------------------- sellers module */

  /** sellers.seller.suspended: no new inbound or service-offer sales; accepted orders and returns go on */
  async onSellerSuspended(e: EventPayload<'sellers.seller.suspended'>): Promise<void> {
    const row = await this.own(e.sellerId);
    if (!row || !serviceEnrollmentMachine.can(row.state as State, 'suspend')) return;
    await this.transition(row.id, 'suspend', `Seller account suspended: ${e.reason}`, SYSTEM_BY, () => ({ seller_suspension_id: isUuid(e.suspensionId) ? e.suspensionId : null })).catch((err) => this.ignoreIllegal(err));
  }

  /** sellers.seller.reinstated: the enrollment that suspension suspended is reinstated; staff suspensions stay */
  async onSellerReinstated(e: EventPayload<'sellers.seller.reinstated'>): Promise<void> {
    if (!e.endedSuspensionId) return;
    const row = await this.own(e.sellerId);
    if (!row || row.state !== 'suspended' || row.seller_suspension_id !== e.endedSuspensionId) return;
    await this.transition(row.id, 'reinstate', 'Seller account reinstated', SYSTEM_BY, () => ({ seller_suspension_id: null })).catch((err) => this.ignoreIllegal(err));
  }

  /** sellers.seller.closed: offboarding starts and the seller is asked to remove the stock */
  async onSellerClosed(e: EventPayload<'sellers.seller.closed'>): Promise<void> {
    const row = await this.own(e.sellerId);
    if (!row) return;
    const by = { actor: e.closedBy ?? SYSTEM };
    if (serviceEnrollmentMachine.can(row.state as State, 'offboard')) {
      const after = await this.transition(row.id, 'offboard', 'Seller account closed', by).catch((err) => this.ignoreIllegal(err));
      if (after && (await this.parts.stock.unitsHeld(e.sellerId)) > 0) await this.offboardingNotice(after, []);
    } else if (serviceEnrollmentMachine.can(row.state as State, 'reject')) {
      await this.transition(row.id, 'reject', 'Seller account closed', by).catch((err) => this.ignoreIllegal(err));
    }
  }

  private ignoreIllegal(err: unknown): undefined {
    if (err instanceof AppError && err.code === 'ILLEGAL_TRANSITION') return undefined;
    throw err;
  }
}

/** What an audit entry shows of an enrollment */
function summary(r: EnrollmentRec) {
  return { state: r.state, termsVersion: r.terms_version, feeScheduleVersion: r.fee_schedule_version, maxCubicFeet: Number(r.max_cubic_feet), maxSkus: r.max_skus, expectedSkus: r.expected_skus, expectedMonthlyUnits: r.expected_monthly_units, reason: r.reason };
}
