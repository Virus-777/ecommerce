import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Signed chain checkpoints (gap pass 3): written after each successful verification and before a purge.
 * mac is a hex HMAC-SHA256 over seq and hash keyed with secretFor(config, 'audit.checkpoint'), a key the
 * database never holds, so rewriting entries and recomputing every hash is still detected.
 */
export const m0003Checkpoints: Migration = {
  id: '0003_checkpoints',
  sql: /* sql */ `
create table audit.checkpoints (
  id uuid primary key,
  seq bigint not null unique,
  hash bytea not null,
  mac text not null,
  key_id text not null,
  kind text not null check (kind in ('verified', 'purge')),
  created_at timestamptz not null
);
comment on table audit.checkpoints is 'Signed chain checkpoints: verification continues across purged ranges and a rewritten chain is detected even if every hash was recomputed';
create index on audit.checkpoints (created_at desc);
`,
};
