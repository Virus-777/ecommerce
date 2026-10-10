import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: the Platform Administrator reads the action history (audit.entries.view). They are told
 * when the hash-chain check fails and propose retention changes, both on screens behind that key. Installs
 * whose system roles already exist get it here; a fresh install seeds it from domain/seed.ts.
 */
export const m0003Pass4SeedAuditView: Migration = {
  id: '0003_pass4_seed_audit_view',
  sql: /* sql */ `
insert into access.role_permissions (role_id, permission_key, granted_by, granted_at)
select r.id, 'audit.entries.view', 'system', now()
from access.roles r
where r.key = 'platform_administrator' and r.system and r.archived_at is null
  and exists (select 1 from access.permissions p where p.key = 'audit.entries.view')
on conflict (role_id, permission_key) do nothing;
`,
};
