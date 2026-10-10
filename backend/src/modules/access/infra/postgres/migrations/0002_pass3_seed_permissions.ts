import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Seed permissions added in gap pass 3, for installs whose system roles already exist (a fresh install
 * seeds them from domain/seed.ts at the first registry sync, when this finds no roles):
 * audit.retention.manage for the Business Owner and the Platform Administrator, and offers.offers.view /
 * offers.offers.remove for the Catalog Manager (decision D8: Catalog owns offer suspension).
 * Seeded limits (recommend_only rows) reach existing installs through the registry sync.
 */
export const m0002Pass3SeedPermissions: Migration = {
  id: '0002_pass3_seed_permissions',
  sql: /* sql */ `
insert into access.role_permissions (role_id, permission_key, granted_by, granted_at)
select r.id, x.permission_key, 'system', now()
from access.roles r
join (values
  ('business_owner', 'audit.retention.manage'),
  ('platform_administrator', 'audit.retention.manage'),
  ('catalog_manager', 'offers.offers.view'),
  ('catalog_manager', 'offers.offers.remove')
) as x(role_key, permission_key) on x.role_key = r.key
where r.system and r.archived_at is null
  and exists (select 1 from access.permissions p where p.key = x.permission_key)
on conflict (role_id, permission_key) do nothing;
`,
};
