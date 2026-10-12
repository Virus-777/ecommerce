/**
 * Gap pass 4: payout_changes (instead of applications.payout jsonb), sellers.payout_blocked_reasons, suspensions.ref,
 * pending_changes for closures, restriction changes and targets waiting for a second reviewer, the SAP- appeal
 * prefix. (Migration 0003, which backfilled them on PostgreSQL installs, is not ported: every MongoDB install starts fresh.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/sellers.js';
import { schemas } from '../infra/mongo/schema.js';
import { ADMIN, approvedSeller, boot, type Kit, payoutInput, restrictionInput, SELLER, staff } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => {
  await kit?.close();
});

const table = (name: string) => kit.app.kernel.mongo.module('sellers', spec.collections, schemas).table<any>(name);
const futureDate = (days: number) => new Date(kit.clock.now().getTime() + days * 86_400_000).toISOString().slice(0, 10);

describe('payout_changes', () => {
  it('records each destination handed to finance; verified replaces the current one', async () => {
    const s = await approvedSeller(kit);
    let rows = await table('payout_changes').find({ seller_id: s.sellerId });
    expect(rows).toEqual([expect.objectContaining({ kind: 'initial', state: 'pending', label: 'Checking •••• 7731' })]);
    const initialId = rows[0].id;
    expect(kit.last('sellers.payout_account.changed')).toMatchObject({ changeId: initialId, isInitial: true });
    await kit.emit('finance', 'finance.destination.verified', { sellerId: s.sellerId, reviewId: newId() });

    const body = { details: payoutInput('000999881234', 'Ana Lopez'), reauthToken: 'dev-reauth.payout-account' };
    await kit.call('POST', `${SELLER}/payout-account/change`, s.sellerToken, body, { 'idempotency-key': newId() });
    await kit.emit('finance', 'finance.destination.rejected', { sellerId: s.sellerId, reviewId: newId(), reason: 'Name does not match' });
    await kit.call('POST', `${SELLER}/payout-account/change`, s.sellerToken, body, { 'idempotency-key': newId() });
    await kit.emit('finance', 'finance.destination.verified', { sellerId: s.sellerId, reviewId: newId() });

    rows = await table('payout_changes').find({ seller_id: s.sellerId });
    const byState = (st: string) => rows.filter((r: { state: string }) => r.state === st);
    expect(byState('replaced')).toEqual([expect.objectContaining({ id: initialId })]);
    expect(byState('rejected')).toEqual([expect.objectContaining({ kind: 'change', rejection_reason: 'Name does not match', previous_label: 'Checking •••• 7731' })]);
    expect(byState('verified')).toEqual([expect.objectContaining({ kind: 'change', label: 'Checking •••• 1234', review_id: expect.any(String) })]);
    expect((await kit.call('GET', `${SELLER}/payout-account`, s.sellerToken)).body).toMatchObject({ current: { label: 'Checking •••• 1234' }, pendingChange: null });
  });

  it('blocked reasons come from sellers.payout_blocked_reasons', async () => {
    const s = await approvedSeller(kit);
    await table('sellers').update(s.sellerId, { payout_readiness: 'blocked', payout_blocked_reasons: ['Tax form missing'] });
    expect((await kit.call('GET', `${SELLER}/payout-account`, s.sellerToken)).body.readiness).toMatchObject({ state: 'blocked', blockedReasons: ['Tax form missing'] });
  });
});

describe('references', () => {
  it('suspensions get SU-YYMMDD-NNNN and appeals SAP-YYMMDD-NNN', async () => {
    const s = await approvedSeller(kit, { launch: true });
    const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/suspend`, staff(), { reasonCode: 'repeated_late_dispatch', reason: '14 of 40 orders late', reviewDate: futureDate(14), openOrders: 'seller_keeps_fulfilling', secondReviewerId: newId() });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const row = await table('suspensions').get(res.body.suspensionId);
    expect(row.ref).toMatch(/^SU-\d{6}-\d{4}$/);
    await kit.decide(res.body.approval.approvalRequestId, 'approved');
    const listed = (await kit.call('GET', `${SELLER}/restrictions?state=active`, s.sellerToken)).body.items.find((r: { id: string }) => r.id === res.body.suspensionId);
    expect(listed.ref).toBe(row.ref);
    const ap = await kit.call('POST', `${SELLER}/restrictions/${res.body.suspensionId}/appeals`, s.sellerToken, { argument: 'Carrier strike caused the delays' });
    expect(ap.body).toMatchObject({ ref: expect.stringMatching(/^SAP-\d{6}-\d{3}$/), subjectRef: row.ref });
  });
});

describe('pending_changes', () => {
  it('a staff closure waits in pending_changes and is applied on approval', async () => {
    const s = await approvedSeller(kit);
    const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/close`, staff(), { reason: 'Inactive for a year', reasonCode: 'inactive' });
    // saved, pending approval: 200 with the account unchanged, the pending change and its approval (pass 5)
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: 'approved',
      approval: { required: true, approvalRequestId: expect.any(String) },
      pendingChange: { kind: 'closure', state: 'pending', reason: 'Inactive for a year', proposed: { reasonCode: 'inactive' }, requestedBy: { kind: 'staff' } },
    });
    expect(res.body.pendingChange.approvalRequestId).toBe(res.body.approval.approvalRequestId);
    const row = await table('pending_changes').get(res.body.pendingChange.id);
    expect(row).toMatchObject({ kind: 'closure', seller_id: s.sellerId, state: 'pending', payload: { reason: 'Inactive for a year', reasonCode: 'inactive' } });
    // staff views show the waiting closure; the seller does not see it
    expect((await kit.call('GET', `${ADMIN}/sellers/${s.sellerId}`, staff())).body.account.pendingChange).toMatchObject({ id: row.id });
    expect((await kit.call('GET', `${SELLER}/account`, s.sellerToken)).body).toMatchObject({ pendingChange: null, approval: null });
    await kit.decide(res.body.approval.approvalRequestId, 'approved');
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('closed');
    expect((await table('pending_changes').get(row.id)).state).toBe('applied');
    expect((await kit.call('GET', `${ADMIN}/sellers/${s.sellerId}`, staff())).body.account).toMatchObject({ status: 'closed', pendingChange: null });
  });

  it('performance targets above the caller authority answer 200 with the current targets and the pending change', async () => {
    const before = (await kit.call('GET', `${ADMIN}/performance-targets`, staff())).body;
    kit.authority.set('sellers.performance.targets', 'approval_required');
    try {
      const target = { metric: 'cancellation_rate', comparator: 'lte', threshold: 1.5, unit: 'percent', windowDays: 30, categoryId: null, display: 'At most 1.5%', isExample: false, effectiveFrom: futureDate(10) };
      const res = await kit.call('PUT', `${ADMIN}/performance-targets`, staff(), { targets: [target], reason: 'Tighter cancellations' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ targets: before, approval: { required: true }, pendingChange: { kind: 'performance_targets', state: 'pending', proposed: { targets: [{ threshold: 1.5 }] } } });
      await kit.decide(res.body.approval.approvalRequestId, 'approved');
      const after = (await kit.call('GET', `${ADMIN}/performance-targets`, staff())).body;
      expect(after.some((t: { threshold: number; effectiveFrom: string }) => t.threshold === 1.5 && t.effectiveFrom === target.effectiveFrom)).toBe(true);
    } finally {
      kit.authority.delete('sellers.performance.targets');
    }
    // within authority: the saved targets, no approval
    const direct = await kit.call('PUT', `${ADMIN}/performance-targets`, staff(), { targets: [{ metric: 'return_rate', comparator: 'lte', threshold: 8, unit: 'percent', windowDays: 30, categoryId: null, display: 'At most 8%', isExample: false, effectiveFrom: futureDate(12) }], reason: 'Returns' });
    expect(direct.body).toMatchObject({ targets: [{ metric: 'return_rate', threshold: 8 }], approval: null, pendingChange: null });
  });

  it('a declined restriction change is dropped', async () => {
    const s = await approvedSeller(kit);
    const r = (await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput())).body;
    kit.authority.set('sellers.sellers.restrict', 'approval_required');
    try {
      const res = await kit.call('PATCH', `${ADMIN}/restrictions/${r.id}`, staff(), { toResolve: 'Ship 20 orders on time', changeReason: 'Clearer steps' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: r.id, toResolve: r.toResolve, pendingChange: { kind: 'restriction_change', state: 'pending', proposed: { patch: { toResolve: 'Ship 20 orders on time' } } } });
      expect(res.body.approval.approvalRequestId).toBe(res.body.pendingChange.approvalRequestId);
      const staffView = async () => (await kit.call('GET', `${ADMIN}/sellers/${s.sellerId}`, staff())).body.restrictions.find((x: { id: string }) => x.id === r.id);
      expect((await staffView()).pendingChange).toMatchObject({ id: res.body.pendingChange.id });
      await kit.decide(res.body.pendingChange.approvalRequestId, 'rejected');
      const row = await table('pending_changes').get(res.body.pendingChange.id);
      expect(row).toMatchObject({ kind: 'restriction_change', target_id: r.id, state: 'declined' });
      const now = await staffView();
      expect(now.toResolve).not.toBe('Ship 20 orders on time');
      expect(now.pendingChange).toBeNull();
    } finally {
      kit.authority.delete('sellers.sellers.restrict');
    }
  });
});
