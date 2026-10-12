/**
 * What the content service needs from the outside world, database-agnostic.
 * The MongoDB adapter lives in infra/mongo/.
 */
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type { ContentDb } from '../../spec/content.js';

export type SectionRow = ContentDb['home_sections'];
export type PageRow = ContentDb['pages'];
export type VersionRow = ContentDb['versions'];
export type CategoryRow = ContentDb['help_categories'];
export type ArticleRow = ContentDb['help_articles'];
export type FeedbackRow = ContentDb['article_feedback'];
export type PolicyRow = ContentDb['policies'];
export type PolicyVersionRow = ContentDb['policy_versions'];
export type PolicyApprovalRow = ContentDb['policy_approvals'];
export type NavigationRow = ContentDb['navigation'];
export type LogRow = ContentDb['content_log'];

export type VersionEntity = VersionRow['entity'];

export interface PageFilter {
  kind?: string;
  statuses?: string[];
  q?: string;
  brandId?: string;
  collectionKind?: string;
  linkedPromotionId?: string;
}

export interface ArticleFilter {
  statuses?: string[];
  categoryId?: string;
  audiences?: string[];
  featured?: boolean;
  ids?: string[];
  q?: string;
  /** Articles whose review_due_at has passed */
  reviewDueBefore?: Date;
}

export interface FeedbackStat {
  article_id: string;
  helpful: number;
  total: number;
}

/** Persistence for this module's own tables: content.home_sections, content.pages, content.versions, content.help_categories, content.help_articles, content.article_feedback, content.policies, content.policy_versions, content.policy_approvals, content.navigation, content.content_log. */
export interface ContentRepository {
  /** Runs fn in one transaction; fn receives a repository bound to it (nested calls reuse it) */
  transaction<T>(fn: (tx: ContentRepository) => Promise<T>): Promise<T>;
  /** Inbox (ctx.mongo.claim): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;

  /* homepage sections (the draft layout) */
  listSections(): Promise<SectionRow[]>;
  getSection(id: string, opts?: { forUpdate?: boolean }): Promise<SectionRow | undefined>;
  insertSection(row: SectionRow): Promise<SectionRow>;
  updateSection(id: string, patch: Partial<SectionRow>): Promise<SectionRow>;
  deleteSection(id: string): Promise<void>;

  /* versions of the homepage, pages and articles */
  insertVersion(row: VersionRow): Promise<VersionRow>;
  updateVersion(id: string, patch: Partial<VersionRow>): Promise<VersionRow>;
  getVersion(id: string): Promise<VersionRow | undefined>;
  getVersions(ids: string[]): Promise<VersionRow[]>;
  versionByNumber(entity: VersionEntity, entityId: string, number: number): Promise<VersionRow | undefined>;
  /** Newest first */
  versionsOf(entity: VersionEntity, entityId: string, states?: string[]): Promise<VersionRow[]>;
  maxVersionNumber(entity: VersionEntity, entityId: string): Promise<number>;
  pageOfVersions(entity: VersionEntity, entityId: string, page: PageRequest): Promise<Page<VersionRow>>;

  /* pages and collections */
  getPage(id: string, opts?: { forUpdate?: boolean }): Promise<PageRow | undefined>;
  getPages(ids: string[]): Promise<PageRow[]>;
  pageBySlug(slug: string): Promise<PageRow | undefined>;
  insertPage(row: PageRow): Promise<PageRow>;
  updatePage(id: string, patch: Partial<PageRow>): Promise<PageRow>;
  listPages(filter: PageFilter): Promise<PageRow[]>;
  pageOfPages(filter: PageFilter, page: PageRequest): Promise<Page<PageRow>>;
  pagesToPublish(now: Date, limit: number): Promise<PageRow[]>;
  pagesToUnpublish(now: Date, limit: number): Promise<PageRow[]>;

  /* Help Center */
  listCategories(): Promise<CategoryRow[]>;
  getCategory(id: string): Promise<CategoryRow | undefined>;
  categoryBySlug(slug: string): Promise<CategoryRow | undefined>;
  insertCategory(row: CategoryRow): Promise<CategoryRow>;
  updateCategory(id: string, patch: Partial<CategoryRow>): Promise<CategoryRow>;
  getArticle(id: string, opts?: { forUpdate?: boolean }): Promise<ArticleRow | undefined>;
  articleBySlug(slug: string): Promise<ArticleRow | undefined>;
  insertArticle(row: ArticleRow): Promise<ArticleRow>;
  updateArticle(id: string, patch: Partial<ArticleRow>): Promise<ArticleRow>;
  listArticles(filter: ArticleFilter): Promise<ArticleRow[]>;
  /** Published-article search (title, summary and the live text), most viewed first */
  pageOfArticles(filter: ArticleFilter, page: PageRequest): Promise<Page<ArticleRow>>;
  articlesToPublish(now: Date, limit: number): Promise<ArticleRow[]>;
  articlesToUnpublish(now: Date, limit: number): Promise<ArticleRow[]>;
  /** Rebuilds the search vector from the live text */
  setArticleSearch(id: string, text: string): Promise<void>;
  incrementViews(id: string): Promise<void>;
  /** One answer per visitor and article (a second answer replaces the first) */
  upsertFeedback(row: FeedbackRow): Promise<void>;
  feedbackStats(articleIds: string[] | null, since?: Date): Promise<FeedbackStat[]>;

  /* policies */
  listPolicies(): Promise<PolicyRow[]>;
  getPolicy(id: string): Promise<PolicyRow | undefined>;
  policyByKey(key: string): Promise<PolicyRow | undefined>;
  insertPolicy(row: PolicyRow): Promise<PolicyRow>;
  getPolicyVersion(id: string, opts?: { forUpdate?: boolean }): Promise<PolicyVersionRow | undefined>;
  /** All versions of these policies, oldest first */
  policyVersionsOf(policyIds: string[]): Promise<PolicyVersionRow[]>;
  insertPolicyVersion(row: PolicyVersionRow): Promise<PolicyVersionRow>;
  updatePolicyVersion(id: string, patch: Partial<PolicyVersionRow>): Promise<PolicyVersionRow>;
  /** Scheduled versions whose effective date has passed, earliest first */
  policyVersionsDue(now: Date, limit: number): Promise<PolicyVersionRow[]>;
  policyVersionByApproval(requestId: string): Promise<PolicyVersionRow | undefined>;
  approvalsOf(versionIds: string[]): Promise<PolicyApprovalRow[]>;
  insertApproval(row: PolicyApprovalRow): Promise<void>;
  updateApproval(id: string, patch: Partial<PolicyApprovalRow>): Promise<void>;
  deleteApprovals(versionId: string): Promise<void>;

  /* navigation */
  listNavigation(): Promise<NavigationRow[]>;
  replaceNavigation(rows: NavigationRow[]): Promise<void>;

  /* publication log */
  log(row: LogRow): Promise<void>;
  logsOf(entity: string, entityId: string, action?: string): Promise<LogRow[]>;
}
