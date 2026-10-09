import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Indexes for the lookups the middleware makes on every refresh and every few seconds
 * (verifyRefreshToken, revocationsSince). No new columns.
 */
export const m0002LookupIndexes: Migration = {
  id: '0002_lookup_indexes',
  sql: /* sql */ `
create index sessions_previous_token_hash_idx on identity.sessions (previous_token_hash) where previous_token_hash is not null;
create index sessions_revoked_at_idx on identity.sessions (revoked_at) where revoked_at is not null;
create index guest_sessions_previous_token_hash_idx on identity.guest_sessions (previous_token_hash) where previous_token_hash is not null;
create index guest_sessions_claimed_at_idx on identity.guest_sessions (claimed_at) where claimed_at is not null;
create index accounts_tokens_valid_after_idx on identity.accounts (tokens_valid_after) where tokens_valid_after is not null;
create index invitations_account_id_idx on identity.invitations (account_id) where account_id is not null;
`,
};
