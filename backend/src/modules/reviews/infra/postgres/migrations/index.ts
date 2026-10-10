import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002OfficialStoreId } from './0002_official_store_id.js';
import { m0003TrustEnforcementAndInvites } from './0003_trust_enforcement_and_invites.js';
import { m0004Pass4OverallSumReferrals } from './0004_pass4_overall_sum_referrals.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002OfficialStoreId, m0003TrustEnforcementAndInvites, m0004Pass4OverallSumReferrals];
