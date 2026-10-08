import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/promotions.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table promotions.campaigns (
  id uuid primary key,
  ref text not null unique,
  name text not null,
  description text,
  internal_note text,
  owner_kind text not null check (owner_kind in ('platform', 'seller')),
  seller_id uuid,
  kind text not null,
  discount jsonb not null,
  auto_apply bool not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  time_zone text not null,
  scope_mode text not null,
  eligibility jsonb not null,
  budget_amount bigint,
  budget_used bigint not null,
  usage_cap int,
  usage_count int not null,
  per_customer int,
  per_order int,
  per_customer_units int,
  funding_owner text not null,
  platform_share_bps int,
  cost_center text,
  stacking jsonb not null,
  exclusive_group text,
  participation jsonb,
  deals jsonb,
  terms text,
  status text not null,
  ended_reason text,
  approval_request_id uuid,
  currency text not null,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version int not null
);
comment on table promotions.campaigns is 'Platform campaigns and seller discounts (owner_kind). Seller discounts are seller-funded and skip Finance confirmation.';
create index on promotions.campaigns (status, starts_at);
create index on promotions.campaigns (status, ends_at);
create index on promotions.campaigns (seller_id, status);
create index on promotions.campaigns (owner_kind, status, id);
create table promotions.campaign_targets (
  campaign_id uuid not null,
  kind text not null,
  target_id uuid not null,
  excluded bool not null,
  label text
);
comment on table promotions.campaign_targets is 'Included and excluded categories, products, offers, sellers, brands';
create unique index on promotions.campaign_targets (campaign_id, kind, target_id);
create index on promotions.campaign_targets (kind, target_id);
create table promotions.eligible_offers (
  campaign_id uuid not null,
  offer_id uuid not null,
  seller_id uuid not null,
  official_store bool not null,
  eligible bool not null,
  reason text,
  refreshed_at timestamptz not null
);
comment on table promotions.eligible_offers is 'Resolved offer set per campaign (rebuilt on scope change and offer events) for fast evaluation and the eligible count';
create index on promotions.eligible_offers (offer_id, campaign_id);
create index on promotions.eligible_offers (campaign_id, seller_id);
create table promotions.funding_reviews (
  id uuid primary key,
  campaign_id uuid not null,
  state text not null,
  sent_at timestamptz not null,
  reviewer_id text,
  decided_at timestamptz,
  checks jsonb not null,
  platform_max bigint not null,
  sellers_max bigint not null,
  expected_sales bigint,
  margin_impact_pts numeric,
  comment text,
  approval_request_id uuid
);
comment on table promotions.funding_reviews is 'Finance confirmation per submission';
create table promotions.participations (
  id uuid primary key,
  campaign_id uuid not null,
  seller_id uuid not null,
  state text not null,
  seller_share_bps int not null,
  platform_share_bps int not null,
  respond_by timestamptz,
  consented_at timestamptz,
  consented_by text,
  consent_text text,
  reason text,
  updated_at timestamptz not null
);
comment on table promotions.participations is 'Seller invitations and consent for platform campaigns';
create unique index on promotions.participations (campaign_id, seller_id);
create index on promotions.participations (seller_id, state);
create table promotions.participation_offers (
  participation_id uuid not null,
  offer_id uuid not null,
  eligible bool not null,
  ineligible_reasons jsonb not null,
  included bool not null
);
create unique index on promotions.participation_offers (participation_id, offer_id);
create table promotions.flash_items (
  id uuid primary key,
  campaign_id uuid not null,
  offer_id uuid not null,
  deal_price bigint not null,
  regular_price bigint not null,
  deal_stock int not null,
  claimed int not null,
  reserved int not null,
  purchase_limit int not null,
  state text not null,
  sold_out_at timestamptz
);
comment on table promotions.flash_items is 'Deal price, deal stock and purchase limit per offer in a flash sale';
create unique index on promotions.flash_items (campaign_id, offer_id);
create table promotions.coupon_codes (
  id uuid primary key,
  campaign_id uuid not null,
  code text not null unique,
  kind text not null check (kind in ('shared', 'unique')),
  max_redemptions int,
  redemptions int not null,
  assigned_customer_id uuid,
  active bool not null,
  created_at timestamptz not null
);
comment on column promotions.coupon_codes.code is 'case-insensitive';
create table promotions.coupon_clips (
  customer_id uuid not null,
  campaign_id uuid not null,
  code_id uuid,
  clipped_at timestamptz not null
);
comment on table promotions.coupon_clips is 'Coupons a customer clipped; applied automatically at checkout';
create unique index on promotions.coupon_clips (customer_id, campaign_id);
create table promotions.evaluations (
  id uuid primary key,
  input_hash text not null,
  result jsonb not null,
  valid_until timestamptz not null
);
comment on table promotions.evaluations is 'Short-lived cart evaluations referenced by reservations';
create table promotions.redemptions (
  id uuid primary key,
  campaign_id uuid not null,
  code_id uuid,
  reservation_id uuid not null,
  idempotency_key text not null,
  evaluation_id uuid not null,
  order_id uuid,
  customer_id uuid,
  guest_key text,
  state text not null,
  amount bigint not null,
  platform_part bigint not null,
  seller_part bigint not null,
  reversed bigint not null,
  currency text not null,
  expires_at timestamptz,
  created_at timestamptz not null
);
comment on table promotions.redemptions is 'Reserved then committed discounts per order';
create unique index on promotions.redemptions (reservation_id, campaign_id);
create index on promotions.redemptions (campaign_id, state);
create index on promotions.redemptions (customer_id, campaign_id);
create index on promotions.redemptions (order_id);
create table promotions.redemption_lines (
  redemption_id uuid not null,
  line_id text not null,
  order_item_id uuid,
  offer_id uuid not null,
  seller_id uuid not null,
  quantity int not null,
  amount bigint not null,
  platform_part bigint not null,
  seller_part bigint not null,
  reversed bigint not null
);
comment on table promotions.redemption_lines is 'Per order item allocation; the source for fundingSplitFor and refundShare';
create index on promotions.redemption_lines (order_item_id);
create table promotions.usage_counters (
  campaign_id uuid not null,
  customer_key text not null,
  uses int not null,
  units int not null
);
comment on table promotions.usage_counters is 'Per-customer uses and units for limits (row-locked during reservation)';
comment on column promotions.usage_counters.customer_key is 'customer id or guest email hash';
create unique index on promotions.usage_counters (campaign_id, customer_key);
create table promotions.event_reminders (
  customer_id uuid not null,
  campaign_id uuid not null,
  created_at timestamptz not null,
  sent_at timestamptz
);
comment on table promotions.event_reminders is 'Remind me on upcoming Deals events';
create unique index on promotions.event_reminders (customer_id, campaign_id);
create table promotions.campaign_log (
  id uuid primary key,
  campaign_id uuid not null,
  action text not null,
  reason text,
  detail jsonb,
  actor_kind text not null,
  actor_id text,
  at timestamptz not null
);
comment on table promotions.campaign_log is 'Every submission, decision, status change, edit and removal with reason';
create table promotions.campaign_results_daily (
  campaign_id uuid not null,
  day date not null,
  sales bigint not null,
  orders int not null,
  cost_platform bigint not null,
  cost_seller bigint not null,
  redemptions int not null,
  returned_items int not null,
  official_cost_basis bigint not null,
  official_revenue bigint not null
);
comment on table promotions.campaign_results_daily is 'Read model rolled up from order, redemption and return events';
create unique index on promotions.campaign_results_daily (campaign_id, day);
alter table promotions.campaign_targets add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.eligible_offers add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.funding_reviews add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.participations add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.participation_offers add foreign key (participation_id) references promotions.participations (id);
alter table promotions.flash_items add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.coupon_codes add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.coupon_clips add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.coupon_clips add foreign key (code_id) references promotions.coupon_codes (id);
alter table promotions.redemptions add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.redemption_lines add foreign key (redemption_id) references promotions.redemptions (id);
alter table promotions.usage_counters add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.event_reminders add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.campaign_log add foreign key (campaign_id) references promotions.campaigns (id);
alter table promotions.campaign_results_daily add foreign key (campaign_id) references promotions.campaigns (id);
`,
};
