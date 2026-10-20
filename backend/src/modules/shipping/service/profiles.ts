/**
 * Shipping profiles (versioned rate sets of the Official Store and each seller), seller shipping settings
 * (coverage, dispatch schedule, label preference, versioned by effective date), closures, what customers see,
 * the storefront shipping section and the record-shipment setup.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { pageOf } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type {
  Closure,
  Coverage,
  CustomerNotice,
  CustomerPreview,
  DeliveryOption,
  DispatchSchedule,
  LabelSupportLine,
  Parcel,
  ProfileInput,
  ProfileMethod,
  SellerShippingSettings,
  SellerShippingSettingsInput,
  SellerShippingSetup,
  ShippingProfile,
  TransitRange,
} from '../../../spec/shipping.js';
import { businessDaysLabel, clockLabel, dayLabel, handlingLabel, isDate, isTime, WEEKDAYS } from '../domain/calendar.js';
import { destinationOf, locationLabel } from '../domain/geo.js';
import { formatShort, methodIssues, priceLabel, ruleStatus } from '../domain/rates.js';
import { shippingProfileVersionMachine } from '../domain/state-machines.js';
import type { ProfileRec } from '../ports.js';
import { invalid, notFound, type By, type Core } from './core.js';
import { ownerKey, type Estimates, type Owner } from './estimates.js';
import type { Views } from './views.js';

type Issue = { path: string; message: string };
type SellerSummary = {
  shipsFrom: string | null;
  coverage: Coverage;
  coverageLabel: string;
  excluded: string[];
  handlingDays: number;
  sameDayCutoff: string | null;
  dispatchLabel: string;
  businessDays: string[];
  closures: Closure[];
  carriers: string[];
  methods: { name: string; transit: TransitRange; priceLabel: string }[];
  freeShippingThreshold: common.Money | null;
  freeShippingLabel: string | null;
  notices: CustomerNotice[];
};

export const APPLY_NOTE = 'New settings apply to orders placed after the effective time. Existing orders keep the delivery terms and prices the customer accepted.';
const EXCLUDED_LABEL: Record<string, string> = { po_box: 'PO boxes', military: 'military addresses', alaska: 'Alaska', hawaii: 'Hawaii', territories: 'US territories' };

export const coverageLabel = (c: Coverage) =>
  c.area === 'all_50' ? 'Ships to all 50 states and DC' : c.area === 'custom' ? 'Ships to selected areas' : 'Ships to the contiguous US and DC';

/** Current version of a lineage for views: active, else the newest scheduled, else the newest of any status */
export function currentOf(versions: readonly ProfileRec[]): ProfileRec | undefined {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  return sorted.find((v) => v.status === 'active') ?? sorted.find((v) => v.status === 'scheduled') ?? sorted.find((v) => v.status === 'archived') ?? sorted[0];
}

export class Profiles {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly estimates: Estimates,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  /* ---------------------------------------------------------------- profiles */

  /**
   * Active offers per profile lineage of an owner, for the profile lists (offers is optional: 0 without it). Each
   * count is exact (offers.countActiveOffersByProfile), never a paged listing with a cap.
   */
  async offersUsing(owner: Owner): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const offers = this.core.ctx.tryUse('offers');
    if (!offers) return counts;
    for (const { current } of await this.lineages(owner, { includeArchived: true })) {
      const n = await this.core.soft('offers', 'countActiveOffersByProfile', (o) => o.countActiveOffersByProfile(current.lineage_id));
      if (n) counts.set(current.lineage_id, n);
    }
    return counts;
  }

  /** Active offers using one profile: an exact count from offers (PROFILE_IN_USE); an offers failure is not taken as 0 */
  async offersUsingProfile(profileId: string): Promise<number> {
    const offers = this.core.ctx.tryUse('offers');
    return offers ? offers.countActiveOffersByProfile(profileId) : 0;
  }

  async lineages(owner: Owner, o: { includeArchived?: boolean } = {}): Promise<{ current: ProfileRec; versions: ProfileRec[] }[]> {
    const rows = await this.repo.find('profiles', { owner_type: owner.ownerType, seller_id: owner.ownerType === 'official' ? null : owner.sellerId }, { orderBy: [['version', 'asc']] });
    const by = new Map<string, ProfileRec[]>();
    for (const r of rows) by.set(r.lineage_id, [...(by.get(r.lineage_id) ?? []), r]);
    const out: { current: ProfileRec; versions: ProfileRec[] }[] = [];
    for (const versions of by.values()) {
      const current = currentOf(versions)!;
      if (!o.includeArchived && versions.some((v) => v.status === 'archived')) continue;
      if (versions.every((v) => v.status === 'draft')) continue;
      out.push({ current, versions });
    }
    return out.sort((a, b) => Number(b.current.is_default) - Number(a.current.is_default) || a.current.name.localeCompare(b.current.name));
  }

  async listProfiles(owner: Owner): Promise<ShippingProfile[]> {
    await this.core.ensureSeeded();
    const [list, using] = await Promise.all([this.lineages(owner), this.offersUsing(owner)]);
    return list.map((l) => this.views.profile(l.current, using.get(l.current.lineage_id) ?? 0));
  }

  async listProfilesAdmin(q: { ownerType?: string | null; sellerId?: string | null; status?: string | null }, page: PageRequest): Promise<common.Page<ShippingProfile>> {
    await this.core.ensureSeeded();
    const rows = await this.repo.find(
      'profiles',
      { ...(q.ownerType ? { owner_type: q.ownerType } : {}), ...(q.sellerId ? { seller_id: q.sellerId } : {}), ...(q.status ? { status: q.status } : {}) },
      { orderBy: [['owner_type', 'asc'], ['name', 'asc'], ['version', 'desc']] },
    );
    let list: ProfileRec[];
    if (q.status) list = rows;
    else {
      const by = new Map<string, ProfileRec[]>();
      for (const r of rows) by.set(r.lineage_id, [...(by.get(r.lineage_id) ?? []), r]);
      list = [...by.values()].map((v) => currentOf(v)!).filter(Boolean);
    }
    const p = pageOf(list, page);
    return { ...p, items: p.items.map((r) => this.views.profile(r)) };
  }

  /** Validates a profile input against the platform methods; returns the stored methods */
  private async methodsOf(input: ProfileInput, currency: string): Promise<ProfileMethod[]> {
    const issues: Issue[] = [];
    if (!input.name?.trim()) issues.push({ path: 'name', message: 'Name is required' });
    if (!input.methods.length) issues.push({ path: 'methods', message: 'Add at least one shipping method' });
    const methods = await this.repo.find('methods', {});
    const services = await this.repo.find('carrier_services', {});
    const seen = new Set<string>();
    const out: ProfileMethod[] = [];
    input.methods.forEach((m, i) => {
      const path = `methods.${i}`;
      const def = methods.find((x) => x.id === m.methodId);
      if (!def) return void issues.push({ path: `${path}.methodId`, message: 'Unknown shipping method' });
      if (!def.active) issues.push({ path: `${path}.methodId`, message: `${def.name} is not offered right now` });
      if (seen.has(def.code)) issues.push({ path: `${path}.methodId`, message: `${def.name} is listed twice` });
      seen.add(def.code);
      issues.push(...methodIssues(m, path, currency));
      const ids = m.carrierServiceIds?.length ? [...new Set(m.carrierServiceIds)] : def.carrier_service_ids;
      ids.forEach((sid, j) => {
        if (!services.some((s) => s.id === sid)) issues.push({ path: `${path}.carrierServiceIds.${j}`, message: 'Unknown carrier service' });
      });
      if (m.freeOver && (m.freeOver.amount < 0 || m.freeOver.currency !== currency)) issues.push({ path: `${path}.freeOver`, message: `A positive amount in ${currency}` });
      out.push({
        methodId: def.id,
        methodCode: def.code,
        name: def.name,
        enabled: m.enabled,
        rateType: m.rateType,
        tiers: m.tiers.map((t) => ({ upToGrams: t.upToGrams ?? null, upToOrderValue: t.upToOrderValue ?? null, price: t.price })),
        minWeightGrams: m.minWeightGrams ?? null,
        maxWeightGrams: m.maxWeightGrams ?? null,
        carrierServiceIds: ids,
        freeOver: m.freeOver ?? null,
      });
    });
    if (input.methods.length && !out.some((m) => m.enabled)) issues.push({ path: 'methods', message: 'Turn on at least one method' });
    if (input.freeShippingThreshold && (input.freeShippingThreshold.amount < 0 || input.freeShippingThreshold.currency !== currency)) issues.push({ path: 'freeShippingThreshold', message: `A positive amount in ${currency}` });
    if (input.freeShippingMethodCode && !out.some((m) => m.methodCode === input.freeShippingMethodCode)) issues.push({ path: 'freeShippingMethodCode', message: 'Choose one of the profile methods' });
    if (input.effectiveFrom && Number.isNaN(new Date(input.effectiveFrom).getTime())) issues.push({ path: 'effectiveFrom', message: 'Not a date-time' });
    if (issues.length) throw invalid(issues);
    return out;
  }

  private effective(input: { effectiveFrom?: string | null }) {
    const now = this.core.now();
    const at = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
    return at.getTime() > now.getTime() ? { at, scheduled: true } : { at: now, scheduled: false };
  }

  async createProfile(owner: Owner, input: ProfileInput, by: By): Promise<ShippingProfile> {
    await this.core.ensureSeeded();
    const currency = this.core.currency;
    const methods = await this.methodsOf(input, currency);
    const eff = this.effective(input);
    const lineage = newId();
    const existing = await this.lineages(owner);
    const isDefault = input.isDefault ?? !existing.length;
    const status = shippingProfileVersionMachine.next('draft', eff.scheduled ? 'schedule' : 'save_now');
    const row = await this.repo.transaction(async (tx) => {
      if (isDefault) await tx.updateWhere('profiles', { owner_type: owner.ownerType, seller_id: owner.sellerId, is_default: true }, { is_default: false });
      return tx.insert('profiles', {
        id: lineage,
        lineage_id: lineage,
        owner_type: owner.ownerType,
        seller_id: owner.sellerId,
        name: input.name.trim(),
        is_default: isDefault,
        methods,
        free_threshold: input.freeShippingThreshold?.amount ?? null,
        free_method_code: input.freeShippingThreshold ? (input.freeShippingMethodCode ?? 'standard') : (input.freeShippingMethodCode ?? null),
        currency,
        version: 1,
        status,
        effective_from: eff.at,
        updated_by: by.actor,
        updated_at: this.core.now(),
      });
    });
    this.core.publish('shipping.profile.changed', { profileId: lineage, sellerId: owner.sellerId, effectiveFrom: eff.at.toISOString() }, by);
    const view = this.views.profile(row);
    await this.core.audit({ action: 'shipping.profile.create', actionLabel: owner.ownerType === 'official' ? 'Created an Official Store shipping profile' : 'Created a shipping profile', category: 'shipping', target: { type: 'shipping_profile', id: lineage, label: row.name }, before: null, after: view }, by);
    return view;
  }

  /** The versions of a lineage the caller owns (another owner's: NOT_FOUND) */
  async owned(profileId: string, owner: Owner | 'any'): Promise<ProfileRec[]> {
    const versions = await this.repo.find('profiles', { lineage_id: profileId }, { orderBy: [['version', 'asc']] });
    if (!versions.length) throw notFound('Shipping profile');
    if (owner !== 'any') {
      const v = versions[0]!;
      if (v.owner_type !== owner.ownerType || (owner.ownerType === 'seller' && v.seller_id !== owner.sellerId)) throw notFound('Shipping profile');
    }
    return versions;
  }

  async updateProfile(profileId: string, owner: Owner, input: ProfileInput, by: By, reason?: string): Promise<ShippingProfile> {
    const versions = await this.owned(profileId, owner);
    const current = currentOf(versions)!;
    if (versions.some((v) => v.status === 'archived')) throw new AppError('ILLEGAL_TRANSITION', 'An archived profile cannot be changed', { machine: 'Shipping profile version', from: 'archived', event: 'save_now', allowed: [] });
    const methods = await this.methodsOf(input, current.currency);
    const eff = this.effective(input);
    const status = shippingProfileVersionMachine.next('draft', eff.scheduled ? 'schedule' : 'save_now');
    const version = Math.max(...versions.map((v) => v.version)) + 1;
    const isDefault = input.isDefault ?? current.is_default;
    const row = await this.repo.transaction(async (tx) => {
      const live = await tx.find('profiles', { lineage_id: profileId }, { forUpdate: true });
      // a newer save replaces a change still waiting for its date
      for (const v of live.filter((x) => x.status === 'scheduled')) await tx.update('profiles', v.id, { status: shippingProfileVersionMachine.next('scheduled', 'cancel') });
      if (!eff.scheduled) for (const v of live.filter((x) => x.status === 'active')) await tx.update('profiles', v.id, { status: shippingProfileVersionMachine.next('active', 'supersede') });
      if (isDefault && !current.is_default) {
        await tx.updateWhere('profiles', { owner_type: owner.ownerType, seller_id: owner.ownerType === 'official' ? null : owner.sellerId, is_default: true }, { is_default: false });
      }
      return tx.insert('profiles', {
        id: newId(),
        lineage_id: profileId,
        owner_type: current.owner_type,
        seller_id: current.seller_id,
        name: input.name.trim(),
        is_default: isDefault,
        methods,
        free_threshold: input.freeShippingThreshold?.amount ?? null,
        free_method_code: input.freeShippingThreshold ? (input.freeShippingMethodCode ?? 'standard') : (input.freeShippingMethodCode ?? null),
        currency: current.currency,
        version,
        status,
        effective_from: eff.at,
        updated_by: by.actor,
        updated_at: this.core.now(),
      });
    });
    this.core.publish('shipping.profile.changed', { profileId, sellerId: current.seller_id, effectiveFrom: eff.at.toISOString() }, by);
    const using = (await this.core.soft('offers', 'countActiveOffersByProfile', (o) => o.countActiveOffersByProfile(profileId))) ?? 0;
    const view = this.views.profile(row, using);
    await this.core.audit(
      {
        action: 'shipping.profile.update',
        actionLabel: eff.scheduled ? `Scheduled new shipping rates from ${dayLabel(this.core.today(eff.at))}` : 'Changed shipping rates',
        category: 'shipping',
        target: { type: 'shipping_profile', id: profileId, label: row.name },
        before: this.views.profile(current, using),
        after: view,
        ...(reason ? { reason } : {}),
      },
      by,
    );
    return view;
  }

  async archiveProfile(profileId: string, owner: Owner, by: By): Promise<ShippingProfile> {
    const versions = await this.owned(profileId, owner);
    const active = versions.find((v) => v.status === 'active');
    const current = currentOf(versions)!;
    const status = shippingProfileVersionMachine.next((active?.status ?? current.status) as never, 'archive');
    const using = await this.offersUsingProfile(profileId);
    if (using > 0) throw this.core.error('PROFILE_IN_USE', `${using} active offer${using === 1 ? ' uses' : 's use'} this profile. Move them to another profile first.`, { offerCount: using });
    const row = await this.repo.transaction(async (tx) => {
      for (const v of versions.filter((x) => x.status === 'scheduled')) await tx.update('profiles', v.id, { status: shippingProfileVersionMachine.next('scheduled', 'cancel') });
      return tx.update('profiles', active!.id, { status, is_default: false, updated_by: by.actor, updated_at: this.core.now() });
    });
    const view = this.views.profile(row, 0);
    await this.core.audit({ action: 'shipping.profile.archive', actionLabel: 'Archived a shipping profile', category: 'shipping', target: { type: 'shipping_profile', id: profileId, label: row.name }, before: this.views.profile(active!, 0), after: view }, by);
    return view;
  }

  /* ---------------------------------------------------------------- seller settings */

  /** Allowed seller handling days: the sellerHandlingRange setting is the only source (decision D-S2) */
  async handlingRange(): Promise<[number, number]> {
    return (await this.core.cfg()).sellerHandlingRange;
  }

  async settingsRows(owner: Owner) {
    return this.repo.find('seller_settings', { owner_type: owner.ownerType, seller_id: owner.ownerType === 'official' ? null : owner.sellerId }, { orderBy: [['effective_from', 'asc']] });
  }

  async getSellerSettings(sellerId: string): Promise<SellerShippingSettings> {
    await this.core.ensureSeeded();
    const owner: Owner = { ownerType: 'seller', sellerId };
    const now = this.core.now();
    const today = this.core.today(now);
    const [settings, rows, closures, profiles, carriers, services] = await Promise.all([
      this.estimates.settingsFor(owner, now),
      this.settingsRows(owner),
      this.estimates.closuresFor(owner),
      this.listProfiles(owner),
      this.repo.find('carriers', { status: 'active' }, { orderBy: [['name', 'asc']] }),
      this.repo.find('carrier_services', { enabled: true }, { orderBy: [['name', 'asc']] }),
    ]);
    const lines: LabelSupportLine[] = carriers.map((c) => {
      const own = services.filter((s) => s.carrier_id === c.id);
      return { carrierName: c.name, services: own.map((s) => s.name), supported: own.some((s) => s.label_supported) };
    });
    const versions = await this.repo.find('profiles', { owner_type: 'seller', seller_id: sellerId }, { orderBy: [['updated_at', 'asc']] });
    const scheduledSettings = rows.find((r) => r.status === 'scheduled');
    const scheduledProfile = versions.filter((v) => v.status === 'scheduled').sort((a, b) => a.effective_from.getTime() - b.effective_from.getTime())[0];
    const pending = [scheduledSettings && { at: scheduledSettings.effective_from, summary: `New coverage and dispatch schedule from ${dayLabel(this.core.today(scheduledSettings.effective_from))}` }, scheduledProfile && { at: scheduledProfile.effective_from, summary: `New rates for ${scheduledProfile.name} from ${dayLabel(this.core.today(scheduledProfile.effective_from))}` }]
      .filter((x): x is { at: Date; summary: string } => Boolean(x))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const history: common.TimelineEvent[] = [
      ...rows.map((r) => ({ at: r.updated_at.toISOString(), label: r.status === 'scheduled' ? 'Coverage and dispatch change scheduled' : 'Coverage and dispatch schedule saved', detail: `${handlingLabel(r.handling_days)} · ${businessDaysLabel(r.business_days)} · order by ${clockLabel(r.same_day_cutoff)}`, actor: r.updated_by })),
      ...versions.map((v) => ({ at: v.updated_at.toISOString(), label: v.version === 1 ? `Profile ${v.name} created` : `Profile ${v.name} changed (version ${v.version})`, detail: v.status === 'scheduled' ? `Takes effect ${dayLabel(this.core.today(v.effective_from))}` : null, actor: v.updated_by })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    const dispatch: DispatchSchedule = {
      handlingDays: settings.handling_days,
      sameDayCutoff: settings.same_day_cutoff,
      businessDays: settings.business_days as DispatchSchedule['businessDays'],
      closures: closures.filter((c) => c.to_date >= today).map((c) => this.views.closure(c)),
    };
    const def = profiles.find((p) => p.isDefault) ?? profiles[0];
    const cfg = await this.core.cfg();
    return {
      shipsFrom: settings.ships_from ?? null,
      coverage: settings.coverage,
      dispatch,
      labels: { buyLabelsInSellerCenter: settings.buy_labels, services: lines, defaultParcel: settings.default_parcel },
      profiles,
      pendingChange: pending[0] ? { effectiveFrom: pending[0].at.toISOString(), summary: pending.map((p) => p.summary).join('; ') } : null,
      customerPreview: def ? await this.preview(owner, { postalCode: cfg.marketDefaultPostalCode, profileId: def.id }) : emptyPreview(),
      history,
      // read-only for the seller (setting sellerHandlingRange, the only source; G40c)
      allowedHandlingDays: { min: cfg.sellerHandlingRange[0], max: cfg.sellerHandlingRange[1] },
      applyNote: APPLY_NOTE,
    };
  }

  async updateSellerSettings(sellerId: string, input: SellerShippingSettingsInput, by: By): Promise<SellerShippingSettings> {
    await this.core.ensureSeeded();
    const owner: Owner = { ownerType: 'seller', sellerId };
    const [min, max] = await this.handlingRange();
    const d = input.dispatch;
    if (!Number.isInteger(d.handlingDays) || d.handlingDays < min || d.handlingDays > max) {
      throw this.core.error('HANDLING_OUT_OF_RANGE', `Handling time must be between ${min} and ${max} business days`, { min, max });
    }
    const issues: Issue[] = [];
    if (!isTime(d.sameDayCutoff)) issues.push({ path: 'dispatch.sameDayCutoff', message: 'Use HH:mm (market time)' });
    if (!d.businessDays.length) issues.push({ path: 'dispatch.businessDays', message: 'Choose at least one dispatch day' });
    if (d.businessDays.some((x) => !(WEEKDAYS as readonly string[]).includes(x))) issues.push({ path: 'dispatch.businessDays', message: 'Unknown day' });
    const c = input.coverage;
    if (c.area === 'custom') {
      if (!c.zoneIds.length) issues.push({ path: 'coverage.zoneIds', message: 'Choose the zones you ship to' });
      const zones = c.zoneIds.length ? await this.repo.find('zones', { id: c.zoneIds }) : [];
      c.zoneIds.forEach((z, i) => {
        if (!zones.some((x) => x.id === z && x.kind === 'served')) issues.push({ path: `coverage.zoneIds.${i}`, message: 'Not a served zone' });
      });
    }
    if (input.effectiveFrom && Number.isNaN(new Date(input.effectiveFrom).getTime())) issues.push({ path: 'effectiveFrom', message: 'Not a date-time' });
    const shipsFrom = input.shipsFrom == null ? undefined : input.shipsFrom.trim();
    if (shipsFrom !== undefined && (!shipsFrom || shipsFrom.length > 80)) issues.push({ path: 'shipsFrom', message: 'Enter the city and state you ship from, e.g. Portland, OR' });
    const parcel = input.defaultParcel ?? undefined;
    if (parcel) {
      for (const k of ['weightGrams', 'lengthCm', 'widthCm', 'heightCm'] as const) {
        const v = parcel[k];
        if (v != null && (!Number.isFinite(v) || v <= 0)) issues.push({ path: `defaultParcel.${k}`, message: 'Enter a positive number' });
      }
      if (parcel.weightGrams == null) issues.push({ path: 'defaultParcel.weightGrams', message: 'Enter the weight' });
    }
    if (issues.length) throw invalid(issues);
    const eff = this.effective(input);
    const before = await this.estimates.settingsFor(owner);
    const now = this.core.now();
    await this.repo.transaction(async (tx) => {
      const rows = await tx.find('seller_settings', { owner_type: 'seller', seller_id: sellerId }, { forUpdate: true });
      // a newer save replaces a change still waiting for its date
      for (const r of rows.filter((x) => x.status === 'scheduled')) await tx.update('seller_settings', r.id, { status: 'superseded' });
      if (!eff.scheduled) for (const r of rows.filter((x) => x.status === 'active')) await tx.update('seller_settings', r.id, { status: 'superseded' });
      await tx.insert('seller_settings', {
        id: newId(),
        owner_type: 'seller',
        seller_id: sellerId,
        coverage: { area: c.area, zoneIds: c.area === 'custom' ? [...new Set(c.zoneIds)] : [], excluded: [...new Set(c.excluded)] },
        handling_days: d.handlingDays,
        same_day_cutoff: d.sameDayCutoff,
        business_days: [...new Set(d.businessDays)],
        buy_labels: input.buyLabelsInSellerCenter,
        status: eff.scheduled ? 'scheduled' : 'active',
        effective_from: eff.at,
        updated_by: by.actor,
        updated_at: now,
        // null in the input keeps the current value
        default_parcel: parcel ?? before.default_parcel,
        ships_from: shipsFrom ?? before.ships_from ?? null,
      });
    });
    this.core.publish('shipping.profile.changed', { profileId: null, sellerId, effectiveFrom: eff.at.toISOString() }, by);
    const view = await this.getSellerSettings(sellerId);
    await this.core.audit(
      {
        action: 'shipping.seller_settings.update',
        actionLabel: eff.scheduled ? `Scheduled shipping settings from ${dayLabel(this.core.today(eff.at))}` : 'Changed shipping settings',
        category: 'shipping',
        target: { type: 'seller_shipping_settings', id: sellerId, label: 'Shipping settings' },
        before: { coverage: before.coverage, handlingDays: before.handling_days, sameDayCutoff: before.same_day_cutoff, businessDays: before.business_days, buyLabels: before.buy_labels, shipsFrom: before.ships_from ?? null, defaultParcel: before.default_parcel },
        after: { coverage: input.coverage, handlingDays: d.handlingDays, sameDayCutoff: d.sameDayCutoff, businessDays: d.businessDays, buyLabels: input.buyLabelsInSellerCenter, shipsFrom: shipsFrom ?? before.ships_from ?? null, defaultParcel: parcel ?? before.default_parcel, effectiveFrom: eff.at.toISOString() },
      },
      by,
    );
    return view;
  }

  async addClosure(sellerId: string, body: { name: string; from: string; to: string }, by: By): Promise<Closure> {
    const issues: Issue[] = [];
    if (!body.name?.trim()) issues.push({ path: 'name', message: 'Name the closure, e.g. Thanksgiving' });
    if (!isDate(body.from) || !isDate(body.to)) issues.push({ path: 'from', message: 'Dates are YYYY-MM-DD' });
    else if (body.from > body.to) issues.push({ path: 'to', message: 'The closure ends before it starts' });
    if (issues.length) throw invalid(issues);
    const row = await this.repo.insert('closures', { id: newId(), owner_type: 'seller', seller_id: sellerId, name: body.name.trim(), from_date: body.from, to_date: body.to });
    this.core.publish('shipping.profile.changed', { profileId: null, sellerId, effectiveFrom: this.core.now().toISOString() }, by);
    return this.views.closure(row);
  }

  async removeClosure(sellerId: string, id: string, by: By): Promise<void> {
    const row = await this.repo.get('closures', id);
    if (!row || row.owner_type !== 'seller' || row.seller_id !== sellerId) throw notFound('Closure');
    await this.repo.removeWhere('closures', { id });
    this.core.publish('shipping.profile.changed', { profileId: null, sellerId, effectiveFrom: this.core.now().toISOString() }, by);
  }

  /* ---------------------------------------------------------------- what customers see */

  /** Customer preview for an offer or profile at a location; useDraft uses versions still waiting for their date */
  async preview(owner: Owner, q: { postalCode: string; offerId?: string | null; profileId?: string | null; useDraft?: boolean | null }): Promise<CustomerPreview> {
    const w = await this.estimates.world();
    let profileId = q.profileId ?? null;
    let dispatch: { businessDays: number; sameDayCutoff: string | null; shipsFrom: string } | null = null;
    let title = 'An item';
    if (q.offerId) {
      const offer = owner.sellerId ? await this.core.soft('offers', 'getOwnOffer', (o) => o.getOwnOffer(owner.sellerId!, q.offerId!)) : undefined;
      if (!offer) throw notFound('Offer');
      profileId = offer.shippingProfileId;
      dispatch = { businessDays: offer.dispatch.businessDays, sameDayCutoff: offer.dispatch.sameDayCutoff ?? null, shipsFrom: offer.dispatch.shipsFrom };
      title = offer.sellerSku ? `Your offer ${offer.sellerSku}` : 'Your offer';
    }
    if (!profileId) profileId = (await this.lineages(owner)).find((l) => l.current.is_default)?.current.lineage_id ?? null;
    if (!profileId) return emptyPreview();
    const versions = await this.owned(profileId, owner);
    const draft = q.useDraft ? versions.filter((v) => v.status === 'scheduled').sort((a, b) => b.version - a.version)[0] : undefined;
    const profile = draft ?? (await this.estimates.profileAt(profileId, w.at));
    if (!profile) throw notFound('Shipping profile');
    let settings = await this.estimates.settingsFor(owner, w.at, w.cfg);
    if (q.useDraft) settings = (await this.settingsRows(owner)).find((r) => r.status === 'scheduled') ?? settings;
    const dest = destinationOf({ postalCode: q.postalCode });
    const cov = this.estimates.coverage(w, dest, settings, profile.methods, null);
    const place = locationLabel(dest) || q.postalCode;
    const example = `${title} to ${place}`;
    if (!cov.shippable) return { example, price: null, shippingLabel: cov.message ?? 'Does not ship to this location', arrivesLabel: '', dispatchLabel: '', cutoffNote: null };
    const options = await this.estimates.packageOptions(w, {
      owner,
      profiles: [profile],
      dest,
      zone: cov.zone,
      weightGrams: null,
      subtotal: null,
      dispatch: [dispatch ?? { businessDays: settings.handling_days, sameDayCutoff: null, shipsFrom: '' }],
      settings,
      closures: await this.estimates.closuresFor(owner),
    });
    const o = options.find((x) => x.isDefault);
    if (!o) return { example, price: null, shippingLabel: 'No delivery method is available here', arrivesLabel: '', dispatchLabel: '', cutoffNote: null };
    return {
      example,
      price: o.price,
      shippingLabel: shippingLabel(o),
      arrivesLabel: o.arrivalLabel,
      dispatchLabel: o.dispatchLabel,
      cutoffNote: settings.same_day_cutoff ? `Order by ${clockLabel(dispatch?.sameDayCutoff ?? settings.same_day_cutoff)} (market time) to count from that business day` : null,
    };
  }

  /** Storefront shipping section per seller (null without an active profile) */
  /**
   * getProfileOwners: owner of each profile, by lineage id or version id (offers checks a seller only uses its own
   * profiles, the Official Store only official ones). Unknown ids map to null. status is the lineage's state now.
   */
  async profileOwners(profileIds: string[]): Promise<Record<string, { ownerType: 'official' | 'seller'; sellerId: string | null; status: string } | null>> {
    const out: Record<string, { ownerType: 'official' | 'seller'; sellerId: string | null; status: string } | null> = {};
    for (const id of profileIds) out[id] = null;
    const ids = [...new Set(profileIds.filter(isUuid))];
    if (!ids.length) return out;
    const direct = await this.repo.find('profiles', { id: ids });
    const lineageOf = new Map<string, string>(direct.map((v) => [v.id, v.lineage_id]));
    const lineageIds = [...new Set([...ids, ...direct.map((v) => v.lineage_id)])];
    const versions = await this.repo.find('profiles', { lineage_id: lineageIds }, { orderBy: [['version', 'asc']] });
    for (const id of ids) {
      const lineage = versions.some((v) => v.lineage_id === id) ? id : lineageOf.get(id);
      const own = versions.filter((v) => v.lineage_id === lineage);
      const current = currentOf(own);
      if (!current) continue;
      out[id] = { ownerType: current.owner_type as 'official' | 'seller', sellerId: current.owner_type === 'official' ? null : current.seller_id, status: own.some((v) => v.status === 'archived') ? 'archived' : current.status };
    }
    return out;
  }

  /**
   * getOfficialFreeShipping: the Official Store's standing free-shipping offer in force now: an active official_store
   * free-shipping rule (lowest minimum first), else the default official profile's threshold.
   */
  async officialFreeShipping(): Promise<{ threshold: common.Money | null; methodCode: string | null; active: boolean; label: string | null }> {
    await this.core.ensureSeeded();
    const today = this.core.today();
    const methods = await this.repo.find('methods', {});
    const nameOf = (code: string) => methods.find((m) => m.code === code)?.name ?? 'Standard';
    const rule = (await this.repo.find('free_shipping_rules', { scope: 'official_store' })).filter((r) => ruleStatus(r, today) === 'active').sort((a, b) => (a.min_order_value ?? 0) - (b.min_order_value ?? 0))[0];
    if (rule) {
      const threshold = rule.min_order_value != null ? money(rule.min_order_value, this.core.currency) : null;
      return { threshold, methodCode: rule.method_code, active: true, label: threshold ? `Free ${nameOf(rule.method_code)} shipping on Official Store orders over ${formatShort(threshold)}` : `Free ${nameOf(rule.method_code)} shipping on every Official Store order` };
    }
    const official = await this.repo.find('profiles', { owner_type: 'official', status: 'active' });
    const p = official.find((x) => x.is_default) ?? official.sort((a, b) => a.name.localeCompare(b.name))[0];
    if (p && p.free_threshold != null) {
      const threshold = money(p.free_threshold, p.currency);
      const code = p.free_method_code ?? 'standard';
      return { threshold, methodCode: code, active: true, label: `Free ${nameOf(code)} shipping on Official Store orders over ${formatShort(threshold)}` };
    }
    return { threshold: null, methodCode: null, active: false, label: null };
  }

  /**
   * getOfficialDefaultProfile: the Official Store's default active profile (its lineage id, what offers reference) with
   * the Official dispatch settings in force: handling days and the same-day cutoff. null when no active profile exists.
   */
  async officialDefaultProfile(): Promise<{ profileId: string; handlingDays: number; sameDayCutoff: string | null } | null> {
    await this.core.ensureSeeded();
    const official: Owner = { ownerType: 'official', sellerId: null };
    const active = (await this.lineages(official)).filter((l) => l.current.status === 'active');
    // lineages are sorted default first
    const p = active[0]?.current;
    if (!p) return null;
    const w = await this.estimates.world();
    const settings = await this.estimates.settingsFor(official, w.at, w.cfg);
    const cutoff = w.targets.official.cutoff || settings.same_day_cutoff || w.cfg.officialCutoff;
    return { profileId: p.lineage_id, handlingDays: settings.handling_days, sameDayCutoff: cutoff || null };
  }

  async summaries(sellerIds: string[]): Promise<Record<string, SellerSummary | null>> {
    const out: Record<string, SellerSummary | null> = {};
    const ids = [...new Set(sellerIds)];
    if (!ids.length) return out;
    const w = await this.estimates.world();
    const owners = ids.map((sellerId): Owner => ({ ownerType: 'seller', sellerId }));
    // ships from: each seller's own settings, one query for the whole batch (never recent shipments, which one busy seller crowds out)
    const [profiles, active, settingsOf, closuresOf] = await Promise.all([
      this.repo.find('profiles', { owner_type: 'seller', seller_id: ids, status: 'active' }),
      this.repo.find('seller_settings', { owner_type: 'seller', seller_id: ids, status: 'active' }),
      this.estimates.settingsForOwners(owners, w.at, w.cfg),
      this.estimates.closuresForOwners(owners),
    ]);
    const until = this.estimates.addDays(w.today, 60);
    for (const sellerId of ids) {
      const own = profiles.filter((p) => p.seller_id === sellerId);
      const p = own.find((x) => x.is_default) ?? own.sort((a, b) => a.name.localeCompare(b.name))[0];
      if (!p) {
        out[sellerId] = null;
        continue;
      }
      const key = ownerKey({ ownerType: 'seller', sellerId });
      const settings = settingsOf.get(key)!;
      const closures = closuresOf.get(key)!.filter((c) => c.to_date >= w.today && c.from_date <= until);
      const methods = p.methods.filter((m) => m.enabled);
      const carrierNames = new Set<string>();
      for (const m of methods) {
        const def = w.methods.find((x) => x.id === m.methodId || x.code === m.methodCode);
        if (!def) continue;
        for (const s of this.estimates.servicesOf(w, m, def)) carrierNames.add(w.carrierOfService.get(s.id)!.name);
      }
      const threshold = p.free_threshold != null ? money(p.free_threshold, p.currency) : null;
      const dispatchLabel = `${handlingLabel(settings.handling_days)} · order by ${clockLabel(settings.same_day_cutoff)} PT to count from that day`;
      out[sellerId] = {
        shipsFrom: active.find((s) => s.seller_id === sellerId)?.ships_from || null,
        coverage: settings.coverage,
        coverageLabel: coverageLabel(settings.coverage),
        excluded: settings.coverage.excluded.map((e) => EXCLUDED_LABEL[e] ?? e),
        handlingDays: settings.handling_days,
        sameDayCutoff: settings.same_day_cutoff || null,
        dispatchLabel,
        businessDays: settings.business_days,
        closures: closures.map((c) => this.views.closure(c)),
        carriers: [...carrierNames].sort(),
        methods: methods.map((m) => {
          const def = w.methods.find((x) => x.id === m.methodId || x.code === m.methodCode);
          return { name: m.name, transit: def ? this.estimates.transitFor(def, null) : { min: 3, max: 6 }, priceLabel: priceLabel(m, p.free_method_code === m.methodCode ? threshold : null) };
        }),
        freeShippingThreshold: threshold,
        freeShippingLabel: threshold ? `Free ${w.methods.find((m) => m.code === (p.free_method_code ?? 'standard'))?.name ?? 'Standard'} shipping on orders over ${formatShort(threshold)} from this seller` : null,
        notices: await this.estimates.activeNotices(undefined, [...new Set(methods.flatMap((m) => m.carrierServiceIds.map((id) => w.carrierOfService.get(id)?.code).filter((x): x is string => Boolean(x))))], 'product', w),
      };
    }
    return out;
  }

  async hasCoverage(sellerId: string): Promise<boolean> {
    const [profiles, settings] = await Promise.all([
      this.repo.count('profiles', { owner_type: 'seller', seller_id: sellerId, status: 'active' }),
      this.repo.count('seller_settings', { owner_type: 'seller', seller_id: sellerId, status: 'active' }),
    ]);
    return profiles > 0 && settings > 0;
  }

  /** Carriers and services for the record-shipment and buy-label forms */
  async setup(sellerId: string): Promise<SellerShippingSetup> {
    await this.core.ensureSeeded();
    const owner: Owner = { ownerType: 'seller', sellerId };
    const [settings, carriers, services] = await Promise.all([
      this.estimates.settingsFor(owner),
      this.repo.find('carriers', { status: 'active' }, { orderBy: [['name', 'asc']] }),
      this.repo.find('carrier_services', { enabled: true }, { orderBy: [['name', 'asc']] }),
    ]);
    const list = carriers.map((c) => this.views.carrier(c, services, { staff: false, enabledOnly: true }));
    const labelsOk = services.some((s) => s.label_supported && carriers.some((c) => c.id === s.carrier_id));
    const p = settings.default_parcel;
    return {
      carriers: list,
      labelPurchaseAvailable: settings.buy_labels && labelsOk,
      labelUnavailableReason: !settings.buy_labels ? 'Turn on Buy labels in Shipping settings' : !labelsOk ? 'No carrier service supports labels right now; enter tracking manually' : null,
      defaultParcel: p,
      defaultParcelLabel: p ? parcelLabel(p) : null,
      dispatchLabel: `${handlingLabel(settings.handling_days)} · order by ${clockLabel(settings.same_day_cutoff)} PT to count from that day`,
    };
  }

  /** Remembers the package of a label purchase as the seller's default when none is saved */
  async rememberParcel(sellerId: string, parcel: Parcel) {
    const rows = await this.repo.find('seller_settings', { owner_type: 'seller', seller_id: sellerId, status: 'active' }, { limit: 1 });
    if (rows[0] && !rows[0].default_parcel) await this.repo.update('seller_settings', rows[0].id, { default_parcel: parcel });
  }

  /* ---------------------------------------------------------------- job */

  /** Activates scheduled profile and settings versions whose time has come and supersedes the previous ones */
  async activateVersions(): Promise<void> {
    const now = this.core.now();
    const due = await this.repo.find('profiles', { status: 'scheduled', effective_from: { op: '<=', value: now } }, { orderBy: [['effective_from', 'asc']], limit: 200 });
    for (const v of due) {
      await this.repo.transaction(async (tx) => {
        const fresh = await tx.get('profiles', v.id, { forUpdate: true });
        if (fresh?.status !== 'scheduled') return;
        for (const a of await tx.find('profiles', { lineage_id: v.lineage_id, status: 'active' })) await tx.update('profiles', a.id, { status: shippingProfileVersionMachine.next('active', 'supersede') });
        await tx.update('profiles', v.id, { status: shippingProfileVersionMachine.next('scheduled', 'take_effect') });
      });
    }
    const settings = await this.repo.find('seller_settings', { status: 'scheduled', effective_from: { op: '<=', value: now } }, { orderBy: [['effective_from', 'asc']], limit: 200 });
    for (const s of settings) {
      await this.repo.transaction(async (tx) => {
        const fresh = await tx.get('seller_settings', s.id, { forUpdate: true });
        if (fresh?.status !== 'scheduled') return;
        await tx.updateWhere('seller_settings', { owner_type: s.owner_type, seller_id: s.seller_id, status: 'active' }, { status: 'superseded' });
        await tx.update('seller_settings', s.id, { status: 'active' });
      });
    }
  }
}

export function shippingLabel(o: Pick<DeliveryOption, 'free' | 'price' | 'methodName' | 'carrierService' | 'freeReason'>): string {
  const via = o.carrierService ? ` · ${o.carrierService}` : '';
  return o.free ? `Free ${o.methodName} shipping${via}` : `${formatShort(o.price)} ${o.methodName} shipping${via}`;
}

export function parcelLabel(p: Parcel): string {
  const dims = p.lengthCm && p.widthCm && p.heightCm ? `${p.lengthCm} × ${p.widthCm} × ${p.heightCm} cm · ` : '';
  const size = p.lengthCm && p.widthCm && p.heightCm ? (p.lengthCm * p.widthCm * p.heightCm <= 6000 ? 'Small box' : p.lengthCm * p.widthCm * p.heightCm <= 20000 ? 'Medium box' : 'Large box') : 'Package';
  return `${size} · ${dims}${(p.weightGrams / 1000).toFixed(1)} kg`;
}

const emptyPreview = (): CustomerPreview => ({ example: 'Add a shipping profile to see what customers see', price: null, shippingLabel: '', arrivesLabel: '', dispatchLabel: '', cutoffNote: null });
