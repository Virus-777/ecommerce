/**
 * Row types of the reviews collections and the list filters the repository (repository.ts) takes.
 */
import type { ReviewsDb } from '../../spec/reviews.js';

export type Db = ReviewsDb;
/** The reviews collections (spec tables) */
export type TableName = keyof Db & string;
/** Tables keyed by `id` */
export type IdTable = Exclude<TableName, 'helpful_votes' | 'product_rating_summaries' | 'seller_feedback_summaries' | 'review_invites'>;

export type ReviewRec = Db['product_reviews'];
export type FeedbackRec = Db['seller_feedback'];
export type ResponseRec = Db['seller_responses'];
export type QuestionRec = Db['questions'];
export type AnswerRec = Db['answers'];
export type VoteRec = Db['helpful_votes'];
export type ReportRec = Db['reports'];
export type ItemRec = Db['moderation_items'];
export type DecisionRec = Db['moderation_decisions'];
export type ReferralRec = Db['referrals'];
export type AppealRec = Db['appeals'];
export type ProductSummaryRec = Db['product_rating_summaries'];
export type SellerSummaryRec = Db['seller_feedback_summaries'];

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
