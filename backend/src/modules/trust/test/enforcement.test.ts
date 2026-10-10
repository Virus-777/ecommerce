import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, buildTestApp, movingClock } from '../../../testing/app.js';
import type { CustomersPublicApi } from '../../customers/contract.js';
import { ADMIN, boot, customer, listing, routed, staff, staffReport, STORE, TRUST_PERMS, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(() => kit.close());

const catalogOwner = (id = newId()) => staff(id, ['trust.recommendations.decide', 'catalog.products.publish']);
const sellerManager = (id = newId()) => staff(id, ['trust.recommendations.decide', 'sellers.accounts.restrict', 'sellers.accounts.suspend']);
const finance = (id = newId()) => staff(id, ['trust.recommendations.decide', 'finance.holds.manage']);

describe('recommendations', () => {
  it('validates what is recommended', async () => {
    const r = await staffReport(kit, [{ type: 'seller', id: newId() }]);
    // action and ownerTeam are typed enums: refused by the request schema
    const badEnums = await kit.call('POST', `${ADMIN}/reports/${r.id}/recommendations`, staff(), { action: 'ban_forever', label: 'x', ownerTeam: 'legal', targets: [{ type: 'seller', id: r.subjects[0].id, label: 'Seller' }], rationale: 'x' });
    expect(badEnums.status).toBe(400);
    expect(badEnums.body.error.details.issues.map((i: any) => i.path).sort()).toEqual(['body.action', 'body.ownerTeam']);
    const bad = await kit.call('POST', `${ADMIN}/reports/${r.id}/recommendations`, staff(), { action: 'warn_seller', label: '', targets: [], rationale: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues.map((i: any) => i.path).sort()).toEqual(['label', 'rationale', 'targets']);
    // ownerTeam left out: the action's owner team (suspend_offer belongs to catalog, decision D8)
    const l = listing(kit);
    const dflt = await kit.call('POST', `${ADMIN}/reports/${r.id}/recommendations`, staff(), { action: 'suspend_offer', label: 'Suspend', targets: [{ type: 'offer', id: l.offerId, label: 'Offer' }], rationale: 'Counterfeit' });
    expect(dflt.status, JSON.stringify(dflt.body)).toBe(201);
    expect(dflt.body).toMatchObject({ ownerTeam: 'catalog', ownerRole: 'catalog_manager' });
    const wrongTarget = await kit.call('POST', `${ADMIN}/reports/${r.id}/recommendations`, staff(), { action: 'restrict_seller', label: 'Restrict', ownerTeam: 'sellers', targets: [{ type: 'offer', id: newId(), label: 'x' }], rationale: 'x' });
    expect(wrongTarget.status).toBe(400);
    const badParams = await kit.call('POST', `${ADMIN}/reports/${r.id}/recommendations`, staff(), { action: 'restrict_customer_messaging', label: 'Mute', ownerTeam: 'customers', targets: [{ type: 'customer', id: newId(), label: 'x' }], rationale: 'x', params: { endsAt: '2020-01-01T00:00:00Z' } });
    expect(badParams.status).toBe(400);
    expect(badParams.body.error.details.issues[0].path).toBe('params.endsAt');
  });

  it('route, withdraw and decline publish the decisions', async () => {
    const r = await staffReport(kit, [{ type: 'seller', id: newId() }]);
    const rec = await routed(kit, r.id, { action: 'warn_seller', ownerTeam: 'sellers', targets: [{ type: 'seller', id: r.subjects[0].id, label: 'Gadget Grove' }] });
    expect(rec).toMatchObject({ state: 'sent_to_owner', ownerRole: 'seller_manager', routedAt: expect.any(String) });
    expect(kit.last('trust.recommendation.routed')).toMatchObject({ recommendationId: rec.id, reportId: r.id, action: 'warn_seller', ownerTeam: 'sellers', ownerRole: 'seller_manager' });
    const queue = await kit.call('GET', `${ADMIN}/recommendations`, sellerManager());
    expect(queue.body.items.map((x: any) => x.id)).toContain(rec.id);
    expect((await kit.call('GET', `${ADMIN}/recommendations`, catalogOwner())).body.items.map((x: any) => x.id)).not.toContain(rec.id);
    const declined = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, sellerManager(), { accept: false, reason: 'First offence; coaching call instead' });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body).toMatchObject({ recommendation: { state: 'declined', decisionReason: 'First offence; coaching call instead' }, enforcement: null });
    expect(kit.last('trust.recommendation.decided')).toEqual({ recommendationId: rec.id, reportId: r.id, state: 'declined', reason: 'First offence; coaching call instead' });
    expect((await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/withdraw`, staff(), { reason: 'x' })).status).toBe(409);
    const other = await routed(kit, r.id, { action: 'warn_seller', ownerTeam: 'sellers', targets: [{ type: 'seller', id: r.subjects[0].id, label: 'Gadget Grove' }] });
    const w = await kit.call('POST', `${ADMIN}/recommendations/${other.id}/withdraw`, staff(), { reason: 'Seller fixed the listing' });
    expect(w.body.state).toBe('withdrawn');
    expect(kit.last('trust.recommendation.decided')).toMatchObject({ recommendationId: other.id, state: 'withdrawn' });
  });

  it('separate duties: trust staff cannot accept their own recommendation; the owner needs its own permission', async () => {
    const l = listing(kit);
    const r = await staffReport(kit, [{ type: 'product', id: l.productId, label: 'BRL-S2' }]);
    const rec = await routed(kit, r.id, { action: 'suspend_product', ownerTeam: 'catalog', targets: [{ type: 'product', id: l.productId, label: 'BRL-S2' }] });
    const own = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, staff(rec.trustStaff), { accept: true, reason: 'Counterfeit confirmed' });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('SEPARATE_DUTIES');
    const noPerm = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, staff(newId(), ['trust.recommendations.decide']), { accept: true, reason: 'x' });
    expect(noPerm.status).toBe(403);
    expect(noPerm.body.error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'catalog.products.publish' } });
    expect((await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, catalogOwner(), { accept: true, reason: '' })).status).toBe(400);

    const owner = newId();
    const ok = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, catalogOwner(owner), { accept: true, reason: 'Brand registry mismatch on 4 units' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const e = ok.body.enforcement;
    expect(e).toMatchObject({ ref: expect.stringMatching(/^EN-\d{6}-\d{4}$/), action: 'suspend_product', ownerTeam: 'catalog', executionState: 'pending', appealable: true, reason: 'Brand registry mismatch on 4 units', recordedBy: { kind: 'staff', id: owner } });
    expect(ok.body.recommendation).toMatchObject({ state: 'completed', enforcementId: e.id, decidedBy: { staffId: owner } });
    const recorded = kit.last('trust.enforcement.recorded');
    expect(recorded).toEqual({ enforcementId: e.id, reportId: r.id, action: 'suspend_product', ownerTeam: 'catalog', targets: [{ type: 'product', id: l.productId, ref: null, label: 'BRL-S2' }], reason: 'Brand registry mismatch on 4 units', params: {}, appealDeadline: e.appealDeadline, alreadyApplied: false });
    expect(kit.events.find((x) => x.name === 'trust.enforcement.recorded' && (x.payload as any).enforcementId === e.id)?.actor).toMatchObject({ kind: 'staff', id: owner });
    expect(kit.audits.at(-1)).toMatchObject({ action: 'trust.recommendation.accept', category: 'catalog' });
    expect((await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, catalogOwner(), { accept: true, reason: 'again' })).status).toBe(409);

    // catalog suspends the product with the report id: execution confirmed
    kit.products.get(l.productId)!.publication = 'suspended';
    await kit.emit('catalog', 'catalog.product.publication_changed', { productId: l.productId, from: 'active', to: 'suspended', reason: 'Trust and Risk enforcement: Brand registry mismatch on 4 units', trustReportId: r.id });
    const list = await kit.call('GET', `${ADMIN}/enforcements?targetType=product&targetId=${l.productId}`, staff());
    expect(list.body.items[0]).toMatchObject({ id: e.id, executionState: 'applied', appliedRef: l.productId, reportRef: r.ref });
    expect((await kit.svc.enforcementsFor('product', l.productId)).map((x) => x.id)).toEqual([e.id]);
    // the seller of the product's offers does not see it as theirs (shared product); the product owner would
  });

  it('restrict_seller: exact params for sellers, above the limit saved pending (200 with approval), confirmed by sellers.seller.restricted', async () => {
    const sellerId = newId();
    const r = await staffReport(kit, [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }]);
    const rec = await routed(kit, r.id, { action: 'restrict_seller', ownerTeam: 'sellers', targets: [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }], params: { affectedActivities: ['new_offers'], scope: { categoryIds: [newId()] } } });
    kit.authority.set('sellers.sellers.restrict', { decision: 'approval_required' });
    const sm = newId();
    const held = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, sellerManager(sm), { accept: true, reason: 'Counterfeit units sold' });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(held.body.enforcement).toBeNull();
    const requestId = held.body.approval.approvalRequestId;
    expect(held.body.approval).toMatchObject({ required: true, approvalRequestId: expect.any(String) });
    expect(held.body.recommendation).toMatchObject({ state: 'sent_to_owner', approvalRequestId: requestId, createdBy: { staffId: expect.any(String) }, routedBy: { staffId: expect.any(String) } });
    expect(kit.callsOf('access.requestApproval').at(-1)?.[0]).toMatchObject({ action: 'sellers.sellers.restrict', target: { type: 'trust_recommendation', id: rec.id, sellerId } });
    kit.authority.delete('sellers.sellers.restrict');
    expect((await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body.recommendations.find((x: any) => x.id === rec.id)).toMatchObject({ state: 'sent_to_owner' });

    // approved: trust accepts it as the requester (the decision delivered twice records one enforcement)
    const decided = { requestId, ref: 'AP-1', actionKey: 'sellers.sellers.restrict', module: 'sellers', target: { type: 'trust_recommendation', id: rec.id, sellerId }, outcome: 'approved', approverIds: [], requestedById: sm };
    await kit.emit('access', 'access.approval.decided', decided);
    await kit.emit('access', 'access.approval.decided', decided);
    const recordedEvents = kit.events.filter((x) => x.name === 'trust.enforcement.recorded' && (x.payload as any).reportId === r.id);
    expect(recordedEvents).toHaveLength(1);
    // authority already granted: sellers must not ask again, so the actor is Trust and Risk with the request
    expect(recordedEvents[0]!.actor).toEqual({ kind: 'system', id: null, name: `Trust and Risk (approval ${requestId})` });
    const enforcementId = (recordedEvents[0]!.payload as any).enforcementId as string;
    const decidedRec = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body.recommendations.find((x: any) => x.id === rec.id);
    expect(decidedRec).toMatchObject({ state: 'completed', enforcementId, decidedBy: { staffId: sm }, decisionReason: 'Counterfeit units sold', approvalRequestId: null });
    expect(kit.audits.filter((a) => a.action === 'trust.recommendation.accept' && a.target?.id === rec.id)).toEqual([
      expect.objectContaining({ approvalRequestId: requestId, actor: { kind: 'staff', id: sm } }),
    ]);
    const ok = { body: { enforcement: { id: enforcementId } } };
    const p = kit.last('trust.enforcement.recorded');
    expect(p.params).toMatchObject({ title: 'Selling restricted after a Trust and Risk review', reasonCode: 'policy_violation', reason: 'Counterfeit units sold', affectedActivities: ['new_offers'], toResolve: expect.any(String), appealDays: 14, reviewDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(p.appealDeadline).toEqual(expect.any(String));
    await kit.emit('sellers', 'sellers.seller.restricted', { sellerId, restrictionId: newId(), reasonCode: 'policy_violation', reason: 'x', affectedActivities: ['new_offers'], scope: { categoryIds: [] }, categoryIds: [], appealRoute: 'Account health', appealDeadline: new Date().toISOString(), reviewDate: '2030-01-01', trustReportId: r.id, trustEnforcementId: ok.body.enforcement.id });
    const full = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body;
    expect(full.enforcements[0]).toMatchObject({ executionState: 'applied' });
    expect(full.timeline.map((t: any) => t.label)).toEqual(expect.arrayContaining([expect.stringMatching(/^Approval requested/), expect.stringMatching(/^Enforcement EN-.* applied$/)]));
  });

  it('suspend_seller: sellers runs its own second review; the decider cannot be the second reviewer', async () => {
    const sellerId = newId();
    const r = await staffReport(kit, [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }]);
    const rec = await routed(kit, r.id, { action: 'suspend_seller', ownerTeam: 'sellers', targets: [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }] });
    kit.authority.set('sellers.sellers.suspend', { decision: 'approval_required', authority: 'permitted' });
    const sm = newId();
    expect((await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, sellerManager(sm), { accept: true, reason: 'Repeat counterfeits', params: { secondReviewerId: sm } })).status).toBe(400);
    const second = newId();
    const ok = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, sellerManager(sm), { accept: true, reason: 'Repeat counterfeits', params: { secondReviewerId: second, openOrders: 'cancel_unshipped_and_refund' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    kit.authority.delete('sellers.sellers.suspend');
    expect(kit.last('trust.enforcement.recorded').params).toEqual({ secondReviewerId: second, openOrders: 'cancel_unshipped_and_refund', reasonCode: 'policy_violation', reason: 'Repeat counterfeits', reviewDate: expect.any(String) });
    await kit.emit('sellers', 'sellers.seller.suspended', { sellerId, suspensionId: newId(), reasonCode: 'policy_violation', reason: 'Repeat counterfeits', reviewDate: '2030-01-01', openOrders: 'cancel_unshipped_and_refund', appealDeadline: new Date().toISOString(), trustReportId: r.id });
    expect((await kit.svc.enforcementsFor('seller', sellerId))[0]).toMatchObject({ action: 'suspend_seller', executionState: 'applied' });
  });

  it('actions no module executes need externalRef; event-confirmed ones stay pending until the owner event (D4)', async () => {
    const sellerId = newId();
    const r = await staffReport(kit, [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }]);
    const rec = await routed(kit, r.id, { action: 'hold_payout', ownerTeam: 'finance', targets: [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }], params: { amount: { amount: 250000, currency: 'USD' } } });
    const noRef = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, finance(), { accept: true, reason: 'Hold' });
    expect(noRef.status).toBe(422);
    expect(noRef.body.error.code).toBe('EXTERNAL_REF_REQUIRED');
    kit.authority.set('finance.holds.place', { decision: 'denied' });
    expect((await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, finance(), { accept: true, reason: 'Hold', externalRef: 'HD-261006-0004' })).status).toBe(403);
    kit.authority.delete('finance.holds.place');
    const ok = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, finance(), { accept: true, reason: 'Hold until the brand review ends', externalRef: 'HD-261006-0004' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // finance.hold.placed confirms it: still pending although the owner named the hold
    expect(ok.body.enforcement).toMatchObject({ executionState: 'pending', appliedRef: 'HD-261006-0004', appealable: false });
    expect(kit.last('trust.enforcement.recorded')).toMatchObject({ action: 'hold_payout', alreadyApplied: true, appealDeadline: null, params: { amount: { amount: 250000, currency: 'USD' }, reviewDate: expect.any(String) } });
    expect(kit.callsOf('access.check').at(-1)).toEqual(['finance.holds.place']);
    // a hold for another seller on the same report does not confirm it
    const usd = { amount: 250000, currency: 'USD' };
    await kit.emit('finance', 'finance.hold.placed', { holdId: newId(), sellerId: newId(), amount: usd, reasonCode: 'trust', reason: 'Other seller', reviewDate: '2030-01-01', trustReportId: r.id });
    expect((await kit.svc.enforcementsFor('seller', sellerId))[0]).toMatchObject({ executionState: 'pending' });
    const holdId = newId();
    await kit.emit('finance', 'finance.hold.placed', { holdId, sellerId, amount: usd, reasonCode: 'trust', reason: 'Trust hold', reviewDate: '2030-01-01', trustReportId: r.id });
    expect((await kit.svc.enforcementsFor('seller', sellerId))[0]).toMatchObject({ executionState: 'applied', appliedRef: holdId });

    // keep_reviews needs no externalRef and is applied on record
    const rv = await staffReport(kit, [{ type: 'review', id: newId(), label: 'Review' }], { type: 'fake_reviews' });
    const keep = await routed(kit, rv.id, { action: 'keep_reviews', targets: [{ type: 'review', id: rv.subjects[0].id, label: 'Review' }] });
    const kept = await kit.call('POST', `${ADMIN}/recommendations/${keep.id}/decide`, staff(newId(), ['trust.recommendations.decide', 'reviews.moderation.decide']), { accept: true, reason: 'Genuine reviews' });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.enforcement.executionState).toBe('applied');
  });

  it('owner modules confirm holds, cancellations, refunds and outreach that carry the report', async () => {
    const sellerId = newId();
    const orderId = newId();
    const buyer = newId();
    const r = await staffReport(kit, [{ type: 'seller', id: sellerId }, { type: 'order', id: orderId }, { type: 'customer', id: buyer }]);
    const decide = async (body: Record<string, unknown>, perm: string) => {
      const rec = await routed(kit, r.id, body);
      const ok = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, staff(newId(), ['trust.recommendations.decide', perm]), { accept: true, reason: 'Go ahead', externalRef: `REF-${body.action}` });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.enforcement.executionState).toBe('pending');
      return ok.body.enforcement.id as string;
    };
    const hold = await decide({ action: 'hold_payout', ownerTeam: 'finance', targets: [{ type: 'seller', id: sellerId, label: 'S' }], params: { amount: { amount: 5000, currency: 'USD' } } }, 'finance.holds.manage');
    const dispatch = await decide({ action: 'hold_dispatch', ownerTeam: 'orders', targets: [{ type: 'order', id: orderId, label: 'O' }] }, 'orders.orders.manage');
    const refund = await decide({ action: 'refund_buyers', ownerTeam: 'finance', targets: [{ type: 'order', id: orderId, label: 'O' }] }, 'returns.refunds.approve');
    const inform = await decide({ action: 'inform_customers', ownerTeam: 'support', targets: [{ type: 'customer', id: buyer, label: 'B' }] }, 'support.cases.handle');
    const usd = { amount: 5000, currency: 'USD' };
    const zero = { amount: 0, currency: 'USD' };
    await kit.emit('finance', 'finance.hold.placed', { holdId: newId(), sellerId, amount: usd, reasonCode: 'trust', reason: 'Trust hold', reviewDate: '2030-01-01', trustReportId: r.id });
    await kit.emit('orders', 'orders.item.cancelled', { orderId, ref: 'MK-261006-00001', groupId: newId(), ownerType: 'seller', sellerId, itemId: newId(), offerId: newId(), stockItemId: newId(), quantity: 1, cancellationId: newId(), initiatedBy: 'staff', reasonCode: 'fraud_review', beforeDispatch: true, countsAgainstSeller: false, refund: { itemAmount: zero, discountShare: zero, shippingRefund: zero, taxRefund: zero, total: zero }, paymentIntentId: newId(), trustReportId: r.id, notifyCustomer: true });
    await kit.emit('returns', 'returns.refund.approved', { refundRequestId: newId(), returnId: null, caseId: null, orderId, orderItemIds: [newId()], ownerType: 'seller', sellerId, source: 'exception', trustReportId: r.id, items: [], total: usd, breakdown: { itemAmount: usd, discountShare: zero, shippingRefund: zero, returnShippingDeduction: zero, deductions: [], total: usd, maxRefundable: usd, destination: 'original_method', isEstimate: false }, fundedBy: 'seller', approvedBy: { kind: 'staff', id: newId() } });
    // bug (pass 3): any case for the customer confirmed inform_customers; only a case naming the report does
    await kit.emit('support', 'support.case.opened', { caseId: newId(), ref: 'CS-104900', kind: 'customer', category: 'delivery', priority: 'normal', customerId: buyer, orderItemIds: [], handler: 'support' });
    expect((await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body.enforcements.find((e: any) => e.id === inform).executionState).toBe('pending');
    await kit.emit('support', 'support.case.opened', { caseId: newId(), ref: 'CS-104933', kind: 'outreach', category: 'trust', priority: 'normal', customerId: buyer, orderItemIds: [], handler: 'support', trustReportId: r.id });
    const full = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body;
    for (const id of [hold, dispatch, refund, inform]) expect(full.enforcements.find((e: any) => e.id === id).executionState).toBe('applied');
    expect(full.linkedCaseRefs).toContain('CS-104933');
    expect(full.timeline.map((t: any) => t.label)).toContain('Order MK-261006-00001: item cancelled by staff');
  });

  it('execution check flags unconfirmed enforcement; a later confirmation applies it', async () => {
    const l = listing(kit);
    const r = await staffReport(kit, [{ type: 'offer', id: l.offerId, label: 'Gadget Grove offer' }]);
    const rec = await routed(kit, r.id, { action: 'suspend_offer', ownerTeam: 'catalog', targets: [{ type: 'offer', id: l.offerId, label: 'Gadget Grove offer' }], params: { mode: 'hold', reviewDate: '2030-01-01' } });
    const ok = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, staff(newId(), ['trust.recommendations.decide', 'offers.offers.remove']), { accept: true, reason: 'Held while the brand checks' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(kit.last('trust.enforcement.recorded').params).toEqual({ mode: 'hold', reviewDate: '2030-01-01' });
    kit.clock.advance(61 * 60_000);
    await kit.job('trust.execution-check');
    const failed = (await kit.call('GET', `${ADMIN}/enforcements?executionState=failed`, staff())).body.items.find((x: any) => x.id === ok.body.enforcement.id);
    expect(failed).toMatchObject({ failure: expect.stringContaining('No confirmation from Catalog') });
    expect(kit.work.at(-1)).toMatchObject({ queueKey: 'catalog.product_review', kind: 'trust_recommendation', dedupeKey: `trust_enforcement:${ok.body.enforcement.id}:unconfirmed` });
    // the seller sees the hold on its offer, with the appeal route
    const mine = await kit.call('GET', '/api/seller/trust/enforcements', (await import('./helpers.js')).seller(l.sellerId));
    expect(mine.body).toEqual([]);
    kit.offers.get(l.offerId)!.status = 'ineligible';
    await kit.emit('offers', 'offers.offer.status_changed', { offerId: l.offerId, productId: l.productId, variantId: newId(), sellerId: l.sellerId, ownerType: 'seller', from: 'active', to: 'ineligible', reasonCode: 'enforcement', reason: 'Held while the brand checks', stockItemId: newId(), trustEnforcementId: ok.body.enforcement.id });
    const e = (await kit.call('GET', `${ADMIN}/enforcements?targetType=offer&targetId=${l.offerId}`, staff())).body.items[0];
    expect(e).toMatchObject({ executionState: 'applied', appliedRef: l.offerId, failure: null });
    expect(kit.callsOf('workqueues.resolveBySource').at(-1)).toEqual([`trust_enforcement:${e.id}:unconfirmed`]);
    const sellerView = await kit.call('GET', '/api/seller/trust/enforcements', (await import('./helpers.js')).seller(l.sellerId));
    expect(sellerView.body[0]).toMatchObject({ id: e.id, title: 'Offer held for review', appealable: true, appealRoute: expect.stringContaining('Appeal to Trust and Risk') });
  });

  it('reverses applied enforcement with authority from access', async () => {
    const r = await staffReport(kit, [{ type: 'review', id: newId(), label: 'Review' }, { type: 'review', id: newId(), label: 'Review 2' }], { type: 'fake_reviews' });
    const [rv1, rv2] = [r.subjects[0].id, r.subjects[1].id];
    const rec = await routed(kit, r.id, { action: 'remove_reviews', ownerTeam: 'reviews', targets: [{ type: 'review', id: rv1, label: 'Review' }, { type: 'review', id: rv2, label: 'Review 2' }] });
    const ok = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, staff(newId(), ['trust.recommendations.decide', 'reviews.moderation.decide']), { accept: true, reason: 'Paid review ring' });
    const id = ok.body.enforcement.id;
    // remove_reviews is confirmed by reviews.moderation.decided (trustEnforcementId) once every named review is removed
    expect(ok.body.enforcement.executionState).toBe('pending');
    const removed = (contentId: string) => ({ moderationItemId: newId(), contentType: 'review', contentId, decision: 'remove', reasonCode: 'fake_or_incentivised', reporters: [], trustEnforcementId: id });
    await kit.emit('reviews', 'reviews.moderation.decided', removed(rv1));
    await kit.emit('reviews', 'reviews.moderation.decided', removed(rv1));
    expect((await kit.call('GET', `${ADMIN}/enforcements?targetType=review&targetId=${rv1}`, staff())).body.items[0].executionState).toBe('pending');
    await kit.emit('reviews', 'reviews.moderation.decided', removed(rv2));
    expect((await kit.call('GET', `${ADMIN}/enforcements?targetType=review&targetId=${rv1}`, staff())).body.items[0].executionState).toBe('applied');
    kit.authority.set('trust.enforcements.reverse', { decision: 'denied' });
    expect((await kit.call('POST', `${ADMIN}/enforcements/${id}/reverse`, staff(), { reason: 'Error' })).status).toBe(403);
    kit.authority.set('trust.enforcements.reverse', { decision: 'approval_required' });
    const reverser = newId();
    const decided = (requestId: string, outcome: string) => ({ requestId, ref: 'AP-1', actionKey: 'trust.enforcements.reverse', module: 'trust', target: { type: 'trust_enforcement', id }, outcome, decidedBy: { kind: 'staff', id: newId(), name: 'Owner' }, reason: outcome === 'rejected' ? 'Not convinced' : null, approverIds: [], requestedById: reverser });
    const rejected = await kit.call('POST', `${ADMIN}/enforcements/${id}/reverse`, staff(reverser), { reason: 'Error' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body).toMatchObject({ executionState: 'applied', reversalRequestId: rejected.body.approval.approvalRequestId, approval: { required: true } });
    // rejected: the enforcement stays applied, with a timeline entry
    await kit.emit('access', 'access.approval.decided', decided(rejected.body.approval.approvalRequestId, 'rejected'));
    const afterReject = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body;
    expect(afterReject.enforcements.find((x: any) => x.id === id)).toMatchObject({ executionState: 'applied', reversalRequestId: null });
    expect(afterReject.timeline.map((t: any) => t.label)).toContain(`Approval rejected to reverse ${ok.body.enforcement.ref}; the enforcement stays in place`);

    const held = await kit.call('POST', `${ADMIN}/enforcements/${id}/reverse`, staff(reverser), { reason: 'Reviews were genuine' });
    expect(held.status).toBe(200);
    const requestId = held.body.approval.approvalRequestId;
    kit.authority.delete('trust.enforcements.reverse');
    // approved (delivered twice): reversed once, as the requester, with their reason
    await kit.emit('access', 'access.approval.decided', decided(requestId, 'approved'));
    await kit.emit('access', 'access.approval.decided', decided(requestId, 'approved'));
    const rev = { body: (await kit.call('GET', `${ADMIN}/enforcements?targetType=review&targetId=${r.subjects[0].id}`, staff())).body.items.find((x: any) => x.id === id) };
    expect(rev.body).toMatchObject({ executionState: 'reversed', reversalReason: 'Reviews were genuine', reversedAt: expect.any(String), reversalRequestId: null });
    expect(kit.of('trust.enforcement.reversed').filter((x) => x.enforcementId === id)).toEqual([
      {
        enforcementId: id,
        ref: ok.body.enforcement.ref,
        reportId: r.id,
        reportRef: r.ref,
        action: 'remove_reviews',
        ownerTeam: 'reviews',
        targets: [expect.objectContaining({ type: 'review', id: rv1 }), expect.objectContaining({ type: 'review', id: rv2 })],
        params: {},
        appliedRef: expect.any(String),
        executionState: 'applied',
        reason: 'Reviews were genuine',
        appealId: null,
        reversedBy: { kind: 'staff', id: reverser },
        reversedAt: expect.any(String),
      },
    ]);
    // the owner team checks the undo (stopgap, decision D9): one enforcement_reversal item in its queue
    expect(kit.work.filter((w) => w.dedupeKey === `trust_reversal:${id}`)).toEqual([expect.objectContaining({ queueKey: 'trust.reports', kind: 'enforcement_reversal', sourceModule: 'trust', priority: 'high' })]);
    expect(kit.audits.filter((a) => a.action === 'trust.enforcement.reverse' && a.target?.id === id)).toEqual([expect.objectContaining({ approvalRequestId: requestId, actor: { kind: 'staff', id: reverser } })]);
    expect((await kit.call('POST', `${ADMIN}/enforcements/${id}/reverse`, staff(), { reason: 'again' })).status).toBe(409);
    expect((await kit.call('POST', `${ADMIN}/enforcements/${newId()}/reverse`, staff(), { reason: 'x' })).status).toBe(404);
  });
});

describe('with the real customers module', () => {
  let app: FastifyInstance;
  const call = async (method: string, url: string, token: string, body?: unknown) => {
    const res = await app.inject({ method: method as never, url, headers: auth(token), ...(body !== undefined ? { payload: body as object } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  beforeAll(async () => {
    app = await buildTestApp({ only: ['trust', 'customers'], clock: movingClock(), config: { rateLimits: false } });
  });
  afterAll(() => app.close());

  it('restrict_customer_messaging is executed by customers, confirmed back, listed for the customer and appealable', async () => {
    const accountId = newId();
    app.kernel.events.publish('identity', 'identity.user.registered', { accountId, email: `ana.${accountId.slice(-6)}@example.com`, firstName: 'Ana', lastName: 'Lopez', marketingOptIn: false, acceptedTermsVersion: '1', at: new Date().toISOString() });
    await app.kernel.events.drain();
    const customers = app.kernel.boot.apis.get('customers') as unknown as CustomersPublicApi;
    const c = (await customers.getCustomerByUserId(accountId))!;
    expect(c).toBeTruthy();
    const trustStaff = newId();
    const report = await call('POST', `${ADMIN}/reports`, staff(trustStaff, TRUST_PERMS), { type: 'abuse', title: 'Abusive messages to sellers', description: 'Threats in 3 conversations', subjects: [{ type: 'customer', id: c.id, label: 'Ana Lopez' }] });
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const add = await call('POST', `${ADMIN}/reports/${report.body.id}/recommendations`, staff(trustStaff, TRUST_PERMS), { action: 'restrict_customer_messaging', label: 'Pause messaging for 30 days', ownerTeam: 'customers', targets: [{ type: 'customer', id: c.id, label: 'Ana Lopez' }], rationale: 'Threats', params: { endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await call('POST', `${ADMIN}/recommendations/${add.body.id}/route`, staff(trustStaff, TRUST_PERMS))).status).toBe(200);
    const support = staff(newId(), ['trust.recommendations.decide', 'customers.accounts.act']);
    const ok = await call('POST', `${ADMIN}/recommendations/${add.body.id}/decide`, support, { accept: true, reason: 'Threatening messages to two sellers' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const snap = await customers.getCustomer(c.id);
    expect(snap?.canMessage).toBe(false);
    const full = await call('GET', `${ADMIN}/reports/${report.body.id}`, staff());
    expect(full.body.enforcements[0]).toMatchObject({ executionState: 'applied', appliedRef: expect.any(String) });
    expect(full.body.subjects[0].statusLabel).toBe('Restricted');

    const me = customer(accountId);
    const mine = await call('GET', `${STORE}/enforcements`, me);
    expect(mine.body).toEqual([expect.objectContaining({ id: ok.body.enforcement.id, title: 'Messaging restricted', reason: 'Threatening messages to two sellers', appealable: true, appealId: null })]);
    expect((await call('GET', `${STORE}/enforcements`, customer())).body).toEqual([]);
    const appeal = await call('POST', `${STORE}/appeals`, me, { enforcementId: ok.body.enforcement.id, argument: 'The messages were quoted out of context' });
    expect(appeal.status, JSON.stringify(appeal.body)).toBe(201);
    expect(appeal.body).toMatchObject({ source: 'trust', state: 'open', appellant: { kind: 'customer' }, appellantName: 'Ana Lopez', reportId: report.body.id });
    expect((await call('GET', `${STORE}/enforcements`, me)).body[0].appealId).toBe(appeal.body.id);
    expect((await call('GET', `${STORE}/appeals`, me)).body.map((a: any) => a.id)).toEqual([appeal.body.id]);
    // GraphQL: the restriction knows its report
    const gql = await app.inject({ method: 'POST', url: '/graphql/admin', headers: auth(staff()), payload: { query: `{ customer(id: "${c.id}") { trustReportCounts { against open filedBy } restrictions { trustReport { ref status riskLevel enforcements { executionState action } } } trustReports(role: AGAINST) { items { ref type } total } } }` } });
    const data = JSON.parse(gql.body);
    expect(data.errors).toBeUndefined();
    expect(data.data.customer.trustReportCounts).toEqual({ against: 1, open: 1, filedBy: 0 });
    expect(data.data.customer.restrictions[0].trustReport).toMatchObject({ ref: report.body.ref, status: 'OPEN', enforcements: [{ executionState: 'APPLIED', action: 'restrict_customer_messaging' }] });
    expect(data.data.customer.trustReports).toMatchObject({ total: 1, items: [{ ref: report.body.ref, type: 'ABUSE' }] });
  });
});
