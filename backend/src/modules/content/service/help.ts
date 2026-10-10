/**
 * Help Center: categories (topics), articles with drafts, review, schedule and versions,
 * helpfulness feedback, search, suggestions for support and the store reads.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { pageOf, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { ContactChannel, HelpArticle, HelpArticleAdmin, HelpArticleInput, HelpArticleSummary, HelpCategory, HelpHome, LinkRef, Version } from '../../../spec/content.js';
import { isValidSlug, plainText, readMinutes, sanitizeHtml, sanitizeJson, slugify } from '../domain/rules.js';
import { contentPublicationMachine } from '../domain/state-machines.js';
import type { ArticleRow, CategoryRow, ContentRepository, VersionRow } from '../ports.js';
import { dateOrNull, invalid, iso, notFound, requireText, SYSTEM, unique, type By, type DraftReview } from './base.js';
import { ContentHomepage } from './homepage.js';

/** An article version's content */
export interface ArticleSnap {
  title: string;
  slug: string;
  categoryId: string;
  summary: string | null;
  body: string;
  tables: unknown[] | null;
  relatedIds: string[];
  policyKeys: string[];
  audience: 'customer' | 'seller' | 'both';
  topics: string[];
  ownerStaffId: string | null;
  effectiveAt: string | null;
  featured: boolean;
  popularSearch: string | null;
  _review?: DraftReview | null;
}

type Status = HelpArticleAdmin['status'];
type Audience = 'customer' | 'seller' | 'both';

export const SELLER_FIRST_NOTE = 'For items from marketplace sellers, the seller answers first. If the seller does not reply within 2 business days, Marketly steps in.';
const HELPFUL_WINDOW_DAYS = 30;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export class ContentHelp extends ContentHomepage {
  /* ---------------------------------------------------------------- categories */

  private async articleCounts(): Promise<Map<string, number>> {
    const rows = await this.repo.listArticles({ statuses: ['published'] });
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.category_id, (out.get(r.category_id) ?? 0) + 1);
    return out;
  }

  protected categoryOut(c: CategoryRow, counts: Map<string, number>): HelpCategory {
    return { id: c.id, slug: c.slug, name: c.name, icon: c.icon, description: c.description, position: c.position, visible: c.visible, audience: c.audience as Audience, articleCount: counts.get(c.id) ?? 0, topArticles: null };
  }

  async listHelpCategoriesAdmin(): Promise<HelpCategory[]> {
    const [rows, counts] = await Promise.all([this.repo.listCategories(), this.articleCounts()]);
    return rows.map((c) => this.categoryOut(c, counts));
  }

  async createHelpCategory(body: { name: string; slug?: string | null; icon?: string | null; description?: string | null; audience: Audience; visible?: boolean | null }, by: By): Promise<HelpCategory> {
    const name = requireText(body.name, 'name', 'A category needs a name');
    let slug = body.slug?.trim().toLowerCase();
    if (slug) {
      if (!isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, numbers and hyphens');
      if (await this.repo.categoryBySlug(slug)) throw this.ctx.error('SLUG_TAKEN', `Another category uses ${slug}`);
    } else {
      const base = slugify(name) || 'topic';
      slug = base;
      for (let i = 2; await this.repo.categoryBySlug(slug); i++) slug = `${base}-${i}`;
    }
    const all = await this.repo.listCategories();
    const row = await this.repo.insertCategory({ id: newId(), slug, name, icon: body.icon?.trim() || null, description: body.description?.trim() || null, position: all.length + 1, visible: body.visible ?? true, audience: body.audience });
    await this.audit({ action: 'content.help.category.create', actionLabel: 'Created help category', target: { type: 'help_category', id: row.id, label: name }, after: row }, by);
    return this.categoryOut(row, new Map());
  }

  async updateHelpCategory(id: string, body: { name?: string | null; icon?: string | null; description?: string | null; position?: number | null; visible?: boolean | null }, by: By): Promise<HelpCategory> {
    const before = await this.repo.getCategory(id);
    if (!before) throw notFound('Category');
    if (body.name !== undefined && body.name !== null) requireText(body.name, 'name', 'A category needs a name');
    const all = await this.repo.listCategories();
    if (body.position != null && (body.position < 1 || body.position > all.length)) throw invalid('position', `Use a position from 1 to ${all.length}`);
    const row = await this.repo.transaction(async (tx) => {
      const updated = await tx.updateCategory(id, {
        ...(body.name != null ? { name: body.name.trim() } : {}),
        ...(body.icon !== undefined ? { icon: body.icon?.trim() || null } : {}),
        ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}),
        ...(body.visible != null ? { visible: body.visible } : {}),
      });
      if (body.position != null) {
        const order = (await tx.listCategories()).filter((c) => c.id !== id);
        order.splice(body.position - 1, 0, updated);
        for (const [i, c] of order.entries()) if (c.position !== i + 1) await tx.updateCategory(c.id, { position: i + 1 });
      }
      return (await tx.getCategory(id))!;
    });
    await this.audit({ action: 'content.help.category.update', actionLabel: body.visible === false ? 'Hid help category' : 'Edited help category', target: { type: 'help_category', id, label: row.name }, before, after: row }, by);
    return this.categoryOut(row, await this.articleCounts());
  }

  /* ---------------------------------------------------------------- article views */

  protected articleSnapOf(v: VersionRow | undefined | null): ArticleSnap | null {
    return v ? (v.snapshot as unknown as ArticleSnap) : null;
  }

  /** Live (or, for unpublished drafts, current draft) content of articles, in one read */
  private async liveSnaps(rows: ArticleRow[]): Promise<Map<string, { snap: ArticleSnap; version: VersionRow }>> {
    const versions = new Map((await this.repo.getVersions(rows.map((r) => r.live_version_id).filter((x): x is string => Boolean(x)))).map((v) => [v.id, v]));
    const out = new Map<string, { snap: ArticleSnap; version: VersionRow }>();
    for (const r of rows) {
      const v = r.live_version_id ? versions.get(r.live_version_id) : undefined;
      if (v) out.set(r.id, { snap: this.articleSnapOf(v)!, version: v });
    }
    return out;
  }

  protected async summaries(rows: ArticleRow[]): Promise<HelpArticleSummary[]> {
    const [snaps, cats] = await Promise.all([this.liveSnaps(rows), this.repo.listCategories()]);
    const names = new Map(cats.map((c) => [c.id, c.name]));
    return rows.map((r) => {
      const s = snaps.get(r.id);
      return {
        id: r.id,
        slug: r.slug,
        title: r.title,
        categoryId: r.category_id,
        categoryName: names.get(r.category_id) ?? '',
        summary: r.summary,
        readMinutes: s ? readMinutes(s.snap.body) : null,
        updatedAt: r.updated_at.toISOString(),
      };
    });
  }

  private async policyLinks(keys: string[]): Promise<LinkRef[]> {
    if (!keys.length) return [];
    const policies = await this.repo.listPolicies();
    return keys.map((k) => policies.find((p) => p.key === k)).filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => ({ label: p.title, url: `/policies/${p.key}`, kind: 'policy' as const }));
  }

  private actionsFor(snap: ArticleSnap): LinkRef[] {
    if (snap.audience === 'seller') return [{ label: 'Go to Seller Center orders', url: '/seller/orders', kind: 'page' }, { label: 'Contact seller support', url: '/seller/help/contact', kind: 'help' }];
    return [{ label: 'Go to my orders', url: '/account/orders', kind: 'page' }, { label: 'Contact us', url: '/help/contact', kind: 'help' }];
  }

  /** The article as the store renders it, from one version's content */
  protected async articleView(r: ArticleRow, snap: ArticleSnap, version: VersionRow | undefined): Promise<HelpArticle> {
    const [cat, counts] = await Promise.all([this.repo.getCategory(snap.categoryId), this.articleCounts()]);
    const category: HelpCategory = cat
      ? this.categoryOut(cat, counts)
      : { id: snap.categoryId, slug: 'help', name: 'Help', icon: null, description: null, position: 0, visible: false, audience: snap.audience, articleCount: 0, topArticles: null };
    // related: the chosen ones first, then the most read of the same topic
    const chosen = snap.relatedIds.length ? await this.repo.listArticles({ ids: snap.relatedIds, statuses: ['published'] }) : [];
    const ordered = snap.relatedIds.map((id) => chosen.find((a) => a.id === id)).filter((a): a is ArticleRow => Boolean(a));
    if (ordered.length < 3) {
      const more = (await this.repo.listArticles({ categoryId: snap.categoryId, statuses: ['published'] })).filter((a) => a.id !== r.id && !ordered.some((o) => o.id === a.id));
      ordered.push(...more.slice(0, 3 - ordered.length));
    }
    const body = sanitizeHtml(snap.body);
    return {
      id: r.id,
      slug: snap.slug,
      title: snap.title,
      category,
      breadcrumb: [
        { label: 'Help Center', url: '/help', kind: 'help' },
        { label: category.name, url: `/help/topics/${category.slug}`, kind: 'help' },
      ],
      effectiveAt: snap.effectiveAt,
      updatedAt: (version?.published_at ?? version?.created_at ?? r.updated_at).toISOString(),
      readMinutes: readMinutes(body),
      body,
      tables: (sanitizeJson(snap.tables ?? []) as unknown[]) ?? [],
      related: await this.summaries(ordered),
      actions: this.actionsFor(snap),
      policyLinks: await this.policyLinks(snap.policyKeys),
      version: version?.number ?? 0,
    };
  }

  private async articleOrThrow(id: string): Promise<ArticleRow> {
    const a = await this.repo.getArticle(id);
    if (!a) throw notFound('Article');
    return a;
  }

  private async articleVersions(a: ArticleRow) {
    const [live, draft] = await Promise.all([a.live_version_id ? this.repo.getVersion(a.live_version_id) : undefined, a.draft_version_id ? this.repo.getVersion(a.draft_version_id) : undefined]);
    return { live, draft };
  }

  protected async helpfulStats(articleIds: string[] | null, since?: Date): Promise<{ pct: number | null; total: number }> {
    const stats = await this.repo.feedbackStats(articleIds, since);
    const total = stats.reduce((n, s) => n + s.total, 0);
    const helpful = stats.reduce((n, s) => n + s.helpful, 0);
    return { pct: total ? Math.round((helpful / total) * 1000) / 10 : null, total };
  }

  protected async articleAdmin(a: ArticleRow): Promise<HelpArticleAdmin> {
    const { live, draft } = await this.articleVersions(a);
    const v = draft ?? live;
    const snap = this.articleSnapOf(v)!;
    const [owner, stats] = await Promise.all([this.owner(a.owner_staff_id), this.helpfulStats([a.id])]);
    return {
      article: await this.articleView(a, snap, v),
      status: a.status as Status,
      owner,
      draftVersion: draft?.number ?? null,
      liveVersion: live?.number ?? null,
      reviewDueAt: iso(a.review_due_at),
      helpfulPct: stats.pct,
      feedbackCount: stats.total,
      schedule: this.schedule(a.publish_at, a.unpublish_at, await this.marketTimeZone()),
    };
  }

  async getHelpArticleAdmin(id: string): Promise<HelpArticleAdmin> {
    return this.articleAdmin(await this.articleOrThrow(id));
  }

  async listArticleVersions(id: string, page: PageRequest): Promise<common.Page<Version>> {
    await this.articleOrThrow(id);
    const res = await this.repo.pageOfVersions('article', id, page);
    return { ...res, items: res.items.map((v) => this.versionOut(v)) };
  }

  /* ---------------------------------------------------------------- article writes */

  private async normalizeArticle(input: HelpArticleInput, opts: { articleId?: string; by: By; current?: ArticleSnap | null }): Promise<ArticleSnap> {
    const title = requireText(input.title, 'title', 'An article needs a title');
    const cat = await this.repo.getCategory(input.categoryId);
    if (!cat) throw invalid('categoryId', 'Category not found');
    const body = sanitizeHtml(requireText(input.body, 'body', 'An article needs its text'));
    if (!plainText(body)) throw invalid('body', 'An article needs its text');
    let slug = input.slug?.trim().toLowerCase() || opts.current?.slug || slugify(title) || `article-${newId().slice(0, 8)}`;
    if (!isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, numbers and hyphens');
    const other = await this.repo.articleBySlug(slug);
    if (other && other.id !== opts.articleId) throw this.ctx.error('SLUG_TAKEN', `Another article uses ${slug}`);
    const relatedIds = unique(input.relatedIds ?? []).filter((x) => x !== opts.articleId);
    const audience = (input.audience ?? (cat.audience === 'seller' ? 'seller' : cat.audience === 'both' ? 'both' : 'customer')) as Audience;
    slug = slug.slice(0, 120);
    return {
      title,
      slug,
      categoryId: cat.id,
      summary: input.summary?.trim() || null,
      body,
      tables: input.tables ? (sanitizeJson(input.tables) as unknown[]) : null,
      relatedIds,
      policyKeys: unique((input.policyKeys ?? []).map((k) => k.trim()).filter(Boolean)),
      audience,
      topics: unique((input.topics ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)),
      ownerStaffId: input.ownerStaffId ?? opts.current?.ownerStaffId ?? this.staffIdOf(opts.by),
      effectiveAt: input.effectiveAt ?? null,
      featured: Boolean(input.featured),
      popularSearch: input.popularSearch?.trim() || null,
    };
  }

  /** Columns follow the live version; before the first publication they follow the draft */
  private columnsOf(s: ArticleSnap): Partial<ArticleRow> {
    return {
      slug: s.slug,
      category_id: s.categoryId,
      title: s.title,
      summary: s.summary,
      audience: s.audience,
      topics: s.topics as never,
      related_ids: s.relatedIds as never,
      policy_keys: s.policyKeys as never,
      popular_search: s.popularSearch,
      effective_at: dateOrNull(s.effectiveAt),
    };
  }

  private slugConflictArticle(err: unknown, slug: string) {
    const msg = err instanceof Error ? err.message : '';
    if (/unique|duplicate/i.test(msg) && /slug/i.test(msg)) return this.ctx.error('SLUG_TAKEN', `Another article uses ${slug}`);
    return err;
  }

  async createHelpArticle(input: HelpArticleInput, by: By): Promise<HelpArticleAdmin> {
    const id = newId();
    const snap = await this.normalizeArticle(input, { by });
    const now = this.now();
    let row: ArticleRow;
    try {
      row = await this.repo.transaction(async (tx) => {
        const v = await tx.insertVersion(this.newVersionRow('article', id, 1, snap, by, { summary: input.changeNote?.trim() || 'Created the article' }));
        return tx.insertArticle({
          ...(this.columnsOf(snap) as Omit<ArticleRow, 'id'>),
          id,
          featured: false,
          owner_staff_id: snap.ownerStaffId,
          status: 'draft',
          publish_at: null,
          unpublish_at: null,
          review_due_at: null,
          live_version_id: null,
          draft_version_id: v.id,
          views: 0,
          search: null,
          updated_at: now,
        });
      });
    } catch (err) {
      throw this.slugConflictArticle(err, snap.slug);
    }
    await this.audit({ action: 'content.help.article.create', actionLabel: 'Created help article', target: { type: 'help_article', id, label: snap.title }, after: snap }, by);
    return this.articleAdmin(row);
  }

  async updateHelpArticle(id: string, input: HelpArticleInput, by: By): Promise<HelpArticleAdmin> {
    const a = await this.articleOrThrow(id);
    if (a.status === 'in_review' || a.status === 'approved' || a.status === 'scheduled') throw new AppError('CONFLICT', a.status === 'scheduled' ? 'Cancel the schedule before editing' : 'The article is in review; request changes before editing');
    if (a.status === 'removed') throw new AppError('CONFLICT', 'The article was removed; restore it before editing');
    const { live, draft } = await this.articleVersions(a);
    const draftSnap = this.articleSnapOf(draft);
    if (draftSnap?._review) throw new AppError('CONFLICT', 'The draft is in review; request changes before editing');
    const snap = await this.normalizeArticle(input, { articleId: id, by, current: draftSnap ?? this.articleSnapOf(live) });
    const summary = input.changeNote?.trim() || 'Edited the draft';
    let row: ArticleRow;
    try {
      row = await this.repo.transaction(async (tx) => {
        const locked = (await tx.getArticle(id, { forUpdate: true }))!;
        let draftId = locked.draft_version_id;
        if (draftId) await tx.updateVersion(draftId, { snapshot: snap as never, summary, author_kind: by.actor.kind, author_id: by.actor.id ?? null, created_at: this.now() });
        else draftId = (await tx.insertVersion(this.newVersionRow('article', id, (await tx.maxVersionNumber('article', id)) + 1, snap, by, { summary }))).id;
        return tx.updateArticle(id, { draft_version_id: draftId, owner_staff_id: snap.ownerStaffId, ...(locked.live_version_id ? {} : this.columnsOf(snap)), updated_at: this.now() });
      });
    } catch (err) {
      throw this.slugConflictArticle(err, snap.slug);
    }
    await this.audit({ action: 'content.help.article.update', actionLabel: 'Edited help article draft', target: { type: 'help_article', id, label: snap.title }, before: draftSnap ?? this.articleSnapOf(live), after: snap, reason: input.changeNote ?? null }, by);
    return this.articleAdmin(row);
  }

  private async setArticleDraftReview(a: ArticleRow, review: DraftReview | null) {
    const draft = a.draft_version_id ? await this.repo.getVersion(a.draft_version_id) : undefined;
    if (!draft) return;
    await this.repo.updateVersion(draft.id, { snapshot: { ...(draft.snapshot as unknown as ArticleSnap), _review: review } as never });
  }

  /** One action endpoint for the publication state machine on articles */
  async transitionHelpArticle(
    id: string,
    body: { action: 'submit' | 'approve' | 'requestChanges' | 'schedule' | 'cancelSchedule' | 'publish' | 'unpublish' | 'remove' | 'restore'; reason?: string | null; kind?: 'correction' | 'removal' | null; publishAt?: string | null; unpublishAt?: string | null },
    by: By,
  ): Promise<HelpArticleAdmin> {
    const a = await this.articleOrThrow(id);
    const status = a.status as Status;
    const review = (await this.reviewRequired()).article;
    const draft = a.draft_version_id ? await this.repo.getVersion(a.draft_version_id) : undefined;
    const draftReview = this.articleSnapOf(draft)?._review ?? null;
    const liveWithDraft = (status === 'published' || status === 'unpublished') && Boolean(draft);
    const illegal = (message: string) => new AppError('ILLEGAL_TRANSITION', message, { from: status, event: body.action, allowed: contentPublicationMachine.eventsFrom(status) });
    const now = this.now();
    const label = a.title;
    let event: string = body.action;

    switch (body.action) {
      case 'submit': {
        if (liveWithDraft) {
          if (draftReview) throw illegal('The draft is already in review');
          await this.setArticleDraftReview(a, { state: 'in_review', by: by.actor, at: now.toISOString() });
        } else await this.repo.updateArticle(id, { status: contentPublicationMachine.next(status, 'submit'), updated_at: now });
        break;
      }
      case 'approve':
      case 'requestChanges': {
        const approving = body.action === 'approve';
        if (!approving) requireText(body.reason, 'reason', 'Say what needs to change');
        if (approving && draft && draft.author_id && draft.author_id === by.actor.id) throw this.ctx.error('SAME_REVIEWER', 'The author cannot approve their own article.');
        if (status !== 'in_review' && draftReview?.state === 'in_review') await this.setArticleDraftReview(a, approving ? { state: 'approved', by: by.actor, at: now.toISOString() } : null);
        else await this.repo.updateArticle(id, { status: contentPublicationMachine.next(status, body.action), updated_at: now });
        break;
      }
      case 'schedule': {
        if (!body.publishAt) throw invalid('publishAt', 'Pick when the article goes live');
        const publishAt = new Date(body.publishAt);
        const unpublishAt = dateOrNull(body.unpublishAt);
        if (unpublishAt && unpublishAt <= publishAt) throw invalid('unpublishAt', 'The removal time must be after the publish time');
        if (review && status === 'draft') throw illegal('The article needs review before it is scheduled');
        await this.repo.updateArticle(id, { status: contentPublicationMachine.next(status, 'schedule'), publish_at: publishAt, unpublish_at: unpublishAt, updated_at: now });
        break;
      }
      case 'cancelSchedule':
        await this.repo.updateArticle(id, { status: contentPublicationMachine.next(status, 'cancelSchedule'), publish_at: null, unpublish_at: null, updated_at: now });
        break;
      case 'publish': {
        if (status === 'published') {
          if (!draft) throw illegal('The article is already live and has no new draft');
          if (review && draftReview?.state !== 'approved') throw illegal('The draft needs review before it goes live');
        } else {
          contentPublicationMachine.next(status, 'publish');
          if (review && status === 'draft') throw illegal('The article needs review before it is published');
          if (review && status === 'unpublished' && draft && draftReview?.state !== 'approved') throw illegal('The draft needs review before it goes live');
        }
        await this.articleLive(id, by, 'publish');
        return this.articleAdmin(await this.articleOrThrow(id));
      }
      case 'unpublish':
        await this.articleDown(id, body.reason ?? null, by);
        return this.articleAdmin(await this.articleOrThrow(id));
      case 'remove': {
        if (!body.kind) throw invalid('kind', 'Say whether this is a correction or a removal');
        const reason = requireText(body.reason, 'reason', 'A reason is required');
        await this.repo.updateArticle(id, { status: contentPublicationMachine.next(status, 'remove'), featured: false, ...(status === 'scheduled' ? { publish_at: null, unpublish_at: null } : {}), updated_at: now });
        this.ctx.events.publish('content.page.removed', { entity: 'article', entityId: id, kind: body.kind, reason }, { actor: by.actor, requestId: by.requestId });
        event = body.kind;
        break;
      }
      case 'restore':
        await this.repo.updateArticle(id, { status: contentPublicationMachine.next(status, 'restore'), updated_at: now });
        break;
    }
    await this.logAction('article', id, event, by, body.reason ?? (body.publishAt ? `${body.publishAt}${body.unpublishAt ? ` – ${body.unpublishAt}` : ''}` : null));
    await this.audit({ action: `content.help.article.${body.action}`, actionLabel: `Help article: ${body.action}`, target: { type: 'help_article', id, label }, reason: body.reason ?? null, before: { status }, after: { status: (await this.repo.getArticle(id))!.status } }, by);
    return this.articleAdmin(await this.articleOrThrow(id));
  }

  /** Publishes the draft (or the live version again); used by publish and the schedule job */
  protected async articleLive(id: string, by: By, why: 'publish' | 'scheduled'): Promise<ArticleRow> {
    const now = this.now();
    const days = await this.ctx.settings.get('articleReviewDays');
    const before = await this.articleOrThrow(id);
    const draft = before.draft_version_id ? await this.repo.getVersion(before.draft_version_id) : undefined;
    const snap = this.articleSnapOf(draft);
    if (snap) {
      const other = await this.repo.articleBySlug(snap.slug);
      if (other && other.id !== id) throw this.ctx.error('SLUG_TAKEN', `Another article uses ${snap.slug}`);
    }
    const row = await this.repo.transaction(async (tx: ContentRepository) => {
      const locked = (await tx.getArticle(id, { forUpdate: true }))!;
      let liveId = locked.live_version_id;
      let fields: Partial<ArticleRow> = {};
      if (locked.draft_version_id && snap) {
        const { _review, ...clean } = snap;
        void _review;
        if (locked.live_version_id) await tx.updateVersion(locked.live_version_id, { state: 'superseded' });
        await tx.updateVersion(locked.draft_version_id, { state: 'live', published_at: now, snapshot: clean as never });
        liveId = locked.draft_version_id;
        fields = { ...this.columnsOf(snap), featured: snap.featured, owner_staff_id: snap.ownerStaffId ?? locked.owner_staff_id };
        if (snap.featured) {
          // one featured guide per audience
          for (const f of await tx.listArticles({ featured: true, audiences: [snap.audience] })) if (f.id !== id) await tx.updateArticle(f.id, { featured: false });
        }
      }
      if (!liveId) throw invalid('draft', 'The article has nothing to publish');
      return tx.updateArticle(id, {
        ...fields,
        status: 'published',
        live_version_id: liveId,
        draft_version_id: null,
        publish_at: why === 'publish' ? null : locked.publish_at,
        unpublish_at: locked.unpublish_at && locked.unpublish_at <= now ? null : locked.unpublish_at,
        review_due_at: new Date(now.getTime() + days * 86_400_000),
        updated_at: now,
      });
    });
    const live = (await this.repo.getVersion(row.live_version_id!))!;
    const liveSnap = this.articleSnapOf(live)!;
    await this.repo.setArticleSearch(id, `${liveSnap.title} ${liveSnap.summary ?? ''} ${liveSnap.topics.join(' ')} ${plainText(liveSnap.body)}`);
    this.ctx.events.publish('content.article.published', { articleId: id, slug: row.slug, version: live.number }, { actor: by.actor, requestId: by.requestId });
    await this.logAction('article', id, why === 'publish' ? 'publish' : 'publish_scheduled', by);
    if (why === 'scheduled') await this.audit({ action: 'content.help.article.publish', actionLabel: 'Published scheduled help article', target: { type: 'help_article', id, label: row.title }, after: { version: live.number } }, by);
    return row;
  }

  protected async articleDown(id: string, reason: string | null, by: By): Promise<ArticleRow> {
    const a = await this.articleOrThrow(id);
    const status = contentPublicationMachine.next(a.status as Status, 'unpublish');
    const now = this.now();
    const row = await this.repo.updateArticle(id, { status, unpublish_at: a.unpublish_at && a.unpublish_at <= now ? null : a.unpublish_at, updated_at: now });
    await this.logAction('article', id, 'unpublish', by, reason);
    return row;
  }

  async restoreArticleVersion(id: string, number: number, body: { reason: string }, by: By): Promise<HelpArticleAdmin> {
    const reason = requireText(body.reason, 'reason', 'Say why the version is restored');
    const a = await this.articleOrThrow(id);
    const source = await this.repo.versionByNumber('article', id, number);
    if (!source) throw notFound('Version');
    if (a.status === 'in_review' || a.status === 'approved' || a.status === 'scheduled') throw new AppError('CONFLICT', 'Finish the review or cancel the schedule before restoring a version');
    const { _review, ...snap } = source.snapshot as unknown as ArticleSnap;
    void _review;
    const other = await this.repo.articleBySlug(snap.slug);
    if (other && other.id !== id) throw this.ctx.error('SLUG_TAKEN', `Another article uses ${snap.slug}`);
    const row = await this.repo.transaction(async (tx) => {
      const locked = (await tx.getArticle(id, { forUpdate: true }))!;
      if (locked.draft_version_id) await tx.updateVersion(locked.draft_version_id, { state: 'discarded' });
      const v = await tx.insertVersion(this.newVersionRow('article', id, (await tx.maxVersionNumber('article', id)) + 1, snap, by, { summary: `Restored version ${number}: ${reason}`, restored_from: number }));
      return tx.updateArticle(id, {
        draft_version_id: v.id,
        ...(locked.status === 'removed' ? { status: contentPublicationMachine.next('removed', 'restore') } : {}),
        ...(locked.live_version_id ? {} : this.columnsOf(snap)),
        updated_at: this.now(),
      });
    });
    await this.logAction('article', id, 'restore', by, reason);
    await this.audit({ action: 'content.help.article.restore-version', actionLabel: `Restored help article version ${number} as a new draft`, target: { type: 'help_article', id, label: row.title }, reason }, by);
    return this.articleAdmin(row);
  }

  /* ---------------------------------------------------------------- store */

  /** A published help article by slug */
  async getHelpArticle(slug: string): Promise<HelpArticle | null> {
    const a = await this.repo.articleBySlug(slug);
    if (!a || a.status !== 'published' || !a.live_version_id) return null;
    const live = await this.repo.getVersion(a.live_version_id);
    const snap = this.articleSnapOf(live);
    return snap ? this.articleView(a, snap, live) : null;
  }

  /** GET /help/articles/{slug}: the article, counted as a view */
  async viewHelpArticle(slug: string): Promise<HelpArticle> {
    const article = await this.getHelpArticle(slug);
    if (!article) throw notFound('Article');
    await this.repo.incrementViews(article.id).catch((err) => this.ctx.log.debug({ err }, 'content: view not counted'));
    return article;
  }

  async rateHelpArticle(id: string, body: { helpful: boolean; comment?: string | null }, who: { principal: Principal; requestId: string }): Promise<void> {
    const a = await this.repo.getArticle(id);
    if (!a || a.status !== 'published') throw notFound('Article');
    const p = who.principal;
    const visitorKey = p.kind === 'customer' && p.accountId ? `customer:${p.accountId}` : p.guestSessionId ? `guest:${p.guestSessionId}` : p.sessionId ? `session:${p.sessionId}` : `request:${who.requestId}`;
    const comment = body.comment ? plainText(body.comment).slice(0, 2000) || null : null;
    await this.repo.upsertFeedback({ id: newId(), article_id: id, helpful: body.helpful, comment, visitor_key: visitorKey, customer_id: p.kind === 'customer' ? (p.accountId ?? null) : null, at: this.now() });
  }

  async searchHelp(q: { q?: string; category?: string; audience?: 'customer' | 'seller' }, page: PageRequest): Promise<common.Page<HelpArticleSummary>> {
    let categoryId: string | undefined;
    if (q.category) {
      const c = await this.repo.categoryBySlug(q.category);
      if (!c || !c.visible) return pageOf([], page);
      categoryId = c.id;
    }
    const res = await this.repo.pageOfArticles({ statuses: ['published'], categoryId, audiences: q.audience ? [q.audience, 'both'] : undefined, q: q.q }, page);
    return { ...res, items: await this.summaries(res.items) };
  }

  protected async contactChannels(audience: 'customer' | 'seller'): Promise<ContactChannel[]> {
    const settingsApi = this.ctx.tryUse('settings');
    const info = await this.soft('settings.storeInfo', settingsApi && (() => settingsApi.storeInfo()), null);
    const hours = info?.support.hoursLabel ?? 'Mon–Sat, 8 AM–8 PM PT';
    const chatHours = info?.support.chatHoursLabel ?? hours;
    const phone = info?.support.phone ?? '';
    const channels: ContactChannel[] = [
      { kind: 'chat', label: 'Chat with us', hours: chatHours, detail: audience === 'seller' ? 'Seller support answers in Seller Center' : 'Typical reply in a few minutes', action: { label: 'Start chat', url: audience === 'seller' ? '/seller/help/contact?channel=chat' : '/help/contact?channel=chat', kind: 'help' } },
      { kind: 'message', label: 'Send a message', hours: 'Any time', detail: 'We reply within one business day', action: { label: 'Write to us', url: audience === 'seller' ? '/seller/help/contact' : '/help/contact', kind: 'help' } },
    ];
    if (phone) channels.splice(1, 0, { kind: 'phone', label: 'Call us', hours, detail: phone, action: { label: phone, url: `tel:${phone.replace(/[^\d+]/g, '')}`, kind: 'external' } });
    return channels;
  }

  async getHelpCenter(audience: 'customer' | 'seller' = 'customer'): Promise<HelpHome> {
    const aud = audience === 'seller' ? 'seller' : 'customer';
    const audiences = [aud, 'both'];
    const [cats, published] = await Promise.all([this.repo.listCategories(), this.repo.listArticles({ statuses: ['published'], audiences })]);
    const counts = new Map<string, number>();
    for (const a of published) counts.set(a.category_id, (counts.get(a.category_id) ?? 0) + 1);
    const topics = await Promise.all(
      cats
        .filter((c) => c.visible && audiences.includes(c.audience))
        .map(async (c) => ({ ...this.categoryOut(c, counts), topArticles: await this.summaries(published.filter((a) => a.category_id === c.id).slice(0, 4)) })),
    );
    const visibleCats = new Set(topics.map((t) => t.id));
    const inVisible = published.filter((a) => visibleCats.has(a.category_id));
    const featuredRow = inVisible.find((a) => a.featured && a.audience === aud) ?? inVisible.find((a) => a.featured);
    const featured = featuredRow ? await this.getHelpArticle(featuredRow.slug) : null;
    return {
      topics,
      popular: await this.summaries(inVisible.slice(0, 6)),
      popularSearches: inVisible
        .filter((a) => a.popular_search)
        .slice(0, 8)
        .map((a) => ({ label: a.popular_search!, url: `/help/articles/${a.slug}`, kind: 'help' as const })),
      featured,
      contact: await this.contactChannels(aud),
      sellerFirstNote: SELLER_FIRST_NOTE,
    };
  }

  /** Suggested articles for an order problem or case category (topics, then the topic's category, then text search) */
  async helpArticlesFor(topic: string, limit: number): Promise<HelpArticleSummary[]> {
    const t = String(topic ?? '').trim().toLowerCase();
    const n = Math.min(Math.max(Number(limit) || 3, 1), 20);
    if (!t) return [];
    const published = await this.repo.listArticles({ statuses: ['published'] });
    let hits = published.filter((a) => strings(a.topics).includes(t));
    if (hits.length < n) {
      const cat = await this.repo.categoryBySlug(t);
      if (cat) hits.push(...published.filter((a) => a.category_id === cat.id && !hits.includes(a)));
    }
    if (hits.length < n) {
      const words = t.replace(/[_-]+/g, ' ');
      const found = await this.repo.listArticles({ statuses: ['published'], q: words });
      hits.push(...found.filter((a) => !hits.some((h) => h.id === a.id)));
    }
    hits = hits.slice(0, n);
    return this.summaries(hits);
  }

  async countHelpArticlesForPolicy(policyKey: string): Promise<{ count: number; articleIds: string[] }> {
    const ids = (await this.repo.listArticles({ statuses: ['published'] })).filter((a) => strings(a.policy_keys).includes(policyKey)).map((a) => a.id);
    return { count: ids.length, articleIds: ids };
  }

  /* ---------------------------------------------------------------- jobs */

  protected async runArticleSchedules(): Promise<number> {
    const now = this.now();
    let n = 0;
    for (const a of await this.repo.articlesToPublish(now, 50)) {
      try {
        await this.articleLive(a.id, SYSTEM, 'scheduled');
        n++;
      } catch (err) {
        this.ctx.log.warn({ err, articleId: a.id }, 'content: scheduled article could not be published');
      }
    }
    for (const a of await this.repo.articlesToUnpublish(now, 50)) {
      try {
        await this.articleDown(a.id, 'Reached its removal time', SYSTEM);
        n++;
      } catch (err) {
        this.ctx.log.warn({ err, articleId: a.id }, 'content: article could not be taken down at its removal time');
      }
    }
    return n;
  }

  /**
   * Flags published articles past their review date and publishes content.article.review_due (notifications tells
   * the owner), once per article and due date: the inbox key commits with the flag in the publication log.
   * Publishing a new version is the review: it sets the next due date, so the next period is flagged again.
   */
  async articleReviewDue(): Promise<number> {
    const now = this.now();
    const due = await this.repo.listArticles({ statuses: ['published'], reviewDueBefore: now });
    let sent = 0;
    for (const a of due) {
      if (!a.review_due_at) continue;
      const dueSince = a.review_due_at;
      const claimed = await this.repo.transaction(async (tx) => {
        if (!(await tx.claim(`article-review-due:${a.id}:${dueSince.toISOString()}`))) return false;
        await this.logAction('article', a.id, 'review_due', SYSTEM, dueSince.toISOString().slice(0, 10), tx);
        return true;
      });
      if (!claimed) continue;
      // the live version's publication is the last review (it set this due date)
      const live = a.live_version_id ? await this.repo.getVersion(a.live_version_id) : undefined;
      this.ctx.events.publish(
        'content.article.review_due',
        { articleId: a.id, slug: a.slug, title: a.title, ownerStaffId: a.owner_staff_id, lastReviewedAt: live?.published_at?.toISOString() ?? null, dueSince: dueSince.toISOString() },
        { actor: SYSTEM.actor },
      );
      sent++;
    }
    return sent;
  }
}

export { HELPFUL_WINDOW_DAYS };
