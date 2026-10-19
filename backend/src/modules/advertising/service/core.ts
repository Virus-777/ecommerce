/**
 * Shared plumbing of the advertising use cases: time and market days, settings, events, audit, the campaign
 * log, optional modules, small caches (placements, global rules) and name lookups. The use cases live in the part classes.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { secretFor } from '../../../kernel/lib/secrets.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type { GlobalRules, Placement } from '../../../spec/advertising.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import { DEFAULT_RULES, pagesLabel, requiredDevices, type ReviewRole, type RuleValues } from '../domain/rules.js';
import type { PlacementRec, RulesRec, Span } from '../ports.js';
import type { AdvertisingRepository } from '../repository.js';
import type { BillingPart } from './billing.js';
import type { CampaignsPart } from './campaigns.js';
import type { CreativesPart } from './creatives.js';
import type { OpsPart } from './ops.js';
import type { ReportsPart } from './reports.js';
import type { SellerPart } from './sellers.js';
import type { ServingPart } from './serving.js';
import type { SetupPart } from './setup.js';
import type { ViewsPart } from './views.js';

export interface AdvertisingServiceDeps {
  repo: AdvertisingRepository;
  ctx: ModuleContext<'advertising'>;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

export interface Parts {
  views: ViewsPart;
  campaigns: CampaignsPart;
  creatives: CreativesPart;
  setup: SetupPart;
  serving: ServingPart;
  sellers: SellerPart;
  billing: BillingPart;
  reports: ReportsPart;
  ops: OpsPart;
}

type OwnEvent = keyof EventMap & `advertising.${string}`;
type Optional = Parameters<ModuleContext<'advertising'>['tryUse']>[0];
type SettingKey = Parameters<ModuleContext<'advertising'>['settings']['get']>[0];

const REVIEW_ROLES: readonly ReviewRole[] = ['advertising', 'content', 'marketing'];
/** access role key → the advertising review step it reviews */
const ROLE_STEP: Record<string, ReviewRole> = { advertising_manager: 'advertising', content_manager: 'content', marketing_manager: 'marketing' };

export const SYSTEM: common.Actor = { kind: 'system', id: null };
export const SYSTEM_BY: By = { actor: SYSTEM };

export const invalid = (issues: { path: string; message: string }[], message = 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);

/** Rows grouped by a key, in their order (Map.groupBy, which the ES2023 lib of this project does not have yet) */
export function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const list = out.get(key(r));
    if (list) list.push(r);
    else out.set(key(r), [r]);
  }
  return out;
}

/** Actors in text columns: kind:id */
export const encodeActor = (a: common.Actor | null | undefined): string => (a ? (a.id ? `${a.kind}:${a.id}` : a.kind) : 'system');
export function decodeActor(s: string | null | undefined): common.Actor | null {
  if (!s) return null;
  const i = s.indexOf(':');
  const kind = (i < 0 ? s : s.slice(0, i)) as common.Actor['kind'];
  return { kind, id: i < 0 ? null : s.slice(i + 1) };
}

export interface ProductInfo {
  id: string;
  title: string;
  image: common.MediaRef | null;
  categoryId: string | null;
  brandId: string | null;
  brandName: string | null;
}

export interface OfferInfo {
  offer: offers.Offer;
  productId: string;
  title: string;
  image: common.MediaRef | null;
  categoryId: string | null;
  sellerName: string;
  /** Available units (null when inventory can't answer) */
  available: number | null;
  /** Active with enough stock to be promoted */
  promotable: boolean;
  reason: string | null;
}

const CACHE_MS = 15_000;
/** Most offers or products kept in the one-minute caches; a full cache starts over */
const CACHE_ENTRIES = 5_000;

export class Core {
  readonly repo: AdvertisingRepository;
  readonly ctx: ModuleContext<'advertising'>;
  parts!: Parts;
  #placements?: { at: number; rows: PlacementRec[] };
  #rules?: { at: number; rules: GlobalRules };
  #staff = new Map<string, { at: number; name: string | null }>();
  #secret?: string;

  constructor(deps: AdvertisingServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
  }

  now = () => this.ctx.clock.now();
  tz = () => this.ctx.config.market.timeZone || 'America/Los_Angeles';
  currency = () => this.ctx.config.market.currency || 'USD';
  money = (amount: number, currency = this.currency()): common.Money => ({ amount, currency });
  /** Market date YYYY-MM-DD */
  today = (at: Date = this.now()) => dateInZone(at, this.tz());
  dayStart = (day: string) => zonedTimeToUtc(day, '00:00', this.tz());
  addDays = (day: string, n: number) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  /** Instants of market days from..to (inclusive) */
  span = (from: string, to: string): Span => ({ from: this.dayStart(from), to: this.dayStart(this.addDays(to, 1)) });
  setting = <K extends SettingKey>(key: K) => this.ctx.settings.get(key);
  async num(key: SettingKey, fallback: number): Promise<number> {
    try {
      const v = Number(await this.setting(key));
      return Number.isFinite(v) && v > 0 ? v : fallback;
    } catch {
      return fallback;
    }
  }

  get secret(): string {
    this.#secret ??= secretFor(this.ctx.config, 'advertising.impressions');
    return this.#secret;
  }

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'advertising', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, action: entry.action }, 'advertising: audit entry not written');
    }
  }

  /** One row of the campaign timeline */
  async log(repo: AdvertisingRepository, campaignId: string, action: string, by: { actor: common.Actor }, o: { from?: string | null; to?: string | null; reason?: string | null } = {}) {
    await repo.insert('campaign_log', {
      id: newId(),
      campaign_id: campaignId,
      action,
      from_status: o.from ?? null,
      to_status: o.to ?? null,
      reason: o.reason ?? null,
      actor_kind: by.actor.kind,
      actor_id: by.actor.id ?? null,
      at: this.now(),
    });
  }

  /** Calls an optional module; off, not built or failing → undefined (reads degrade, the response still answers) */
  async optional<M extends Optional, R>(module: M, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, module }, `advertising: ${module} could not answer`);
      return undefined;
    }
  }

  /** media is a dependency, but reads (previews, refs) degrade rather than fail when it can't answer */
  async optionalMedia<R>(fn: (api: PublicApiMap['media']) => Promise<R>): Promise<R | undefined> {
    try {
      return await fn(this.ctx.use('media'));
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'advertising: media could not answer');
      return undefined;
    }
  }

  principalOf(by: By): Principal {
    if (by.principal) return by.principal;
    return { kind: 'staff', audience: 'admin', accountId: by.actor.id ?? null, sessionId: `advertising:${by.actor.kind}`, name: by.actor.name ?? null };
  }

  /* ---------------------------------------------------------------- placements and rules (cached) */

  invalidate() {
    this.#placements = undefined;
    this.#rules = undefined;
    this.parts?.serving?.invalidate();
  }

  /**
   * The review step a staff member acts on, from their access roles (access.rolesOf), never from the request alone:
   * Advertising Manager → advertising, Content Manager → content, Marketing Manager → marketing, Business Owner any.
   * `requested` only picks among the caller's own steps (a step their roles do not cover is FORBIDDEN); without it the
   * caller's single applicable step is used, preferring `waiting` steps, else VALIDATION_FAILED asks for one.
   */
  async reviewRoleFor(by: By, requested: ReviewRole | null | undefined, o: { applicable?: (r: ReviewRole) => boolean; waiting?: (r: ReviewRole) => boolean } = {}): Promise<ReviewRole> {
    const accountId = by.principal?.accountId ?? (by.actor.kind === 'staff' ? by.actor.id : null);
    const roles = accountId ? await this.ctx.use('access').rolesOf(accountId) : [];
    const mine = new Set<ReviewRole>();
    for (const r of roles) {
      if (r.key === 'business_owner') for (const x of REVIEW_ROLES) mine.add(x);
      const mapped = ROLE_STEP[r.key];
      if (mapped) mine.add(mapped);
    }
    if (requested) {
      if (!mine.has(requested)) throw new AppError('FORBIDDEN', `Your roles do not cover the ${requested} review step`);
      return requested;
    }
    let candidates = [...mine].filter((r) => o.applicable?.(r) ?? true);
    if (!candidates.length) throw new AppError('FORBIDDEN', 'Your roles do not cover a review step of this item');
    if (candidates.length > 1 && o.waiting) {
      const open = candidates.filter((r) => o.waiting!(r));
      if (open.length) candidates = open;
    }
    // content and marketing fill the same step: content is the default reviewer of it
    if (candidates.includes('content') && candidates.includes('marketing')) candidates = candidates.filter((r) => r !== 'marketing');
    if (candidates.length > 1) throw invalid([{ path: 'role', message: `Choose the review step: ${candidates.join(', ')}` }], 'You hold more than one reviewing role');
    return candidates[0]!;
  }

  async placementRows(): Promise<PlacementRec[]> {
    const t = Date.now();
    if (!this.#placements || t - this.#placements.at > CACHE_MS) this.#placements = { at: t, rows: await this.repo.find('placements', {}, { orderBy: [['id', 'asc']] }) };
    return this.#placements.rows;
  }

  async placementByKey(key: string): Promise<PlacementRec | undefined> {
    return (await this.placementRows()).find((p) => p.key === key);
  }

  async placementById(id: string): Promise<PlacementRec | undefined> {
    return (await this.placementRows()).find((p) => p.id === id);
  }

  /** Settings › Website and Android app › Serve the website (apps.serveWebsite): on unless set off */
  async websiteServed(): Promise<boolean> {
    const settings = this.ctx.tryUse('settings');
    if (!settings) return true;
    try {
      return (await settings.get<boolean>('apps.serveWebsite')) !== false;
    } catch (err) {
      this.ctx.log.warn({ err }, 'advertising: apps.serveWebsite unavailable; desktop images stay required');
      return true;
    }
  }

  placementView(p: PlacementRec, liveCampaigns = 0, websiteServed = true): Placement {
    const eligible = (p.eligible_pages ?? []) as string[];
    return {
      id: p.id,
      key: p.key as Placement['key'],
      name: p.name,
      description: p.description,
      kind: p.kind as Placement['kind'],
      enabled: p.enabled,
      availability: p.availability as Placement['availability'],
      eligiblePages: eligible,
      pagesLabel: pagesLabel(eligible),
      formats: (p.formats ?? []) as never,
      requiredDevices: requiredDevices((p.formats ?? []) as never, websiteServed),
      frequencyCap: (p.frequency_cap ?? null) as never,
      trigger: (p.trigger ?? null) as never,
      rotation: p.rotation as never,
      dismissal: p.dismissal as never,
      maxPerPage: p.max_per_page,
      positions: (p.positions ?? null) as never,
      label: p.label as Placement['label'],
      liveCampaigns,
      version: p.version,
      updatedAt: p.updated_at.toISOString(),
      updatedBy: decodeActor(p.updated_by),
    };
  }

  rulesOf(row: RulesRec): GlobalRules {
    const r = { ...DEFAULT_RULES, ...((row.rules ?? {}) as Partial<RuleValues>) } as RuleValues & { state?: string };
    return {
      blockedPages: r.blockedPages,
      overlaysPerPageView: r.overlaysPerPageView,
      labelRequired: r.labelRequired,
      closeControlMinPx: r.closeControlMinPx,
      removeUnavailable: r.removeUnavailable,
      sellerNamedOnPromotedOffers: r.sellerNamedOnPromotedOffers,
      dismissStopsForSession: r.dismissStopsForSession,
      paidSellerAdsEnabled: r.paidSellerAdsEnabled,
      attributionDays: r.attributionDays,
      attributionBasis: 'click',
      version: row.version,
      effectiveAt: row.effective_at.toISOString(),
      updatedBy: decodeActor(row.created_by),
      approval: null,
    };
  }

  /** Rules in force now: the highest approved version whose effective time has come */
  async rules(): Promise<GlobalRules> {
    const t = Date.now();
    if (this.#rules && t - this.#rules.at <= CACHE_MS) return this.#rules.rules;
    const rows = await this.repo.find('global_rules', { effective_at: { op: '<=', value: this.now() } }, { orderBy: [['version', 'desc']], limit: 50 });
    const row = rows.find((r) => ((r.rules ?? {}) as { state?: string }).state === 'approved');
    const rules = row ? this.rulesOf(row) : { ...DEFAULT_RULES, version: 1, effectiveAt: new Date(0).toISOString(), updatedBy: null, approval: null };
    this.#rules = { at: t, rules };
    return rules;
  }

  /* ---------------------------------------------------------------- promoted offers (cached for a minute; offer and stock events clear entries) */

  #offers = new Map<string, { at: number; info: OfferInfo | null }>();
  #products = new Map<string, { at: number; p: ProductInfo | null }>();

  forgetOffers(ids?: readonly string[]) {
    if (!ids) this.#offers.clear();
    else for (const id of ids) this.#offers.delete(id);
  }

  async product(productId: string): Promise<ProductInfo | null> {
    const t = Date.now();
    const hit = this.#products.get(productId);
    if (hit && t - hit.at < 60_000) return hit.p;
    const p = await this.optional('catalog', (c) => c.getProduct(productId));
    const info = p ? { id: p.id, title: p.title, image: p.images?.[0] ?? null, categoryId: p.categoryId ?? null, brandId: p.brand?.id ?? null, brandName: p.brand?.name ?? null } : null;
    // every viewed product page can land here: keep the cache bounded
    if (this.#products.size >= CACHE_ENTRIES) this.#products.clear();
    this.#products.set(productId, { at: t, p: info });
    return info;
  }

  /**
   * Promoted offers with what serving and checks need: undefined when the offers module can't answer
   * (checks are then skipped), otherwise one entry per id (null for unknown offers).
   */
  async offerInfo(offerIds: readonly string[]): Promise<Map<string, OfferInfo | null> | undefined> {
    const ids = [...new Set(offerIds)];
    const out = new Map<string, OfferInfo | null>();
    if (!ids.length) return out;
    if (!this.ctx.tryUse('offers')) return undefined;
    const t = Date.now();
    const missing = ids.filter((id) => {
      const hit = this.#offers.get(id);
      if (hit && t - hit.at < 60_000) {
        out.set(id, hit.info);
        return false;
      }
      return true;
    });
    if (!missing.length) return out;
    const found = await this.optional('offers', (o) => o.getOffers(missing));
    if (!found) return out.size ? out : undefined;
    const offers = Object.values(found).filter((x): x is NonNullable<typeof x> => Boolean(x));
    const byId = new Map(offers.map((o) => [o.id, o]));
    const [stock, minStock, sellerNames] = await Promise.all([
      this.optional('inventory', (i) => i.getAvailability(offers.map((o) => o.stockItemId))).then((s) => s ?? {}),
      this.num('minPromotedStock', 10),
      this.sellerNames(offers.map((o) => o.sellerId)),
    ]);
    const productIds = [...new Set(offers.map((o) => o.productId))];
    const products = new Map(await Promise.all(productIds.map(async (id) => [id, await this.product(id)] as const)));
    if (this.#offers.size >= CACHE_ENTRIES) this.#offers.clear();
    for (const id of missing) {
      const o = byId.get(id);
      if (!o) {
        out.set(id, null);
        this.#offers.set(id, { at: t, info: null });
        continue;
      }
      const p = products.get(o.productId);
      const available = stock[o.stockItemId]?.available ?? null;
      const reason = o.status !== 'active' ? `Offer is ${o.status.replace(/_/g, ' ')}` : available !== null && available < 1 ? 'Out of stock' : available !== null && available < minStock ? `Only ${available} in stock (at least ${minStock} needed)` : null;
      const info: OfferInfo = {
        offer: o,
        productId: o.productId,
        title: p?.title ?? o.sellerSku ?? 'Product',
        image: p?.image ?? null,
        categoryId: p?.categoryId ?? null,
        sellerName: o.ownerType === 'official' ? OFFICIAL_STORE_NAME : (sellerNames.get(o.sellerId ?? '') ?? o.sellerName ?? 'Seller'),
        available,
        promotable: reason === null,
        reason,
      };
      out.set(id, info);
      this.#offers.set(id, { at: t, info });
    }
    return out;
  }

  /* ---------------------------------------------------------------- names */

  async sellerNames(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((i): i is string => Boolean(i)))];
    const out = new Map<string, string>();
    if (!wanted.length) return out;
    const list = await this.optional('sellers', (s) => s.getSellers(wanted));
    for (const s of list ?? []) out.set(s.id, s.storeName);
    return out;
  }

  /** Staff display names (cached for a few minutes) */
  async staffNames(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const t = Date.now();
    for (const id of new Set(ids.filter((i): i is string => Boolean(i)))) {
      let hit = this.#staff.get(id);
      if (!hit || t - hit.at > 300_000) {
        let name: string | null = null;
        try {
          name = (await this.ctx.use('access').getStaffRef(id))?.name ?? null;
        } catch {
          name = null;
        }
        hit = { at: t, name };
        this.#staff.set(id, hit);
      }
      if (hit.name) out.set(id, hit.name);
    }
    return out;
  }

  /** Actors with names where cheap (staff and sellers) */
  async named(actors: readonly (common.Actor | null)[]): Promise<(common.Actor | null)[]> {
    const staff = await this.staffNames(actors.filter((a) => a?.kind === 'staff').map((a) => a!.id));
    return actors.map((a) => (a && !a.name && a.kind === 'staff' && a.id && staff.has(a.id) ? { ...a, name: staff.get(a.id)! } : a));
  }
}

/** Base class of the use-case parts */
export abstract class Part {
  constructor(protected readonly core: Core) {}
  protected get repo() {
    return this.core.repo;
  }
  protected get ctx() {
    return this.core.ctx;
  }
  protected get parts() {
    return this.core.parts;
  }
  protected now() {
    return this.core.now();
  }
}
