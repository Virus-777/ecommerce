import { orThrow } from '../../kernel/lib/or-throw.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import { escapeRegExp } from '../../kernel/lib/text.js';
import { contains, type Filter, type ModuleStore } from '../../kernel/mongo/index.js';
import type { ArticleFilter, ArticleRow, CategoryRow, FeedbackRow, FeedbackStat, LogRow, NavigationRow, PageFilter, PageRow, PolicyApprovalRow, PolicyRow, PolicyVersionRow, SectionRow, VersionEntity, VersionRow } from './ports.js';

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...values] });

/** English stop words, dropped from a help search query */
const STOP_WORDS = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below between both but by can did do does doing down ' +
    'during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most ' +
    'my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them ' +
    'themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you ' +
    'your yours yourself yourselves'
  ).split(' '),
);

/** A rough English stem (returns → return, deliveries → deliver, shipped → ship) matched at the start of a word */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3);
  else if (w.length > 4 && /(sh|ch|x|ss|zz)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  // shipp → ship
  if (w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz|ff)$/.test(w)) w = w.slice(0, -1);
  return w;
}

/**
 * The help search on the article's live text: every word of
 * the query that is not a stop word appears in the text, compared by a rough stem at the start of a word. A query of
 * stop words only matches nothing through the text (title and summary still match).
 */
function liveTextMatches(q: string): Filter | undefined {
  const words = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP_WORDS.has(w)))];
  if (!words.length) return undefined;
  return { $and: words.map((w) => ({ search: { $regex: `(^|[^a-z0-9])${escapeRegExp(stem(w))}`, $options: 'i' } })) };
}

/** The content module's collections (MongoDB, docs/04-mongodb-migration.md): one per spec table. */
export class ContentRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      sections: this.store.table<SectionRow>('home_sections'),
      pages: this.store.table<PageRow>('pages'),
      versions: this.store.table<VersionRow>('versions'),
      categories: this.store.table<CategoryRow>('help_categories'),
      articles: this.store.table<ArticleRow>('help_articles'),
      feedback: this.store.table<FeedbackRow>('article_feedback'),
      policies: this.store.table<PolicyRow>('policies'),
      policyVersions: this.store.table<PolicyVersionRow>('policy_versions'),
      approvals: this.store.table<PolicyApprovalRow>('policy_approvals'),
      navigation: this.store.table<NavigationRow>('navigation'),
      log: this.store.table<LogRow>('content_log'),
    };
  }

  /** Runs fn in one transaction; fn receives a repository bound to it (nested calls reuse it) */
  transaction<T>(fn: (tx: ContentRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new ContentRepository(tx)));
  }

  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean> {
    return this.store.claim(key);
  }

  /* ================================================================ sections */
  listSections(): Promise<SectionRow[]> {
    return this.#t.sections.find({}, { sort: { draft_position: 1, id: 1 } });
  }

  getSection(id: string, opts?: { forUpdate?: boolean }): Promise<SectionRow | undefined> {
    return this.#t.sections.get(id, opts);
  }

  insertSection(row: SectionRow): Promise<SectionRow> {
    return this.#t.sections.insert(row);
  }

  async updateSection(id: string, patch: Partial<SectionRow>): Promise<SectionRow> {
    return orThrow(await this.#t.sections.update(id, patch), `section ${id}`);
  }

  async deleteSection(id: string): Promise<void> {
    await this.#t.sections.delete(id);
  }

  /* ================================================================ versions */
  insertVersion(row: VersionRow): Promise<VersionRow> {
    return this.#t.versions.insert(row);
  }

  async updateVersion(id: string, patch: Partial<VersionRow>): Promise<VersionRow> {
    return orThrow(await this.#t.versions.update(id, patch), `version ${id}`);
  }

  getVersion(id: string): Promise<VersionRow | undefined> {
    return this.#t.versions.get(id);
  }

  async getVersions(ids: string[]): Promise<VersionRow[]> {
    return (ids.length ? this.#t.versions.getMany([...new Set(ids)]) : []);
  }

  versionByNumber(entity: VersionEntity, entityId: string, number: number): Promise<VersionRow | undefined> {
    return this.#t.versions.findOne({ entity, entity_id: entityId, number });
  }

  /** Newest first */
  versionsOf(entity: VersionEntity, entityId: string, states?: string[]): Promise<VersionRow[]> {
    return this.#t.versions.find({ entity, entity_id: entityId, ...(states?.length ? { state: oneOf(states) } : {}) }, { sort: { number: -1 } });
  }

  async maxVersionNumber(entity: VersionEntity, entityId: string): Promise<number> {
    return (await this.#t.versions.findOne({ entity, entity_id: entityId }, { sort: { number: -1 } }))?.number ?? 0;
  }

  pageOfVersions(entity: VersionEntity, entityId: string, page: PageRequest): Promise<Page<VersionRow>> {
    return this.#t.versions.page({ entity, entity_id: entityId }, page, { column: 'number', direction: 'desc' });
  }

  /* ================================================================ pages */
  getPage(id: string, opts?: { forUpdate?: boolean }): Promise<PageRow | undefined> {
    return this.#t.pages.get(id, opts);
  }

  async getPages(ids: string[]): Promise<PageRow[]> {
    return (ids.length ? this.#t.pages.getMany([...new Set(ids)]) : []);
  }

  pageBySlug(slug: string): Promise<PageRow | undefined> {
    return this.#t.pages.findOne({ slug });
  }

  insertPage(row: PageRow): Promise<PageRow> {
    return this.#t.pages.insert(row);
  }

  async updatePage(id: string, patch: Partial<PageRow>): Promise<PageRow> {
    return orThrow(await this.#t.pages.update(id, patch), `page ${id}`);
  }

  listPages(f: PageFilter): Promise<PageRow[]> {
    return this.#t.pages.find(this.#pageFilter(f), { sort: { updated_at: -1, id: 1 } });
  }

  pageOfPages(f: PageFilter, page: PageRequest): Promise<Page<PageRow>> {
    return this.#t.pages.page(this.#pageFilter(f), page, { column: 'updated_at', direction: 'desc' });
  }

  pagesToPublish(now: Date, limit: number): Promise<PageRow[]> {
    return this.#t.pages.find({ status: 'scheduled', publish_at: { $lte: now } }, { sort: { publish_at: 1 }, limit });
  }

  pagesToUnpublish(now: Date, limit: number): Promise<PageRow[]> {
    return this.#t.pages.find({ status: 'published', unpublish_at: { $lte: now } }, { sort: { unpublish_at: 1 }, limit });
  }

  /* ================================================================ help */
  listCategories(): Promise<CategoryRow[]> {
    return this.#t.categories.find({}, { sort: { position: 1, name: 1 } });
  }

  getCategory(id: string): Promise<CategoryRow | undefined> {
    return this.#t.categories.get(id);
  }

  categoryBySlug(slug: string): Promise<CategoryRow | undefined> {
    return this.#t.categories.findOne({ slug });
  }

  insertCategory(row: CategoryRow): Promise<CategoryRow> {
    return this.#t.categories.insert(row);
  }

  async updateCategory(id: string, patch: Partial<CategoryRow>): Promise<CategoryRow> {
    return orThrow(await this.#t.categories.update(id, patch), `category ${id}`);
  }

  getArticle(id: string, opts?: { forUpdate?: boolean }): Promise<ArticleRow | undefined> {
    return this.#t.articles.get(id, opts);
  }

  articleBySlug(slug: string): Promise<ArticleRow | undefined> {
    return this.#t.articles.findOne({ slug });
  }

  insertArticle(row: ArticleRow): Promise<ArticleRow> {
    return this.#t.articles.insert(row);
  }

  async updateArticle(id: string, patch: Partial<ArticleRow>): Promise<ArticleRow> {
    return orThrow(await this.#t.articles.update(id, patch), `article ${id}`);
  }

  listArticles(f: ArticleFilter): Promise<ArticleRow[]> {
    return this.#t.articles.find(this.#articleFilter(f), { sort: { views: -1, title: 1 } });
  }

  /** Published-article search (title, summary and the live text), most viewed first */
  pageOfArticles(f: ArticleFilter, page: PageRequest): Promise<Page<ArticleRow>> {
    return this.#t.articles.page(this.#articleFilter(f), page, { column: 'views', direction: 'desc' });
  }

  articlesToPublish(now: Date, limit: number): Promise<ArticleRow[]> {
    return this.#t.articles.find({ status: 'scheduled', publish_at: { $lte: now } }, { sort: { publish_at: 1 }, limit });
  }

  articlesToUnpublish(now: Date, limit: number): Promise<ArticleRow[]> {
    return this.#t.articles.find({ status: 'published', unpublish_at: { $lte: now } }, { sort: { unpublish_at: 1 }, limit });
  }

  /** Rebuilds the search vector from the live text */
  async setArticleSearch(id: string, text: string): Promise<void> {
    await this.#t.articles.update(id, { search: text });
  }

  async incrementViews(id: string): Promise<void> {
    await this.#t.articles.update(id, { $inc: { views: 1 } });
  }

  /** One answer per visitor and article (a second answer replaces the first) */
  async upsertFeedback(row: FeedbackRow): Promise<void> {
    await this.#t.feedback.upsert(row, { key: ['article_id', 'visitor_key'], update: { helpful: row.helpful, comment: row.comment, customer_id: row.customer_id, at: row.at } });
  }

  async feedbackStats(articleIds: string[] | null, since?: Date): Promise<FeedbackStat[]> {
    if (articleIds && !articleIds.length) return [];
    const rows = await this.#t.feedback.aggregate<{ _id: string; helpful: number; total: number }>([
      { $match: this.#t.feedback.filter({ ...(articleIds ? { article_id: oneOf(articleIds) } : {}), ...(since ? { at: { $gte: since } } : {}) }) },
      { $group: { _id: '$article_id', helpful: { $sum: { $cond: ['$helpful', 1, 0] } }, total: { $sum: 1 } } },
    ]);
    return rows.map((r) => ({ article_id: r._id, helpful: r.helpful, total: r.total }));
  }

  /* ================================================================ policies */
  listPolicies(): Promise<PolicyRow[]> {
    return this.#t.policies.find({}, { sort: { title: 1 } });
  }

  getPolicy(id: string): Promise<PolicyRow | undefined> {
    return this.#t.policies.get(id);
  }

  policyByKey(key: string): Promise<PolicyRow | undefined> {
    return this.#t.policies.findOne({ key });
  }

  insertPolicy(row: PolicyRow): Promise<PolicyRow> {
    return this.#t.policies.insert(row);
  }

  getPolicyVersion(id: string, opts?: { forUpdate?: boolean }): Promise<PolicyVersionRow | undefined> {
    return this.#t.policyVersions.get(id, opts);
  }

  /** All versions of these policies, oldest first */
  async policyVersionsOf(policyIds: string[]): Promise<PolicyVersionRow[]> {
    return (policyIds.length ? this.#t.policyVersions.find({ policy_id: oneOf([...new Set(policyIds)]) }, { sort: { created_at: 1, id: 1 } }) : []);
  }

  insertPolicyVersion(row: PolicyVersionRow): Promise<PolicyVersionRow> {
    return this.#t.policyVersions.insert(row);
  }

  async updatePolicyVersion(id: string, patch: Partial<PolicyVersionRow>): Promise<PolicyVersionRow> {
    return orThrow(await this.#t.policyVersions.update(id, patch), `policy version ${id}`);
  }

  /** Scheduled versions whose effective date has passed, earliest first */
  policyVersionsDue(now: Date, limit: number): Promise<PolicyVersionRow[]> {
    return this.#t.policyVersions.find({ state: 'scheduled', effective_at: { $lte: now } }, { sort: { effective_at: 1, created_at: 1 }, limit });
  }

  policyVersionByApproval(requestId: string): Promise<PolicyVersionRow | undefined> {
    return this.#t.policyVersions.findOne({ approval_request_id: requestId });
  }

  async approvalsOf(versionIds: string[]): Promise<PolicyApprovalRow[]> {
    return (versionIds.length ? this.#t.approvals.find({ policy_version_id: oneOf([...new Set(versionIds)]) }, { sort: { id: 1 } }) : []);
  }

  async insertApproval(row: PolicyApprovalRow): Promise<void> {
    await this.#t.approvals.insert(row);
  }

  async updateApproval(id: string, patch: Partial<PolicyApprovalRow>): Promise<void> {
    await this.#t.approvals.update(id, patch);
  }

  async deleteApprovals(versionId: string): Promise<void> {
    await this.#t.approvals.deleteMany({ policy_version_id: versionId });
  }

  /* ================================================================ navigation and log */
  listNavigation(): Promise<NavigationRow[]> {
    return this.#t.navigation.find({}, { sort: { area: 1, position: 1 } });
  }

  async replaceNavigation(rows: NavigationRow[]): Promise<void> {
    await this.#t.navigation.deleteMany({});
    await this.#t.navigation.insertMany(rows);
  }

  async log(row: LogRow): Promise<void> {
    await this.#t.log.insert(row);
  }

  logsOf(entity: string, entityId: string, action?: string): Promise<LogRow[]> {
    return this.#t.log.find({ entity, entity_id: entityId, ...(action ? { action } : {}) }, { sort: { at: -1 } });
  }

  #pageFilter(f: PageFilter): Filter {
    const q = f.q?.trim();
    return {
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.statuses?.length ? { status: oneOf(f.statuses) } : {}),
      ...(f.brandId ? { brand_id: f.brandId } : {}),
      ...(f.collectionKind ? { collection_kind: f.collectionKind } : {}),
      ...(f.linkedPromotionId ? { linked_promotion_id: f.linkedPromotionId } : {}),
      ...(q ? { $or: [{ title: contains(q) }, { slug: contains(q) }] } : {}),
    };
  }

  #articleFilter(f: ArticleFilter): Filter {
    const q = f.q?.trim();
    const text = q ? liveTextMatches(q) : undefined;
    return {
      ...(f.statuses?.length ? { status: oneOf(f.statuses) } : {}),
      ...(f.categoryId ? { category_id: f.categoryId } : {}),
      ...(f.audiences?.length ? { audience: oneOf(f.audiences) } : {}),
      ...(f.featured !== undefined ? { featured: f.featured } : {}),
      ...(f.ids ? { id: oneOf(f.ids) } : {}),
      ...(f.reviewDueBefore ? { review_due_at: { $lte: f.reviewDueBefore } } : {}),
      ...(q ? { $or: [{ title: contains(q) }, { summary: contains(q) }, ...(text ? [text] : [])] } : {}),
    };
  }
}
