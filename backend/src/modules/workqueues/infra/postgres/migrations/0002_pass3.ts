import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 3: queues pause while waiting (queues.pause_while_waiting, items.waiting_since), the archive
 * stays in Postgres (items.archived_at; nothing is deleted any more) and the queues added to seedQueues
 * (official_store.messages, sellers.accounts, reviews.moderation) on installs seeded before them. They take
 * the placeholder lead and backup; the boot seed fills them from access coverage (updated_by 'system').
 */
export const m0002Pass3: Migration = {
  id: '0002_pass3',
  sql: /* sql */ `
alter table workqueues.queues add column pause_while_waiting bool not null default false;
alter table workqueues.items add column waiting_since timestamptz;
alter table workqueues.items add column archived_at timestamptz;
comment on column workqueues.items.waiting_since is 'set on wait, cleared on resume; used to push due_at when the queue pauses while waiting';
comment on column workqueues.items.archived_at is 'resolved items past itemRetentionDays; rows stay';
create index on workqueues.items (archived_at) where archived_at is not null;
insert into workqueues.queues (key, name, area, owner_role, lead_staff_id, backup_staff_id, escalation_route, escalation_label, default_deadline_minutes, business_hours_only, pause_while_waiting, screen, screen_filter, visible_to_seller, active, updated_by, updated_at) values
  ('official_store.messages', 'Official Store messages', 'support', 'official_store_manager', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
   '[{"afterMinutes":0,"to":{"kind":"role","key":"customer_support_manager","name":"Customer Support Manager"},"notify":true},{"afterMinutes":1440,"to":{"kind":"role","key":"business_owner","name":"Business Owner"},"notify":true}]'::jsonb,
   'Customer Support Manager, Business Owner after 24 h', 240, true, false, 'admin/official', 'messages', false, true, 'system', now()),
  ('sellers.accounts', 'Seller accounts', 'sellers', 'seller_manager', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
   '[{"afterMinutes":2880,"to":{"kind":"role","key":"business_owner","name":"Business Owner"},"notify":true}]'::jsonb,
   'Business Owner after 48 h', 2880, true, false, 'admin/sellers', 'accounts', false, true, 'system', now()),
  ('reviews.moderation', 'Review moderation', 'trust', 'trust_and_risk_manager', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
   '[{"afterMinutes":1440,"to":{"kind":"role","key":"business_owner","name":"Business Owner"},"notify":true}]'::jsonb,
   'Business Owner after 24 h', 1440, true, false, 'admin/reviews', 'moderation', false, true, 'system', now())
on conflict (key) do nothing;
`,
};
