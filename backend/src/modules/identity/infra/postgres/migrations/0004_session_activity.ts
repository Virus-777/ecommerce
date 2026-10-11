import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Staff sessions go idle after staffIdleMinutes without activity, checked on every admin request
 * (touchStaffSession), not only at refresh. Existing sessions were last active when last refreshed.
 */
export const m0004SessionActivity: Migration = {
  id: '0004_session_activity',
  sql: /* sql */ `
alter table identity.sessions add column last_active_at timestamptz;
update identity.sessions set last_active_at = last_refreshed_at;
alter table identity.sessions alter column last_active_at set not null;
`,
};
