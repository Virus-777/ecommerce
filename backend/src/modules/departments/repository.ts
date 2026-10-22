import { contains, type ModuleStore } from '../../kernel/mongo/index.js';
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type { AuthorRow, CompanyRow, FarmSetupRow, FollowRow, GameKeyRow, GameRow, IndustryRow, InquiryRow, PhonePicksRow, PhoneRow, PlayerRow, PostRow, PrizeAwardRow, PrizeWeekRow, RankingRow, ReactionRow, ReplyLikeRow, ReplyRow, ReportRow, ReviewRow, SaveRow, ScoreRow, TopicRow } from './ports.js';

export type Lock = { forUpdate?: boolean };
export type SlugTable = 'phones' | 'topics' | 'authors' | 'posts' | 'industries' | 'companies' | 'games';

/**
 * The departments module's collections (departments.<table>, docs/04-mongodb-migration.md): the Phone tab's phones, blog
 * topics, authors, posts, reactions, replies and reports, industries, companies, inquiries, games and rankings.
 */
export class DepartmentsRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      picks: store.table<PhonePicksRow>('phone_picks'),
      phones: store.table<PhoneRow>('phones'),
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
      saves: store.table<SaveRow>('blog_saves'),
      follows: store.table<FollowRow>('blog_follows'),
      replyLikes: store.table<ReplyLikeRow>('blog_reply_likes'),
      reviews: store.table<ReviewRow>('reviews'),
      players: store.table<PlayerRow>('players'),
      keys: store.table<GameKeyRow>('game_keys'),
      scores: store.table<ScoreRow>('scores'),
      prizeWeeks: store.table<PrizeWeekRow>('prize_weeks'),
      awards: store.table<PrizeAwardRow>('prize_awards'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: DepartmentsRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new DepartmentsRepository(tx)));
  }

  /* ---------------------------------------------------------------- phones */

  /** Every phone in staff order (`publishedOnly`: what the store shows) */
  listPhones(o: { publishedOnly?: boolean } = {}): Promise<PhoneRow[]> {
    return this.#t.phones.find(o.publishedOnly ? { status: 'published' } : {}, { sort: { position: 1, created_at: 1 } });
  }
  getPhone(id: string): Promise<PhoneRow | undefined> {
    return this.#t.phones.get(id);
  }
  phoneBySlug(slug: string): Promise<PhoneRow | undefined> {
    return this.#t.phones.findOne({ slug });
  }
  insertPhone(row: PhoneRow): Promise<PhoneRow> {
    return this.#t.phones.insert(row);
  }
  /** Inserts unless a phone already has the slug (or the id): undefined then */
  insertPhoneIfAbsent(row: PhoneRow): Promise<PhoneRow | undefined> {
    return this.#t.phones.insertIfAbsent(row);
  }
  updatePhone(id: string, patch: Partial<PhoneRow>): Promise<PhoneRow | undefined> {
    return this.#t.phones.update(id, patch);
  }
  deletePhone(id: string): Promise<boolean> {
    return this.#t.phones.delete(id);
  }
  /** The next position at the end of the list */
  async nextPhonePosition(): Promise<number> {
    const [last] = await this.#t.phones.find({}, { sort: { position: -1 }, limit: 1 });
    return (last?.position ?? 0) + 1;
  }
  /** Moves the phones at `from` or later one place down (room at `from`), leaving out `exceptId` */
  async shiftPhones(from: number, exceptId?: string): Promise<void> {
    await this.#t.phones.updateMany({ position: { $gte: from }, ...(exceptId ? { id: { $ne: exceptId } } : {}) }, { $inc: { position: 1 } });
  }
  /** Gives the phones positions 1, 2, 3… in the order of `ids` */
  async setPhonePositions(ids: string[]): Promise<void> {
    for (const [i, id] of ids.entries()) await this.#t.phones.update(id, { position: i + 1 });
  }

  /** Before standalone phones: the picked product ids (departments.import-phone-picks) */
  getPicks(): Promise<PhonePicksRow | undefined> {
    return this.#t.picks.get('phones');
  }
  /** Picks as they were kept before standalone phones; [] once imported */
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
    await this.#t.saves.deleteMany({ post_id: id });
    await this.#t.replyLikes.deleteMany({ post_id: id });
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
    const answers = await this.#t.replies.distinct<string>('id', { parent_id: id });
    await this.#t.replyLikes.deleteMany({ reply_id: { $in: [id, ...answers] } });
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
    await this.#t.reviews.deleteMany({ target_type: 'company', target_id: id });
    await this.#t.companies.delete(id);
  }
  /** Companies in staff order; the page always carries the total */
  async pageCompanies(f: { status?: string; industryId?: string; hiddenIndustryIds?: string[]; q?: string }, page: PageRequest): Promise<Page<CompanyRow>> {
    const filter: Record<string, unknown> = {};
    if (f.status) filter.status = f.status;
    if (f.industryId) filter.industry_id = f.industryId;
    else if (f.hiddenIndustryIds?.length) filter.industry_id = { $nin: f.hiddenIndustryIds };
    if (f.q?.trim()) filter.$or = [{ name: contains(f.q) }, { tagline: contains(f.q) }, { city: contains(f.q) }];
    const res = await this.#t.companies.page(filter, page, { column: 'position', direction: 'asc' });
    return res.total === undefined ? { ...res, total: await this.#t.companies.count(filter) } : res;
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
  /** Deletes a game with its ranking tables, reviews, server keys, scores and prize weeks */
  async deleteGameCascade(id: string): Promise<void> {
    await this.#t.rankings.deleteMany({ game_id: id });
    await this.#t.reviews.deleteMany({ target_type: 'game', target_id: id });
    await this.#t.keys.deleteMany({ game_id: id });
    await this.#t.scores.deleteMany({ game_id: id });
    await this.#t.prizeWeeks.deleteMany({ game_id: id });
    await this.#t.awards.deleteMany({ game_id: id });
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

  /* ---------------------------------------------------------------- blog saves, follows and reply likes */

  getSave(customerId: string, postId: string): Promise<SaveRow | undefined> {
    return this.#t.saves.findOne({ customer_id: customerId, post_id: postId });
  }
  insertSave(row: SaveRow): Promise<SaveRow | undefined> {
    return this.#t.saves.insertIfAbsent(row, ['customer_id', 'post_id']);
  }
  deleteSave(customerId: string, postId: string): Promise<number> {
    return this.#t.saves.deleteMany({ customer_id: customerId, post_id: postId });
  }
  pageSaves(customerId: string, page: PageRequest): Promise<Page<SaveRow>> {
    return this.#t.saves.page({ customer_id: customerId }, page, { column: 'saved_at', direction: 'desc' });
  }

  getFollow(customerId: string, authorId: string): Promise<FollowRow | undefined> {
    return this.#t.follows.findOne({ customer_id: customerId, author_id: authorId });
  }
  insertFollow(row: FollowRow): Promise<FollowRow | undefined> {
    return this.#t.follows.insertIfAbsent(row, ['author_id', 'customer_id']);
  }
  deleteFollow(customerId: string, authorId: string): Promise<number> {
    return this.#t.follows.deleteMany({ customer_id: customerId, author_id: authorId });
  }
  countFollowers(authorId: string): Promise<number> {
    return this.#t.follows.count({ author_id: authorId });
  }
  /** Followers per author */
  async followerCounts(authorIds: string[]): Promise<Map<string, number>> {
    if (!authorIds.length) return new Map();
    const rows = await this.#t.follows.aggregate<{ _id: string; n: number }>([{ $match: { author_id: { $in: authorIds } } }, { $group: { _id: '$author_id', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
  followerIds(authorId: string): Promise<string[]> {
    return this.#t.follows.distinct<string>('customer_id', { author_id: authorId });
  }
  pageFollows(customerId: string, page: PageRequest): Promise<Page<FollowRow>> {
    return this.#t.follows.page({ customer_id: customerId }, page, { column: 'followed_at', direction: 'desc' });
  }

  getReplyLike(replyId: string, customerId: string): Promise<ReplyLikeRow | undefined> {
    return this.#t.replyLikes.findOne({ reply_id: replyId, customer_id: customerId });
  }
  insertReplyLike(row: ReplyLikeRow): Promise<ReplyLikeRow | undefined> {
    return this.#t.replyLikes.insertIfAbsent(row, ['reply_id', 'customer_id']);
  }
  deleteReplyLike(replyId: string, customerId: string): Promise<number> {
    return this.#t.replyLikes.deleteMany({ reply_id: replyId, customer_id: customerId });
  }
  countReplyLikes(replyId: string): Promise<number> {
    return this.#t.replyLikes.count({ reply_id: replyId });
  }
  /** Which of a post's replies the customer liked */
  async likedReplyIds(postId: string, customerId: string): Promise<Set<string>> {
    return new Set(await this.#t.replyLikes.distinct<string>('reply_id', { post_id: postId, customer_id: customerId }));
  }

  /* ---------------------------------------------------------------- reviews */

  getReview(id: string): Promise<ReviewRow | undefined> {
    return this.#t.reviews.get(id);
  }
  reviewOf(target: ReviewRow['target_type'], targetId: string, customerId: string): Promise<ReviewRow | undefined> {
    return this.#t.reviews.findOne({ target_type: target, target_id: targetId, customer_id: customerId });
  }
  /** Inserts the review, or changes stars, text and name of the customer's existing one (hidden stays as it is) */
  saveReview(row: ReviewRow): Promise<ReviewRow> {
    return this.#t.reviews.upsert(row, { key: ['target_type', 'target_id', 'customer_id'], update: { stars: row.stars, text: row.text, name: row.name, updated_at: row.updated_at } });
  }
  updateReview(id: string, patch: Partial<ReviewRow>): Promise<ReviewRow | undefined> {
    return this.#t.reviews.update(id, patch);
  }
  pageVisibleReviews(target: ReviewRow['target_type'], targetId: string, stars: number | undefined, page: PageRequest): Promise<Page<ReviewRow>> {
    return this.#t.reviews.page({ target_type: target, target_id: targetId, hidden: false, ...(stars ? { stars } : {}) }, page, { column: 'updated_at', direction: 'desc' });
  }
  /** Visible reviews per target and stars: { targetId → { stars → count } } */
  async ratingCounts(target: ReviewRow['target_type'], targetIds: string[]): Promise<Map<string, Map<number, number>>> {
    const out = new Map<string, Map<number, number>>();
    if (!targetIds.length) return out;
    const rows = await this.#t.reviews.aggregate<{ _id: { t: string; s: number }; n: number }>([
      { $match: { target_type: target, target_id: { $in: targetIds }, hidden: false } },
      { $group: { _id: { t: '$target_id', s: '$stars' }, n: { $sum: 1 } } },
    ]);
    for (const r of rows) {
      const m = out.get(String(r._id.t)) ?? new Map<number, number>();
      m.set(Number(r._id.s), r.n);
      out.set(String(r._id.t), m);
    }
    return out;
  }
  async hiddenReviewCounts(target: ReviewRow['target_type'], targetIds: string[]): Promise<Map<string, number>> {
    if (!targetIds.length) return new Map();
    const rows = await this.#t.reviews.aggregate<{ _id: string; n: number }>([{ $match: { target_type: target, target_id: { $in: targetIds }, hidden: true } }, { $group: { _id: '$target_id', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
  pageAdminReviews(f: { target?: string; targetId?: string; hidden?: boolean; stars?: number }, page: PageRequest): Promise<Page<ReviewRow>> {
    const filter: Record<string, unknown> = {};
    if (f.target) filter.target_type = f.target;
    if (f.targetId) filter.target_id = f.targetId;
    if (f.hidden !== undefined) filter.hidden = f.hidden;
    if (f.stars) filter.stars = f.stars;
    return this.#t.reviews.page(filter, page, { column: 'updated_at', direction: 'desc' });
  }

  /* ---------------------------------------------------------------- players and server keys */

  playerByCustomer(customerId: string): Promise<PlayerRow | undefined> {
    return this.#t.players.findOne({ customer_id: customerId });
  }
  playerByCode(code: string): Promise<PlayerRow | undefined> {
    return this.#t.players.findOne({ code });
  }
  playersByCustomers(customerIds: string[]): Promise<PlayerRow[]> {
    return customerIds.length ? this.#t.players.find({ customer_id: { $in: customerIds } }) : Promise.resolve([]);
  }
  /** Undefined when the customer already has a player ID or the code is taken */
  insertPlayer(row: PlayerRow): Promise<PlayerRow | undefined> {
    return this.#t.players.insertIfAbsent(row);
  }
  updatePlayer(id: string, patch: Partial<PlayerRow>): Promise<PlayerRow | undefined> {
    return this.#t.players.update(id, patch);
  }

  listKeys(gameId: string): Promise<GameKeyRow[]> {
    return this.#t.keys.find({ game_id: gameId }, { sort: { created_at: -1 } });
  }
  getKey(id: string): Promise<GameKeyRow | undefined> {
    return this.#t.keys.get(id);
  }
  keyByHash(hash: string): Promise<GameKeyRow | undefined> {
    return this.#t.keys.findOne({ key_hash: hash });
  }
  insertKey(row: GameKeyRow): Promise<GameKeyRow> {
    return this.#t.keys.insert(row);
  }
  updateKey(id: string, patch: Partial<GameKeyRow>): Promise<GameKeyRow | undefined> {
    return this.#t.keys.update(id, patch);
  }
  countActiveKeys(gameId: string): Promise<number> {
    return this.#t.keys.count({ game_id: gameId, status: 'active' });
  }
  async activeKeyCounts(gameIds: string[]): Promise<Map<string, number>> {
    if (!gameIds.length) return new Map();
    const rows = await this.#t.keys.aggregate<{ _id: string; n: number }>([{ $match: { game_id: { $in: gameIds }, status: 'active' } }, { $group: { _id: '$game_id', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }

  /* ---------------------------------------------------------------- scores */

  scoreByPartnerId(gameId: string, partnerScoreId: string): Promise<ScoreRow | undefined> {
    return this.#t.scores.findOne({ game_id: gameId, partner_score_id: partnerScoreId });
  }
  /** Undefined when the game already has a score with this partner id */
  insertScore(row: ScoreRow): Promise<ScoreRow | undefined> {
    return this.#t.scores.insertIfAbsent(row, ['game_id', 'partner_score_id']);
  }
  countScores(f: { gameId?: string; customerId?: string }): Promise<number> {
    return this.#t.scores.count({ ...(f.gameId ? { game_id: f.gameId } : {}), ...(f.customerId ? { customer_id: f.customerId } : {}) });
  }
  async scoreCounts(gameIds: string[]): Promise<Map<string, number>> {
    if (!gameIds.length) return new Map();
    const rows = await this.#t.scores.aggregate<{ _id: string; n: number }>([{ $match: { game_id: { $in: gameIds } } }, { $group: { _id: '$game_id', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }
  hasScores(gameId: string): Promise<boolean> {
    return this.#t.scores.exists({ game_id: gameId });
  }
  /** The best score of each player in a game, within a prize week or a market day, or (all time) before an instant */
  async bests(gameId: string, f: { week?: string; day?: string; before?: Date; customerId?: string } = {}): Promise<{ customerId: string; score: number; at: Date }[]> {
    const match: Record<string, unknown> = { game_id: gameId };
    if (f.week) match.week = f.week;
    if (f.day) match.day = f.day;
    if (f.before) match.played_at = { $lt: f.before };
    if (f.customerId) match.customer_id = f.customerId;
    const rows = await this.#t.scores.aggregate<{ _id: string; score: number; at: Date }>([
      { $match: match },
      { $sort: { score: -1, played_at: 1 } },
      { $group: { _id: '$customer_id', score: { $first: '$score' }, at: { $first: '$played_at' } } },
    ]);
    return rows.map((r) => ({ customerId: String(r._id), score: r.score, at: new Date(r.at) }));
  }
  /** Players with a score in each game's prize week */
  async weekPlayerCounts(gameIds: string[], week: string): Promise<Map<string, number>> {
    if (!gameIds.length) return new Map();
    const rows = await this.#t.scores.aggregate<{ _id: string; n: number }>([{ $match: { game_id: { $in: gameIds }, week } }, { $group: { _id: { g: '$game_id', c: '$customer_id' } } }, { $group: { _id: '$_id.g', n: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }

  /* ---------------------------------------------------------------- prize weeks and awards */

  getPrizeWeek(gameId: string, week: string): Promise<PrizeWeekRow | undefined> {
    return this.#t.prizeWeeks.findOne({ game_id: gameId, week });
  }
  savePrizeWeek(row: PrizeWeekRow): Promise<PrizeWeekRow> {
    return this.#t.prizeWeeks.upsert(row, { key: ['game_id', 'week'], update: { state: row.state, winners: row.winners, updated_at: row.updated_at } });
  }
  awardOf(gameId: string, week: string, customerId: string): Promise<PrizeAwardRow | undefined> {
    return this.#t.awards.findOne({ game_id: gameId, week, customer_id: customerId });
  }
  insertAward(row: PrizeAwardRow): Promise<PrizeAwardRow | undefined> {
    return this.#t.awards.insertIfAbsent(row, ['game_id', 'week', 'customer_id']);
  }
  updateAward(id: string, patch: Partial<PrizeAwardRow>): Promise<PrizeAwardRow | undefined> {
    return this.#t.awards.update(id, patch);
  }
  pageAwards(gameId: string, f: { week?: string; state?: string }, page: PageRequest): Promise<Page<PrizeAwardRow>> {
    return this.#t.awards.page({ game_id: gameId, ...(f.week ? { week: f.week } : {}), ...(f.state ? { state: f.state } : {}) }, page, { column: 'created_at', direction: 'desc' });
  }

  /* ---------------------------------------------------------------- personal data export */

  /** Every row about a customer, by any of their ids (account id or customers-module id) */
  async customerData(ids: string[]) {
    const mine = { $in: ids };
    const [reactions, replies, reports, saves, follows, replyLikes, inquiries, reviews, players, scores, awards] = await Promise.all([
      this.#t.reactions.find({ customer_id: mine }, { sort: { at: 1 } }),
      this.#t.replies.find({ customer_id: mine }, { sort: { created_at: 1 } }),
      this.#t.reports.find({ reporter_id: mine }, { sort: { created_at: 1 } }),
      this.#t.saves.find({ customer_id: mine }, { sort: { saved_at: 1 } }),
      this.#t.follows.find({ customer_id: mine }, { sort: { followed_at: 1 } }),
      this.#t.replyLikes.find({ customer_id: mine }, { sort: { at: 1 } }),
      this.#t.inquiries.find({ customer_id: mine }, { sort: { created_at: 1 } }),
      this.#t.reviews.find({ customer_id: mine }, { sort: { created_at: 1 } }),
      this.#t.players.find({ customer_id: mine }, { sort: { created_at: 1 } }),
      this.#t.scores.find({ customer_id: mine }, { sort: { played_at: 1 } }),
      this.#t.awards.find({ customer_id: mine }, { sort: { created_at: 1 } }),
    ]);
    return { reactions, replies, reports, saves, follows, replyLikes, inquiries, reviews, players, scores, awards };
  }

  /* ---------------------------------------------------------------- slugs */

  /** Whether a slug is taken in a table by another record than `exceptId` */
  slugTaken(table: SlugTable, slug: string, exceptId?: string): Promise<boolean> {
    const t = this.#t[table] as unknown as { exists(f: Record<string, unknown>): Promise<boolean> };
    return t.exists({ slug, ...(exceptId ? { id: { $ne: exceptId } } : {}) });
  }
}
