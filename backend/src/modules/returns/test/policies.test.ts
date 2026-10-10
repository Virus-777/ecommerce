/**
 * Return policies: the public baseline, effective terms, seller terms (never below the baseline), baseline
 * versions with Business Owner approval and category exceptions that need approval when they shorten a window.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import { SEEDED_POLICY_ID } from '../domain/rules.js';
import { group, harness, idem, line, placeOrder, product, tokens, type Harness } from './helpers.js';

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
  it('serves the seeded baseline version 1.0 (decision D-RT2)', async () => {
    const res = await h.call('GET', '/api/store/returns/policy', tokens.visitor());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ windowDays: 30, version: '1.0' });
    const admin = await h.call('GET', '/api/admin/returns/policies', staff());
    expect(admin.body.active).toMatchObject({ id: SEEDED_POLICY_ID, version: '1.0', status: 'active', windowDays: 30, sellerResponseBusinessDays: 2, infoReplyDays: 7, dropOffDays: 7 });
    expect(await h.service.defaultWindowDays()).toEqual({ windowDays: 30, policyVersion: '1.0' });
    expect(res.body.responsibilities.find((r: any) => r.reasonGroup === 'change_of_mind')).toMatchObject({ paidBy: 'customer', customerFee: { amount: 799 } });
    expect(res.body.responsibilities.find((r: any) => r.reasonGroup === 'damaged')).toMatchObject({ paidBy: 'seller', originalShippingRefunded: true });
    const official = await h.service.resolveTerms(null, null, null);
    expect(official).toMatchObject({ sellerId: OFFICIAL_STORE_ID, windowDays: 30, source: 'baseline', remedies: ['refund', 'replacement', 'exchange'], policyVersion: '1.0', policyVersionId: SEEDED_POLICY_ID });
    expect(official.responsibilities.every((r) => r.paidBy === 'platform')).toBe(true);
    // OFFICIAL_STORE_ID resolves the Official Store terms too, never a seller without terms
    expect(await h.service.resolveTerms(OFFICIAL_STORE_ID, null, null)).toEqual(official);
    expect((await h.service.sellerReturnTermsFor([OFFICIAL_STORE_ID]))[OFFICIAL_STORE_ID]).toEqual(official);
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
    expect(res.body).toMatchObject({ status: 'pending_approval', version: '1.1', approval: { required: true } });
    expect(h.calls.approvals.at(-1)).toMatchObject({ action: 'returns.baseline.change', target: { id: res.body.id } });
    expect((await h.call('POST', `/api/admin/returns/policies/${res.body.id}/withdraw`, staff(), { reason: 'x' })).status).toBe(409);
    await h.publish('access', 'access.approval.decided', { requestId: res.body.approval.approvalRequestId, ref: 'AP-3', actionKey: 'returns.baseline.change', module: 'returns', target: { type: 'return_policy', id: res.body.id }, outcome: 'approved', decidedBy: { kind: 'staff', id: newId() }, reason: null, amount: null, approverIds: [], requestedById: newId() });
    let admin = await h.call('GET', '/api/admin/returns/policies', staff());
    expect(admin.body.upcoming.find((v: any) => v.id === res.body.id)).toMatchObject({ status: 'scheduled' });
    expect(admin.body.active.version).toBe('1.0');
    h.clock.advance(3 * day);
    try {
      await h.app.kernel.jobs.runNow('returns.policy-activation');
      admin = await h.call('GET', '/api/admin/returns/policies', staff());
      expect(admin.body.active).toMatchObject({ id: res.body.id, status: 'active', version: '1.1' });
      expect(admin.body.history.find((v: any) => v.id === SEEDED_POLICY_ID)).toMatchObject({ status: 'superseded' });
      expect(h.named('returns.policy.changed').find((e) => e.policyVersionId === res.body.id)).toBeTruthy();
      const pub = await h.call('GET', '/api/store/returns/policy', tokens.visitor());
      expect(pub.body.responsibilities.find((r: any) => r.reasonGroup === 'change_of_mind').customerFee.amount).toBe(599);
      // a second version supersedes it; a scheduled one can be withdrawn
      h.authority.decision = 'allowed';
      const next = await h.call('POST', '/api/admin/returns/policies', staff(), version({ effectiveFrom: new Date(h.clock.now().getTime() + 5 * day).toISOString() }));
      expect(next.body).toMatchObject({ status: 'scheduled', version: '1.2' });
      const withdrawn = await h.call('POST', `/api/admin/returns/policies/${next.body.id}/withdraw`, staff(), { reason: 'Not now' });
      expect(withdrawn.body.status).toBe('withdrawn');
    } finally {
      h.clock.advance(-3 * day);
    }
  });
});

describe("the order item's category", () => {
  it('applies the category exception the item was bought under: terms, fault window and inspection checks', async () => {
    const categoryId = newId();
    const ex = await h.call('POST', '/api/admin/returns/category-exceptions', staff(), {
      categoryId,
      windowDays: 40,
      changeOfMindAllowed: true,
      condition: 'Unworn with tags attached',
      faultReturnsWindowDays: 90,
      shownOn: ['product_page', 'checkout', 'order'],
      effectiveFrom: new Date(h.clock.now().getTime() - 60_000).toISOString(),
      reason: 'Apparel',
    });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    const sellerId = newId();
    const p = product(h, { title: 'Jacket', price: 9000, sellerId, windowDays: 40, categoryId });
    const m = await placeOrder(h, [group(h, [line(p, 1)], { sellerId })]);
    const token = tokens.customer(m.customerId);
    const itemId = m.items[0]![0]!;

    const elig = await h.call('POST', '/api/store/returns/eligibility', token, { orderId: m.order.id, items: [{ orderItemId: itemId, quantity: 1 }], reason: 'damaged' });
    expect(elig.status, JSON.stringify(elig.body)).toBe(200);
    expect(elig.body.groups[0].terms).toMatchObject({ categoryId, source: 'category_exception', condition: 'Unworn with tags attached', windowDays: 40 });

    // past the 40-day change-of-mind window, damaged items can still come back within the category's 90 days
    h.clock.advance(60 * day);
    try {
      const items = await h.call('GET', `/api/store/returns/orders/${m.order.id}/returnable-items`, tokens.customer(m.customerId));
      expect(items.body.items[0]).toMatchObject({ eligible: true, quantityReturnable: 1 });
      expect(items.body.items[0].message).toContain('Only damaged, defective or wrong items');
    } finally {
      h.clock.advance(-60 * day);
    }

    const res = await h.call('POST', '/api/store/returns/requests', token, { orderId: m.order.id, items: [{ orderItemId: itemId, quantity: 1 }], reason: 'damaged', details: 'Torn seam', remedy: 'refund' }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.returns[0].id;
    const seller = tokens.seller(sellerId);
    expect((await h.call('POST', `/api/seller/returns/requests/${id}/approve`, seller, { labelMethod: 'prepaid_qr' })).status).toBe(200);
    expect((await h.call('POST', `/api/seller/returns/requests/${id}/receive`, seller, {})).status).toBe(200);
    const agg = (await h.service.core.load(id))!;
    expect(agg.ret.terms_snapshot.meta.categories).toEqual({ [itemId]: categoryId });
    const labels = h.service.views.checklist(agg, { '*': ['Clean, no odour'], [categoryId]: ['Tags attached'], [newId()]: ['Powers on'] })!.items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Clean, no odour', 'Tags attached']));
    expect(labels).not.toContain('Powers on');
  });
});
