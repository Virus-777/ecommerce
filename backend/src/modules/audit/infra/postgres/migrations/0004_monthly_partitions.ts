import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Monthly partitions (pass 5): audit.entries and audit.entry_targets become tables partitioned by range on
 * `at`, one partition per market month, so the retention purge drops whole months instead of deleting rows.
 *
 * - Partitions live in schema audit_partitions (entries_<name>, entry_targets_<name>) and are listed in
 *   audit.entry_partitions; audit.ensure_entry_partitions(instants, time zone) creates the month around each
 *   instant that no partition covers yet, clipped to its neighbours, so months in the market time zone fit
 *   next to the UTC months this migration makes for existing rows (it cannot read MARKET_TIME_ZONE).
 * - Existing rows move as they are (same seq, hashes untouched); the identity carries on after the old one.
 * - Append-only protection stays: the row trigger is on the parent (cloned to every partition), the
 *   TRUNCATE trigger is on the parent and on each partition (statement triggers are not cloned), and an
 *   event trigger refuses dropping an entries table unless audit.purging is on (only where the migration
 *   role may create event triggers; elsewhere a dropped month still breaks the chain and verify-chain says so).
 * - entry_targets has no foreign key any more: a reference check would scan the month on every drop. It is
 *   written in the same transaction as its entry and carries the entry's at, so it is dropped with it.
 * - Needs PostgreSQL 13 or later (row triggers on a partitioned table); PGlite is 18.
 */
export const m0004MonthlyPartitions: Migration = {
  id: '0004_monthly_partitions',
  sql: /* sql */ `
create schema if not exists audit_partitions;
comment on schema audit_partitions is 'Month partitions of audit.entries and audit.entry_targets (listed in audit.entry_partitions)';

create table audit.entry_partitions (
  name text primary key,
  from_at timestamptz not null,
  to_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (from_at < to_at)
);
comment on table audit.entry_partitions is 'The month partitions of entries and entry_targets ([from_at, to_at), one market month)';
comment on column audit.entry_partitions.name is 'lower bound in UTC as YYYYMMDD_HH24MI: tables audit_partitions.entries_<name> and entry_targets_<name>';
create unique index on audit.entry_partitions (from_at);

-- Creates the partitions (entries and entry_targets) of the month in p_tz around each instant no partition
-- covers yet, clipped to the partitions next to it. Callers hold the chain lock; this also locks on its own.
create function audit.ensure_entry_partitions(p_ats timestamptz[], p_tz text) returns int language plpgsql as $fn$
declare
  t timestamptz;
  local_month timestamp;
  lo timestamptz;
  hi timestamptz;
  suffix text;
  made int := 0;
begin
  foreach t in array coalesce(p_ats, '{}') loop
    continue when t is null or exists (select 1 from audit.entry_partitions p where p.from_at <= t and p.to_at > t);
    perform pg_advisory_xact_lock(107156823700592); -- "auditp"
    continue when exists (select 1 from audit.entry_partitions p where p.from_at <= t and p.to_at > t);
    local_month := date_trunc('month', t at time zone p_tz);
    lo := local_month at time zone p_tz;
    hi := (local_month + interval '1 month') at time zone p_tz;
    lo := greatest(lo, coalesce((select max(p.to_at) from audit.entry_partitions p where p.to_at <= t), lo));
    hi := least(hi, coalesce((select min(p.from_at) from audit.entry_partitions p where p.from_at > t), hi));
    suffix := to_char(lo at time zone 'UTC', 'YYYYMMDD"_"HH24MI');
    execute format('create table audit_partitions.%I partition of audit.entries for values from (%L) to (%L)', 'entries_' || suffix, lo, hi);
    execute format('create trigger entries_no_truncate before truncate on audit_partitions.%I for each statement execute function audit.entries_append_only()', 'entries_' || suffix);
    execute format('create table audit_partitions.%I partition of audit.entry_targets for values from (%L) to (%L)', 'entry_targets_' || suffix, lo, hi);
    insert into audit.entry_partitions (name, from_at, to_at) values (suffix, lo, hi);
    made := made + 1;
  end loop;
  return made;
end
$fn$;

-- Move: the old tables aside, the partitioned ones in their place (constraints and indexes after the copy)
alter table audit.entry_targets drop constraint if exists entry_targets_entry_id_fkey;
alter table audit.entries rename to entries_unpartitioned;
alter sequence audit.entries_seq_seq rename to entries_unpartitioned_seq_seq;
alter table audit.entry_targets rename to entry_targets_unpartitioned;

create table audit.entries (
  id uuid not null,
  seq bigint generated always as identity not null,
  at timestamptz not null,
  actor_kind text not null,
  actor_id text,
  actor_name text,
  actor_roles jsonb not null,
  action text not null,
  action_label text not null,
  module text not null,
  category text not null,
  target_type text not null,
  target_id text not null,
  target_ref text,
  target_label text,
  target_screen text,
  seller_id uuid,
  reason text,
  before jsonb,
  after jsonb,
  before_text text,
  after_text text,
  evidence jsonb not null,
  approval_request_id uuid,
  approval_note text,
  request_id text,
  ip inet,
  visible_to_seller bool not null,
  search tsvector,
  prev_hash bytea not null,
  hash bytea not null
) partition by range (at);

create table audit.entry_targets (
  entry_id uuid not null,
  target_type text not null,
  target_id text not null,
  at timestamptz not null
) partition by range (at);

-- existing rows: one partition per UTC month that has any
select audit.ensure_entry_partitions(array(
  select distinct date_trunc('month', x.at at time zone 'UTC') at time zone 'UTC'
  from (select at from audit.entries_unpartitioned union select at from audit.entry_targets_unpartitioned) x
), 'UTC');

insert into audit.entries overriding system value
  select id, seq, at, actor_kind, actor_id, actor_name, actor_roles, action, action_label, module, category, target_type, target_id,
    target_ref, target_label, target_screen, seller_id, reason, before, after, before_text, after_text, evidence, approval_request_id,
    approval_note, request_id, ip, visible_to_seller, search, prev_hash, hash
  from audit.entries_unpartitioned;
insert into audit.entry_targets select entry_id, target_type, target_id, at from audit.entry_targets_unpartitioned;

-- the identity carries on where the old one stopped
create temporary table audit_next_seq on commit drop as
  select greatest(
    coalesce((select max(seq) from audit.entries), 0) + 1,
    (select case when is_called then last_value + 1 else last_value end from audit.entries_unpartitioned_seq_seq)
  ) as n;

drop table audit.entry_targets_unpartitioned;
drop table audit.entries_unpartitioned;

select setval(pg_get_serial_sequence('audit.entries', 'seq'), (select n from audit_next_seq), false);

alter table audit.entries add primary key (id, at);
alter table audit.entries add unique (seq, at);
create index on audit.entries (at desc, id);
create index on audit.entries (target_type, target_id, at desc);
create index on audit.entries (actor_id, at desc);
create index on audit.entries (category, at desc);
create index on audit.entries (seller_id, at desc) where visible_to_seller;
create index on audit.entries (approval_request_id);
create index on audit.entries using gin (search);
create index on audit.entry_targets (target_type, target_id, at desc);
create index on audit.entry_targets (entry_id);

comment on table audit.entries is 'Append-only (no UPDATE/DELETE grants for the app role). Partitioned by month on at (audit.entry_partitions). hash = sha256(prev_hash || canonical row).';
comment on column audit.entries.search is 'generated: refs, labels, reason, names';
comment on table audit.entry_targets is 'Related targets for history lookups (an order item entry also appears under its order and seller); partitioned like entries';

create trigger entries_append_only before update or delete on audit.entries
  for each row execute function audit.entries_append_only();
create trigger entries_no_truncate before truncate on audit.entries
  for each statement execute function audit.entries_append_only();

-- dropping (a partition of) entries is a purge: refused unless audit.purging is on
create function audit.entries_no_drop() returns event_trigger language plpgsql as $fn$
declare
  o record;
begin
  if coalesce(current_setting('audit.purging', true), '') = 'on' then
    return;
  end if;
  for o in select * from pg_event_trigger_dropped_objects() loop
    if o.object_type = 'table' and o.schema_name in ('audit', 'audit_partitions') and o.object_name like 'entries%' then
      raise exception 'audit.entries is append-only (DROP of % refused)', o.object_identity using errcode = '42501';
    end if;
  end loop;
end
$fn$;
do $do$
begin
  create event trigger audit_entries_no_drop on sql_drop execute function audit.entries_no_drop();
exception when insufficient_privilege then
  raise notice 'audit: the migration role cannot create event triggers; dropping a partition of audit.entries is not refused (verify-chain still detects it)';
end
$do$;
`,
};
