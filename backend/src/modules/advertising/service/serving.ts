/**
 * The serving decision for each page view, and tracking. Hot path: live campaigns, their approved
 * creatives and media come from a small cache (rebuilt every few seconds and on any change); a page view
 * then costs one indexed read of the visitor's frequency rows (plus spend for paid ads).
 *
 * Order (spec notes): drop blocked pages → live campaigns for this placement, page and audience → drop
 * suppressed (dismissed) and frequency-capped → drop unavailable promoted offers → pick by priority, equal
 * priority rotating evenly (sponsored products: relevance first). At most one overlay per page view; a pop-up
 * is skipped in a session where an overlay already showed.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { AdImpression, AdPreview, PageType, PopupTrigger, PromotedOfferCard, RotationRule, ServeDecision, ServeRequest, SponsoredProductSlot, TrackEvent } from '../../../spec/advertising.js';
import type * as common from '../../../spec/common.js';
import { advertiserIsOwn, footnoteFor, frequencyBlock, isLayoutPosition, isPageType, OVERLAY_KEYS, ownAdvertiserName, rank, suppressionUntil, windowDaysOf } from '../domain/rules.js';
import { eventId, signImpression, verifyImpression, visitorKey, type ImpressionClaims } from '../domain/token.js';
import type { CampaignRec, CreativeRec, PlacementRec } from '../ports.js';
import { Part, SYSTEM, type OfferInfo } from './core.js';
import type { Model } from './views.js';

/** A live campaign ready to serve */
interface Entry {
  m: Model;
  creatives: CreativeRec[];
  media: Map<string, common.MediaRef>;
  offerIds: string[];
  displays: number;
  advertiserName: string;
  sellerName: string | null;
  promo: { name: string; code: string | null } | null;
}

interface Viewer {
  keys: string[];
  sessionId: string;
  customerId: string | null;
  signedIn: boolean;
  page: string;
  device: string;
}

const LIVE_CACHE_MS = 10_000;
const TOKEN_TTL_S = 86_400;
const OVERLAY_ORDER = ['opening_fullscreen', 'popup', 'interstitial'];

const deviceClass = (d: string) => (d === 'phone' || d === 'app' || d === 'android' || d === 'ios' || d === 'mobile' ? 'phone' : 'desktop');
const words = (s: string | null | undefined) => (s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

export class ServingPart extends Part {
  #live?: { at: number; entries: Promise<Entry[]> };
  #turns = new Map<string, number>();

  invalidate() {
    this.#live = undefined;
  }

  private turn(key: string): number {
    const n = (this.#turns.get(key) ?? 0) + 1;
    this.#turns.set(key, n % 1_000_000);
    return n;
  }

  /* ---------------------------------------------------------------- live cache */

  private async live(): Promise<Entry[]> {
    const t = Date.now();
    if (!this.#live || t - this.#live.at > LIVE_CACHE_MS) {
      const entries = this.build().catch((err) => {
        this.#live = undefined;
        throw err;
      });
      this.#live = { at: t, entries };
    }
    return this.#live.entries;
  }

  private async build(): Promise<Entry[]> {
    const rows = await this.repo.liveCampaigns(this.now());
    return this.entries(await this.parts.views.models(rows), { approvedOnly: true });
  }

  private async entries(models: Model[], o: { approvedOnly: boolean }): Promise<Entry[]> {
    if (!models.length) return [];
    const ids = models.map((m) => m.row.id);
    const creatives = await this.repo.getMany(
      'creatives',
      models.flatMap((m) => m.creatives.map((c) => c.creative_id)),
    );
    const mediaIds = creatives.map((c) => c.media_id).filter((x): x is string => Boolean(x));
    const refs = mediaIds.length ? await this.core.optionalMedia((api) => api.refs(mediaIds, 'large')) : [];
    const media = new Map((refs ?? []).map((r) => [r.id, r]));
    const [totals, sellers] = await Promise.all([this.repo.totals(ids), this.core.sellerNames(models.map((m) => m.row.seller_id))]);
    const promos = new Map<string, { name: string; code: string | null } | null>();
    for (const id of new Set(models.map((m) => m.row.linked_promotion_id).filter((x): x is string => Boolean(x)))) {
      const p = await this.core.optional('promotions', (api) => api.getPublicCampaign(id));
      promos.set(id, p ? { name: p.name, code: p.code ?? null } : null);
    }
    return models.map((m) => {
      const r = m.row;
      const own = creatives.filter((c) => m.creatives.some((x) => x.creative_id === c.id) && (!o.approvedOnly || c.status === 'approved') && (c.kind !== 'video' || m.placement.key === 'video'));
      const sellerName = r.seller_id ? (sellers.get(r.seller_id) ?? null) : null;
      return {
        m,
        creatives: own,
        media,
        offerIds: m.items.filter((i) => i.kind === 'offer').map((i) => i.target_id),
        displays: totals.get(r.id)?.displays ?? 0,
        advertiserName: advertiserIsOwn(r.advertiser_kind) ? ownAdvertiserName(r.advertiser_kind) : r.advertiser_kind === 'seller' ? (sellerName ?? 'Seller') : (this.parts.views.brandName(m.items) ?? 'Brand'),
        sellerName,
        promo: r.linked_promotion_id ? (promos.get(r.linked_promotion_id) ?? null) : null,
      };
    });
  }

  /* ---------------------------------------------------------------- positions and blocked pages */

  async adPositionsFor(page: PageType): Promise<{ placementKey: string; name: string; enabled: boolean }[]> {
    const p = page?.page;
    if (!isPageType(p) || (await this.core.rules()).blockedPages.includes(p)) return [];
    const rows = (await this.core.placementRows()).filter((x) => ((x.eligible_pages ?? []) as string[]).includes(p) && isLayoutPosition(x.key));
    const order = (k: string) => (k === 'opening_fullscreen' ? 0 : 1);
    return rows.sort((a, b) => order(a.key) - order(b.key) || (a.id < b.id ? -1 : 1)).map((x) => ({ placementKey: x.key, name: x.name, enabled: x.enabled }));
  }

  async isAdBlockedPage(page: PageType): Promise<boolean> {
    return (await this.core.rules()).blockedPages.includes(page?.page);
  }

  /* ---------------------------------------------------------------- the decision */

  async serve(req: ServeRequest, who: { scope: Scope; principal: Principal | null }): Promise<ServeDecision> {
    const now = this.now();
    const rules = await this.core.rules();
    const ttlSeconds = await this.core.num('decisionTtlSeconds', 60);
    const decision: ServeDecision = { decisionId: newId(), overlay: null, popupTrigger: null, slots: {}, sponsoredProducts: [], rotationSeconds: null, ttlSeconds };
    if (!isPageType(req.page) || rules.blockedPages.includes(req.page)) return decision;

    const customerId = who.scope.kind === 'customer' ? (who.scope.customerId ?? null) : null;
    const viewer: Viewer = {
      keys: this.keysFor(req.visitorId, customerId),
      sessionId: req.sessionId,
      customerId,
      signedIn: who.principal?.kind === 'customer',
      page: req.page,
      device: req.device,
    };
    const placements = (await this.core.placementRows()).filter((p) => p.enabled && ((p.eligible_pages ?? []) as string[]).includes(req.page));
    const requested = new Set(req.slots?.length ? req.slots : placements.map((p) => p.key));
    const usable = placements.filter((p) => requested.has(p.key));
    if (!usable.length) return decision;
    const usableIds = new Set(usable.map((p) => p.id));

    let returning: boolean | undefined;
    const isReturning = async () => (returning ??= await this.repo.hasHistory(viewer.keys));
    const all = (await this.live()).filter((e) => usableIds.has(e.m.placement.id));
    const candidates: Entry[] = [];
    for (const e of all) {
      if (!this.runsNow(e, now) || !e.m.pages.includes(req.page)) continue;
      if (req.page === 'category' && e.m.categoryIds.length && !(req.context?.categoryId && e.m.categoryIds.includes(req.context.categoryId))) continue;
      if (e.m.placement.key === 'opening_fullscreen' && !req.isEntryPage) continue;
      if (e.m.placement.key === 'popup' && req.overlayShownThisSession && ((e.m.placement.trigger as PopupTrigger | null)?.skipIfOverlayShownThisSession ?? true)) continue;
      if (!(await this.audienceOk(e, req, viewer, isReturning))) continue;
      if (e.m.placement.key !== 'sponsored_product' && !e.creatives.length) continue;
      candidates.push(e);
    }
    const allowed = await this.filterDeliverable(candidates, viewer, now, rules.removeUnavailable);

    // overlays: at most one per page view (overlaysPerPageView may turn them off)
    if (rules.overlaysPerPageView > 0) {
      for (const key of OVERLAY_ORDER) {
        const list = allowed.filter((e) => e.m.placement.key === key);
        if (!list.length) continue;
        const picked = this.pick(list, list[0]!.m.placement, req.context?.categoryId ?? null, 1)[0];
        const imp = picked && this.impression(picked, viewer, req);
        if (!imp) continue;
        decision.overlay = imp;
        if (key === 'popup') decision.popupTrigger = (picked.m.placement.trigger as PopupTrigger | null) ?? null;
        break;
      }
    }

    // inline and card positions
    for (const p of usable) {
      if (OVERLAY_KEYS.includes(p.key) || p.key === 'sponsored_product') continue;
      const list = allowed.filter((e) => e.m.placement.id === p.id);
      if (!list.length) continue;
      const rot = p.rotation as unknown as RotationRule;
      const max = Math.max(1, Math.min(p.max_per_page ?? 1, rot.maxInRotation ?? p.max_per_page ?? 1));
      const imps = this.pick(list, p, req.context?.categoryId ?? null, max)
        .map((e) => this.impression(e, viewer, req))
        .filter((x): x is AdImpression => Boolean(x));
      if (!imps.length) continue;
      decision.slots[p.key] = imps;
      if (rot.mode === 'carousel' && imps.length > 1) decision.rotationSeconds ??= rot.carouselSeconds ?? 6;
    }

    // sponsored product cards
    const sp = usable.find((p) => p.key === 'sponsored_product');
    if (sp) {
      decision.sponsoredProducts = await this.sponsoredFrom(
        allowed.filter((e) => e.m.placement.id === sp.id),
        sp,
        viewer,
        { query: req.context?.query ?? null, categoryId: req.context?.categoryId ?? null, productId: req.context?.productId ?? null, organicOfferIds: [] },
      );
    }
    return decision;
  }

  /** Sponsored product cards for a results list (search, catalog); first page only is the caller's job */
  async sponsoredForResults(ctx: { page: PageType; query?: string; categoryId?: string; productId?: string; visitorId: string; sessionId: string; device: string; organicOfferIds: string[] }): Promise<SponsoredProductSlot[]> {
    const page = ctx.page?.page;
    const rules = await this.core.rules();
    if (!isPageType(page) || rules.blockedPages.includes(page)) return [];
    const placement = (await this.core.placementRows()).find((p) => p.key === 'sponsored_product');
    if (!placement?.enabled || !((placement.eligible_pages ?? []) as string[]).includes(page)) return [];
    const now = this.now();
    const viewer: Viewer = { keys: this.keysFor(ctx.visitorId || ctx.sessionId || 'anonymous', null), sessionId: ctx.sessionId || 'anonymous', customerId: null, signedIn: false, page, device: ctx.device };
    // no privacy choices here: only campaigns for everyone (page context targeting)
    const list = (await this.live()).filter((e) => e.m.placement.id === placement.id && this.runsNow(e, now) && e.m.pages.includes(page) && e.m.audience?.mode !== 'selected');
    const allowed = await this.filterDeliverable(list, viewer, now, rules.removeUnavailable);
    return this.sponsoredFrom(allowed, placement, viewer, { query: ctx.query ?? null, categoryId: ctx.categoryId ?? null, productId: ctx.productId ?? null, organicOfferIds: ctx.organicOfferIds ?? [] });
  }

  private runsNow(e: Entry, now: Date) {
    const r = e.m.row;
    return r.starts_at !== null && r.ends_at !== null && r.starts_at.getTime() <= now.getTime() && r.ends_at.getTime() > now.getTime();
  }

  private keysFor(visitorId: string, customerId: string | null): string[] {
    const keys = [visitorKey('v', visitorId || 'anonymous', this.core.secret)];
    if (customerId) keys.push(visitorKey('c', customerId, this.core.secret));
    return keys;
  }

  /** Audience rules, using only what the visitor's privacy choices allow */
  private async audienceOk(e: Entry, req: ServeRequest, v: Viewer, isReturning: () => Promise<boolean>): Promise<boolean> {
    const a = e.m.audience;
    if (!a || a.mode !== 'selected') return true;
    if (!req.personalizationAllowed) return false;
    if (a.regions?.length && !(req.region && a.regions.includes(req.region))) return false;
    if (a.signIn === 'signed_in' && !v.signedIn) return false;
    if (a.categoryIds?.length && !(req.context?.categoryId && a.categoryIds.includes(req.context.categoryId))) return false;
    if (a.visitors === 'new' && (await isReturning())) return false;
    if (a.visitors === 'returning' && !(await isReturning())) return false;
    return true;
  }

  /** Drops suppressed and capped campaigns, those at a spending limit or delivery cap, and unavailable promoted offers */
  private async filterDeliverable(list: Entry[], v: Viewer, now: Date, removeUnavailable: boolean): Promise<Entry[]> {
    if (!list.length) return [];
    const ids = list.map((e) => e.m.row.id);
    const rows = await this.repo.frequencyRows(v.keys, ids);
    const needToday = list.filter((e) => e.m.cap?.perDay && e.m.cap?.perWindow).map((e) => e.m.row.id);
    const needTotal = list.filter((e) => e.m.cap?.perCampaign).map((e) => e.m.row.id);
    const today = needToday.length ? await this.repo.displayCounts(v.keys, needToday, this.core.dayStart(this.core.today(now))) : new Map<string, number>();
    const total = needTotal.length ? await this.repo.displayCounts(v.keys, needTotal, null) : new Map<string, number>();
    const rules = await this.core.rules();
    let out = list.filter((e) => {
      if (e.m.row.delivery_cap !== null && e.displays >= e.m.row.delivery_cap) return false;
      const block = frequencyBlock(
        rows.filter((r) => r.campaign_id === e.m.row.id),
        e.m.cap ?? { label: '' },
        rules.dismissStopsForSession && e.m.dismissal.mode === 'not_dismissible' ? { ...e.m.dismissal, mode: 'session' } : e.m.dismissal,
        v.sessionId,
        now,
        { displaysToday: today.get(e.m.row.id) ?? 0, displaysTotal: total.get(e.m.row.id) ?? 0 },
      );
      return !block;
    });
    // paid campaigns: fresh spend against the daily and total limits
    const paid = out.filter((e) => e.m.row.billing !== 'none' && e.m.row.seller_id);
    if (paid.length) {
      const fresh = new Map((await this.repo.getMany('campaigns', paid.map((e) => e.m.row.id))).map((c) => [c.id, c]));
      const spend = await this.repo.spendOn(paid.map((e) => e.m.row.id), this.core.today(now));
      out = out.filter((e) => {
        const c = fresh.get(e.m.row.id);
        if (!c || !paid.includes(e)) return true;
        if (c.status !== 'live') return false;
        const unit = c.billing === 'cpc' ? (c.rate ?? 0) : 0;
        if (c.total_limit !== null && (c.spent + unit > c.total_limit || c.spent >= c.total_limit)) return false;
        const day = spend.get(c.id) ?? 0;
        if (c.daily_limit !== null && (day + unit > c.daily_limit || day >= c.daily_limit)) return false;
        return true;
      });
    }
    if (removeUnavailable) {
      const offerIds = [...new Set(out.flatMap((e) => e.offerIds))];
      if (offerIds.length) {
        const info = await this.core.offerInfo(offerIds);
        if (info) out = out.filter((e) => !e.offerIds.length || e.offerIds.some((id) => info.get(id)?.promotable));
      }
    }
    return out;
  }

  /** Rank by the placement's rotation rule; equal ranks rotate per page view */
  private pick(list: Entry[], p: PlacementRec, categoryId: string | null, max: number): Entry[] {
    const rot = p.rotation as unknown as RotationRule;
    const ranked = rank(
      list.map((e) => ({ id: e.m.row.id, priority: e.m.row.priority, relevance: categoryId && (e.m.categoryIds.includes(categoryId) || e.m.audience?.categoryIds?.includes(categoryId)) ? 1 : 0, e })),
      rot.mode,
      this.turn(p.key),
    );
    return ranked.slice(0, max).map((x) => x.e);
  }

  private async sponsoredFrom(list: Entry[], p: PlacementRec, v: Viewer, ctx: { query: string | null; categoryId: string | null; productId: string | null; organicOfferIds: string[] }): Promise<SponsoredProductSlot[]> {
    if (!list.length) return [];
    const info = await this.core.offerInfo([...new Set(list.flatMap((e) => e.offerIds))]);
    if (!info) return [];
    const terms = words(ctx.query);
    const organic = new Set(ctx.organicOfferIds);
    const viewed = ctx.productId ? await this.core.product(ctx.productId) : null;
    const contextual = Boolean(terms.length || ctx.categoryId || ctx.productId);
    const pairs: { id: string; priority: number; relevance: number; e: Entry; offer: OfferInfo }[] = [];
    for (const e of list) {
      for (const offerId of e.offerIds) {
        const o = info.get(offerId);
        if (!o?.promotable || o.productId === ctx.productId) continue;
        let relevance = 0;
        if (organic.has(offerId)) relevance += 3;
        if (ctx.categoryId && (o.categoryId === ctx.categoryId || e.m.categoryIds.includes(ctx.categoryId))) relevance += 2;
        if (viewed?.categoryId && o.categoryId === viewed.categoryId) relevance += 2;
        if (terms.length && words(o.title).some((w) => terms.includes(w))) relevance += 1;
        if (contextual && relevance === 0) continue;
        pairs.push({ id: `${e.m.row.id}:${offerId}`, priority: e.m.row.priority, relevance, e, offer: o });
      }
    }
    const ranked = rank(pairs, (p.rotation as unknown as RotationRule).mode, this.turn(p.key));
    const max = Math.max(1, p.max_per_page ?? 2);
    const positions = ((p.positions ?? []) as number[]).length ? ((p.positions ?? []) as number[]) : [1, 2, 3, 4];
    const usedCampaigns = new Set<string>();
    const usedOffers = new Set<string>();
    const out: SponsoredProductSlot[] = [];
    for (const x of ranked) {
      if (out.length >= max) break;
      if (usedCampaigns.has(x.e.m.row.id) || usedOffers.has(x.offer.offer.id)) continue;
      const imp = this.impression(x.e, v, null, x.offer);
      if (!imp) continue;
      usedCampaigns.add(x.e.m.row.id);
      usedOffers.add(x.offer.offer.id);
      out.push({ position: positions[out.length] ?? (positions.at(-1) ?? 0) + 5 * (out.length - positions.length + 1), impression: imp });
    }
    return out;
  }

  /* ---------------------------------------------------------------- impressions */

  private creativeFor(e: Entry, device: string): CreativeRec | undefined {
    const cls = deviceClass(device);
    const fit = e.creatives.filter((c) => c.device === cls || c.device === 'any');
    if (!fit.length) return undefined;
    return fit[this.turn(`creative:${e.m.row.id}`) % fit.length];
  }

  private impression(e: Entry, v: Viewer, req: ServeRequest | null, offer?: OfferInfo, preview = false): AdImpression | null {
    const r = e.m.row;
    const key = e.m.placement.key;
    const creative = this.creativeFor(e, v.device);
    if (!creative && !offer) return null;
    const nowS = Math.floor(this.now().getTime() / 1000);
    const claims: ImpressionClaims = { i: newId(), c: r.id, k: creative?.id ?? r.id, p: key, v: v.keys, s: v.sessionId, u: v.customerId, g: v.page, d: v.device, t: nowS, e: nowS + TOKEN_TTL_S };
    const dismissible = e.m.dismissal.mode !== 'not_dismissible';
    const mediaRef = creative?.media_id ? (e.media.get(creative.media_id) ?? null) : null;
    const tz = r.time_zone || this.core.tz();
    const promotedOffer: PromotedOfferCard | null = offer
      ? {
          offerId: offer.offer.id,
          productId: offer.productId,
          title: offer.title,
          image: offer.image,
          price: offer.offer.price,
          wasPrice: offer.offer.compareAt?.amount ?? null,
          sellerName: offer.sellerName,
          deliveryNote: offer.offer.dispatch?.label ?? null,
        }
      : null;
    return {
      impressionToken: preview ? 'preview' : signImpression(claims, this.core.secret),
      campaignId: r.id,
      creativeId: creative?.id ?? r.id,
      placementKey: key,
      label: r.advertiser_kind === 'platform' && r.goal === 'platform_event' ? 'Announcement' : (e.m.placement.label as 'Ad' | 'Sponsored'),
      advertiserName: e.advertiserName,
      sellerName: r.seller_id ? (offer?.sellerName ?? e.sellerName) : null,
      advertiserLogo: null,
      eyebrow: OVERLAY_KEYS.includes(key) ? (e.promo?.name ?? null) : null,
      headline: creative?.headline ?? offer?.title ?? r.name,
      body: creative?.body ?? null,
      buttonText: creative?.button_text ?? (offer ? 'View product' : 'Shop now'),
      secondaryText: key === 'opening_fullscreen' ? `Continue to ${req?.page === 'home' || !req ? 'home page' : 'the page'}` : key === 'popup' ? 'No thanks' : null,
      image: creative?.kind === 'image' ? mediaRef : (offer?.image ?? null),
      video: creative?.kind === 'video' ? mediaRef : null,
      destination: creative?.link ?? (offer ? `/product/${offer.productId}?offer=${offer.offer.id}` : (e.m.destination?.url ?? '/')),
      dismissible,
      closeLabel: dismissible ? 'Close' : null,
      footnote: footnoteFor(key, r.ends_at, e.m.cap ?? { label: '' }, tz),
      code: key === 'popup' ? (e.promo?.code ?? null) : null,
      promotedOffer,
    };
  }

  /** Desktop and phone preview exactly as visitors see it (any creative status) */
  async preview(m: Model, theme: 'light' | 'dark'): Promise<AdPreview> {
    const [e] = await this.entries([m], { approvedOnly: false });
    const offerInfo = e!.offerIds.length ? await this.core.offerInfo(e!.offerIds) : undefined;
    const offer = offerInfo ? e!.offerIds.map((id) => offerInfo.get(id)).find((x): x is OfferInfo => Boolean(x)) : undefined;
    const viewer = (device: string): Viewer => ({ keys: [], sessionId: 'preview', customerId: null, signedIn: false, page: m.pages[0] ?? 'home', device });
    const fallback = (device: string): AdImpression => ({
      impressionToken: 'preview',
      campaignId: m.row.id,
      creativeId: m.row.id,
      placementKey: m.placement.key,
      label: m.placement.label as 'Ad' | 'Sponsored',
      advertiserName: e!.advertiserName,
      headline: `${m.row.name} (no ${device} creative yet)`,
      buttonText: 'Shop now',
      destination: m.destination?.url ?? '/',
      dismissible: m.dismissal.mode !== 'not_dismissible',
      closeLabel: m.dismissal.mode !== 'not_dismissible' ? 'Close' : null,
    });
    const one = (device: string) => this.impression(e!, viewer(device), null, m.placement.key === 'sponsored_product' ? offer : undefined, true) ?? fallback(device);
    return { desktop: one('desktop'), phone: one('phone'), frame: { desktop: 'Desktop 1440 × 900', phone: 'Phone 390 × 844' }, theme };
  }

  /* ---------------------------------------------------------------- tracking */

  /**
   * Displays, clicks and dismissals, batched. Tokens must be ours (a tampered or malformed token refuses
   * the batch); expired tokens and duplicates (same impression and kind) are ignored. A display counts
   * against the frequency cap, a dismissal suppresses at once, a paid click is charged within the limits.
   */
  async track(events: TrackEvent[]): Promise<{ accepted: number; ignored: number }> {
    const nowMs = this.now().getTime();
    const checked = (events ?? []).map((ev) => ({ ev, check: verifyImpression(ev.impressionToken, this.core.secret, nowMs) }));
    const bad = checked.find((c) => !c.check.ok && c.check.reason !== 'expired');
    if (bad) throw this.ctx.error('INVALID_IMPRESSION_TOKEN', 'An impression token is missing or was tampered with.');
    let accepted = 0;
    let ignored = 0;
    const campaigns = new Map<string, CampaignRec | null>();
    const campaignOf = async (id: string) => {
      if (!campaigns.has(id)) campaigns.set(id, (await this.repo.get('campaigns', id)) ?? null);
      return campaigns.get(id)!;
    };
    for (const { ev, check } of checked) {
      if (!check.ok) {
        ignored++;
        continue;
      }
      const c = check.claims;
      const campaign = await campaignOf(c.c);
      if (!campaign) {
        ignored++;
        continue;
      }
      const kind = ev.kind;
      const dedupeKind = kind === 'close' ? 'dismiss' : kind;
      const id = eventId(c.i, dedupeKind);
      const now = this.now();
      const inserted = await this.repo.insertIgnore('ad_events', {
        id,
        impression_id: c.i,
        campaign_id: c.c,
        creative_id: c.k,
        placement_key: c.p,
        kind,
        visitor_key: c.v[0] ?? 'anonymous',
        session_id: c.s,
        customer_id: c.u,
        page: c.g,
        device: c.d,
        at: now,
        cost: null,
      });
      if (!inserted) {
        ignored++;
        continue;
      }
      accepted++;
      if (kind === 'display') {
        await this.repo.recordDisplay(c.v, c.c, c.s, now, windowDaysOf(campaign.frequency_cap as never));
        this.countDisplay(c.c);
      } else if (kind === 'dismiss' || kind === 'close') {
        const rules = await this.core.rules();
        const until = suppressionUntil(campaign.dismissal as never, campaign.ends_at, now, rules.dismissStopsForSession);
        if (until) await this.repo.recordDismissal(c.v, c.c, c.s, until, now);
      } else if (kind === 'click' && campaign.billing === 'cpc' && campaign.seller_id && campaign.status === 'live') {
        await this.chargeClick(id, campaign);
      }
    }
    return { accepted, ignored };
  }

  /** Keeps the cached delivery count current between roll-ups */
  private countDisplay(campaignId: string) {
    const live = this.#live;
    if (!live) return;
    void live.entries
      .then((list) => {
        const e = list.find((x) => x.m.row.id === campaignId);
        if (e) e.displays++;
      })
      .catch(() => undefined);
  }

  private async chargeClick(eventId: string, campaign: CampaignRec) {
    const res = await this.repo.chargeClick(eventId, campaign.id, this.core.today());
    if (res.charged && res.exhausted) {
      this.core.publish('advertising.budget.reached', { campaignId: campaign.id, sellerId: campaign.seller_id, limit: res.exhausted });
      this.invalidate();
      if (res.exhausted === 'total') {
        await this.parts.campaigns.finish(campaign.id, 'budget_reached', 'Total spending limit reached', { actor: SYSTEM }).catch((err) => {
          if (!(err instanceof AppError) || err.code !== 'ILLEGAL_TRANSITION') throw err;
        });
      }
    }
  }
}
