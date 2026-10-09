/**
 * Return policies: the public baseline, effective terms, seller terms (never below the baseline), baseline
 * versions with Business Owner approval and category exceptions that need approval when they shorten a window.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});
beforeEach(() => {
  h.authority.decision = 'allowed';
});

const staff = () => tokens.staff();
const address = { name: 'Casa Verde Returns', line1: '200 Pine St', city: 'Reno', region: 'NV', postalCode: '89501', country: 'US' };
const day = 86_400_000;

describe('baseline and effective terms', () => {
  it('serves the settings baseline until a version is active', async () => {
    const res = await h.call('GET', '/api/store/returns/policy', tokens.visitor());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ windowDays: 30, version: 'default' });
    expect(res.body.responsibilities.find((r: any) => r.reasonGroup === 'change_of_mind')).toMatchObject({ paidBy: 'customer', customerFee: { amount: 799 } });
    expect(res.body.responsibilities.find((r: any) => r.reasonGroup === 'damaged')).toMatchObject({ paidBy: 'seller', originalShippingRefunded: true });
    const official = await h.service.resolveTerms(null, null, null);
    expect(official).toMatchObject({ windowDays: 30, source: 'baseline', remedies: ['refund', 'replacement', 'exchange'] });
    expect(official.responsibilities.every((r) => r.paidBy === 'platform')).toBe(true);
  });

  it('creates version 1 of seller terms on approval and keeps changes at or above the baseline', async () => {
    const sellerId = newId();
    await h.publish('sellers', 'sellers.seller.approved', { sellerId, applicationId: newId(), storeName: 'Casa Verde', ownerAccountId: newId(), categoryIds: [], returnAddress: address, returnContact: 'returns@casaverde.example' });
    await h.publish('sellers', 'sellers.seller.approved', { sellerId, applicationId: newId(), storeName: 'Casa Verde', ownerAccountId: newId(), categoryIds: [], returnAddress: address, returnContact: 'returns@casaverde.example' });
    const seller = tokens.seller(sellerId);
    const terms = await h.call('GET', '/api/seller/returns/terms', seller);
    expect(terms.body).toMatchObject({ version: 1, windowDays: 30, returnAddress: address, returnContactEmail: 'returns@casaverde.example', baseline: { windowDays: 30 } });
    const input = { windowDays: 45, changeOfMindPaidBy: 'seller', freeReturns: true, remedies: ['refund', 'exchange'], returnAddress: address, responseTargetBusinessDays: 1, refundTargetDays: 2 };
    const below = await h.call('PUT', '/api/seller/returns/terms', seller, { ...input, windowDays: 14 });
    expect(below.status).toBe(422);
    expect(below.body.error).toMatchObject({ code: 'POLICY_BELOW_BASELINE', details: { fields: [{ field: 'windowDays', baseline: 30, value: 14 }] } });
    const ok = await h.call('PUT', '/api/seller/returns/terms', seller, input);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ version: 2, windowDays: 45, freeReturns: true });
    expect(h.named('returns.seller_terms.changed').find((e) => e.sellerId === sellerId)).toMatchObject({ version: 2 });
    expect(h.audits.at(-1)).toMatchObject({ action: 'returns.seller_terms.update' });
    const eff = await h.call('GET', `/api/store/returns/terms?sellerId=${sellerId}`, tokens.visitor());
    expect(eff.body).toMatchObject({ sellerId, windowDays: 45, source: 'seller_terms', sellerTermsVersion: 2, remedies: ['refund', 'exchange'], responseTargetBusinessDays: 1 });
    expect(eff.body.responsibilities.find((r: any) => r.reasonGroup === 'change_of_mind')).toMatchObject({ paidBy: 'seller', customerFee: null });
    expect((await h.service.sellerReturnTermsFor([sellerId]))[sellerId]!.summary).toContain('45-day returns');
  });
});

describe('category exceptions', () => {
  it('schedules exceptions that do not shorten a window and activates them', async () => {
    const categoryId = newId();
    const res = await h.call('POST', '/api/admin/returns/category-exceptions', staff(), {
      categoryId,
      windowDays: 60,
      changeOfMindAllowed: true,
      condition: 'Any condition',
      faultReturnsWindowDays: 60,
      shownOn: ['product_page', 'checkout'],
      effectiveFrom: new Date(h.clock.now().getTime() - 60_000).toISOString(),
      reason: 'Holiday season',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'active', applyScope: 'new_orders' });
    expect(h.named('returns.policy.proposed').find((e) => e.categoryExceptionId === res.body.id)).toBeTruthy();
    expect(h.named('returns.policy.changed').find((e) => e.categoryId === categoryId)).toBeTruthy();
    const terms = await h.service.resolveTerms(newId(), categoryId, null);
    expect(terms).toMatchObject({ windowDays: 60, source: 'category_exception', condition: 'Any condition' });
    const retire = await h.call('PATCH', `/api/admin/returns/category-exceptions/${res.body.id}`, staff(), {
      categoryId,
      windowDays: 60,
      changeOfMindAllowed: true,
      condition: 'Any condition',
      faultReturnsWindowDays: 60,
      shownOn: ['product_page'],
      effectiveFrom: res.body.effectiveFrom,
      effectiveTo: new Date(h.clock.now().getTime() + 5 * day).toISOString(),
      reason: 'Season ends',
    });
    expect(retire.status, JSON.stringify(retire.body)).toBe(200);
    expect(retire.body.effectiveTo).toBeTruthy();
    h.clock.advance(6 * day);
    try {
      await h.app.kernel.jobs.runNow('returns.policy-activation');
      expect((await h.service.resolveTerms(newId(), categoryId, null)).source).not.toBe('category_exception');
    } finally {
      h.clock.advance(-6 * day);
    }
  });

  it('sends shortening changes to the Business Owner and refuses them for undelivered orders', async () => {
    const categoryId = newId();
    const input = { categoryId, windowDays: 15, changeOfMindAllowed: true, condition: 'Unopened and sealed', faultReturnsWindowDays: 30, shownOn: ['product_page', 'checkout', 'order'], effectiveFrom: new Date(h.clock.now().getTime() + 10 * day).toISOString(), reason: 'High return fraud in Electronics' };
    const preview = await h.call('POST', '/api/admin/returns/category-exceptions/preview', staff(), { exception: input });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ needsApproval: true, approvalRule: 'business_owner', approvers: ['Olivia Owner'], blocking: [] });
    expect(preview.body.items.some((i: any) => i.module === 'orders')).toBe(true);
    const scoped = await h.call('POST', '/api/admin/returns/category-exceptions/preview', staff(), { exception: { ...input, applyScope: 'undelivered_orders' } });
    expect(scoped.body.blocking.length).toBe(1);
    expect((await h.call('POST', '/api/admin/returns/category-exceptions', staff(), { ...input, applyScope: 'undelivered_orders' })).status).toBe(400);
    const faultTooShort = await h.call('POST', '/api/admin/returns/category-exceptions', staff(), { ...input, faultReturnsWindowDays: 10 });
    expect(faultTooShort.body.error.details.issues[0].path).toBe('faultReturnsWindowDays');

    h.authority.decision = 'approval_required';
    const res = await h.call('POST', '/api/admin/returns/category-exceptions', staff(), input);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending_approval', approval: { required: true } });
    expect(h.calls.approvals.at(-1)).toMatchObject({ action: 'returns.policies.shorten-window', target: { type: 'category_exception', id: res.body.id } });
    await h.publish('access', 'access.approval.decided', { requestId: res.body.approval.approvalRequestId, ref: 'AP-2', actionKey: 'returns.policies.shorten-window', module: 'returns', target: { type: 'category_exception', id: res.body.id }, outcome: 'approved', decidedBy: { kind: 'staff', id: newId() }, reason: null, amount: null, approverIds: [], requestedById: newId() });
    const admin = await h.call('GET', '/api/admin/returns/policies', staff());
    expect(admin.body.active.categoryExceptions.find((x: any) => x.id === res.body.id)).toMatchObject({ status: 'scheduled' });
    const pub = await h.call('GET', '/api/store/returns/policy', tokens.visitor());
    expect(pub.body.upcomingChange).toContain('15 days');
  });
});

describe('baseline versions', () => {
  const version = (o: Record<string, unknown> = {}) => ({
    windowDays: 30,
    sellerResponseBusinessDays: 2,
    infoReplyDays: 3,
    dropOffDays: 7,
    inspectionTargetBusinessDays: 2,
    refundTargetBusinessDays: 3,
    responsibilities: [
      { reasonGroup: 'damaged', paidBy: 'seller', originalShippingRefunded: true },
      { reasonGroup: 'change_of_mind', paidBy: 'customer', customerFee: { amount: 599, currency: 'USD' }, originalShippingRefunded: false },
    ],
    effectiveFrom: new Date(h.clock.now().getTime() + 2 * day).toISOString(),
    reason: 'Lower change-of-mind fee',
    ...o,
  });

  it('goes to Business Owner approval, is scheduled and activates at its date', async () => {
    const invalid = await h.call('POST', '/api/admin/returns/policies', staff(), version({ responsibilities: [{ reasonGroup: 'defective', paidBy: 'customer', originalShippingRefunded: false }] }));
    expect(invalid.status).toBe(400);
    h.authority.decision = 'approval_required';
    const res = await h.call('POST', '/api/admin/returns/policies', staff(), version());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending_approval', version: '1.0', approval: { required: true } });
    expect(h.calls.approvals.at(-1)).toMatchObject({ action: 'returns.baseline.change', target: { id: res.body.id } });
    expect((await h.call('POST', `/api/admin/returns/policies/${res.body.id}/withdraw`, staff(), { reason: 'x' })).status).toBe(409);
    await h.publish('access', 'access.approval.decided', { requestId: res.body.approval.approvalRequestId, ref: 'AP-3', actionKey: 'returns.baseline.change', module: 'returns', target: { type: 'return_policy', id: res.body.id }, outcome: 'approved', decidedBy: { kind: 'staff', id: newId() }, reason: null, amount: null, approverIds: [], requestedById: newId() });
    let admin = await h.call('GET', '/api/admin/returns/policies', staff());
    expect(admin.body.upcoming.find((v: any) => v.id === res.body.id)).toMatchObject({ status: 'scheduled' });
    expect(admin.body.active.version).toBe('default');
    h.clock.advance(3 * day);
    try {
      await h.app.kernel.jobs.runNow('returns.policy-activation');
      admin = await h.call('GET', '/api/admin/returns/policies', staff());
      expect(admin.body.active).toMatchObject({ id: res.body.id, status: 'active', version: '1.0' });
      expect(h.named('returns.policy.changed').find((e) => e.policyVersionId === res.body.id)).toBeTruthy();
      const pub = await h.call('GET', '/api/store/returns/policy', tokens.visitor());
      expect(pub.body.responsibilities.find((r: any) => r.reasonGroup === 'change_of_mind').customerFee.amount).toBe(599);
      // a second version supersedes it; a scheduled one can be withdrawn
      h.authority.decision = 'allowed';
      const next = await h.call('POST', '/api/admin/returns/policies', staff(), version({ effectiveFrom: new Date(h.clock.now().getTime() + 5 * day).toISOString() }));
      expect(next.body).toMatchObject({ status: 'scheduled', version: '1.1' });
      const withdrawn = await h.call('POST', `/api/admin/returns/policies/${next.body.id}/withdraw`, staff(), { reason: 'Not now' });
      expect(withdrawn.body.status).toBe('withdrawn');
    } finally {
      h.clock.advance(-3 * day);
    }
  });
});
