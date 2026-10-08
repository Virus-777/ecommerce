import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/advertising.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table advertising.placements (
  id uuid primary key,
  key text not null unique,
  name text not null,
  kind text not null,
  enabled bool not null,
  availability text not null,
  eligible_pages jsonb not null,
  formats jsonb not null,
  frequency_cap jsonb,
  trigger jsonb,
  rotation jsonb not null,
  dismissal jsonb not null,
  max_per_page int,
  positions jsonb,
  label text not null,
  description text not null,
  version int not null,
  updated_by text,
  updated_at timestamptz not null
);
comment on table advertising.placements is 'One row per placement type with its rules';
create table advertising.global_rules (
  version int primary key,
  rules jsonb not null,
  effective_at timestamptz not null,
  approval_request_id uuid,
  created_by text not null,
  created_at timestamptz not null
);
comment on table advertising.global_rules is 'Versioned global rules; current = highest effective version';
create table advertising.campaigns (
  id uuid primary key,
  ref text not null unique,
  name text not null,
  origin text not null check (origin in ('staff', 'seller_request')),
  advertiser_kind text not null,
  seller_id uuid,
  brand_id uuid,
  goal text not null,
  owner_staff_id uuid,
  linked_promotion_id uuid,
  placement_id uuid not null,
  pages jsonb not null,
  page_category_ids jsonb not null,
  audience jsonb not null,
  destination jsonb not null,
  starts_at timestamptz,
  ends_at timestamptz,
  time_zone text not null,
  frequency_cap jsonb not null,
  dismissal jsonb not null,
  priority int not null,
  billing text not null,
  rate bigint,
  daily_limit bigint,
  total_limit bigint,
  delivery_cap int,
  spent bigint not null,
  currency text not null,
  stop_with_promotion bool not null,
  after_approval text not null check (after_approval in ('schedule', 'activate')),
  status text not null,
  paused_reason text,
  finished_reason text,
  note_to_reviewers text,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version int not null
);
create index on advertising.campaigns (status, starts_at);
create index on advertising.campaigns (status, ends_at);
create index on advertising.campaigns (placement_id, status);
create index on advertising.campaigns (seller_id, status);
create index on advertising.campaigns (linked_promotion_id);
create table advertising.campaign_items (
  campaign_id uuid not null,
  kind text not null,
  target_id uuid not null,
  label text
);
comment on table advertising.campaign_items is 'Promoted offers, products, stores or brands';
create index on advertising.campaign_items (kind, target_id);
create table advertising.campaign_creatives (
  campaign_id uuid not null,
  creative_id uuid not null,
  device text not null
);
create unique index on advertising.campaign_creatives (campaign_id, creative_id);
create table advertising.approval_steps (
  id uuid primary key,
  campaign_id uuid not null,
  submission int not null,
  role text not null,
  reviewer_id text,
  state text not null,
  note text,
  decided_at timestamptz
);
comment on table advertising.approval_steps is 'Required reviewers per campaign submission';
create table advertising.creatives (
  id uuid primary key,
  advertiser_kind text not null,
  seller_id uuid,
  brand_id uuid,
  kind text not null,
  device text not null,
  placement_key text not null,
  media_id uuid,
  file_name text,
  width int,
  height int,
  bytes int,
  duration_seconds int,
  headline text,
  body text,
  button_text text,
  link text,
  status text not null,
  link_check jsonb not null,
  auto_checks jsonb not null,
  created_by text not null,
  created_at timestamptz not null
);
comment on table advertising.creatives is 'Creative library';
create index on advertising.creatives (status, created_at);
create index on advertising.creatives (seller_id);
create table advertising.creative_reviews (
  id uuid primary key,
  creative_id uuid not null,
  reviewer_id text not null,
  role text not null,
  decision text not null,
  reason_code text,
  comment text,
  at timestamptz not null
);
create table advertising.campaign_log (
  id uuid primary key,
  campaign_id uuid not null,
  action text not null,
  from_status text,
  to_status text,
  reason text,
  actor_kind text not null,
  actor_id text,
  at timestamptz not null
);
comment on table advertising.campaign_log is 'Lifecycle timeline with actor and reason';
create table advertising.ad_events (
  id uuid primary key,
  impression_id uuid not null,
  campaign_id uuid not null,
  creative_id uuid not null,
  placement_key text not null,
  kind text not null,
  visitor_key text not null,
  session_id text not null,
  customer_id uuid,
  page text not null,
  device text not null,
  at timestamptz not null,
  cost bigint
);
comment on table advertising.ad_events is 'Displays, clicks, dismissals (append-only, partitioned by day; retained 13 months)';
comment on column advertising.ad_events.visitor_key is 'hashed';
create index on advertising.ad_events (campaign_id, at);
create index on advertising.ad_events (visitor_key, campaign_id, kind, at);
create table advertising.frequency_state (
  visitor_key text not null,
  campaign_id uuid not null,
  session_id text,
  session_displays int not null,
  window_displays int not null,
  window_started_at timestamptz not null,
  last_display_at timestamptz,
  suppressed_until timestamptz
);
comment on table advertising.frequency_state is 'Per visitor and campaign counters and suppression (TTL-cleaned)';
create unique index on advertising.frequency_state (visitor_key, campaign_id);
create table advertising.attributions (
  id uuid primary key,
  order_id uuid not null,
  campaign_id uuid not null,
  click_event_id uuid not null,
  amount bigint not null,
  currency text not null,
  attributed_at timestamptz not null,
  reversed bool not null
);
comment on table advertising.attributions is 'Orders attributed to a click within the attribution period';
create unique index on advertising.attributions (order_id, campaign_id);
create table advertising.daily_stats (
  campaign_id uuid not null,
  day date not null,
  displays int not null,
  clicks int not null,
  dismissals int not null,
  spend bigint not null,
  attributed_orders int not null,
  attributed_sales bigint not null
);
comment on table advertising.daily_stats is 'Read model per campaign and day';
create unique index on advertising.daily_stats (campaign_id, day);
create table advertising.ad_charges (
  id uuid primary key,
  campaign_id uuid not null,
  seller_id uuid not null,
  day date not null,
  basis text not null,
  units int not null,
  rate bigint not null,
  amount bigint not null,
  currency text not null,
  state text not null,
  posted_at timestamptz,
  statement_ref text,
  reason text
);
comment on table advertising.ad_charges is 'Seller ad charges per campaign and day, posted to finance as a separate statement line';
create unique index on advertising.ad_charges (campaign_id, day);
create index on advertising.ad_charges (seller_id, state);
alter table advertising.campaigns add foreign key (placement_id) references advertising.placements (id);
alter table advertising.campaign_items add foreign key (campaign_id) references advertising.campaigns (id);
alter table advertising.campaign_creatives add foreign key (campaign_id) references advertising.campaigns (id);
alter table advertising.campaign_creatives add foreign key (creative_id) references advertising.creatives (id);
alter table advertising.approval_steps add foreign key (campaign_id) references advertising.campaigns (id);
alter table advertising.creative_reviews add foreign key (creative_id) references advertising.creatives (id);
alter table advertising.campaign_log add foreign key (campaign_id) references advertising.campaigns (id);
alter table advertising.ad_charges add foreign key (campaign_id) references advertising.campaigns (id);
`,
};
