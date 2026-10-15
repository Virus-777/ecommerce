/**
 * Shared plumbing of the promotions use cases: time, settings, events, audit, the campaign log, optional
 * modules and lookups of offers, products, sellers and categories. The use cases live in the part classes.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { StateMachine } from '../../../kernel/lib/state-machine.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import { pctOf, type CampaignModel, type OfferAttrs } from '../domain/rules.js';
import { toModel } from '../mappers.js';
import type { CampaignRec } from '../ports.js';
import type { PromotionsRepository } from '../repository.js';
import type { CampaignsPart } from './campaigns.js';
import type { CheckoutPart } from './checkout.js';
import type { OpsPart } from './ops.js';
import type { ParticipationPart } from './participation.js';
import type { SellerDiscountsPart } from './seller-discounts.js';
import type { StorefrontPart } from './storefront.js';

export interface PromotionsServiceDeps {
  repo: PromotionsRepository;
  ctx: ModuleContext<'promotions'>;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

export interface Parts {
  campaigns: CampaignsPart;
  participation: ParticipationPart;
  sellerDiscounts: SellerDiscountsPart;
  storefront: StorefrontPart;
  checkout: CheckoutPart;
  ops: OpsPart;
}

type OwnEvent = keyof EventMap & `promotions.${string}`;
type Optional = Parameters<ModuleContext<'promotions'>['tryUse']>[0];
type SettingKey = Parameters<ModuleContext<'promotions'>['settings']['get']>[0];

export const SYSTEM: common.Actor = { kind: 'system', id: null };
/** Example fee rate used until finance confirms the seller's rate */
export const EXAMPLE_FEE_BPS = 1000;

export const invalid = (issues: { path: string; message: string }[], message = 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);

/** An offer with what promotions shows and matches on */
export interface OfferCard {
  offer: offers.Offer;
  attrs: OfferAttrs;
  title: string;
  image: common.MediaRef | null;
  categoryId: string | null;
  sellerName: string;
  /** Storefront slug (/shop/:slug); null for the Official Store or when sellers can't answer */
  sellerSlug: string | null;
  stock: number | null;
}

export class Core {
  readonly repo: PromotionsRepository;
  readonly ctx: ModuleContext<'promotions'>;
  parts!: Parts;
  #categories?: { at: number; parents: Map<string, string | null>; names: Map<string, string> };

  constructor(deps: PromotionsServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
  }

  now = () => this.ctx.clock.now();
  currency = () => this.ctx.config.market.currency || 'USD';
  /** Market date YYYY-MM-DD */
  today = (at: Date = this.now()) => dateInZone(at, this.ctx.config.market.timeZone);
  setting = <K extends SettingKey>(key: K) => this.ctx.settings.get(key);

  /** Was-price look-back window: offers owns it (decision O5), promotions reads offers.wasPriceLookbackDays */
  async lookbackDays(): Promise<number> {
    const v = Number(await this.ctx.settings.read('offers.wasPriceLookbackDays'));
    return Number.isFinite(v) && v > 0 ? v : 30;
  }

  async ttlMinutes(): Promise<number> {
    const v = Number(await this.setting('reservationTtlMinutes'));
    return Number.isFinite(v) && v > 0 ? v : 30;
  }

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, action: entry.action }, 'promotions: audit entry not written');
    }
  }

  /** One row of the campaign history */
  async log(repo: PromotionsRepository, campaignId: string, action: string, by: { actor: common.Actor }, reason?: string | null, detail?: unknown) {
    await repo.insert('campaign_log', {
      id: newId(),
      campaign_id: campaignId,
      action,
      reason: reason ?? null,
      detail: (detail ?? null) as never,
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
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, module }, `promotions: ${module} could not answer`);
      return undefined;
    }
  }

  step<S extends string = string>(machine: StateMachine<string, string>, from: string, event: string, to?: string): S {
    return machine.next(from as never, event as never, to as never) as S;
  }

  principalOf(by: By): Principal {
    if (by.principal) return by.principal;
    return { kind: 'staff', audience: 'admin', accountId: by.actor.id ?? null, sessionId: `promotions:${by.actor.kind}`, name: by.actor.name ?? null };
  }

  /* ---------------------------------------------------------------- campaigns */

  async models(rows: readonly CampaignRec[], repo: PromotionsRepository = this.repo): Promise<CampaignModel[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [targets, codes] = await Promise.all([repo.find('campaign_targets', { campaign_id: ids }), repo.find('coupon_codes', { campaign_id: ids, kind: 'shared' })]);
    const unique = new Set((await repo.find('coupon_codes', { campaign_id: ids, kind: 'unique' }, { limit: 10000 })).map((c) => c.campaign_id));
    return rows.map((r) => {
      const model = toModel(
        r,
        targets.filter((t) => t.campaign_id === r.id),
        codes.filter((c) => c.campaign_id === r.id),
      );
      model.hasUniqueCodes = unique.has(r.id);
      return model;
    });
  }

  async campaign(id: string, o: { repo?: PromotionsRepository; forUpdate?: boolean } = {}): Promise<{ row: CampaignRec; model: CampaignModel }> {
    const repo = o.repo ?? this.repo;
    const row = isUuid(id) ? await repo.get('campaigns', id, { forUpdate: o.forUpdate }) : undefined;
    if (!row) throw notFound('Campaign');
    const [model] = await this.models([row], repo);
    return { row, model: model! };
  }

  /* ---------------------------------------------------------------- lookups in other modules */

  /** The category and its ancestors (catalog tree, cached for 5 minutes) */
  async categoryChain(categoryId: string | null | undefined): Promise<string[]> {
    if (!categoryId) return [];
    const now = Date.now();
    if (!this.#categories || now - this.#categories.at > 300_000) {
      let tree: unknown[] = [];
      try {
        tree = await this.ctx.use('catalog').listCategories({ includeHidden: true });
      } catch (err) {
        if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'promotions: category tree unavailable');
      }
      const parents = new Map<string, string | null>();
      const names = new Map<string, string>();
      const walk = (list: { id: string; parentId?: string | null; name: string; children?: unknown[] }[], parent: string | null) => {
        for (const c of list) {
          parents.set(c.id, c.parentId ?? parent);
          names.set(c.id, c.name);
          walk((c.children ?? []) as never, c.id);
        }
      };
      walk((tree ?? []) as never, null);
      this.#categories = { at: now, parents, names };
    }
    const chain: string[] = [];
    let cur: string | null | undefined = categoryId;
    while (cur && !chain.includes(cur) && chain.length < 12) {
      chain.push(cur);
      cur = this.#categories.parents.get(cur);
    }
    return chain;
  }

  /** Catalog product or null (unknown product, or catalog unable to answer) */
  async product(productId: string): Promise<{ title: string; image: common.MediaRef | null; categoryId: string | null; brandId: string | null } | null> {
    try {
      const p = await this.ctx.use('catalog').getProduct(productId);
      return p ? { title: p.title, image: p.images?.[0] ?? null, categoryId: p.categoryId ?? null, brandId: p.brand?.id ?? null } : null;
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, productId }, 'promotions: product lookup failed');
      return null;
    }
  }

  async sellerNames(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    return new Map([...(await this.sellerCards(ids))].map(([id, s]) => [id, s.name]));
  }

  /** Store name and storefront slug per seller (sellers.getSellers); sellers it can't answer for are left out */
  async sellerCards(ids: readonly (string | null | undefined)[]): Promise<Map<string, { name: string; slug: string | null }>> {
    const wanted = [...new Set(ids.filter((i): i is string => isUuid(i)))];
    const out = new Map<string, { name: string; slug: string | null }>();
    if (!wanted.length) return out;
    const list = await this.optional('sellers', (s) => s.getSellers(wanted));
    for (const s of list ?? []) out.set(s.id, { name: s.storeName, slug: s.slug ?? null });
    return out;
  }

  /** Available units per stock item (inventory), when inventory answers */
  async stockOf(stockItemIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const ids = [...new Set(stockItemIds.filter(Boolean))];
    if (!ids.length) return out;
    const r = await this.optional('inventory', (i) => i.getAvailability(ids));
    for (const [id, v] of Object.entries(r ?? {})) out.set(id, v.available);
    return out;
  }

  /** Attributes of an offer for scope rules */
  async attrsOf(offer: offers.Offer, product?: { categoryId: string | null; brandId: string | null } | null): Promise<OfferAttrs> {
    const p = product === undefined ? await this.product(offer.productId) : product;
    return {
      offerId: offer.id,
      productId: offer.productId,
      sellerId: offer.sellerId ?? null,
      official: offer.ownerType === 'official',
      categoryIds: await this.categoryChain(p?.categoryId),
      brandId: p?.brandId ?? null,
    };
  }

  /** Offer cards for a set of offers (offers + catalog + inventory + sellers); unknown offers are left out */
  async offerCards(offerIds: readonly string[], o: { sellerId?: string; withStock?: boolean } = {}): Promise<Map<string, OfferCard>> {
    const ids = [...new Set(offerIds.filter(isUuid))];
    const out = new Map<string, OfferCard>();
    if (!ids.length) return out;
    const api = this.ctx.use('offers');
    // one batch read (any status) unless a seller reads its own offers (scoped per offer)
    const sellerId = o.sellerId;
    const found = sellerId ? await Promise.all(ids.map((id) => api.getOwnOffer(sellerId, id))) : Object.values(await api.getOffers(ids));
    const list = found.filter((x): x is offers.Offer => Boolean(x));
    const products = new Map<string, Awaited<ReturnType<Core['product']>>>();
    for (const pid of new Set(list.map((x) => x.productId))) products.set(pid, await this.product(pid));
    const stock = o.withStock === false ? new Map<string, number>() : await this.stockOf(list.map((x) => x.stockItemId));
    const sellers = await this.sellerCards(list.map((x) => x.sellerId));
    for (const offer of list) {
      const p = products.get(offer.productId) ?? null;
      const seller = offer.ownerType === 'official' ? undefined : sellers.get(offer.sellerId ?? '');
      out.set(offer.id, {
        offer,
        attrs: await this.attrsOf(offer, p),
        title: p?.title ?? offer.sellerSku ?? 'Product',
        image: p?.image ?? null,
        categoryId: p?.categoryId ?? null,
        sellerName: offer.ownerType === 'official' ? OFFICIAL_STORE_NAME : (seller?.name ?? offer.sellerName ?? 'Seller'),
        // the Official Store has no seller storefront
        sellerSlug: seller?.slug ?? null,
        stock: stock.has(offer.stockItemId) ? stock.get(offer.stockItemId)! : null,
      });
    }
    return out;
  }

  /** Fee at a price after the seller-funded part: finance's rule, or the example rate while finance can't answer */
  async feeCalculator(categoryId: string | null, price: number): Promise<{ rateBps: number; isExample: boolean; feeAt: (basis: number) => number }> {
    const cur = this.currency();
    const r = await this.optional('finance', (f) => f.calculateFee({ categoryId, itemPrice: { amount: price, currency: cur } }));
    const rateBps = r?.rateBps ?? EXAMPLE_FEE_BPS;
    return { rateBps, isExample: !r, feeAt: (basis) => pctOf(basis, rateBps) };
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
