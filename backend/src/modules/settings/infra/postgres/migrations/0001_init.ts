import type { Migration } from '../../../../../kernel/migrations/index.js';

/** Tables, constraints and indexes from docs/api/spec/modules/settings.json (spec "tables"). */
export const m0001Init: Migration = {
  id: '0001_init',
  sql: /* sql */ `
create table settings.definitions (
  key text primary key,
  module text not null,
  section text not null,
  label text not null,
  description text not null,
  value_type text not null,
  schema jsonb not null,
  default_value jsonb not null,
  editable bool not null,
  approval text not null,
  min_lead_days int not null,
  apply_scopes jsonb not null,
  seller_visible bool not null,
  public bool not null,
  example_value bool not null,
  edit_permission text not null,
  registered_at timestamptz not null,
  unavailable_since timestamptz
);
comment on table settings.definitions is 'Registry synced at boot from module manifests (runtime settings)';
comment on column settings.definitions.schema is 'enum values, min, max, unit';
create index on settings.definitions (module);
create index on settings.definitions (section);
create table settings.values (
  id uuid primary key,
  key text not null,
  version int not null,
  value jsonb not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  apply_scope text not null,
  change_id uuid,
  changed_by_kind text not null,
  changed_by_id text not null,
  approved_by_id text,
  reason text,
  created_at timestamptz not null
);
comment on table settings.values is 'Effective-dated versions; the row in force has effective_from <= now and (effective_to is null or > now)';
create unique index on settings.values (key, version);
create index on settings.values (key, effective_from desc);
create table settings.changes (
  id uuid primary key,
  ref text not null unique,
  status text not null,
  items jsonb not null,
  effective_at timestamptz not null,
  apply_scope text not null,
  reason text not null,
  impact jsonb not null,
  created_by_kind text not null,
  created_by_id text not null,
  created_at timestamptz not null,
  submitted_at timestamptz,
  approval_request_id uuid,
  applied_at timestamptz,
  cancel_reason text,
  version int not null,
  announced_at timestamptz
);
comment on column settings.changes.announced_at is 'seller-visible changes: when sellers were told';
create index on settings.changes (status, effective_at);
create index on settings.changes (created_at desc);
create table settings.change_keys (
  change_id uuid not null,
  key text not null,
  open bool not null
);
comment on table settings.change_keys is 'Keys touched by open changes, to block overlapping scheduled changes';
create unique index on settings.change_keys (key) where open;
create table settings.feature_flags (
  key text primary key,
  module text not null,
  label text not null,
  description text not null,
  enabled bool not null,
  rollout text not null,
  percentage int,
  public bool not null,
  planned_phase int,
  updated_by text,
  updated_at timestamptz
);
alter table settings.values add foreign key (key) references settings.definitions (key);
alter table settings.values add foreign key (change_id) references settings.changes (id);
alter table settings.change_keys add foreign key (change_id) references settings.changes (id);
`,
};
