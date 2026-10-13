/**
 * Seed data every install starts with (applied on boot):
 * baseline policy version 1.0 (decision D-RT2: 30-day window, $7.99 change-of-mind return shipping), active and
 * effective at install, so resolveTerms, eligibility and terms snapshots always have a policy version and a
 * policyVersionId. Nothing is inserted when a version exists.
 */
import type { ReturnsRepository } from '../repository.js';
import { defaultResponsibilities, SEEDED_POLICY_ID } from './rules.js';

export async function seedBaselinePolicy(repo: ReturnsRepository, now: Date): Promise<void> {
  // one transaction: two instances booting together conflict and the second finds the first one's version
  await repo.transaction(async (tx) => {
    if ((await tx.count('policy_versions', {})) > 0) return;
    await tx.insert('policy_versions', {
      id: SEEDED_POLICY_ID,
      version: '1.0',
      status: 'active',
      window_days: 30,
      seller_response_business_days: 2,
      info_reply_days: 7,
      drop_off_days: 7,
      inspection_target_business_days: 2,
      refund_target_business_days: 2,
      responsibilities: defaultResponsibilities({ amount: 799, currency: 'USD' }),
      effective_from: now,
      change_reason: 'Launch baseline',
      approval_request_id: null,
      created_by: JSON.stringify({ kind: 'system', id: null }),
      created_at: now,
    });
  });
}
