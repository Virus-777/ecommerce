/**
 * Gap pass 3: review steps from the caller's access roles (never from the body alone), the rules decision consumer
 * inbox-claimed, and guest attribution by visitorId only when the shopper allowed personalization.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { RULES_ACTION, RULES_TARGET } from '../service/setup.js';
import { ADMIN, boot, campaignInput, liveCampaign, openingCreatives, track, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

/** A staff token for an account with the given access roles */
const staffWith = (roles: string[]) => {
  const id = newId();
  k.roles.set(id, roles);
  return callers.staff(undefined, { sub: id } as never);
};

async function submitted() {
  const creatives = await openingCreatives(k);
  const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { creativeIds: creatives.map((c: any) => c.id) }));
  const id = created.body.id as string;
  const sub = await k.call('POST', `${ADMIN}/campaigns/${id}/submit`, k.staff, {});
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return { id, creativeIds: creatives.map((c: any) => c.id as string) };
}

describe('guest attribution', () => {
  const order = (visitorId: string | null) => ({ orderId: newId(), ref: 'MK-2', checkoutSessionId: newId(), customerId: null, guestEmail: 'gia@example.com', paymentIntentId: newId(), paymentState: 'accepted', total: { amount: 5000, currency: 'USD' }, couponCodes: [], groups: [], placedAt: k.clock.now().toISOString(), attemptNo: 1, contactName: 'Gia Guest', visitorId });
  const attributions = (orderId: string) => k.svc.core.repo.find('attributions', { order_id: orderId });
  const visitor = { scope: { kind: 'visitor', visitorSessionId: newId() } as never, principal: null };

  it('attributes a guest order by visitorId only when the click was made with personalization allowed', async () => {
    const c = await liveCampaign(k, { name: 'Guest attribution' });

    // without personalization: the click is kept under a session key and cannot be matched to the visitor
    const anon = await k.svc.serving.serve({ page: 'home', context: {}, device: 'desktop', visitorId: 'v-private', sessionId: 's-private', isEntryPage: true, slots: [], personalizationAllowed: false }, visitor);
    expect(anon.overlay?.campaignId).toBe(c.id);
    expect((await track(k, [{ impressionToken: anon.overlay!.impressionToken, kind: 'click' }])).status).toBe(202);
    const privateOrder = order('v-private');
    await k.emit('orders.order.placed', privateOrder);
    expect(await attributions(privateOrder.orderId)).toEqual([]);

    // with personalization: the guest order with the same visitorId is attributed (once)
    const seen = await k.svc.serving.serve({ page: 'home', context: {}, device: 'desktop', visitorId: 'v-guest', sessionId: 's-guest', isEntryPage: true, slots: [], personalizationAllowed: true }, visitor);
    expect(seen.overlay).toBeTruthy();
    expect((await track(k, [{ impressionToken: seen.overlay!.impressionToken, kind: 'click' }])).status).toBe(202);
    const nobody = order(null); // no customer and no visitor id: not attributed
    await k.emit('orders.order.placed', nobody);
    expect(await attributions(nobody.orderId)).toEqual([]);
    const placed = order('v-guest');
    await k.emit('orders.order.placed', placed);
    await k.emit('orders.order.placed', placed);
    const rows = await attributions(placed.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ campaign_id: seen.overlay!.campaignId, amount: 5000 });
  });
});

describe('review steps come from access roles', () => {
  it('a Content Manager cannot act on the Advertising step by sending role advertising', async () => {
    const { id, creativeIds } = await submitted();
    const content = staffWith(['content_manager']);
    const forged = await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, content, { role: 'advertising' });
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('FORBIDDEN');
    expect((await k.call('POST', `${ADMIN}/campaigns/${id}/request-changes`, content, { role: 'advertising', reason: 'x' })).status).toBe(403);
    expect((await k.call('POST', `${ADMIN}/creatives/${creativeIds[0]}/review`, content, { role: 'advertising', decision: 'approved' })).status).toBe(403);
    const view = (await k.call('GET', `${ADMIN}/campaigns/${id}`, k.staff)).body;
    expect(view.approvals.find((a: any) => a.role === 'advertising').state).toBe('waiting');

    // without a role the caller's own step is used
    const own = await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, content, {});
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.approvals.find((a: any) => a.role === 'content').state).toBe('approved');
    expect(own.body.approvals.find((a: any) => a.role === 'advertising').state).toBe('waiting');
    const ads = await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, staffWith(['advertising_manager']), {});
    expect(ads.status, JSON.stringify(ads.body)).toBe(200);
    expect(ads.body.approvals.every((a: any) => a.state === 'approved')).toBe(true);
  });

  it('a Business Owner (every step) names the step when more than one is waiting; staff with no reviewing role are refused', async () => {
    const { id } = await submitted();
    const owner = staffWith(['business_owner']);
    const ambiguous = await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, owner, {});
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.details.issues[0].path).toBe('role');
    expect((await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, staffWith(['finance_manager']), {})).status).toBe(403);
    const picked = await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, owner, { role: 'advertising' });
    expect(picked.status).toBe(200);
    // one step left: no role needed, but the same person cannot approve it (SAME_REVIEWER)
    const second = await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, owner, {});
    expect(second.body.error.code).toBe('SAME_REVIEWER');
  });

  it('creative review takes the step from the roles too', async () => {
    const { creativeIds } = await submitted();
    const marketing = staffWith(['marketing_manager']);
    const r = await k.call('POST', `${ADMIN}/creatives/${creativeIds[0]}/review`, marketing, { decision: 'approved' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reviews.at(-1)).toMatchObject({ role: 'marketing', decision: 'approved' });
  });
});

describe('access.approval.decided for a rules change', () => {
  it('applies once and writes one audit entry when the decision is delivered twice at the same time', async () => {
    const proposed = await k.call('PUT', `${ADMIN}/rules`, k.staff, { attributionDays: 10, reason: 'Longer window' });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(202);
    const requestId = proposed.body.approval.approvalRequestId as string;
    const version = proposed.body.version as number;
    const decided = { requestId, ref: 'AP-1', actionKey: RULES_ACTION, module: 'advertising', target: { type: RULES_TARGET, id: String(version) }, outcome: 'approved', decidedBy: { kind: 'staff', id: newId(), name: 'Bea Owner' }, reason: null, approverIds: [], requestedById: newId() };
    const before = k.audits.filter((a) => a.action === 'advertising.rules.approve').length;
    await Promise.all([k.svc.onApprovalDecidedFromAccess(decided as never), k.svc.onApprovalDecidedFromAccess(decided as never)]);
    await k.svc.onApprovalDecidedFromAccess(decided as never, newId());
    expect(k.audits.filter((a) => a.action === 'advertising.rules.approve').length).toBe(before + 1);
  });
});
