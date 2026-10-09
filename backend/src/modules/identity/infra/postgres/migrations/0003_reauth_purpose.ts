import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Re-auth tokens are bound to a purpose (the step-up purpose of the endpoint that consumes them).
 * Outstanding tokens live a few minutes and have no purpose to backfill, so they are deleted.
 */
export const m0003ReauthPurpose: Migration = {
  id: '0003_reauth_purpose',
  sql: /* sql */ `
delete from identity.reauth_tokens;
alter table identity.reauth_tokens add column purpose text not null;
`,
};
