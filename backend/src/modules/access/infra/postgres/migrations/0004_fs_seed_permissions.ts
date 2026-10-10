import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly (fulfillment-service, phase 4): the staff keys of the service for the roles that do
 * its work, on installs whose system roles already exist (a fresh install seeds them from domain/seed.ts at
 * the first registry sync, when this finds no roles). The access spec notes list them:
 * seller_manager reviews enrollments; warehouse_manager receives and views operations; warehouse_worker and
 * returns_manager receive; inventory_manager and order_manager view operations; finance_manager manages fees.
 * The approval actions (reimbursements.approve, fees.change, charges.reverse) keep their seeded limits.
 */
export const m0004FsSeedPermissions: Migration = {
  id: '0004_fs_seed_permissions',
  sql: /* sql */ `
insert into access.role_permissions (role_id, permission_key, granted_by, granted_at)
select r.id, x.permission_key, 'system', now()
from access.roles r
join (values
  ('seller_manager', 'fulfillment-service.enrollment.review'),
  ('warehouse_manager', 'fulfillment-service.inbound.receive'),
  ('warehouse_manager', 'fulfillment-service.operations.view'),
  ('warehouse_worker', 'fulfillment-service.inbound.receive'),
  ('inventory_manager', 'fulfillment-service.operations.view'),
  ('order_manager', 'fulfillment-service.operations.view'),
  ('returns_manager', 'fulfillment-service.inbound.receive'),
  ('finance_manager', 'fulfillment-service.fees.manage')
) as x(role_key, permission_key) on x.role_key = r.key
where r.system and r.archived_at is null
  and exists (select 1 from access.permissions p where p.key = x.permission_key)
on conflict (role_id, permission_key) do nothing;
`,
};
