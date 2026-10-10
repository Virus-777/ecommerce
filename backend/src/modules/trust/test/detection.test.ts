import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { evaluate } from '../domain/detection.js';
import { riskScore } from '../domain/rules.js';
import { resolvers } from '../graphql/resolvers.js';
import { ADMIN, boot, staff, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(() => kit.close());

const reportsBy = async (detector: string) => (await kit.call('GET', `${ADMIN}/reports?limit=100`, staff())).body.items.filter((r: any) => r.reporterLabel.includes(detector));

describe('detection rules', () => {
  it('a review burst raises one fake_reviews report; new reviews extend it', async () => {
    const productId = newId();
    const sellerId = newId();
    const publish = async () => {
      const reviewId = newId();
      await kit.emit('reviews', 'reviews.review.published', { reviewId, productId, sellerId, rating: 5, verified: false });
      return reviewId;
    };
    for (let i = 0; i < 7; i++) await publish();
    await kit.job('trust.run-detection');
    expect(await reportsBy('reviews.burst')).toHaveLength(0);
    const eighth = await publish();
    await kit.emit('reviews', 'reviews.review.published', { reviewId: eighth, productId, sellerId, rating: 5, verified: false }); // republished: same signal
    await kit.job('trust.run-detection');
    const [r] = await reportsBy('reviews.burst');
    expect(r).toMatchObject({ type: 'fake_reviews', source: 'automated', status: 'open' });
    expect(r.riskScore).toBeGreaterThanOrEqual(50);
    const full = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body;
    expect(full.detector).toBe('reviews.burst');
    expect(full.subjects.filter((s: any) => s.type === 'review')).toHaveLength(8);
    expect(full.evidence).toHaveLength(1);
    expect(full.riskFactors[0]).toMatchObject({ factor: 'signal', weight: 50 });
    // no new signals: nothing added; a new review extends the same report
    await kit.job('trust.run-detection');
    expect((await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body.evidence).toHaveLength(1);
    await publish();
    await kit.job('trust.run-detection');
    expect(await reportsBy('reviews.burst')).toHaveLength(1);
    expect((await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body.evidence).toHaveLength(2);
    const rules = (await kit.call('GET', `${ADMIN}/detection-rules`, staff())).body;
    expect(rules.find((x: any) => x.key === 'reviews.burst')).toMatchObject({ active: true, baseScore: 50, hitsLast30Days: 2, lastRunAt: expect.any(String) });
  });

  it('repeated chargebacks on one seller open a report straight away', async () => {
    const sellerId = newId();
    for (let i = 0; i < 3; i++) await kit.emit('payments', 'payments.chargeback.opened', { disputeId: newId(), ref: `DP-${i}`, kind: 'chargeback', orderId: newId(), sellerId, amount: { amount: 4999, currency: 'USD' } });
    const [r] = await reportsBy('payments.repeated_chargebacks');
    expect(r).toMatchObject({ type: 'suspicious_orders' });
    expect(r.subjects.filter((s: any) => s.type === 'order')).toHaveLength(3);
    expect(r.subjects.find((s: any) => s.type === 'seller').id).toBe(sellerId);
  });

  it('card testing and offers priced far below the others', async () => {
    const session = newId();
    for (let i = 0; i < 5; i++) await kit.emit('payments', 'payments.payment.failed', { intentId: newId(), checkoutSessionId: session, orderId: null, declineCategory: 'card_declined', afterPendingCheck: false, at: new Date(Date.now() + i).toISOString() });
    const productId = newId();
    const sellerId = newId();
    const offerId = newId();
    kit.products.set(productId, { title: 'Brightline S2', brandId: newId() });
    kit.offers.set(offerId, { sellerId, sellerName: 'Cheap Deals', productId, price: 4900 });
    for (const price of [18900, 19900, 21900]) kit.offers.set(newId(), { sellerId: newId(), sellerName: 'Peer', productId, price });
    await kit.emit('offers', 'offers.offer.created', { offerId, productId, variantId: newId(), ownerType: 'seller', sellerId, condition: 'new', stockItemId: newId() });
    await kit.job('trust.run-detection');
    expect(await reportsBy('payments.card_testing')).toHaveLength(1);
    const [p] = await reportsBy('offers.price_far_below_authorized');
    expect(p).toMatchObject({ type: 'counterfeit' });
    expect(p.subjects.map((s: any) => s.type).sort()).toEqual(['offer', 'product', 'seller']);
  });

  it('staff turn rules off or change thresholds, with a reason', async () => {
    const res = await kit.call('PATCH', `${ADMIN}/detection-rules/offers.restricted_brand`, staff(), { active: true, thresholds: { brandIds: ['b-1'] }, baseScore: 60, reason: 'Halden needs authorisation' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ key: 'offers.restricted_brand', baseScore: 60, thresholds: { brandIds: ['b-1'], allowedSellerIds: [], windowHours: 24 } });
    expect(kit.audits.at(-1)).toMatchObject({ action: 'trust.rule.update', reason: 'Halden needs authorisation', before: { baseScore: 40 }, after: { baseScore: 60 } });
    expect((await kit.call('PATCH', `${ADMIN}/detection-rules/nope`, staff(), { reason: 'x' })).status).toBe(404);
    expect((await kit.call('PATCH', `${ADMIN}/detection-rules/reviews.burst`, staff(), { baseScore: 500, reason: 'x' })).status).toBe(400);
    const off = await kit.call('PATCH', `${ADMIN}/detection-rules/payments.card_testing`, staff(), { active: false, reason: 'Provider handles it' });
    expect(off.body.active).toBe(false);
    expect((await kit.call('GET', `${ADMIN}/detection-rules`, staff(newId(), []))).status).toBe(403);
  });
});

describe('referrals from other modules', () => {
  it('reported messages open one abuse report per message; repeat reports add reporters; redelivery changes nothing', async () => {
    const messageId = newId();
    const first = { reportId: newId(), messageId, reason: 'harassment' };
    await kit.emit('messaging', 'messaging.message.reported', first);
    await kit.emit('messaging', 'messaging.message.reported', first);
    await kit.emit('messaging', 'messaging.message.reported', { reportId: newId(), messageId, reason: 'spam' });
    const list = (await kit.call('GET', `${ADMIN}/reports?subjectType=message&subjectId=${messageId}`, staff())).body.items;
    expect(list).toHaveLength(1);
    const full = (await kit.call('GET', `${ADMIN}/reports/${list[0].id}`, staff())).body;
    expect(full).toMatchObject({ type: 'abuse', source: 'referral', reporterCount: 2 });
    // messaging's own referral (raiseSignal with the same key) lands in the same report
    const r = await kit.svc.raiseSignal({ type: 'abuse', detector: 'messaging.report', title: 'Reported message', subjects: [{ type: 'message', id: messageId, label: 'Reported message' }], evidence: [{ kind: 'record_link', text: 'Moderator referral' }], dedupeKey: `messaging:report:${messageId}` });
    expect(r.id).toBe(list[0].id);
  });

  it('referred reviews open or extend a fake_reviews report about the author', async () => {
    const authorId = newId();
    const item = { moderationItemId: newId(), contentType: 'review', contentId: newId(), authorId, note: 'Same wording as 12 other reviews' };
    await kit.emit('reviews', 'reviews.content.referred', item);
    await kit.emit('reviews', 'reviews.content.referred', item);
    await kit.emit('reviews', 'reviews.content.referred', { ...item, moderationItemId: newId(), contentId: newId() });
    const list = (await kit.call('GET', `${ADMIN}/reports?subjectType=customer&subjectId=${authorId}`, staff())).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: 'fake_reviews', source: 'referral' });
    expect(list[0].subjects.filter((s: any) => s.type === 'review')).toHaveLength(2);
  });

  it('a submitted application is noted on the open assessment', async () => {
    const applicationId = newId();
    const sellerId = newId();
    const { reportId } = await kit.svc.requestAssessment({ subjectType: 'seller_application', subjectId: applicationId, sellerId, question: 'Check the address', requestedBy: { kind: 'staff', id: newId() } });
    const event = { applicationId, ref: 'SA-1', sellerId, categoryIds: [newId()], sellerType: 'business', invited: true, decisionTargetAt: new Date().toISOString(), duplicateCount: 0 };
    await kit.emit('sellers', 'sellers.application.submitted', event);
    await kit.emit('sellers', 'sellers.application.submitted', event);
    const full = (await kit.call('GET', `${ADMIN}/reports/${reportId}`, staff())).body;
    expect(full.evidence.filter((e: any) => e.kind === 'signal')).toHaveLength(1);
  });

  it('order and lifecycle events are recorded without failing for unknown records', async () => {
    const usd = { amount: 0, currency: 'USD' };
    await kit.emit('orders', 'orders.order.placed', { orderId: newId(), ref: 'MK-1', checkoutSessionId: newId(), customerId: newId(), guestEmail: null, paymentIntentId: newId(), paymentState: 'accepted', total: { amount: 1000, currency: 'USD' }, couponCodes: [], groups: [], placedAt: new Date().toISOString(), attemptNo: 1, contactName: 'Ana' });
    await kit.emit('orders', 'orders.item.cancelled', { orderId: newId(), ref: 'MK-2', groupId: newId(), ownerType: 'seller', sellerId: newId(), itemId: newId(), offerId: newId(), stockItemId: newId(), quantity: 1, cancellationId: newId(), initiatedBy: 'staff', reasonCode: 'fraud', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: usd, discountShare: usd, shippingRefund: usd, taxRefund: usd, total: usd }, paymentIntentId: newId(), trustReportId: newId(), notifyCustomer: true });
    await kit.emit('finance', 'finance.hold.placed', { holdId: newId(), sellerId: newId(), amount: { amount: 100, currency: 'USD' }, reasonCode: 'trust', reason: 'x', reviewDate: '2030-01-01', trustReportId: newId() });
    await kit.emit('support', 'support.case.opened', { caseId: newId(), ref: 'CS-1', kind: 'trust_outreach', category: 'trust', priority: 'normal', customerId: newId(), orderItemIds: [], handler: 'marketplace_support' });
    await kit.emit('customers', 'customers.account.restriction_lifted', { customerId: newId(), restrictionId: newId(), scope: 'messaging', trustEnforcementId: newId() });
    expect(true).toBe(true);
  });
});

describe('pure rules and GraphQL mapping', () => {
  it('the risk score explains every point', () => {
    const r = riskScore({ type: 'counterfeit', source: 'brand_owner', reporterCount: 3, signalScore: null, evidence: [{ kind: 'check', result: 'fail', source: 'staff' }], priorEnforcements: 1, recentSignals: 2, missingProof: 0 });
    expect(r.factors.map((f) => f.factor)).toEqual(['type', 'brand_owner', 'reporters', 'failed_checks', 'prior_enforcement', 'recent_signals']);
    expect(r.score).toBe(35 + 15 + 10 + 10 + 10 + 4);
    expect(riskScore({ type: 'other', source: 'automated', reporterCount: 1, signalScore: 99, evidence: Array(5).fill({ kind: 'check', result: 'fail', source: 'staff' }), priorEnforcements: 3, recentSignals: 9, missingProof: 2 }).score).toBe(100);
  });

  it('linked accounts at one address', () => {
    const at = new Date();
    const sig = (customerId: string) => ({ id: newId(), kind: 'order_placed', subject_type: 'order', subject_id: newId(), features: { customerId, addressKey: '1mainst|97204|us' }, at });
    expect(evaluate('orders.linked_new_accounts', { minAccounts: 3 }, [sig('a'), sig('b')])).toHaveLength(0);
    const hits = evaluate('orders.linked_new_accounts', { minAccounts: 3 }, [sig('a'), sig('b'), sig('c'), sig('a')]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.subjects.filter((s) => s.type === 'customer')).toHaveLength(3);
  });

  it('resolvers map counts and reports for the admin 360', async () => {
    const r = resolvers(kit.svc);
    const sellerId = newId();
    await kit.svc.raiseSignal({ type: 'abuse', detector: 'x', title: 'x', subjects: [{ type: 'seller', id: sellerId, label: 'S' }], evidence: [], dedupeKey: `gql:${sellerId}` });
    const counts = await (r.Seller!.trustReportCounts as any)({ id: sellerId }, {}, {});
    expect(counts).toEqual({ filedBy: 0, against: 1, open: 1 });
    const page = await (r.Seller!.trustReports as any)({ id: sellerId }, { role: 'AGAINST', statuses: ['OPEN'] }, {});
    expect(page.items[0]).toMatchObject({ type: 'ABUSE', status: 'OPEN', source: 'AUTOMATED', recommendations: { total: 0 }, enforcements: [] });
    expect(await (r.SellerRestriction!.trustReport as any)({ trustReportId: null }, {}, {})).toBeNull();
  });
});
