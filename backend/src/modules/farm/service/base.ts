/**
 * Shared plumbing of the farm service: context, time and the market zone, audit, optional data, validation helpers,
 * dealer cards with their distance, the nearest dealer and farm locations. The parts build on it
 * (base → dealers → orders → service).
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { distanceLabel, distanceMiles, isGeoPoint, type GeoPoint } from '../../../kernel/lib/geo.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { DealerCard, FarmLocationInput } from '../../../spec/farm.js';
import { addressLabel, dealerMeta, LIMITS, messageOf } from '../domain/rules.js';
import type { DealerRow, DealerSnapshot, StoredLocation } from '../ports.js';
import type { FarmRepository } from '../repository.js';

export interface FarmServiceDeps {
  repo: FarmRepository;
  ctx: ModuleContext<'farm'>;
}

/** Who acts: for audit entries, history and events */
export interface By {
  actor: common.Actor;
  requestId?: string;
}

export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const requireText = (value: string | null | undefined, path: string, max: number, message = 'This field is required') => {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw invalid(path, message);
  if (v.length > max) throw invalid(path, `Use at most ${max} characters`);
  return v;
};
/** Optional text: trimmed, null when blank, at most `max` characters */
export const optionalText = (value: string | null | undefined, path: string, max: number) => {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  if (v.length > max) throw invalid(path, `Use at most ${max} characters`);
  return v;
};
export const unique = <T>(list: readonly T[]) => [...new Set(list)];
export const present = <T>(v: T | null | undefined): v is T => v != null;
export const pointOf = (v: unknown): GeoPoint | null => (isGeoPoint(v) ? { lat: v.lat, lng: v.lng } : null);

export class FarmBase {
  constructor(protected readonly deps: FarmServiceDeps) {}

  protected get repo() {
    return this.deps.repo;
  }
  protected get ctx() {
    return this.deps.ctx;
  }
  protected get payments() {
    return this.ctx.use('payments');
  }
  protected get customers() {
    return this.ctx.use('customers');
  }
  /** Farm machines and their attachments (departments); without departments nothing can be ordered */
  protected get departments() {
    return this.ctx.tryUse('departments');
  }
  protected now() {
    return this.ctx.clock.now();
  }
  /** The market's time zone (config) */
  protected get tz(): string {
    return this.ctx.config.market.timeZone || 'America/Los_Angeles';
  }
  protected get currency(): string {
    return this.ctx.config.market.currency || 'USD';
  }
  protected get country(): string {
    return 'US';
  }
  /** Today in the market zone, YYYY-MM-DD */
  protected today(): string {
    return dateInZone(this.now(), this.tz);
  }

  /** A whole-number setting, or `fallback` when unset or out of range */
  protected async intSetting(key: 'confirmHours' | 'leadDays' | 'maxAheadDays' | 'installmentMonths' | 'depositPercent', fallback: number, min = 0): Promise<number> {
    try {
      const v = Number(await this.ctx.settings.get(key));
      return Number.isFinite(v) && v >= min ? Math.floor(v) : fallback;
    } catch {
      return fallback;
    }
  }

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'orders', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      this.ctx.log.warn({ err, action: entry.action }, 'farm: audit entry not recorded');
    }
  }

  /** An answer that may fail without failing the request, or `fallback` */
  protected async soft<T>(what: string, call: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
    if (!call) return fallback;
    try {
      return await call();
    } catch (err) {
      this.ctx.log.debug({ err, what }, 'farm: optional data unavailable');
      return fallback;
    }
  }

  /* ---------------------------------------------------------------- places */

  /** A point for an address (customers.geocodeAddress), or null */
  protected geocode(a: { line1?: string | null; city: string; region: string; postalCode?: string | null; country?: string | null }): Promise<GeoPoint | null> {
    return this.soft(
      'customers.geocodeAddress',
      async () => pointOf(await this.customers.geocodeAddress({ city: a.city, region: a.region, ...(a.line1 ? { line1: a.line1 } : {}), ...(a.postalCode ? { postalCode: a.postalCode } : {}), ...(a.country ? { country: a.country } : {}) })),
      null,
    );
  }

  /**
   * The customers-module id of the signed-in customer on a visitor endpoint (customers.getCustomerByUserId, else the
   * account id as store endpoints use it); null for visitors.
   */
  async viewerOf(principal: Principal | null | undefined): Promise<string | null> {
    if (principal?.kind !== 'customer' || !principal.accountId) return null;
    const c = await this.soft('customers.getCustomerByUserId', () => this.customers.getCustomerByUserId(principal.accountId!), null);
    return c?.id ?? principal.accountId;
  }

  /** The signed-in customer's point (their geocoded default address), or null */
  protected async customerPoint(customerId: string | null): Promise<GeoPoint | null> {
    if (!customerId) return null;
    const loc = await this.soft('customers.customerLocation', () => this.customers.customerLocation(customerId), null);
    return pointOf(loc?.point);
  }

  /**
   * The farm location of a form: a saved address (customers.getAddressForOrder) or the typed one, with the pin or
   * else the geocoded address. `strict` checks every field (placing an order); a quote takes what is there.
   */
  protected async farmLocation(input: FarmLocationInput | null | undefined, customerId: string | null, strict: boolean): Promise<StoredLocation | null> {
    if (!input) {
      if (strict) throw invalid('location', 'Add the farm location');
      return null;
    }
    const pin = input.point != null ? pointOf(input.point) : null;
    if (strict && input.point != null && !pin) throw invalid('location.point', 'Not a point on the map');
    let base: Omit<StoredLocation, 'point' | 'pinned'> | null = null;
    if (input.addressId && !customerId) {
      // a quote for a visitor: saved addresses need a signed-in customer
      if (strict) throw new AppError('UNAUTHORIZED', 'Sign in to use a saved address');
    } else if (input.addressId && customerId) {
      const a = strict ? await this.customers.getAddressForOrder(customerId, input.addressId) : await this.soft('customers.getAddressForOrder', () => this.customers.getAddressForOrder(customerId, input.addressId!), null);
      if (a) base = { name: null, line1: a.line1, line2: a.line2 ?? null, city: a.city, region: a.region, postalCode: a.postalCode || null, country: a.country || this.country };
    } else if (input.address) {
      const a = input.address;
      if (strict) {
        base = {
          name: optionalText(a.name, 'location.address.name', LIMITS.name),
          line1: requireText(a.line1, 'location.address.line1', LIMITS.line),
          line2: optionalText(a.line2, 'location.address.line2', LIMITS.line),
          city: requireText(a.city, 'location.address.city', LIMITS.city),
          region: requireText(a.region, 'location.address.region', LIMITS.region),
          postalCode: optionalText(a.postalCode, 'location.address.postalCode', LIMITS.postalCode),
          country: (optionalText(a.country, 'location.address.country', 2) ?? this.country).toUpperCase(),
        };
      } else if (a.city?.trim() && a.region?.trim()) {
        base = { name: a.name?.trim() || null, line1: a.line1?.trim() ?? '', line2: a.line2?.trim() || null, city: a.city.trim(), region: a.region.trim(), postalCode: a.postalCode?.trim() || null, country: a.country?.trim().toUpperCase() || this.country };
      }
    }
    if (!base) {
      if (strict) throw invalid('location', 'Pick a saved address or type the farm address');
      return pin ? { name: null, line1: '', line2: null, city: '', region: '', postalCode: null, country: this.country, point: pin, pinned: true } : null;
    }
    const point = pin ?? (await this.geocode(base));
    return { ...base, point, pinned: Boolean(pin) };
  }

  /* ---------------------------------------------------------------- dealers */

  protected snapshotOf(d: DealerRow): DealerSnapshot {
    return { name: d.name, line1: d.line1, city: d.city, point: pointOf(d.point), hours: d.hours, phone: d.phone, messagePhone: d.message_phone, messageEmail: d.message_email };
  }

  /** The dealer card the app shows, with the distance from `from` when both points are known */
  protected dealerCard(id: string, d: DealerSnapshot, from: GeoPoint | null): DealerCard {
    const address = addressLabel(d);
    const distance = distanceLabel(from, d.point);
    return {
      id,
      name: d.name,
      addressLabel: address,
      city: d.city,
      distanceLabel: distance,
      metaLabel: dealerMeta(address, distance),
      hours: d.hours,
      phone: d.phone,
      message: messageOf({ message_phone: d.messagePhone, message_email: d.messageEmail }),
      point: d.point,
    };
  }

  /**
   * The dealer an order at `point` goes to: the nearest active dealer with a point; without a point (or no dealer
   * with one), the market default — the first active dealer in Admin order. Null when no dealer is active.
   */
  protected async dealerFor(...points: (GeoPoint | null)[]): Promise<{ dealer: DealerRow; from: GeoPoint | null; nearest: boolean } | null> {
    const active = await this.repo.listDealers({ activeOnly: true });
    if (!active.length) return null;
    for (const from of points) {
      if (!from) continue;
      let best: { d: DealerRow; miles: number } | null = null;
      for (const d of active) {
        const p = pointOf(d.point);
        if (!p) continue;
        const miles = distanceMiles(from, p);
        if (!best || miles < best.miles) best = { d, miles };
      }
      if (best) return { dealer: best.d, from, nearest: true };
    }
    return { dealer: active[0]!, from: points.find(present) ?? null, nearest: false };
  }
}
