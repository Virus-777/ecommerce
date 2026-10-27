/**
 * Requests and bookings: customers request a service (bookable services take a free slot and a staff member), follow
 * its status, cancel it before the cut-off and rate it once completed; staff move it through the Service request
 * state machine. No online payment at this phase: the customer pays the provider.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isIsoDate } from '../../../kernel/lib/dates.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import { pageOf, type Page, type PageRequest } from '../../../kernel/lib/pagination.js';
import type { ProviderStaff, RequestAdmin, RequestDetails, RequestDevice, RequestInput, RequestUpdate, ReviewAdmin, ReviewInput, ServiceRequest, StatusChange } from '../../../spec/services.js';
import { dayLabel, deviceLabel, HANDOVER_MODES, LIMITS, makeRef, OPEN_STATUSES, requestEstimate, requestPriceLabel, shortName, STATUS_EVENT, statusLabel, timeLabel, withRating } from '../domain/rules.js';
import { serviceRequestMachine } from '../domain/state-machines.js';
import type { ProviderRow, RequestRow, ReviewRow, ServiceRow } from '../ports.js';
import { actorKey, invalid, notFound, optionalText, requireText, unique, type By } from './base.js';
import { ServicesCatalog } from './catalog.js';

type Status = RequestRow['status'];
const historyOf = (v: unknown): StatusChange[] => (Array.isArray(v) ? (v as StatusChange[]).filter((h) => h && typeof h.status === 'string' && typeof h.at === 'string') : []);
const detailsOf = (v: unknown): RequestDetails => (v && typeof v === 'object' ? (v as RequestDetails) : {});
const deviceOf = (v: unknown): RequestDevice | null => {
  const d = v as RequestDevice | null;
  return d && typeof d === 'object' && typeof d.id === 'string' ? { id: d.id, label: d.label, imeiLast4: d.imeiLast4, covered: d.covered === true } : null;
};
const staffOfRow = (p: ProviderRow | undefined, id: string | null): ProviderStaff | null => {
  if (!p || !id) return null;
  const s = (Array.isArray(p.staff) ? (p.staff as unknown as ProviderStaff[]) : []).find((x) => x && x.id === id);
  return s ? { id: s.id, name: s.name, role: s.role ?? null } : null;
};

export class ServicesRequests extends ServicesCatalog {
  /* ---------------------------------------------------------------- output */

  private async requestsOut(rows: RequestRow[]): Promise<ServiceRequest[]> {
    if (!rows.length) return [];
    const [services, providers, cats, cutoff] = await Promise.all([this.repo.servicesByIds(unique(rows.map((r) => r.service_id))), this.repo.providersByIds(unique(rows.map((r) => r.provider_id))), this.categoryMap(), this.cutoffMinutes()]);
    const sById = new Map(services.map((s) => [s.id, s]));
    const pById = new Map(providers.map((p) => [p.id, p]));
    const refs = await this.refsOf(providers, services);
    const cards = new Map((await this.providerCards(providers)).map((c) => [c.id, c]));
    const now = this.now();
    return rows.map((r) => {
      const s = sById.get(r.service_id)!;
      const p = pById.get(r.provider_id)!;
      const tz = this.zone(p);
      const beforeCutoff = !r.slot_start || r.slot_start.getTime() - now.getTime() > cutoff * 60_000;
      return {
        id: r.id,
        ref: r.ref,
        area: r.area as ServiceRequest['area'],
        status: r.status as ServiceRequest['status'],
        statusLabel: statusLabel(r.status, p.name),
        service: this.serviceCard(s, p, cats, refs),
        provider: cards.get(p.id)!,
        slotStart: r.slot_start?.toISOString() ?? null,
        slotEnd: r.slot_end?.toISOString() ?? null,
        whenLabel: r.slot_start ? `${dayLabel(r.slot_start, tz)} · ${timeLabel(r.slot_start, tz)}` : null,
        staff: staffOfRow(p, r.staff_id),
        contact: r.contact as unknown as ServiceRequest['contact'],
        details: detailsOf(r.details),
        priceLabel: deviceOf(r.device)?.covered ? '$0 · covered by your warranty' : requestPriceLabel(s.from_price == null ? null : money(s.from_price, s.currency), s.price_unit),
        device: deviceOf(r.device),
        providerNote: r.provider_note,
        canCancel: (r.status === 'requested' || r.status === 'confirmed') && beforeCutoff,
        canReview: r.status === 'completed' && !r.reviewed,
        // customers see when the status changed, not who changed it
        history: historyOf(r.history).map((h) => ({ status: h.status, at: h.at, by: null })),
        createdAt: r.created_at.toISOString(),
      };
    });
  }

  private zone(p: ProviderRow) {
    const tz = (p.hours as { timeZone?: unknown } | null)?.timeZone;
    return typeof tz === 'string' && tz ? tz : this.tz;
  }

  private async cutoffMinutes(): Promise<number> {
    const v = Number(await this.ctx.settings.get('cancelCutoffMinutes'));
    return Number.isFinite(v) && v >= 0 ? v : 120;
  }

  private async requestsAdmin(rows: RequestRow[]): Promise<RequestAdmin[]> {
    if (!rows.length) return [];
    const [services, providers] = await Promise.all([this.repo.servicesByIds(unique(rows.map((r) => r.service_id))), this.repo.providersByIds(unique(rows.map((r) => r.provider_id)))]);
    const sById = new Map(services.map((s) => [s.id, s]));
    const pById = new Map(providers.map((p) => [p.id, p]));
    return rows.map((r) => ({
      id: r.id,
      ref: r.ref,
      area: r.area as RequestAdmin['area'],
      status: r.status as RequestAdmin['status'],
      serviceId: r.service_id,
      serviceTitle: sById.get(r.service_id)?.title ?? '',
      providerId: r.provider_id,
      providerName: pById.get(r.provider_id)?.name ?? '',
      customerId: r.customer_id,
      slotStart: r.slot_start?.toISOString() ?? null,
      slotEnd: r.slot_end?.toISOString() ?? null,
      staff: staffOfRow(pById.get(r.provider_id), r.staff_id),
      device: deviceOf(r.device),
      contact: r.contact as unknown as RequestAdmin['contact'],
      details: detailsOf(r.details),
      providerNote: r.provider_note,
      staffNote: r.staff_note,
      history: historyOf(r.history),
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  /* ---------------------------------------------------------------- customers */

  private checkDetails(d: RequestDetails | null | undefined, s: ServiceRow): RequestDetails {
    const v = d ?? {};
    const handover = v.handover ?? null;
    if (handover) {
      if (!(HANDOVER_MODES as readonly string[]).includes(handover)) throw invalid('details.handover', 'Unknown hand-over option');
      const offered = (Array.isArray(s.handover) ? (s.handover as { mode: string }[]) : []).map((h) => h.mode);
      if (offered.length && !offered.includes(handover)) throw invalid('details.handover', 'This service does not offer that option');
    }
    if (v.preferredDate != null && (!isIsoDate(v.preferredDate) || v.preferredDate < this.today())) throw invalid('details.preferredDate', 'Pick today or a later day');
    return {
      deviceModel: optionalText(v.deviceModel, 'details.deviceModel', LIMITS.short),
      osVersion: optionalText(v.osVersion, 'details.osVersion', 40),
      handover,
      address: optionalText(v.address, 'details.address', LIMITS.address),
      careFor: optionalText(v.careFor, 'details.careFor', 120),
      preferredDate: v.preferredDate ?? null,
      plan: optionalText(v.plan, 'details.plan', LIMITS.short),
      notes: optionalText(v.notes, 'details.notes', LIMITS.notes),
    };
  }

  private async freshRef(tx: typeof this.repo): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const ref = makeRef();
      if (!(await tx.refTaken(ref))) return ref;
    }
    throw new AppError('CONFLICT', 'Could not make a request reference; try again');
  }

  /**
   * `customerId` keys the request (the account id); `deviceOwner` is the customers-module id the registered devices
   * are kept under (the same when the account has no customer record).
   */
  async createRequest(customerId: string, input: RequestInput, by: By, deviceOwner: string = customerId): Promise<ServiceRequest> {
    const contact = { name: requireText(input.contact?.name, 'contact.name', LIMITS.short), phone: requireText(input.contact?.phone, 'contact.phone', 40), email: optionalText(input.contact?.email, 'contact.email', 120) };
    const id = newId();
    await this.repo.transaction(async (tx) => {
      // the service row is locked so two customers can't take the same slot at once
      const s = await tx.getService(input.serviceId, { forUpdate: true });
      const p = s && s.status === 'published' ? await tx.getProvider(s.provider_id, { forUpdate: true }) : undefined;
      if (!s || !p || p.status !== 'published') throw notFound('Service');
      const details = this.checkDetails(input.details, s);
      let device: RequestDevice | null = null;
      if (input.deviceId) {
        if (s.area !== 'post_sale' && s.area !== 'os_install') throw invalid('deviceId', 'Only phone services take a registered device');
        const d = await tx.getDevice(input.deviceId);
        if (!d || d.customer_id !== deviceOwner) throw invalid('deviceId', 'Pick one of your registered devices');
        // $0 only for a covered-by-warranty post-sale service and a verified device whose cover runs today
        const covered = s.covered_by_warranty === true && s.area === 'post_sale' && d.status === 'verified' && d.covered_until != null && d.covered_until >= this.today();
        device = { id: d.id, label: deviceLabel(d.model, d.storage), imeiLast4: d.imei_last4, covered };
        if (!details.deviceModel) details.deviceModel = d.model;
      }
      let slot: { start: Date; end: Date } | null = null;
      let staffId: string | null = null;
      if (s.slot_minutes) {
        if (!input.slotStart) throw this.ctx.error('SLOT_REQUIRED', 'Pick a time for this service.');
        const checked = await this.checkSlot(s, p, input.slotStart, input.staffId);
        slot = checked.slot;
        staffId = checked.staffId;
      }
      const now = this.now();
      // What the price list says one request costs, for the statistics tab; null when the service charges by the
      // hour. Kept at request time so a later price change does not rewrite the past — an estimate either way,
      // since these services are paid at the provider.
      const estimate = device?.covered ? money(0, s.currency) : requestEstimate(s, details.plan);
      await tx.insertRequest({
        id,
        ref: await this.freshRef(tx),
        area: s.area,
        service_id: s.id,
        provider_id: p.id,
        customer_id: customerId,
        slot_start: slot?.start ?? null,
        slot_end: slot?.end ?? null,
        staff_id: staffId,
        device_id: device?.id ?? null,
        device: device as never,
        contact: contact as never,
        details: details as never,
        status: 'requested',
        provider_note: null,
        staff_note: null,
        history: [{ status: 'requested', at: now.toISOString(), by: 'customer' }] as never,
        reviewed: false,
        estimated_amount: estimate?.amount ?? null,
        estimated_currency: estimate?.currency ?? null,
        created_at: now,
        updated_at: now,
      });
    });
    const row = (await this.repo.getRequest(id))!;
    this.ctx.events.publish('services.request.status_changed', { requestId: id, customerId, status: 'requested', ref: row.ref }, by);
    return (await this.requestsOut([row]))[0]!;
  }

  async listMyRequests(customerId: string, q: { area?: string; state?: 'open' | 'past' }, page: PageRequest): Promise<Page<ServiceRequest>> {
    const statuses = q.state === 'open' ? [...OPEN_STATUSES] : q.state === 'past' ? ['completed', 'cancelled', 'declined'] : undefined;
    const res = await this.repo.pageCustomerRequests(customerId, { ...(q.area ? { area: q.area } : {}), ...(statuses ? { statuses } : {}) }, page);
    return { ...res, items: await this.requestsOut(res.items) };
  }

  private async mine(customerId: string, id: string): Promise<RequestRow> {
    const r = await this.repo.getRequest(id);
    if (!r || r.customer_id !== customerId) throw notFound('Request');
    return r;
  }

  async getMyRequest(customerId: string, id: string): Promise<ServiceRequest> {
    return (await this.requestsOut([await this.mine(customerId, id)]))[0]!;
  }

  /** Moves a request and records it in its history; returns the new row */
  private async move(r: RequestRow, event: 'confirm' | 'start' | 'complete' | 'decline' | 'cancel', by: string, extra: Partial<RequestRow> = {}): Promise<RequestRow> {
    const to = serviceRequestMachine.next(r.status as Status as never, event) as string;
    const now = this.now();
    return (await this.repo.updateRequest(r.id, { ...extra, status: to, history: [...historyOf(r.history), { status: to, at: now.toISOString(), by }] as never, updated_at: now }))!;
  }

  async cancelMyRequest(customerId: string, id: string, body: { reason?: string | null }, by: By): Promise<ServiceRequest> {
    const r = await this.mine(customerId, id);
    if (r.status !== 'requested' && r.status !== 'confirmed') throw new AppError('ILLEGAL_TRANSITION', 'This request can no longer be cancelled', { machine: 'Service request', from: r.status, event: 'cancel' });
    const cutoff = await this.cutoffMinutes();
    if (r.slot_start && r.slot_start.getTime() - this.now().getTime() <= cutoff * 60_000) throw this.ctx.error('TOO_LATE_TO_CANCEL', 'It is too close to the booking to cancel in the app; call the provider.');
    const reason = optionalText(body.reason, 'reason', 300);
    const row = await this.move(r, 'cancel', 'customer', reason ? { staff_note: r.staff_note ? `${r.staff_note}\nCustomer: ${reason}` : `Customer: ${reason}` } : {});
    this.ctx.events.publish('services.request.status_changed', { requestId: id, customerId, status: row.status, ref: row.ref }, by);
    return (await this.requestsOut([row]))[0]!;
  }

  async reviewMyRequest(customerId: string, id: string, input: ReviewInput, by: By): Promise<ServiceRequest> {
    const r = await this.mine(customerId, id);
    if (r.status !== 'completed') throw new AppError('ILLEGAL_TRANSITION', 'You can rate a request once it is completed', { machine: 'Service request', from: r.status, event: 'review' });
    if (r.reviewed) throw this.ctx.error('ALREADY_REVIEWED', 'You already rated this.');
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw invalid('rating', 'Rate from 1 to 5 stars');
    const text = optionalText(input.text, 'text', LIMITS.reviewText);
    const customers = this.ctx.tryUse('customers');
    const c = await this.soft('customers.getCustomerByUserId', customers && (() => customers.getCustomerByUserId(customerId)), null);
    await this.repo.transaction(async (tx) => {
      const fresh = await tx.getRequest(id, { forUpdate: true });
      if (!fresh || fresh.reviewed) throw this.ctx.error('ALREADY_REVIEWED', 'You already rated this.');
      await tx.insertReview({ id: newId(), service_id: r.service_id, provider_id: r.provider_id, request_id: r.id, customer_id: customerId, author_name: shortName(c?.displayName), rating: input.rating, text, status: 'visible', created_at: this.now() });
      await tx.updateRequest(id, { reviewed: true, updated_at: this.now() });
      await this.addRating(tx, r.service_id, r.provider_id, input.rating, 1);
    });
    void by;
    return this.getMyRequest(customerId, id);
  }

  /** Keeps the rating totals of a service and its provider in step with their visible reviews */
  private async addRating(tx: typeof this.repo, serviceId: string, providerId: string, rating: number, delta: 1 | -1) {
    const s = await tx.getService(serviceId, { forUpdate: true });
    if (s) await tx.updateService(serviceId, { rating_sum: Math.max(0, s.rating_sum + delta * rating), rating_count: Math.max(0, s.rating_count + delta), rating_stars: withRating(s.rating_stars, rating, delta) as never });
    const p = await tx.getProvider(providerId, { forUpdate: true });
    if (p) await tx.updateProvider(providerId, { rating_sum: Math.max(0, p.rating_sum + delta * rating), rating_count: Math.max(0, p.rating_count + delta), rating_stars: withRating(p.rating_stars, rating, delta) as never });
  }

  /* ---------------------------------------------------------------- staff */

  async listRequestsAdmin(q: { area?: string; status?: string; providerId?: string; q?: string }, page: PageRequest): Promise<Page<RequestAdmin>> {
    const res = await this.repo.pageAdminRequests(q, page);
    return { ...res, items: await this.requestsAdmin(res.items) };
  }

  async getRequestAdmin(id: string): Promise<RequestAdmin> {
    const r = await this.repo.getRequest(id);
    if (!r) throw notFound('Request');
    return (await this.requestsAdmin([r]))[0]!;
  }

  async updateRequest(id: string, input: RequestUpdate, by: By): Promise<RequestAdmin> {
    const before = await this.repo.getRequest(id);
    if (!before) throw notFound('Request');
    const patch: Partial<RequestRow> = {};
    if (input.providerNote !== undefined) patch.provider_note = optionalText(input.providerNote, 'providerNote', 500);
    if (input.staffNote !== undefined) patch.staff_note = optionalText(input.staffNote, 'staffNote', LIMITS.notes);
    if (input.slotStart) {
      if (!(OPEN_STATUSES as readonly string[]).includes(before.status)) throw new AppError('ILLEGAL_TRANSITION', 'Only open bookings can be moved', { machine: 'Service request', from: before.status, event: 'move' });
      const s = await this.repo.getService(before.service_id);
      const p = await this.repo.getProvider(before.provider_id);
      if (!s?.slot_minutes || !p) throw invalid('slotStart', 'This request has no time to move');
      const checked = await this.checkSlot(s, p, input.slotStart, before.staff_id, before.id);
      patch.slot_start = checked.slot.start;
      patch.slot_end = checked.slot.end;
      patch.staff_id = checked.staffId;
    }
    let row: RequestRow;
    const who = actorKey(by.actor);
    if (input.status && input.status !== before.status) row = await this.move(before, STATUS_EVENT[input.status], who, patch);
    else row = (await this.repo.updateRequest(id, { ...patch, updated_at: this.now() }))!;
    if (row.status !== before.status) this.ctx.events.publish('services.request.status_changed', { requestId: id, customerId: row.customer_id, status: row.status, ref: row.ref }, by);
    const out = (await this.requestsAdmin([row]))[0]!;
    await this.audit({ action: 'services.request.update', actionLabel: input.status && input.status !== before.status ? `Marked request ${row.ref} ${row.status.replace('_', ' ')}` : `Changed request ${row.ref}`, target: { type: 'service_request', id, label: row.ref }, before: { status: before.status, slotStart: before.slot_start?.toISOString() ?? null }, after: { status: row.status, slotStart: row.slot_start?.toISOString() ?? null } }, by);
    return out;
  }

  /* ---------------------------------------------------------------- reviews */

  private async reviewsAdmin(rows: ReviewRow[]): Promise<ReviewAdmin[]> {
    const services = new Map((await this.repo.servicesByIds(unique(rows.map((r) => r.service_id)))).map((s) => [s.id, s.title]));
    return rows.map((r) => ({ id: r.id, serviceId: r.service_id, serviceTitle: services.get(r.service_id) ?? '', requestId: r.request_id, rating: r.rating, text: r.text, authorName: r.author_name, status: r.status as ReviewAdmin['status'], createdAt: r.created_at.toISOString() }));
  }

  async listReviewsAdmin(q: { status?: 'visible' | 'hidden'; serviceId?: string }, page: PageRequest): Promise<Page<ReviewAdmin>> {
    const res = await this.repo.pageAdminReviews(q, page);
    return { ...res, items: await this.reviewsAdmin(res.items) };
  }

  async moderateReview(id: string, body: { status: 'visible' | 'hidden' }, by: By): Promise<ReviewAdmin> {
    let changed = false;
    await this.repo.transaction(async (tx) => {
      const r = await tx.getReview(id, { forUpdate: true });
      if (!r) throw notFound('Review');
      if (r.status === body.status) return;
      changed = true;
      await tx.updateReview(id, { status: body.status });
      await this.addRating(tx, r.service_id, r.provider_id, r.rating, body.status === 'visible' ? 1 : -1);
    });
    const r = (await this.repo.getReview(id))!;
    if (changed) await this.audit({ action: 'services.review.moderate', actionLabel: body.status === 'hidden' ? 'Hid a review' : 'Showed a review', target: { type: 'service_review', id, label: r.author_name }, after: { status: body.status } }, by);
    return (await this.reviewsAdmin([r]))[0]!;
  }

  protected pageList = pageOf;
}
