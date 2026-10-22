/**
 * Shared plumbing of the food service: context, time and the market zone, audit, optional data, pictures (media
 * usages), slugs, validation helpers and the restaurant cards every part shows. The parts build on it
 * (base → catalog → basket → orders → service).
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { isTimeZone } from '../../../kernel/lib/dates.js';
import { distanceLabel, isGeoPoint, type GeoPoint } from '../../../kernel/lib/geo.js';
import { money, type Money } from '../../../kernel/lib/money.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { RestaurantCard } from '../../../spec/food.js';
import { averageOf, deliveryLabel, feeLabel, isValidSlug, openStateOf, slugOf, type OpenState } from '../domain/rules.js';
import type { RestaurantRow } from '../ports.js';
import type { FoodRepository } from '../repository.js';

export interface FoodServiceDeps {
  repo: FoodRepository;
  ctx: ModuleContext<'food'>;
}

/** Who acts: for audit entries, history and events */
export interface By {
  actor: common.Actor;
  requestId?: string;
}

export type Refs = Map<string, common.MediaRef>;

/** Who looks at restaurant cards: the signed-in customer's point (their geocoded default address) and saved restaurants */
export interface Viewer {
  customerId: string | null;
  point: GeoPoint | null;
  saved: Set<string>;
}
export const NO_VIEWER: Viewer = { customerId: null, point: null, saved: new Set() };

/** A restaurant's point (lat and lng are stored as numeric strings), or null */
export const pointOf = (r: Pick<RestaurantRow, 'lat' | 'lng'>): GeoPoint | null => {
  if (r.lat == null || r.lng == null) return null;
  const p = { lat: Number(r.lat), lng: Number(r.lng) };
  return isGeoPoint(p) ? p : null;
};
type UsageKind = 'content_block' | 'category_image';

export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const requireText = (value: string | null | undefined, path: string, max: number, message = 'This field is required') => {
  const v = value?.trim();
  if (!v) throw invalid(path, message);
  if (v.length > max) throw invalid(path, `Use at most ${max} characters`);
  return v;
};
/** Optional text: trimmed, null when blank, at most `max` characters */
export const optionalText = (value: string | null | undefined, path: string, max: number) => {
  const v = value?.trim();
  if (!v) return null;
  if (v.length > max) throw invalid(path, `Use at most ${max} characters`);
  return v;
};
/** A list of short texts: trimmed, blanks and repeats dropped, at most `count` of at most `max` characters */
export const textList = (list: readonly string[] | null | undefined, path: string, count: number, max: number): string[] => {
  const out = unique((list ?? []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean));
  if (out.length > count) throw invalid(path, `Use at most ${count} items`);
  out.forEach((s, i) => {
    if (s.length > max) throw invalid(`${path}[${i}]`, `Use at most ${max} characters`);
  });
  return out;
};
export const unique = <T>(list: readonly T[]) => [...new Set(list)];
export const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const present = <T>(v: T | null | undefined): v is T => v != null;

export class FoodBase {
  constructor(protected readonly deps: FoodServiceDeps) {}

  protected get repo() {
    return this.deps.repo;
  }
  protected get ctx() {
    return this.deps.ctx;
  }
  protected get media() {
    return this.ctx.use('media');
  }
  protected get payments() {
    return this.ctx.use('payments');
  }
  protected get customers() {
    return this.ctx.use('customers');
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
  /** A restaurant's zone: its own, else the market's */
  protected zoneOf(r: { time_zone?: string | null } | { timeZone?: string | null }): string {
    const tz = 'time_zone' in r ? r.time_zone : (r as { timeZone?: string | null }).timeZone;
    return tz && isTimeZone(tz) ? tz : this.tz;
  }

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'content', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      this.ctx.log.warn({ err, action: entry.action }, 'food: audit entry not recorded');
    }
  }

  /** An answer that may fail without failing the request, or `fallback` */
  protected async soft<T>(what: string, call: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
    if (!call) return fallback;
    try {
      return await call();
    } catch (err) {
      this.ctx.log.debug({ err, what }, 'food: optional data unavailable');
      return fallback;
    }
  }

  /** The slug a category or restaurant is saved under; SLUG_TAKEN when another record has it */
  protected async slugFor(table: 'categories' | 'restaurants', given: string | null | undefined, from: string, exceptId?: string): Promise<string> {
    const slug = slugOf(given, from);
    if (!slug || !isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, digits and hyphens');
    if (await this.repo.slugTaken(table, slug, exceptId)) throw this.ctx.error('SLUG_TAKEN', `Another record already uses the slug ${slug}`);
    return slug;
  }

  /** Money of an admin input in the market currency: a whole amount of cents, 0 or more (`positive`: above 0) */
  protected checkMoney(m: common.Money | null | undefined, path: string, o: { positive?: boolean } = {}): Money | null {
    if (!m) return null;
    if (!Number.isInteger(m.amount) || m.amount < 0 || (o.positive && m.amount === 0)) throw invalid(`${path}.amount`, o.positive ? 'Use a whole amount in cents above 0' : 'Use a whole amount in cents, 0 or more');
    if (m.currency && m.currency !== this.currency) throw invalid(`${path}.currency`, `Use ${this.currency}`);
    return money(m.amount, this.currency);
  }

  /* ---------------------------------------------------------------- restaurant cards */

  protected openState(r: RestaurantRow, at = this.now()): OpenState {
    return openStateOf(r.hours, at, this.zoneOf(r), r.status !== 'published');
  }

  /**
   * The viewer of restaurant cards: for a signed-in customer their location (customers.customerLocation; none when it
   * fails) and which of these restaurants (all when not given) they saved
   */
  protected async viewerOf(customerId: string | null | undefined, restaurantIds?: string[]): Promise<Viewer> {
    if (!customerId) return NO_VIEWER;
    const [location, saved] = await Promise.all([
      this.soft('customers.customerLocation', () => this.customers.customerLocation(customerId), null),
      this.repo.savedIds(customerId, restaurantIds),
    ]);
    return { customerId, point: location && isGeoPoint(location.point) ? location.point : null, saved };
  }

  protected restaurantCard(r: RestaurantRow, refs: Refs, at = this.now(), viewer: Viewer = NO_VIEWER): RestaurantCard {
    const state = this.openState(r, at);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      cuisine: r.cuisine,
      image: r.image_id ? (refs.get(r.image_id) ?? null) : null,
      logo: r.logo_id ? (refs.get(r.logo_id) ?? null) : null,
      city: r.city,
      rating: averageOf(r.rating_sum, r.rating_count),
      ratingCount: r.rating_count,
      deliveryLabel: deliveryLabel(r.delivery_min, r.delivery_max),
      feeLabel: feeLabel(money(r.delivery_fee, r.currency)),
      promoBadge: r.promo_badge,
      open: state.open,
      openLabel: state.label,
      distanceLabel: distanceLabel(viewer.point, pointOf(r)),
      saved: viewer.saved.has(r.id),
    };
  }

  /* ---------------------------------------------------------------- media */

  /** MediaRefs by asset id (missing files are left out) */
  protected async refsMap(ids: (string | null | undefined)[], size: 'large' | 'thumb' = 'large'): Promise<Refs> {
    const list = unique(ids.filter((i): i is string => Boolean(i)));
    if (!list.length) return new Map();
    const refs = await this.soft('media.refs', () => this.media.refs(list, size), [] as common.MediaRef[]);
    return new Map(refs.map((r) => [r.id, r]));
  }

  /** Saves a write with its pictures: attaches new ones, runs `save`, then detaches the ones no longer used (or undoes) */
  protected async withMedia<T>(kind: UsageKind, refId: string, refLabel: string, before: string[], after: { id: string; path: string }[], save: () => Promise<T>): Promise<T> {
    const usage = { module: 'food', kind, refId };
    const prev = new Set(before);
    const attached: string[] = [];
    const undo = async () => {
      for (const id of attached) await this.media.detach(id, usage).catch(() => {});
    };
    try {
      for (const f of after) {
        if (prev.has(f.id) || attached.includes(f.id)) continue;
        try {
          await this.media.attach(f.id, { ...usage, refLabel }, { kind: 'platform' });
        } catch (err) {
          if (isAppError(err) && err.code === 'NOT_FOUND') throw invalid(f.path, 'File not found; upload it again');
          if (isAppError(err) && (err.code === 'ASSET_NOT_OWNED' || err.code === 'VALIDATION_FAILED')) throw invalid(f.path, 'Use a picture uploaded for store content');
          throw err;
        }
        attached.push(f.id);
      }
    } catch (err) {
      await undo();
      throw err;
    }
    let out: T;
    try {
      out = await save();
    } catch (err) {
      await undo();
      throw err;
    }
    const next = new Set(after.map((f) => f.id));
    for (const id of prev) {
      if (next.has(id)) continue;
      await this.media.detach(id, usage).catch((err) => this.ctx.log.warn({ err, assetId: id }, 'food: could not detach a file'));
    }
    return out;
  }

  protected async detachAll(kind: UsageKind, refId: string, ids: (string | null | undefined)[]) {
    for (const id of ids.filter((i): i is string => Boolean(i))) await this.media.detach(id, { module: 'food', kind, refId }).catch((err) => this.ctx.log.warn({ err, assetId: id }, 'food: could not detach a file'));
  }
}
