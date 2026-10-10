import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: alerts.armed_at. A back-in-stock alert fires only once what it follows was seen unavailable, so one
 * switched on while the item is in stock no longer fires at the next job run. Existing alerts keep the behaviour
 * they were created with (armed since creation): their item's availability then is not known, and the job has had
 * the chance to fire the in-stock ones already.
 */
export const m0003AlertArmedAt: Migration = {
  id: '0003_alert_armed_at',
  sql: /* sql */ `
alter table wishlist.alerts add column armed_at timestamptz;
comment on column wishlist.alerts.armed_at is 'back_in_stock: when what the alert follows was last seen unavailable; the alert fires only once armed';
update wishlist.alerts set armed_at = created_at;
`,
};
