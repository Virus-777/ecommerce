import type { EventPayload } from '../../kernel/events/index.js';
import { newId } from '../../kernel/lib/ids.js';
import type * as catalog from '../../spec/catalog.js';
import { format as formatMoney } from '../../kernel/lib/money.js';
import type * as common from '../../spec/common.js';
import { OFFICIAL_STORE_ID, OFFICIAL_STORE_NAME } from '../../spec/common.js';
import type { Check, ContentPublicApi, FooterGroup, HelpCategory, LinkRef, OfficialStoreProfile, PageDraftInput, SellerAnnouncement, ServiceStrip, SiteNavigation } from '../../spec/content.js';
import type * as sellers from '../../spec/sellers.js';
import { inWindow } from './domain/rules.js';
import type { NavigationRow, PageRow, VersionRow } from './ports.js';
import { invalid, iso, requireText, SYSTEM, type By } from './service/base.js';
import { ContentNews } from './service/news.js';

export type { ContentServiceDeps } from './service/base.js';

/**
 * Content use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, an endpoint, a consumed event or a job in docs/api/spec/modules/content.json.
 * The use cases are layered in service/: base → tiles → pages → homepage → help → policies → this class
 * (navigation, consumed events and jobs).
 */
export class ContentService extends ContentNews implements ContentPublicApi {
  /* ---------------------------------------------------------------- navigation */

  /** Footer company facts from settings (market.companyLine and market.legalName); fallbacks when settings is off */
  private async company(): Promise<{ companyLine: string; legalName: string }> {
    const settingsApi = this.ctx.tryUse('settings');
    const info = await this.soft('settings.storeInfo', settingsApi && (() => settingsApi.storeInfo()), null);
    const legalName = info?.market.legalName?.trim() || 'Marketly';
    const companyLine = info?.market.companyLine?.trim() || `© ${this.now().getUTCFullYear()} ${legalName}`;
    return { companyLine, legalName };
  }

  private navigationFrom(rows: NavigationRow[], opts: { strip: 'active' | 'any' }): Omit<SiteNavigation, 'contact' | 'companyLine' | 'legalName'> {
    const link = (r: NavigationRow): LinkRef => ({ label: r.label, url: r.url, kind: (r.kind === 'none' ? null : r.kind) as LinkRef['kind'] });
    const header = rows.filter((r) => r.area === 'header').map(link);
    const footer: FooterGroup[] = [];
    for (const r of rows.filter((x) => x.area === 'footer')) {
      const title = r.group_title ?? '';
      let g = footer.find((x) => x.title === title);
      if (!g) footer.push((g = { title, links: [] }));
      g.links.push(link(r));
    }
    const s = rows.find((r) => r.area === 'service_strip');
    const show = s && (opts.strip === 'any' || inWindow(this.now(), s.active_from, s.active_until));
    const serviceStrip: ServiceStrip | null = show ? { text: s.text ?? '', link: s.url ? link(s) : null, activeFrom: iso(s.active_from), activeUntil: iso(s.active_until) } : null;
    return { header, footer, serviceStrip };
  }

  /* ---------------------------------------------------------------- Official Store */

  /**
   * GET /official-store: the Official Store is not a seller record, so its profile comes from content settings,
   * the current policies of the chosen kinds and its feedback summary in reviews.
   */
  async getOfficialStore(): Promise<OfficialStoreProfile> {
    const [logoUrl, bannerUrl, introduction, kinds] = await Promise.all([
      this.ctx.settings.get('officialStoreLogoUrl'),
      this.ctx.settings.get('officialStoreBannerUrl'),
      this.ctx.settings.get('officialStoreIntroduction'),
      this.ctx.settings.get('officialStorePolicyKinds'),
    ]);
    const wanted: string[] = Array.isArray(kinds) ? (kinds as unknown[]).filter((k): k is string => typeof k === 'string') : [];
    const policies = (await this.listPublicPolicies()).filter((p) => p.current && wanted.includes(p.kind));
    policies.sort((a, b) => wanted.indexOf(a.kind) - wanted.indexOf(b.kind));
    const reviewsApi = this.ctx.tryUse('reviews');
    const feedback = await this.soft('reviews.getSellerFeedbackSummary', reviewsApi && (() => reviewsApi.getSellerFeedbackSummary(OFFICIAL_STORE_ID)), null);
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
      id: OFFICIAL_STORE_ID,
      name: OFFICIAL_STORE_NAME,
      logoUrl: text(logoUrl),
      bannerUrl: text(bannerUrl),
      introduction: text(introduction),
      policies: policies.map((p) => ({ label: p.title, url: `/policies/${p.key}`, kind: 'policy' })),
      feedback,
    };
  }

  /** Header and footer links, the service strip inside its window, contact details and the company line */
  async getNavigation(): Promise<SiteNavigation> {
    const rows = await this.repo.listNavigation();
    return { ...this.navigationFrom(rows, { strip: 'active' }), contact: await this.contactChannels('customer'), ...(await this.company()) };
  }

  async updateNavigation(body: { header: LinkRef[]; footer: FooterGroup[]; serviceStrip?: ServiceStrip | null; reason?: string | null }, by: By): Promise<SiteNavigation> {
    body.header.forEach((l, i) => this.checkLink(l, `header[${i}]`));
    body.footer.forEach((g, i) => {
      requireText(g.title, `footer[${i}].title`, 'A footer group needs a title');
      if (!g.links.length) throw invalid(`footer[${i}].links`, 'A footer group needs at least one link');
      g.links.forEach((l, j) => this.checkLink(l, `footer[${i}].links[${j}]`));
    });
    const strip = body.serviceStrip ?? null;
    if (strip) {
      requireText(strip.text, 'serviceStrip.text', 'The service strip needs its text');
      this.checkLink(strip.link, 'serviceStrip.link');
      if (strip.activeFrom && strip.activeUntil && new Date(strip.activeUntil) <= new Date(strip.activeFrom)) throw invalid('serviceStrip.activeUntil', 'The strip must end after it starts');
    }
    const rows: NavigationRow[] = [];
    const row = (area: NavigationRow['area'], position: number, l: LinkRef | null, extra: Partial<NavigationRow> = {}): NavigationRow => ({
      id: newId(),
      area,
      group_title: null,
      position,
      label: l?.label.trim() ?? '',
      url: l?.url.trim() ?? '',
      kind: l?.kind ?? 'none',
      text: null,
      active_from: null,
      active_until: null,
      ...extra,
    });
    body.header.forEach((l, i) => rows.push(row('header', i + 1, l)));
    let n = 0;
    for (const g of body.footer) for (const l of g.links) rows.push(row('footer', ++n, l, { group_title: g.title.trim() }));
    if (strip) rows.push(row('service_strip', 1, strip.link ?? null, { text: strip.text.trim(), active_from: strip.activeFrom ? new Date(strip.activeFrom) : null, active_until: strip.activeUntil ? new Date(strip.activeUntil) : null }));
    const before = await this.repo.listNavigation();
    await this.repo.transaction((tx) => tx.replaceNavigation(rows));
    const after = await this.repo.listNavigation();
    await this.audit({ action: 'content.navigation.update', actionLabel: 'Replaced header and footer links', target: { type: 'navigation', id: 'site', label: 'Site navigation' }, before: this.navigationFrom(before, { strip: 'any' }), after: this.navigationFrom(after, { strip: 'any' }), reason: body.reason ?? null }, by);
    return { ...this.navigationFrom(after, { strip: 'any' }), contact: await this.contactChannels('customer'), ...(await this.company()), checks: await this.stripChecks(strip?.text ?? null) };
  }

  /**
   * Warn-only checks of the service strip text against the facts in force (decision: warn, never block): a
   * free-shipping amount against shipping.getOfficialFreeShipping, an 'N-day returns' window against
   * returns.defaultWindowDays. A module that is off (or cannot answer) is simply not checked.
   */
  protected async stripChecks(text: string | null): Promise<Check[]> {
    if (!text?.trim()) return [];
    const checks: Check[] = [];
    const freeShip = /free (?:shipping|delivery)[^$]{0,40}\$\s?([\d,]+(?:\.\d{2})?)|\$\s?([\d,]+(?:\.\d{2})?)[^$]{0,40}free (?:shipping|delivery)/i.exec(text);
    if (freeShip) {
      const shipping = this.ctx.tryUse('shipping');
      const official = await this.soft('shipping.getOfficialFreeShipping', shipping && (() => shipping.getOfficialFreeShipping()), null);
      if (official) {
        const stated = Math.round(Number((freeShip[1] ?? freeShip[2])!.replace(/,/g, '')) * 100);
        const inForce = official.active && official.threshold ? official.threshold.amount : null;
        if (inForce === null) checks.push({ state: 'warn', label: 'The strip promises free shipping the Official Store does not offer now', detail: 'No free-shipping threshold is in force in shipping.' });
        else if (inForce !== stated) checks.push({ state: 'warn', label: 'The free-shipping amount in the strip differs from shipping', detail: `Strip: ${formatMoney({ amount: stated, currency: official.threshold!.currency })}; in force: ${formatMoney(official.threshold!)}` });
        else checks.push({ state: 'ok', label: 'Free-shipping amount matches shipping' });
      }
    }
    const window = /(\d{1,3})[- ]day (?:free )?returns?/i.exec(text);
    if (window) {
      const returns = this.ctx.tryUse('returns');
      const inForce = await this.soft('returns.defaultWindowDays', returns && (() => returns.defaultWindowDays()), null);
      if (inForce) {
        const stated = Number(window[1]);
        if (stated !== inForce.windowDays) checks.push({ state: 'warn', label: 'The return window in the strip differs from the returns policy', detail: `Strip: ${stated} days; in force: ${inForce.windowDays} days${inForce.policyVersion ? ` (policy ${inForce.policyVersion})` : ''}` });
        else checks.push({ state: 'ok', label: 'Return window matches the returns policy' });
      }
    }
    return checks;
  }

  /* ---------------------------------------------------------------- events consumed */

  /** promotions.campaign.ended: hide homepage sections linked to the promotion; flag linked pages that stay up longer */
  async onCampaignEndedFromPromotions(event: EventPayload<'promotions.campaign.ended'>): Promise<void> {
    await this.changeSections(
      (s) => (s.linkedPromotionId === event.campaignId || this.dealsCampaignOf(s) === event.campaignId) && !s.config.hiddenByPromotion,
      (s) => ({ ...s, config: { ...s.config, hiddenByPromotion: true } }),
      `Promotion ended (${event.reason.replace(/_/g, ' ')}): hid linked sections`,
    );
    const now = this.now();
    for (const p of await this.repo.listPages({ linkedPromotionId: event.campaignId, statuses: ['published', 'scheduled'] })) {
      if (p.unpublish_at && p.unpublish_at <= now) continue;
      if ((await this.repo.logsOf('page', p.id, 'promotion_ended')).length) continue;
      await this.logAction('page', p.id, 'promotion_ended', SYSTEM, `Linked promotion ended (${event.reason}); the page stays up until ${iso(p.unpublish_at) ?? 'it is taken down'}`);
    }
  }

  /** promotions.campaign.started: linked sections and pages are re-resolved */
  async onCampaignStartedFromPromotions(event: EventPayload<'promotions.campaign.started'>): Promise<void> {
    await this.changeSections(
      (s) => (s.linkedPromotionId === event.campaignId || this.dealsCampaignOf(s) === event.campaignId) && Boolean(s.config.hiddenByPromotion),
      (s) => ({ ...s, config: { ...s.config, hiddenByPromotion: false } }),
      'Promotion started: linked sections shown again',
    );
    this.invalidateHome();
  }

  /** Rewrites manual product lists in section drafts and page drafts (a page without a draft gets one from its live version) */
  private async rewriteProducts(fix: (ids: string[]) => string[] | null, summary: string, opts: { live: boolean }) {
    const fixSource = <T extends { productSource?: { mode: string; productIds?: string[] | null } | null }>(x: T): T | null => {
      const src = x.productSource;
      if (src?.mode !== 'manual' || !src.productIds?.length) return null;
      const next = fix(src.productIds);
      return next ? { ...x, productSource: { ...src, productIds: next } } : null;
    };
    await this.changeSections(
      (s) => s.config.productSource?.mode === 'manual' && Boolean(s.config.productSource.productIds?.length),
      (s) => {
        const c = fixSource(s.config);
        return c ? { ...s, config: c } : null;
      },
      summary,
      { live: opts.live },
    );
    const pages = await this.repo.listPages({});
    const baseIdOf = (p: PageRow) => p.draft_version_id ?? p.live_version_id;
    // every page's draft (else live) version in one read
    const bases = new Map((await this.repo.getVersions(pages.flatMap((p) => baseIdOf(p) ?? []))).map((v) => [v.id, v]));
    for (const p of pages) {
      const baseId = baseIdOf(p);
      const base: VersionRow | undefined = baseId ? bases.get(baseId) : undefined;
      const snap = base?.snapshot as unknown as PageDraftInput | undefined;
      if (!base || !snap?.blocks) continue;
      let changed = false;
      const blocks = snap.blocks.map((b) => {
        const nb = fixSource(b);
        if (nb) changed = true;
        return nb ?? b;
      });
      if (!changed) continue;
      await this.repo.transaction(async (tx) => {
        if (p.draft_version_id) await tx.updateVersion(p.draft_version_id, { snapshot: { ...snap, blocks } as never });
        else {
          const v = await tx.insertVersion(this.newVersionRow('page', p.id, (await tx.maxVersionNumber('page', p.id)) + 1, { ...snap, blocks }, SYSTEM, { summary }));
          await tx.updatePage(p.id, { draft_version_id: v.id, updated_at: this.now() } as Partial<PageRow>);
        }
      });
      await this.logAction('page', p.id, 'products_changed', SYSTEM, summary);
    }
  }

  /** catalog.product.publication_changed: hidden or suspended products leave manual selections (recorded in the next version) */
  async onProductPublicationChangedFromCatalog(event: EventPayload<'catalog.product.publication_changed'>): Promise<void> {
    this.invalidateHome();
    if (event.to !== 'hidden' && event.to !== 'suspended') return;
    await this.rewriteProducts((ids) => (ids.includes(event.productId) ? ids.filter((x) => x !== event.productId) : null), `Removed a product that is now ${event.to}`, { live: false });
  }

  /** catalog.product.merged: the duplicate id is replaced by the kept product in sections and collections */
  async onProductMergedFromCatalog(event: EventPayload<'catalog.product.merged'>): Promise<void> {
    this.invalidateHome();
    await this.rewriteProducts(
      (ids) => (ids.includes(event.duplicateProductId) ? [...new Set(ids.map((x) => (x === event.duplicateProductId ? event.keptProductId : x)))] : null),
      'Replaced a merged duplicate product',
      { live: true },
    );
  }

  /** offers.offer.status_changed: product tiles are resolved again on the next read */
  async onOfferStatusChangedFromOffers(_event: EventPayload<'offers.offer.status_changed'>): Promise<void> {
    this.invalidateHome();
  }

  /** inventory.stock.changed: availability on curated collections is checked again on the next read */
  async onStockChangedFromInventory(_event: EventPayload<'inventory.stock.changed'>): Promise<void> {
    this.invalidateHome();
  }

  /** sellers.seller.suspended: the seller leaves Featured sellers (draft and live layout) */
  async onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>): Promise<void> {
    await this.changeSections(
      (s) => Boolean(s.config.sellerIds?.includes(event.sellerId)),
      (s) => ({ ...s, config: { ...s.config, sellerIds: (s.config.sellerIds ?? []).filter((x) => x !== event.sellerId) } }),
      'Removed a suspended seller from Featured sellers',
    );
  }

  /** sellers.seller.reinstated: seller_feature blocks naming the seller show again (status is read at render time) */
  async onSellerReinstatedFromSellers(_event: EventPayload<'sellers.seller.reinstated'>): Promise<void> {
    this.invalidateHome();
  }

  /** sellers.seller.closed: seller_feature blocks stay hidden for good; pages naming the seller are flagged for their owner (once per closure) */
  async onSellerClosedFromSellers(event: EventPayload<'sellers.seller.closed'>, eventId?: string): Promise<void> {
    this.invalidateHome();
    const pages = await this.repo.listPages({});
    const versions = await this.pageVersionsById(pages);
    const featuresSeller = (id: string | null) => {
      const v = id ? versions.get(id) : undefined;
      return ((v?.snapshot as unknown as PageDraftInput | null)?.blocks ?? []).some((b) => b.type === 'seller_feature' && b.sellerId === event.sellerId);
    };
    const flagged = pages.filter((p) => featuresSeller(p.live_version_id) || featuresSeller(p.draft_version_id));
    // the claim and the flags commit together: a redelivered event flags nothing twice
    await this.repo.transaction(async (tx) => {
      if (!(await tx.claim(`seller-closed:${eventId ?? event.sellerId}`))) return;
      for (const p of flagged) await this.logAction('page', p.id, 'seller_closed', SYSTEM, `A featured seller closed (${event.reasonCode}); edit the seller feature block`, tx);
    });
  }

  /** Seller Center announcements: policy versions flagged for sellers that are scheduled or current, newest first */
  async sellerAnnouncements(opts: { since?: string; limit: number }): Promise<SellerAnnouncement[]> {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit || 10)), 100);
    const since = opts.since ? new Date(opts.since) : null;
    if (since && Number.isNaN(since.getTime())) throw invalid('since', 'Use an ISO date and time');
    const policies = (await this.repo.listPolicies()).filter((p) => p.audience === 'seller' || p.audience === 'both');
    if (!policies.length) return [];
    const byId = new Map(policies.map((p) => [p.id, p]));
    const versions = (await this.repo.policyVersionsOf(policies.map((p) => p.id)))
      .filter((v) => v.notify_sellers && (v.state === 'scheduled' || v.state === 'current') && v.effective_at)
      .filter((v) => !since || (v.published_at ?? v.effective_at!) >= since)
      .sort((a, b) => b.effective_at!.getTime() - a.effective_at!.getTime() || b.created_at.getTime() - a.created_at.getTime());
    return versions.slice(0, limit).map((v) => {
      const p = byId.get(v.policy_id)!;
      return {
        policyVersionId: v.id,
        policyKey: p.key,
        title: v.title || p.title,
        version: v.version,
        state: v.state as SellerAnnouncement['state'],
        effectiveAt: v.effective_at!.toISOString(),
        changeSummary: v.change_summary,
        url: `/policy-versions/${v.id}`,
      };
    });
  }

  /**
   * Link targets for advertising destination pickers: collections and campaign pages (the app opens both as
   * /collection/{slug}) by title or slug, or by id; available while published and live.
   */
  async linkTargets(input: { kind: 'collection'; q?: string; ids?: string[]; slugs?: string[]; limit?: number }): Promise<common.LinkTarget[]> {
    if (input.kind !== 'collection') return [];
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const q = (input.q ?? '').trim().toLowerCase();
    const rows = input.ids
      ? await this.repo.getPages(input.ids)
      : input.slugs
        ? (await Promise.all([...new Set(input.slugs)].map((s) => this.repo.pageBySlug(s)))).filter((p): p is PageRow => Boolean(p))
      : (await this.repo.listPages({ statuses: ['published', 'scheduled'] })).filter((p) => p.kind !== 'about' && (!q || p.title.toLowerCase().includes(q) || p.slug.includes(q))).slice(0, limit);
    const at = this.now();
    return rows
      .filter((p) => p.kind !== 'about')
      .map((p) => ({
        id: p.id,
        label: p.title,
        meta: `${p.kind === 'collection' ? 'Collection' : 'Page'}${p.status === 'scheduled' ? ' · scheduled' : ''}`,
        path: `/collection/${p.slug}`,
        image: null,
        available: this.pageIsLive(p, at),
      }));
  }

  /** Homepage sections and pages linked to a promotion (linkedPromotionId, or a deals source limited to it) */
  async contentForCampaign(campaignId: string): Promise<{ sections: { id: string; kind: string; heading?: string; status: string }[]; pages: { id: string; slug: string; title: string; status: string; url: string }[] }> {
    const rows = await this.repo.listSections();
    const sections = rows
      .filter((r) => r.status !== 'removed')
      .map((r) => this.snapOf(r))
      .filter((s) => s.linkedPromotionId === campaignId || this.dealsCampaignOf(s) === campaignId)
      .map((s) => ({ id: s.id, kind: s.kind, ...(s.heading ? { heading: s.heading } : {}), status: s.status }));
    const candidates = (await this.repo.listPages({})).filter((p) => p.status !== 'removed');
    const versions = await this.pageVersionsById(candidates.filter((p) => p.linked_promotion_id !== campaignId));
    const linksCampaign = (id: string | null) => {
      const snap = (id ? versions.get(id)?.snapshot : null) as unknown as PageDraftInput | null | undefined;
      return snap?.linkedPromotionId === campaignId || (snap?.blocks ?? []).some((b) => b.productSource?.mode === 'rule' && b.productSource.rule?.kind === 'deals' && b.productSource.rule.campaignId === campaignId);
    };
    const pages = candidates
      .filter((p) => p.linked_promotion_id === campaignId || linksCampaign(p.live_version_id) || linksCampaign(p.draft_version_id))
      .map((p) => ({ id: p.id, slug: p.slug, title: p.title, status: p.status, url: this.pageUrl(p) }));
    return { sections, pages };
  }

  /** The live and draft versions of pages, by id, in one read */
  private async pageVersionsById(pages: PageRow[]): Promise<Map<string, VersionRow>> {
    const ids = pages.flatMap((p) => [p.live_version_id, p.draft_version_id].filter((x): x is string => Boolean(x)));
    return new Map((await this.repo.getVersions(ids)).map((v) => [v.id, v]));
  }

  /* ---------------------------------------------------------------- jobs */

  /** Job content.run-schedules: publish and unpublish sections, pages, articles and news posts whose times have passed */
  async runSchedules(): Promise<void> {
    await this.runHomepageSchedules();
    await this.runPageSchedules();
    await this.runArticleSchedules();
    await this.runNewsSchedules();
  }

  /** Job content.refresh-collections: re-checks curated collections' availability (rule-based ones are resolved live through search) */
  async refreshCollections(): Promise<void> {
    const minutes = await this.ctx.settings.get('availabilityCheckMinutes');
    const now = this.now();
    for (const p of await this.repo.listPages({ kind: 'collection', statuses: ['published'] })) {
      const [last] = await this.repo.logsOf('page', p.id, 'availability_check');
      if (last && now.getTime() - last.at.getTime() < minutes * 60_000) continue;
      const v = p.live_version_id ? await this.repo.getVersion(p.live_version_id) : undefined;
      const snap = v?.snapshot as unknown as PageDraftInput | undefined;
      let hidden = 0;
      let shown = 0;
      for (const b of snap?.blocks ?? []) {
        if (!b.productSource) continue;
        const r = await this.resolveSource(b.productSource, { includeHidden: true });
        hidden += r.items.filter((i) => !i.available).length;
        shown += r.items.filter((i) => i.available).length;
      }
      await this.logAction('page', p.id, 'availability_check', SYSTEM, `${shown} available, ${hidden} hidden`);
    }
    this.invalidateHome();
  }

  /** Job content.cache-warm: rebuilds the resolved homepage for desktop, phone and app */
  async cacheWarm(): Promise<void> {
    this.invalidateHome();
    for (const device of ['desktop', 'phone', 'app']) await this.getHomePage({ device });
  }

  /* ---------------------------------------------------------------- GraphQL support (reads by reference) */

  /** Catalog products for nested Product objects (unknown or unavailable ones are left out) */
  async productsByIds(ids: string[]): Promise<Map<string, catalog.Product>> {
    const catalogApi = this.ctx.tryUse('catalog');
    const out = new Map<string, catalog.Product>();
    if (!catalogApi) return out;
    // batched reads (catalog answers up to 200 products a call) instead of one read per product
    const unique = [...new Set(ids)];
    const chunks = Array.from({ length: Math.ceil(unique.length / 200) }, (_, i) => unique.slice(i * 200, i * 200 + 200));
    const records = await Promise.all(chunks.map((chunk) => this.soft('catalog.getProducts', () => catalogApi.getProducts(chunk), [] as catalog.ProductRecord[])));
    for (const r of records.flat()) out.set(r.product.id, r.product);
    return out;
  }

  async categoriesById(): Promise<Map<string, catalog.Category>> {
    return this.categoryIndex();
  }

  /** Storefront cards and status of sellers, for nested Seller objects */
  async sellersByIds(ids: string[]): Promise<Map<string, { card: sellers.SellerSummary; snapshot: sellers.SellerSnapshot | null }>> {
    const sellersApi = this.ctx.tryUse('sellers');
    const out = new Map<string, { card: sellers.SellerSummary; snapshot: sellers.SellerSnapshot | null }>();
    if (!sellersApi || !ids.length) return out;
    const [cards, snaps] = await Promise.all([this.soft('sellers.getStorefrontCard', () => sellersApi.getStorefrontCard(ids), []), this.soft('sellers.getSellers', () => sellersApi.getSellers(ids), [])]);
    for (const c of cards) out.set(c.id, { card: c, snapshot: snaps.find((s) => s.id === c.id) ?? null });
    return out;
  }

  /** A live collection page as the GraphQL Collection (curator, selection rule, refresh time) */
  async collectionInfo(pageId: string): Promise<{ id: string; kind: string; title: string; slug: string; url: string; curator: { name: string; updatedAt: string; sectionCount: number; productCount: number } | null; selectionRule: string | null; refreshedAt: string | null } | null> {
    const p = await this.repo.getPage(pageId);
    if (!p || p.kind !== 'collection' || !this.pageIsLive(p)) return null;
    const v = p.live_version_id ? await this.repo.getVersion(p.live_version_id) : undefined;
    const snap = v?.snapshot as unknown as PageDraftInput | undefined;
    const sources = (snap?.blocks ?? []).map((b) => b.productSource).filter(Boolean);
    const rule = sources.find((s) => s?.mode === 'rule')?.rule;
    const [check] = await this.repo.logsOf('page', p.id, 'availability_check');
    const updatedAt = (v?.published_at ?? p.updated_at).toISOString();
    return {
      id: p.id,
      kind: p.collection_kind ?? 'curated',
      title: p.title,
      slug: p.slug,
      url: this.pageUrl(p),
      curator: snap?.curatorName ? { name: snap.curatorName, updatedAt, sectionCount: sources.length, productCount: (await this.collectionItems(p.id)).length } : null,
      selectionRule: rule ? rule.description || null : null,
      refreshedAt: iso(check?.at) ?? (rule ? this.now().toISOString() : null),
    };
  }

  /** SEO fields and the linked campaign of a page's live (or draft, for previews) version */
  async pageExtras(pageId: string, opts: { draft?: boolean } = {}): Promise<{ seoTitle: string | null; seoDescription: string | null; linkedPromotionId: string | null } | null> {
    const p = await this.repo.getPage(pageId);
    const versionId = p ? (opts.draft ? (p.draft_version_id ?? p.live_version_id) : p.live_version_id) : null;
    const v = versionId ? await this.repo.getVersion(versionId) : undefined;
    const snap = v?.snapshot as unknown as PageDraftInput | undefined;
    if (!p) return null;
    return { seoTitle: snap?.seoTitle ?? null, seoDescription: snap?.seoDescription ?? null, linkedPromotionId: snap?.linkedPromotionId ?? p.linked_promotion_id };
  }

  async helpCategoriesById(): Promise<Map<string, HelpCategory>> {
    return new Map((await this.listHelpCategoriesAdmin()).map((c) => [c.id, c]));
  }
}
