/**
 * Storefront reads and customer actions: promotion prices per offer (same price rules as the cart), honest
 * was prices, the Deals page (flash sales, coupons, clearance, events), coupon clipping, event reminders,
 * code look-ups, seller promotion banners and the public face of a campaign.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import { pageOf, toPageRequest, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import type * as offers from '../../../spec/offers.js';
import type { AccountCoupons, CodeCheck, CouponCard, DealProduct, DealsPage, DiscountAllocation, FlashCountdown, FlashSaleBlock, OfferPromotion, ProductPromotions, PromoBadge, PromoBanner, PublicCampaign, UpcomingEvent } from '../../../spec/promotions.js';
import { evaluate, type EvalLine, type PriceOption } from '../domain/evaluate.js';
import { amountAndUnit, bpsLabel, COUPON_KINDS, customerCheck, dayLabel, discountLabel, isRunning, m, moneyLabel, needsConsent, PRICE_KINDS, scopeCheck, scopeLabel, SHIPPING_KINDS, type CampaignModel, type OfferAttrs } from '../domain/rules.js';
import { groupBy, iso, periodOf } from '../mappers.js';
import type { FlashItemRec } from '../ports.js';
import { invalid, notFound, Part, type OfferCard } from './core.js';

const PUBLIC_STATUSES = ['scheduled', 'live', 'paused', 'ended', 'cancelled'];
const COUPON_RULES = (perPackage: number) => [
  "Coupons can't be combined with flash sale prices unless the coupon says so.",
  perPackage === 1 ? 'One coupon per seller per order.' : `Up to ${perPackage} coupons per seller package.`,
  'Clipped coupons apply automatically at checkout when your cart qualifies.',
];

export class StorefrontPart extends Part {
  #codeChecks = new Map<string, number[]>();

  /* ---------------------------------------------------------------- prices */

  isCouponType = (c: CampaignModel) => COUPON_KINDS.includes(c.kind) || SHIPPING_KINDS.includes(c.kind);
  /** Shown as a clippable coupon card (Deals page, product page, My coupons) */
  isCard = (c: CampaignModel) => this.isCouponType(c) && Boolean((c.deals?.show && c.deals.section === 'coupons') || (c.autoApply && c.code));

  /** Promotion prices through the same rules as the cart (a one-unit cart per offer, no codes) */
  async priceOffers(offerIds: string[], ctx: { customerId?: string; at?: string }): Promise<OfferPromotion[]> {
    const ids = [...new Set(offerIds.filter(isUuid))];
    if (!ids.length) return [];
    const at = ctx.at ? new Date(ctx.at) : this.now();
    const list = await this.ctx.use('offers').listActiveOffersByIds(ids);
    return this.priceList(list, at, ctx.customerId ?? null);
  }

  async priceList(list: offers.Offer[], at: Date, customerId: string | null): Promise<OfferPromotion[]> {
    if (!list.length) return [];
    const ids = list.map((o) => o.id);
    // price campaigns and coupons in one read (both running at `at`); the order (soonest ending first) is kept per kind
    const runningAll = await this.core.models(await this.repo.runningCampaigns(at, { kinds: [...PRICE_KINDS, ...COUPON_KINDS] }));
    const running = runningAll.filter((c) => PRICE_KINDS.includes(c.kind));
    const upcomingFlash = (await this.core.models(await this.repo.find('campaigns', { status: 'scheduled', kind: 'flash_sale', starts_at: { op: '>', value: at } }, { limit: 50 }))).filter((c) => c.startsAt.getTime() - at.getTime() <= 7 * 86_400_000);
    const flashIds = [...running.filter((c) => c.kind === 'flash_sale'), ...upcomingFlash].map((c) => c.id);
    const flashRows = flashIds.length ? await this.repo.find('flash_items', { campaign_id: flashIds, offer_id: ids }) : [];
    const flashOf = new Map(flashRows.map((f) => [`${f.campaign_id}:${f.offer_id}`, f]));
    const eligible = new Set((await this.repo.eligibleFor(ids, running.map((c) => c.id))).map((e) => `${e.campaign_id}:${e.offer_id}`));
    // automatic discounts the customer gets without doing anything: autoApply coupons for everyone (or every signed-in
    // customer). A minimum spend counts when one unit of the offer reaches it (the one-unit evaluation below decides);
    // category and brand scopes are resolved from catalog (one batch read) when such a campaign runs.
    const automatic = runningAll.filter(
      (c) => COUPON_KINDS.includes(c.kind) && c.autoApply && (c.discount.percentOffBps || c.discount.amountOff) && (c.eligibility.audience === 'everyone' || (c.eligibility.audience === 'signed_in' && Boolean(customerId))),
    );
    const needsProduct = automatic.some((c) => [...c.scope.include, ...c.scope.exclude].some((t) => t.kind === 'category' || t.kind === 'brand'));
    const productFacts = needsProduct ? await this.productFacts(list.map((o) => o.productId)) : new Map<string, { categoryIds: string[]; brandId: string | null }>();
    const consents = await this.parts.participation.consents([...running, ...automatic].filter(needsConsent).map((c) => c.id));
    const usage = new Map<string, { uses: number; units: number }>();
    if (customerId && (running.length || automatic.length)) {
      const keys = [customerId, ...ids.map((o) => `${customerId}:${o}`)];
      for (const u of await this.repo.find('usage_counters', { campaign_id: [...running, ...automatic].map((c) => c.id), customer_key: keys })) usage.set(u.customer_key === customerId ? u.campaign_id : `${u.campaign_id}:${u.customer_key.slice(customerId.length + 1)}`, { uses: u.uses, units: u.units });
    }
    const lines: EvalLine[] = [];
    const priceOptions = new Map<string, PriceOption[]>();
    for (const o of list) {
      const sellerId = o.sellerId ?? OFFICIAL_STORE_ID;
      const pf = productFacts.get(o.productId);
      const attrs: OfferAttrs = { offerId: o.id, productId: o.productId, sellerId: o.sellerId ?? null, official: o.ownerType === 'official', categoryIds: pf?.categoryIds ?? [], brandId: pf?.brandId ?? null };
      lines.push({ lineId: o.id, offerId: o.id, productId: o.productId, variantId: o.variantId, sellerId, officialStore: attrs.official, categoryId: pf?.categoryIds[0] ?? null, quantity: 1, unitPrice: o.price, packageId: o.id, attrs });
      const opts: PriceOption[] = [];
      for (const c of running) {
        if (!eligible.has(`${c.id}:${o.id}`)) continue;
        let consentBps: number | null = null;
        if (!attrs.official && needsConsent(c)) {
          const s = consents.get(c.id)?.get(sellerId);
          if (!s?.offerIds.has(o.id)) continue;
          consentBps = s.platformBps;
        }
        const f = flashOf.get(`${c.id}:${o.id}`);
        if (c.kind === 'flash_sale' && !f) continue;
        opts.push({ campaign: c, consentBps, flash: f ? { dealPrice: f.deal_price, regularPrice: f.regular_price, dealStock: f.deal_stock, claimed: f.claimed, reserved: f.reserved, purchaseLimit: f.purchase_limit, state: f.state } : null });
      }
      priceOptions.set(o.id, opts);
    }
    // a one-unit cart per offer: amounts, minimum spends and budgets are judged per offer, never split across the list
    const coupons = automatic.map((c) => ({ campaign: c, source: 'automatic' as const, code: null, codeInfo: null }));
    const evalLines = lines.map((ln) => evaluate({
      at,
      currency: list[0]!.price.currency,
      customerId,
      signedIn: Boolean(customerId),
      isNewCustomer: null,
      region: null,
      couponsPerPackage: 1,
      lines: [ln],
      shipping: null,
      priceOptions: new Map([[ln.lineId, priceOptions.get(ln.lineId) ?? []]]),
      coupons,
      rejected: [],
      usage,
      consents,
    }).lines[0]!);
    const automaticById = new Map(automatic.map((c) => [c.id, c]));
    const promos = await this.activeSellerPromotions([...new Set(list.map((o) => o.sellerId).filter((s): s is string => Boolean(s)))], { customerId: customerId ?? undefined, at: at.toISOString() }, true);
    const byId = new Map(running.map((c) => [c.id, c]));
    const upcomingById = new Map(upcomingFlash.map((c) => [c.id, c]));
    const days = await this.core.lookbackDays();
    const priced = list.map((o, i) => {
      const l = evalLines[i]!;
      return { o, l, off: l.regularUnitPrice.amount - l.unitPrice.amount, priceCampaign: l.allocations.map((a) => byId.get(a.campaignId)).find(Boolean) ?? null };
    });
    // honest was prices: one offers read per discounted offer, side by side
    const refs = await Promise.all(priced.map(({ o, off, priceCampaign }) => (off > 0 && priceCampaign ? this.referencePriceAt(o.id, priceCampaign.startsAt, days) : null)));
    return priced.map(({ o, l, off, priceCampaign }, i) => {
      const badges: PromoBadge[] = [];
      if (off > 0) badges.push({ label: `−${bpsLabel(Math.round((off * 10000) / l.regularUnitPrice.amount))}`, kind: priceCampaign?.kind === 'flash_sale' ? 'flash' : 'deal' });
      for (const a of l.allocations) {
        const c = byId.get(a.campaignId);
        if (!c) continue;
        if (c.kind === 'flash_sale' && !badges.some((b) => b.label === 'Flash deal')) badges.push({ label: 'Flash deal', kind: 'flash' });
        if (c.deals?.section === 'clearance' && !badges.some((b) => b.kind === 'clearance')) badges.push({ label: 'Clearance', kind: 'clearance' });
        if (c.ownerKind === 'platform' && c.kind !== 'flash_sale') badges.push({ label: c.name, kind: 'campaign' });
      }
      const sellerPromos = (o.sellerId ? (promos[o.sellerId] ?? []) : []).filter((b) => (b as PromoBanner & { offerIds?: string[] }).offerIds?.includes(o.id) ?? true).map(({ offerIds: _o, ...b }: PromoBanner & { offerIds?: string[] }) => b);
      if (sellerPromos.some((p) => /free shipping/i.test(p.title + p.detail))) badges.push({ label: 'Free shipping', kind: 'free_shipping' });
      const ref = refs[i];
      const honest = ref && priceCampaign && ref.amount > l.unitPrice.amount;
      const wasPrice: common.Money | null = honest ? ref : null;
      const wasPriceRule = honest ? `Lowest price from this seller in the ${days} days before ${dayLabel(priceCampaign.startsAt, priceCampaign.timeZone)}` : null;
      // no countdown for a deal the offer's raised price keeps from applying (evaluate)
      const flashRow = flashRows.find((f) => f.offer_id === o.id && o.price.amount <= f.regular_price && (byId.get(f.campaign_id)?.kind === 'flash_sale' || upcomingById.has(f.campaign_id)));
      const flashCampaign = flashRow ? (byId.get(flashRow.campaign_id) ?? upcomingById.get(flashRow.campaign_id)) : undefined;
      return {
        offerId: o.id,
        regularPrice: l.regularUnitPrice,
        price: l.unitPrice,
        wasPrice,
        wasPriceRule,
        badges,
        campaignId: priceCampaign?.id ?? flashCampaign?.id ?? null,
        purchaseLimit: l.purchaseLimit ?? null,
        flash: flashRow && flashCampaign ? this.countdown(flashCampaign, flashRow, at) : null,
        sellerPromos,
        ...this.automaticDiscountOf(l.allocations, automaticById, l.unitPrice.currency),
      };
    });
  }

  /** Category chain and brand per product for scope rules (catalog.getProducts, 200 ids per call); unknown products are left out */
  async productFacts(productIds: readonly string[]): Promise<Map<string, { categoryIds: string[]; brandId: string | null }>> {
    const ids = [...new Set(productIds.filter(isUuid))];
    const out = new Map<string, { categoryIds: string[]; brandId: string | null }>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      let records: catalog.ProductRecord[] = [];
      try {
        records = await this.ctx.use('catalog').getProducts(chunk);
      } catch (err) {
        // without catalog facts category and brand scopes simply do not match (no automatic discount shown)
        this.ctx.log.warn({ err }, 'promotions: catalog products unavailable for automatic discounts');
      }
      for (const r of records) out.set(r.product.id, { categoryIds: await this.core.categoryChain(r.product.categoryId), brandId: r.product.brand?.id ?? null });
    }
    return out;
  }

  /** Per-unit automatic discount on top of the price (one unit was evaluated), with its label; null when none */
  automaticDiscountOf(allocations: DiscountAllocation[], automatic: Map<string, CampaignModel>, currency: string): { automaticDiscount: common.Money | null; automaticDiscountLabel: string | null } {
    const own = allocations.filter((a) => automatic.has(a.campaignId) && a.amount.amount > 0);
    if (!own.length) return { automaticDiscount: null, automaticDiscountLabel: null };
    const amount = own.reduce((s, a) => s + a.amount.amount, 0);
    const label = own.map((a) => `${automatic.get(a.campaignId)!.name}, applied automatically`).join(' + ');
    return { automaticDiscount: m(amount, currency), automaticDiscountLabel: label };
  }

  countdown(c: CampaignModel, f: FlashItemRec, at: Date): FlashCountdown {
    const taken = f.claimed + f.reserved;
    const state: FlashCountdown['state'] = c.startsAt.getTime() > at.getTime() ? 'upcoming' : f.state === 'sold_out' ? 'sold_out' : f.state === 'ended' || !isRunning(c, at) ? 'ended' : 'active';
    return { campaignId: c.id, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString(), claimedPct: f.deal_stock > 0 ? Math.min(100, Math.floor((taken * 100) / f.deal_stock)) : 100, dealStockLeft: Math.max(0, f.deal_stock - taken), state };
  }

  async referencePriceAt(offerId: string, before: Date, days: number): Promise<common.Money | null> {
    return this.ctx.use('offers').lowestPrice(offerId, days, before.toISOString());
  }

  /** Honest was price: offers' lowest price in the look-back window before the campaign start (or now) */
  async referencePrice(offerId: string): Promise<common.Money | null> {
    const days = await this.core.lookbackDays();
    const now = this.now();
    const running = await this.core.models(await this.repo.runningCampaigns(now, { kinds: [...PRICE_KINDS] }));
    const rows = await this.repo.eligibleFor([offerId], running.map((c) => c.id));
    const start = running.filter((c) => rows.some((r) => r.campaign_id === c.id)).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0]?.startsAt;
    return this.referencePriceAt(offerId, start ?? now, days);
  }

  /* ---------------------------------------------------------------- flash sales */

  async flashBlock(c: CampaignModel): Promise<FlashSaleBlock> {
    const now = this.now();
    const state: FlashSaleBlock['state'] = isRunning(c, now) ? 'live' : c.status === 'scheduled' && c.startsAt.getTime() > now.getTime() ? 'upcoming' : 'ended';
    const secondsLeft = state === 'live' ? Math.max(0, Math.floor((c.endsAt.getTime() - now.getTime()) / 1000)) : state === 'upcoming' ? Math.max(0, Math.floor((c.startsAt.getTime() - now.getTime()) / 1000)) : 0;
    return { campaignId: c.id, name: c.name, period: periodOf(c), state, secondsLeft, items: await this.parts.campaigns.flashItems(c, undefined, { storefront: true }) };
  }

  async getFlashSale(campaignId: string): Promise<FlashSaleBlock | null> {
    if (!isUuid(campaignId)) return null;
    const row = await this.repo.get('campaigns', campaignId);
    if (!row || row.kind !== 'flash_sale' || !['scheduled', 'live', 'paused', 'ended'].includes(row.status)) return null;
    const [c] = await this.core.models([row]);
    return this.flashBlock(c!);
  }

  async liveDeals(opts: { limit: number; campaignId?: string }): Promise<FlashSaleBlock[]> {
    const limit = Math.min(Math.max(opts.limit || 1, 1), 20);
    const now = this.now();
    if (opts.campaignId !== undefined) {
      // one campaign (content SourceRule.campaignId): its block while it is live or upcoming
      if (!isUuid(opts.campaignId)) return [];
      const row = await this.repo.get('campaigns', opts.campaignId);
      if (!row || row.kind !== 'flash_sale') return [];
      const [c] = await this.core.models([row]);
      const live = isRunning(c!, now);
      const upcoming = row.status === 'scheduled' && c!.startsAt.getTime() > now.getTime();
      return live || upcoming ? [await this.flashBlock(c!)] : [];
    }
    const live = await this.repo.runningCampaigns(now, { kinds: ['flash_sale'] });
    const upcoming = live.length >= limit ? [] : await this.repo.find('campaigns', { status: 'scheduled', kind: 'flash_sale', starts_at: { op: '>', value: now } }, { orderBy: [['starts_at', 'asc']], limit: limit - live.length });
    const models = await this.core.models([...live, ...upcoming].slice(0, limit));
    const out = [];
    for (const c of models) out.push(await this.flashBlock(c));
    return out;
  }

  /* ---------------------------------------------------------------- coupons */

  fundedBy(c: CampaignModel, names: Map<string, string>): string {
    if (c.ownerKind === 'seller') return names.get(c.sellerId ?? '') ?? 'Seller';
    if (c.funding.owner === 'platform') return 'Marketly';
    if (c.funding.owner === 'shared') return 'Marketly and participating sellers';
    return 'Participating sellers';
  }

  conditions(c: CampaignModel, names: Map<string, string>): string {
    const parts: string[] = [];
    if (c.ownerKind === 'seller') parts.push(names.get(c.sellerId ?? '') ?? 'Seller');
    const scope = scopeLabel(c.scope);
    if (scope && scope !== 'Sitewide' && c.ownerKind !== 'seller') parts.push(scope);
    if (c.discount.minSpend) parts.push(`minimum spend ${moneyLabel(c.discount.minSpend.amount, c.currency)}`);
    if (c.discount.maxDiscountPerOrder) parts.push(`up to ${moneyLabel(c.discount.maxDiscountPerOrder.amount, c.currency)} off`);
    if (c.limits.perCustomer) parts.push(c.limits.perCustomer === 1 ? 'one use per customer' : `${c.limits.perCustomer} uses per customer`);
    if (c.eligibility.audience === 'new_customers') parts.push('new customers only');
    if (c.eligibility.audience === 'signed_in') parts.push('signed-in customers');
    if (c.eligibility.audience === 'regions') parts.push(`delivery to ${(c.eligibility.regions ?? []).join(', ')}`);
    return parts.join(' · ') || 'No minimum spend';
  }

  /** Coupon cards for a customer (or a guest), with clip, use and assigned-code state */
  async cards(campaigns: CampaignModel[], customerId: string | null): Promise<CouponCard[]> {
    if (!campaigns.length) return [];
    const ids = campaigns.map((c) => c.id);
    const [names, clips, assigned, usage, used] = await Promise.all([
      this.core.sellerNames(campaigns.map((c) => c.sellerId)),
      customerId ? this.repo.find('coupon_clips', { customer_id: customerId, campaign_id: ids }) : [],
      customerId ? this.repo.find('coupon_codes', { campaign_id: ids, assigned_customer_id: customerId }) : [],
      customerId ? this.repo.find('usage_counters', { campaign_id: ids, customer_key: customerId }) : [],
      customerId ? this.repo.find('redemptions', { campaign_id: ids, customer_id: customerId, state: ['committed', 'partially_reversed'] }, { orderBy: [['created_at', 'desc']] }) : [],
    ]);
    const refs = await this.parts.campaigns.orderRefs(used.map((r) => r.order_id ?? ''));
    const now = this.now();
    return campaigns.map((c) => {
      const code = assigned.find((a) => a.campaign_id === c.id && a.active) ?? assigned.find((a) => a.campaign_id === c.id);
      const uses = usage.find((u) => u.campaign_id === c.id)?.uses ?? 0;
      const last = used.find((r) => r.campaign_id === c.id);
      const isUsed = Boolean(last) && uses >= (c.limits.perCustomer ?? 1);
      const expired = !isRunning(c, now) && (c.status === 'ended' || c.status === 'cancelled' || c.endsAt.getTime() <= now.getTime());
      const state: CouponCard['state'] = isUsed ? 'used' : expired ? 'expired' : clips.some((x) => x.campaign_id === c.id) ? 'clipped' : 'available';
      return {
        campaignId: c.id,
        codeId: code?.id ?? null,
        code: code?.code ?? c.code,
        title: c.description ?? c.name,
        ...amountAndUnit(c.discount, c.currency),
        conditions: this.conditions(c, names),
        fundedBy: this.fundedBy(c, names),
        expiresAt: c.endsAt.toISOString(),
        state,
        autoApply: c.autoApply,
        terms: c.terms,
        usedOn: isUsed && last?.order_id ? { orderId: last.order_id, orderRef: refs.get(last.order_id) ?? '', saved: m(last.amount - last.reversed, last.currency), at: iso(last.created_at) } : null,
      };
    });
  }

  async cardCampaigns(o: { sellerId?: string } = {}): Promise<CampaignModel[]> {
    const running = await this.core.models(await this.repo.runningCampaigns(this.now(), { kinds: [...COUPON_KINDS, ...SHIPPING_KINDS] }));
    return running.filter((c) => this.isCard(c) && (!o.sellerId || c.sellerId === o.sellerId || c.scope.include.some((t) => t.kind === 'seller' && t.id === o.sellerId)));
  }

  async listDealCoupons(customerId: string | null, sellerId: string | undefined, page: PageRequest): Promise<common.Page<CouponCard>> {
    const cards = await this.cards(await this.cardCampaigns({ sellerId }), customerId);
    return pageOf(cards, page);
  }

  async couponsForProduct(productIds: string[], ctx: { customerId?: string }): Promise<Record<string, CouponCard[]>> {
    const out: Record<string, CouponCard[]> = {};
    const ids = [...new Set(productIds.filter(isUuid))];
    for (const id of ids) out[id] = [];
    if (!ids.length) return out;
    const campaigns = await this.cardCampaigns();
    if (!campaigns.length) return out;
    const consents = await this.parts.participation.consents(campaigns.filter(needsConsent).map((c) => c.id));
    for (const productId of ids) {
      const product = await this.core.product(productId);
      const offerList = await this.parts.campaigns.allOffers({ productId, status: ['active'] }, 100);
      const attrs = await Promise.all(offerList.map((o) => this.core.attrsOf(o, product)));
      const covering = campaigns.filter((c) =>
        attrs.some((a) => {
          if (!scopeCheck(c, a).ok) return false;
          if (a.official || !needsConsent(c)) return true;
          return Boolean(a.sellerId && consents.get(c.id)?.get(a.sellerId)?.offerIds.has(a.offerId));
        }),
      );
      out[productId] = await this.cards(covering, ctx.customerId ?? null);
    }
    return out;
  }

  async couponsForCustomer(customerId: string): Promise<AccountCoupons> {
    const live = await this.cardCampaigns();
    const clips = await this.repo.find('coupon_clips', { customer_id: customerId });
    const assigned = await this.repo.find('coupon_codes', { assigned_customer_id: customerId });
    const redeemed = await this.repo.find('redemptions', { customer_id: customerId, state: ['committed', 'partially_reversed', 'reversed'] }, { orderBy: [['created_at', 'desc']], limit: 200 });
    const extraIds = [...new Set([...clips.map((c) => c.campaign_id), ...assigned.map((a) => a.campaign_id), ...redeemed.map((r) => r.campaign_id)])].filter((id) => !live.some((c) => c.id === id));
    const extra = (await this.core.models(await this.repo.getMany('campaigns', extraIds))).filter((c) => this.isCouponType(c) && c.status !== 'draft');
    const cards = await this.cards([...live, ...extra], customerId);
    const available = cards.filter((c) => c.state === 'available' || c.state === 'clipped').sort((a, b) => Number(b.state === 'clipped') - Number(a.state === 'clipped') || a.expiresAt.localeCompare(b.expiresAt));
    const usedOrExpired = cards.filter((c) => c.state === 'used' || c.state === 'expired').sort((a, b) => b.expiresAt.localeCompare(a.expiresAt)).slice(0, 50);
    return { available, usedOrExpired, rules: COUPON_RULES(Math.max(1, Number(await this.core.setting('couponsPerSellerPackage')) || 1)) };
  }

  async clip(campaignId: string, customerId: string): Promise<CouponCard> {
    const { model: c } = await this.core.campaign(campaignId);
    if (!this.isCouponType(c) || !PUBLIC_STATUSES.includes(c.status)) throw notFound('Coupon');
    const now = this.now();
    const notEligible = (reason: string, message: string) => this.ctx.error('COUPON_NOT_ELIGIBLE', message, { reason });
    if (c.status === 'ended' || c.status === 'cancelled' || c.endsAt.getTime() <= now.getTime()) throw notEligible('expired', 'This coupon has ended');
    if (c.status === 'paused') throw notEligible('expired', "This coupon isn't available right now");
    if (c.startsAt.getTime() > now.getTime()) throw notEligible('not_started', `This coupon starts on ${dayLabel(c.startsAt, c.timeZone)}`);
    if (!this.isCard(c)) throw notEligible('not_found', 'This coupon is used with its code at checkout');
    const isNew = c.eligibility.audience === 'new_customers' ? await this.parts.checkout.isNewCustomer({ customerId }, customerId) : null;
    const who = customerCheck(c.eligibility.audience === 'regions' ? { audience: 'everyone' } : c.eligibility, { signedIn: true, isNewCustomer: isNew, region: null });
    if (!who.ok) throw notEligible(who.reason, who.message);
    const [card] = await this.cards([c], customerId);
    if (card!.state === 'used') throw new AppError('ILLEGAL_TRANSITION', "You've already used this coupon", { from: 'used', event: 'clip' });
    const code = await this.repo.findOne('coupon_codes', { campaign_id: campaignId, assigned_customer_id: customerId, active: true });
    const inserted = await this.repo.insertIfAbsent('coupon_clips', { customer_id: customerId, campaign_id: campaignId, code_id: code?.id ?? null, clipped_at: now });
    if (!inserted) throw new AppError('ILLEGAL_TRANSITION', 'This coupon is already clipped', { from: 'clipped', event: 'clip' });
    return (await this.cards([c], customerId))[0]!;
  }

  async unclip(campaignId: string, customerId: string): Promise<void> {
    await this.repo.removeWhere('coupon_clips', { customer_id: customerId, campaign_id: campaignId });
  }

  /** Rate limit for code look-ups per session (setting codeCheckRateLimit, e.g. 10 per minute per session) */
  async rateLimit(sessionKey: string) {
    const setting = String(await this.core.setting('codeCheckRateLimit'));
    const max = Number(/\d+/.exec(setting)?.[0] ?? 10) || 10;
    const window = /hour/i.test(setting) ? 3_600_000 : 60_000;
    const now = Date.now();
    const hits = (this.#codeChecks.get(sessionKey) ?? []).filter((t) => now - t < window);
    if (hits.length >= max) throw new AppError('RATE_LIMITED', 'Too many code checks. Try again in a minute.', { retryAfterSeconds: Math.ceil((window - (now - hits[0]!)) / 1000) });
    hits.push(now);
    this.#codeChecks.set(sessionKey, hits);
    if (this.#codeChecks.size > 10_000) this.#codeChecks.clear();
  }

  async checkCode(code: string, customerId: string | null, sessionKey: string): Promise<CodeCheck> {
    await this.rateLimit(sessionKey);
    const typed = code.trim();
    if (!typed) return { code, valid: false, coupon: null, reason: 'Enter a code.' };
    const [row] = await this.repo.activeCodes([typed]);
    const c = row ? (await this.core.models(await this.repo.getMany('campaigns', [row.campaign_id])))[0] : undefined;
    if (!row || !c || !this.isCouponType(c) || ['draft', 'in_review', 'changes_requested', 'approved'].includes(c.status)) return { code: typed, valid: false, coupon: null, reason: "We couldn't find this code. Check the spelling." };
    if (row.assigned_customer_id && row.assigned_customer_id !== customerId) return { code: typed, valid: false, coupon: null, reason: "We couldn't find this code. Check the spelling." };
    const usage = new Map<string, { uses: number; units: number }>();
    if (customerId) for (const u of await this.repo.find('usage_counters', { campaign_id: c.id, customer_key: customerId })) usage.set(u.campaign_id, { uses: u.uses, units: u.units });
    const isNew = customerId && c.eligibility.audience === 'new_customers' ? await this.parts.checkout.isNewCustomer({ customerId }, customerId) : null;
    // the cart decides which items a code covers; here only its own conditions count
    const out = evaluate({ at: this.now(), currency: c.currency, customerId, signedIn: Boolean(customerId), isNewCustomer: isNew, region: null, couponsPerPackage: 1, lines: [], shipping: null, priceOptions: new Map(), coupons: [{ campaign: c, source: 'code', code: typed, codeInfo: { id: row.id, code: row.code, kind: row.kind, maxRedemptions: row.max_redemptions, redemptions: row.redemptions, active: row.active, assignedCustomerId: row.assigned_customer_id } }], rejected: [], usage, consents: new Map() });
    const r = out.rejected[0];
    const valid = !r || r.reason === 'no_eligible_items' || r.reason === 'min_spend_not_met';
    const [card] = await this.cards([c], customerId);
    return { code: typed, valid, coupon: { ...card!, code: row.code, codeId: row.kind === 'unique' ? row.id : (card!.codeId ?? null) }, reason: valid ? `${discountLabel(c.discount, c.currency)}. Applied in your cart when the items qualify.` : r!.message };
  }

  /* ---------------------------------------------------------------- deals page */

  async clearanceProducts(o: { categoryId?: string; customerId?: string | null } = {}): Promise<DealProduct[]> {
    const now = this.now();
    const campaigns = (await this.core.models(await this.repo.runningCampaigns(now, { kinds: ['markdown'] }))).filter((c) => c.deals?.show && c.deals.section === 'clearance');
    if (!campaigns.length) return [];
    const rows = await this.repo.find('eligible_offers', { campaign_id: campaigns.map((c) => c.id), eligible: true }, { orderBy: [['offer_id', 'asc']], limit: 500 });
    const consents = await this.parts.participation.consents(campaigns.filter(needsConsent).map((c) => c.id));
    const byId = new Map(campaigns.map((c) => [c.id, c]));
    const ok = rows.filter((r) => {
      const c = byId.get(r.campaign_id)!;
      return r.official_store || !needsConsent(c) || consents.get(c.id)?.get(r.seller_id)?.offerIds.has(r.offer_id);
    });
    const offerIds = [...new Set(ok.map((r) => r.offer_id))];
    // an offer in several clearance campaigns shows the end of the one that ends first (campaigns are soonest ending first)
    const okByCampaign = groupBy(ok, (r) => r.campaign_id);
    const endsAt = new Map<string, Date>();
    for (const c of campaigns) for (const r of okByCampaign.get(c.id) ?? []) if (!endsAt.has(r.offer_id)) endsAt.set(r.offer_id, c.endsAt);
    return this.dealProducts(offerIds, (offerId) => endsAt.get(offerId) ?? null, o);
  }

  async dealProducts(offerIds: string[], endsAt: (offerId: string) => Date | null, o: { categoryId?: string; customerId?: string | null } = {}): Promise<DealProduct[]> {
    if (!offerIds.length) return [];
    const cards = await this.core.offerCards(offerIds);
    let list = [...cards.values()];
    if (o.categoryId) list = list.filter((c) => c.attrs.categoryIds.includes(o.categoryId!));
    const prices = new Map((await this.priceList(list.map((c) => c.offer), this.now(), o.customerId ?? null)).map((p) => [p.offerId, p]));
    return list.map((c: OfferCard) => {
      const p = prices.get(c.offer.id);
      const end = endsAt(c.offer.id);
      return { productId: c.offer.productId, offerId: c.offer.id, title: c.title, image: c.image, sellerName: c.sellerName, sellerSlug: c.sellerSlug, price: p?.price ?? c.offer.price, wasPrice: p?.wasPrice ?? (p && p.price.amount < p.regularPrice.amount ? p.regularPrice : null), endsAt: end ? end.toISOString() : null, stockLeft: c.stock };
    });
  }

  async listClearance(paging: common.PageInput, categoryId?: string): Promise<common.Page<DealProduct>> {
    return pageOf(await this.clearanceProducts({ categoryId }), toPageRequest(paging));
  }

  async upcomingEvents(customerId: string | null): Promise<UpcomingEvent[]> {
    const now = this.now();
    const rows = await this.repo.find('campaigns', { status: 'scheduled', owner_kind: 'platform', starts_at: { op: '>', value: now } }, { orderBy: [['starts_at', 'asc']], limit: 50 });
    const models = (await this.core.models(rows)).filter((c) => c.deals?.show && (c.deals.section === 'events' || c.deals.section === 'flash' || !c.deals.section));
    const reminders = customerId && models.length ? await this.repo.find('event_reminders', { customer_id: customerId, campaign_id: models.map((c) => c.id) }) : [];
    return models.slice(0, 12).map((c) => this.event(c, reminders.some((r) => r.campaign_id === c.id)));
  }

  event = (c: CampaignModel, reminderSet: boolean): UpcomingEvent => ({ campaignId: c.id, name: c.name, period: periodOf(c), summary: c.description ?? discountLabel(c.discount, c.currency), reminderSet });

  async getDealsPage(ctx: { customerId?: string; at?: string }, tab?: string): Promise<DealsPage> {
    const customerId = ctx.customerId ?? null;
    const want = (t: string) => !tab || tab === 'all' || tab === t;
    const [flashSales, couponCampaigns, clearance, events] = await Promise.all([this.liveDeals({ limit: 4 }), this.cardCampaigns(), this.clearanceProducts({ customerId }), this.upcomingEvents(customerId)]);
    const coupons = want('coupons') ? await this.cards(couponCampaigns.slice(0, 12), customerId) : [];
    const perPackage = Math.max(1, Number(await this.core.setting('couponsPerSellerPackage')) || 1);
    const tabs = [
      { key: 'flash', label: 'Flash sales', count: flashSales.length },
      { key: 'clearance', label: 'Clearance', count: clearance.length },
      { key: 'coupons', label: 'Coupons', count: couponCampaigns.length },
      { key: 'events', label: 'Upcoming events', count: events.length },
    ];
    return {
      serverTime: this.now().toISOString(),
      tabs: [{ key: 'all', label: 'All deals', count: tabs.reduce((a, t) => a + t.count, 0) }, ...tabs],
      flashSales: want('flash') ? flashSales : [],
      coupons,
      clearance: want('clearance') ? clearance.slice(0, 12) : [],
      upcomingEvents: want('events') ? events : [],
      rules: [...COUPON_RULES(perPackage), `Was prices are the lowest price in the ${await this.core.lookbackDays()} days before the deal started.`],
    };
  }

  async productPromotions(productId: string, variantId: string | undefined, customerId: string | null): Promise<ProductPromotions> {
    const list = (await this.parts.campaigns.allOffers({ productId, status: ['active'] }, 100)).filter((o) => !variantId || o.variantId === variantId);
    const prices = await this.priceList(list, this.now(), customerId);
    const coupons = (await this.couponsForProduct([productId], { customerId: customerId ?? undefined }))[productId] ?? [];
    return { productId, offers: prices, coupons };
  }

  async campaignProducts(id: string, page: PageRequest): Promise<common.Page<DealProduct>> {
    const row = isUuid(id) ? await this.repo.get('campaigns', id) : undefined;
    if (!row || !['scheduled', 'live', 'paused'].includes(row.status)) throw notFound('Campaign');
    const [c] = await this.core.models([row]);
    const rows = await this.repo.find('eligible_offers', { campaign_id: id, eligible: true }, { orderBy: [['offer_id', 'asc']], limit: 2000 });
    const consents = needsConsent(c!) ? await this.parts.participation.consents([id]) : new Map();
    const ids = rows.filter((r) => r.official_store || !needsConsent(c!) || consents.get(id)?.get(r.seller_id)?.offerIds.has(r.offer_id)).map((r) => r.offer_id);
    const p = pageOf(ids, page);
    return { ...p, items: await this.dealProducts(p.items, () => c!.endsAt) };
  }

  /* ---------------------------------------------------------------- reminders */

  async setReminder(campaignId: string, customerId: string): Promise<UpcomingEvent> {
    const row = isUuid(campaignId) ? await this.repo.get('campaigns', campaignId) : undefined;
    if (!row || row.owner_kind !== 'platform' || !['scheduled', 'live'].includes(row.status)) throw notFound('Event');
    const [c] = await this.core.models([row]);
    if (c!.startsAt.getTime() <= this.now().getTime()) throw invalid([{ path: 'campaignId', message: 'This event has already started' }], 'This event has already started');
    await this.repo.insertIfAbsent('event_reminders', { customer_id: customerId, campaign_id: campaignId, created_at: this.now(), sent_at: null });
    return this.event(c!, true);
  }

  async removeReminder(campaignId: string, customerId: string): Promise<void> {
    await this.repo.removeWhere('event_reminders', { customer_id: customerId, campaign_id: campaignId });
  }

  /** Job: remind customers of events starting within 15 minutes, promotional consent permitting */
  async sendReminders(): Promise<void> {
    const now = this.now();
    const soon = await this.repo.find('campaigns', { status: ['scheduled', 'live'], starts_at: { op: '<=', value: new Date(now.getTime() + 15 * 60_000) } }, { limit: 200 });
    const due = soon.filter((c) => new Date(c.ends_at).getTime() > now.getTime());
    if (!due.length) return;
    const reminders = await this.repo.find('event_reminders', { campaign_id: due.map((c) => c.id), sent_at: null }, { limit: 500 });
    for (const r of reminders) {
      const camp = due.find((c) => c.id === r.campaign_id)!;
      const customer = await this.core.optional('customers', (c) => c.getCustomer(r.customer_id));
      const consent = await this.core.optional('customers', (c) => c.getMarketingConsent(r.customer_id));
      const allowed = consent ? consent.emailPromotions || consent.pushPromotions : false;
      if (allowed && customer) {
        await this.core.optional('notifications', (n) =>
          n.notify({ topic: 'customer.promotions.newsletter', recipients: [{ kind: 'customer', accountId: customer.userId }], context: { campaign: { name: camp.name, startsAt: iso(camp.starts_at) } }, link: { kind: 'campaign', id: camp.id, screen: 'store/deals', label: 'See the deals' }, dedupeKey: `promotions:event-reminder:${camp.id}:${r.customer_id}` }),
        );
      }
      await this.repo.updateWhere('event_reminders', { customer_id: r.customer_id, campaign_id: r.campaign_id }, { sent_at: now });
    }
  }

  /* ---------------------------------------------------------------- seller banners and public campaign */

  /** Live seller-funded promotions (automatic or by code), soonest ending first; `withOffers` keeps the offer ids for priceOffers */
  async activeSellerPromotions(sellerIds: string[], ctx: { customerId?: string; at?: string }, withOffers = false): Promise<Record<string, PromoBanner[]>> {
    const out: Record<string, PromoBanner[]> = {};
    const ids = [...new Set(sellerIds.filter(isUuid))];
    for (const id of ids) out[id] = [];
    if (!ids.length) return out;
    const at = ctx.at ? new Date(ctx.at) : this.now();
    const models = await this.core.models(await this.repo.runningCampaigns(at, { ownerKind: 'seller', sellerIds: ids, kinds: [...COUPON_KINDS, ...SHIPPING_KINDS] }));
    for (const c of models) {
      if (!customerCheck(c.eligibility, { signedIn: Boolean(ctx.customerId), isNewCustomer: null, region: null }).ok && c.eligibility.audience !== 'new_customers') continue;
      const label = discountLabel(c.discount, c.currency);
      const banner: PromoBanner & { offerIds?: string[] } = {
        campaignId: c.id,
        title: c.code && !c.autoApply ? `${label} with code ${c.code}` : label,
        detail: c.code && !c.autoApply ? `Use code ${c.code} at checkout${c.discount.minSpend ? ` on orders over ${moneyLabel(c.discount.minSpend.amount, c.currency)}` : ''}` : c.autoApply ? 'Applied automatically at checkout' : 'Clip it to use it at checkout',
        period: periodOf(c),
        autoApply: c.autoApply,
        code: c.code,
        ...(withOffers && c.scope.mode === 'offers' ? { offerIds: c.scope.include.filter((t) => t.kind === 'offer').map((t) => t.id) } : {}),
      };
      out[c.sellerId!]?.push(banner);
    }
    return out;
  }

  async getPublicCampaign(campaignId: string): Promise<PublicCampaign | null> {
    if (!isUuid(campaignId)) return null;
    const row = await this.repo.get('campaigns', campaignId);
    if (!row || !PUBLIC_STATUSES.includes(row.status)) return null;
    const [c] = await this.core.models([row]);
    return { id: c!.id, name: c!.name, description: c!.description, period: periodOf(c!), terms: c!.terms, status: c!.status, code: c!.code };
  }

  async isCampaignActive(campaignId: string): Promise<{ active: boolean; reason?: string }> {
    const row = isUuid(campaignId) ? await this.repo.get('campaigns', campaignId) : undefined;
    if (!row) return { active: false, reason: 'not_found' };
    const [c] = await this.core.models([row]);
    const now = this.now();
    if (row.status === 'paused') return { active: false, reason: 'paused' };
    if (row.status === 'ended') return { active: false, reason: row.ended_reason ?? 'ended' };
    if (row.status === 'cancelled') return { active: false, reason: 'cancelled' };
    if (!isRunning(c!, now)) return { active: false, reason: c!.startsAt.getTime() > now.getTime() && row.status === 'scheduled' ? 'not_started' : 'not_published' };
    if (row.budget_amount !== null && row.budget_used >= row.budget_amount) return { active: false, reason: 'budget_exhausted' };
    if (row.usage_cap !== null && row.usage_count >= row.usage_cap) return { active: false, reason: 'usage_cap_reached' };
    if (row.kind === 'flash_sale') {
      const items = await this.repo.find('flash_items', { campaign_id: campaignId });
      if (items.length && items.every((f) => f.state !== 'active')) return { active: false, reason: 'sold_out' };
    }
    return { active: true };
  }
}
