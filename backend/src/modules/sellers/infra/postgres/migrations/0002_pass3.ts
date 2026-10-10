import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 3: the keyed tax id hash for duplicate checks (applications.tax_id_hash, filled for new and
 * edited applications), and trustEnforcementId on suspensions and warnings so trust.enforcement.reversed
 * can undo exactly what an enforcement created (restrictions already keep it).
 */
export const m0002Pass3: Migration = {
  id: '0002_pass3',
  sql: /* sql */ `
alter table sellers.applications add column tax_id_hash text;
comment on column sellers.applications.tax_id_hash is 'keyed hash of the normalised tax id, for duplicate checks';
create index on sellers.applications (tax_id_hash);
alter table sellers.suspensions add column trust_enforcement_id uuid;
alter table sellers.warnings add column trust_enforcement_id uuid;
create index on sellers.suspensions (trust_enforcement_id) where trust_enforcement_id is not null;
create index on sellers.warnings (trust_enforcement_id) where trust_enforcement_id is not null;
`,
};
