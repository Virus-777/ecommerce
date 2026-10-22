/**
 * Address geocoding (owner decision 2026-10-22): the customer's location is their saved default delivery address,
 * placed on the map by the geocoder provider when it is saved and by the customers.geocode-addresses backfill.
 * Coordinates stay internal; other modules read them through customerLocation and geocode their own staff-entered
 * addresses with geocodeAddress. A geocoder failure never fails a save: the address is left for the backfill.
 */
import { isGeoPoint, type GeoPoint } from '../../../kernel/lib/geo.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { CustomerLocation } from '../../../spec/customers.js';
import { addressOf } from '../mappers.js';
import { unconfiguredGeocoder } from '../providers/geocoder.js';
import type { AddressRow, Geocoder, GeocodeQuery, GeocodeResult } from '../ports.js';
import { DAY, type Core } from './core.js';

type GeoColumns = Pick<AddressRow, 'lat' | 'lng' | 'geocoded_at' | 'geocode_precision'>;

/** Addresses the geocoder could not place are tried again after this long (a provider or table may learn them) */
export const GEOCODE_RETRY_DAYS = 7;
export const GEOCODE_BATCH = 200;
/** Batches per backfill run, so one run stays short; the next run carries on */
const GEOCODE_BATCHES_PER_RUN = 25;

const NOT_GEOCODED: GeoColumns = { lat: null, lng: null, geocoded_at: null, geocode_precision: null };

/** The stored point of an address row, or null */
export function pointOf(a: Pick<AddressRow, 'lat' | 'lng'>): GeoPoint | null {
  if (a.lat == null || a.lng == null) return null;
  const p = { lat: Number(a.lat), lng: Number(a.lng) };
  return isGeoPoint(p) ? p : null;
}

export class Geocoding {
  constructor(readonly core: Core) {}

  get geocoder(): Geocoder {
    return this.core.deps.geocoder ?? unconfiguredGeocoder;
  }

  /** The provider's answer, or undefined when it failed (logged); null = it does not know the address */
  private async locate(q: GeocodeQuery): Promise<GeocodeResult | null | undefined> {
    if (!q.city?.trim() || !q.region?.trim()) return null;
    try {
      const r = await this.geocoder.geocode(q);
      return r && isGeoPoint(r.point) ? r : null;
    } catch (err) {
      this.core.ctx.log.warn({ err, provider: this.geocoder.name }, 'customers: geocoder failed');
      return undefined;
    }
  }

  /** A point for any address (publicApi geocodeAddress): food, services, farm and departments place staff-entered addresses */
  async geocodeAddress(input: { line1?: string; city: string; region: string; postalCode?: string; country?: string }): Promise<GeoPoint | null> {
    if (!input || !this.geocoder.configured) return null;
    return (await this.locate(input))?.point ?? null;
  }

  /** The geo columns for an address being saved: geocoded_at stays null when the geocoder failed, so the backfill retries */
  async columnsFor(a: common.Address, now: Date): Promise<GeoColumns> {
    if (!this.geocoder.configured) return NOT_GEOCODED;
    const r = await this.locate({ line1: a.line1, city: a.city, region: a.region, postalCode: a.postalCode, country: a.country });
    if (r === undefined) return NOT_GEOCODED;
    return {
      lat: r ? r.point.lat.toFixed(6) : null,
      lng: r ? r.point.lng.toFixed(6) : null,
      geocoded_at: now,
      geocode_precision: r?.precision ?? null,
    };
  }

  /** Geocodes one stored address and saves the columns (the address itself is unchanged, so updated_at is kept) */
  private async geocodeRow(a: AddressRow): Promise<AddressRow | undefined> {
    const cols = await this.columnsFor(addressOf(a),this.core.now());
    if (!cols.geocoded_at) return undefined;
    return this.core.repo.updateAddress(a.id, cols);
  }

  /**
   * The customer's point from their default address (publicApi customerLocation). Accepts the customers-module id;
   * an identity account id is resolved too (callers fall back to it when the principal has no customerId). A default
   * address never geocoded yet is geocoded now.
   */
  async customerLocation(customerId: string): Promise<CustomerLocation | null> {
    if (!isUuid(customerId)) return null;
    const repo = this.core.repo;
    const c = (await repo.getCustomer(customerId)) ?? (await repo.getCustomerByUserId(customerId));
    if (!c) return null;
    let a = (await repo.defaultAddresses([c.id]))[0];
    if (!a) return null;
    if (!a.geocoded_at && this.geocoder.configured) a = (await this.geocodeRow(a)) ?? a;
    const point = pointOf(a);
    if (!point) return null;
    return { point, city: a.city, region: a.region, addressId: a.id, label: a.line1, precision: a.geocode_precision ?? null };
  }

  /** customers.geocode-addresses: addresses never geocoded (or not placed for a week) get their point */
  async geocodeAddresses(): Promise<{ geocoded: number; notFound: number; failed: number }> {
    const out = { geocoded: 0, notFound: 0, failed: 0 };
    if (!this.geocoder.configured) return out;
    const retryBefore = new Date(this.core.now().getTime() - GEOCODE_RETRY_DAYS * DAY);
    const tried: string[] = [];
    for (let i = 0; i < GEOCODE_BATCHES_PER_RUN; i++) {
      const rows = await this.core.repo.addressesToGeocode(retryBefore, GEOCODE_BATCH, tried);
      if (!rows.length) break;
      for (const a of rows) {
        tried.push(a.id);
        const saved = await this.geocodeRow(a);
        if (!saved) out.failed++;
        else if (saved.lat == null) out.notFound++;
        else out.geocoded++;
      }
    }
    if (out.geocoded || out.notFound || out.failed) this.core.ctx.log.info({ ...out, provider: this.geocoder.name }, 'customers: geocoded saved addresses');
    return out;
  }
}
