import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, customer, customerReport, listing, PUBLIC, seller, SELLER, staff, STORE, visitor, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(() => kit.close());

describe('reports from customers and sellers', () => {
  it('a customer reports an offer: the report names the listing and seller, never the reporter to others', async () => {
    const l = listing(kit);
    const me = newId();
    const media = newId();
    const res = await kit.call('POST', `${STORE}/reports`, customer(me), { type: 'counterfeit', subject: { type: 'offer', id: l.offerId }, reason: 'may_be_counterfeit', details: 'Serial does not match', evidenceIds: [media] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ what: 'Report on a listing', about: 'Brightline S2 Robot Vacuum from Gadget Grove', youSaid: 'May be counterfeit: Serial does not match', statusLabel: 'received', outcome: null });
    expect(res.body.ref).toMatch(/^TR-\d{4}$/);
    expect(res.body.expectedBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const created = kit.last('trust.report.created');
    expect(created).toMatchObject({ reportId: res.body.id, type: 'counterfeit', source: 'customer' });
    expect(created.subjects.map((s: any) => s.type).sort()).toEqual(['offer', 'seller']);
    expect(kit.callsOf('media.attach').at(-1)).toEqual([media, expect.objectContaining({ module: 'trust', kind: 'trust_evidence' }), { kind: 'customer', id: me }]);

    // staff see the reporter; another customer does not see the report at all
    const full = await kit.call('GET', `${ADMIN}/reports/${res.body.id}`, staff());
    expect(full.status).toBe(200);
    expect(full.body.reporter.actor).toEqual({ kind: 'customer', id: me });
    expect(full.body.riskFactors.length).toBeGreaterThan(0);
    expect(full.body.deadline.state).toBe('on_time');
    expect(full.body.subjects.find((s: any) => s.type === 'offer')).toMatchObject({ screen: 'admin/offers', statusLabel: 'Active' });
    expect((await kit.call('GET', `${STORE}/reports/${res.body.id}`, customer())).status).toBe(404);
    expect((await kit.call('GET', `${STORE}/reports/${res.body.id}`, customer(me))).body.id).toBe(res.body.id);
    const mine = await kit.call('GET', `${STORE}/reports`, customer(me));
    expect(mine.body.items.map((r: any) => r.id)).toEqual([res.body.id]);
  });

  it('the same subject from the same reporter within 24 h updates the report; later it opens a new one', async () => {
    const l = listing(kit);
    const me = customer();
    const first = await customerReport(kit, l.offerId, me);
    const again = await kit.call('POST', `${STORE}/reports`, me, { type: 'counterfeit', subject: { type: 'offer', id: l.offerId }, reason: 'may_be_counterfeit', details: 'Also the logo is blurry' });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first);
    const full = await kit.call('GET', `${ADMIN}/reports/${first}`, staff());
    expect(full.body.evidence.filter((e: any) => e.kind === 'statement')).toHaveLength(2);
    expect(full.body.reporterCount).toBe(1);
    kit.clock.advance(25 * 3_600_000);
    const later = await customerReport(kit, l.offerId, me);
    expect(later).not.toBe(first);
  });

  it('validates the form and limits reports per day', async () => {
    const me = customer();
    const bad = await kit.call('POST', `${STORE}/reports`, me, { type: 'counterfeit', subject: { type: 'review', id: newId() }, reason: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues.map((i: any) => i.path).sort()).toEqual(['reason', 'subject.type']);
    // an offer the catalog does not know
    expect((await kit.call('POST', `${STORE}/reports`, me, { type: 'counterfeit', subject: { type: 'offer', id: newId() }, reason: 'x' })).status).toBe(400);
    for (let i = 0; i < 20; i++) {
      const l = listing(kit);
      await customerReport(kit, l.offerId, me);
    }
    const l = listing(kit);
    const limited = await kit.call('POST', `${STORE}/reports`, me, { type: 'counterfeit', subject: { type: 'offer', id: l.offerId }, reason: 'x' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('a seller reports an abusive customer; it cannot report its own offer', async () => {
    const l = listing(kit);
    const own = await kit.call('POST', `${SELLER}/reports`, seller(l.sellerId), { type: 'counterfeit', subject: { type: 'offer', id: l.offerId }, reason: 'x' });
    expect(own.status).toBe(400);
    const buyer = newId();
    kit.customers.set(buyer, { displayName: 'Sam Buyer' });
    expect((await kit.call('POST', `${SELLER}/reports`, seller(l.sellerId), { type: 'abuse', subject: { type: 'customer', id: newId() }, reason: 'x' })).status).toBe(400);
    const c = await kit.call('POST', `${SELLER}/reports`, seller(l.sellerId), { type: 'abuse', subject: { type: 'customer', id: buyer }, reason: 'abusive_messages', details: 'Threats in messages' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.what).toBe('Report on a customer');
    expect((await kit.call('GET', `${SELLER}/reports`, seller(l.sellerId))).body.items.map((r: any) => r.id)).toEqual([c.body.id]);
    expect((await kit.call('GET', `${SELLER}/reports`, seller(newId()))).body.items).toEqual([]);
    expect((await kit.call('POST', `${SELLER}/reports`, seller(l.sellerId, []), { type: 'abuse', subject: { type: 'customer', id: newId() }, reason: 'x' })).status).toBe(403);
  });

  it('the reporter adds details while the report is open and sees the outcome when it closes', async () => {
    const l = listing(kit);
    const accountId = newId();
    const customerId = newId();
    kit.customers.set(customerId, { displayName: 'Ana Buyer', userId: accountId });
    const me = customer(accountId);
    const id = await customerReport(kit, l.offerId, me);
    const added = await kit.call('POST', `${STORE}/reports/${id}/evidence`, me, { text: 'Photo of the box', mediaIds: [newId()] });
    expect(added.status).toBe(200);
    const res = await kit.call('POST', `${ADMIN}/reports/${id}/assign`, staff(), { staffId: newId() });
    expect(res.status).toBe(200);
    expect((await kit.call('GET', `${STORE}/reports/${id}`, me)).body.statusLabel).toBe('under_review');
    const done = await kit.call('POST', `${ADMIN}/reports/${id}/resolve`, staff(), { outcome: 'action_taken', summary: 'Offer removed', reporterOutcome: 'We removed the listing. Thank you.' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // the reporter is named by the customer id (stored under the account id or the customer id)
    expect(kit.of('trust.report.resolved').filter((e) => e.reportId === id)).toEqual([
      { reportId: id, ref: expect.stringMatching(/^TR-/), outcome: 'action_taken', reporterOutcome: 'We removed the listing. Thank you.', reporters: [{ kind: 'customer', customerId, contactName: expect.toBeOneOf([null, 'Ana Buyer']), contactEmail: expect.stringMatching(/@example.com$/) }] },
    ]);
    const mine = (await kit.call('GET', `${STORE}/reports/${id}`, me)).body;
    expect(mine).toMatchObject({ statusLabel: 'action_taken', outcome: 'We removed the listing. Thank you.', expectedBy: null });
    const late = await kit.call('POST', `${STORE}/reports/${id}/evidence`, me, { text: 'More' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await kit.call('POST', `${STORE}/reports/${id}/evidence`, customer(), { text: 'Not mine' })).status).toBe(404);
  });

  it('a brand owner reports listings from the public form', async () => {
    const l = listing(kit);
    const res = await kit.call('POST', `${PUBLIC}/reports`, visitor(), { brandName: 'Brightline', contactName: 'Rita Brand', contactEmail: 'rita@brightline.example.com', offerOrProductIds: [l.offerId, l.productId], details: 'Not an authorised reseller', proofMediaIds: [newId()] });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toEqual({ ref: expect.stringMatching(/^TR-/), confirmationSent: kit.app.kernel.modules.includes('notifications') });
    const created = kit.last('trust.report.created');
    // the receipt with the TR reference goes to the contact address (notifications), once
    expect(kit.of('trust.rights_report.received').filter((e) => e.reportId === created.reportId)).toEqual([{ reportId: created.reportId, ref: res.body.ref, brandName: 'Brightline', contactName: 'Rita Brand', contactEmail: 'rita@brightline.example.com' }]);
    expect(created).toMatchObject({ source: 'brand_owner', type: 'counterfeit' });
    const full = await kit.call('GET', `${ADMIN}/reports/${created.reportId}`, staff());
    expect(full.body.reporter).toMatchObject({ contactEmail: 'rita@brightline.example.com' });
    expect(full.body.riskFactors.map((f: any) => f.factor)).toContain('brand_owner');
    expect(full.body.subjects.map((s: any) => s.type).sort()).toEqual(['offer', 'product', 'seller']);
    const bad = await kit.call('POST', `${PUBLIC}/reports`, visitor(), { brandName: 'Brightline', contactName: 'Rita', contactEmail: 'rita@brightline.example.com', offerOrProductIds: [l.offerId], details: 'x', proofMediaIds: [] });
    expect(bad.status).toBe(400);
    expect(kit.of('trust.rights_report.received').filter((e) => e.contactName === 'Rita')).toEqual([]);
  });

  it('a dismissal tells every reporter of the report and of the duplicates merged into it, once each', async () => {
    const l = listing(kit);
    const accountId = newId();
    const customerId = newId();
    kit.customers.set(customerId, { displayName: 'Bo Buyer', userId: accountId });
    const kept = await customerReport(kit, l.offerId, customer(accountId));
    const rival = listing(kit).sellerId;
    const bySeller = await kit.call('POST', `${SELLER}/reports`, seller(rival), { type: 'counterfeit', subject: { type: 'offer', id: l.offerId }, reason: 'may_be_counterfeit' });
    expect(bySeller.status, JSON.stringify(bySeller.body)).toBe(201);
    const brand = await kit.call('POST', `${PUBLIC}/reports`, visitor(), { brandName: 'Brightline', contactName: 'Rita Brand', contactEmail: 'rita@brightline.example.com', offerOrProductIds: [l.offerId], details: 'Not an authorised reseller', proofMediaIds: [newId()] });
    const brandId = kit.of('trust.rights_report.received').find((e) => e.ref === brand.body.ref)!.reportId;
    // the same customer again on another listing, merged in as well: still told once
    const again = await customerReport(kit, listing(kit).offerId, customer(accountId));
    for (const dup of [bySeller.body.id, brandId, again]) expect((await kit.call('POST', `${ADMIN}/reports/${dup}/merge`, staff(), { intoReportId: kept, reason: 'Same listing' })).status).toBe(200);
    const res = await kit.call('POST', `${ADMIN}/reports/${kept}/dismiss`, staff(), { reason: 'Genuine stock', reporterOutcome: 'We checked the listing and found no violation' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const resolved = kit.of('trust.report.resolved').filter((e) => e.reportId === kept);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ ref: res.body.ref, outcome: 'dismissed', reporterOutcome: 'We checked the listing and found no violation' });
    expect(resolved[0].reporters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'customer', customerId }),
        expect.objectContaining({ kind: 'seller', sellerId: rival }),
        { kind: 'rights_owner', contactName: 'Rita Brand', contactEmail: 'rita@brightline.example.com' },
      ]),
    );
    expect(resolved[0].reporters).toHaveLength(3);
  });
});

describe('signals and assessments from other modules', () => {
  it('raiseSignal de-duplicates by key while the report is open', async () => {
    const sellerId = newId();
    const input = { type: 'suspicious_orders', detector: 'payments.fraud', title: 'Card testing', subjects: [{ type: 'seller' as const, id: sellerId, label: 'Seller' }], evidence: [{ kind: 'signal' as const, result: 'warn' as const, text: '6 declines' }], score: 75, dedupeKey: `fraud:${sellerId}` };
    const a = await kit.svc.raiseSignal(input);
    const b = await kit.svc.raiseSignal({ ...input, evidence: [{ kind: 'signal', result: 'fail', text: '9 declines' }] });
    expect(b.id).toBe(a.id);
    expect(b.evidence).toHaveLength(2);
    expect(a.source).toBe('automated');
    expect(a.riskScore).toBeGreaterThanOrEqual(75);
    expect(a.riskFactors[0]).toMatchObject({ factor: 'signal', weight: 75 });
    await kit.call('POST', `${ADMIN}/reports/${a.id}/dismiss`, staff(), { reason: 'Test cards from QA', reporterOutcome: 'n/a' });
    const c = await kit.svc.raiseSignal(input);
    expect(c.id).not.toBe(a.id);
    const counts = await kit.svc.reportsAbout('seller', sellerId);
    expect(counts).toMatchObject({ against: 2, open: 1, filedBy: 0 });
  });

  it('requestAssessment opens a report and the recorded assessment answers sellers', async () => {
    const applicationId = newId();
    const sellerId = newId();
    kit.sellers.set(sellerId, { storeName: 'Northwind Audio', status: 'under_review' });
    const r = await kit.svc.requestAssessment({ subjectType: 'seller_application', subjectId: applicationId, sellerId, question: 'Brand authorisation for Halden?', requestedBy: { kind: 'staff', id: newId() } });
    expect(r.ref).toMatch(/^TR-/);
    const again = await kit.svc.requestAssessment({ subjectType: 'seller_application', subjectId: applicationId, sellerId, question: 'And the address?', requestedBy: { kind: 'staff', id: newId() } });
    expect(again.reportId).toBe(r.reportId);
    const before = await kit.call('GET', `${ADMIN}/reports/${r.reportId}`, staff());
    expect(before.body).toMatchObject({ type: 'seller_application', source: 'referral', assessment: null });
    const res = await kit.call('POST', `${ADMIN}/reports/${r.reportId}/assessment`, staff(), { level: 'medium', flags: [{ severity: 'warn', text: 'Address shared with a closed account' }], recommendation: 'Approve with a 14-day payout hold', recommendedHoldDays: 14 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(res.body.assessment).toMatchObject({ level: 'medium', recommendedHoldDays: 14 });
    expect(kit.last('trust.assessment.completed')).toEqual({ reportId: r.reportId, subjectType: 'seller_application', subjectId: applicationId, level: 'medium', flags: [{ severity: 'warn', text: 'Address shared with a closed account' }], recommendation: 'Approve with a 14-day payout hold', recommendedHoldDays: 14 });
    expect(kit.last('trust.report.resolved')).toEqual({ reportId: r.reportId, ref: r.ref, outcome: 'referred', reporterOutcome: null, reporters: [] });
    const twice = await kit.call('POST', `${ADMIN}/reports/${r.reportId}/assessment`, staff(), { level: 'low', flags: [], recommendation: 'x' });
    expect(twice.status).toBe(409);
    expect(kit.audits.at(-1)?.action).toBe('trust.assessment.record');
  });

  it('summaries for other modules leave out reporter identity, evidence and notes', async () => {
    const l = listing(kit);
    const id = await customerReport(kit, l.offerId);
    await kit.call('POST', `${ADMIN}/reports/${id}/notes`, staff(), { body: 'Internal only' });
    const [s] = await kit.svc.getReportSummaries([id, newId()]);
    expect(s).toMatchObject({ id, reporter: null, evidence: [], notes: [], timeline: [] });
    const page = await kit.svc.listReportsAbout('seller', l.sellerId, { role: 'against' }, {});
    expect(page.items.map((r) => r.id)).toEqual([id]);
    expect(page.items[0]!.reporter).toBeNull();
    expect((await kit.svc.listReportsAbout('seller', l.sellerId, { role: 'filed_by' }, {})).items).toEqual([]);
  });
});
