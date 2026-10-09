import { sql, type Kysely } from 'kysely';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { ContentDb } from '../../../../spec/content.js';
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
  VersionEntity,
  VersionRow,
} from '../../ports.js';

type Db = Kysely<ContentDb>;

/** jsonb columns are written as JSON text (arrays would otherwise be sent as PostgreSQL arrays) */
const JSON_COLUMNS: Partial<Record<keyof ContentDb, readonly string[]>> = {
  home_sections: ['config'],
  pages: ['removal'],
  versions: ['snapshot'],
  help_articles: ['topics', 'related_ids', 'policy_keys'],
  policy_versions: ['tables'],
};

function enc(table: keyof ContentDb, row: object): any {
  const cols = JSON_COLUMNS[table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = cols.includes(k) && v !== null ? JSON.stringify(v) : v;
  }
  return out;
}

/** ILIKE pattern with the user's text taken literally */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Postgres adapter for ContentRepository. `db` is scoped to the `content` schema. */
export function createPostgresContentRepository(db: Db): ContentRepository {
  return new PgContentRepository(db);
}

class PgContentRepository implements ContentRepository {
  constructor(private readonly db: Db) {}

  async transaction<T>(fn: (tx: ContentRepository) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return fn(this);
    return this.db.transaction().execute((trx) => fn(new PgContentRepository(trx)));
  }

  /* ================================================================ sections */

  async listSections() {
    return this.db.selectFrom('home_sections').selectAll().orderBy('draft_position').orderBy('id').execute();
  }

  async getSection(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db.selectFrom('home_sections').selectAll().where('id', '=', id);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async insertSection(row: SectionRow) {
    return this.db.insertInto('home_sections').values(enc('home_sections', row)).returningAll().executeTakeFirstOrThrow();
  }

  async updateSection(id: string, patch: Partial<SectionRow>) {
    return this.db.updateTable('home_sections').set(enc('home_sections', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }

  async deleteSection(id: string) {
    await this.db.deleteFrom('home_sections').where('id', '=', id).execute();
  }

  /* ================================================================ versions */

  async insertVersion(row: VersionRow) {
    return this.db.insertInto('versions').values(enc('versions', row)).returningAll().executeTakeFirstOrThrow();
  }

  async updateVersion(id: string, patch: Partial<VersionRow>) {
    return this.db.updateTable('versions').set(enc('versions', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }

  async getVersion(id: string) {
    return this.db.selectFrom('versions').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async getVersions(ids: string[]) {
    if (!ids.length) return [];
    return this.db.selectFrom('versions').selectAll().where('id', 'in', [...new Set(ids)]).execute();
  }

  async versionByNumber(entity: VersionEntity, entityId: string, number: number) {
    return this.db.selectFrom('versions').selectAll().where('entity', '=', entity).where('entity_id', '=', entityId).where('number', '=', number).executeTakeFirst();
  }

  async versionsOf(entity: VersionEntity, entityId: string, states?: string[]) {
    let q = this.db.selectFrom('versions').selectAll().where('entity', '=', entity).where('entity_id', '=', entityId);
    if (states?.length) q = q.where('state', 'in', states);
    return q.orderBy('number', 'desc').execute();
  }

  async maxVersionNumber(entity: VersionEntity, entityId: string) {
    const r = await this.db
      .selectFrom('versions')
      .select(sql<number>`coalesce(max(number), 0)::int`.as('n'))
      .where('entity', '=', entity)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    return r?.n ?? 0;
  }

  async pageOfVersions(entity: VersionEntity, entityId: string, page: PageRequest) {
    const q = this.db.selectFrom('versions').selectAll().where('entity', '=', entity).where('entity_id', '=', entityId);
    return paginate(q, page, { column: 'number', direction: 'desc' });
  }

  /* ================================================================ pages */

  async getPage(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db.selectFrom('pages').selectAll().where('id', '=', id);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async getPages(ids: string[]) {
    if (!ids.length) return [];
    return this.db.selectFrom('pages').selectAll().where('id', 'in', [...new Set(ids)]).execute();
  }

  async pageBySlug(slug: string) {
    return this.db.selectFrom('pages').selectAll().where('slug', '=', slug).executeTakeFirst();
  }

  async insertPage(row: PageRow) {
    return this.db.insertInto('pages').values(enc('pages', row)).returningAll().executeTakeFirstOrThrow();
  }

  async updatePage(id: string, patch: Partial<PageRow>) {
    return this.db.updateTable('pages').set(enc('pages', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }

  private pageQuery(f: PageFilter) {
    let q = this.db.selectFrom('pages').selectAll();
    if (f.kind) q = q.where('kind', '=', f.kind);
    if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
    if (f.brandId) q = q.where('brand_id', '=', f.brandId);
    if (f.collectionKind) q = q.where('collection_kind', '=', f.collectionKind);
    if (f.linkedPromotionId) q = q.where('linked_promotion_id', '=', f.linkedPromotionId);
    if (f.q?.trim()) {
      const p = contains(f.q.trim());
      q = q.where((eb) => eb.or([eb('title', 'ilike', p), eb('slug', 'ilike', p)]));
    }
    return q;
  }

  async listPages(filter: PageFilter) {
    return this.pageQuery(filter).orderBy('updated_at', 'desc').orderBy('id').execute();
  }

  async pageOfPages(filter: PageFilter, page: PageRequest) {
    return paginate(this.pageQuery(filter), page, { column: 'updated_at', direction: 'desc' });
  }

  async pagesToPublish(now: Date, limit: number) {
    return this.db.selectFrom('pages').selectAll().where('status', '=', 'scheduled').where('publish_at', '<=', now).orderBy('publish_at').limit(limit).execute();
  }

  async pagesToUnpublish(now: Date, limit: number) {
    return this.db.selectFrom('pages').selectAll().where('status', '=', 'published').where('unpublish_at', '<=', now).orderBy('unpublish_at').limit(limit).execute();
  }

  /* ================================================================ help */

  async listCategories() {
    return this.db.selectFrom('help_categories').selectAll().orderBy('position').orderBy('name').execute();
  }

  async getCategory(id: string) {
    return this.db.selectFrom('help_categories').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async categoryBySlug(slug: string) {
    return this.db.selectFrom('help_categories').selectAll().where('slug', '=', slug).executeTakeFirst();
  }

  async insertCategory(row: CategoryRow) {
    return this.db.insertInto('help_categories').values(row).returningAll().executeTakeFirstOrThrow();
  }

  async updateCategory(id: string, patch: Partial<CategoryRow>) {
    return this.db.updateTable('help_categories').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }

  async getArticle(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db.selectFrom('help_articles').selectAll().where('id', '=', id);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async articleBySlug(slug: string) {
    return this.db.selectFrom('help_articles').selectAll().where('slug', '=', slug).executeTakeFirst();
  }

  async insertArticle(row: ArticleRow) {
    return this.db.insertInto('help_articles').values(enc('help_articles', row)).returningAll().executeTakeFirstOrThrow();
  }

  async updateArticle(id: string, patch: Partial<ArticleRow>) {
    return this.db.updateTable('help_articles').set(enc('help_articles', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }

  private articleQuery(f: ArticleFilter) {
    let q = this.db.selectFrom('help_articles').selectAll();
    if (f.statuses?.length) q = q.where('status', 'in', f.statuses);
    if (f.categoryId) q = q.where('category_id', '=', f.categoryId);
    if (f.audiences?.length) q = q.where('audience', 'in', f.audiences);
    if (f.featured !== undefined) q = q.where('featured', '=', f.featured);
    if (f.ids) q = f.ids.length ? q.where('id', 'in', f.ids) : q.where(sql<boolean>`false`);
    if (f.reviewDueBefore) q = q.where('review_due_at', '<=', f.reviewDueBefore);
    if (f.q?.trim()) {
      const text = f.q.trim();
      const p = contains(text);
      q = q.where((eb) => eb.or([eb('title', 'ilike', p), eb('summary', 'ilike', p), sql<boolean>`search @@ plainto_tsquery('english', ${text})`]));
    }
    return q;
  }

  async listArticles(filter: ArticleFilter) {
    return this.articleQuery(filter).orderBy('views', 'desc').orderBy('title').execute();
  }

  async pageOfArticles(filter: ArticleFilter, page: PageRequest) {
    return paginate(this.articleQuery(filter), page, { column: 'views', direction: 'desc' });
  }

  async articlesToPublish(now: Date, limit: number) {
    return this.db.selectFrom('help_articles').selectAll().where('status', '=', 'scheduled').where('publish_at', '<=', now).orderBy('publish_at').limit(limit).execute();
  }

  async articlesToUnpublish(now: Date, limit: number) {
    return this.db.selectFrom('help_articles').selectAll().where('status', '=', 'published').where('unpublish_at', '<=', now).orderBy('unpublish_at').limit(limit).execute();
  }

  async setArticleSearch(id: string, text: string) {
    await this.db
      .updateTable('help_articles')
      .set({ search: sql`to_tsvector('english', ${text})` as never })
      .where('id', '=', id)
      .execute();
  }

  async incrementViews(id: string) {
    await this.db
      .updateTable('help_articles')
      .set({ views: sql`views + 1` as never })
      .where('id', '=', id)
      .execute();
  }

  async upsertFeedback(row: FeedbackRow) {
    await this.db
      .insertInto('article_feedback')
      .values(row)
      .onConflict((oc) => oc.columns(['article_id', 'visitor_key']).doUpdateSet({ helpful: row.helpful, comment: row.comment, customer_id: row.customer_id, at: row.at }))
      .execute();
  }

  async feedbackStats(articleIds: string[] | null, since?: Date): Promise<FeedbackStat[]> {
    let q = this.db
      .selectFrom('article_feedback')
      .select(['article_id', sql<number>`count(*) filter (where helpful)::int`.as('helpful'), sql<number>`count(*)::int`.as('total')])
      .groupBy('article_id');
    if (articleIds) {
      if (!articleIds.length) return [];
      q = q.where('article_id', 'in', articleIds);
    }
    if (since) q = q.where('at', '>=', since);
    return q.execute();
  }

  /* ================================================================ policies */

  async listPolicies() {
    return this.db.selectFrom('policies').selectAll().orderBy('title').execute();
  }

  async getPolicy(id: string) {
    return this.db.selectFrom('policies').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async policyByKey(key: string) {
    return this.db.selectFrom('policies').selectAll().where('key', '=', key).executeTakeFirst();
  }

  async insertPolicy(row: PolicyRow) {
    return this.db.insertInto('policies').values(row).returningAll().executeTakeFirstOrThrow();
  }

  async getPolicyVersion(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db.selectFrom('policy_versions').selectAll().where('id', '=', id);
    if (opts.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async policyVersionsOf(policyIds: string[]) {
    if (!policyIds.length) return [];
    return this.db.selectFrom('policy_versions').selectAll().where('policy_id', 'in', [...new Set(policyIds)]).orderBy('created_at').orderBy('id').execute();
  }

  async insertPolicyVersion(row: PolicyVersionRow) {
    return this.db.insertInto('policy_versions').values(enc('policy_versions', row)).returningAll().executeTakeFirstOrThrow();
  }

  async updatePolicyVersion(id: string, patch: Partial<PolicyVersionRow>) {
    return this.db.updateTable('policy_versions').set(enc('policy_versions', patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }

  async policyVersionsDue(now: Date, limit: number) {
    return this.db.selectFrom('policy_versions').selectAll().where('state', '=', 'scheduled').where('effective_at', '<=', now).orderBy('effective_at').orderBy('created_at').limit(limit).execute();
  }

  async policyVersionByApproval(requestId: string) {
    return this.db.selectFrom('policy_versions').selectAll().where('approval_request_id', '=', requestId).executeTakeFirst();
  }

  async approvalsOf(versionIds: string[]) {
    if (!versionIds.length) return [];
    return this.db.selectFrom('policy_approvals').selectAll().where('policy_version_id', 'in', [...new Set(versionIds)]).orderBy('id').execute();
  }

  async insertApproval(row: PolicyApprovalRow) {
    await this.db.insertInto('policy_approvals').values(row).execute();
  }

  async updateApproval(id: string, patch: Partial<PolicyApprovalRow>) {
    await this.db.updateTable('policy_approvals').set(patch).where('id', '=', id).execute();
  }

  async deleteApprovals(versionId: string) {
    await this.db.deleteFrom('policy_approvals').where('policy_version_id', '=', versionId).execute();
  }

  /* ================================================================ navigation and log */

  async listNavigation() {
    return this.db.selectFrom('navigation').selectAll().orderBy('area').orderBy('position').execute();
  }

  async replaceNavigation(rows: NavigationRow[]) {
    await this.db.deleteFrom('navigation').execute();
    if (rows.length) await this.db.insertInto('navigation').values(rows).execute();
  }

  async log(row: LogRow) {
    await this.db.insertInto('content_log').values(row).execute();
  }

  async logsOf(entity: string, entityId: string, action?: string) {
    let q = this.db.selectFrom('content_log').selectAll().where('entity', '=', entity).where('entity_id', '=', entityId);
    if (action) q = q.where('action', '=', action);
    return q.orderBy('at', 'desc').execute();
  }
}
