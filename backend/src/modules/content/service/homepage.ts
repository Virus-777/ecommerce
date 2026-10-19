/**
 * Homepage: the draft layout (home_sections rows), published layout versions (versions with entity
 * homepage), per-section schedules, locked ad positions, preview and the resolved store homepage.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { BannerBlock, HomeSection, HomeSectionAdmin, Homepage, HomepageAdmin, HomepageReview, LinkRef, NewsCard, PreviewRequest, ProductSource, PromiseItem, SectionInput, SectionProductRow, Version } from '../../../spec/content.js';
import { DEFAULT_AD_POSITIONS, DEFAULT_RULES, HOMEPAGE_ID, inWindow, PRODUCT_KINDS, SECTION_KIND_LABEL } from '../domain/rules.js';
import { contentPublicationMachine } from '../domain/state-machines.js';
import type { SectionRow, VersionRow } from '../ports.js';
import type { ContentRepository } from '../repository.js';
import { actorFromKey, actorKey, dateOrNull, invalid, iso, notFound, requireText, SYSTEM, unique, type By } from './base.js';
import { ContentPages } from './pages.js';

/** What home_sections.config keeps: the kind-specific parts of SectionInput */
interface SectionConfig {
  banner?: BannerBlock | null;
  productSource?: ProductSource | null;
  categoryIds?: string[] | null;
  sellerIds?: string[] | null;
  brandIds?: string[] | null;
  promiseItems?: PromiseItem[] | null;
  /** Ad positions: name from advertising */
  name?: string | null;
  /** Set when the linked promotion ended (the section stays hidden) */
  hiddenByPromotion?: boolean | null;
}

/** One section in a published layout version */
interface SectionSnap {
  id: string;
  kind: string;
  heading: string | null;
  subheading: string | null;
  config: SectionConfig;
  linkedPromotionId: string | null;
  linkedPageId: string | null;
  adPlacementKey: string | null;
  showFrom: string | null;
  removeAt: string | null;
  timeZone: string;
  ownerStaffId: string | null;
  ownerRole: string | null;
  status: string;
}

interface LayoutSnapshot {
  sections: SectionSnap[];
}

type SectionStatus = HomeSectionAdmin['status'];

/** What GraphQL shows beyond the REST HomeSection */
export interface SectionMeta {
  linkedPromotionId: string | null;
  collectionId: string | null;
  selectionRule: string | null;
  categoryIds: string[];
  sellerIds: string[];
}
export type ResolvedHomeSection = HomeSection & { position: number; meta: SectionMeta };
export interface ResolvedHomepage {
  version: number;
  generatedAt: string;
  sections: ResolvedHomeSection[];
}

const AD_MANAGED = 'Managed in Advertisements';

const bannerIds = (c: SectionConfig | null | undefined): { id: string; path: string }[] => (c?.banner?.images ?? []).map((img, i) => ({ id: img.id, path: `banner.images[${i}]` }));

export class ContentHomepage extends ContentPages {
  /* ---------------------------------------------------------------- layout plumbing */

  protected snapOf(r: SectionRow): SectionSnap {
    return {
      id: r.id,
      kind: r.kind,
      heading: r.heading,
      subheading: r.subheading,
      config: (r.config ?? {}) as SectionConfig,
      linkedPromotionId: r.linked_promotion_id,
      linkedPageId: r.linked_page_id,
      adPlacementKey: r.ad_placement_key,
      showFrom: iso(r.show_from),
      removeAt: iso(r.remove_at),
      timeZone: r.time_zone,
      ownerStaffId: r.owner_staff_id,
      ownerRole: r.owner_role,
      status: r.status,
    };
  }

  /** The draft layout: every section not removed from the draft, in order */
  protected draftLayout(rows: SectionRow[]): LayoutSnapshot {
    return { sections: rows.filter((r) => r.status !== 'removed').map((r) => this.snapOf(r)) };
  }

  protected async homepageVersions(repo: ContentRepository = this.repo) {
    // one read for both (newest first)
    const versions = await repo.versionsOf('homepage', HOMEPAGE_ID, ['live', 'draft']);
    return { live: versions.find((v) => v.state === 'live'), draft: versions.find((v) => v.state === 'draft') };
  }

  protected layoutOf(v: VersionRow | undefined | null): LayoutSnapshot {
    return (v?.snapshot as unknown as LayoutSnapshot | undefined) ?? { sections: [] };
  }

  /** Keeps one draft version in step with the draft layout (created on the first edit after a publish) */
  private async touchDraft(tx: ContentRepository, by: By, summary: string) {
    const layout = this.draftLayout(await tx.listSections());
    const { draft } = await this.homepageVersions(tx);
    if (draft) {
      const text = draft.summary ? `${draft.summary}; ${summary}` : summary;
      // a person's edit after submission sends the draft back to not_submitted (system upkeep does not)
      const reset = by.actor.kind !== 'system' && draft.review_state && draft.review_state !== 'not_submitted';
      await tx.updateVersion(draft.id, {
        snapshot: layout as never,
        summary: text.length > 480 ? `${text.slice(0, 477)}…` : text,
        ...(by.actor.kind !== 'system' ? { author_kind: by.actor.kind, author_id: by.actor.id ?? null } : {}),
        ...(reset ? { review_state: 'not_submitted' as const, submitted_by: null, submitted_at: null, reviewed_by: null, reviewed_at: null } : {}),
      });
    } else {
      await tx.insertVersion(this.newVersionRow('homepage', HOMEPAGE_ID, (await tx.maxVersionNumber('homepage', HOMEPAGE_ID)) + 1, layout, by, { summary, review_state: 'not_submitted' }));
    }
  }

  /** The promotion a deals source is limited to (SourceRule.campaignId), if any */
  protected dealsCampaignOf(s: { config: SectionConfig }): string | null {
    const rule = s.config.productSource?.mode === 'rule' ? s.config.productSource.rule : null;
    return rule?.kind === 'deals' ? (rule.campaignId ?? null) : null;
  }

  /** HomepageAdmin.draftReview: not_required unless content.reviewRequired.section is on */
  private draftReviewOf(draft: VersionRow | undefined, required: boolean): HomepageReview {
    if (!required) return { state: 'not_required', submittedBy: null, submittedAt: null, reviewedBy: null, reviewedAt: null, note: null };
    return {
      state: (draft?.review_state ?? 'not_submitted') as HomepageReview['state'],
      submittedBy: draft?.submitted_by ? actorFromKey(draft.submitted_by) : null,
      submittedAt: iso(draft?.submitted_at),
      reviewedBy: draft?.reviewed_by ? actorFromKey(draft.reviewed_by) : null,
      reviewedAt: iso(draft?.reviewed_at),
      note: draft?.review_note ?? null,
    };
  }

  /** Draft layout → in_review (only when content.reviewRequired.section is on) */
  async submitHomepageDraft(body: { summary?: string | null }, by: By): Promise<HomepageAdmin> {
    if (!(await this.reviewRequired()).section) throw new AppError('ILLEGAL_TRANSITION', 'Homepage review is off: publish the draft directly', { machine: 'Homepage review', event: 'submit', reason: 'review_not_required' });
    const now = this.now();
    let number = 0;
    await this.repo.transaction(async (tx) => {
      const { draft } = await this.homepageVersions(tx);
      if (!draft) throw new AppError('CONFLICT', 'There are no unpublished changes to send for review');
      const from = draft.review_state ?? 'not_submitted';
      if (from !== 'not_submitted' && from !== 'changes_requested') throw new AppError('ILLEGAL_TRANSITION', from === 'in_review' ? 'The draft is already waiting for review' : 'The draft is already approved', { machine: 'Homepage review', from, event: 'submit' });
      const extra = body.summary?.trim();
      const text = extra ? (draft.summary ? `${draft.summary}; ${extra}` : extra) : draft.summary;
      await tx.updateVersion(draft.id, { review_state: 'in_review', submitted_by: actorKey(by.actor), submitted_at: now, reviewed_by: null, reviewed_at: null, review_note: null, summary: text && text.length > 480 ? `${text.slice(0, 477)}…` : text });
      number = draft.number;
    });
    await this.logAction('homepage', HOMEPAGE_ID, 'submit', by, body.summary ?? null);
    await this.audit({ action: 'content.homepage.submit', actionLabel: `Sent homepage draft version ${number} for review`, target: { type: 'homepage', id: HOMEPAGE_ID, label: `Homepage v${number}` }, reason: body.summary ?? null }, by);
    return this.getHomepageAdmin();
  }

  /** in_review → approved or changes_requested; whoever submitted or last edited the draft cannot approve it */
  async reviewHomepageDraft(body: { approve: boolean; note?: string | null }, by: By): Promise<HomepageAdmin> {
    if (!(await this.reviewRequired()).section) throw new AppError('ILLEGAL_TRANSITION', 'Homepage review is off: publish the draft directly', { machine: 'Homepage review', event: 'review', reason: 'review_not_required' });
    const note = body.approve ? body.note?.trim() || null : requireText(body.note, 'note', 'Say what needs to change');
    const now = this.now();
    let number = 0;
    await this.repo.transaction(async (tx) => {
      const { draft } = await this.homepageVersions(tx);
      const from = draft?.review_state ?? 'not_submitted';
      if (!draft || from !== 'in_review') throw new AppError('ILLEGAL_TRANSITION', 'The draft is not waiting for review', { machine: 'Homepage review', from, event: body.approve ? 'approve' : 'request_changes' });
      const me = actorKey(by.actor);
      const lastEditor = draft.author_id ? `${draft.author_kind}:${draft.author_id}` : null;
      if (body.approve && (draft.submitted_by === me || lastEditor === me)) throw this.ctx.error('SAME_REVIEWER', 'Someone other than the person who submitted or last edited the homepage draft must approve it.');
      await tx.updateVersion(draft.id, { review_state: body.approve ? 'approved' : 'changes_requested', reviewed_by: me, reviewed_at: now, review_note: note });
      number = draft.number;
    });
    await this.logAction('homepage', HOMEPAGE_ID, body.approve ? 'review_approved' : 'review_changes_requested', by, note);
    await this.audit({ action: body.approve ? 'content.homepage.approve' : 'content.homepage.request-changes', actionLabel: body.approve ? `Approved homepage draft version ${number}` : `Requested changes to homepage draft version ${number}`, target: { type: 'homepage', id: HOMEPAGE_ID, label: `Homepage v${number}` }, reason: note }, by);
    return this.getHomepageAdmin();
  }

  /** Records a new live layout (publish, restore, immediate removal, scheduled changes) */
  private async recordLive(tx: ContentRepository, layout: LayoutSnapshot, by: By, summary: string, opts: { fromDraft?: VersionRow; restoredFrom?: number } = {}): Promise<VersionRow> {
    const now = this.now();
    const { live } = await this.homepageVersions(tx);
    if (live) await tx.updateVersion(live.id, { state: 'superseded' });
    if (opts.fromDraft) return tx.updateVersion(opts.fromDraft.id, { state: 'live', snapshot: layout as never, summary, published_at: now, author_kind: by.actor.kind, author_id: by.actor.id ?? null });
    return tx.insertVersion(this.newVersionRow('homepage', HOMEPAGE_ID, (await tx.maxVersionNumber('homepage', HOMEPAGE_ID)) + 1, layout, by, { state: 'live', summary, published_at: now, restored_from: opts.restoredFrom ?? null }));
  }

  private publishedEvent(version: VersionRow, by: By) {
    this.invalidateHome();
    this.ctx.events.publish('content.page.published', { entity: 'homepage', entityId: HOMEPAGE_ID, slug: null, version: version.number, url: '/' }, { actor: by.actor, requestId: by.requestId });
  }

  /** Ad positions are locked markers controlled by advertising; seeded once (as the first live layout when nothing is published) */
  async ensureAdPositions(): Promise<void> {
    const rows = await this.repo.listSections();
    if (rows.some((r) => r.kind === 'ad_position')) return;
    const advertising = this.ctx.tryUse('advertising');
    const fromAds = await this.soft('advertising.adPositionsFor', advertising && (() => advertising.adPositionsFor('home')), null);
    const positions = fromAds ? fromAds.filter((p) => p.enabled).map((p) => ({ key: p.placementKey, name: p.name })) : DEFAULT_AD_POSITIONS;
    if (!positions.length) return;
    const tz = await this.marketTimeZone();
    const now = this.now();
    await this.repo.transaction(async (tx) => {
      const current = await tx.listSections();
      if (current.some((r) => r.kind === 'ad_position')) return;
      let pos = current.length;
      for (const [i, p] of positions.entries()) {
        await tx.insertSection({
          id: newId(),
          kind: 'ad_position',
          heading: p.name,
          subheading: null,
          config: { name: p.name } as never,
          linked_promotion_id: null,
          linked_page_id: null,
          ad_placement_key: p.key,
          show_from: null,
          remove_at: null,
          time_zone: tz,
          owner_staff_id: null,
          owner_role: 'Advertising',
          status: 'published',
          // the opening ad first, the others after the content sections
          draft_position: i === 0 ? -1 : ++pos,
          removed_reason: null,
          updated_by: actorKey(SYSTEM.actor),
          updated_at: now,
        });
      }
      await this.renumber(tx);
      const { live } = await this.homepageVersions(tx);
      if (!live && !current.length) await this.recordLive(tx, this.draftLayout(await tx.listSections()), SYSTEM, 'Ad positions from Advertisements');
      else await this.touchDraft(tx, SYSTEM, 'Ad positions from Advertisements');
    });
  }

  /** draft_position 1..n in the current order (removed rows keep theirs) */
  private async renumber(tx: ContentRepository, order?: string[]) {
    const rows = await tx.listSections();
    const active = rows.filter((r) => r.status !== 'removed');
    const sorted = order ? order.map((id) => active.find((r) => r.id === id)!).filter(Boolean) : active;
    for (const [i, r] of sorted.entries()) if (r.draft_position !== i + 1) await tx.updateSection(r.id, { draft_position: i + 1 });
  }

  /* ---------------------------------------------------------------- admin views */

  private sectionTitle(s: { kind: string; heading: string | null; config: SectionConfig }) {
    return s.heading?.trim() || s.config.banner?.headline || s.config.name || SECTION_KIND_LABEL[s.kind] || s.kind;
  }

  /** The product source a section shows: its own, a linked collection, or the default rule of its kind */
  protected sourceOf(s: { kind: string; config: SectionConfig; linkedPageId: string | null }): ProductSource | null {
    if (s.config.productSource) return s.config.productSource;
    if (s.kind === 'collection_teaser' && s.linkedPageId) return { mode: 'collection', collectionId: s.linkedPageId };
    const rule = DEFAULT_RULES[s.kind];
    return rule ? { mode: 'rule', rule: { kind: rule.kind, days: rule.days ?? null, description: rule.description } } : null;
  }

  private async sectionAdmin(r: SectionRow, position: number, owner: HomeSectionAdmin['owner']): Promise<HomeSectionAdmin> {
    const s = this.snapOf(r);
    const ad = r.kind === 'ad_position';
    let productCount = 0;
    let hidden = 0;
    let modeLabel = '';
    if (PRODUCT_KINDS.has(r.kind) || s.config.productSource) {
      const source = this.sourceOf(s);
      const max = await this.ctx.settings.get('maxSectionProducts');
      const res = await this.resolveSource(source, { includeHidden: true, limit: Math.min(source?.limit ?? max, max) || max });
      productCount = res.items.filter((i) => i.available).length;
      hidden = res.items.length - productCount;
      modeLabel = source?.mode === 'manual' ? 'manual selection' : source?.mode === 'collection' ? 'from a collection' : 'selection rule';
    }
    const n = (list: unknown[] | null | undefined) => list?.length ?? 0;
    const description = ad
      ? AD_MANAGED
      : PRODUCT_KINDS.has(r.kind)
        ? `${productCount} ${productCount === 1 ? 'product' : 'products'} · ${modeLabel}`
        : r.kind === 'category_shortcuts'
          ? `${n(s.config.categoryIds)} categories`
          : r.kind === 'featured_sellers'
            ? `${n(s.config.sellerIds)} sellers`
            : r.kind === 'brand_collections'
              ? `${n(s.config.brandIds)} brands`
              : r.kind === 'promise_strip'
                ? `${n(s.config.promiseItems)} promises`
                : r.kind === 'deals'
                  ? 'Live flash sales from Promotions'
                  : r.kind === 'recently_viewed'
                    ? "Each customer's recently viewed products"
                    : r.kind === 'news'
                      ? 'The newest news posts, pinned first'
                    : (s.config.banner?.headline ?? SECTION_KIND_LABEL[r.kind] ?? r.kind);
    const status: SectionStatus = (['draft', 'scheduled', 'published', 'unpublished', 'removed'] as const).includes(r.status as SectionStatus) ? (r.status as SectionStatus) : 'draft';
    return {
      id: r.id,
      position,
      kind: r.kind,
      title: this.sectionTitle(s),
      description,
      owner,
      schedule: this.schedule(r.show_from, r.remove_at, r.time_zone, Boolean(r.linked_promotion_id) && !r.show_from && !r.remove_at),
      status,
      locked: ad,
      adPlacementKey: r.ad_placement_key,
      managedIn: ad ? AD_MANAGED : null,
      config: ad ? null : this.inputOf(r, position),
      unavailableHidden: hidden,
      productCount,
      updatedAt: r.updated_at.toISOString(),
    };
  }

  private inputOf(r: SectionRow, position: number): SectionInput {
    const c = (r.config ?? {}) as SectionConfig;
    return {
      kind: r.kind as SectionInput['kind'],
      heading: r.heading,
      subheading: r.subheading,
      banner: c.banner ?? null,
      productSource: c.productSource ?? null,
      categoryIds: c.categoryIds ?? null,
      sellerIds: c.sellerIds ?? null,
      brandIds: c.brandIds ?? null,
      linkedPromotionId: r.linked_promotion_id,
      linkedPageId: r.linked_page_id,
      promiseItems: c.promiseItems ?? null,
      showFrom: iso(r.show_from),
      removeAt: iso(r.remove_at),
      timeZone: r.time_zone,
      ownerStaffId: r.owner_staff_id,
      ownerRole: r.owner_role,
      position,
    };
  }

  /** Sections shown in the admin list: the draft layout plus sections removed from the draft that are still live */
  private async adminRows(): Promise<{ row: SectionRow; position: number }[]> {
    const rows = await this.repo.listSections();
    const { live } = await this.homepageVersions();
    const liveIds = new Set(this.layoutOf(live).sections.map((s) => s.id));
    const active = rows.filter((r) => r.status !== 'removed');
    const pendingRemoval = rows.filter((r) => r.status === 'removed' && liveIds.has(r.id));
    return [...active.map((row, i) => ({ row, position: i + 1 })), ...pendingRemoval.map((row) => ({ row, position: 0 }))];
  }

  private async sectionsAdmin(list: { row: SectionRow; position: number }[]): Promise<HomeSectionAdmin[]> {
    const owners = await this.owners(list.map((x) => ({ staffId: x.row.owner_staff_id, role: x.row.owner_role })));
    return Promise.all(list.map((x, i) => this.sectionAdmin(x.row, x.position, owners[i]!)));
  }

  async getHomepageAdmin(): Promise<HomepageAdmin> {
    const [list, versions, tz, review] = await Promise.all([this.adminRows(), this.homepageVersions(), this.marketTimeZone(), this.reviewRequired()]);
    return {
      liveVersion: versions.live?.number ?? 0,
      draftVersion: versions.draft?.number ?? null,
      hasDraft: Boolean(versions.draft),
      draftReview: this.draftReviewOf(versions.draft, review.section),
      sections: await this.sectionsAdmin(list),
      timeZone: tz,
      owner: { staffId: null, name: 'Content team', role: 'Content' },
    };
  }

  private async sectionAdminById(id: string): Promise<HomeSectionAdmin> {
    const list = await this.adminRows();
    const hit = list.find((x) => x.row.id === id);
    const row = hit?.row ?? (await this.repo.getSection(id));
    if (!row) throw notFound('Section');
    const [owner] = await this.owners([{ staffId: row.owner_staff_id, role: row.owner_role }]);
    return this.sectionAdmin(row, hit?.position ?? 0, owner!);
  }

  async listHomepageVersions(page: PageRequest): Promise<common.Page<Version>> {
    const res = await this.repo.pageOfVersions('homepage', HOMEPAGE_ID, page);
    return { ...res, items: res.items.map((v) => this.versionOut(v)) };
  }

  async listHomeSectionProducts(id: string, q: { includeHidden?: boolean }, page: PageRequest): Promise<common.Page<SectionProductRow>> {
    const row = await this.repo.getSection(id);
    if (!row) throw notFound('Section');
    const s = this.snapOf(row);
    const source = this.sourceOf(s);
    const max = await this.ctx.settings.get('maxSectionProducts');
    const res = await this.resolveSource(source, { includeHidden: true, limit: source?.limit ?? max });
    const stock = await this.stockOf(res.items.map((i) => i.offerId).filter((x): x is string => Boolean(x)));
    const rows: SectionProductRow[] = res.items.map((i, n) => ({
      productId: i.productId,
      offerId: i.offerId,
      position: n + 1,
      title: i.tile.title,
      image: i.tile.image ?? null,
      sellerName: i.tile.sellerName ?? null,
      stock: i.offerId ? (stock.get(i.offerId) ?? null) : null,
      available: i.available,
      hiddenReason: i.available ? null : (i.hiddenReason ?? 'product_hidden'),
    }));
    return pageOf(q.includeHidden ? rows : rows.filter((r) => r.available), page);
  }

  /* ---------------------------------------------------------------- section writes */

  private async checkSection(input: SectionInput, opts: { count: number; editing?: SectionRow }): Promise<{ config: SectionConfig; showFrom: Date | null; removeAt: Date | null; timeZone: string }> {
    const max = await this.ctx.settings.get('maxSectionProducts');
    const banner = this.checkBanner(input.banner, 'banner');
    if (input.kind === 'campaign_banner' && !banner) throw invalid('banner', 'A campaign banner needs its banner');
    if (input.kind === 'promise_strip') {
      const items = input.promiseItems ?? [];
      if (items.length < 2 || items.length > 4) throw invalid('promiseItems', 'Add 2 to 4 promises');
      items.forEach((p, i) => {
        requireText(p.icon, `promiseItems[${i}].icon`);
        requireText(p.title, `promiseItems[${i}].title`);
        requireText(p.body, `promiseItems[${i}].body`);
      });
    } else if (input.promiseItems?.length) throw invalid('promiseItems', 'Only the Our promise strip has promises');
    if (input.kind === 'category_shortcuts' && !input.categoryIds?.length) throw invalid('categoryIds', 'Pick at least one category');
    if (input.kind === 'featured_sellers' && !input.sellerIds?.length) throw invalid('sellerIds', 'Pick at least one seller');
    if (input.kind === 'brand_collections' && !input.brandIds?.length) throw invalid('brandIds', 'Pick at least one brand');
    if (input.kind === 'featured_products' && !input.productSource) throw invalid('productSource', 'Pick the products to feature');
    if (input.kind === 'collection_teaser' && !input.linkedPageId && !input.productSource) throw invalid('linkedPageId', 'Pick the collection to tease');
    const productSource = this.checkSource(input.productSource, 'productSource', max);
    if (productSource?.mode === 'collection' && productSource.collectionId && !(await this.repo.getPage(productSource.collectionId))) throw invalid('productSource.collectionId', 'Collection not found');
    if (input.linkedPageId && !(await this.repo.getPage(input.linkedPageId))) throw invalid('linkedPageId', 'Page not found');
    const showFrom = dateOrNull(input.showFrom);
    const removeAt = dateOrNull(input.removeAt);
    if (showFrom && removeAt && removeAt <= showFrom) throw invalid('removeAt', 'The removal time must be after the start');
    const timeZone = await this.timeZoneOr(input.timeZone ?? opts.editing?.time_zone);
    if (input.position != null && (input.position < 1 || input.position > opts.count + 1)) throw invalid('position', `Use a position from 1 to ${opts.count + 1}`);
    return {
      config: {
        banner,
        productSource,
        categoryIds: input.categoryIds ? unique(input.categoryIds) : null,
        sellerIds: input.sellerIds ? unique(input.sellerIds) : null,
        brandIds: input.brandIds ? unique(input.brandIds) : null,
        promiseItems: input.promiseItems ?? null,
      },
      showFrom,
      removeAt,
      timeZone,
    };
  }

  private async liveFilesOf(sectionId: string): Promise<string[]> {
    const { live } = await this.homepageVersions();
    return bannerIds(this.layoutOf(live).sections.find((s) => s.id === sectionId)?.config).map((f) => f.id);
  }

  async addHomeSection(input: SectionInput, by: By): Promise<HomeSectionAdmin> {
    const active = (await this.repo.listSections()).filter((r) => r.status !== 'removed');
    const checked = await this.checkSection(input, { count: active.length });
    const id = newId();
    const title = this.sectionTitle({ kind: input.kind, heading: input.heading ?? null, config: checked.config });
    const media = await this.syncMedia('content_block', id, title, [], bannerIds(checked.config));
    try {
      await this.repo.transaction(async (tx) => {
        await tx.insertSection({
          id,
          kind: input.kind,
          heading: input.heading?.trim() || null,
          subheading: input.subheading?.trim() || null,
          config: checked.config as never,
          linked_promotion_id: input.linkedPromotionId ?? null,
          linked_page_id: input.linkedPageId ?? null,
          ad_placement_key: null,
          show_from: checked.showFrom,
          remove_at: checked.removeAt,
          time_zone: checked.timeZone,
          owner_staff_id: input.ownerStaffId ?? this.staffIdOf(by),
          owner_role: input.ownerRole?.trim() || 'Content',
          status: 'draft',
          draft_position: 10_000,
          removed_reason: null,
          updated_by: actorKey(by.actor),
          updated_at: this.now(),
        });
        const order = (await tx.listSections()).filter((r) => r.status !== 'removed' && r.id !== id).map((r) => r.id);
        order.splice((input.position ?? order.length + 1) - 1, 0, id);
        await this.renumber(tx, order);
        await this.touchDraft(tx, by, `Added ${title}`);
      });
    } catch (err) {
      await media.undo();
      throw err;
    }
    this.invalidateHome();
    const out = await this.sectionAdminById(id);
    await this.audit({ action: 'content.homepage.section.add', actionLabel: 'Added homepage section', target: { type: 'home_section', id, label: out.title }, after: out.config }, by);
    return out;
  }

  private async editableSection(id: string): Promise<SectionRow> {
    const row = await this.repo.getSection(id);
    if (!row) throw notFound('Section');
    if (row.kind === 'ad_position') throw this.ctx.error('SECTION_LOCKED', 'Ad positions are controlled by advertising and cannot be edited here.');
    return row;
  }

  async updateHomeSection(id: string, input: SectionInput, by: By): Promise<HomeSectionAdmin> {
    const row = await this.editableSection(id);
    if (row.status === 'removed') throw new AppError('CONFLICT', 'The section was removed from the draft');
    const active = (await this.repo.listSections()).filter((r) => r.status !== 'removed');
    const checked = await this.checkSection(input, { count: active.length - 1, editing: row });
    const title = this.sectionTitle({ kind: input.kind, heading: input.heading ?? null, config: checked.config });
    const before = [...bannerIds(row.config as SectionConfig).map((f) => f.id), ...(await this.liveFilesOf(id))];
    const media = await this.syncMedia('content_block', id, title, before, [...bannerIds(checked.config), ...(await this.liveFilesOf(id)).map((x) => ({ id: x, path: 'banner' }))]);
    try {
      await this.repo.transaction(async (tx) => {
        await tx.updateSection(id, {
          kind: input.kind,
          heading: input.heading?.trim() || null,
          subheading: input.subheading?.trim() || null,
          config: { ...(row.config as SectionConfig), ...checked.config } as never,
          linked_promotion_id: input.linkedPromotionId ?? null,
          linked_page_id: input.linkedPageId ?? null,
          show_from: checked.showFrom,
          remove_at: checked.removeAt,
          time_zone: checked.timeZone,
          owner_staff_id: input.ownerStaffId ?? row.owner_staff_id,
          owner_role: input.ownerRole?.trim() || row.owner_role,
          updated_by: actorKey(by.actor),
          updated_at: this.now(),
        });
        if (input.position != null) {
          const order = (await tx.listSections()).filter((r) => r.status !== 'removed' && r.id !== id).map((r) => r.id);
          order.splice(input.position - 1, 0, id);
          await this.renumber(tx, order);
        }
        await this.touchDraft(tx, by, `Edited ${title}`);
      });
    } catch (err) {
      await media.undo();
      throw err;
    }
    await media.commit();
    this.invalidateHome();
    const out = await this.sectionAdminById(id);
    await this.audit({ action: 'content.homepage.section.update', actionLabel: 'Edited homepage section', target: { type: 'home_section', id, label: out.title }, before: this.inputOf(row, 0), after: out.config }, by);
    return out;
  }

  async scheduleHomeSection(id: string, body: { showFrom: string; removeAt?: string | null; timeZone: string }, by: By): Promise<HomeSectionAdmin> {
    const row = await this.editableSection(id);
    const showFrom = new Date(body.showFrom);
    const removeAt = dateOrNull(body.removeAt);
    if (removeAt && removeAt <= showFrom) throw invalid('removeAt', 'The removal time must be after the start');
    const tz = await this.timeZoneOr(body.timeZone);
    const status = contentPublicationMachine.next(row.status as SectionStatus, 'schedule');
    await this.repo.transaction(async (tx) => {
      await tx.updateSection(id, { status, show_from: showFrom, remove_at: removeAt, time_zone: tz, updated_by: actorKey(by.actor), updated_at: this.now() });
      await this.touchDraft(tx, by, `Scheduled ${this.sectionTitle(this.snapOf(row))}`);
    });
    this.invalidateHome();
    await this.logAction('home_section', id, 'schedule', by, `${showFrom.toISOString()}${removeAt ? ` – ${removeAt.toISOString()}` : ''}`);
    const out = await this.sectionAdminById(id);
    await this.audit({ action: 'content.homepage.section.schedule', actionLabel: 'Scheduled homepage section', target: { type: 'home_section', id, label: out.title }, before: { status: row.status, showFrom: iso(row.show_from), removeAt: iso(row.remove_at) }, after: { status, showFrom: showFrom.toISOString(), removeAt: iso(removeAt) } }, by);
    return out;
  }

  async removeHomeSection(id: string, body: { kind: 'correction' | 'removal'; reason: string; immediately: boolean }, by: By): Promise<HomeSectionAdmin> {
    const reason = requireText(body.reason, 'reason', 'A reason is required');
    const row = await this.editableSection(id);
    const { live } = await this.homepageVersions();
    const liveLayout = this.layoutOf(live);
    const isLive = liveLayout.sections.some((s) => s.id === id);
    const title = this.sectionTitle(this.snapOf(row));
    let out: HomeSectionAdmin;
    if (!isLive && row.status !== 'removed' && row.status !== 'published' && row.status !== 'unpublished') {
      // never shown to customers: it simply leaves the draft
      const [owner] = await this.owners([{ staffId: row.owner_staff_id, role: row.owner_role }]);
      out = { ...(await this.sectionAdmin(row, 0, owner!)), status: 'removed' };
      await this.repo.transaction(async (tx) => {
        await tx.deleteSection(id);
        await this.renumber(tx);
        await this.touchDraft(tx, by, `Removed ${title} from the draft`);
      });
      for (const f of bannerIds(row.config as SectionConfig)) await this.media.detach(f.id, { module: 'content', kind: 'content_block', refId: id }).catch(() => {});
    } else {
      // scheduled sections already in the live layout come down like published ones
      const status = row.status === 'scheduled' && isLive ? 'removed' : contentPublicationMachine.next(row.status as SectionStatus, 'remove');
      let version: VersionRow | null = null;
      await this.repo.transaction(async (tx) => {
        await tx.updateSection(id, { status, removed_reason: `${body.kind}: ${reason}`, updated_by: actorKey(by.actor), updated_at: this.now() });
        await this.renumber(tx);
        await this.touchDraft(tx, by, `Removed ${title}`);
        if (body.immediately && isLive) {
          version = await this.recordLive(tx, { sections: liveLayout.sections.filter((s) => s.id !== id) }, by, `${body.kind === 'correction' ? 'Correction' : 'Removal'}: took down ${title} (${reason})`);
        }
      });
      if (version) {
        this.publishedEvent(version, by);
        this.ctx.events.publish('content.page.removed', { entity: 'homepage_section', entityId: id, kind: body.kind, reason }, { actor: by.actor, requestId: by.requestId });
      }
      out = await this.sectionAdminById(id);
    }
    this.invalidateHome();
    await this.logAction('home_section', id, body.kind, by, reason);
    await this.audit({ action: `content.homepage.section.${body.kind}`, actionLabel: body.immediately ? 'Took homepage section down now' : 'Removed homepage section from the draft', target: { type: 'home_section', id, label: title }, reason, before: { status: row.status }, after: { status: out.status, immediately: body.immediately } }, by);
    return out;
  }

  async reorderHomeSections(sectionIds: string[], by: By): Promise<HomepageAdmin> {
    await this.repo.transaction(async (tx) => {
      const active = (await tx.listSections()).filter((r) => r.status !== 'removed');
      const ids = active.map((r) => r.id);
      if (sectionIds.length !== ids.length || new Set(sectionIds).size !== ids.length || !sectionIds.every((s) => ids.includes(s))) {
        throw new AppError('CONFLICT', 'The layout changed since it was loaded; reload and reorder again', { expected: ids });
      }
      await this.renumber(tx, sectionIds);
      await this.touchDraft(tx, by, 'Reordered sections');
    });
    this.invalidateHome();
    return this.getHomepageAdmin();
  }

  async publishHomepage(body: { summary: string }, by: By): Promise<HomepageAdmin> {
    const summary = body.summary?.trim() || 'Published the homepage';
    const now = this.now();
    const reviewOn = (await this.reviewRequired()).section;
    let version!: VersionRow;
    let dropped: SectionRow[] = [];
    await this.repo.transaction(async (tx) => {
      const { draft } = await this.homepageVersions(tx);
      if (!draft) throw new AppError('CONFLICT', 'There are no unpublished changes');
      if (reviewOn && draft.review_state !== 'approved') {
        throw new AppError('ILLEGAL_TRANSITION', 'The homepage draft needs an approved review before it is published', { machine: 'Homepage review', from: draft.review_state ?? 'not_submitted', event: 'publish', reason: 'review_required' });
      }
      const rows = await tx.listSections();
      for (const r of rows) {
        if (r.status === 'removed' || r.kind === 'ad_position') continue;
        const target = r.show_from && r.show_from > now ? 'scheduled' : r.remove_at && r.remove_at <= now ? 'unpublished' : 'published';
        let status = r.status;
        if (target !== r.status) {
          if (target === 'published' && contentPublicationMachine.can(r.status as SectionStatus, 'publish')) status = 'published';
          else if (target === 'scheduled' && contentPublicationMachine.can(r.status as SectionStatus, 'schedule')) status = 'scheduled';
          else if (target === 'unpublished' && r.status === 'published') status = 'unpublished';
        }
        if (status !== r.status) await tx.updateSection(r.id, { status });
      }
      dropped = rows.filter((r) => r.status === 'removed');
      for (const r of dropped) await tx.deleteSection(r.id);
      version = await this.recordLive(tx, this.draftLayout(await tx.listSections()), by, summary, { fromDraft: draft });
    });
    for (const r of dropped) for (const f of bannerIds(r.config as SectionConfig)) await this.media.detach(f.id, { module: 'content', kind: 'content_block', refId: r.id }).catch(() => {});
    this.publishedEvent(version, by);
    await this.logAction('homepage', HOMEPAGE_ID, 'publish', by, summary);
    await this.audit({ action: 'content.homepage.publish', actionLabel: `Published homepage version ${version.number}`, target: { type: 'homepage', id: HOMEPAGE_ID, label: `Homepage v${version.number}` }, after: { version: version.number, summary } }, by);
    return this.getHomepageAdmin();
  }

  /** Puts the draft rows back to a layout (discard, restore) */
  private async resetRows(tx: ContentRepository, layout: LayoutSnapshot, by: By): Promise<SectionRow[]> {
    const rows = await tx.listSections();
    const keep = new Set(layout.sections.map((s) => s.id));
    const gone = rows.filter((r) => !keep.has(r.id));
    for (const r of gone) await tx.deleteSection(r.id);
    for (const [i, s] of layout.sections.entries()) {
      const fields: SectionRow = {
        id: s.id,
        kind: s.kind,
        heading: s.heading,
        subheading: s.subheading,
        config: s.config as never,
        linked_promotion_id: s.linkedPromotionId,
        linked_page_id: s.linkedPageId,
        ad_placement_key: s.adPlacementKey,
        show_from: dateOrNull(s.showFrom),
        remove_at: dateOrNull(s.removeAt),
        time_zone: s.timeZone,
        owner_staff_id: s.ownerStaffId,
        owner_role: s.ownerRole,
        status: s.status,
        draft_position: i + 1,
        removed_reason: null,
        updated_by: actorKey(by.actor),
        updated_at: this.now(),
      };
      if (rows.some((r) => r.id === s.id)) await tx.updateSection(s.id, fields);
      else await tx.insertSection(fields);
    }
    return gone;
  }

  private async detachGone(gone: SectionRow[], layout: LayoutSnapshot) {
    for (const r of gone) for (const f of bannerIds(r.config as SectionConfig)) await this.media.detach(f.id, { module: 'content', kind: 'content_block', refId: r.id }).catch(() => {});
    // files of restored sections are in use again
    for (const s of layout.sections) {
      for (const f of bannerIds(s.config)) {
        await this.media.attach(f.id, { module: 'content', kind: 'content_block', refId: s.id, refLabel: this.sectionTitle(s) }, { kind: 'platform' }).catch((err) => this.ctx.log.warn({ err, assetId: f.id }, 'content: restored section image unavailable'));
      }
    }
  }

  async discardHomepageDraft(by: By): Promise<HomepageAdmin> {
    let gone: SectionRow[] = [];
    let layout: LayoutSnapshot = { sections: [] };
    await this.repo.transaction(async (tx) => {
      const { live, draft } = await this.homepageVersions(tx);
      if (!draft) return;
      layout = this.layoutOf(live);
      gone = await this.resetRows(tx, layout, by);
      await tx.updateVersion(draft.id, { state: 'discarded' });
    });
    await this.detachGone(gone, layout);
    this.invalidateHome();
    await this.logAction('homepage', HOMEPAGE_ID, 'discard_draft', by);
    return this.getHomepageAdmin();
  }

  async restoreHomepageVersion(number: number, body: { reason: string; publish: boolean }, by: By): Promise<HomepageAdmin> {
    const reason = requireText(body.reason, 'reason', 'Say why the layout is restored');
    const source = await this.repo.versionByNumber('homepage', HOMEPAGE_ID, number);
    if (!source) throw notFound('Version');
    const layout = this.layoutOf(source);
    let gone: SectionRow[] = [];
    let published: VersionRow | null = null;
    await this.repo.transaction(async (tx) => {
      const { draft } = await this.homepageVersions(tx);
      if (draft) await tx.updateVersion(draft.id, { state: 'discarded' });
      gone = await this.resetRows(tx, layout, by);
      const summary = `Restored version ${number}: ${reason}`;
      if (body.publish) published = await this.recordLive(tx, layout, by, summary, { restoredFrom: number });
      else await tx.insertVersion(this.newVersionRow('homepage', HOMEPAGE_ID, (await tx.maxVersionNumber('homepage', HOMEPAGE_ID)) + 1, layout, by, { summary, restored_from: number }));
    });
    await this.detachGone(gone, layout);
    if (published) this.publishedEvent(published, by);
    this.invalidateHome();
    await this.logAction('homepage', HOMEPAGE_ID, 'restore', by, reason);
    await this.audit({ action: 'content.homepage.restore-version', actionLabel: `Restored homepage version ${number}${body.publish ? ' and published it' : ' as a draft'}`, target: { type: 'homepage', id: HOMEPAGE_ID, label: `Homepage v${number}` }, reason }, by);
    return this.getHomepageAdmin();
  }

  /* ---------------------------------------------------------------- store homepage */

  /** `campaignActive`: whether a promotion is running, asked once per promotion for the whole layout */
  private async visibleAt(s: SectionSnap, at: Date, campaignActive: (campaignId: string) => Promise<boolean>): Promise<boolean> {
    if (s.kind === 'ad_position') return true;
    if (s.status !== 'published' && s.status !== 'scheduled') return false;
    if (!inWindow(at, s.showFrom, s.removeAt)) return false;
    if (s.config.hiddenByPromotion) return false;
    // a linked promotion, or a deals source limited to one promotion: the section hides when it is not running
    for (const campaignId of unique([s.linkedPromotionId, this.dealsCampaignOf(s)].filter((x): x is string => Boolean(x)))) {
      if (!(await campaignActive(campaignId))) return false;
    }
    return true;
  }

  private async sectionLink(s: SectionSnap, pages: Map<string, { kind: string; slug: string }>): Promise<LinkRef | null> {
    if (s.linkedPageId) {
      const p = pages.get(s.linkedPageId);
      if (p) return { label: 'See all', url: this.pageUrl(p), kind: p.kind === 'collection' ? 'collection' : 'page' };
    }
    if (s.kind === 'deals') return { label: 'See all deals', url: '/deals', kind: 'deals' };
    if (s.kind === 'news') return { label: 'All news', url: '/news', kind: 'page' };
    if (s.config.productSource?.mode === 'collection' && s.config.productSource.collectionId) {
      const p = pages.get(s.config.productSource.collectionId);
      if (p) return { label: 'See all', url: this.pageUrl(p), kind: 'collection' };
    }
    return null;
  }

  /** The homepage `news` section's posts (service/news.ts) */
  protected async homeNews(): Promise<NewsCard[]> {
    return [];
  }

  protected async resolveSection(s: SectionSnap, pages: Map<string, { kind: string; slug: string }>): Promise<ResolvedHomeSection> {
    const base: ResolvedHomeSection = {
      id: s.id,
      position: 0,
      kind: s.kind,
      heading: s.heading,
      subheading: s.subheading,
      link: null,
      banner: null,
      products: [],
      categories: [],
      sellers: [],
      brands: [],
      deals: null,
      promiseItems: s.kind === 'promise_strip' ? (s.config.promiseItems ?? []) : [],
      news: [],
      adPlacementKey: s.kind === 'ad_position' ? s.adPlacementKey : null,
      endsAt: s.removeAt,
      meta: { linkedPromotionId: s.linkedPromotionId, collectionId: null, selectionRule: null, categoryIds: s.config.categoryIds ?? [], sellerIds: s.config.sellerIds ?? [] },
    };
    if (s.kind === 'ad_position') return base;
    base.link = await this.sectionLink(s, pages);
    if (s.config.banner) {
      const refs = await this.refsMap(s.config.banner.images.map((i) => i.id));
      base.banner = { ...s.config.banner, images: s.config.banner.images.map((i) => refs.get(i.id)).filter((x): x is common.MediaRef => Boolean(x)) };
    }
    const max = await this.ctx.settings.get('maxSectionProducts');
    if (PRODUCT_KINDS.has(s.kind) || s.config.productSource) {
      const source = this.sourceOf(s);
      const res = await this.resolveSource(source, { limit: Math.min(source?.limit ?? max, max) || max });
      base.products = res.items.map((i) => i.tile);
      base.meta.selectionRule = res.rule;
      base.meta.collectionId = source?.mode === 'collection' ? (source.collectionId ?? null) : null;
    }
    if (s.kind === 'collection_teaser' && s.linkedPageId) base.meta.collectionId = s.linkedPageId;
    if (s.kind === 'category_shortcuts') base.categories = await this.categoryTiles(s.config.categoryIds ?? []);
    if (s.kind === 'featured_sellers') base.sellers = await this.sellerTiles(s.config.sellerIds ?? []);
    if (s.kind === 'brand_collections') base.brands = await this.brandTiles(s.config.brandIds ?? []);
    if (s.kind === 'news') base.news = await this.homeNews();
    if (s.kind === 'deals') {
      const promotions = this.ctx.tryUse('promotions');
      const campaignId = this.dealsCampaignOf(s);
      base.deals = await this.soft('promotions.liveDeals', promotions && (() => promotions.liveDeals({ limit: 4, ...(campaignId ? { campaignId } : {}) })), null);
    }
    return base;
  }

  protected async buildHomepage(layout: LayoutSnapshot, version: number, at: Date): Promise<ResolvedHomepage> {
    const promotions = this.ctx.tryUse('promotions');
    const asked = new Map<string, Promise<boolean>>();
    const campaignActive = (campaignId: string) => {
      let answer = asked.get(campaignId);
      if (!answer) {
        answer = this.soft('promotions.isCampaignActive', promotions && (() => promotions.isCampaignActive(campaignId)), { active: true }).then((r) => r.active);
        asked.set(campaignId, answer);
      }
      return answer;
    };
    // every section checked at once, kept in layout order
    const shown = await Promise.all(layout.sections.map((s) => this.visibleAt(s, at, campaignActive)));
    const visible = layout.sections.filter((_, i) => shown[i]);
    const pageIds = unique(visible.flatMap((s) => [s.linkedPageId, s.config.productSource?.collectionId].filter((x): x is string => Boolean(x))));
    const pages = new Map((await this.repo.getPages(pageIds)).map((p) => [p.id, p]));
    const sections = await Promise.all(visible.map((s) => this.resolveSection(s, pages)));
    sections.forEach((s, i) => (s.position = i + 1));
    return { version, generatedAt: this.now().toISOString(), sections };
  }

  /** REST and public API shape: the GraphQL extras are left out */
  private plain(h: ResolvedHomepage): Homepage {
    return { version: h.version, generatedAt: h.generatedAt, sections: h.sections.map(({ meta, position, ...rest }) => (void meta, void position, rest)) };
  }

  /** Published homepage sections in order with schedules applied; resolved homepages are cached per device for a few minutes */
  async getHomePage(opts: { customerId?: string; device?: string; at?: string } = {}): Promise<Homepage> {
    return this.plain(await this.resolvedHomePage(opts));
  }

  async previewHomePage(req: PreviewRequest): Promise<Homepage> {
    return this.plain(await this.resolvedPreview(req));
  }

  /** The live homepage with what GraphQL also shows (position, collection, selection rule, linked campaign) */
  async resolvedHomePage(opts: { device?: string; at?: string } = {}): Promise<ResolvedHomepage> {
    const device = opts?.device ?? 'desktop';
    const at = opts?.at ? new Date(opts.at) : null;
    const nowMs = this.now().getTime();
    if (!at) {
      const hit = this.homeCache.entries.get(device);
      if (hit && nowMs >= hit.builtAt && nowMs < hit.validUntil) return hit.value as ResolvedHomepage;
    }
    const { live } = await this.homepageVersions();
    const layout = this.layoutOf(live);
    const page = await this.buildHomepage(layout, live?.number ?? 0, at ?? this.now());
    if (!at) {
      // valid for five minutes, or until the next section appears or goes
      const next = layout.sections.flatMap((s) => [s.showFrom, s.removeAt]).map((t) => (t ? new Date(t).getTime() : NaN)).filter((t) => t > nowMs);
      this.homeCache.entries.set(device, { builtAt: nowMs, validUntil: Math.min(nowMs + 5 * 60_000, ...next), value: page });
    }
    return page;
  }

  async resolvedPreview(req: PreviewRequest): Promise<ResolvedHomepage> {
    const at = req?.at ? new Date(req.at) : this.now();
    const { live, draft } = await this.homepageVersions();
    if (req?.useDraft !== false) {
      const layout = this.draftLayout(await this.repo.listSections());
      // a section published now shows as published in the preview; scheduled ones appear at their time
      const asPublished = { sections: layout.sections.map((s) => (s.status === 'draft' || s.status === 'unpublished' ? { ...s, status: 'published' } : s)) };
      return this.buildHomepage(asPublished, draft?.number ?? (live?.number ?? 0) + 1, at);
    }
    return this.buildHomepage(this.layoutOf(live), live?.number ?? 0, at);
  }

  /* ---------------------------------------------------------------- schedule job and consumers */

  /** Scheduled sections appear at showFrom and go at removeAt without a manual publish; a version records each change */
  protected async runHomepageSchedules(): Promise<number> {
    const now = this.now();
    let changed: string[] = [];
    let version: VersionRow | null = null;
    await this.repo.transaction(async (tx) => {
      const { live } = await this.homepageVersions(tx);
      if (!live) return;
      const layout = this.layoutOf(live);
      const next = layout.sections.map((s) => {
        if (s.kind === 'ad_position') return s;
        if (s.status === 'scheduled' && (!s.showFrom || new Date(s.showFrom) <= now) && (!s.removeAt || new Date(s.removeAt) > now)) {
          changed.push(`${this.sectionTitle(s)} appeared`);
          return { ...s, status: 'published' };
        }
        if ((s.status === 'published' || s.status === 'scheduled') && s.removeAt && new Date(s.removeAt) <= now) {
          changed.push(`${this.sectionTitle(s)} reached its removal time`);
          return { ...s, status: 'unpublished' };
        }
        return s;
      });
      if (!changed.length) return;
      version = await this.recordLive(tx, { sections: next }, SYSTEM, `Schedule: ${changed.join('; ')}`);
      for (const s of next) {
        const before = layout.sections.find((x) => x.id === s.id);
        if (before?.status === s.status) continue;
        const row = await tx.getSection(s.id);
        if (row && row.status === before?.status) await tx.updateSection(s.id, { status: s.status, updated_at: now });
      }
      const { draft } = await this.homepageVersions(tx);
      if (draft) await tx.updateVersion(draft.id, { snapshot: this.draftLayout(await tx.listSections()) as never });
    });
    if (version) {
      this.publishedEvent(version, SYSTEM);
      await this.logAction('homepage', HOMEPAGE_ID, 'schedule_run', SYSTEM, changed.join('; '));
    }
    return changed.length;
  }

  /** Applies a change to matching sections in the draft rows and the live layout (one new live version) */
  protected async changeSections(match: (s: SectionSnap) => boolean, change: (s: SectionSnap) => SectionSnap | null, summary: string, opts: { live?: boolean } = {}): Promise<number> {
    let count = 0;
    let version: VersionRow | null = null;
    await this.repo.transaction(async (tx) => {
      for (const r of await tx.listSections()) {
        const s = this.snapOf(r);
        if (!match(s)) continue;
        const next = change(s);
        if (!next) continue;
        count++;
        await tx.updateSection(r.id, { config: next.config as never, status: next.status, linked_promotion_id: next.linkedPromotionId, updated_at: this.now() });
      }
      const { live, draft } = await this.homepageVersions(tx);
      if (count && !draft && opts.live === false) await this.touchDraft(tx, SYSTEM, summary);
      if (live && opts.live !== false) {
        const layout = this.layoutOf(live);
        let liveChanged = false;
        const sections = layout.sections.map((s) => {
          if (!match(s)) return s;
          const next = change(s);
          if (!next) return s;
          liveChanged = true;
          return next;
        });
        if (liveChanged) {
          count = Math.max(count, 1);
          version = await this.recordLive(tx, { sections }, SYSTEM, summary);
        }
      }
      if (draft && count) await tx.updateVersion(draft.id, { snapshot: this.draftLayout(await tx.listSections()) as never });
    });
    if (version) this.publishedEvent(version, SYSTEM);
    this.invalidateHome();
    return count;
  }
}
