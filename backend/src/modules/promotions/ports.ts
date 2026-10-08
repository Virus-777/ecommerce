/**
 * What the promotions service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: promotions.campaigns, promotions.campaign_targets, promotions.eligible_offers, promotions.funding_reviews, promotions.participations, promotions.participation_offers, promotions.flash_items, promotions.coupon_codes, promotions.coupon_clips, promotions.evaluations, promotions.redemptions, promotions.redemption_lines, promotions.usage_counters, promotions.event_reminders, promotions.campaign_log, promotions.campaign_results_daily. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PromotionsRepository {}
