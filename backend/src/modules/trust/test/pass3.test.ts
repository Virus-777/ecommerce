/** Pass 3: confirmations by trustEnforcementId, store evidence requests, reporter contact, subjectIdsWithReports, detection inputs */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, customer, customerReport, listing, routed, seller, SELLER, staff, staffReport, STORE, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(() => kit.close());

const owner = (perm: string) => staff(newId(), ['trust.recommendations.decide', perm]);

describe('execution confirmed by the executing module (trustEnforcementId)', () => {
  it('warn_seller waits for sellers.warning.issued; lock_conversation for messaging.conversation.locked', async () => {
    const sellerId = newId();
    const r = await staffReport(kit, [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }]);
    const warn = await routed(kit, r.id, { action: 'warn_seller', targets: [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }] });
    const ok = await kit.call('POST', `${ADMIN}/recommendations/${warn.id}/decide`, owner('sellers.accounts.restrict'), { accept: true, reason: 'Misleading titles' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // bug (pass 3): warn_seller was applied on record before sellers had issued anything
    expect(ok.body.enforcement.executionState).toBe('pending');
    // another enforcement's id, or an unknown one, confirms nothing
    await kit.emit('sellers', 'sellers.warning.issued', { sellerId, warningId: newId(), kind: 'policy', title: 'x', trustEnforcementId: newId() });
    expect((await kit.svc.enforcementsFor('seller', sellerId))[0]!.executionState).toBe('pending');
    const warningId = newId();
    await kit.emit('sellers', 'sellers.warning.issued', { sellerId, warningId, kind: 'policy', title: 'Policy warning', trustEnforcementId: ok.body.enforcement.id });
    expect((await kit.svc.enforcementsFor('seller', sellerId))[0]).toMatchObject({ executionState: 'applied', appliedRef: warningId });

    const conversationId = newId();
    const rc = await staffReport(kit, [{ type: 'conversation', id: conversationId, label: 'Conversation' }], { type: 'abuse' });
    const lock = await routed(kit, rc.id, { action: 'lock_conversation', targets: [{ type: 'conversation', id: conversationId, label: 'Conversation' }] });
    const locked = await kit.call('POST', `${ADMIN}/recommendations/${lock.id}/decide`, owner('messaging.conversations.moderate'), { accept: true, reason: 'Threats' });
    expect(locked.body.enforcement.executionState).toBe('pending');
    await kit.emit('messaging', 'messaging.conversation.locked', { conversationId, reason: 'Threats', lockedBy: { kind: 'system', id: null }, trustEnforcementId: locked.body.enforcement.id });
    expect((await kit.svc.enforcementsFor('conversation', conversationId))[0]).toMatchObject({ executionState: 'applied', appliedRef: conversationId });
  });

  it('suspend_offer: confirmed by the enforcement id; a reinstatement carrying it does not confirm', async () => {
    const l = listing(kit);
    const r = await staffReport(kit, [{ type: 'offer', id: l.offerId, label: 'Offer' }]);
    const rec = await routed(kit, r.id, { action: 'suspend_offer', targets: [{ type: 'offer', id: l.offerId, label: 'Offer' }] });
    // offer suspension belongs to the Catalog Manager with offers.offers.remove (D8)
    expect((await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, owner('catalog.products.publish'), { accept: true, reason: 'x' })).status).toBe(403);
    const ok = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, owner('offers.offers.remove'), { accept: true, reason: 'Counterfeit' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const id = ok.body.enforcement.id;
    const changed = (to: string) => ({ offerId: l.offerId, productId: l.productId, variantId: newId(), sellerId: l.sellerId, ownerType: 'seller', from: 'active', to, reasonCode: 'trust', reason: 'x', stockItemId: newId(), trustEnforcementId: id });
    await kit.emit('offers', 'offers.offer.status_changed', changed('active'));
    expect((await kit.svc.enforcementsFor('offer', l.offerId))[0]!.executionState).toBe('pending');
    await kit.emit('offers', 'offers.offer.status_changed', changed('removed'));
    expect((await kit.svc.enforcementsFor('offer', l.offerId))[0]).toMatchObject({ executionState: 'applied', appliedRef: l.offerId });
  });
});

describe('proof asked from a customer (store)', () => {
  it('the customer lists and answers its own requests; others get 404; past dueAt is refused', async () => {
    const accountId = newId();
    const customerId = newId();
    kit.customers.set(customerId, { displayName: 'Ana Lopez', userId: accountId });
    const r = await staffReport(kit, [{ type: 'customer', id: customerId, label: 'Ana Lopez' }], { type: 'suspicious_orders' });
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const q = await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence-requests`, staff(), { to: { type: 'customer', id: customerId, label: 'Ana Lopez' }, question: 'Did you place order MK-1?', dueAt: due });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(kit.last('trust.evidence.requested')).toEqual({ requestId: q.body.id, reportId: r.id, reportRef: r.ref, toType: 'customer', toId: customerId, customerId, sellerId: null, question: 'Did you place order MK-1?', dueAt: due });

    const me = customer(accountId);
    const list = await kit.call('GET', `${STORE}/evidence-requests?state=open`, me);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ id: q.body.id, reportRef: r.ref, question: 'Did you place order MK-1?', state: 'open' })]);
    expect(JSON.stringify(list.body)).not.toContain('reporter');
    expect((await kit.call('GET', `${STORE}/evidence-requests`, customer())).body).toEqual([]);
    expect((await kit.call('POST', `${STORE}/evidence-requests/${q.body.id}/answer`, customer(), { answer: 'x' })).status).toBe(404);
    const media = newId();
    const ans = await kit.call('POST', `${STORE}/evidence-requests/${q.body.id}/answer`, me, { answer: 'Yes, it was me', mediaIds: [media] });
    expect(ans.status, JSON.stringify(ans.body)).toBe(200);
    expect(ans.body).toMatchObject({ state: 'answered', answer: 'Yes, it was me', reportRef: r.ref });
    expect(kit.callsOf('media.attach').at(-1)).toEqual([media, expect.objectContaining({ module: 'trust', kind: 'trust_evidence', refId: r.id }), { kind: 'customer', id: accountId }]);
    expect(kit.last('trust.evidence.received')).toEqual({ requestId: q.body.id, reportId: r.id });
    // the customer's "send proof" notice closes
    expect(kit.callsOf('notifications.resolve')).toContainEqual([`trust-evidence:${q.body.id}`]);
    const full = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body;
    expect(full.evidence.find((e: any) => e.source === 'reported_party')).toMatchObject({ kind: 'document', text: expect.stringContaining('Yes, it was me') });

    const late = await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence-requests`, staff(), { to: { type: 'customer', id: customerId, label: 'Ana Lopez' }, question: 'And order MK-2?', dueAt: new Date(Date.now() + 3_600_000).toISOString() });
    kit.clock.advance(2 * 3_600_000);
    const refused = await kit.call('POST', `${STORE}/evidence-requests/${late.body.id}/answer`, me, { answer: 'Too late' });
    expect(refused.status).toBe(409);
  });
});

describe('reporters and the customer and seller lists', () => {
  it('the account email is stored as the reporter contact and reaches trust.report.resolved', async () => {
    const l = listing(kit);
    const accountId = newId();
    const id = await customerReport(kit, l.offerId, customer(accountId));
    const res = await kit.call('POST', `${ADMIN}/reports/${id}/dismiss`, staff(), { reason: 'Genuine', reporterOutcome: 'We checked the listing' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(kit.last('trust.report.resolved').reporters).toEqual([expect.objectContaining({ kind: 'customer', contactEmail: `account.${accountId.slice(-6)}@example.com` })]);
  });

  it('subjectIdsWithReports filters before paging (against, filed_by, openOnly, ids)', async () => {
    const l = listing(kit);
    const quiet = newId();
    const accountId = newId();
    const customerId = newId();
    kit.customers.set(customerId, { displayName: 'Reporter', userId: accountId });
    await customerReport(kit, l.offerId, customer(accountId));
    expect(await kit.svc.subjectIdsWithReports('seller', { ids: [l.sellerId, quiet] })).toEqual([l.sellerId]);
    expect(await kit.svc.subjectIdsWithReports('seller', { role: 'filed_by', ids: [l.sellerId] })).toEqual([]);
    expect(await kit.svc.subjectIdsWithReports('seller', {})).toContain(l.sellerId);
    expect(await kit.svc.subjectIdsWithReports('customer', { role: 'filed_by', ids: [customerId, quiet] })).toEqual([customerId]);
    expect(await kit.svc.subjectIdsWithReports('customer', { role: 'against', ids: [customerId] })).toEqual([]);
    // dismissed reports drop out with openOnly
    const s2 = listing(kit);
    const rid = await customerReport(kit, s2.offerId);
    expect((await kit.call('POST', `${ADMIN}/reports/${rid}/dismiss`, staff(), { reason: 'Duplicate', reporterOutcome: 'Thanks' })).status).toBe(200);
    expect(await kit.svc.subjectIdsWithReports('seller', { openOnly: true, ids: [s2.sellerId] })).toEqual([]);
    expect(await kit.svc.subjectIdsWithReports('seller', { ids: [s2.sellerId] })).toEqual([s2.sellerId]);
  });

  it('subjectIdsWithReports finds customer reporters stored under their account id (pass 5)', async () => {
    const l = listing(kit);
    const accountId = newId();
    const customerId = newId();
    // customers did not know the account when it reported: the report is stored under the account id
    await customerReport(kit, l.offerId, customer(accountId));
    kit.customers.set(customerId, { displayName: 'Late customer', userId: accountId });
    // before pass 5 an id list only matched reporter ids equal to the customer id
    expect(await kit.svc.subjectIdsWithReports('customer', { role: 'filed_by', ids: [customerId, newId()] })).toEqual([customerId]);
    expect(await kit.svc.subjectIdsWithReports('customer', { ids: [customerId] })).toEqual([customerId]);
    expect(await kit.svc.subjectIdsWithReports('customer', { role: 'filed_by' })).toContain(customerId);
    expect(await kit.svc.subjectIdsWithReports('customer', { role: 'filed_by', ids: [newId()] })).toEqual([]);
  });
});

describe('detection inputs', () => {
  it('application hashes from sellers.application.submitted feed the duplicates rule', async () => {
    const taxIdHash = `h-${newId()}`;
    const submitted = (sellerId: string) => ({ applicationId: newId(), ref: 'SA-1', sellerId, categoryIds: [], sellerType: 'business', invited: false, decisionTargetAt: new Date().toISOString(), taxIdHash, bankTokenHash: null, addressKey: null, duplicateCount: 0 });
    const a = newId();
    const b = newId();
    await kit.emit('sellers', 'sellers.application.submitted', submitted(a));
    await kit.emit('sellers', 'sellers.application.submitted', submitted(b));
    const list = await kit.call('GET', `${ADMIN}/reports?source=automated&type=seller_application`, staff());
    const hit = list.body.items.find((x: any) => x.title.includes('tax id'));
    expect(hit).toBeTruthy();
  });

  it('the price rule compares with the median of the other active offers (D7)', async () => {
    const productId = newId();
    kit.products.set(productId, { title: 'Halden kettle' });
    // a single very expensive peer would pull a mid-range reference up; the median ignores it
    for (const price of [10000, 10400, 9800, 99900]) kit.offers.set(newId(), { sellerId: newId(), sellerName: 'Peer', productId, price });
    const offerId = newId();
    const sellerId = newId();
    kit.offers.set(offerId, { sellerId, sellerName: 'Fair Price', productId, price: 6000 });
    await kit.emit('offers', 'offers.offer.created', { offerId, productId, variantId: newId(), ownerType: 'seller', sellerId, condition: 'new', stockItemId: newId() });
    await kit.job('trust.run-detection');
    const list = await kit.call('GET', `${ADMIN}/reports?source=automated&type=counterfeit&subjectType=offer&subjectId=${offerId}`, staff());
    // 6000 is 59% of the median 10200: above the 50% threshold, so no report (the old midpoint of lowest and highest flagged it)
    expect(list.body.items).toEqual([]);
  });
});

describe('seller evidence requests keep working', () => {
  it('lists by seller id', async () => {
    const sellerId = newId();
    const r = await staffReport(kit, [{ type: 'seller', id: sellerId, label: 'S' }]);
    await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence-requests`, staff(), { to: { type: 'seller', id: sellerId, label: 'S' }, question: 'Invoices?', dueAt: new Date(Date.now() + 86_400_000 * 3).toISOString() });
    const list = await kit.call('GET', `${SELLER}/evidence-requests`, seller(sellerId));
    expect(list.body[0]).toMatchObject({ reportRef: r.ref });
  });
});
