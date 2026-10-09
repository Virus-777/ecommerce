/**
 * Campaign pages, curated collections, the About page and landing pages: drafts and versions,
 * review, schedule, publish, unpublish, correction or removal, and the store reads.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, toPageRequest, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { BannerBlock, Check, CollectionCard, LinkedPromotion, PageAdmin, PageBlock, PageInput, PageSummary, ProductSource, ProductTile, RemovalInfo, StorePage, Version } from '../../../spec/content.js';
import { isValidSlug, isValidTimeZone, sanitizeHtml, slugify } from '../domain/rules.js';
import { contentPublicationMachine } from '../domain/state-machines.js';
import type { PageRow, VersionRow } from '../ports.js';
import { dateOrNull, invalid, iso, notFound, requireText, SYSTEM, type By, type DraftReview } from './base.js';
import { ContentTiles } from './tiles.js';

type PageSnapshot = PageInput & { _review?: DraftReview | null };
type Removal = RemovalInfo & { correctionNote?: string | null };
type Status = PageSummary['status'];

const COLLECTION_NOTES = ['Only in-stock offers are included', 'No seller paid to be included', 'Prices and stock are live'];

/** Files a page uses: the card image and banner images of its blocks */
export const pageMediaIds = (p: PageInput | null | undefined): { id: string; path: string }[] => {
  if (!p) return [];
  const out: { id: string; path: string }[] = [];
  if (p.coverImage?.id) out.push({ id: p.coverImage.id, path: 'coverImage' });
  p.blocks?.forEach((b, i) => b.banner?.images?.forEach((img, j) => img?.id && out.push({ id: img.id, path: `blocks[${i}].banner.images[${j}]` })));
  return out;
};

export class ContentPages extends ContentTiles {
  /* ---------------------------------------------------------------- validation */

  protected checkBanner(b: BannerBlock | null | undefined, path: string): BannerBlock | null {
    if (!b) return null;
    requireText(b.headline, `${path}.headline`, 'A banner needs a headline');
    this.checkLink(b.primaryCta, `${path}.primaryCta`);
    this.checkLink(b.secondaryCta, `${path}.secondaryCta`);
    return { ...b, body: b.body == null ? b.body : sanitizeHtml(b.body), images: b.images ?? [] };
  }

  protected checkSource(s: ProductSource | null | undefined, path: string, maxProducts: number): ProductSource | null {
    if (!s) return null;
    if (s.mode === 'manual' && !s.productIds?.length) throw invalid(`${path}.productIds`, 'Pick at least one product');
    if (s.mode === 'collection' && !s.collectionId) throw invalid(`${path}.collectionId`, 'Pick a collection');
    if (s.mode === 'rule' && !s.rule) throw invalid(`${path}.rule`, 'Pick a selection rule');
    if (s.limit != null && (s.limit < 1 || s.limit > Math.max(maxProducts, 1))) throw invalid(`${path}.limit`, `Show between 1 and ${maxProducts} products`);
    if (s.rule?.kind === 'top_sellers_in_category' && !s.rule.categoryId) throw invalid(`${path}.rule.categoryId`, 'Pick the category to rank');
    return { ...s, productIds: s.productIds ? [...new Set(s.productIds)] : s.productIds };
  }

  private async normalizePage(input: PageInput, opts: { pageId?: string }): Promise<PageSnapshot> {
    const title = requireText(input.title, 'title', 'A page needs a title');
    if (input.kind === 'collection' && !input.collectionKind) throw invalid('collectionKind', 'Pick the kind of collection');
    if (input.kind !== 'collection' && input.collectionKind) throw invalid('collectionKind', 'Only collections have a collection kind');
    if (input.collectionKind === 'brand' && !input.brandId) throw invalid('brandId', 'A brand collection needs its brand');
    let slug = input.slug?.trim().toLowerCase() || (input.kind === 'about' ? 'about' : slugify(title));
    if (!slug) slug = `page-${newId().slice(0, 8)}`;
    if (!isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, numbers and hyphens');
    const other = await this.repo.pageBySlug(slug);
    if (other && other.id !== opts.pageId) throw this.ctx.error('SLUG_TAKEN', `Another page uses /${slug}`);
    if (input.period) {
      if (new Date(input.period.from) >= new Date(input.period.to)) throw invalid('period.to', 'The period must end after it starts');
      if (!isValidTimeZone(input.period.timeZone)) throw invalid('period.timeZone', 'Use an IANA time zone, e.g. America/Los_Angeles');
    }
    const max = await this.ctx.settings.get('maxSectionProducts');
    const ids = new Set<string>();
    const blocks: PageBlock[] = (input.blocks ?? []).map((b, i) => {
      const id = b.id?.trim() || `block-${i + 1}`;
      if (ids.has(id)) throw invalid(`blocks[${i}].id`, 'Block ids must be unique on the page');
      ids.add(id);
      this.checkLink(b.link, `blocks[${i}].link`);
      return {
        ...b,
        id,
        body: b.body == null ? b.body : sanitizeHtml(b.body),
        editorNote: b.editorNote == null ? b.editorNote : sanitizeHtml(b.editorNote),
        banner: this.checkBanner(b.banner, `blocks[${i}].banner`),
        productSource: this.checkSource(b.productSource, `blocks[${i}].productSource`, Math.max(max, 100)),
        products: [],
        items: b.items ?? null,
      };
    });
    return {
      ...input,
      title,
      slug,
      intro: input.intro == null ? input.intro : sanitizeHtml(input.intro),
      blocks,
    };
  }

  /* ---------------------------------------------------------------- reads */

  protected pageUrl(p: { kind: string; slug: string }) {
    if (p.kind === 'about') return '/about';
    if (p.kind === 'collection') return `/collections/${p.slug}`;
    return `/pages/${p.slug}`;
  }

  protected async pageOrThrow(id: string): Promise<PageRow> {
    const p = await this.repo.getPage(id);
    if (!p) throw notFound('Page');
    return p;
  }

  protected snapshotOf(v: VersionRow | undefined | null): PageSnapshot | null {
    return v ? (v.snapshot as unknown as PageSnapshot) : null;
  }

  private stripMeta(s: PageSnapshot | null): PageInput | null {
    if (!s) return null;
    const { _review, ...rest } = s;
    void _review;
    return rest;
  }

  private async pageVersions(p: PageRow) {
    const [live, draft] = await Promise.all([p.live_version_id ? this.repo.getVersion(p.live_version_id) : undefined, p.draft_version_id ? this.repo.getVersion(p.draft_version_id) : undefined]);
    return { live, draft };
  }

  protected async allowedPageActions(p: PageRow, draft: VersionRow | undefined): Promise<string[]> {
    const status = p.status as Status;
    const review = (await this.reviewRequired()).page;
    const draftReview = this.snapshotOf(draft)?._review?.state ?? null;
    let actions: string[] = contentPublicationMachine.eventsFrom(status);
    if (review && status === 'draft') actions = actions.filter((a) => a !== 'publish' && a !== 'schedule');
    if (status === 'published' && draft) {
      if (!review || draftReview === 'approved') actions.push('publish');
      if (review && !draftReview) actions.push('submit');
      if (draftReview === 'in_review') actions.push('approve', 'requestChanges');
    }
    if (status === 'published') actions.push('schedule');
    if (status !== 'removed' && status !== 'in_review') actions.push('edit');
    return [...new Set(actions)];
  }

  protected async pageSummaries(rows: PageRow[]): Promise<PageSummary[]> {
    const owners = await this.owners(rows.map((r) => ({ staffId: r.owner_staff_id })));
    const versions = new Map((await this.repo.getVersions(rows.flatMap((r) => [r.live_version_id, r.draft_version_id].filter((x): x is string => Boolean(x))))).map((v) => [v.id, v]));
    return Promise.all(
      rows.map(async (r, i) => {
        const draft = r.draft_version_id ? versions.get(r.draft_version_id) : undefined;
        const live = r.live_version_id ? versions.get(r.live_version_id) : undefined;
        return {
          id: r.id,
          kind: r.kind,
          collectionKind: r.collection_kind,
          title: r.title,
          slug: r.slug,
          url: this.pageUrl(r),
          owner: owners[i]!,
          schedule: this.schedule(r.publish_at, r.unpublish_at, r.time_zone, Boolean(r.linked_promotion_id) && !r.publish_at && !r.unpublish_at),
          status: r.status as Status,
          liveVersion: live?.number ?? null,
          draftVersion: draft?.number ?? null,
          updatedAt: r.updated_at.toISOString(),
          allowedActions: await this.allowedPageActions(r, draft),
        };
      }),
    );
  }

  protected async linkedPromotion(id: string | null | undefined): Promise<(LinkedPromotion & { ended: boolean }) | null> {
    const promotions = id ? this.ctx.tryUse('promotions') : undefined;
    if (!id || !promotions) return null;
    const c = await this.soft('promotions.getPublicCampaign', () => promotions.getPublicCampaign(id), null);
    if (!c) return null;
    const ended = ['ended', 'finished', 'cancelled', 'expired'].includes(c.status) || new Date(c.period.endsAt) <= this.now();
    return { id: c.id, name: c.name, status: c.status, startsAt: c.period.startsAt, endsAt: c.period.endsAt, ended };
  }

  private async pageChecks(p: PageRow, snap: PageSnapshot | null, promo: (LinkedPromotion & { ended: boolean }) | null): Promise<Check[]> {
    const checks: Check[] = [];
    if (!snap) return checks;
    const sources = snap.blocks.filter((b) => b.productSource);
    if (sources.length) {
      let hidden = 0;
      let shown = 0;
      for (const b of sources) {
        const r = await this.resolveSource(b.productSource, { includeHidden: true });
        hidden += r.items.filter((x) => !x.available).length;
        shown += r.items.filter((x) => x.available).length;
      }
      checks.push(hidden ? { state: 'warn', label: `${hidden} unavailable ${hidden === 1 ? 'product' : 'products'} hidden`, detail: 'Hidden automatically until they are available again' } : { state: 'ok', label: `${shown} products available` });
    }
    const missing = snap.blocks.filter((b) => (b.type === 'hero' || b.type === 'banner' || b.type === 'image') && !(b.banner?.images?.length ?? 0));
    checks.push(missing.length ? { state: 'warn', label: 'Missing images', detail: missing.map((b) => b.title || b.banner?.headline || b.id).join(', ') } : { state: 'ok', label: 'Images in place' });
    if (snap.kind === 'collection' && !snap.coverImage) checks.push({ state: 'info', label: 'No card image', detail: 'The collection card uses the first product image' });
    if (promo) {
      if (promo.ended) {
        const later = !p.unpublish_at || p.unpublish_at > this.now();
        checks.push(later && p.status === 'published' ? { state: 'warn', label: 'Linked promotion has ended', detail: 'The page stays up until its removal time; take it down or set a removal time' } : { state: 'info', label: 'Linked promotion has ended' });
      } else if (p.publish_at) {
        const same = Math.abs(new Date(promo.startsAt).getTime() - p.publish_at.getTime()) <= 60_000;
        checks.push(same ? { state: 'ok', label: 'Campaign starts at the same time as the page' } : { state: 'warn', label: 'Campaign and page start at different times', detail: `Campaign starts ${promo.startsAt}; page publishes ${p.publish_at.toISOString()}` });
      }
    }
    if ((await this.reviewRequired()).page && p.status === 'draft') checks.push({ state: 'info', label: 'Review required before publishing' });
    return checks;
  }

  protected async pageAdmin(p: PageRow): Promise<PageAdmin> {
    const { live, draft } = await this.pageVersions(p);
    const [summary] = await this.pageSummaries([p]);
    const draftSnap = this.snapshotOf(draft);
    const liveSnap = this.snapshotOf(live);
    const promo = await this.linkedPromotion(draftSnap?.linkedPromotionId ?? liveSnap?.linkedPromotionId ?? p.linked_promotion_id);
    const removal = p.removal as unknown as Removal | null;
    return {
      summary: summary!,
      draft: this.stripMeta(draftSnap),
      live: this.stripMeta(liveSnap),
      linkedPromotion: promo ? { id: promo.id, name: promo.name, status: promo.status, startsAt: promo.startsAt, endsAt: promo.endsAt } : null,
      checks: await this.pageChecks(p, draftSnap ?? liveSnap, promo),
      removal: removal ? { kind: removal.kind, reason: removal.reason, actor: removal.actor, at: removal.at } : null,
    };
  }

  /** Blocks with their products resolved; media refreshed from media (files no longer usable are left out) */
  protected async resolveBlocks(blocks: PageBlock[]): Promise<PageBlock[]> {
    const refs = await this.refsMap(blocks.flatMap((b) => (b.banner?.images ?? []).map((i) => i.id)));
    const max = await this.ctx.settings.get('maxSectionProducts');
    return Promise.all(
      blocks.map(async (b) => {
        let products: ProductTile[] = [];
        if (b.productSource) products = (await this.resolveSource(b.productSource, { limit: b.productSource.limit ?? Math.max(max, 1) })).items.map((i) => i.tile);
        return {
          ...b,
          body: b.body == null ? b.body : sanitizeHtml(b.body),
          editorNote: b.editorNote == null ? b.editorNote : sanitizeHtml(b.editorNote),
          banner: b.banner ? { ...b.banner, images: (b.banner.images ?? []).map((i) => refs.get(i.id)).filter((x): x is common.MediaRef => Boolean(x)) } : b.banner,
          products,
          items: b.items ?? [],
        };
      }),
    );
  }

  protected async storePageFrom(p: PageRow, snap: PageSnapshot, version: VersionRow | undefined): Promise<StorePage> {
    const blocks = await this.resolveBlocks(snap.blocks ?? []);
    const url = this.pageUrl({ kind: snap.kind, slug: snap.slug ?? p.slug });
    const updatedAt = (version?.published_at ?? version?.created_at ?? p.updated_at).toISOString();
    const productCount = blocks.reduce((n, b) => n + b.products.length, 0);
    const now = this.now();
    const endsIn = snap.period ? Math.floor((new Date(snap.period.to).getTime() - now.getTime()) / 1000) : null;
    return {
      id: p.id,
      kind: snap.kind,
      collectionKind: snap.collectionKind ?? null,
      title: snap.title,
      slug: snap.slug ?? p.slug,
      eyebrow: snap.eyebrow ?? null,
      intro: snap.intro == null ? null : sanitizeHtml(snap.intro),
      curator: snap.kind === 'collection' && snap.curatorName ? { name: snap.curatorName, avatar: null, updatedAt, sectionCount: blocks.filter((b) => b.productSource).length, productCount } : null,
      breadcrumb: [{ label: 'Home', url: '/', kind: 'page' }, ...(snap.kind === 'collection' ? [{ label: 'Collections', url: '/collections', kind: 'collection' as const }] : []), { label: snap.title, url, kind: snap.kind === 'collection' ? 'collection' : 'page' }],
      period: snap.period ?? null,
      endsInSeconds: endsIn != null && endsIn > 0 ? endsIn : null,
      blocks,
      notes: snap.kind === 'collection' ? COLLECTION_NOTES : snap.linkedPromotionId ? ['Prices and stock are live'] : [],
      updatedAt,
      version: version?.number ?? 0,
    };
  }

  protected pageIsLive(p: PageRow, at = this.now()) {
    return p.status === 'published' && Boolean(p.live_version_id) && (!p.unpublish_at || p.unpublish_at > at);
  }

  /** A published page by slug inside its window; a correction shows its note in place of the page */
  async getStorePage(slug: string): Promise<StorePage | null> {
    const p = await this.repo.pageBySlug(slug);
    if (!p) return null;
    if (p.status === 'removed') {
      const removal = p.removal as unknown as Removal | null;
      if (removal?.kind !== 'correction' || !removal.correctionNote) return null;
      return {
        id: p.id,
        kind: p.kind,
        collectionKind: p.collection_kind,
        title: p.title,
        slug: p.slug,
        eyebrow: null,
        intro: null,
        curator: null,
        breadcrumb: [{ label: 'Home', url: '/', kind: 'page' }],
        period: null,
        endsInSeconds: null,
        blocks: [{ type: 'text', id: 'correction', title: 'Correction', body: sanitizeHtml(removal.correctionNote), products: [], items: [] }],
        notes: [],
        updatedAt: removal.at,
        version: 0,
      };
    }
    if (!this.pageIsLive(p)) return null;
    const live = p.live_version_id ? await this.repo.getVersion(p.live_version_id) : undefined;
    const snap = this.snapshotOf(live);
    return snap ? this.storePageFrom(p, snap, live) : null;
  }

  /** The draft (or the live version when there is no draft) as customers will see it */
  async previewPage(pageId: string): Promise<StorePage> {
    const p = await this.pageOrThrow(pageId);
    const { live, draft } = await this.pageVersions(p);
    const v = draft ?? live;
    const snap = this.snapshotOf(v);
    if (!snap) throw notFound('Page version');
    return this.storePageFrom(p, snap, v);
  }

  async collectionProducts(pageId: string, opts: { categoryId?: string; paging: unknown; blockId?: string }): Promise<common.Page<ProductTile>> {
    const items = await this.collectionItems(pageId, { categoryId: opts?.categoryId ?? null, blockId: opts?.blockId ?? null });
    const req = this.pagingOf(opts?.paging);
    return pageOf(
      items.map((i) => i.tile),
      req,
    );
  }

  /** The spec types `paging` as PageInput; accept the common paging input or a PageRequest */
  protected pagingOf(p: unknown): PageRequest {
    if (p && typeof p === 'object' && 'mode' in p) return p as PageRequest;
    const x = (p ?? {}) as common.PageInput;
    return toPageRequest({ ...(x.cursor ? { cursor: x.cursor } : {}), ...(x.page ? { page: x.page } : {}), ...(x.limit ? { limit: x.limit } : {}) });
  }

  async listPageProducts(slug: string, q: { categoryId?: string; blockId?: string }, page: PageRequest): Promise<common.Page<ProductTile>> {
    const p = await this.repo.pageBySlug(slug);
    if (!p || !this.pageIsLive(p)) throw notFound('Page');
    return this.collectionProducts(p.id, { categoryId: q.categoryId, blockId: q.blockId, paging: page });
  }

  async listCollections(q: { brandId?: string; collectionKind?: string }, page: PageRequest): Promise<common.Page<CollectionCard>> {
    const rows = (await this.repo.listPages({ kind: 'collection', statuses: ['published'], brandId: q.brandId, collectionKind: q.collectionKind })).filter((p) => this.pageIsLive(p));
    const slice = pageOf(rows, page);
    const versions = new Map((await this.repo.getVersions(slice.items.map((p) => p.live_version_id!))).map((v) => [v.id, v]));
    const covers = await this.refsMap(slice.items.map((p) => this.snapshotOf(versions.get(p.live_version_id!))?.coverImage?.id));
    const items = await Promise.all(
      slice.items.map(async (p): Promise<CollectionCard> => {
        const snap = this.snapshotOf(versions.get(p.live_version_id!));
        const products = await this.collectionItems(p.id);
        const cover = snap?.coverImage?.id ? covers.get(snap.coverImage.id) : undefined;
        return { id: p.id, slug: p.slug, url: this.pageUrl(p), title: p.title, collectionKind: p.collection_kind, productCount: products.length, image: cover ?? products.find((x) => x.tile.image)?.tile.image ?? null };
      }),
    );
    return { ...slice, items };
  }

  async pageLink(pageId: string): Promise<{ url: string; status: string; publishAt?: string; unpublishAt?: string } | null> {
    const p = await this.repo.getPage(pageId);
    if (!p) return null;
    return { url: this.pageUrl(p), status: p.status, ...(p.publish_at ? { publishAt: p.publish_at.toISOString() } : {}), ...(p.unpublish_at ? { unpublishAt: p.unpublish_at.toISOString() } : {}) };
  }

  /* ---------------------------------------------------------------- admin reads */

  async listPagesAdmin(q: { kind?: string; status?: string; q?: string }, page: PageRequest): Promise<common.Page<PageSummary>> {
    const res = await this.repo.pageOfPages({ kind: q.kind, statuses: q.status ? q.status.split(',').map((s) => s.trim()).filter(Boolean) : undefined, q: q.q }, page);
    return { ...res, items: await this.pageSummaries(res.items) };
  }

  async getPageAdmin(id: string): Promise<PageAdmin> {
    return this.pageAdmin(await this.pageOrThrow(id));
  }

  async listPageVersions(id: string, page: PageRequest): Promise<common.Page<Version>> {
    await this.pageOrThrow(id);
    const res = await this.repo.pageOfVersions('page', id, page);
    return { ...res, items: res.items.map((v) => this.versionOut(v)) };
  }

  /* ---------------------------------------------------------------- writes */

  async createPage(input: PageInput, by: By): Promise<PageAdmin> {
    const id = newId();
    const snap = await this.normalizePage(input, {});
    const tz = await this.marketTimeZone();
    const files = pageMediaIds(snap);
    const media = await this.syncMedia('content_block', id, snap.title, [], files);
    const now = this.now();
    let row: PageRow;
    try {
      row = await this.repo.transaction(async (tx) => {
        const version = await tx.insertVersion(this.newVersionRow('page', id, 1, snap, by, { summary: input.changeNote?.trim() || 'Created the page' }));
        return tx.insertPage({
          id,
          kind: snap.kind,
          collection_kind: snap.collectionKind ?? null,
          slug: snap.slug!,
          title: snap.title,
          brand_id: snap.brandId ?? null,
          owner_staff_id: snap.ownerStaffId ?? this.staffIdOf(by),
          linked_promotion_id: snap.linkedPromotionId ?? null,
          status: 'draft',
          publish_at: null,
          unpublish_at: null,
          time_zone: tz,
          live_version_id: null,
          draft_version_id: version.id,
          removal: null,
          created_at: now,
          updated_at: now,
        });
      });
    } catch (err) {
      await media.undo();
      throw this.slugConflict(err, snap.slug!);
    }
    await this.audit({ action: 'content.page.create', actionLabel: 'Created page', target: { type: 'page', id, label: row.title }, after: snap }, by);
    return this.pageAdmin(row);
  }

  protected slugConflict(err: unknown, slug: string) {
    const msg = err instanceof Error ? err.message : '';
    if (/unique|duplicate/i.test(msg) && /slug/i.test(msg)) return this.ctx.error('SLUG_TAKEN', `Another page uses /${slug}`);
    return err;
  }

  async updatePage(id: string, input: PageInput, by: By): Promise<PageAdmin> {
    const p = await this.pageOrThrow(id);
    const review = (await this.reviewRequired()).page;
    if (p.status === 'in_review') throw new AppError('CONFLICT', 'The page is in review; request changes before editing');
    if (p.status === 'removed') throw new AppError('CONFLICT', 'The page was removed; restore a version to edit it');
    if (review && (p.status === 'approved' || p.status === 'scheduled')) throw new AppError('CONFLICT', 'The approved version is waiting to go live; edit it after it is published');
    const { live, draft } = await this.pageVersions(p);
    if (this.snapshotOf(draft)?._review?.state === 'in_review') throw new AppError('CONFLICT', 'The draft is in review; request changes before editing');
    const snap = await this.normalizePage(input, { pageId: id });
    const before = [...pageMediaIds(this.snapshotOf(draft)), ...pageMediaIds(this.snapshotOf(live))].map((f) => f.id);
    const media = await this.syncMedia('content_block', id, snap.title, before, [...pageMediaIds(snap), ...pageMediaIds(this.snapshotOf(live))]);
    const summary = input.changeNote?.trim() || 'Edited the draft';
    let row: PageRow;
    try {
      row = await this.repo.transaction(async (tx) => {
        const locked = (await tx.getPage(id, { forUpdate: true }))!;
        let draftId = locked.draft_version_id;
        if (draftId) await tx.updateVersion(draftId, { snapshot: snap as never, summary, author_kind: by.actor.kind, author_id: by.actor.id ?? null, created_at: this.now() });
        else draftId = (await tx.insertVersion(this.newVersionRow('page', id, (await tx.maxVersionNumber('page', id)) + 1, snap, by, { summary }))).id;
        const notLive = !locked.live_version_id;
        return tx.updatePage(id, {
          draft_version_id: draftId,
          owner_staff_id: snap.ownerStaffId ?? locked.owner_staff_id,
          ...(notLive ? { kind: snap.kind, collection_kind: snap.collectionKind ?? null, slug: snap.slug!, title: snap.title, brand_id: snap.brandId ?? null, linked_promotion_id: snap.linkedPromotionId ?? null } : {}),
          updated_at: this.now(),
        });
      });
    } catch (err) {
      await media.undo();
      throw this.slugConflict(err, snap.slug!);
    }
    await media.commit();
    await this.audit({ action: 'content.page.update', actionLabel: 'Edited page draft', target: { type: 'page', id, label: row.title }, before: this.stripMeta(this.snapshotOf(draft) ?? this.snapshotOf(live)), after: snap, reason: input.changeNote ?? null }, by);
    return this.pageAdmin(row);
  }

  /** Sets the review marker on the draft of a page that is already live */
  private async setDraftReview(p: PageRow, review: DraftReview | null) {
    const draft = p.draft_version_id ? await this.repo.getVersion(p.draft_version_id) : undefined;
    if (!draft) return;
    const snap = { ...(draft.snapshot as unknown as PageSnapshot), _review: review };
    await this.repo.updateVersion(draft.id, { snapshot: snap as never });
  }

  async submitPage(id: string, by: By): Promise<PageAdmin> {
    const p = await this.pageOrThrow(id);
    const draft = p.draft_version_id ? await this.repo.getVersion(p.draft_version_id) : undefined;
    if ((p.status === 'published' || p.status === 'unpublished') && draft) {
      if (this.snapshotOf(draft)?._review) throw new AppError('ILLEGAL_TRANSITION', 'The draft is already in review', { from: p.status, event: 'submit' });
      await this.setDraftReview(p, { state: 'in_review', by: by.actor, at: this.now().toISOString() });
    } else {
      const status = contentPublicationMachine.next(p.status as Status, 'submit');
      await this.repo.updatePage(id, { status, updated_at: this.now() });
    }
    await this.logAction('page', id, 'submit', by);
    await this.audit({ action: 'content.page.submit', actionLabel: 'Sent page for review', target: { type: 'page', id, label: p.title } }, by);
    return this.pageAdmin((await this.repo.getPage(id))!);
  }

  async approvePage(id: string, body: { approve: boolean; reason?: string | null }, by: By): Promise<PageAdmin> {
    const p = await this.pageOrThrow(id);
    const draft = p.draft_version_id ? await this.repo.getVersion(p.draft_version_id) : undefined;
    const event = body.approve ? 'approve' : 'requestChanges';
    if (!body.approve) requireText(body.reason, 'reason', 'Say what needs to change');
    if (p.status !== 'in_review' && this.snapshotOf(draft)?._review?.state === 'in_review') {
      await this.setDraftReview(p, body.approve ? { state: 'approved', by: by.actor, at: this.now().toISOString() } : null);
    } else {
      const status = contentPublicationMachine.next(p.status as Status, event);
      await this.repo.updatePage(id, { status, updated_at: this.now() });
    }
    await this.logAction('page', id, event, by, body.reason);
    await this.audit({ action: `content.page.${body.approve ? 'approve' : 'request-changes'}`, actionLabel: body.approve ? 'Approved page' : 'Requested page changes', target: { type: 'page', id, label: p.title }, reason: body.reason ?? null }, by);
    return this.pageAdmin((await this.repo.getPage(id))!);
  }

  async schedulePage(id: string, body: { publishAt: string; unpublishAt?: string | null; timeZone: string }, by: By): Promise<PageAdmin> {
    const p = await this.pageOrThrow(id);
    const tz = await this.timeZoneOr(body.timeZone);
    const publishAt = new Date(body.publishAt);
    const unpublishAt = dateOrNull(body.unpublishAt);
    if (unpublishAt && unpublishAt <= publishAt) throw invalid('unpublishAt', 'The removal time must be after the publish time');
    if (unpublishAt && unpublishAt <= this.now()) throw invalid('unpublishAt', 'The removal time has already passed');
    let patch: Partial<PageRow>;
    if (p.status === 'published') {
      // a live page keeps its publication; only the removal time changes
      if (publishAt > this.now()) throw new AppError('ILLEGAL_TRANSITION', 'The page is already live; unpublish it to schedule a new start', { from: p.status, event: 'schedule' });
      patch = { unpublish_at: unpublishAt, time_zone: tz };
    } else {
      if ((await this.reviewRequired()).page && p.status === 'draft') throw new AppError('ILLEGAL_TRANSITION', 'Send the page for review before scheduling it', { from: p.status, event: 'schedule', allowed: ['submit'] });
      const status = contentPublicationMachine.next(p.status as Status, 'schedule');
      patch = { status, publish_at: publishAt, unpublish_at: unpublishAt, time_zone: tz };
    }
    const row = await this.repo.updatePage(id, { ...patch, updated_at: this.now() });
    this.invalidateHome();
    await this.logAction('page', id, 'schedule', by, `${publishAt.toISOString()}${unpublishAt ? ` – ${unpublishAt.toISOString()}` : ''}`);
    await this.audit({ action: 'content.page.schedule', actionLabel: 'Scheduled page', target: { type: 'page', id, label: p.title }, before: { publishAt: iso(p.publish_at), unpublishAt: iso(p.unpublish_at), status: p.status }, after: { publishAt: iso(row.publish_at), unpublishAt: iso(row.unpublish_at), status: row.status } }, by);
    return this.pageAdmin(row);
  }

  async publishPage(id: string, by: By): Promise<PageAdmin> {
    const p = await this.pageOrThrow(id);
    const review = (await this.reviewRequired()).page;
    const draft = p.draft_version_id ? await this.repo.getVersion(p.draft_version_id) : undefined;
    if (p.status === 'published') {
      if (!draft) throw new AppError('ILLEGAL_TRANSITION', 'The page is already live and has no new draft', { from: p.status, event: 'publish' });
      if (review && this.snapshotOf(draft)?._review?.state !== 'approved') throw new AppError('ILLEGAL_TRANSITION', 'The draft needs review before it goes live', { from: p.status, event: 'publish', allowed: ['submit'] });
    } else {
      contentPublicationMachine.next(p.status as Status, 'publish');
      if (review && p.status === 'draft') throw new AppError('ILLEGAL_TRANSITION', 'Send the page for review before publishing it', { from: p.status, event: 'publish', allowed: ['submit'] });
    }
    return this.pageAdmin(await this.goLive(id, by, 'publish'));
  }

  /** Publishes the draft (or the live version again) now; used by publish and by the schedule job */
  protected async goLive(id: string, by: By, why: 'publish' | 'scheduled'): Promise<PageRow> {
    const now = this.now();
    const before = await this.pageOrThrow(id);
    const draft = before.draft_version_id ? await this.repo.getVersion(before.draft_version_id) : undefined;
    const snap = this.snapshotOf(draft);
    if (snap) {
      const other = await this.repo.pageBySlug(snap.slug ?? before.slug);
      if (other && other.id !== id) throw this.ctx.error('SLUG_TAKEN', `Another page uses /${snap.slug}`);
    }
    const oldLive = before.live_version_id ? this.snapshotOf(await this.repo.getVersion(before.live_version_id)) : null;
    const after = await this.repo.transaction(async (tx) => {
      const locked = (await tx.getPage(id, { forUpdate: true }))!;
      let liveId = locked.live_version_id;
      let fields: Partial<PageRow> = {};
      if (locked.draft_version_id && snap) {
        const { _review, ...clean } = snap;
        void _review;
        if (locked.live_version_id) await tx.updateVersion(locked.live_version_id, { state: 'superseded' });
        await tx.updateVersion(locked.draft_version_id, { state: 'live', published_at: now, snapshot: clean as never });
        liveId = locked.draft_version_id;
        fields = { kind: snap.kind, collection_kind: snap.collectionKind ?? null, slug: snap.slug ?? locked.slug, title: snap.title, brand_id: snap.brandId ?? null, linked_promotion_id: snap.linkedPromotionId ?? null };
      }
      if (!liveId) throw invalid('draft', 'The page has nothing to publish');
      return tx.updatePage(id, {
        ...fields,
        status: 'published',
        live_version_id: liveId,
        draft_version_id: null,
        removal: null,
        publish_at: why === 'publish' ? null : locked.publish_at,
        unpublish_at: locked.unpublish_at && locked.unpublish_at <= now ? null : locked.unpublish_at,
        updated_at: now,
      });
    });
    if (snap && oldLive) {
      // files only the old live version used
      const keep = new Set(pageMediaIds(snap).map((f) => f.id));
      for (const f of pageMediaIds(oldLive)) if (!keep.has(f.id)) await this.media.detach(f.id, { module: 'content', kind: 'content_block', refId: id }).catch(() => {});
    }
    this.invalidateHome();
    const version = (await this.repo.getVersion(after.live_version_id!))!;
    this.ctx.events.publish('content.page.published', { entity: 'page', entityId: id, slug: after.slug, version: version.number, url: this.pageUrl(after) }, { actor: by.actor, requestId: by.requestId });
    await this.logAction('page', id, why === 'publish' ? 'publish' : 'publish_scheduled', by);
    await this.audit({ action: 'content.page.publish', actionLabel: why === 'publish' ? 'Published page' : 'Published scheduled page', target: { type: 'page', id, label: after.title }, before: { status: before.status, liveVersion: oldLive ? 'previous' : null }, after: { status: after.status, version: version.number } }, by);
    return after;
  }

  async unpublishPage(id: string, body: { reason?: string | null }, by: By): Promise<PageAdmin> {
    return this.pageAdmin(await this.takeDown(id, body.reason ?? null, by));
  }

  protected async takeDown(id: string, reason: string | null, by: By): Promise<PageRow> {
    const p = await this.pageOrThrow(id);
    const status = contentPublicationMachine.next(p.status as Status, 'unpublish');
    const now = this.now();
    const row = await this.repo.updatePage(id, { status, unpublish_at: p.unpublish_at && p.unpublish_at <= now ? null : p.unpublish_at, updated_at: now });
    this.invalidateHome();
    this.ctx.events.publish('content.page.unpublished', { pageId: id, slug: row.slug, reason }, { actor: by.actor, requestId: by.requestId });
    await this.logAction('page', id, 'unpublish', by, reason);
    await this.audit({ action: 'content.page.unpublish', actionLabel: 'Unpublished page', target: { type: 'page', id, label: row.title }, reason, before: { status: p.status }, after: { status } }, by);
    return row;
  }

  async removePage(id: string, body: { kind: 'correction' | 'removal'; reason: string; correctionNote?: string | null }, by: By): Promise<PageAdmin> {
    const reason = requireText(body.reason, 'reason', 'A reason is required');
    const p = await this.pageOrThrow(id);
    const status = contentPublicationMachine.next(p.status as Status, 'remove');
    const removal: Removal = { kind: body.kind, reason, actor: by.actor, at: this.now().toISOString(), correctionNote: body.correctionNote?.trim() ? sanitizeHtml(body.correctionNote) : null };
    const row = await this.repo.updatePage(id, { status, removal: removal as never, updated_at: this.now() });
    this.invalidateHome();
    this.ctx.events.publish('content.page.removed', { entity: 'page', entityId: id, kind: body.kind, reason }, { actor: by.actor, requestId: by.requestId });
    await this.logAction('page', id, body.kind, by, reason);
    await this.audit({ action: `content.page.${body.kind}`, actionLabel: body.kind === 'correction' ? 'Correction: took page down' : 'Removed page', target: { type: 'page', id, label: p.title }, reason, before: { status: p.status }, after: { status, removal } }, by);
    return this.pageAdmin(row);
  }

  async restorePageVersion(id: string, number: number, body: { reason: string }, by: By): Promise<PageAdmin> {
    const reason = requireText(body.reason, 'reason', 'Say why the version is restored');
    const p = await this.pageOrThrow(id);
    const source = await this.repo.versionByNumber('page', id, number);
    if (!source) throw notFound('Version');
    const { _review, ...snap } = source.snapshot as unknown as PageSnapshot;
    void _review;
    const other = await this.repo.pageBySlug(snap.slug ?? p.slug);
    if (other && other.id !== id) throw this.ctx.error('SLUG_TAKEN', `Another page uses /${snap.slug}`);
    const { live, draft } = await this.pageVersions(p);
    const before = [...pageMediaIds(this.snapshotOf(draft)), ...pageMediaIds(this.snapshotOf(live))].map((f) => f.id);
    const media = await this.syncMedia('content_block', id, snap.title, before, [...pageMediaIds(snap), ...pageMediaIds(this.snapshotOf(live))]);
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.getPage(id, { forUpdate: true }))!;
      if (locked.draft_version_id) await tx.updateVersion(locked.draft_version_id, { state: 'discarded' });
      const v = await tx.insertVersion(this.newVersionRow('page', id, (await tx.maxVersionNumber('page', id)) + 1, snap, by, { summary: `Restored version ${number}: ${reason}`, restored_from: number }));
      const restoring = locked.status === 'removed';
      return tx.updatePage(id, {
        draft_version_id: v.id,
        ...(restoring ? { status: contentPublicationMachine.next('removed', 'restore'), removal: null } : {}),
        ...(!locked.live_version_id ? { title: snap.title, slug: snap.slug ?? locked.slug, kind: snap.kind, collection_kind: snap.collectionKind ?? null, brand_id: snap.brandId ?? null, linked_promotion_id: snap.linkedPromotionId ?? null } : {}),
        updated_at: this.now(),
      });
    });
    await media.commit();
    await this.logAction('page', id, 'restore', by, reason);
    await this.audit({ action: 'content.page.restore-version', actionLabel: `Restored page version ${number} as a new draft`, target: { type: 'page', id, label: row.title }, reason }, by);
    return this.pageAdmin(row);
  }

  /* ---------------------------------------------------------------- schedule job */

  protected async runPageSchedules(): Promise<number> {
    const now = this.now();
    let n = 0;
    for (const p of await this.repo.pagesToPublish(now, 50)) {
      try {
        await this.goLive(p.id, SYSTEM, 'scheduled');
        n++;
      } catch (err) {
        this.ctx.log.warn({ err, pageId: p.id }, 'content: scheduled page could not be published');
      }
    }
    for (const p of await this.repo.pagesToUnpublish(now, 50)) {
      try {
        await this.takeDown(p.id, 'Reached its removal time', SYSTEM);
        n++;
      } catch (err) {
        this.ctx.log.warn({ err, pageId: p.id }, 'content: page could not be taken down at its removal time');
      }
    }
    return n;
  }
}
