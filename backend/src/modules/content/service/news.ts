/**
 * News for customers (docs/06-news.md): staff-editable categories and posts with drafts, review (a second person
 * approves, content.reviewRequired.news), schedule, pin, archive time and versions; the store list, post and summary.
 * The homepage `news` section reads homeNews(). News is a short list, so lists are filtered, sorted and paged in
 * memory (pageOf), like campaign pages.
 */
import { stringList } from '../../../kernel/lib/text.js';
import { slugify } from '../../../kernel/lib/text.js';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { LinkRef, NewsAdmin, NewsAdminSummary, NewsCard, NewsCategory, NewsCategoryRef, NewsInput, NewsPost, NewsStatusCounts, NewsSummary, Version } from '../../../spec/content.js';
import { isValidSlug, plainText, sanitizeHtml } from '../domain/rules.js';
import { contentPublicationMachine } from '../domain/state-machines.js';
import type { NewsCategoryRow, NewsRow, VersionRow } from '../ports.js';
import { actorFromKey, invalid, iso, notFound, requireText, SYSTEM, unique, type By, type DraftReview } from './base.js';
import { ContentPolicies } from './policies.js';

/** A news post version's content */
export interface NewsSnap {
  title: string;
  slug: string;
  categoryId: string;
  summary: string;
  body: string;
  cover: common.MediaRef | null;
  cta: LinkRef | null;
  archiveAt: string | null;
  ownerStaffId: string | null;
  _review?: DraftReview | null;
}

type Status = NewsAdmin['status'];
type Action = 'submit' | 'approve' | 'requestChanges' | 'schedule' | 'cancelSchedule' | 'publish' | 'unpublish' | 'remove' | 'restore' | 'discardDraft';

const TITLE_MAX = 90;
const SUMMARY_MAX = 200;
const CATEGORY_NAME_MAX = 30;
/** Published posts pinned at once; pinning another unpins the one pinned longest ago */
const MAX_PINNED = 3;
/** Store paths under /news that are not posts */
const RESERVED_SLUGS = new Set(['categories', 'summary', 'counts']);
const HOME_NEWS = 3;

const newsMediaIds = (s: NewsSnap | null | undefined) => (s?.cover?.id ? [{ id: s.cover.id, path: 'cover' }] : []);

export class ContentNews extends ContentPolicies {
  /* ---------------------------------------------------------------- categories */

  private async newsCounts(listedOnly: boolean): Promise<Map<string, number>> {
    const now = this.now();
    const out = new Map<string, number>();
    for (const r of await this.repo.listNews({ statuses: ['published'] })) {
      if (listedOnly && this.isArchived(r, now)) continue;
      out.set(r.category_id, (out.get(r.category_id) ?? 0) + 1);
    }
    return out;
  }

  private categoryOutNews(c: NewsCategoryRow, counts: Map<string, number>): NewsCategory {
    return { id: c.id, slug: c.slug, name: c.name, icon: c.icon, position: c.position, visible: c.visible, postCount: counts.get(c.id) ?? 0 };
  }

  private categoryRef(c: NewsCategoryRow | undefined, id: string): NewsCategoryRef {
    return c ? { id: c.id, slug: c.slug, name: c.name, icon: c.icon } : { id, slug: 'news', name: 'News', icon: null };
  }

  async listNewsCategoriesAdmin(): Promise<NewsCategory[]> {
    const [rows, counts] = await Promise.all([this.repo.listNewsCategories(), this.newsCounts(false)]);
    return rows.map((c) => this.categoryOutNews(c, counts));
  }

  /** Store: visible categories that have listed posts, in staff order */
  async listNewsCategories(): Promise<NewsCategory[]> {
    const [rows, counts] = await Promise.all([this.repo.listNewsCategories(), this.newsCounts(true)]);
    return rows.filter((c) => c.visible && (counts.get(c.id) ?? 0) > 0).map((c) => this.categoryOutNews(c, counts));
  }

  private async freeCategorySlug(name: string, wanted: string | null | undefined, selfId?: string): Promise<string> {
    let slug = wanted?.trim().toLowerCase();
    if (slug) {
      if (!isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, numbers and hyphens');
      const other = await this.repo.newsCategoryBySlug(slug);
      if (other && other.id !== selfId) throw this.ctx.error('SLUG_TAKEN', `Another category uses ${slug}`);
      return slug;
    }
    const base = slugify(name) || 'news';
    slug = base;
    for (let i = 2; ; i++) {
      const other = await this.repo.newsCategoryBySlug(slug);
      if (!other || other.id === selfId) return slug;
      slug = `${base}-${i}`;
    }
  }

  private async checkCategoryName(name: string, selfId?: string): Promise<string> {
    const n = requireText(name, 'name', 'A category needs a name');
    if (n.length > CATEGORY_NAME_MAX) throw invalid('name', `Use up to ${CATEGORY_NAME_MAX} characters`);
    if ((await this.repo.listNewsCategories()).some((c) => c.id !== selfId && c.name.toLowerCase() === n.toLowerCase())) throw invalid('name', `There is already a category named ${n}`);
    return n;
  }

  async createNewsCategory(body: { name: string; slug?: string | null; icon?: string | null; visible?: boolean | null }, by: By): Promise<NewsCategory> {
    const name = await this.checkCategoryName(body.name);
    const slug = await this.freeCategorySlug(name, body.slug);
    const all = await this.repo.listNewsCategories();
    const row = await this.repo.insertNewsCategory({ id: newId(), slug, name, icon: body.icon?.trim() || null, position: all.length + 1, visible: body.visible ?? true, previous_slugs: [] as never });
    await this.audit({ action: 'content.news.category.create', actionLabel: 'Added news category', target: { type: 'news_category', id: row.id, label: name }, after: row }, by);
    return this.categoryOutNews(row, new Map());
  }

  async updateNewsCategory(id: string, body: { name?: string | null; icon?: string | null; visible?: boolean | null; position?: number | null }, by: By): Promise<NewsCategory> {
    const before = await this.repo.getNewsCategory(id);
    if (!before) throw notFound('Category');
    const name = body.name != null ? await this.checkCategoryName(body.name, id) : null;
    const all = await this.repo.listNewsCategories();
    if (body.position != null && (body.position < 1 || body.position > all.length)) throw invalid('position', `Use a position from 1 to ${all.length}`);
    // a new name gives a new slug; the old one keeps working as a filter link
    const slug = name && name !== before.name ? await this.freeCategorySlug(name, null, id) : before.slug;
    const row = await this.repo.transaction(async (tx) => {
      const updated = await tx.updateNewsCategory(id, {
        ...(name ? { name } : {}),
        ...(slug !== before.slug ? { slug, previous_slugs: unique([...stringList(before.previous_slugs), before.slug]) as never } : {}),
        ...(body.icon !== undefined ? { icon: body.icon?.trim() || null } : {}),
        ...(body.visible != null ? { visible: body.visible } : {}),
      });
      if (body.position != null) {
        const order = (await tx.listNewsCategories()).filter((c) => c.id !== id);
        order.splice(body.position - 1, 0, updated);
        for (const [i, c] of order.entries()) if (c.position !== i + 1) await tx.updateNewsCategory(c.id, { position: i + 1 });
      }
      return (await tx.getNewsCategory(id))!;
    });
    const label = body.visible === false ? 'Hid news category' : body.visible === true && !before.visible ? 'Showed news category' : body.position != null && !name ? 'Reordered news categories' : 'Edited news category';
    await this.audit({ action: 'content.news.category.update', actionLabel: label, target: { type: 'news_category', id, label: row.name }, before, after: row }, by);
    if (slug !== before.slug || body.visible != null) this.invalidateHome();
    return this.categoryOutNews(row, await this.newsCounts(false));
  }

  async deleteNewsCategory(id: string, by: By): Promise<void> {
    const c = await this.repo.getNewsCategory(id);
    if (!c) throw notFound('Category');
    const posts = (await this.repo.listNews({ categoryId: id })).filter((p) => p.status !== 'removed');
    if (posts.length) {
      throw new AppError('CONFLICT', `${posts.length} ${posts.length === 1 ? 'post uses' : 'posts use'} ${c.name}; move ${posts.length === 1 ? 'it' : 'them'} to another category first`, {
        posts: posts.map((p) => ({ id: p.id, title: p.title, status: p.status })),
      });
    }
    await this.repo.transaction(async (tx) => {
      await tx.deleteNewsCategory(id);
      for (const [i, row] of (await tx.listNewsCategories()).entries()) if (row.position !== i + 1) await tx.updateNewsCategory(row.id, { position: i + 1 });
    });
    await this.audit({ action: 'content.news.category.delete', actionLabel: 'Deleted news category', target: { type: 'news_category', id, label: c.name }, before: c }, by);
  }

  /* ---------------------------------------------------------------- views */

  protected newsSnapOf(v: VersionRow | undefined | null): NewsSnap | null {
    return v ? (v.snapshot as unknown as NewsSnap) : null;
  }

  /** Past its archive time: no longer listed, its link still opens it */
  private isArchived(r: Pick<NewsRow, 'archive_at'>, now = this.now()): boolean {
    return Boolean(r.archive_at && r.archive_at <= now);
  }

  private newsUrl(slug: string) {
    return `/news/${slug}`;
  }

  /** Listed in the store: published and not archived, pinned first (latest pin first), then newest */
  private async listedNews(now = this.now()): Promise<NewsRow[]> {
    const rows = (await this.repo.listNews({ statuses: ['published'] })).filter((r) => r.live_version_id && !this.isArchived(r, now));
    const t = (d: Date | null | undefined) => (d ? d.getTime() : 0);
    return rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.pinned && b.pinned ? t(b.pinned_at) - t(a.pinned_at) : 0) || t(b.published_at) - t(a.published_at));
  }

  /** Store cards from the live versions, in one read per kind */
  protected async newsCards(rows: NewsRow[]): Promise<NewsCard[]> {
    if (!rows.length) return [];
    const [versions, cats] = await Promise.all([this.repo.getVersions(rows.map((r) => r.live_version_id).filter((x): x is string => Boolean(x))), this.repo.listNewsCategories()]);
    const byId = new Map(versions.map((v) => [v.id, v]));
    const catById = new Map(cats.map((c) => [c.id, c]));
    const snaps = rows.map((r) => this.newsSnapOf(byId.get(r.live_version_id ?? '')));
    const covers = await this.refsMap(snaps.map((s) => s?.cover?.id));
    return rows.map((r, i) => {
      const s = snaps[i];
      return {
        id: r.id,
        slug: r.slug,
        url: this.newsUrl(r.slug),
        title: s?.title ?? r.title,
        summary: s?.summary ?? r.summary,
        category: this.categoryRef(catById.get(r.category_id), r.category_id),
        cover: s?.cover?.id ? (covers.get(s.cover.id) ?? null) : null,
        pinned: r.pinned,
        publishedAt: (r.published_at ?? r.updated_at).toISOString(),
      };
    });
  }

  /** The post as the store renders it, from one version's content */
  protected async newsView(r: NewsRow, snap: NewsSnap, version: VersionRow | undefined): Promise<NewsPost> {
    const now = this.now();
    const [cat, covers, listed] = await Promise.all([this.repo.getNewsCategory(snap.categoryId), this.refsMap([snap.cover?.id]), this.listedNews(now)]);
    const related = await this.newsCards(listed.filter((x) => x.id !== r.id).slice(0, 3));
    const isLive = version?.state === 'live';
    return {
      id: r.id,
      slug: snap.slug,
      url: this.newsUrl(snap.slug),
      title: snap.title,
      summary: snap.summary,
      category: this.categoryRef(cat, snap.categoryId),
      cover: snap.cover?.id ? (covers.get(snap.cover.id) ?? null) : null,
      pinned: r.pinned,
      publishedAt: iso(r.published_at),
      updatedAt: (isLive ? (version?.published_at ?? version?.created_at) : version?.created_at ?? r.updated_at)!.toISOString(),
      body: sanitizeHtml(snap.body),
      cta: snap.cta ?? null,
      archived: isLive ? this.isArchived(r, now) : Boolean(snap.archiveAt && new Date(snap.archiveAt) <= now),
      related,
      version: version?.number ?? 0,
    };
  }

  private async newsOrThrow(id: string): Promise<NewsRow> {
    const r = await this.repo.getNews(id);
    if (!r) throw notFound('News post');
    return r;
  }

  private async newsVersions(r: NewsRow) {
    const [live, draft] = await Promise.all([r.live_version_id ? this.repo.getVersion(r.live_version_id) : undefined, r.draft_version_id ? this.repo.getVersion(r.draft_version_id) : undefined]);
    return { live, draft };
  }

  private async newsReviewOn(): Promise<boolean> {
    return (await this.reviewRequired()).news;
  }

  /** The post itself (first publication) or a live post's new draft waits for review */
  private awaitingReview(r: NewsRow, draft: VersionRow | undefined): boolean {
    return r.status === 'in_review' || this.newsSnapOf(draft)?._review?.state === 'in_review';
  }

  /** viewer: the calling staff member, for canApprove (the writer of a draft cannot approve it) */
  protected async newsAdmin(r: NewsRow, viewer?: By): Promise<NewsAdmin> {
    const { live, draft } = await this.newsVersions(r);
    const v = draft ?? live;
    const snap = this.newsSnapOf(v)!;
    const authorIsStaff = draft?.author_kind === 'staff' && Boolean(draft.author_id);
    const [owner, author, reviewOn] = await Promise.all([this.owner(r.owner_staff_id), authorIsStaff ? this.owner(draft!.author_id) : null, this.newsReviewOn()]);
    const draftAuthor: common.Actor | null = draft ? { kind: draft.author_kind as common.Actor['kind'], id: draft.author_id ?? null, name: author?.name ?? null } : null;
    const isAuthor = Boolean(draft?.author_id && viewer?.actor.id && draft.author_id === viewer.actor.id);
    // a live post's draft review; before the first publication status tells it, except the reviewer's note
    const draftNote = this.newsSnapOf(draft)?._review;
    const review = draftNote && (r.live_version_id || draftNote.state === 'changes_requested') ? draftNote : null;
    return {
      post: await this.newsView(r, snap, v),
      status: r.status as Status,
      archived: r.status === 'published' && this.isArchived(r),
      pinned: r.pinned,
      archiveAt: snap.archiveAt ?? iso(r.archive_at),
      owner,
      draftVersion: draft?.number ?? null,
      liveVersion: live?.number ?? null,
      draftAuthor,
      canApprove: this.awaitingReview(r, draft) && !isAuthor && !(await this.isOwnWork('news', r.id, v, viewer)),
      draftReview: review ? { state: review.state, by: review.by ?? actorFromKey(null), at: review.at ?? iso(draft!.created_at)!, reason: review.reason ?? null } : null,
      reviewRequired: reviewOn,
      schedule: this.schedule(r.publish_at, r.unpublish_at, await this.marketTimeZone()),
      lastPublishedAt: iso(live?.published_at),
    };
  }

  async getNewsAdmin(id: string, viewer?: By): Promise<NewsAdmin> {
    return this.newsAdmin(await this.newsOrThrow(id), viewer);
  }

  async previewNews(id: string, body: { useDraft?: boolean | null }): Promise<NewsPost> {
    const r = await this.newsOrThrow(id);
    const { live, draft } = await this.newsVersions(r);
    const v = body.useDraft === false ? (live ?? draft) : (draft ?? live);
    const snap = this.newsSnapOf(v);
    if (!snap) throw notFound('Version');
    return this.newsView(r, snap, v);
  }

  private matchesStatus(r: NewsRow, draft: VersionRow | undefined, status: string | undefined, now: Date): boolean {
    if (!status) return true;
    if (status === 'in_review') return this.awaitingReview(r, draft);
    if (status === 'published') return r.status === 'published' && !this.isArchived(r, now);
    if (status === 'archived') return (r.status === 'published' && this.isArchived(r, now)) || r.status === 'unpublished' || r.status === 'removed';
    return r.status === status;
  }

  async listNewsAdmin(q: { status?: string; categoryId?: string; q?: string }, page: PageRequest): Promise<common.Page<NewsAdminSummary>> {
    const now = this.now();
    const rows = await this.repo.listNews(q.categoryId ? { categoryId: q.categoryId } : {});
    const drafts = new Map((await this.repo.getVersions(rows.map((r) => r.draft_version_id).filter((x): x is string => Boolean(x)))).map((v) => [v.id, v]));
    const term = q.q?.trim().toLowerCase();
    const shown = rows.filter((r) => this.matchesStatus(r, drafts.get(r.draft_version_id ?? ''), q.status, now) && (!term || `${r.title} ${r.summary} ${r.slug}`.toLowerCase().includes(term)));
    const slice = pageOf(shown, page);
    const [cats, owners] = await Promise.all([this.repo.listNewsCategories(), this.owners(slice.items.map((r) => ({ staffId: r.owner_staff_id, role: 'Content' })))]);
    const catById = new Map(cats.map((c) => [c.id, c]));
    const versions = new Map((await this.repo.getVersions(slice.items.flatMap((r) => [r.live_version_id, r.draft_version_id]).filter((x): x is string => Boolean(x)))).map((v) => [v.id, v]));
    return {
      ...slice,
      items: slice.items.map((r, i) => {
        const draft = versions.get(r.draft_version_id ?? '');
        const snap = this.newsSnapOf(draft) ?? this.newsSnapOf(versions.get(r.live_version_id ?? ''));
        return {
          id: r.id,
          slug: r.slug,
          url: this.newsUrl(r.slug),
          title: snap?.title ?? r.title,
          category: this.categoryRef(catById.get(snap?.categoryId ?? r.category_id), snap?.categoryId ?? r.category_id),
          status: r.status as Status,
          archived: r.status === 'published' && this.isArchived(r, now),
          pinned: r.pinned,
          awaitingReview: this.awaitingReview(r, draft),
          owner: owners[i]!,
          publishedAt: iso(r.published_at),
          publishAt: iso(r.publish_at),
          archiveAt: iso(r.archive_at) ?? snap?.archiveAt ?? null,
          updatedAt: r.updated_at.toISOString(),
          draftVersion: draft?.number ?? null,
          liveVersion: versions.get(r.live_version_id ?? '')?.number ?? null,
        };
      }),
    };
  }

  async getNewsCounts(): Promise<NewsStatusCounts> {
    const now = this.now();
    const rows = await this.repo.listNews();
    const drafts = new Map((await this.repo.getVersions(rows.map((r) => r.draft_version_id).filter((x): x is string => Boolean(x)))).map((v) => [v.id, v]));
    const n = (status: string) => rows.filter((r) => this.matchesStatus(r, drafts.get(r.draft_version_id ?? ''), status, now)).length;
    return { all: rows.length, draft: n('draft'), inReview: n('in_review'), scheduled: n('scheduled'), published: n('published'), archived: n('archived') };
  }

  async listNewsVersions(id: string, page: PageRequest): Promise<common.Page<Version>> {
    await this.newsOrThrow(id);
    const res = await this.repo.pageOfVersions('news', id, page);
    return { ...res, items: res.items.map((v) => this.versionOut(v)) };
  }

  /* ---------------------------------------------------------------- writes */

  private async normalizeNews(input: NewsInput, opts: { postId?: string; by: By; current?: NewsSnap | null }): Promise<NewsSnap> {
    const title = requireText(input.title, 'title', 'A post needs a title');
    if (title.length > TITLE_MAX) throw invalid('title', `Use up to ${TITLE_MAX} characters`);
    const summary = requireText(input.summary, 'summary', 'Write a short summary for the news cards');
    if (summary.length > SUMMARY_MAX) throw invalid('summary', `Use up to ${SUMMARY_MAX} characters`);
    if (!(await this.repo.getNewsCategory(input.categoryId))) throw invalid('categoryId', 'Pick a category');
    const body = sanitizeHtml(requireText(input.body, 'body', 'A post needs its text'));
    if (!plainText(body)) throw invalid('body', 'A post needs its text');
    let slug = (input.slug?.trim().toLowerCase() || opts.current?.slug || slugify(title) || `news-${newId().slice(0, 8)}`).slice(0, 120);
    if (!isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, numbers and hyphens');
    if (RESERVED_SLUGS.has(slug)) throw invalid('slug', `${slug} is reserved; pick another address`);
    const other = await this.repo.newsBySlug(slug);
    if (other && other.id !== opts.postId) {
      // a new post without its own slug gets the next free one; a chosen slug must be free
      if (input.slug?.trim() || opts.current) throw this.ctx.error('SLUG_TAKEN', `Another post uses ${slug}`);
      const base = slug;
      for (let i = 2; await this.repo.newsBySlug(slug); i++) slug = `${base}-${i}`;
    }
    this.checkLink(input.cta, 'cta');
    if (input.archiveAt && Number.isNaN(Date.parse(input.archiveAt))) throw invalid('archiveAt', 'Use a date and time');
    return {
      title,
      slug,
      categoryId: input.categoryId,
      summary,
      body,
      cover: input.cover?.id ? input.cover : null,
      cta: input.cta ? { label: input.cta.label.trim(), url: input.cta.url.trim(), kind: input.cta.kind ?? null } : null,
      archiveAt: input.archiveAt ?? null,
      ownerStaffId: input.ownerStaffId ?? opts.current?.ownerStaffId ?? this.staffIdOf(opts.by),
    };
  }

  /** Columns follow the live version; before the first publication they follow the draft */
  private newsColumns(s: NewsSnap): Partial<NewsRow> {
    return { slug: s.slug, category_id: s.categoryId, title: s.title, summary: s.summary, archive_at: s.archiveAt ? new Date(s.archiveAt) : null };
  }

  private slugConflictNews(err: unknown, slug: string) {
    const msg = err instanceof Error ? err.message : '';
    if (/unique|duplicate/i.test(msg) && /slug/i.test(msg)) return this.ctx.error('SLUG_TAKEN', `Another post uses ${slug}`);
    return err;
  }

  async createNews(input: NewsInput, by: By): Promise<NewsAdmin> {
    const id = newId();
    const snap = await this.normalizeNews(input, { by });
    const media = await this.syncMedia('content_block', id, snap.title, [], newsMediaIds(snap));
    const now = this.now();
    let row: NewsRow;
    try {
      row = await this.repo.transaction(async (tx) => {
        const v = await tx.insertVersion(this.newVersionRow('news', id, 1, snap, by, { summary: input.changeNote?.trim() || 'Created the post' }));
        return tx.insertNews({
          ...(this.newsColumns(snap) as Omit<NewsRow, 'id'>),
          id,
          previous_slugs: [] as never,
          owner_staff_id: snap.ownerStaffId,
          status: 'draft',
          pinned: false,
          pinned_at: null,
          publish_at: null,
          unpublish_at: null,
          published_at: null,
          live_version_id: null,
          draft_version_id: v.id,
          updated_at: now,
        });
      });
    } catch (err) {
      await media.undo();
      throw this.slugConflictNews(err, snap.slug);
    }
    await media.commit();
    await this.logAction('news', id, 'create', by);
    await this.audit({ action: 'content.news.create', actionLabel: 'Created news post', target: { type: 'news_post', id, label: snap.title }, after: snap }, by);
    return this.newsAdmin(row, by);
  }

  async updateNews(id: string, input: NewsInput, by: By): Promise<NewsAdmin> {
    const r = await this.newsOrThrow(id);
    if (r.status === 'in_review' || r.status === 'approved' || r.status === 'scheduled') throw new AppError('CONFLICT', r.status === 'scheduled' ? 'Cancel the schedule before editing' : r.status === 'approved' ? 'The post is approved; publish it, or request changes before editing' : 'The post is in review; request changes before editing');
    if (r.status === 'removed') throw new AppError('CONFLICT', 'The post was removed; restore it before editing');
    const { live, draft } = await this.newsVersions(r);
    const draftSnap = this.newsSnapOf(draft);
    // a draft in review or approved is frozen; after changes were requested it is edited again (the note stays)
    const review = draftSnap?._review;
    if (review && review.state !== 'changes_requested') throw new AppError('CONFLICT', review.state === 'approved' ? 'The draft is approved; publish it, or request changes before editing' : 'The draft is in review; request changes before editing');
    const snap = await this.normalizeNews(input, { postId: id, by, current: draftSnap ?? this.newsSnapOf(live) });
    const before = [...newsMediaIds(draftSnap), ...newsMediaIds(this.newsSnapOf(live))].map((f) => f.id);
    const media = await this.syncMedia('content_block', id, snap.title, before, [...newsMediaIds(snap), ...newsMediaIds(this.newsSnapOf(live))]);
    const summary = input.changeNote?.trim() || 'Edited the draft';
    let row: NewsRow;
    try {
      row = await this.repo.transaction(async (tx) => {
        const locked = (await tx.getNews(id, { forUpdate: true }))!;
        let draftId = locked.draft_version_id;
        if (draftId) await tx.updateVersion(draftId, { snapshot: (review ? { ...snap, _review: review } : snap) as never, summary, author_kind: by.actor.kind, author_id: by.actor.id ?? null, created_at: this.now() });
        else draftId = (await tx.insertVersion(this.newVersionRow('news', id, (await tx.maxVersionNumber('news', id)) + 1, snap, by, { summary }))).id;
        return tx.updateNews(id, { draft_version_id: draftId, owner_staff_id: snap.ownerStaffId, ...(locked.live_version_id ? {} : this.newsColumns(snap)), updated_at: this.now() });
      });
    } catch (err) {
      await media.undo();
      throw this.slugConflictNews(err, snap.slug);
    }
    await media.commit();
    await this.logAction('news', id, 'edit', by, input.changeNote ?? null);
    await this.audit({ action: 'content.news.update', actionLabel: 'Edited news post draft', target: { type: 'news_post', id, label: snap.title }, before: draftSnap ?? this.newsSnapOf(live), after: snap, reason: input.changeNote ?? null }, by);
    return this.newsAdmin(row, by);
  }

  private async setNewsDraftReview(r: NewsRow, review: DraftReview | null) {
    const draft = r.draft_version_id ? await this.repo.getVersion(r.draft_version_id) : undefined;
    if (!draft) return;
    await this.repo.updateVersion(draft.id, { snapshot: { ...(draft.snapshot as unknown as NewsSnap), _review: review } as never });
  }

  /** One action endpoint for the publication state machine on news posts (the same rules as help articles) */
  async transitionNews(id: string, body: { action: Action; reason?: string | null; kind?: 'correction' | 'removal' | null; publishAt?: string | null }, by: By): Promise<NewsAdmin> {
    const r = await this.newsOrThrow(id);
    const status = r.status as Status;
    const review = await this.newsReviewOn();
    const draft = r.draft_version_id ? await this.repo.getVersion(r.draft_version_id) : undefined;
    const draftReview = this.newsSnapOf(draft)?._review ?? null;
    const liveWithDraft = (status === 'published' || status === 'unpublished') && Boolean(draft);
    const illegal = (message: string) => new AppError('ILLEGAL_TRANSITION', message, { from: status, event: body.action, allowed: contentPublicationMachine.eventsFrom(status) });
    const now = this.now();
    let event: string = body.action;

    switch (body.action) {
      case 'submit': {
        if (liveWithDraft) {
          if (draftReview?.state === 'in_review') throw illegal('The draft is already in review');
          if (draftReview?.state === 'approved') throw illegal('The draft is already approved; publish it');
          await this.setNewsDraftReview(r, { state: 'in_review', by: by.actor, at: now.toISOString() });
        } else {
          await this.repo.updateNews(id, { status: contentPublicationMachine.next(status, 'submit'), updated_at: now });
          // submitted again after changes were requested: the old note goes
          if (draftReview) await this.setNewsDraftReview(r, null);
        }
        break;
      }
      case 'approve':
      case 'requestChanges': {
        const approving = body.action === 'approve';
        if (!approving) requireText(body.reason, 'reason', 'Say what needs to change');
        // a restored post has no draft: what goes back live is the live version
        if (approving) await this.assertNotOwnWork('news', id, draft ?? (r.live_version_id ? await this.repo.getVersion(r.live_version_id) : undefined), by, 'post');
        // a live post's draft in review, or an approved one sent back before it goes live
        if (status !== 'in_review' && (draftReview?.state === 'in_review' || (!approving && draftReview?.state === 'approved'))) {
          await this.setNewsDraftReview(r, approving ? { state: 'approved', by: by.actor, at: now.toISOString() } : { state: 'changes_requested', by: by.actor, at: now.toISOString(), reason: body.reason!.trim() });
        } else if (liveWithDraft) throw illegal(draftReview ? `The draft is ${draftReview.state.replace('_', ' ')}, not waiting for review` : 'Submit the draft for review first');
        else {
          await this.repo.updateNews(id, { status: contentPublicationMachine.next(status, body.action), updated_at: now });
          // the reviewer's note reaches the writer like on a live post's draft
          if (!approving) await this.setNewsDraftReview(r, { state: 'changes_requested', by: by.actor, at: now.toISOString(), reason: body.reason!.trim() });
        }
        break;
      }
      case 'schedule': {
        if (!body.publishAt) throw invalid('publishAt', 'Pick when the post goes live');
        const publishAt = new Date(body.publishAt);
        if (Number.isNaN(publishAt.getTime())) throw invalid('publishAt', 'Use a date and time');
        if (review && status === 'draft') throw illegal('The post needs review before it is scheduled');
        if (status === 'published') throw illegal('The post is live: publish its approved draft now, or unpublish it to schedule it');
        if (review && liveWithDraft && draftReview?.state !== 'approved') throw illegal('The draft needs review before it is scheduled');
        await this.repo.updateNews(id, { status: contentPublicationMachine.next(status, 'schedule'), publish_at: publishAt, updated_at: now });
        break;
      }
      case 'cancelSchedule':
        await this.repo.updateNews(id, { status: contentPublicationMachine.next(status, 'cancelSchedule'), publish_at: null, updated_at: now });
        break;
      case 'publish': {
        if (status === 'published') {
          if (!draft) throw illegal('The post is already live and has no new draft');
          if (review && draftReview?.state !== 'approved') throw illegal('The draft needs review before it goes live');
        } else {
          contentPublicationMachine.next(status, 'publish');
          if (review && status === 'draft') throw illegal('The post needs review before it is published');
          if (review && status === 'unpublished' && draft && draftReview?.state !== 'approved') throw illegal('The draft needs review before it goes live');
        }
        await this.newsLive(id, by, 'publish');
        return this.newsAdmin(await this.newsOrThrow(id), by);
      }
      case 'unpublish':
        await this.newsDown(id, body.reason ?? null, by);
        return this.newsAdmin(await this.newsOrThrow(id), by);
      case 'remove': {
        if (!body.kind) throw invalid('kind', 'Say whether this is a correction or a removal');
        const reason = requireText(body.reason, 'reason', 'A reason is required');
        await this.repo.updateNews(id, { status: contentPublicationMachine.next(status, 'remove'), pinned: false, pinned_at: null, ...(status === 'scheduled' ? { publish_at: null } : {}), updated_at: now });
        this.ctx.events.publish('content.page.removed', { entity: 'news', entityId: id, kind: body.kind, reason }, { actor: by.actor, requestId: by.requestId });
        this.invalidateHome();
        event = body.kind;
        break;
      }
      case 'restore':
        await this.repo.updateNews(id, { status: contentPublicationMachine.next(status, 'restore'), updated_at: now });
        break;
      case 'discardDraft': {
        // a live post's unpublished draft goes; the live version stays as it is
        if (!draft || !r.live_version_id) throw illegal(r.live_version_id ? 'The post has no draft to discard' : 'The post was never published: remove it instead');
        const live = await this.repo.getVersion(r.live_version_id);
        const keep = new Set(newsMediaIds(this.newsSnapOf(live)).map((f) => f.id));
        await this.repo.transaction(async (tx) => {
          await tx.updateVersion(draft.id, { state: 'discarded' });
          await tx.updateNews(id, { draft_version_id: null, updated_at: now });
        });
        for (const f of newsMediaIds(this.newsSnapOf(draft))) if (!keep.has(f.id)) await this.media.detach(f.id, { module: 'content', kind: 'content_block', refId: id }).catch(() => {});
        break;
      }
    }
    await this.logAction('news', id, event, by, body.reason ?? body.publishAt ?? null);
    await this.audit({ action: `content.news.${body.action}`, actionLabel: `News post: ${body.action}`, target: { type: 'news_post', id, label: r.title }, reason: body.reason ?? null, before: { status }, after: { status: (await this.repo.getNews(id))!.status } }, by);
    return this.newsAdmin(await this.newsOrThrow(id), by);
  }

  /** Publishes the draft (or the live version again); used by publish and the schedule job */
  protected async newsLive(id: string, by: By, why: 'publish' | 'scheduled'): Promise<NewsRow> {
    const now = this.now();
    const before = await this.newsOrThrow(id);
    const draft = before.draft_version_id ? await this.repo.getVersion(before.draft_version_id) : undefined;
    const liveBefore = before.live_version_id ? await this.repo.getVersion(before.live_version_id) : undefined;
    const snap = this.newsSnapOf(draft);
    if (snap) {
      const other = await this.repo.newsBySlug(snap.slug);
      if (other && other.id !== id) throw this.ctx.error('SLUG_TAKEN', `Another post uses ${snap.slug}`);
    }
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.getNews(id, { forUpdate: true }))!;
      let liveId = locked.live_version_id;
      let fields: Partial<NewsRow> = {};
      if (locked.draft_version_id && snap) {
        const { _review, ...clean } = snap;
        void _review;
        if (locked.live_version_id) await tx.updateVersion(locked.live_version_id, { state: 'superseded' });
        await tx.updateVersion(locked.draft_version_id, { state: 'live', published_at: now, snapshot: clean as never });
        liveId = locked.draft_version_id;
        fields = { ...this.newsColumns(snap), owner_staff_id: snap.ownerStaffId ?? locked.owner_staff_id };
        // a published post that changes its address keeps the old one working
        if (locked.live_version_id && snap.slug !== locked.slug) fields.previous_slugs = unique([...stringList(locked.previous_slugs), locked.slug]) as never;
      }
      if (!liveId) throw invalid('draft', 'The post has nothing to publish');
      return tx.updateNews(id, {
        ...fields,
        status: 'published',
        live_version_id: liveId,
        draft_version_id: null,
        publish_at: null,
        published_at: locked.published_at ?? now,
        // a pin waiting since before the first publication counts from now
        ...(locked.pinned && !locked.published_at ? { pinned_at: now } : {}),
        updated_at: now,
      });
    });
    if (row.pinned) await this.keepPinLimit(id);
    const live = (await this.repo.getVersion(row.live_version_id!))!;
    // files only the replaced live version used are no longer needed
    if (liveBefore && liveBefore.id !== live.id) {
      const keep = new Set(newsMediaIds(this.newsSnapOf(live)).map((f) => f.id));
      for (const f of newsMediaIds(this.newsSnapOf(liveBefore))) if (!keep.has(f.id)) await this.media.detach(f.id, { module: 'content', kind: 'content_block', refId: id }).catch(() => {});
    }
    this.invalidateHome();
    this.ctx.events.publish('content.news.published', { postId: id, slug: row.slug, url: this.newsUrl(row.slug), version: live.number }, { actor: by.actor, requestId: by.requestId });
    await this.logAction('news', id, why === 'publish' ? 'publish' : 'publish_scheduled', by);
    if (why === 'scheduled') await this.audit({ action: 'content.news.publish', actionLabel: 'Published scheduled news post', target: { type: 'news_post', id, label: row.title }, after: { version: live.number } }, by);
    return row;
  }

  protected async newsDown(id: string, reason: string | null, by: By): Promise<NewsRow> {
    const r = await this.newsOrThrow(id);
    const status = contentPublicationMachine.next(r.status as Status, 'unpublish');
    const now = this.now();
    const row = await this.repo.updateNews(id, { status, unpublish_at: null, updated_at: now });
    this.invalidateHome();
    this.ctx.events.publish('content.news.unpublished', { postId: id, slug: row.slug, reason }, { actor: by.actor, requestId: by.requestId });
    await this.logAction('news', id, 'unpublish', by, reason);
    return row;
  }

  /** At most MAX_PINNED published posts are pinned: the ones pinned longest ago give way */
  private async keepPinLimit(keepId: string) {
    const pinned = (await this.repo.listNews({ statuses: ['published'] })).filter((p) => p.pinned).sort((a, b) => (b.pinned_at?.getTime() ?? 0) - (a.pinned_at?.getTime() ?? 0));
    const over = pinned.filter((p) => p.id !== keepId).slice(MAX_PINNED - 1);
    for (const p of over) await this.repo.updateNews(p.id, { pinned: false, pinned_at: null });
    return over;
  }

  async pinNews(id: string, body: { pinned: boolean }, by: By): Promise<NewsAdmin> {
    const r = await this.newsOrThrow(id);
    if (r.status === 'removed') throw new AppError('CONFLICT', 'The post was removed');
    if (r.pinned === body.pinned) return this.newsAdmin(r, by);
    const now = this.now();
    await this.repo.updateNews(id, { pinned: body.pinned, pinned_at: body.pinned ? now : null });
    const unpinned = body.pinned && r.status === 'published' ? await this.keepPinLimit(id) : [];
    this.invalidateHome();
    await this.audit(
      {
        action: body.pinned ? 'content.news.pin' : 'content.news.unpin',
        actionLabel: body.pinned ? 'Pinned news post' : 'Unpinned news post',
        target: { type: 'news_post', id, label: r.title },
        ...(unpinned.length ? { after: { unpinned: unpinned.map((p) => ({ id: p.id, title: p.title })) } } : {}),
      },
      by,
    );
    return this.newsAdmin(await this.newsOrThrow(id), by);
  }

  async restoreNewsVersion(id: string, number: number, body: { reason: string }, by: By): Promise<NewsAdmin> {
    const reason = requireText(body.reason, 'reason', 'Say why the version is restored');
    const r = await this.newsOrThrow(id);
    const source = await this.repo.versionByNumber('news', id, number);
    if (!source) throw notFound('Version');
    if (r.status === 'in_review' || r.status === 'approved' || r.status === 'scheduled') throw new AppError('CONFLICT', 'Finish the review or cancel the schedule before restoring a version');
    const { _review, ...snap } = source.snapshot as unknown as NewsSnap;
    void _review;
    const other = await this.repo.newsBySlug(snap.slug);
    if (other && other.id !== id) throw this.ctx.error('SLUG_TAKEN', `Another post uses ${snap.slug}`);
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.getNews(id, { forUpdate: true }))!;
      if (locked.draft_version_id) await tx.updateVersion(locked.draft_version_id, { state: 'discarded' });
      const v = await tx.insertVersion(this.newVersionRow('news', id, (await tx.maxVersionNumber('news', id)) + 1, snap, by, { summary: `Restored version ${number}: ${reason}`, restored_from: number }));
      return tx.updateNews(id, {
        draft_version_id: v.id,
        ...(locked.status === 'removed' ? { status: contentPublicationMachine.next('removed', 'restore') } : {}),
        ...(locked.live_version_id ? {} : this.newsColumns(snap)),
        updated_at: this.now(),
      });
    });
    await this.logAction('news', id, 'restore', by, reason);
    await this.audit({ action: 'content.news.restore-version', actionLabel: `Restored news post version ${number} as a new draft`, target: { type: 'news_post', id, label: row.title }, reason }, by);
    return this.newsAdmin(row, by);
  }

  /* ---------------------------------------------------------------- store */

  async listNews(q: { category?: string }, page: PageRequest): Promise<common.Page<NewsCard>> {
    let rows = await this.listedNews();
    if (q.category?.trim()) {
      const cat = await this.repo.newsCategoryBySlug(q.category.trim().toLowerCase());
      rows = cat ? rows.filter((r) => r.category_id === cat.id) : [];
    }
    const slice = pageOf(rows, page);
    return { ...slice, items: await this.newsCards(slice.items) };
  }

  async getNewsSummary(): Promise<NewsSummary> {
    const rows = await this.listedNews();
    const latest = rows.reduce<Date | null>((m, r) => (r.published_at && (!m || r.published_at > m) ? r.published_at : m), null);
    return { count: rows.length, latestPublishedAt: iso(latest) };
  }

  /** A published post by its slug or an old one (archived posts still open) */
  async getNewsPost(slug: string): Promise<NewsPost> {
    const r = await this.repo.newsBySlug(slug.trim().toLowerCase());
    if (!r || r.status !== 'published' || !r.live_version_id) throw notFound('News post');
    const live = await this.repo.getVersion(r.live_version_id);
    const snap = this.newsSnapOf(live);
    if (!snap) throw notFound('News post');
    return this.newsView(r, snap, live);
  }

  /** The homepage `news` section: the newest listed posts, pinned first */
  protected override async homeNews(): Promise<NewsCard[]> {
    return this.newsCards((await this.listedNews()).slice(0, HOME_NEWS));
  }

  /* ---------------------------------------------------------------- jobs */

  protected async runNewsSchedules(): Promise<number> {
    const now = this.now();
    let n = 0;
    for (const r of await this.repo.newsToPublish(now, 50)) {
      try {
        await this.newsLive(r.id, SYSTEM, 'scheduled');
        n++;
      } catch (err) {
        this.ctx.log.warn({ err, postId: r.id }, 'content: scheduled news post could not be published');
      }
    }
    for (const r of await this.repo.newsToUnpublish(now, 50)) {
      try {
        await this.newsDown(r.id, 'Reached its removal time', SYSTEM);
        n++;
      } catch (err) {
        this.ctx.log.warn({ err, postId: r.id }, 'content: news post could not be taken down at its removal time');
      }
    }
    return n;
  }
}
