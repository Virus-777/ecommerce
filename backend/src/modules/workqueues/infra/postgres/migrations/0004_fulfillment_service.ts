import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly: the four fulfillment.* queues (seedQueues) on installs seeded before them. Same
 * definitions as domain/catalog.ts QUEUE_SEEDS; they take the placeholder lead and backup, and the boot seed
 * fills them from access coverage (updated_by 'system'). A fresh install gets them from the boot seed too:
 * on conflict, nothing changes.
 */
export const m0004FulfillmentService: Migration = {
  id: '0004_fulfillment_service',
  sql: /* sql */ `
insert into workqueues.queues (key, name, area, owner_role, lead_staff_id, backup_staff_id, escalation_route, escalation_label, default_deadline_minutes, business_hours_only, pause_while_waiting, screen, screen_filter, visible_to_seller, active, updated_by, updated_at) values
  ('fulfillment.receiving', 'Fulfilled by Marketly receiving', 'inventory_warehouse', 'warehouse_manager', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
   '[{"afterMinutes":1440,"to":{"kind":"role","key":"inventory_manager","name":"Inventory Manager"},"notify":true},{"afterMinutes":2880,"to":{"kind":"role","key":"business_owner","name":"Business Owner"},"notify":true}]'::jsonb,
   'Inventory Manager after 24 h, Business Owner after 48 h', 1440, true, false, 'ops/receiving', 'fulfillment_service', false, true, 'system', now()),
  ('fulfillment.reconciliation', 'Fulfilled by Marketly stock differences', 'inventory_warehouse', 'inventory_manager', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
   '[{"afterMinutes":0,"to":{"kind":"role","key":"warehouse_manager","name":"Warehouse Manager"},"notify":true},{"afterMinutes":2880,"to":{"kind":"role","key":"business_owner","name":"Business Owner"},"notify":true}]'::jsonb,
   'Warehouse Manager, Business Owner after 48 h', 2880, true, false, 'ops/inventory', 'service_differences', false, true, 'system', now()),
  ('fulfillment.requests', 'Fulfilled by Marketly orders', 'inventory_warehouse', 'warehouse_manager', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
   '[{"afterMinutes":0,"to":{"kind":"role","key":"order_manager","name":"Order Manager"},"notify":true},{"afterMinutes":1440,"to":{"kind":"role","key":"business_owner","name":"Business Owner"},"notify":true}]'::jsonb,
   'Order Manager, Business Owner after 24 h', 240, false, false, 'ops/pick-pack', 'fulfillment_service', false, true, 'system', now()),
  ('fulfillment.enrollments', 'Fulfilled by Marketly enrollments', 'sellers', 'seller_manager', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
   '[{"afterMinutes":2880,"to":{"kind":"role","key":"business_owner","name":"Business Owner"},"notify":true}]'::jsonb,
   'Business Owner after 48 h', 2880, true, false, 'admin/sellers', 'fulfillment_service', false, true, 'system', now())
on conflict (key) do nothing;
`,
};
