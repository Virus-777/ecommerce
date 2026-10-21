import { contains, type ModuleStore } from '../../kernel/mongo/index.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type { AuthorRow, CompanyRow, FarmSetupRow, GameRow, IndustryRow, InquiryRow, PhonePicksRow, PostRow, RankingRow, ReactionRow, ReplyRow, ReportRow, TopicRow } from './ports.js';

export type Lock = { forUpdate?: boolean };
export type SlugTable = 'topics' | 'authors' | 'posts' | 'industries' | 'companies' | 'games';

/**
 * The departments module's collections (departments.<table>, docs/04-mongodb-migration.md): the Phone tab picks, blog
 * topics, authors, posts, reactions, replies and reports, industries, companies, inquiries, games and rankings.
 */
export class DepartmentsRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      picks: store.table<PhonePicksRow>('phone_picks'),
      farm: store.table<FarmSetupRow>('farm_setup'),
      topics: store.table<TopicRow>('blog_topics'),
      authors: store.table<AuthorRow>('blog_authors'),
      posts: store.table<PostRow>('blog_posts'),
      reactions: store.table<ReactionRow>('blog_reactions'),
      replies: store.table<ReplyRow>('blog_replies'),
      reports: store.table<ReportRow>('blog_reports'),
      industries: store.table<IndustryRow>('industries'),
      companies: store.table<CompanyRow>('companies'),
      inquiries: store.table<InquiryRow>('inquiries'),
      games: store.table<GameRow>('games'),
      rankings: store.table<RankingRow>('rankings'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: DepartmentsRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new DepartmentsRepository(tx)));
  }

  /* ---------------------------------------------------------------- phones */

  getPicks(): Promise<PhonePicksRow | undefined> {
    return this.#t.picks.get('phones');
  }
  savePicks(productIds: string[], by: string, at: Date): Promise<PhonePicksRow> {
    return this.#t.picks.upsert({ id: 'phones', product_ids: productIds, updated_by: by, updated_at: at });
  }

  /* ---------------------------------------------------------------- farm machines */

  getFarm(): Promise<FarmSetupRow | undefined> {
    return this.#t.farm.get('farm');
  }
  saveFarm(v: { types: unknown[]; machines: unknown[] }, by: string, at: Date): Promise<FarmSetupRow> {
    return this.#t.farm.upsert({ id: 'farm', types: v.types as never, machines: v.machines as never, updated_by: by, updated_at: at });
  }

  /* ---------------------------------------------------------------- blog topics and authors */

  listTopics(o: { visibleOnly?: boolean } = {}): Promise<TopicRow[]> {
    return this.#t.topics.find(o.visibleOnly ? { visible: true } : {}, { sort: { position: 1, name: 1 } });
  }
  getTopic(id: string): Promise<TopicRow | undefined> {
    return this.#t.topics.get(id);
  }
  topicBySlug(slug: string): Promise<TopicRow | undefined> {
    return this.#t.topics.findOne({ slug });
  }
  topicsByIds(ids: string[]): Promise<TopicRow[]> {
    return this.#t.topics.getMany(ids);
  }
  insertTopic(row: TopicRow): Promise<TopicRow> {
    return this.#t.topics.insert(row);
  }
  updateTopic(id: string, patch: Partial<TopicRow>): Promise<TopicRow | undefined> {
    return this.#t.topics.update(id, patch);
  }
  deleteTopic(id: string): Promise<boolean> {
    return this.#t.topics.delete(id);
  }
  countTopics(): Promise<number> {
    return this.#t.topics.count();
  }

  listAuthors(): Promise<AuthorRow[]> {
    return this.#t.authors.find({}, { sort: { name: 1 } });
  }
  getAuthor(id: string): Promise<AuthorRow | undefined> {
    return this.#t.authors.get(id);
  }
  authorBySlug(slug: string): Promise<AuthorRow | undefined> {
    return this.#t.authors.findOne({ slug });
  }
  authorsByIds(ids: string[]): Promise<AuthorRow[]> {
    return this.#t.authors.getMany(ids);
  }
  insertAuthor(row: AuthorRow): Promise<AuthorRow> {
    return this.#t.authors.insert(row);
  }
  updateAuthor(id: string, patch: Partial<AuthorRow>): Promise<AuthorRow | undefined> {
    return this.#t.authors.update(id, patch);
  }
  deleteAuthor(id: string): Promise<boolean> {
    return this.#t.authors.delete(id);
  }

  /* ---------------------------------------------------------------- blog posts */

  getPost(id: string, lock?: Lock): Promise<PostRow | undefined> {
    return this.#t.posts.get(id, lock);
  }
  postBySlug(slug: string): Promise<PostRow | undefined> {
    return this.#t.posts.findOne({ slug });
  }
  postsByIds(ids: string[]): Promise<PostRow[]> {
    return this.#t.posts.getMany(ids);
  }
  insertPost(row: PostRow): Promise<PostRow> {
    return this.#t.posts.insert(row);
  }
  updatePost(id: string, patch: Partial<PostRow>): Promise<PostRow | undefined> {
    return this.#t.posts.update(id, patch);
  }
  countPosts(f: { topicId?: string; authorId?: string; status?: string }): Promise<number> {
    return this.#t.posts.count({ ...(f.topicId ? { topic_id: f.topicId } : {}), ...(f.authorId ? { author_id: f.authorId } : {}), ...(f.status ? { status: f.status } : {}) });
  }
  /** Posts per topic or author ({ id → count }), published ones only unless `all` */
  async postCounts(field: 'topic_id' | 'author_id', o: { all?: boolean } = {}): Promise<Map<string, number>> {
    const rows = await this.#t.posts.aggregate<{ _id: string; n: number }>([{ $match: { ...(o.all ? {} : { status: 'published' }), [field]: { $ne: null } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
  /** Likes on the published posts of each author */
  async likesByAuthor(): Promise<Map<string, number>> {
    const rows = await this.#t.posts.aggregate<{ _id: string; n: number }>([{ $match: { status: 'published' } }, { $group: { _id: '$author_id', n: { $sum: '$like_count' } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
  postIdsOfAuthor(authorId: string): Promise<string[]> {
    return this.#t.posts.distinct<string>('id', { author_id: authorId });
  }

  /** Published posts newest first, leaving out posts of hidden topics */
  pagePublished(f: { topicId?: string; authorId?: string; hiddenTopicIds?: string[]; q?: string }, page: PageRequest): Promise<Page<PostRow>> {
    const filter: Record<string, unknown> = { status: 'published' };
    if (f.topicId) filter.topic_id = f.topicId;
    else if (f.hiddenTopicIds?.length) filter.topic_id = { $nin: f.hiddenTopicIds };
    if (f.authorId) filter.author_id = f.authorId;
    if (f.q?.trim()) filter.$or = [{ title: contains(f.q) }, { summary: contains(f.q) }];
    return this.#t.posts.page(filter, page, { column: 'published_at', direction: 'desc' });
  }
  /** The published post just before (older) or just after (newer) a post */
  async neighbour(post: PostRow, dir: 'previous' | 'next', hiddenTopicIds: string[]): Promise<PostRow | undefined> {
    const at = post.published_at!;
    const older = dir === 'previous';
    const cmp = older ? '$lt' : '$gt';
    const topic = hiddenTopicIds.length ? { topic_id: { $nin: hiddenTopicIds } } : {};
    const rows = await this.#t.posts.find(
      { status: 'published', ...topic, $or: [{ published_at: { [cmp]: at } }, { published_at: at, id: { [cmp]: post.id } }] },
      { sort: older ? { published_at: -1, id: -1 } : { published_at: 1, id: 1 }, limit: 1 },
    );
    return rows[0];
  }
  pageAdminPosts(f: { status?: string; topicId?: string; authorId?: string; q?: string }, page: PageRequest): Promise<Page<PostRow>> {
    const filter: Record<string, unknown> = {};
    if (f.status) filter.status = f.status;
    if (f.topicId) filter.topic_id = f.topicId;
    if (f.authorId) filter.author_id = f.authorId;
    if (f.q?.trim()) filter.title = contains(f.q);
    return this.#t.posts.page(filter, page, { column: 'updated_at', direction: 'desc' });
  }
  /** Deletes a post with its reactions, replies and reports */
  async deletePostCascade(id: string): Promise<void> {
    const replyIds = await this.#t.replies.distinct<string>('id', { post_id: id });
    await this.#t.reactions.deleteMany({ post_id: id });
    await this.#t.replies.deleteMany({ post_id: id });
    await this.#t.reports.deleteMany({ $or: [{ target_type: 'post', target_id: id }, ...(replyIds.length ? [{ target_type: 'reply', target_id: { $in: replyIds } }] : [])] });
    await this.#t.posts.delete(id);
  }

  /* ---------------------------------------------------------------- reactions and replies */

  getReaction(postId: string, customerId: string): Promise<ReactionRow | undefined> {
    return this.#t.reactions.findOne({ post_id: postId, customer_id: customerId });
  }
  insertReaction(row: ReactionRow): Promise<ReactionRow> {
    return this.#t.reactions.insert(row);
  }
  updateReaction(id: string, patch: Partial<ReactionRow>): Promise<ReactionRow | undefined> {
    return this.#t.reactions.update(id, patch);
  }
  deleteReaction(id: string): Promise<boolean> {
    return this.#t.reactions.delete(id);
  }

  getReply(id: string, lock?: Lock): Promise<ReplyRow | undefined> {
    return this.#t.replies.get(id, lock);
  }
  insertReply(row: ReplyRow): Promise<ReplyRow> {
    return this.#t.replies.insert(row);
  }
  updateReply(id: string, patch: Partial<ReplyRow>): Promise<ReplyRow | undefined> {
    return this.#t.replies.update(id, patch);
  }
  /** Deletes a reply with the replies that answer it */
  async deleteReplyCascade(id: string): Promise<void> {
    await this.#t.replies.deleteMany({ parent_id: id });
    await this.#t.replies.delete(id);
  }
  countVisibleReplies(postId: string): Promise<number> {
    return this.#t.replies.count({ post_id: postId, status: 'visible' });
  }
  pageVisibleReplies(postId: string, page: PageRequest): Promise<Page<ReplyRow>> {
    return this.#t.replies.page({ post_id: postId, status: 'visible' }, page, { column: 'created_at', direction: 'asc' });
  }
  pageAdminReplies(f: { status?: string; postId?: string; ids?: string[] }, page: PageRequest): Promise<Page<ReplyRow>> {
    const filter: Record<string, unknown> = {};
    if (f.status) filter.status = f.status;
    if (f.postId) filter.post_id = f.postId;
    if (f.ids) filter.id = { $in: f.ids };
    return this.#t.replies.page(filter, page, { column: 'created_at', direction: 'desc' });
  }
  repliesByIds(ids: string[]): Promise<ReplyRow[]> {
    return this.#t.replies.getMany(ids);
  }

  /* ---------------------------------------------------------------- reports */

  /** Undefined when this reporter already reported the target (unique index) */
  insertReport(row: ReportRow): Promise<ReportRow | undefined> {
    return this.#t.reports.insertIfAbsent(row);
  }
  getReport(id: string, lock?: Lock): Promise<ReportRow | undefined> {
    return this.#t.reports.get(id, lock);
  }
  updateReport(id: string, patch: Partial<ReportRow>): Promise<ReportRow | undefined> {
    return this.#t.reports.update(id, patch);
  }
  pageReports(f: { status?: string }, page: PageRequest): Promise<Page<ReportRow>> {
    return this.#t.reports.page(f.status ? { status: f.status } : {}, page, { column: 'created_at', direction: 'desc' });
  }
  /** Open reports per target id */
  async openReportCounts(targetType: string, ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.#t.reports.aggregate<{ _id: string; n: number }>([{ $match: { target_type: targetType, target_id: { $in: ids }, status: 'open' } }, { $group: { _id: '$target_id', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
  /** Reply ids with open reports */
  reportedReplyIds(): Promise<string[]> {
    return this.#t.reports.distinct<string>('target_id', { target_type: 'reply', status: 'open' });
  }
  /** Upheld reports about an author or their posts */
  countUpheldAbout(authorId: string, postIds: string[]): Promise<number> {
    return this.#t.reports.count({ status: 'upheld', $or: [{ target_type: 'author', target_id: authorId }, ...(postIds.length ? [{ target_type: 'post', target_id: { $in: postIds } }] : [])] });
  }

  /* ---------------------------------------------------------------- industries and companies */

  listIndustries(o: { visibleOnly?: boolean } = {}): Promise<IndustryRow[]> {
    return this.#t.industries.find(o.visibleOnly ? { visible: true } : {}, { sort: { position: 1, name: 1 } });
  }
  getIndustry(id: string): Promise<IndustryRow | undefined> {
    return this.#t.industries.get(id);
  }
  industryBySlug(slug: string): Promise<IndustryRow | undefined> {
    return this.#t.industries.findOne({ slug });
  }
  industriesByIds(ids: string[]): Promise<IndustryRow[]> {
    return this.#t.industries.getMany(ids);
  }
  insertIndustry(row: IndustryRow): Promise<IndustryRow> {
    return this.#t.industries.insert(row);
  }
  updateIndustry(id: string, patch: Partial<IndustryRow>): Promise<IndustryRow | undefined> {
    return this.#t.industries.update(id, patch);
  }
  deleteIndustry(id: string): Promise<boolean> {
    return this.#t.industries.delete(id);
  }
  countIndustries(): Promise<number> {
    return this.#t.industries.count();
  }
  /** Published companies per industry */
  async companyCounts(): Promise<Map<string, number>> {
    const rows = await this.#t.companies.aggregate<{ _id: string; n: number }>([{ $match: { status: 'published', industry_id: { $ne: null } } }, { $group: { _id: '$industry_id', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
  countCompanies(f: { industryId?: string } = {}): Promise<number> {
    return this.#t.companies.count(f.industryId ? { industry_id: f.industryId } : {});
  }

  getCompany(id: string): Promise<CompanyRow | undefined> {
    return this.#t.companies.get(id);
  }
  companyBySlug(slug: string): Promise<CompanyRow | undefined> {
    return this.#t.companies.findOne({ slug });
  }
  insertCompany(row: CompanyRow): Promise<CompanyRow> {
    return this.#t.companies.insert(row);
  }
  updateCompany(id: string, patch: Partial<CompanyRow>): Promise<CompanyRow | undefined> {
    return this.#t.companies.update(id, patch);
  }
  /** Deletes a company with its inquiries */
  async deleteCompanyCascade(id: string): Promise<void> {
    await this.#t.inquiries.deleteMany({ company_id: id });
    await this.#t.companies.delete(id);
  }
  pageCompanies(f: { status?: string; industryId?: string; hiddenIndustryIds?: string[]; q?: string }, page: PageRequest): Promise<Page<CompanyRow>> {
    const filter: Record<string, unknown> = {};
    if (f.status) filter.status = f.status;
    if (f.industryId) filter.industry_id = f.industryId;
    else if (f.hiddenIndustryIds?.length) filter.industry_id = { $nin: f.hiddenIndustryIds };
    if (f.q?.trim()) filter.$or = [{ name: contains(f.q) }, { tagline: contains(f.q) }, { city: contains(f.q) }];
    return this.#t.companies.page(filter, page, { column: 'position', direction: 'asc' });
  }
  /** The next position at the end of the list */
  async nextCompanyPosition(): Promise<number> {
    const [last] = await this.#t.companies.find({}, { sort: { position: -1 }, limit: 1 });
    return (last?.position ?? 0) + 1;
  }

  insertInquiry(row: InquiryRow): Promise<InquiryRow> {
    return this.#t.inquiries.insert(row);
  }
  getInquiry(id: string): Promise<InquiryRow | undefined> {
    return this.#t.inquiries.get(id);
  }
  updateInquiry(id: string, patch: Partial<InquiryRow>): Promise<InquiryRow | undefined> {
    return this.#t.inquiries.update(id, patch);
  }
  pageInquiries(f: { status?: string; companyId?: string }, page: PageRequest): Promise<Page<InquiryRow>> {
    return this.#t.inquiries.page({ ...(f.status ? { status: f.status } : {}), ...(f.companyId ? { company_id: f.companyId } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }
  /** Inquiries still new per company */
  async openInquiryCounts(companyIds: string[]): Promise<Map<string, number>> {
    if (!companyIds.length) return new Map();
    const rows = await this.#t.inquiries.aggregate<{ _id: string; n: number }>([{ $match: { company_id: { $in: companyIds }, status: 'new' } }, { $group: { _id: '$company_id', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
  companiesByIds(ids: string[]): Promise<CompanyRow[]> {
    return this.#t.companies.getMany(ids);
  }

  /* ---------------------------------------------------------------- games and rankings */

  listGames(o: { publishedOnly?: boolean } = {}): Promise<GameRow[]> {
    return this.#t.games.find(o.publishedOnly ? { status: 'published' } : {}, { sort: { position: 1, title: 1 } });
  }
  getGame(id: string): Promise<GameRow | undefined> {
    return this.#t.games.get(id);
  }
  gameBySlug(slug: string): Promise<GameRow | undefined> {
    return this.#t.games.findOne({ slug });
  }
  insertGame(row: GameRow): Promise<GameRow> {
    return this.#t.games.insert(row);
  }
  updateGame(id: string, patch: Partial<GameRow>): Promise<GameRow | undefined> {
    return this.#t.games.update(id, patch);
  }
  /** Deletes a game with its ranking tables */
  async deleteGameCascade(id: string): Promise<void> {
    await this.#t.rankings.deleteMany({ game_id: id });
    await this.#t.games.delete(id);
  }
  async nextGamePosition(): Promise<number> {
    const [last] = await this.#t.games.find({}, { sort: { position: -1 }, limit: 1 });
    return (last?.position ?? 0) + 1;
  }

  getRanking(gameId: string, period: string): Promise<RankingRow | undefined> {
    return this.#t.rankings.findOne({ game_id: gameId, period });
  }
  /** When each game's tables last changed */
  async rankingsUpdatedAt(gameIds: string[]): Promise<Map<string, Date>> {
    if (!gameIds.length) return new Map();
    const rows = await this.#t.rankings.find({ game_id: { $in: gameIds } });
    const out = new Map<string, Date>();
    for (const r of rows) if (!out.get(r.game_id) || out.get(r.game_id)! < r.updated_at) out.set(r.game_id, r.updated_at);
    return out;
  }
  saveRanking(row: RankingRow): Promise<RankingRow> {
    return this.#t.rankings.upsert(row, { key: ['game_id', 'period'], update: { entries: row.entries, updated_by: row.updated_by, updated_at: row.updated_at } });
  }

  /* ---------------------------------------------------------------- slugs */

  /** Whether a slug is taken in a table by another record than `exceptId` */
  slugTaken(table: SlugTable, slug: string, exceptId?: string): Promise<boolean> {
    const t = this.#t[table] as unknown as { exists(f: Record<string, unknown>): Promise<boolean> };
    return t.exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) });
  }
}
