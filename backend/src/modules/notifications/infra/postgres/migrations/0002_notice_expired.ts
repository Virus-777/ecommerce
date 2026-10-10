import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 3: action notices that ended without being resolved are expired (Notice.state expired, expiredAt),
 * never shown as resolved. Notices the purge job had marked "resolved" with the note 'expired' move over.
 */
export const m0002NoticeExpired: Migration = {
  id: '0002_notice_expired',
  sql: /* sql */ `
alter table notifications.notices add column expired_at timestamptz;
comment on column notifications.notices.expired_at is 'action notices that ended without being resolved';
update notifications.notices set expired_at = resolved_at, resolved_at = null, resolve_note = null where resolve_note = 'expired' and resolved_at is not null;
`,
};
