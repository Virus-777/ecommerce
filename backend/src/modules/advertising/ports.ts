/**
 * What the advertising service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: advertising.placements, advertising.global_rules, advertising.campaigns, advertising.campaign_items, advertising.campaign_creatives, advertising.approval_steps, advertising.creatives, advertising.creative_reviews, advertising.campaign_log, advertising.ad_events, advertising.frequency_state, advertising.attributions, advertising.daily_stats, advertising.ad_charges. */
export interface AdvertisingRepository {}
