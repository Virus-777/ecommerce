import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/media.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table media.assets (
  id uuid primary key,
  kind text not null,
  purpose text not null,
  status text not null,
  file_name text not null,
  content_type text not null,
  size_bytes bigint not null,
  sha256 text,
  phash bigint,
  width int,
  height int,
  duration_seconds numeric,
  page_count int,
  alt text,
  title text,
  owner_kind text not null,
  owner_id text,
  owner_label text,
  visibility text not null,
  storage_bucket text not null,
  storage_key text not null,
  check_result jsonb,
  rejection_reason text,
  removed_reason text,
  removed_by text,
  retain_until timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null,
  ready_at timestamptz,
  deleted_at timestamptz
);
comment on column media.assets.phash is 'images';
comment on column media.assets.expires_at is 'generated files';
create index on media.assets (owner_kind, owner_id, created_at desc);
create index on media.assets (status, created_at);
create index on media.assets (purpose, created_at);
create index on media.assets (owner_kind, owner_id, phash);
create index on media.assets (retain_until);
create index on media.assets (expires_at);
create table media.renditions (
  asset_id uuid not null,
  size text not null,
  storage_key text not null,
  url text not null,
  width int not null,
  height int not null,
  format text not null,
  bytes bigint not null,
  primary key (asset_id, size, format)
);
create table media.uploads (
  id uuid primary key,
  asset_id uuid not null,
  expected_bytes bigint not null,
  expected_sha256 text,
  url_expires_at timestamptz not null,
  completed_at timestamptz,
  client_ip inet,
  created_by_kind text not null,
  created_by_id text
);
comment on table media.uploads is 'Upload sessions (signed URL issued, waiting for bytes)';
create index on media.uploads (url_expires_at) where completed_at is null;
create table media.usages (
  id uuid primary key,
  asset_id uuid not null,
  module text not null,
  kind text not null,
  ref_id text not null,
  ref_label text,
  evidence bool not null,
  attached_at timestamptz not null,
  detached_at timestamptz
);
create index on media.usages (asset_id) where detached_at is null;
create unique index on media.usages (asset_id, module, kind, ref_id) where detached_at is null;
create index on media.usages (module, kind, ref_id);
create table media.processing_jobs (
  id uuid primary key,
  asset_id uuid not null,
  step text not null check (step in ('scan', 'probe', 'strip', 'renditions', 'transcode', 'check')),
  status text not null,
  attempts int not null,
  provider_ref text,
  error text,
  next_attempt_at timestamptz,
  created_at timestamptz not null,
  finished_at timestamptz
);
create index on media.processing_jobs (status, next_attempt_at);
create index on media.processing_jobs (provider_ref);
create table media.upload_counters (
  owner_kind text not null,
  owner_id text not null,
  day date not null,
  count int not null,
  bytes bigint not null,
  primary key (owner_kind, owner_id, day)
);
comment on table media.upload_counters is 'Daily per-owner counts and bytes for rate limits and quotas';
alter table media.renditions add foreign key (asset_id) references media.assets (id);
alter table media.uploads add foreign key (asset_id) references media.assets (id);
alter table media.usages add foreign key (asset_id) references media.assets (id);
alter table media.processing_jobs add foreign key (asset_id) references media.assets (id);
`,
};
