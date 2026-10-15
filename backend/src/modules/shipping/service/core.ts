/**
 * Shared plumbing of the shipping use cases: time, settings, events, audit, optional modules, names and the
 * reference data every market needs (carriers, methods, zones, the Official Store schedule), seeded once.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type { Coverage, OfficialDispatchTarget, SellerDispatchTarget } from '../../../spec/shipping.js';
import { MON_FRI } from '../domain/calendar.js';
import { CONTIGUOUS_48_DC, MILITARY, TERRITORIES } from '../domain/geo.js';
import { carrierSeedId, carrierServiceSeedId } from '../domain/seed.js';
import { CARRIER_CATALOG, DEFAULT_CARRIERS } from '../domain/tracking.js';
import type { CarrierPort, TargetsRec } from '../ports.js';
import type { ShippingRepository } from '../repository.js';

export interface ShippingServiceDeps {
  repo: ShippingRepository;
  ctx: ModuleContext<'shipping'>;
  carriers: CarrierPort;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

export interface Cfg {
  defaultSellerHandlingDays: number;
  sellerHandlingRange: [number, number];
  officialCutoff: string;
  dispatchDueTime: string;
  validTrackingWithinHours: number;
  labelScanGraceHours: number;
  stalledNoScanDays: number;
  failedDeliveryChoiceDays: number;
  claimFinanceApprovalAbove: common.Money;
  marketDefaultPostalCode: string;
}

type OwnEvent = keyof EventMap & `shipping.${string}`;
type Optional = Parameters<ModuleContext<'shipping'>['tryUse']>[0];

/** Events collected inside a transaction and published after the commit */
export class Batch {
  readonly events: { name: OwnEvent; payload: unknown }[] = [];
  constructor(readonly by: By) {}
  push<N extends OwnEvent>(name: N, payload: EventMap[N]) {
    this.events.push({ name, payload });
  }
}

export const SYSTEM: common.Actor = { kind: 'system', id: null };

/** Who customer-facing shipment events reach */
export interface Recipient {
  customerId: string | null;
  contactEmail: string | null;
}
/** Events notifications sends to the customer: they carry the order's customer and contact email */
const TO_CUSTOMER = new Set<string>(['shipping.shipment.dispatched', 'shipping.shipment.delivered', 'shipping.shipment.exception']);
export const OFFICIAL_NAME = OFFICIAL_STORE_NAME;
export const DEFAULT_CUTOFF = '14:00';

/** Who physically ships a group (orders' FulfilledBy) */
export type FulfilledBy = 'official_warehouse' | 'seller' | 'marketly_service';
export const FULFILLED_BY: readonly FulfilledBy[] = ['official_warehouse', 'seller', 'marketly_service'];

/** The value when a caller or an older event gives none: Official Store groups are warehouse-shipped, seller groups seller-shipped */
export const fulfilledByOf = (ownerType: string, given?: string | null): FulfilledBy =>
  given && (FULFILLED_BY as readonly string[]).includes(given) ? (given as FulfilledBy) : ownerType === 'official' ? 'official_warehouse' : 'seller';

/** Marketly's warehouse ships it (Fulfilled by Marketly): a seller's package, but the seller has no part in dispatch */
export const byMarketly = (fulfilledBy: string | null | undefined) => fulfilledBy === 'marketly_service';

/** 409 FULFILLED_BY_MARKETLY for seller actions on a Marketly-shipped package */
export const MARKETLY_SHIPS = "Marketly ships this package; you can't record shipments, buy labels, correct tracking or answer exceptions for it.";

export const invalid = (issues: { path: string; message: string }[], message = 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);

export class Core {
  readonly repo: ShippingRepository;
  readonly ctx: ModuleContext<'shipping'>;
  readonly carriers: CarrierPort;
  #seeded: Promise<void> | null = null;

  constructor(deps: ShippingServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
    this.carriers = deps.carriers;
  }

  now = () => this.ctx.clock.now();
  get tz() {
    return this.ctx.config.market.timeZone;
  }
  get currency() {
    return this.ctx.config.market.currency;
  }
  today = (at: Date = this.now()) => dateInZone(at, this.tz);
  error = (code: string, message?: string, details?: unknown) => this.ctx.error(code, message, details);

  /** Seller endpoints on a Fulfilled by Marketly package: 409 FULFILLED_BY_MARKETLY */
  refuseIfMarketly(fulfilledBy: string | null | undefined) {
    if (byMarketly(fulfilledBy)) throw this.error('FULFILLED_BY_MARKETLY', MARKETLY_SHIPS);
  }

  /** The Fulfilled by Marketly service location (fulfillment-service); null when the module is off or has none */
  async serviceLocation(): Promise<{ locationId: string; address: common.Address; shipsFrom: string } | null> {
    return (await this.soft('fulfillment-service', 'getServiceLocation', (f) => f.getServiceLocation())) ?? null;
  }

  async cfg(): Promise<Cfg> {
    const s = this.ctx.settings;
    const [a, b, c, d, e, f, g, h, i, j] = await Promise.all([
      s.get('defaultSellerHandlingDays'),
      s.get('sellerHandlingRange'),
      s.get('officialCutoff'),
      s.get('dispatchDueTime'),
      s.get('validTrackingWithinHours'),
      s.get('labelScanGraceHours'),
      s.get('stalledNoScanDays'),
      s.get('failedDeliveryChoiceDays'),
      s.get('claimFinanceApprovalAbove'),
      s.get('marketDefaultPostalCode'),
    ]);
    // default 0–3 business days, 0 = ships the same business day (decision G40b)
    const range = Array.isArray(b) && b.length === 2 ? ([num(b[0], 0), num(b[1], 3)] as [number, number]) : ([0, 3] as [number, number]);
    const limit = (i ?? {}) as Partial<common.Money>;
    return {
      defaultSellerHandlingDays: num(a, 2),
      sellerHandlingRange: range,
      officialCutoff: str(c, DEFAULT_CUTOFF),
      dispatchDueTime: str(d, '17:00'),
      validTrackingWithinHours: num(e, 24),
      labelScanGraceHours: num(f, 36),
      stalledNoScanDays: num(g, 7),
      failedDeliveryChoiceDays: num(h, 14),
      claimFinanceApprovalAbove: { amount: num(limit.amount, 100000), currency: str(limit.currency, 'USD') },
      marketDefaultPostalCode: str(j, this.ctx.config.market.defaultLocation.postalCode),
    };
  }

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  /**
   * Publishes what a transaction collected (after the commit). Customer-facing shipment events get the
   * order's customer and contact email (orders.getOrder) here, outside the transaction.
   */
  async flush(batch: Batch) {
    const recipients = new Map<string, Promise<Recipient>>();
    for (const e of batch.events) {
      let payload = e.payload as Record<string, unknown>;
      if (TO_CUSTOMER.has(e.name) && typeof payload.orderId === 'string' && !('contactEmail' in payload)) {
        const orderId = payload.orderId;
        if (!recipients.has(orderId)) recipients.set(orderId, this.recipientOf(orderId));
        payload = { ...payload, ...(await recipients.get(orderId)!) };
      }
      this.publish(e.name, payload as never, batch.by);
    }
  }

  /** The order's customer (null for guests) and contact email; unknown order or orders failing → nulls */
  async recipientOf(orderId: string): Promise<Recipient> {
    try {
      const order = await this.ctx.use('orders').getOrder(orderId);
      return { customerId: order?.contact.customerId ?? null, contactEmail: order?.contact.email ?? null };
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err, orderId }, 'shipping: order contact lookup failed');
      return { customerId: null, contactEmail: null };
    }
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
  }

  /** An optional module's answer; off, not built or failing → undefined (the caller degrades) */
  async soft<M extends Optional, R>(module: M, what: string, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err, module, what }, 'shipping: optional call failed');
      return undefined;
    }
  }

  /** Store names of sellers (Official Store for null) */
  async sellerNames(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    const out = new Map<string, string>();
    if (!unique.length) return out;
    const list = await this.soft('sellers', 'getSellers', (s) => s.getSellers(unique));
    for (const s of list ?? []) out.set(s.id, s.storeName);
    return out;
  }

  nameOf(names: Map<string, string>, ownerType: string, sellerId: string | null | undefined) {
    return ownerType === 'official' || !sellerId ? OFFICIAL_NAME : (names.get(sellerId) ?? 'Seller');
  }

  /** Market closures (settings) as closed dispatch days of the Official Store */
  async marketClosedDays(): Promise<Set<string>> {
    const m = await this.soft('settings', 'market', (s) => s.market());
    return new Set((m?.closures ?? []).filter((c) => c.kind === 'closed').map((c) => c.date));
  }

  /* ---------------------------------------------------------------- reference data */

  /** Dispatch targets in force (latest effective row), else the defaults from settings */
  async targets(at: Date = this.now(), cfg?: Cfg): Promise<TargetsRec> {
    const rows = await this.repo.find('dispatch_targets', { effective_from: { op: '<=', value: at } }, { orderBy: [['effective_from', 'desc']], limit: 1 });
    if (rows[0]) return rows[0];
    const c = cfg ?? (await this.cfg());
    return {
      id: '00000000-0000-7000-8000-000000000000',
      official: defaultOfficial(c),
      seller_default: defaultSeller(c),
      effective_from: new Date(0),
      set_by: SYSTEM,
      reason: 'Defaults',
    };
  }

  /** Seeds carriers, services, methods, zones and the Official Store default profile once (idempotent) */
  ensureSeeded(): Promise<void> {
    this.#seeded ??= this.seed().catch((err) => {
      this.#seeded = null;
      throw err;
    });
    return this.#seeded;
  }

  private async seed() {
    const repo = this.repo;
    const now = this.now();
    const services = new Map<string, string>();
    for (const code of DEFAULT_CARRIERS) {
      const def = CARRIER_CATALOG[code]!;
      await repo.insertIfAbsent('carriers', {
        id: carrierSeedId(code),
        code,
        name: def.name,
        // Other carrier has no account and no tracking feed: numbers are checked by format only
        account_label: code === 'other' ? null : `Marketly ${def.name} account`,
        status: 'active',
        tracking_mode: code === 'other' ? 'manual' : code === 'ontrac' ? 'polling' : 'webhook',
        credentials_ref: code === 'other' ? null : `carrier/${code}`,
        contacts: [],
        last_event_at: null,
        on_time_rate_30d: null,
      });
      const carrier = (await repo.find('carriers', { code }))[0]!;
      for (const s of def.services) {
        await repo.insertIfAbsent('carrier_services', {
          id: carrierServiceSeedId(code, s.code),
          carrier_id: carrier.id,
          code: s.code,
          name: s.name,
          transit_min: s.transit.min,
          transit_max: s.transit.max,
          enabled: true,
          label_supported: s.labelSupported,
          tracking_pattern: s.trackingPattern,
        });
      }
      for (const s of await repo.find('carrier_services', { carrier_id: carrier.id })) services.set(`${code}:${s.code}`, s.id);
    }
    const ids = (...keys: string[]) => keys.map((k) => services.get(k)).filter((x): x is string => Boolean(x));
    const methods = [
      { code: 'standard', name: 'Standard', customer_label: '3–6 business days', transit_min: 3, transit_max: 6, carrier_service_ids: ids('ups:ground', 'usps:ground_advantage', 'fedex:ground'), position: 1 },
      { code: 'expedited', name: 'Expedited', customer_label: '2–3 business days', transit_min: 2, transit_max: 3, carrier_service_ids: ids('ups:2nd_day_air', 'usps:priority', 'fedex:2day'), position: 2 },
      { code: 'express', name: 'Express', customer_label: '1–2 business days', transit_min: 1, transit_max: 2, carrier_service_ids: ids('ups:next_day_air', 'usps:priority_express', 'fedex:standard_overnight'), position: 3 },
      { code: 'large_items', name: 'Large items', customer_label: '5–10 business days', transit_min: 5, transit_max: 10, carrier_service_ids: ids('fedex:freight'), position: 4 },
    ];
    for (const m of methods) await repo.insertIfAbsent('methods', { id: newId(), active: true, ...m });

    if (!(await repo.count('zones', {}))) {
      const zone = (name: string, kind: 'served' | 'excluded', regions: string[], extra: { address_kinds?: string[]; transit?: Record<string, { min: number; max: number }>; message?: string; status?: string } = {}) => ({
        id: newId(),
        name,
        kind,
        regions,
        postal_prefixes: [],
        address_kinds: extra.address_kinds ?? [],
        transit_by_method: extra.transit ?? {},
        status: extra.status ?? 'active',
        customer_message: extra.message ?? null,
      });
      await repo.insertMany('zones', [
        zone('Contiguous US and DC', 'served', [...CONTIGUOUS_48_DC], { transit: { standard: { min: 3, max: 6 }, expedited: { min: 2, max: 3 }, express: { min: 1, max: 2 }, large_items: { min: 5, max: 10 } } }),
        zone('Alaska and Hawaii', 'served', ['AK', 'HI'], { transit: { standard: { min: 5, max: 9 }, expedited: { min: 3, max: 5 }, express: { min: 2, max: 3 }, large_items: { min: 10, max: 15 } } }),
        zone('Military addresses (APO/FPO/DPO)', 'excluded', [...MILITARY], { address_kinds: ['military'], message: 'We cannot ship to military addresses yet.' }),
        zone('US territories', 'excluded', [...TERRITORIES], { address_kinds: ['territory'], message: 'We do not ship to US territories yet.' }),
        zone('PO boxes', 'excluded', [], { address_kinds: ['po_box'], message: 'Carriers cannot deliver this package to a PO box. Use a street address.', status: 'disabled' }),
      ]);
    }

    if (!(await repo.count('seller_settings', { owner_type: 'official' }))) {
      await repo.insert('seller_settings', {
        id: newId(),
        owner_type: 'official',
        seller_id: null,
        coverage: { area: 'all_50', zoneIds: [], excluded: ['military', 'territories'] } satisfies Coverage,
        handling_days: 0,
        same_day_cutoff: DEFAULT_CUTOFF,
        business_days: [...MON_FRI],
        buy_labels: true,
        status: 'active',
        effective_from: now,
        updated_by: SYSTEM,
        updated_at: now,
        default_parcel: { weightGrams: 1000, lengthCm: 30, widthCm: 20, heightCm: 15 },
        // the Official Store ships from inventory's default location, never a stored text
        ships_from: null,
      });
    }
    if (!(await repo.count('profiles', { owner_type: 'official' }))) {
      const all = await repo.find('methods', {});
      const by = (code: string) => all.find((m) => m.code === code)!;
      const usd = (amount: number) => ({ amount, currency: this.currency });
      const pm = (code: string, tiers: { upToGrams?: number | null; price: common.Money }[], rateType: 'flat_per_package' | 'by_weight' = 'by_weight') => ({
        methodId: by(code).id,
        methodCode: code,
        name: by(code).name,
        enabled: true,
        rateType,
        tiers: tiers.map((t) => ({ upToGrams: t.upToGrams ?? null, upToOrderValue: null, price: t.price })),
        minWeightGrams: null,
        maxWeightGrams: code === 'large_items' ? null : 30_000,
        carrierServiceIds: by(code).carrier_service_ids,
        freeOver: null,
      });
      const lineage = newId();
      await repo.insert('profiles', {
        id: lineage,
        lineage_id: lineage,
        owner_type: 'official',
        seller_id: null,
        name: 'Default',
        is_default: true,
        methods: [
          pm('standard', [{ upToGrams: 2000, price: usd(599) }, { upToGrams: 10000, price: usd(899) }, { upToGrams: null, price: usd(1499) }]),
          pm('expedited', [{ upToGrams: 2000, price: usd(1299) }, { upToGrams: null, price: usd(1999) }]),
          pm('express', [{ price: usd(2499) }], 'flat_per_package'),
        ],
        free_threshold: 3500,
        free_method_code: 'standard',
        currency: this.currency,
        version: 1,
        status: 'active',
        effective_from: new Date(0),
        updated_by: SYSTEM,
        updated_at: now,
      });
    }
  }
}

export const defaultOfficial = (c: Cfg): OfficialDispatchTarget => ({
  cutoff: c.officialCutoff,
  businessDays: [...MON_FRI],
  beforeCutoff: 'Ships the same business day',
  afterCutoff: 'Ships the next business day',
  onTimeRate30d: null,
});

export const defaultSeller = (c: Cfg): SellerDispatchTarget => ({
  dispatchWithinBusinessDays: c.defaultSellerHandlingDays,
  allowedMinDays: c.sellerHandlingRange[0],
  allowedMaxDays: c.sellerHandlingRange[1],
  validTrackingWithinHours: c.validTrackingWithinHours,
  onTimeTargetPct: 95,
});
