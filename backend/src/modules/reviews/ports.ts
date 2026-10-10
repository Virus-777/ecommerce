/**
 * What the reviews service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type { ReviewsDb } from '../../spec/reviews.js';

export type Db = ReviewsDb;
export type Table = keyof Db & string;
/** Tables keyed by `id` */
export type IdTable = Exclude<Table, 'helpful_votes' | 'product_rating_summaries' | 'seller_feedback_summaries' | 'review_invites'>;
export type InviteRec = Db['review_invites'];

export type ReviewRec = Db['product_reviews'];
export type FeedbackRec = Db['seller_feedback'];
export type ResponseRec = Db['seller_responses'];
export type QuestionRec = Db['questions'];
export type AnswerRec = Db['answers'];
export type VoteRec = Db['helpful_votes'];
export type ReportRec = Db['reports'];
export type ItemRec = Db['moderation_items'];
export type DecisionRec = Db['moderation_decisions'];
export type AppealRec = Db['appeals'];
export type ProductSummaryRec = Db['product_rating_summaries'];
export type SellerSummaryRec = Db['seller_feedback_summaries'];

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not'; value: V | null };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

export interface ReviewListFilter {
  productId?: string;
  sellerId?: string;
  customerId?: string;
  statuses?: string[];
  /** published and visible only */
  publicOnly?: boolean;
  stars?: number;
  critical?: boolean;
  verifiedOnly?: boolean;
  withPhotos?: boolean;
  variantIds?: string[];
  needsResponse?: boolean;
  q?: string;
  sort?: 'most_helpful' | 'newest' | 'highest' | 'lowest';
}

export interface FeedbackListFilter {
  sellerId?: string;
  customerId?: string;
  statuses?: string[];
  publicOnly?: boolean;
  sentiment?: string;
  needsResponse?: boolean;
  /** created_at >= since */
  since?: Date;
}

export interface QuestionListFilter {
  productId?: string;
  productIds?: string[];
  statuses?: string[];
  /** questions hidden by an open report are left out */
  publicOnly?: boolean;
  q?: string;
  answered?: boolean;
  /** The seller has (true) or has not (false) published an answer */
  answeredBySeller?: { sellerId: string; value: boolean };
  sort: 'most_helpful' | 'newest' | 'oldest' | 'oldest_unanswered';
}

export interface ModerationListFilter {
  queue?: string;
  contentType?: string;
  status?: string;
  reason?: string;
}

export interface ReviewsRepository {
  transaction<R>(fn: (tx: ReviewsRepository) => Promise<R>): Promise<R>;
  /** Inbox (ctx.inbox): true the first time this key is claimed; commits with the transaction it runs in */
  claim(key: string): Promise<boolean>;
  /** Insert unless a unique key already holds the row; true when inserted */
  insertIgnore<T extends Table>(table: T, row: Db[T]): Promise<boolean>;

  /* generic table access */
  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined>;
  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]>;
  find<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]>;
  findOne<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined>;
  count<T extends Table>(table: T, where: Where<Db[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]>;
  update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]>;
  updateWhere<T extends Table>(table: T, where: Where<Db[T]>, patch: Partial<Db[T]>): Promise<number>;
  page<T extends Table>(table: T, where: Where<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc' }): Promise<common.Page<Db[T]>>;

  /* lists */
  listReviews(filter: ReviewListFilter, page: PageRequest): Promise<common.Page<ReviewRec>>;
  listFeedback(filter: FeedbackListFilter, page: PageRequest): Promise<common.Page<FeedbackRec>>;
  listQuestions(filter: QuestionListFilter, page: PageRequest): Promise<common.Page<QuestionRec>>;
  /** Answers of questions; publicOnly leaves out unpublished answers and ones hidden by an open report */
  answersOf(questionIds: readonly string[], o: { publicOnly: boolean }): Promise<AnswerRec[]>;
  responsesFor(targetType: string, targetIds: readonly string[]): Promise<ResponseRec[]>;
  /** Content ids among `ids` hidden by an open moderation item (questions, answers, responses) */
  hiddenByReport(contentType: string, ids: readonly string[]): Promise<Set<string>>;
  listModerationItems(filter: ModerationListFilter, page: PageRequest): Promise<common.Page<ItemRec>>;
  moderationCounts(since: Date): Promise<{ open: number; byQueue: Record<string, number>; byContentType: Record<string, number>; overdue: number; oldestOpenAt: Date | null }>;
  overdueItems(before: Date, limit: number): Promise<ItemRec[]>;
  countReportsByTarget(targetType: string, targetIds: readonly string[]): Promise<Map<string, number>>;

  /* helpful votes */
  upsertVote(row: VoteRec): Promise<void>;
  countHelpful(targetType: string, targetId: string): Promise<number>;
  votedHelpful(targetType: string, targetIds: readonly string[], customerId: string): Promise<Set<string>>;

  /* read models */
  recomputeProductSummary(productId: string, now: Date): Promise<ProductSummaryRec>;
  recomputeSellerSummary(sellerId: string, since: Date, positiveThreshold: number, now: Date): Promise<SellerSummaryRec>;
  productSummaries(productIds: readonly string[]): Promise<ProductSummaryRec[]>;
  sellerSummaries(sellerIds: readonly string[]): Promise<SellerSummaryRec[]>;
  /** Average overall feedback score per seller over the period (the summary table has no overall sum) */
  sellerAverages(sellerIds: readonly string[], since: Date): Promise<Map<string, number>>;
  /** Product ids with reviews or questions, in batches (summaries job) */
  productIdsAfter(after: string | null, limit: number): Promise<string[]>;
  sellerIdsAfter(after: string | null, limit: number): Promise<string[]>;
  /** Questions with at least one published answer per product */
  answeredQuestionCounts(productIds: readonly string[]): Promise<Map<string, number>>;
}
