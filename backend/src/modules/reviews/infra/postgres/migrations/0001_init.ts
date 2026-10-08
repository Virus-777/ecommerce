import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/reviews.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table reviews.product_reviews (
  id uuid primary key,
  product_id uuid not null,
  variant_id uuid,
  order_item_id uuid not null,
  order_id uuid not null,
  seller_id uuid not null,
  customer_id uuid not null,
  display_name text not null,
  show_name bool not null,
  verified bool not null,
  rating int not null,
  headline text not null,
  body text not null,
  media_ids jsonb not null,
  status text not null,
  visible bool not null,
  helpful_count int not null,
  created_at timestamptz not null,
  published_at timestamptz,
  edited_at timestamptz
);
comment on table reviews.product_reviews is 'One review per customer per product (latest delivered purchase); Verified Purchase when linked to a delivered order item';
create unique index on reviews.product_reviews (customer_id, product_id);
create index on reviews.product_reviews (product_id, status, helpful_count desc);
create index on reviews.product_reviews (product_id, status, published_at desc);
create index on reviews.product_reviews (seller_id, published_at desc);
create table reviews.seller_feedback (
  id uuid primary key,
  seller_id uuid not null,
  order_id uuid not null,
  customer_id uuid not null,
  display_name text not null,
  as_described bool not null,
  dispatch_rating int not null,
  communication_rating int,
  overall int not null,
  sentiment text not null,
  comment text,
  status text not null,
  visible bool not null,
  created_at timestamptz not null,
  edited_at timestamptz
);
comment on table reviews.seller_feedback is 'One per customer per seller package (order seller group)';
create unique index on reviews.seller_feedback (order_id, seller_id, customer_id);
create index on reviews.seller_feedback (seller_id, status, created_at desc);
create table reviews.seller_responses (
  id uuid primary key,
  target_type text not null,
  target_id uuid not null,
  seller_id uuid not null,
  text text not null,
  status text not null,
  rule_check jsonb not null,
  created_by text not null,
  created_at timestamptz not null,
  published_at timestamptz,
  editable_until timestamptz not null
);
create unique index on reviews.seller_responses (target_type, target_id);
create index on reviews.seller_responses (seller_id, status);
create table reviews.questions (
  id uuid primary key,
  product_id uuid not null,
  customer_id uuid not null,
  display_name text not null,
  text text not null,
  status text not null,
  answer_count int not null,
  created_at timestamptz not null
);
create index on reviews.questions (product_id, status, created_at desc);
create table reviews.answers (
  id uuid primary key,
  question_id uuid not null,
  author_kind text not null,
  author_id text not null,
  seller_id uuid,
  display_name text not null,
  text text not null,
  status text not null,
  rule_check jsonb not null,
  helpful_count int not null,
  created_at timestamptz not null,
  published_at timestamptz
);
create index on reviews.answers (question_id, status);
create index on reviews.answers (seller_id);
create table reviews.helpful_votes (
  target_type text not null,
  target_id uuid not null,
  customer_id uuid not null,
  helpful bool not null,
  at timestamptz not null
);
create unique index on reviews.helpful_votes (target_type, target_id, customer_id);
create table reviews.reports (
  id uuid primary key,
  target_type text not null,
  target_id uuid not null,
  moderation_item_id uuid not null,
  reporter_kind text not null,
  reporter_id text,
  reason text not null,
  note text,
  status text not null,
  outcome_text text,
  created_at timestamptz not null,
  decided_at timestamptz
);
create index on reviews.reports (reporter_kind, reporter_id, created_at desc);
create index on reviews.reports (moderation_item_id);
create table reviews.moderation_items (
  id uuid primary key,
  content_type text not null,
  content_id uuid not null,
  queue text not null,
  status text not null,
  visibility text not null,
  reasons jsonb not null,
  report_count int not null,
  first_reported_at timestamptz not null,
  decided_at timestamptz
);
comment on table reviews.moderation_items is 'One open item per piece of content under review; reports attach to it';
create index on reviews.moderation_items (status, queue, first_reported_at);
create index on reviews.moderation_items (content_type, content_id);
create table reviews.moderation_decisions (
  id uuid primary key,
  moderation_item_id uuid not null,
  decision text not null,
  reason_code text not null,
  message_to_reporter text,
  message_to_author text,
  edit_request text,
  moderator_id uuid not null,
  decided_at timestamptz not null,
  appeal_by timestamptz
);
create index on reviews.moderation_decisions (moderation_item_id);
create table reviews.appeals (
  id uuid primary key,
  decision_id uuid not null,
  content_type text not null,
  content_id uuid not null,
  by_kind text not null,
  by_id text not null,
  reason text not null,
  status text not null,
  reviewer_id uuid,
  outcome text,
  submitted_at timestamptz not null,
  decided_at timestamptz
);
create index on reviews.appeals (status, submitted_at);
create table reviews.product_rating_summaries (
  product_id uuid primary key,
  rating_count int not null,
  written_count int not null,
  sum_ratings int not null,
  distribution jsonb not null,
  with_photos int not null,
  answered_questions int not null,
  updated_at timestamptz not null
);
comment on table reviews.product_rating_summaries is 'Projection updated on publish, edit, removal and merge';
create table reviews.seller_feedback_summaries (
  seller_id uuid primary key,
  count int not null,
  positive int not null,
  neutral int not null,
  negative int not null,
  as_described_yes int not null,
  dispatch_sum int not null,
  communication_sum int not null,
  communication_count int not null,
  updated_at timestamptz not null
);
comment on table reviews.seller_feedback_summaries is 'Rolling 12-month projection per seller';
alter table reviews.answers add foreign key (question_id) references reviews.questions (id);
alter table reviews.reports add foreign key (moderation_item_id) references reviews.moderation_items (id);
alter table reviews.moderation_decisions add foreign key (moderation_item_id) references reviews.moderation_items (id);
alter table reviews.appeals add foreign key (decision_id) references reviews.moderation_decisions (id);
`,
};
