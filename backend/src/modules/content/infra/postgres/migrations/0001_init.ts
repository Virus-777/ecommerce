import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/content.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table content.home_sections (
  id uuid primary key,
  kind text not null,
  heading text,
  subheading text,
  config jsonb not null,
  linked_promotion_id uuid,
  linked_page_id uuid,
  ad_placement_key text,
  show_from timestamptz,
  remove_at timestamptz,
  time_zone text not null,
  owner_staff_id uuid,
  owner_role text,
  status text not null,
  draft_position int not null,
  removed_reason text,
  updated_by text not null,
  updated_at timestamptz not null
);
comment on table content.home_sections is 'Homepage sections (draft state); ad positions are rows with kind ad_position and a placement key';
create table content.pages (
  id uuid primary key,
  kind text not null,
  collection_kind text,
  slug text not null unique,
  title text not null,
  brand_id uuid,
  owner_staff_id uuid,
  linked_promotion_id uuid,
  status text not null,
  publish_at timestamptz,
  unpublish_at timestamptz,
  time_zone text not null,
  live_version_id uuid,
  draft_version_id uuid,
  removal jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
comment on table content.pages is 'Campaign pages, collections, About and landing pages';
create index on content.pages (kind, status);
create index on content.pages (brand_id, status);
create index on content.pages (status, publish_at);
create index on content.pages (status, unpublish_at);
create table content.versions (
  id uuid primary key,
  entity text not null check (entity in ('homepage', 'page', 'article')),
  entity_id uuid not null,
  number int not null,
  state text not null,
  snapshot jsonb not null,
  summary text,
  author_kind text not null,
  author_id text,
  restored_from int,
  created_at timestamptz not null,
  published_at timestamptz
);
comment on table content.versions is 'Immutable snapshots of homepage layouts, pages and articles. Restore copies a snapshot into a new version.';
create unique index on content.versions (entity, entity_id, number);
create table content.help_categories (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  icon text,
  description text,
  position int not null,
  visible bool not null,
  audience text not null
);
create table content.help_articles (
  id uuid primary key,
  slug text not null unique,
  category_id uuid not null,
  title text not null,
  summary text,
  audience text not null,
  topics jsonb not null,
  related_ids jsonb not null,
  policy_keys jsonb not null,
  featured bool not null,
  popular_search text,
  owner_staff_id uuid,
  status text not null,
  publish_at timestamptz,
  unpublish_at timestamptz,
  effective_at timestamptz,
  review_due_at timestamptz,
  live_version_id uuid,
  draft_version_id uuid,
  views int not null,
  search tsvector,
  updated_at timestamptz not null
);
comment on column content.help_articles.search is 'generated from live version';
create index on content.help_articles (category_id, status);
create index on content.help_articles using gin (search);
create index on content.help_articles (status, review_due_at);
create table content.article_feedback (
  id uuid primary key,
  article_id uuid not null,
  helpful bool not null,
  comment text,
  visitor_key text not null,
  customer_id uuid,
  at timestamptz not null
);
create unique index on content.article_feedback (article_id, visitor_key);
create table content.policies (
  id uuid primary key,
  key text not null unique,
  title text not null,
  owner_staff_id uuid not null,
  editor_staff_id uuid,
  audience text not null check (audience in ('customer', 'seller', 'both'))
);
create table content.policy_versions (
  id uuid primary key,
  policy_id uuid not null,
  version text not null,
  state text not null,
  title text not null,
  body text not null,
  tables jsonb,
  effective_at timestamptz,
  change_summary text,
  impact text not null,
  notify_customers bool not null,
  notify_sellers bool not null,
  approval_request_id uuid,
  created_by text not null,
  created_at timestamptz not null,
  published_at timestamptz
);
comment on table content.policy_versions is 'Never edited after approval; orders reference these ids';
create unique index on content.policy_versions (policy_id, version);
create index on content.policy_versions (policy_id, state, effective_at);
create table content.policy_approvals (
  id uuid primary key,
  policy_version_id uuid not null,
  role text not null,
  reviewer_id text,
  state text not null,
  note text,
  at timestamptz
);
create table content.navigation (
  id uuid primary key,
  area text not null check (area in ('header', 'footer', 'service_strip')),
  group_title text,
  position int not null,
  label text not null,
  url text not null,
  kind text not null,
  text text,
  active_from timestamptz,
  active_until timestamptz
);
comment on table content.navigation is 'Header and footer link groups (versioned through versions with entity page kind ''navigation'' is not needed; edits are audited)';
comment on column content.navigation.text is 'service_strip only';
create table content.content_log (
  id uuid primary key,
  entity text not null,
  entity_id uuid not null,
  action text not null,
  reason text,
  actor_kind text not null,
  actor_id text,
  at timestamptz not null
);
comment on table content.content_log is 'Publication, schedule, unpublish, correction and removal actions with reasons';
alter table content.pages add foreign key (live_version_id) references content.versions (id);
alter table content.pages add foreign key (draft_version_id) references content.versions (id);
alter table content.help_articles add foreign key (category_id) references content.help_categories (id);
alter table content.help_articles add foreign key (live_version_id) references content.versions (id);
alter table content.help_articles add foreign key (draft_version_id) references content.versions (id);
alter table content.article_feedback add foreign key (article_id) references content.help_articles (id);
alter table content.policy_versions add foreign key (policy_id) references content.policies (id);
alter table content.policy_approvals add foreign key (policy_version_id) references content.policy_versions (id);
`,
};
