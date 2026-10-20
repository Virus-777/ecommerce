/**
 * Staff configuration: carriers and their services, platform methods, zones, dispatch targets, free-shipping
 * rules and the holiday and service-interruption calendar (with its preview), plus the admin summary.
 */
import { isIsoDate } from '../../../kernel/lib/dates.js';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type {
  Carrier,
  CarrierInput,
  CarrierService,
  CarrierServiceUpdate,
  DispatchTargets,
  DispatchTargetsInput,
  FreeShippingRule,
  FreeShippingRuleInput,
  MethodInput,
  NoticeInput,
  NoticePreview,
  ServiceNotice,
  ShippingMethod,
  ShippingSummary,
  Zone,
  ZoneInput,
} from '../../../spec/shipping.js';
import { addDays, isTime, arrivesLabel, WEEKDAYS } from '../domain/calendar.js';
import { destinationOf } from '../domain/geo.js';
import { serviceNoticeMachine } from '../domain/state-machines.js';
import { ruleStatus } from '../domain/rates.js';
import { CARRIER_CATALOG } from '../domain/tracking.js';
import type { CarrierRec, NoticeRec, RuleRec, ZoneRec } from '../ports.js';
import { invalid, notFound, type By, type Core } from './core.js';
import type { Estimates, Owner } from './estimates.js';
import type { Views } from './views.js';

type Issue = { path: string; message: string };
const needReason = (reason: string | null | undefined, issues: Issue[]) => {
  if (!reason?.trim()) issues.push({ path: 'reason', message: 'Say why you are making this change' });
};
const transitIssues = (t: { min: number; max: number } | null | undefined, path: string, issues: Issue[]) => {
  if (!t) return;
  if (!(t.min >= 0) || !(t.max >= 0)) issues.push({ path, message: 'Transit days cannot be negative' });
  if (t.min > t.max) issues.push({ path, message: 'Minimum transit is above the maximum' });
};


export class Setup {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly estimates: Estimates,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  /* ---------------------------------------------------------------- carriers */

  async listCarriers(o: { staff: boolean; sellerFacing?: boolean }): Promise<Carrier[]> {
    await this.core.ensureSeeded();
    const [carriers, services] = await Promise.all([this.repo.find('carriers', o.sellerFacing ? { status: 'active' } : {}, { orderBy: [['name', 'asc']] }), this.repo.find('carrier_services', {}, { orderBy: [['name', 'asc']] })]);
    return carriers.map((c) => this.views.carrier(c, services, { staff: o.staff, enabledOnly: o.sellerFacing ?? false }));
  }

  async carrierView(c: CarrierRec): Promise<Carrier> {
    return this.views.carrier(c, await this.repo.find('carrier_services', { carrier_id: c.id }, { orderBy: [['name', 'asc']] }), { staff: true });
  }

  async createCarrier(input: CarrierInput, by: By): Promise<Carrier> {
    await this.core.ensureSeeded();
    const code = input.code.trim().toLowerCase();
    const issues: Issue[] = [];
    if (!/^[a-z0-9_]{2,30}$/.test(code)) issues.push({ path: 'code', message: 'Use a short code such as ups, usps, fedex, ontrac or other' });
    if (!input.name?.trim()) issues.push({ path: 'name', message: 'Name is required' });
    if (issues.length) throw invalid(issues);
    if ((await this.repo.find('carriers', { code })).length) throw new AppError('CONFLICT', `A carrier with code ${code} already exists`, { code });
    const def = CARRIER_CATALOG[code];
    const id = newId();
    const created = await this.repo.transaction(async (tx) => {
      const c = await tx.insert('carriers', {
        id,
        code,
        name: input.name.trim(),
        account_label: input.accountLabel ?? null,
        status: input.status ?? 'active',
        tracking_mode: input.trackingMode,
        credentials_ref: `carrier/${code}`,
        contacts: input.contacts ?? [],
        last_event_at: null,
        on_time_rate_30d: null,
      });
      // carriers bring the services their adapter supports; staff enable or disable them
      for (const s of def?.services ?? [{ code: 'standard', name: `${input.name.trim()} Standard`, transit: { min: 2, max: 7 }, labelSupported: false, trackingPattern: null }]) {
        await tx.insert('carrier_services', { id: newId(), carrier_id: id, code: s.code, name: s.name, transit_min: s.transit.min, transit_max: s.transit.max, enabled: true, label_supported: s.labelSupported, tracking_pattern: s.trackingPattern });
      }
      return c;
    });
    const view = await this.carrierView(created);
    await this.core.audit({ action: 'shipping.carrier.create', actionLabel: 'Added a carrier', category: 'shipping', target: { type: 'carrier', id, ref: code, label: created.name }, before: null, after: view }, by);
    return view;
  }

  async updateCarrier(id: string, body: { name?: string | null; accountLabel?: string | null; status?: 'active' | 'inactive' | null; trackingMode?: 'webhook' | 'polling' | 'manual' | null; contacts?: Carrier['contacts'] | null; reason: string }, by: By): Promise<Carrier> {
    const issues: Issue[] = [];
    needReason(body.reason, issues);
    if (body.name !== undefined && body.name !== null && !body.name.trim()) issues.push({ path: 'name', message: 'Name cannot be empty' });
    if (issues.length) throw invalid(issues);
    const before = await this.repo.get('carriers', id);
    if (!before) throw notFound('Carrier');
    const after = await this.repo.update('carriers', id, {
      ...(body.name ? { name: body.name.trim() } : {}),
      ...(body.accountLabel !== undefined ? { account_label: body.accountLabel } : {}),
      ...(body.status ? { status: body.status } : {}),
      ...(body.trackingMode ? { tracking_mode: body.trackingMode } : {}),
      ...(body.contacts ? { contacts: body.contacts } : {}),
    });
    const view = await this.carrierView(after);
    await this.core.audit({ action: 'shipping.carrier.update', actionLabel: body.status && body.status !== before.status ? (body.status === 'active' ? 'Activated a carrier' : 'Deactivated a carrier') : 'Changed a carrier', category: 'shipping', target: { type: 'carrier', id, ref: after.code, label: after.name }, before, after, reason: body.reason }, by);
    return view;
  }

  async updateCarrierService(carrierId: string, serviceId: string, body: CarrierServiceUpdate, by: By): Promise<CarrierService> {
    const before = await this.repo.get('carrier_services', serviceId);
    if (!before || before.carrier_id !== carrierId) throw notFound('Carrier service');
    const issues: Issue[] = [];
    transitIssues(body.transit, 'transit', issues);
    if (issues.length) throw invalid(issues);
    const after = await this.repo.update('carrier_services', serviceId, {
      ...(body.enabled != null ? { enabled: body.enabled } : {}),
      ...(body.labelSupported != null ? { label_supported: body.labelSupported } : {}),
      ...(body.transit ? { transit_min: body.transit.min, transit_max: body.transit.max } : {}),
    });
    await this.core.audit({ action: 'shipping.carrier_service.update', actionLabel: body.enabled === false ? 'Disabled a carrier service' : body.enabled === true ? 'Enabled a carrier service' : 'Changed a carrier service', category: 'shipping', target: { type: 'carrier_service', id: serviceId, label: after.name }, before, after }, by);
    return this.views.service(after);
  }

  /* ---------------------------------------------------------------- methods */

  async listMethods(activeOnly: boolean): Promise<ShippingMethod[]> {
    await this.core.ensureSeeded();
    return (await this.repo.find('methods', activeOnly ? { active: true } : {}, { orderBy: [['position', 'asc']] })).map((m) => this.views.method(m));
  }

  async updateMethod(id: string, input: MethodInput, by: By): Promise<ShippingMethod> {
    const before = await this.repo.get('methods', id);
    if (!before) throw notFound('Shipping method');
    const issues: Issue[] = [];
    if (!input.name?.trim()) issues.push({ path: 'name', message: 'Name is required' });
    if (!input.customerLabel?.trim()) issues.push({ path: 'customerLabel', message: 'Customer label is required' });
    transitIssues(input.transit, 'transit', issues);
    const services = input.carrierServiceIds.length ? await this.repo.find('carrier_services', { id: input.carrierServiceIds }) : [];
    input.carrierServiceIds.forEach((sid, i) => {
      if (!services.some((s) => s.id === sid)) issues.push({ path: `carrierServiceIds.${i}`, message: 'Unknown carrier service' });
    });
    if (input.code !== before.code && (await this.repo.find('methods', { code: input.code })).length) issues.push({ path: 'code', message: 'Another method already uses this code' });
    if (issues.length) throw invalid(issues);
    const after = await this.repo.update('methods', id, {
      code: input.code,
      name: input.name.trim(),
      customer_label: input.customerLabel.trim(),
      transit_min: input.transit.min,
      transit_max: input.transit.max,
      carrier_service_ids: [...new Set(input.carrierServiceIds)],
      ...(input.active != null ? { active: input.active } : {}),
    });
    await this.core.audit({ action: 'shipping.method.update', actionLabel: 'Changed a shipping method', category: 'shipping', target: { type: 'shipping_method', id, ref: after.code, label: after.name }, before, after }, by);
    return this.views.method(after);
  }

  /* ---------------------------------------------------------------- zones */

  async listZones(): Promise<Zone[]> {
    await this.core.ensureSeeded();
    return (await this.repo.find('zones', {}, { orderBy: [['kind', 'desc'], ['name', 'asc']] })).map((z) => this.views.zone(z));
  }

  private zoneRow(input: ZoneInput): Omit<ZoneRec, 'id'> {
    const issues: Issue[] = [];
    if (!input.name?.trim()) issues.push({ path: 'name', message: 'Name is required' });
    needReason(input.reason, issues);
    const regions = [...new Set(input.regions.map((r) => r.trim().toUpperCase()).filter(Boolean))];
    const prefixes = [...new Set((input.postalPrefixes ?? []).map((p) => p.trim()).filter(Boolean))];
    const kinds = [...new Set(input.addressKinds ?? [])];
    if (prefixes.some((p) => !/^\d{1,5}$/.test(p))) issues.push({ path: 'postalPrefixes', message: 'ZIP prefixes are 1 to 5 digits' });
    if (!regions.length && !prefixes.length && !(input.kind === 'excluded' && kinds.length)) issues.push({ path: 'regions', message: 'Name the states, ZIP prefixes or address kinds this zone covers' });
    if (input.kind === 'served' && kinds.length) issues.push({ path: 'addressKinds', message: 'Address kinds apply to excluded areas only' });
    for (const [code, t] of Object.entries(input.transitByMethod ?? {})) transitIssues(t, `transitByMethod.${code}`, issues);
    if (issues.length) throw invalid(issues);
    return {
      name: input.name.trim(),
      kind: input.kind,
      regions,
      postal_prefixes: prefixes,
      address_kinds: kinds,
      transit_by_method: input.transitByMethod ?? {},
      status: input.status,
      customer_message: input.customerMessage?.trim() || null,
    };
  }

  async createZone(input: ZoneInput, by: By): Promise<Zone> {
    await this.core.ensureSeeded();
    const row = await this.repo.insert('zones', { id: newId(), ...this.zoneRow(input) });
    this.core.publish('shipping.coverage.changed', { zoneId: row.id, status: row.status }, by);
    await this.core.audit({ action: 'shipping.zone.create', actionLabel: row.kind === 'excluded' ? 'Added an excluded area' : 'Added a served zone', category: 'shipping', target: { type: 'zone', id: row.id, label: row.name }, before: null, after: row, reason: input.reason }, by);
    return this.views.zone(row);
  }

  async updateZone(id: string, input: ZoneInput, by: By): Promise<Zone> {
    const before = await this.repo.get('zones', id);
    if (!before) throw notFound('Zone');
    const after = await this.repo.update('zones', id, this.zoneRow(input));
    this.core.publish('shipping.coverage.changed', { zoneId: id, status: after.status }, by);
    const label = before.status !== after.status ? (after.status === 'active' ? 'Enabled a zone' : 'Disabled a zone') : 'Changed a zone';
    await this.core.audit({ action: 'shipping.zone.update', actionLabel: label, category: 'shipping', target: { type: 'zone', id, label: after.name }, before, after, reason: input.reason }, by);
    return this.views.zone(after);
  }

  /* ---------------------------------------------------------------- dispatch targets */

  async getTargets(): Promise<DispatchTargets> {
    const t = await this.core.targets();
    // the allowed handling range is shown read-only from the sellerHandlingRange setting (its only source)
    const [allowedMinDays, allowedMaxDays] = (await this.core.cfg()).sellerHandlingRange;
    return { official: t.official, sellerDefault: { ...t.seller_default, allowedMinDays, allowedMaxDays }, effectiveFrom: t.effective_from.toISOString(), note: 'Example targets. Final service standards are in the seller agreement.' };
  }

  async updateTargets(input: DispatchTargetsInput, by: By): Promise<DispatchTargets> {
    const issues: Issue[] = [];
    needReason(input.reason, issues);
    const o = input.official;
    const s = input.sellerDefault;
    if (!isTime(o.cutoff)) issues.push({ path: 'official.cutoff', message: 'Use HH:mm (market time)' });
    if (!o.businessDays.length) issues.push({ path: 'official.businessDays', message: 'Choose at least one dispatch day' });
    if (o.businessDays.some((d) => !(WEEKDAYS as readonly string[]).includes(d))) issues.push({ path: 'official.businessDays', message: 'Unknown day' });
    const [allowedMinDays, allowedMaxDays] = (await this.core.cfg()).sellerHandlingRange;
    if (!Number.isInteger(s.dispatchWithinBusinessDays) || s.dispatchWithinBusinessDays < allowedMinDays || s.dispatchWithinBusinessDays > allowedMaxDays) issues.push({ path: 'sellerDefault.dispatchWithinBusinessDays', message: `The default must be inside the allowed range (${allowedMinDays} to ${allowedMaxDays} business days, setting sellerHandlingRange)` });
    if (s.validTrackingWithinHours <= 0) issues.push({ path: 'sellerDefault.validTrackingWithinHours', message: 'Must be positive' });
    if (s.onTimeTargetPct < 0 || s.onTimeTargetPct > 100) issues.push({ path: 'sellerDefault.onTimeTargetPct', message: 'A percentage between 0 and 100' });
    const from = new Date(input.effectiveFrom);
    if (Number.isNaN(from.getTime())) issues.push({ path: 'effectiveFrom', message: 'Not a date-time' });
    if (issues.length) throw invalid(issues);
    const before = await this.getTargets();
    const current = await this.core.targets();
    const row = await this.repo.insert('dispatch_targets', {
      id: newId(),
      official: { ...o, onTimeRate30d: o.onTimeRate30d ?? current.official.onTimeRate30d ?? null },
      seller_default: { dispatchWithinBusinessDays: s.dispatchWithinBusinessDays, allowedMinDays, allowedMaxDays, validTrackingWithinHours: s.validTrackingWithinHours, onTimeTargetPct: s.onTimeTargetPct },
      effective_from: from.getTime() < this.core.now().getTime() ? this.core.now() : from,
      set_by: by.actor,
      reason: input.reason.trim(),
    });
    const after = { official: row.official, sellerDefault: { ...row.seller_default, allowedMinDays, allowedMaxDays }, effectiveFrom: row.effective_from.toISOString(), note: before.note };
    await this.core.audit({ action: 'shipping.dispatch_targets.update', actionLabel: 'Changed dispatch targets', category: 'shipping', target: { type: 'dispatch_targets', id: row.id, label: 'Dispatch targets' }, before, after, reason: input.reason }, by);
    return after;
  }

  /* ---------------------------------------------------------------- free-shipping rules */

  async listRules(): Promise<FreeShippingRule[]> {
    const today = this.core.today();
    return (await this.repo.find('free_shipping_rules', {}, { orderBy: [['name', 'asc']] })).map((r) => this.views.rule({ ...r, status: ruleStatus(r, today) }));
  }

  private ruleRow(input: FreeShippingRuleInput): Omit<RuleRec, 'id' | 'status'> {
    const issues: Issue[] = [];
    needReason(input.reason, issues);
    if (!input.name?.trim()) issues.push({ path: 'name', message: 'Name is required' });
    if (!input.methodCode?.trim()) issues.push({ path: 'methodCode', message: 'Choose the method shipped free' });
    if (input.minOrderValue && (input.minOrderValue.amount < 0 || input.minOrderValue.currency !== this.core.currency)) issues.push({ path: 'minOrderValue', message: `A positive amount in ${this.core.currency}` });
    if (input.window && input.window.from > input.window.to) issues.push({ path: 'window', message: 'The window ends before it starts' });
    if (input.scope === 'official_store' && input.fundedBy === 'seller') issues.push({ path: 'fundedBy', message: 'Official Store free shipping is company-funded' });
    if (issues.length) throw invalid(issues);
    return {
      name: input.name.trim(),
      scope: input.scope,
      min_order_value: input.minOrderValue?.amount ?? null,
      method_code: input.methodCode.trim(),
      funded_by: input.fundedBy,
      starts_on: input.window?.from ?? null,
      ends_on: input.window?.to ?? null,
    };
  }

  async createRule(input: FreeShippingRuleInput, by: By): Promise<FreeShippingRule> {
    const base = this.ruleRow(input);
    const today = this.core.today();
    // active false: added switched off (inactive) until switched on
    const row = await this.repo.insert('free_shipping_rules', { id: newId(), ...base, status: ruleStatus({ ...base, status: input.active === false ? 'inactive' : 'active' }, today) });
    await this.core.audit({ action: 'shipping.free_rule.create', actionLabel: 'Added a free-shipping rule', category: 'shipping', target: { type: 'free_shipping_rule', id: row.id, label: row.name }, before: null, after: row, reason: input.reason }, by);
    return this.views.rule(row);
  }

  async updateRule(id: string, input: FreeShippingRuleInput, by: By): Promise<FreeShippingRule> {
    const before = await this.repo.get('free_shipping_rules', id);
    if (!before) throw notFound('Free-shipping rule');
    const base = this.ruleRow(input);
    const today = this.core.today();
    // active switches the rule off (inactive) or back on; omitted keeps its current state
    const on = input.active ?? before.status !== 'inactive';
    const after = await this.repo.update('free_shipping_rules', id, { ...base, status: ruleStatus({ ...base, status: on ? 'active' : 'inactive' }, today) });
    const label = after.status === 'inactive' && before.status !== 'inactive' ? 'Switched off a free-shipping rule' : before.status === 'inactive' && after.status !== 'inactive' ? 'Switched on a free-shipping rule' : after.status === 'ended' ? 'Ended a free-shipping rule' : 'Changed a free-shipping rule';
    await this.core.audit({ action: 'shipping.free_rule.update', actionLabel: label, category: 'shipping', target: { type: 'free_shipping_rule', id, label: after.name }, before, after, reason: input.reason }, by);
    return this.views.rule(after);
  }

  /* ---------------------------------------------------------------- notices */

  async listNotices(q: { status?: string | null; from?: string | null; to?: string | null }, page: PageRequest): Promise<common.Page<ServiceNotice>> {
    const r = await this.repo.page(
      'notices',
      { ...(q.status ? { status: q.status } : {}), ...(q.from ? { to_date: { op: '>=', value: q.from } } : {}), ...(q.to ? { from_date: { op: '<=', value: q.to } } : {}) },
      page,
      { order: { column: 'from_date', direction: 'desc' } },
    );
    return { ...r, items: r.items.map((n) => this.views.notice(n)) };
  }

  private noticeRow(input: NoticeInput): Omit<NoticeRec, 'id' | 'status' | 'created_by' | 'updated_at'> {
    const issues: Issue[] = [];
    if (!input.title?.trim()) issues.push({ path: 'title', message: 'Title is required' });
    if (!isIsoDate(input.from) || !isIsoDate(input.to)) issues.push({ path: 'from', message: 'Dates are YYYY-MM-DD' });
    else if (input.from > input.to) issues.push({ path: 'to', message: 'The notice ends before it starts' });
    if (!input.customerMessage?.trim()) issues.push({ path: 'customerMessage', message: 'Write the message customers see' });
    if (!input.surfaces.length) issues.push({ path: 'surfaces', message: 'Choose where the notice shows' });
    const e = input.effect;
    if (e.extraTransitDays) transitIssues(e.extraTransitDays, 'effect.extraTransitDays', issues);
    if ((input.postalPrefixes ?? []).some((p) => !/^\d{1,5}$/.test(p.trim()))) issues.push({ path: 'postalPrefixes', message: 'ZIP prefixes are 1 to 5 digits' });
    if (input.showFrom && Number.isNaN(new Date(input.showFrom).getTime())) issues.push({ path: 'showFrom', message: 'Not a date-time' });
    if (issues.length) throw invalid(issues);
    return {
      title: input.title.trim(),
      kind: input.kind,
      from_date: input.from,
      to_date: input.to,
      carrier_codes: [...new Set((input.carrierCodes ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean))],
      carrier_service_ids: [...new Set(input.carrierServiceIds ?? [])],
      regions: [...new Set((input.regions ?? []).map((r) => r.trim().toUpperCase()).filter(Boolean))],
      postal_prefixes: [...new Set((input.postalPrefixes ?? []).map((p) => p.trim()).filter(Boolean))],
      zone_ids: [...new Set(input.zoneIds ?? [])],
      seller_scope: input.sellerScope ?? 'all',
      effect: { extraTransitDays: e.extraTransitDays ?? null, noPickup: Boolean(e.noPickup), noDelivery: Boolean(e.noDelivery), noDispatch: Boolean(e.noDispatch) },
      customer_message: input.customerMessage.trim(),
      show_from: input.showFrom ? new Date(input.showFrom) : null,
      surfaces: [...new Set(input.surfaces)],
    };
  }

  async createNotice(input: NoticeInput, by: By): Promise<ServiceNotice> {
    const row = await this.repo.insert('notices', { id: newId(), ...this.noticeRow(input), status: 'draft', created_by: by.actor, updated_at: this.core.now() });
    await this.core.audit({ action: 'shipping.notice.create', actionLabel: 'Drafted a service notice', category: 'shipping', target: { type: 'service_notice', id: row.id, label: row.title }, before: null, after: row }, by);
    return this.views.notice(row);
  }

  async updateNotice(id: string, input: NoticeInput, by: By): Promise<ServiceNotice> {
    const before = await this.repo.get('notices', id);
    if (!before) throw notFound('Notice');
    if (!['draft', 'scheduled', 'live'].includes(before.status)) throw new AppError('ILLEGAL_TRANSITION', `A ${before.status} notice cannot be edited`, { machine: 'Service notice', from: before.status, event: 'edit', allowed: [] });
    const after = await this.repo.update('notices', id, { ...this.noticeRow(input), updated_at: this.core.now() });
    await this.core.audit({ action: 'shipping.notice.update', actionLabel: 'Changed a service notice', category: 'shipping', target: { type: 'service_notice', id, label: after.title }, before, after }, by);
    return this.views.notice(after);
  }

  async publishNotice(id: string, mode: 'now' | 'scheduled', by: By): Promise<ServiceNotice> {
    const before = await this.repo.get('notices', id);
    if (!before) throw notFound('Notice');
    const status = serviceNoticeMachine.next(before.status as never, mode === 'now' ? 'publish_now' : 'schedule');
    const after = await this.repo.update('notices', id, { status, updated_at: this.core.now() });
    this.core.publish('shipping.notice.published', { noticeId: id, status, from: after.from_date, to: after.to_date }, by);
    await this.core.audit({ action: 'shipping.notice.publish', actionLabel: mode === 'now' ? 'Published a service notice' : 'Scheduled a service notice', category: 'shipping', target: { type: 'service_notice', id, label: after.title }, before, after }, by);
    // scheduled notices whose time has come go live at once
    if (status === 'scheduled') await this.noticeSchedule([id]);
    return this.views.notice((await this.repo.get('notices', id))!);
  }

  async withdrawNotice(id: string, reason: string, by: By): Promise<ServiceNotice> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Say why the notice is withdrawn' }]);
    const before = await this.repo.get('notices', id);
    if (!before) throw notFound('Notice');
    const status = serviceNoticeMachine.next(before.status as never, 'withdraw');
    const after = await this.repo.update('notices', id, { status, updated_at: this.core.now() });
    await this.core.audit({ action: 'shipping.notice.withdraw', actionLabel: 'Withdrew a service notice', category: 'shipping', target: { type: 'service_notice', id, label: after.title }, before, after, reason }, by);
    return this.views.notice(after);
  }

  /** Deletes a draft notice (G73); anything published or scheduled is withdrawn instead */
  async deleteNotice(id: string, by: By): Promise<void> {
    const before = await this.repo.get('notices', id);
    if (!before) throw notFound('Notice');
    if (before.status !== 'draft') throw new AppError('ILLEGAL_TRANSITION', `A ${before.status} notice cannot be deleted; withdraw it instead`, { machine: 'Service notice', from: before.status, event: 'delete', allowed: ['withdraw'] });
    await this.repo.removeWhere('notices', { id, status: 'draft' });
    await this.core.audit({ action: 'shipping.notice.delete', actionLabel: 'Deleted a draft service notice', category: 'shipping', target: { type: 'service_notice', id, label: before.title }, before, after: null }, by);
  }

  /** Job: scheduled → live at showFrom (or the from date); live → ended after the to date */
  async noticeSchedule(only?: string[]): Promise<void> {
    const now = this.core.now();
    const today = this.core.today(now);
    const due = await this.repo.find('notices', { status: 'scheduled', ...(only ? { id: only } : {}) }, { limit: 200 });
    for (const n of due) {
      const starts = n.show_from ?? null;
      if ((starts && starts.getTime() <= now.getTime()) || (!starts && n.from_date <= today)) {
        const status = serviceNoticeMachine.next('scheduled', 'go_live');
        if ((await this.repo.updateWhere('notices', { id: n.id, status: 'scheduled' }, { status, updated_at: now })) > 0) {
          this.core.publish('shipping.notice.published', { noticeId: n.id, status, from: n.from_date, to: n.to_date });
        }
      }
    }
    if (only) return;
    for (const n of await this.repo.find('notices', { status: 'live', to_date: { op: '<', value: today } }, { limit: 200 })) {
      await this.repo.updateWhere('notices', { id: n.id, status: 'live' }, { status: serviceNoticeMachine.next('live', 'end'), updated_at: now });
    }
  }

  /** What checkout would show for a postal code with and without the draft notice (nothing saved) */
  async previewNotice(body: { notice: NoticeInput; postalCode: string; surface?: string | null; profileId?: string | null; at?: string | null }): Promise<NoticePreview> {
    const row = this.noticeRow(body.notice);
    const at = body.at ? new Date(body.at) : this.core.now();
    const w = await this.estimates.world(at);
    const surface = (body.surface ?? 'checkout') as NoticePreview['surface'];
    let profile = body.profileId ? await this.estimates.profileAt(body.profileId, at) : undefined;
    if (body.profileId && !profile) throw invalid([{ path: 'profileId', message: 'Unknown or archived shipping profile' }]);
    if (!profile) {
      const official = (await this.repo.find('profiles', { owner_type: 'official', is_default: true }, { orderBy: [['version', 'desc']] }))[0];
      profile = official ? await this.estimates.profileAt(official.lineage_id, at) : undefined;
    }
    if (!profile) throw invalid([{ path: 'profileId', message: 'There is no Official Store profile to preview with' }]);
    const draft: NoticeRec = { id: newId(), ...row, status: 'live', created_by: { kind: 'system' }, updated_at: at };
    const owner: Owner = { ownerType: profile.owner_type as Owner['ownerType'], sellerId: profile.seller_id };
    const settings = await this.estimates.settingsFor(owner, at, w.cfg);
    const closures = await this.estimates.closuresFor(owner);
    const dest = destinationOf({ postalCode: body.postalCode });
    const cov = this.estimates.coverage(w, dest, settings, profile.methods, null);
    const zoneIds = cov.zone ? [cov.zone.id] : [];
    const located = this.estimates.noticeApplies(draft, { dest, zoneIds, ownerType: owner.ownerType });
    const estimates: NoticePreview['estimates'] = [];
    let anyChanged = false;
    if (cov.shippable) {
      for (const pm of profile.methods.filter((m) => m.enabled)) {
        const method = w.methods.find((m) => m.code === pm.methodCode);
        if (!method) continue;
        for (const service of this.estimates.servicesOf(w, pm, method)) {
          const one = { ...profile, methods: [{ ...pm, carrierServiceIds: [service.id] }] };
          const args = { owner, profiles: [one], dest, zone: cov.zone, weightGrams: null, subtotal: null, dispatch: [], settings, closures };
          const [before] = await this.estimates.packageOptions(w, args);
          const [after] = await this.estimates.packageOptions(w, { ...args, extraNotices: [draft] });
          if (!before || !after) continue;
          const changed = before.arrival.from !== after.arrival.from || before.arrival.to !== after.arrival.to;
          anyChanged ||= changed;
          estimates.push({ carrierServiceId: service.id, carrierService: service.name, methodName: method.name, arrivalBefore: before.arrival, arrival: after.arrival, arrivalLabel: arrivesLabel(after.arrival), changed });
        }
      }
    }
    const window = estimates.length ? { from: addDays(this.core.today(at), 0), to: estimates.map((e) => (e as { arrival: common.DateRange }).arrival.to).sort().at(-1)! } : null;
    const overlaps = window ? row.from_date <= window.to && row.to_date >= window.from : row.to_date >= this.core.today(at);
    const applies = located && row.surfaces.includes(surface) && (overlaps || anyChanged);
    // sellers with an active profile that ships here, within the notice's seller scope
    let affectedSellers = 0;
    if (row.seller_scope !== 'official') {
      const sellerIds = [...new Set((await this.repo.find('profiles', { owner_type: 'seller', status: 'active' })).map((p) => p.seller_id).filter((x): x is string => Boolean(x)))];
      for (const sellerId of sellerIds) {
        const s = await this.estimates.settingsFor({ ownerType: 'seller', sellerId }, at, w.cfg);
        if (this.estimates.coverage(w, dest, s).shippable && this.estimates.noticeApplies(draft, { dest, zoneIds, ownerType: 'seller' })) affectedSellers++;
      }
    }
    return {
      postalCode: dest.postalCode || body.postalCode,
      applies,
      surface,
      message: applies ? row.customer_message : null,
      estimates,
      dispatchChanges: Boolean(row.effect.noDispatch) && applies,
      affectedSellers,
    };
  }

  /* ---------------------------------------------------------------- summary */

  async summary(counts: () => Promise<ShippingSummary['exceptionCounts']>): Promise<ShippingSummary> {
    await this.core.ensureSeeded();
    const now = this.core.now();
    const [notices, exceptionCounts, overdue, targets, carriers, manager] = await Promise.all([
      this.estimates.activeNotices(),
      counts(),
      this.repo.count('dispatch_watch', { due_at: { op: '<', value: now } }),
      this.core.targets(now),
      this.repo.count('carriers', { status: 'active' }),
      this.core.soft('access', 'shipping manager', (a) => a.membersOfRole('shipping_manager')),
    ]);
    const lead = manager?.find((m) => !m.away) ?? manager?.[0];
    return {
      liveNotices: notices,
      exceptionCounts,
      overdueDispatch: overdue,
      officialOnTimeRate30d: targets.official.onTimeRate30d ?? null,
      carriersActive: carriers,
      owner: lead ? `${lead.name}, Shipping Manager` : 'Shipping Manager',
    };
  }
}
