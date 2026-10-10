/**
 * The estimate engine: ships-to checks, prices per method, dispatch dates and arrival ranges for a location.
 * arrival = dispatch date (acceptance + handling business days, same-day cutoff, business days, closures, notices
 * with noDispatch) + carrier transit for the destination zone (zone transit by method, extra days from live notices,
 * no-pickup and no-delivery days). Quotes use the profile version in force at quote time.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { money } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { CoverageCheck, CustomerNotice, DeliveryOption, DeliveryQuote, DispatchInput, PackageQuote, PackageQuoteInput, Parcel, ProfileMethod } from '../../../spec/shipping.js';
import { addDays, arrivalRange, arrivesLabel, isTime, MON_FRI, planDispatch, shipsLabel, type DayRules } from '../domain/calendar.js';
import { addressKindOf, CONTIGUOUS_48_DC, destinationOf, TERRITORIES, zoneMatches, type AddressKind, type Destination } from '../domain/geo.js';
import { fitsWeight, freeOutcome, methodPrice, ruleStatus } from '../domain/rates.js';
import type { CarrierRec, ClosureRec, MethodRec, NoticeRec, ProfileRec, RuleRec, ServiceRec, SettingsRec, TargetsRec, ZoneRec } from '../ports.js';
import { DEFAULT_CUTOFF, notFound, SYSTEM, type Cfg, type Core } from './core.js';

export const DEFAULT_WEIGHT_GRAMS = 1000;
const QUOTABLE = ['active', 'scheduled', 'superseded'];

export interface World {
  at: Date;
  today: string;
  cfg: Cfg;
  carriers: CarrierRec[];
  services: Map<string, ServiceRec>;
  carrierOfService: Map<string, CarrierRec>;
  methods: MethodRec[];
  zones: ZoneRec[];
  rules: RuleRec[];
  /** Live notices */
  notices: NoticeRec[];
  marketClosed: Set<string>;
  targets: TargetsRec;
}

export interface Owner {
  ownerType: 'official' | 'seller';
  sellerId: string | null;
}

export interface CoverageResult {
  shippable: boolean;
  reason: CoverageCheck['reason'] | null;
  message: string | null;
  zone: ZoneRec | null;
}

interface OptionDraft {
  option: Omit<DeliveryOption, 'isDefault'>;
  sortPrice: number;
}

const encodeOptionId = (o: { v: string[]; m: string; s: string[] }) => Buffer.from(JSON.stringify(o)).toString('base64url');

export class Estimates {
  constructor(private readonly core: Core) {}

  /* ---------------------------------------------------------------- loading */

  async world(at: Date = this.core.now()): Promise<World> {
    const repo = this.core.repo;
    await this.core.ensureSeeded();
    const cfg = await this.core.cfg();
    const [carriers, services, methods, zones, rules, notices, marketClosed, targets] = await Promise.all([
      repo.find('carriers', {}),
      repo.find('carrier_services', {}),
      repo.find('methods', {}, { orderBy: [['position', 'asc']] }),
      repo.find('zones', { status: 'active' }),
      repo.find('free_shipping_rules', { status: { op: '<>', value: 'inactive' } }),
      repo.find('notices', { status: 'live' }),
      this.core.marketClosedDays(),
      this.core.targets(at, cfg),
    ]);
    const byId = new Map(carriers.map((c) => [c.id, c]));
    return {
      at,
      today: this.core.today(at),
      cfg,
      carriers,
      services: new Map(services.map((s) => [s.id, s])),
      carrierOfService: new Map(services.flatMap((s) => (byId.get(s.carrier_id) ? [[s.id, byId.get(s.carrier_id)!] as const] : []))),
      methods,
      zones,
      rules: rules.map((r) => ({ ...r, status: ruleStatus(r, this.core.today(at)) })),
      notices,
      marketClosed,
      targets,
    };
  }

  /** The profile version in force at a time (archived or unknown: undefined) */
  async profileAt(profileId: string, at: Date = this.core.now()): Promise<ProfileRec | undefined> {
    const versions = await this.core.repo.find('profiles', { lineage_id: profileId }, { orderBy: [['effective_from', 'desc'], ['version', 'desc']] });
    if (!versions.length || versions.some((v) => v.status === 'archived')) return undefined;
    return versions.find((v) => QUOTABLE.includes(v.status) && v.effective_from.getTime() <= at.getTime());
  }

  /** Seller (or Official Store) settings in force, else the defaults a seller gets before saving any */
  async settingsFor(owner: Owner, at: Date = this.core.now(), cfg?: Cfg): Promise<SettingsRec> {
    const rows = await this.core.repo.find(
      'seller_settings',
      { owner_type: owner.ownerType, seller_id: owner.ownerType === 'official' ? null : owner.sellerId, status: ['active', 'scheduled', 'superseded'], effective_from: { op: '<=', value: at } },
      { orderBy: [['effective_from', 'desc']], limit: 1 },
    );
    if (rows[0]) return rows[0];
    const c = cfg ?? (await this.core.cfg());
    return {
      id: '00000000-0000-7000-8000-000000000000',
      owner_type: owner.ownerType,
      seller_id: owner.sellerId,
      coverage: { area: 'contiguous_48_dc', zoneIds: [], excluded: ['po_box', 'military'] },
      handling_days: owner.ownerType === 'official' ? 0 : c.defaultSellerHandlingDays,
      same_day_cutoff: owner.ownerType === 'official' ? c.officialCutoff : DEFAULT_CUTOFF,
      business_days: [...MON_FRI],
      buy_labels: false,
      status: 'active',
      effective_from: new Date(0),
      updated_by: SYSTEM,
      updated_at: new Date(0),
      default_parcel: null,
      ships_from: null,
    };
  }

  async closuresFor(owner: Owner): Promise<ClosureRec[]> {
    return this.core.repo.find('closures', { owner_type: owner.ownerType, seller_id: owner.ownerType === 'official' ? null : owner.sellerId }, { orderBy: [['from_date', 'asc']] });
  }

  /* ---------------------------------------------------------------- rules */

  /** Notices that apply to a destination, owner and (when given) carriers or services */
  noticeApplies(n: NoticeRec, o: { dest?: Destination | null; zoneIds?: string[]; ownerType?: 'official' | 'seller'; carrierCodes?: string[]; serviceIds?: string[] }): boolean {
    if (o.ownerType && n.seller_scope === 'official' && o.ownerType !== 'official') return false;
    if (o.ownerType && n.seller_scope === 'marketplace' && o.ownerType !== 'seller') return false;
    const located = n.regions.length || n.postal_prefixes.length || n.zone_ids.length;
    if (located) {
      if (!o.dest) return false;
      const hit =
        (o.dest.region && n.regions.includes(o.dest.region)) ||
        n.postal_prefixes.some((p) => p && o.dest!.postalCode.startsWith(p)) ||
        (o.zoneIds ?? []).some((z) => n.zone_ids.includes(z));
      if (!hit) return false;
    }
    if (n.carrier_codes.length && o.carrierCodes?.length && !n.carrier_codes.some((c) => o.carrierCodes!.includes(c))) return false;
    if (n.carrier_service_ids.length && o.serviceIds?.length && !n.carrier_service_ids.some((s) => o.serviceIds!.includes(s))) return false;
    return true;
  }

  private inPeriod = (n: NoticeRec, date: string) => date >= n.from_date && date <= n.to_date;

  /** Work days of the owner: dispatch schedule, closures, market closures (Official Store) and noDispatch notices */
  dispatchRules(w: World, owner: Owner, settings: SettingsRec, closures: readonly ClosureRec[], notices: readonly NoticeRec[]): DayRules {
    const days = owner.ownerType === 'official' ? (w.targets.official.businessDays?.length ? w.targets.official.businessDays : settings.business_days) : settings.business_days;
    const stops = notices.filter((n) => n.effect.noDispatch);
    return {
      days: days.length ? days : MON_FRI,
      closed: (date) =>
        closures.some((c) => date >= c.from_date && date <= c.to_date) || (owner.ownerType === 'official' && w.marketClosed.has(date)) || stops.some((n) => this.inPeriod(n, date)),
    };
  }

  carrierRules(notices: readonly NoticeRec[], effect: 'noPickup' | 'noDelivery'): DayRules {
    const stops = notices.filter((n) => n.effect[effect]);
    return { days: MON_FRI, closed: (date) => stops.some((n) => this.inPeriod(n, date)) };
  }

  /** Ships-to check: platform exclusions, served zones, the owner's coverage, then size */
  coverage(w: World, dest: Destination, settings: SettingsRec, methods?: readonly ProfileMethod[], weightGrams?: number | null): CoverageResult {
    const kind: AddressKind = addressKindOf(dest);
    const no = (reason: CoverageResult['reason'], message: string, zone: ZoneRec | null = null): CoverageResult => ({ shippable: false, reason, message, zone });
    if (dest.country && dest.country !== 'US') return no('excluded_area', 'We only deliver within the United States.');
    for (const z of w.zones.filter((x) => x.kind === 'excluded')) {
      if (!zoneMatches(z, dest, kind)) continue;
      const reason = kind === 'po_box' && z.address_kinds.includes('po_box') ? 'po_box' : kind === 'military' && z.address_kinds.includes('military') ? 'military' : 'excluded_area';
      return no(reason, z.customer_message ?? `We do not deliver to ${z.name.toLowerCase()}.`, z);
    }
    const served = w.zones.find((z) => z.kind === 'served' && zoneMatches(z, dest, kind)) ?? null;
    if (!served) return no('excluded_area', "We don't deliver to this location yet.");
    const c = settings.coverage;
    const excluded = new Set(c.excluded ?? []);
    if (kind === 'po_box' && excluded.has('po_box')) return no('po_box', 'This seller does not ship to PO boxes. Use a street address.', served);
    if (kind === 'military' && excluded.has('military')) return no('military', 'This seller does not ship to military addresses.', served);
    if (kind === 'territory' && excluded.has('territories')) return no('outside_seller_coverage', 'This seller does not ship to US territories.', served);
    if (dest.region === 'AK' && excluded.has('alaska')) return no('outside_seller_coverage', 'This seller does not ship to Alaska.', served);
    if (dest.region === 'HI' && excluded.has('hawaii')) return no('outside_seller_coverage', 'This seller does not ship to Hawaii.', served);
    if (c.area === 'contiguous_48_dc' && !(dest.region && CONTIGUOUS_48_DC.includes(dest.region))) return no('outside_seller_coverage', 'This seller ships to the contiguous US and DC only.', served);
    if (c.area === 'all_50' && !(dest.region && (CONTIGUOUS_48_DC.includes(dest.region) || ['AK', 'HI'].includes(dest.region) || (TERRITORIES.includes(dest.region) && !excluded.has('territories')))))
      return no('outside_seller_coverage', 'This seller ships within the 50 states and DC only.', served);
    if (c.area === 'custom' && !(c.zoneIds ?? []).includes(served.id)) return no('outside_seller_coverage', 'This seller does not ship to this area.', served);
    if (methods && weightGrams && weightGrams > 0 && !methods.filter((m) => m.enabled).some((m) => fitsWeight(m, weightGrams)))
      return no('item_too_large', 'This item is too large or heavy for the delivery methods offered.', served);
    return { shippable: true, reason: null, message: null, zone: served };
  }

  transitFor(w: World, method: MethodRec, zone: ZoneRec | null) {
    const t = zone?.transit_by_method?.[method.code];
    return t && Number.isFinite(t.min) ? { min: t.min, max: Math.max(t.min, t.max) } : { min: method.transit_min, max: Math.max(method.transit_min, method.transit_max) };
  }

  /** Enabled carrier services behind a profile method (the method's own when the profile names none) */
  servicesOf(w: World, pm: ProfileMethod, method: MethodRec): ServiceRec[] {
    const ids = pm.carrierServiceIds?.length ? pm.carrierServiceIds : method.carrier_service_ids;
    return ids
      .map((id) => w.services.get(id))
      .filter((s): s is ServiceRec => Boolean(s && s.enabled && w.carrierOfService.get(s.id)?.status === 'active'));
  }

  /* ---------------------------------------------------------------- options */

  /**
   * Options for one package: per method common to every profile, the price (max over profiles), free shipping,
   * the dispatch plan (latest of the items) and the arrival range.
   */
  async packageOptions(
    w: World,
    o: {
      owner: Owner;
      profiles: ProfileRec[];
      dest: Destination;
      zone: ZoneRec | null;
      weightGrams: number | null;
      subtotal: common.Money | null;
      dispatch: { businessDays: number; sameDayCutoff?: string | null; shipsFrom: string }[];
      settings: SettingsRec;
      closures: ClosureRec[];
      extraNotices?: NoticeRec[];
    },
  ): Promise<DeliveryOption[]> {
    const currency = o.profiles[0]?.currency ?? this.core.currency;
    const codes = o.profiles.map((p) => new Set(p.methods.filter((m) => m.enabled).map((m) => m.methodCode)));
    const common = [...(codes[0] ?? [])].filter((code) => codes.every((s) => s.has(code)));
    const notices = [...w.notices, ...(o.extraNotices ?? [])];
    const zoneIds = o.zone ? [o.zone.id] : [];
    const ownerNotices = notices.filter((n) => this.noticeApplies(n, { dest: o.dest, zoneIds, ownerType: o.owner.ownerType }));
    const dayRules = this.dispatchRules(w, o.owner, o.settings, o.closures, ownerNotices);
    const official = o.owner.ownerType === 'official';
    const defaultCutoff = official ? w.targets.official.cutoff || w.cfg.officialCutoff : o.settings.same_day_cutoff || DEFAULT_CUTOFF;
    // the package leaves when its slowest item can
    const plans = (o.dispatch.length ? o.dispatch : [{ businessDays: o.settings.handling_days, sameDayCutoff: null, shipsFrom: '' }]).map((d) =>
      planDispatch(w.at, {
        timeZone: this.core.tz,
        handlingDays: Number.isFinite(d.businessDays) ? d.businessDays : o.settings.handling_days,
        cutoff: d.sameDayCutoff && isTime(d.sameDayCutoff) ? d.sameDayCutoff : defaultCutoff,
        dueTime: w.cfg.dispatchDueTime,
        rules: dayRules,
      }),
    );
    const plan = plans.reduce((a, b) => (b.dueAt > a.dueAt ? b : a));
    const cutoffAt = plans.every((p) => p.countsToday) ? plans.map((p) => p.cutoffAt).filter((x): x is Date => Boolean(x)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null : null;
    const shipsFrom = o.dispatch.find((d) => d.shipsFrom)?.shipsFrom ?? null;
    const drafts: OptionDraft[] = [];
    for (const code of common) {
      const method = w.methods.find((m) => m.code === code && m.active);
      if (!method) continue;
      const pms = o.profiles.map((p) => p.methods.find((m) => m.methodCode === code && m.enabled)!);
      const prices = pms.map((pm) => methodPrice(pm, o.weightGrams, o.subtotal, currency));
      if (prices.some((p) => p === null)) continue;
      const services = this.servicesOf(w, pms[0]!, method);
      if (!services.length) continue;
      const carrierCodes = [...new Set(services.map((s) => w.carrierOfService.get(s.id)!.code))];
      const serviceIds = services.map((s) => s.id);
      const methodNotices = ownerNotices.filter((n) => this.noticeApplies(n, { dest: o.dest, zoneIds, carrierCodes, serviceIds }));
      const transit = this.transitFor(w, method, o.zone);
      const pickup = this.carrierRules(methodNotices, 'noPickup');
      const delivery = this.carrierRules(methodNotices, 'noDelivery');
      let { leaves, range } = arrivalRange(plan.date, transit, pickup, delivery);
      const extra = methodNotices.filter((n) => n.effect.extraTransitDays && n.from_date <= range.to && n.to_date >= leaves);
      if (extra.length) {
        const add = extra.reduce((s, n) => ({ min: s.min + (n.effect.extraTransitDays?.min ?? 0), max: s.max + (n.effect.extraTransitDays?.max ?? 0) }), { min: 0, max: 0 });
        ({ leaves, range } = arrivalRange(plan.date, { min: transit.min + add.min, max: transit.max + add.max }, pickup, delivery));
      }
      const price = prices.reduce((a, b) => (b!.amount > a!.amount ? b : a))!;
      const outcomes = o.profiles.map((p, i) =>
        freeOutcome({
          ownerType: o.owner.ownerType,
          methodCode: code,
          pm: pms[i]!,
          threshold: p.free_threshold != null ? money(p.free_threshold, p.currency) : null,
          thresholdMethodCode: p.free_method_code,
          subtotal: o.subtotal,
          rules: w.rules,
          today: w.today,
        }),
      );
      const free = price.amount === 0 || outcomes.every((x) => x.free);
      const first = outcomes.find((x) => x.free);
      const shown = methodNotices.filter((n) => n.to_date >= w.today && n.from_date <= range.to);
      drafts.push({
        sortPrice: free ? 0 : price.amount,
        option: {
          id: encodeOptionId({ v: o.profiles.map((p) => p.id), m: code, s: serviceIds }),
          methodCode: code,
          methodName: method.name,
          carrierService: services.map((s) => s.name).join(' or ') || null,
          price: free ? money(0, currency) : price,
          free,
          fundedBy: free ? (first?.fundedBy ?? (official ? 'company' : 'seller')) : 'customer',
          freeReason: free ? (first?.reason ?? 'Free shipping') : null,
          arrival: range,
          arrivalLabel: arrivesLabel(range),
          dispatchBy: plan.dueAt.toISOString(),
          dispatchLabel: shipsLabel(plan.date, w.today, shipsFrom),
          cutoffAt: cutoffAt ? cutoffAt.toISOString() : null,
          notices: [...new Set(shown.map((n) => n.customer_message))],
        },
      });
    }
    drafts.sort((a, b) => a.sortPrice - b.sortPrice || a.option.arrival.to.localeCompare(b.option.arrival.to));
    return drafts.map((d, i) => ({ ...d.option, isDefault: i === 0 }));
  }

  /* ---------------------------------------------------------------- public API */

  async quote(profileId: string, postalCode: string, parcel: Parcel | null, dispatch: DispatchInput, w?: World): Promise<DeliveryQuote> {
    const world = w ?? (await this.world());
    const profile = await this.profileAt(profileId, world.at);
    if (!profile) throw notFound('Shipping profile');
    const owner: Owner = { ownerType: profile.owner_type as Owner['ownerType'], sellerId: profile.seller_id };
    const settings = await this.settingsFor(owner, world.at, world.cfg);
    const dest = destinationOf({ postalCode });
    const weight = parcel?.weightGrams && parcel.weightGrams > 0 ? parcel.weightGrams : DEFAULT_WEIGHT_GRAMS;
    const cov = this.coverage(world, dest, settings, profile.methods, weight);
    if (!cov.shippable) return { shipsToLocation: false, reason: cov.message, options: [], default: null };
    const options = await this.packageOptions(world, {
      owner,
      profiles: [profile],
      dest,
      zone: cov.zone,
      weightGrams: weight,
      subtotal: null,
      dispatch: [{ businessDays: dispatch.businessDays, sameDayCutoff: dispatch.sameDayCutoff ?? null, shipsFrom: dispatch.shipsFrom }],
      settings,
      closures: await this.closuresFor(owner),
    });
    if (!options.length) return { shipsToLocation: false, reason: 'No delivery method is available for this item at this location.', options: [], default: null };
    return { shipsToLocation: true, reason: null, options, default: options.find((x) => x.isDefault) ?? null };
  }

  async quoteOptions(input: PackageQuoteInput): Promise<PackageQuote> {
    const at = input.at ? new Date(input.at) : this.core.now();
    const w = await this.world(Number.isNaN(at.getTime()) ? this.core.now() : at);
    const owner: Owner = { ownerType: input.ownerType, sellerId: input.ownerType === 'official' ? null : (input.sellerId ?? null) };
    const settings = await this.settingsFor(owner, w.at, w.cfg);
    const dest = destinationOf({ postalCode: input.destination.postalCode, region: input.destination.region ?? null, country: input.destination.country, address: input.destination.address ?? null });
    const versions = new Map<string, ProfileRec | undefined>();
    for (const id of new Set(input.items.map((i) => i.profileId))) versions.set(id, await this.profileAt(id, w.at));
    const notShippable: string[] = [];
    const ok: typeof input.items = [];
    let reason: string | null = null;
    let zone: ZoneRec | null = null;
    for (const item of input.items) {
      const p = versions.get(item.profileId);
      const weight = (item.parcel?.weightGrams && item.parcel.weightGrams > 0 ? item.parcel.weightGrams : DEFAULT_WEIGHT_GRAMS) * Math.max(1, item.quantity);
      const cov = p ? this.coverage(w, dest, settings, p.methods, weight) : { shippable: false, reason: null, message: 'This item has no shipping options.', zone: null };
      if (!cov.shippable || (p && p.owner_type !== owner.ownerType)) {
        notShippable.push(item.lineId);
        reason ??= cov.message ?? 'Does not ship to this location';
      } else {
        ok.push(item);
        zone ??= cov.zone;
      }
    }
    if (!ok.length) return { shipsToLocation: false, notShippableLineIds: notShippable, reason: reason ?? 'Does not ship to this location', options: [], default: null };
    const profiles = [...new Map(ok.map((i) => [i.profileId, versions.get(i.profileId)!])).values()];
    const weight = ok.reduce((s, i) => s + (i.parcel?.weightGrams && i.parcel.weightGrams > 0 ? i.parcel.weightGrams : DEFAULT_WEIGHT_GRAMS) * Math.max(1, i.quantity), 0);
    const currency = ok[0]!.value.currency;
    const subtotal = money(ok.reduce((s, i) => s + i.value.amount, 0), currency);
    const options = await this.packageOptions(w, {
      owner,
      profiles,
      dest,
      zone,
      weightGrams: weight,
      subtotal,
      dispatch: ok.map((i) => ({ businessDays: i.dispatch.businessDays, sameDayCutoff: i.dispatch.sameDayCutoff ?? null, shipsFrom: i.dispatch.shipsFrom || input.shipsFrom })),
      settings,
      closures: await this.closuresFor(owner),
    });
    if (!options.length) {
      return { shipsToLocation: false, notShippableLineIds: input.items.map((i) => i.lineId), reason: 'These items have no delivery method in common. Order them separately.', options: [], default: null };
    }
    return { shipsToLocation: true, notShippableLineIds: notShippable, reason: notShippable.length ? reason : null, options, default: options.find((o) => o.isDefault) ?? null };
  }

  async checkCoverage(profileIds: string[], destination: common.Address): Promise<CoverageCheck[]> {
    const w = await this.world();
    const dest = destinationOf({ postalCode: destination.postalCode, address: destination });
    const out: CoverageCheck[] = [];
    for (const profileId of profileIds) {
      const p = await this.profileAt(profileId, w.at);
      if (!p) {
        out.push({ profileId, shippable: false, reason: 'excluded_area', message: 'This item has no shipping options.' });
        continue;
      }
      const settings = await this.settingsFor({ ownerType: p.owner_type as Owner['ownerType'], sellerId: p.seller_id }, w.at, w.cfg);
      const c = this.coverage(w, dest, settings, p.methods, null);
      out.push({ profileId, shippable: c.shippable, reason: c.reason ?? null, message: c.message });
    }
    return out;
  }

  /** Dispatch deadline from acceptance time, handling days, same-day cutoff, business days and closures */
  async dispatchDeadline(ownerType: 'official' | 'seller', sellerId: string | null, from: string, dispatch: DispatchInput): Promise<string> {
    const at = new Date(from);
    if (Number.isNaN(at.getTime())) throw new AppError('VALIDATION_FAILED', 'from is not a date-time', { issues: [{ path: 'from', message: 'not a date-time' }] });
    const w = await this.world(at);
    return (await this.plan(w, { ownerType, sellerId: ownerType === 'official' ? null : sellerId }, dispatch)).dueAt.toISOString();
  }

  async plan(w: World, owner: Owner, dispatch: { businessDays?: number | null; sameDayCutoff?: string | null }) {
    const settings = await this.settingsFor(owner, w.at, w.cfg);
    const closures = await this.closuresFor(owner);
    const notices = w.notices.filter((n) => n.effect.noDispatch && this.noticeApplies(n, { ownerType: owner.ownerType }) && !(n.regions.length || n.postal_prefixes.length || n.zone_ids.length));
    const rules = this.dispatchRules(w, owner, settings, closures, notices);
    const cutoff = dispatch.sameDayCutoff && isTime(dispatch.sameDayCutoff) ? dispatch.sameDayCutoff : owner.ownerType === 'official' ? w.targets.official.cutoff || w.cfg.officialCutoff : settings.same_day_cutoff;
    return planDispatch(w.at, {
      timeZone: this.core.tz,
      handlingDays: dispatch.businessDays != null && Number.isFinite(dispatch.businessDays) ? dispatch.businessDays : settings.handling_days,
      cutoff,
      dueTime: w.cfg.dispatchDueTime,
      rules,
    });
  }

  /** Live service notices for a location (by postal prefix, state and zones), carriers and surface */
  async activeNotices(postalCode?: string, carrierCodes?: string[], surface?: string, w?: World): Promise<CustomerNotice[]> {
    const world = w ?? (await this.world());
    const dest = postalCode ? destinationOf({ postalCode }) : null;
    const zoneIds = dest ? world.zones.filter((z) => zoneMatches(z, dest, addressKindOf(dest))).map((z) => z.id) : [];
    return world.notices
      .filter((n) => n.to_date >= world.today)
      .filter((n) => !surface || n.surfaces.includes(surface))
      .filter((n) => (dest ? this.noticeApplies(n, { dest, zoneIds, ...(carrierCodes?.length ? { carrierCodes } : {}) }) : !carrierCodes?.length || !n.carrier_codes.length || n.carrier_codes.some((c) => carrierCodes.includes(c))))
      .sort((a, b) => a.from_date.localeCompare(b.from_date))
      .map((n) => ({ id: n.id, kind: n.kind, title: n.title, message: n.customer_message, from: n.from_date, to: n.to_date }));
  }

  /** Market-day arithmetic for callers that need it (preview windows) */
  addDays = addDays;
}
