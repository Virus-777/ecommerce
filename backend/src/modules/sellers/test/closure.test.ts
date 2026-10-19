/**
 * H17: closing a seller account. The seller cannot close while orders, returns, cases or money are open; staff
 * closures always go to a second reviewer and are refused while orders are not shipped. Edits made while answering
 * an information request reach the seller record.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, approvedSeller, boot, businessInput, SELLER, staff, STORE, submitted, type Kit } from './helpers.js';

let kit: Kit;
/** What the stubbed modules answer per seller */
const open = new Map<string, { unshipped?: number; returns?: number; cases?: number; pending?: number }>();
const of = (id: string) => open.get(id) ?? {};
const money = (amount: number) => ({ amount, currency: 'USD' });

beforeAll(async () => {
  kit = await boot({
    apiStubs: {
      orders: { countSellerOrders: async (id: string) => ({ new: of(id).unshipped ?? 0, preparing: 0, fulfilledByMarketly: 0 }) as never },
      returns: { sellerQueueCounts: async (id: string) => ({ tabs: { requests: of(id).returns ?? 0, toInspect: 0, disputes: 0 } }) as never },
      support: { sellerCaseStats: async (id: string) => ({ open: of(id).cases ?? 0, unresolved: 0, decidedAgainstSeller: 0, medianReplyMinutes: 0 }) },
      finance: { getSellerBalances: async (id: string) => ({ pending: money(of(id).pending ?? 0), held: money(0), available: money(0) }) as never },
    },
  });
});
afterAll(async () => kit?.close());

const closeOwn = (s: { sellerToken: string }) => kit.call('POST', `${SELLER}/account/close`, s.sellerToken, { reason: 'Retiring', reauthToken: 'dev-reauth.seller-closure' });

describe('closing a seller account', () => {
  it('the seller cannot close while orders, returns, cases or money are open', async () => {
    const s = await approvedSeller(kit);
    open.set(s.sellerId, { unshipped: 2, returns: 1, cases: 1, pending: 4200 });
    const res = await closeOwn(s);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'SELLER_HAS_OPEN_OBLIGATIONS' });
    expect(res.body.error.details.obligations).toEqual([
      '2 orders not shipped yet: ship or cancel them',
      '1 open return',
      '1 open support case',
      'a balance not settled yet (pending, held or not paid out)',
    ]);
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('approved');

    open.delete(s.sellerId);
    const done = await closeOwn(s);
    expect(done.status).toBe(202);
    expect(done.body.status).toBe('closed');
  });

  it('staff closures always need a second reviewer, also with the seller_request code; unshipped orders block them', async () => {
    const s = await approvedSeller(kit);
    open.set(s.sellerId, { unshipped: 1, returns: 1 });
    const blocked = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/close`, staff(), { reason: 'Asked by phone', reasonCode: 'seller_request' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SELLER_HAS_OPEN_OBLIGATIONS');

    open.set(s.sellerId, { returns: 1 });
    const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/close`, staff(), { reason: 'Asked by phone', reasonCode: 'seller_request' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', pendingChange: { kind: 'closure' } });
    expect(kit.approvals.get(res.body.approval.approvalRequestId)!.details).toMatchObject({ openObligations: ['1 open return'] });
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('approved');
    await kit.decide(res.body.approval.approvalRequestId, 'approved');
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('closed');
  });
});

describe('answering an information request', () => {
  it('copies the business edits to the seller record', async () => {
    const s = await submitted(kit);
    const reviewer = staff();
    await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer);
    const dueAt = new Date(kit.clock.now().getTime() + 5 * 86_400_000).toISOString();
    const req = await kit.call('POST', `${ADMIN}/applications/${s.id}/request-information`, reviewer, { items: [{ title: 'Legal name', detail: 'Use the registered name', neededFor: 'business' }], message: 'Your legal name does not match the registry', dueAt, reminder: 'none' });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    const itemId = req.body.application.informationRequest.items[0].id;
    const storeName = `Southwind ${s.id.slice(-5)}`;
    const edit = await kit.call('PATCH', `${STORE}/applications/${s.id}`, s.token, { step: 'business', business: businessInput('Southwind Audio Inc', storeName) });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const res = await kit.call('POST', `${STORE}/applications/${s.id}/respond`, s.token, { items: [{ itemId, note: 'Fixed the legal name' }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await kit.svc.core.repo.get('sellers', s.sellerId)).toMatchObject({ legal_name: 'Southwind Audio Inc', store_name: storeName });
  });
});
