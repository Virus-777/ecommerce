/**
 * What the reviews service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: reviews.product_reviews, reviews.seller_feedback, reviews.seller_responses, reviews.questions, reviews.answers, reviews.helpful_votes, reviews.reports, reviews.moderation_items, reviews.moderation_decisions, reviews.appeals, reviews.product_rating_summaries, reviews.seller_feedback_summaries. */
export interface ReviewsRepository {}
