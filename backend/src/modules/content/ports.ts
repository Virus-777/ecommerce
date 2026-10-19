/** Row types and filter shapes the content repository and service share. */
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
export type NewsCategoryRow = ContentDb['news_categories'];
export type NewsRow = ContentDb['news_posts'];

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
