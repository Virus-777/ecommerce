import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Codes are unique case-insensitively among active codes only: a code frees up when its campaign ends
 * or is cancelled (CODE_TAKEN covers active and scheduled campaigns). Lookup indexes for evaluation,
 * reservations, clips and the funding split.
 */
export const m0002CodesAndLookups: Migration = {
  id: '0002_codes_and_lookups',
  sql: /* sql */ `
alter table promotions.coupon_codes drop constraint if exists coupon_codes_code_key;
create unique index coupon_codes_active_code on promotions.coupon_codes (upper(code)) where active;
create index on promotions.coupon_codes (campaign_id, created_at);
create index on promotions.coupon_codes (assigned_customer_id);
create index on promotions.evaluations (input_hash, valid_until);
create index on promotions.redemptions (reservation_id);
create index on promotions.redemptions (idempotency_key);
create index on promotions.redemptions (state, expires_at);
create index on promotions.redemption_lines (redemption_id);
create index on promotions.campaign_log (campaign_id, at);
create index on promotions.participation_offers (offer_id);
create index on promotions.flash_items (offer_id);
create index on promotions.coupon_clips (campaign_id);
create index on promotions.event_reminders (campaign_id, sent_at);
`,
};
