/**
 * Approval limits with the real access module (no stubs for access, identity or audit): staff are invited with
 * their roles, sign in with 2-step codes, and access decides who may hold money, approve payout runs and act as
 * the second reviewer. Orders stays stubbed for the order details finance reads.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import { buildTestApp, movingClock, tokenClock } from '../../../testing/app.js';
import { flows, type Flows, type Staff } from '../../../testing/flows.js';
import type { AccessPublicApi } from '../../../spec/access.js';
import type { FinanceService } from '../service.js';

const ADMIN = '/api/admin/finance';
const USD = (amount: number) => ({ amount, currency: 'USD' });
const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let svc: FinanceService;
let managerA: Staff;
let managerB: Staff;
let specialist: Staff;
let owner: Staff;
const S = newId();

beforeAll(async () => {
  tokenClock.now = undefined;
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'notifications', 'settings', 'finance']),
    clock,
    config: { rateLimits: false },
    apiStubs: { sellers: { getSellers: async (ids: string[]) => ids.map((id) => ({ id, ref: 'SL-20714', slug: 'n', storeName: 'Northwind Audio', status: 'approved', verified: true, canSellNew: true, activeRestrictionIds: [], launchReady: true }) as any) } },
  });
  f = flows(app, clock);
  svc = app.kernel.boot.apis.get('finance') as FinanceService;
  owner = await f.bootstrapOwner();
  managerA = await f.staffWithRoles(owner, 'fran@marketly.test', 'Fran Finance', ['finance_manager']);
  managerB = await f.staffWithRoles(owner, 'gus@marketly.test', 'Gus Ledger', ['finance_manager']);
  specialist = await f.staffWithRoles(owner, 'sam@marketly.test', 'Sam Specialist', ['finance_staff']);
  // finance roles carry sensitive permissions: access holds them for a second Platform Administrator, whom this
  // test has not got (the bootstrap owner requested them). Stand in for that approval, as access's own fixture does.
  // through access's own store, whichever database this run keeps access in (TEST_MYSQL_MODULES): reaching for
  // `kernel.mongo.db.collection('access.role_assignments')` wrote into an empty MongoDB once access moved, and
  // the only symptom was a 403 from a permission check that was right to refuse.
  await app.kernel.boot.stores
    .get('access')!
    .table<{ status: string; account_id: string; approval_request_id: string | null }>('role_assignments')
    .updateMany({ status: 'pending_approval', account_id: [managerA.accountId, managerB.accountId, specialist.accountId] }, { status: 'active', approval_request_id: null });
  // a verified payout account and a balance above the $50,000 second-reviewer threshold
  const providerDestinationId = 'dest_real';
  app.kernel.events.publish('test', 'sellers.payout_account.changed', { sellerId: S, changeId: newId(), providerDestinationId, label: 'Pacific Coast CU •••• 6620', accountHolderName: 'Northwind LLC', accountType: 'business_checking', previousLabel: null, isInitial: true, requestedBy: { kind: 'seller', id: newId() } });
  await app.kernel.events.drain();
  const pending = (await svc.core.repo.findOne('destination_reviews', { seller_id: S }))!;
  await svc.destinations.verify(pending.id, [], { actor: { kind: 'seller', id: null } }, null);
  await svc.holds.recordSystemAdjustment({ key: 'opening', sellerId: S, direction: 'credit', amount: 6_000_000, reasonCode: 'other', reason: 'Opening balance (test)' });
});
afterAll(async () => {
  await app?.close();
});

describe('approval limits from access', () => {
  it('a Finance Specialist holds within the limit; above it the hold waits for a Finance Manager', async () => {
    const small = await f.call('POST', `${ADMIN}/holds`, { token: specialist.accessToken, body: { sellerId: S, amount: USD(100_000), reasonCode: 'risk_review', reason: 'Spike in refunds', reviewDate: svc.core.today() }, headers: { 'idempotency-key': newId() } });
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    const big = await f.call('POST', `${ADMIN}/holds`, { token: specialist.accessToken, body: { sellerId: S, amount: USD(2_000_000), reasonCode: 'risk_review', reason: 'Large unusual payout', reviewDate: svc.core.today() }, headers: { 'idempotency-key': newId() } });
    // saved waiting for approval: 201 with approval in the body (FORMAT.md, Approval responses)
    expect(big.status, JSON.stringify(big.body)).toBe(201);
    expect(big.body.approval).toMatchObject({ required: true, approvalRequestId: expect.any(String) });
    const { id: holdId, approval: { approvalRequestId } } = big.body;
    expect((await svc.core.repo.findOne('seller_accounts', { seller_id: S }))?.held).toBe(100_000);
    const approved = await f.call('POST', `/api/admin/access/approval-requests/${approvalRequestId}/approve`, { token: managerA.accessToken, body: { note: 'Agreed', reauthToken: await f.reauth(managerA, 'approval') } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await svc.core.repo.findOne('seller_accounts', { seller_id: S }))?.held).toBe(2_100_000);
    expect((await svc.core.repo.get('holds', holdId))?.approval_request_id).toBeNull();
    // release everything again for the payout below (manager, within the release limit)
    for (const id of [small.body.id, holdId]) {
      const r = await f.call('POST', `${ADMIN}/holds/${id}/release`, { token: managerA.accessToken, body: { reason: 'Reviewed' }, headers: { 'idempotency-key': newId() } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
  });

  it("a run above the first manager's payout limit (access) needs two different Finance Managers; the first cannot approve twice", async () => {
    clock.advance(60_000);
    const run = await f.call('POST', `${ADMIN}/payout-runs`, { token: managerA.accessToken, body: { cutoffAt: clock.now().toISOString(), scheduledRelease: new Date(clock.now().getTime() + 3_600_000).toISOString() }, headers: { 'idempotency-key': newId() } });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.total).toEqual(USD(6_000_000));
    expect((await f.call('POST', `${ADMIN}/payout-runs/${run.body.id}/submit`, { token: managerA.accessToken })).status).toBe(200);
    const first = await f.call('POST', `${ADMIN}/payout-runs/${run.body.id}/approve`, { token: managerA.accessToken, body: { confirmedReview: true, note: 'Held and changed rows reviewed' }, headers: { 'idempotency-key': newId() } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ status: 'pending_approval', viewerCanApprove: false });
    expect(first.body.approvals.map((a: any) => a.status)).toEqual(['approved', 'pending']);
    const twice = await f.call('POST', `${ADMIN}/payout-runs/${run.body.id}/approve`, { token: managerA.accessToken, body: { confirmedReview: true }, headers: { 'idempotency-key': newId() } });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('SAME_APPROVER');
    const view = await f.call('GET', `${ADMIN}/payout-runs/${run.body.id}`, { token: managerB.accessToken });
    expect(view.body.viewerCanApprove).toBe(true);
    const second = await f.call('POST', `${ADMIN}/payout-runs/${run.body.id}/approve`, { token: managerB.accessToken, body: { confirmedReview: true, reauthToken: await f.reauth(managerB, 'approval') }, headers: { 'idempotency-key': newId() } });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.status).toBe('approved');
    const released = await f.call('POST', `${ADMIN}/payout-runs/${run.body.id}/release`, { token: managerB.accessToken, headers: { 'idempotency-key': newId() } });
    expect(released.body.status).toBe('releasing');
  });

  it('a seller credit above creditSecondReviewerThreshold waits for a Finance reviewer in access, then posts', async () => {
    const before = (await svc.core.repo.findOne('seller_accounts', { seller_id: S }))!.available;
    const credit = await svc.creditSeller({ sellerId: S, amount: USD(60_000), reason: 'Units lost in the warehouse', reference: { kind: 'fulfillment_service', id: newId(), ref: 'FS-CLAIM-77' }, idempotencyKey: `real-access-${newId()}` });
    expect(credit).toMatchObject({ status: 'pending_approval' });
    const request = await (app.kernel.boot.apis.get('access') as AccessPublicApi).getApproval(credit.approvalRequestId!);
    expect(request).toMatchObject({ status: 'pending', target: { type: 'seller_credit', id: credit.id } });
    // access has no Finance limits for finance.credits.issue yet (seed), so the Business Owner decides it
    const approved = await f.call('POST', `/api/admin/access/approval-requests/${credit.approvalRequestId}/approve`, { token: owner.accessToken, body: { note: 'Claim checked', reauthToken: await f.reauth(owner, 'approval') } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await app.kernel.events.drain();
    expect((await svc.core.repo.get('seller_credits', credit.id))?.status).toBe('posted');
    expect((await svc.core.repo.findOne('seller_accounts', { seller_id: S }))!.available).toBe(before + 60_000);
  });

  it('a Finance Specialist cannot approve payouts at all', async () => {
    const res = await f.call('POST', `${ADMIN}/payout-runs/${newId()}/approve`, { token: specialist.accessToken, body: { confirmedReview: true }, headers: { 'idempotency-key': newId() } });
    expect(res.status).toBe(403);
  });
});
