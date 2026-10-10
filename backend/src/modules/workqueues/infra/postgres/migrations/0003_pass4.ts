import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: the inventory.merge_candidates queue (inventory's "merge these two SKUs" tasks after a catalog
 * merge used to land in inventory.low_stock) on installs seeded before it, and the open merge-candidate items
 * moved there. It takes the placeholder lead and backup; the boot seed fills them from access coverage.
 */
export const m0003Pass4: Migration = {
  id: '0003_pass4',
  sql: /* sql */ `
insert into workqueues.queues (key, name, area, owner_role, lead_staff_id, backup_staff_id, escalation_route, escalation_label, default_deadline_minutes, business_hours_only, pause_while_waiting, screen, screen_filter, visible_to_seller, active, updated_by, updated_at) values
  ('inventory.merge_candidates', 'SKU merge candidates', 'inventory_warehouse', 'inventory_manager', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
   '[{"afterMinutes":2880,"to":{"kind":"role","key":"official_store_manager","name":"Official Store Manager"},"notify":true}]'::jsonb,
   'Official Store Manager after 48 h', 4320, true, false, 'ops/inventory', 'merge_candidates', false, true, 'system', now())
on conflict (key) do nothing;
update workqueues.items set queue_key = 'inventory.merge_candidates'
 where dedupe_key like 'inventory.merge\\_candidate:%' and queue_key = 'inventory.low_stock';
`,
};
