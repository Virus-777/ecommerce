import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { Filter } from '../../kernel/mongo/table.js';
import type {
  ArticleFilter,
  ArticleRow,
  CategoryRow,
  ContentRepository,
  FeedbackRow,
  FeedbackStat,
  LogRow,
  NavigationRow,
  PageFilter,
  PageRow,
  PolicyApprovalRow,
  PolicyRow,
  PolicyVersionRow,
  SectionRow,
  VersionRow,
} from './ports.js';

/** One of `values`, or nothing when the list is empty (an empty IN matches no row) */
const oneOf = (values: readonly unknown[]) => ({ $in: [...values] });
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** SQL `ilike '%x%'` with the user's text taken literally */
const contains = (x: string) => ({ $regex: escapeRegExp(x), $options: 'i' });

function found<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`content: ${what} not found`);
  return row;
}

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

/** MongoDB adapter for ContentRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoContentRepository(store: ModuleStore): ContentRepository {
  const t = {
    sections: store.table<SectionRow>('home_sections'),
    pages: store.table<PageRow>('pages'),
    versions: store.table<VersionRow>('versions'),
    categories: store.table<CategoryRow>('help_categories'),
    articles: store.table<ArticleRow>('help_articles'),
    feedback: store.table<FeedbackRow>('article_feedback'),
    policies: store.table<PolicyRow>('policies'),
    policyVersions: store.table<PolicyVersionRow>('policy_versions'),
    approvals: store.table<PolicyApprovalRow>('policy_approvals'),
    navigation: store.table<NavigationRow>('navigation'),
    log: store.table<LogRow>('content_log'),
  };

  const pageFilter = (f: PageFilter): Filter => {
    const q = f.q?.trim();
    return {
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.statuses?.length ? { status: oneOf(f.statuses) } : {}),
      ...(f.brandId ? { brand_id: f.brandId } : {}),
      ...(f.collectionKind ? { collection_kind: f.collectionKind } : {}),
      ...(f.linkedPromotionId ? { linked_promotion_id: f.linkedPromotionId } : {}),
      ...(q ? { $or: [{ title: contains(q) }, { slug: contains(q) }] } : {}),
    };
  };

  const articleFilter = (f: ArticleFilter): Filter => {
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
  };

  const repo: ContentRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoContentRepository(tx))),
    claim: (key) => store.claim(key),

    /* ================================================================ sections */
    listSections: () => t.sections.find({}, { sort: { draft_position: 1, id: 1 } }),
    getSection: (id, opts) => t.sections.get(id, opts),
    insertSection: (row) => t.sections.insert(row),
    updateSection: async (id, patch) => found(await t.sections.update(id, patch), `section ${id}`),
    async deleteSection(id) {
      await t.sections.delete(id);
    },

    /* ================================================================ versions */
    insertVersion: (row) => t.versions.insert(row),
    updateVersion: async (id, patch) => found(await t.versions.update(id, patch), `version ${id}`),
    getVersion: (id) => t.versions.get(id),
    getVersions: async (ids) => (ids.length ? t.versions.getMany([...new Set(ids)]) : []),
    versionByNumber: (entity, entityId, number) => t.versions.findOne({ entity, entity_id: entityId, number }),
    versionsOf: (entity, entityId, states) =>
      t.versions.find({ entity, entity_id: entityId, ...(states?.length ? { state: oneOf(states) } : {}) }, { sort: { number: -1 } }),
    async maxVersionNumber(entity, entityId) {
      return (await t.versions.findOne({ entity, entity_id: entityId }, { sort: { number: -1 } }))?.number ?? 0;
    },
    pageOfVersions: (entity, entityId, page) => t.versions.page({ entity, entity_id: entityId }, page, { column: 'number', direction: 'desc' }),

    /* ================================================================ pages */
    getPage: (id, opts) => t.pages.get(id, opts),
    getPages: async (ids) => (ids.length ? t.pages.getMany([...new Set(ids)]) : []),
    pageBySlug: (slug) => t.pages.findOne({ slug }),
    insertPage: (row) => t.pages.insert(row),
    updatePage: async (id, patch) => found(await t.pages.update(id, patch), `page ${id}`),
    listPages: (f) => t.pages.find(pageFilter(f), { sort: { updated_at: -1, id: 1 } }),
    pageOfPages: (f, page) => t.pages.page(pageFilter(f), page, { column: 'updated_at', direction: 'desc' }),
    pagesToPublish: (now, limit) => t.pages.find({ status: 'scheduled', publish_at: { $lte: now } }, { sort: { publish_at: 1 }, limit }),
    pagesToUnpublish: (now, limit) => t.pages.find({ status: 'published', unpublish_at: { $lte: now } }, { sort: { unpublish_at: 1 }, limit }),

    /* ================================================================ help */
    listCategories: () => t.categories.find({}, { sort: { position: 1, name: 1 } }),
    getCategory: (id) => t.categories.get(id),
    categoryBySlug: (slug) => t.categories.findOne({ slug }),
    insertCategory: (row) => t.categories.insert(row),
    updateCategory: async (id, patch) => found(await t.categories.update(id, patch), `category ${id}`),
    getArticle: (id, opts) => t.articles.get(id, opts),
    articleBySlug: (slug) => t.articles.findOne({ slug }),
    insertArticle: (row) => t.articles.insert(row),
    updateArticle: async (id, patch) => found(await t.articles.update(id, patch), `article ${id}`),
    listArticles: (f) => t.articles.find(articleFilter(f), { sort: { views: -1, title: 1 } }),
    pageOfArticles: (f, page) => t.articles.page(articleFilter(f), page, { column: 'views', direction: 'desc' }),
    articlesToPublish: (now, limit) => t.articles.find({ status: 'scheduled', publish_at: { $lte: now } }, { sort: { publish_at: 1 }, limit }),
    articlesToUnpublish: (now, limit) => t.articles.find({ status: 'published', unpublish_at: { $lte: now } }, { sort: { unpublish_at: 1 }, limit }),
    async setArticleSearch(id, text) {
      await t.articles.update(id, { search: text });
    },
    async incrementViews(id) {
      await t.articles.update(id, { $inc: { views: 1 } });
    },
    async upsertFeedback(row) {
      await t.feedback.upsert(row, { key: ['article_id', 'visitor_key'], update: { helpful: row.helpful, comment: row.comment, customer_id: row.customer_id, at: row.at } });
    },
    async feedbackStats(articleIds, since): Promise<FeedbackStat[]> {
      if (articleIds && !articleIds.length) return [];
      const rows = await t.feedback.aggregate<{ _id: string; helpful: number; total: number }>([
        { $match: t.feedback.filter({ ...(articleIds ? { article_id: oneOf(articleIds) } : {}), ...(since ? { at: { $gte: since } } : {}) }) },
        { $group: { _id: '$article_id', helpful: { $sum: { $cond: ['$helpful', 1, 0] } }, total: { $sum: 1 } } },
      ]);
      return rows.map((r) => ({ article_id: r._id, helpful: r.helpful, total: r.total }));
    },

    /* ================================================================ policies */
    listPolicies: () => t.policies.find({}, { sort: { title: 1 } }),
    getPolicy: (id) => t.policies.get(id),
    policyByKey: (key) => t.policies.findOne({ key }),
    insertPolicy: (row) => t.policies.insert(row),
    getPolicyVersion: (id, opts) => t.policyVersions.get(id, opts),
    policyVersionsOf: async (policyIds) => (policyIds.length ? t.policyVersions.find({ policy_id: oneOf([...new Set(policyIds)]) }, { sort: { created_at: 1, id: 1 } }) : []),
    insertPolicyVersion: (row) => t.policyVersions.insert(row),
    updatePolicyVersion: async (id, patch) => found(await t.policyVersions.update(id, patch), `policy version ${id}`),
    policyVersionsDue: (now, limit) => t.policyVersions.find({ state: 'scheduled', effective_at: { $lte: now } }, { sort: { effective_at: 1, created_at: 1 }, limit }),
    policyVersionByApproval: (requestId) => t.policyVersions.findOne({ approval_request_id: requestId }),
    approvalsOf: async (versionIds) => (versionIds.length ? t.approvals.find({ policy_version_id: oneOf([...new Set(versionIds)]) }, { sort: { id: 1 } }) : []),
    async insertApproval(row) {
      await t.approvals.insert(row);
    },
    async updateApproval(id, patch) {
      await t.approvals.update(id, patch);
    },
    async deleteApprovals(versionId) {
      await t.approvals.deleteMany({ policy_version_id: versionId });
    },

    /* ================================================================ navigation and log */
    listNavigation: () => t.navigation.find({}, { sort: { area: 1, position: 1 } }),
    async replaceNavigation(rows) {
      await t.navigation.deleteMany({});
      await t.navigation.insertMany(rows);
    },
    async log(row) {
      await t.log.insert(row);
    },
    logsOf: (entity, entityId, action) => t.log.find({ entity, entity_id: entityId, ...(action ? { action } : {}) }, { sort: { at: -1 } }),
  };
  return repo;
}
