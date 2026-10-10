/**
 * Gap pass 4: payout_changes (instead of applications.payout jsonb), sellers.payout_blocked_reasons, suspensions.ref,
 * pending_changes for closures, restriction changes and targets waiting for a second reviewer, the SAP- appeal
 * prefix, and migration 0003 backfilling them on an existing install.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0003Pass4 } from '../infra/postgres/migrations/0003_pass4.js';
import { ADMIN, approvedSeller, boot, type Kit, payoutInput, restrictionInput, SELLER, staff } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => {
  await kit?.close();
});

const db = () => kit.app.kernel.database.kysely.withSchema('sellers') as any;
const futureDate = (days: number) => new Date(kit.clock.now().getTime() + days * 86_400_000).toISOString().slice(0, 10);

describe('payout_changes', () => {
  it('records each destination handed to finance; verified replaces the current one', async () => {
    const s = await approvedSeller(kit);
    let rows = await db().selectFrom('payout_changes').selectAll().where('seller_id', '=', s.sellerId).execute();
    expect(rows).toEqual([expect.objectContaining({ kind: 'initial', state: 'pending', label: 'Checking •••• 7731' })]);
    const initialId = rows[0].id;
    expect(kit.last('sellers.payout_account.changed')).toMatchObject({ changeId: initialId, isInitial: true });
    await kit.emit('finance', 'finance.destination.verified', { sellerId: s.sellerId, reviewId: newId() });

    const body = { details: payoutInput('000999881234', 'Ana Lopez'), reauthToken: 'dev-reauth.payout-account' };
    await kit.call('POST', `${SELLER}/payout-account/change`, s.sellerToken, body, { 'idempotency-key': newId() });
    await kit.emit('finance', 'finance.destination.rejected', { sellerId: s.sellerId, reviewId: newId(), reason: 'Name does not match' });
    await kit.call('POST', `${SELLER}/payout-account/change`, s.sellerToken, body, { 'idempotency-key': newId() });
    await kit.emit('finance', 'finance.destination.verified', { sellerId: s.sellerId, reviewId: newId() });

    rows = await db().selectFrom('payout_changes').selectAll().where('seller_id', '=', s.sellerId).execute();
    const byState = (st: string) => rows.filter((r: { state: string }) => r.state === st);
    expect(byState('replaced')).toEqual([expect.objectContaining({ id: initialId })]);
    expect(byState('rejected')).toEqual([expect.objectContaining({ kind: 'change', rejection_reason: 'Name does not match', previous_label: 'Checking •••• 7731' })]);
    expect(byState('verified')).toEqual([expect.objectContaining({ kind: 'change', label: 'Checking •••• 1234', review_id: expect.any(String) })]);
    expect((await kit.call('GET', `${SELLER}/payout-account`, s.sellerToken)).body).toMatchObject({ current: { label: 'Checking •••• 1234' }, pendingChange: null });
  });

  it('blocked reasons come from sellers.payout_blocked_reasons', async () => {
    const s = await approvedSeller(kit);
    await db().updateTable('sellers').set({ payout_readiness: 'blocked', payout_blocked_reasons: JSON.stringify(['Tax form missing']) }).where('id', '=', s.sellerId).execute();
    expect((await kit.call('GET', `${SELLER}/payout-account`, s.sellerToken)).body.readiness).toMatchObject({ state: 'blocked', blockedReasons: ['Tax form missing'] });
  });
});

describe('references', () => {
  it('suspensions get SU-YYMMDD-NNNN and appeals SAP-YYMMDD-NNN', async () => {
    const s = await approvedSeller(kit, { launch: true });
    const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/suspend`, staff(), { reasonCode: 'repeated_late_dispatch', reason: '14 of 40 orders late', reviewDate: futureDate(14), openOrders: 'seller_keeps_fulfilling', secondReviewerId: newId() });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const row = await db().selectFrom('suspensions').select('ref').where('id', '=', res.body.suspensionId).executeTakeFirst();
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
    expect(res.body.error).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { approvalRequestId: expect.any(String), pendingChangeId: expect.any(String) } });
    const row = await db().selectFrom('pending_changes').selectAll().where('id', '=', res.body.error.details.pendingChangeId).executeTakeFirst();
    expect(row).toMatchObject({ kind: 'closure', seller_id: s.sellerId, state: 'pending', payload: { reason: 'Inactive for a year', reasonCode: 'inactive' } });
    await kit.decide(res.body.error.details.approvalRequestId, 'approved');
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('closed');
    expect(await db().selectFrom('pending_changes').select('state').where('id', '=', row.id).executeTakeFirst()).toEqual({ state: 'applied' });
  });

  it('a declined restriction change is dropped', async () => {
    const s = await approvedSeller(kit);
    const r = (await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput())).body;
    kit.authority.set('sellers.sellers.restrict', 'approval_required');
    try {
      const res = await kit.call('PATCH', `${ADMIN}/restrictions/${r.id}`, staff(), { toResolve: 'Ship 20 orders on time', changeReason: 'Clearer steps' });
      expect(res.body.error.code).toBe('APPROVAL_REQUIRED');
      await kit.decide(res.body.error.details.approvalRequestId, 'rejected');
      const row = await db().selectFrom('pending_changes').selectAll().where('id', '=', res.body.error.details.pendingChangeId).executeTakeFirst();
      expect(row).toMatchObject({ kind: 'restriction_change', target_id: r.id, state: 'declined' });
      expect((await kit.call('GET', `${ADMIN}/restrictions/${r.id}`, staff())).body.toResolve).not.toBe('Ship 20 orders on time');
    } finally {
      kit.authority.delete('sellers.sellers.restrict');
    }
  });
});

describe('migration 0003', () => {
  it('backfills blocked reasons, suspension refs and payout changes from applications.payout', async () => {
    const s = await approvedSeller(kit);
    const sus = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/suspend`, staff(), { reasonCode: 'repeated_late_dispatch', reason: 'Late', reviewDate: futureDate(14), openOrders: 'seller_keeps_fulfilling', secondReviewerId: newId() });
    const k = kit.app.kernel.database;
    // back to the schema before 0003, with the payout kept in the application jsonb
    await k.exec(`drop table sellers.pending_changes; drop table sellers.payout_changes;
alter table sellers.suspensions drop column ref;
alter table sellers.sellers drop column payout_blocked_reasons;`);
    const seller = await db().selectFrom('sellers').select(['application_id']).where('id', '=', s.sellerId).executeTakeFirst();
    const changeId = newId();
    const details = (label: string, token: string) => ({ accountHolderName: 'Northwind Audio LLC', accountType: 'business_checking', label, providerDestinationId: token });
    await db().updateTable('applications').set({ payout: JSON.stringify({ current: details('Checking •••• 7731', 'tok_1'), pendingChange: { ...details('Checking •••• 1234', 'tok_2'), changeId, requestedAt: '2026-10-01T10:00:00.000Z' }, blockedReasons: ['Tax form missing'] }) }).where('id', '=', seller.application_id).execute();
    await db().updateTable('sellers').set({ payout_readiness: 'change_under_review' }).where('id', '=', s.sellerId).execute();

    await k.exec(`begin;\n${m0003Pass4.sql}\ncommit;`);

    const after = await db().selectFrom('sellers').select(['payout_blocked_reasons']).where('id', '=', s.sellerId).executeTakeFirst();
    expect(after.payout_blocked_reasons).toEqual(['Tax form missing']);
    const ref = await db().selectFrom('suspensions').select('ref').where('id', '=', sus.body.suspensionId).executeTakeFirst();
    expect(ref.ref).toBe(`SU-${sus.body.suspensionId.replace(/-/g, '').slice(-8).toUpperCase()}`);
    const rows = await db().selectFrom('payout_changes').selectAll().where('seller_id', '=', s.sellerId).execute();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'verified', label: 'Checking •••• 7731', provider_destination_id: 'tok_1' }),
        expect.objectContaining({ id: changeId, state: 'pending', kind: 'change', label: 'Checking •••• 1234', previous_label: 'Checking •••• 7731' }),
      ]),
    );
    expect(rows).toHaveLength(2);
    expect((await kit.call('GET', `${SELLER}/payout-account`, s.sellerToken)).body).toMatchObject({ current: { label: 'Checking •••• 7731' }, pendingChange: { label: 'Checking •••• 1234' } });
  });
});
