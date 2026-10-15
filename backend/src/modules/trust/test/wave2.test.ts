/**
 * Wave 2 (BACKEND-REQUESTS): seller subjects carry the seller's ref and slug (G69d), a proof request can be cancelled
 * (G73), and a report shows its recommended next step and each subject's history (G74).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, listing, routed, seller, SELLER, staff, staffReport, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => {
  await kit?.close();
});

const due = () => new Date(Date.now() + 2 * 86_400_000).toISOString();

describe('seller subjects (G69d)', () => {
  it('show the seller reference and slug from sellers, in the report, the queue and proof requests', async () => {
    const l = listing(kit, { storeName: 'Casa Verde' });
    const r = await staffReport(kit, [{ type: 'seller', id: l.sellerId, label: 'Casa Verde' }]);
    const ref = `SL-${l.sellerId.slice(-5)}`;
    const slug = `store-${l.sellerId.slice(-5)}`;
    const report = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body;
    expect(report.subjects[0]).toMatchObject({ type: 'seller', id: l.sellerId, ref, slug, screen: 'admin/seller' });
    const rows = (await kit.call('GET', `${ADMIN}/reports?subjectType=seller&subjectId=${l.sellerId}`, staff())).body.items;
    expect(rows[0].subjects[0]).toMatchObject({ ref, slug });
    const q = await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence-requests`, staff(), { to: { type: 'seller', id: l.sellerId, label: 'Casa Verde' }, question: 'Send the invoices', dueAt: due() });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect((await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body.evidenceRequests[0].to).toMatchObject({ ref, slug });
  });
});

describe('cancel a proof request (G73)', () => {
  it('cancels an open request (default reason), closes the notice, notes the timeline; twice is refused', async () => {
    const l = listing(kit);
    const r = await staffReport(kit, [{ type: 'seller', id: l.sellerId }]);
    const q = (await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence-requests`, staff(), { to: { type: 'seller', id: l.sellerId, label: 'Gadget Grove' }, question: 'Send the invoices', dueAt: due() })).body;
    const res = await kit.call('POST', `${ADMIN}/evidence-requests/${q.id}/cancel`, staff(), {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: q.id, state: 'cancelled' });
    const report = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body;
    expect(report.timeline.map((t: any) => t.label)).toContain('Proof request to the seller cancelled');
    expect(kit.audits.find((a) => a.action === 'trust.evidence.cancel')).toMatchObject({ reason: 'No longer needed' });
    // the seller sees it cancelled and can no longer answer
    expect((await kit.call('GET', `${SELLER}/evidence-requests`, seller(l.sellerId))).body.find((x: any) => x.id === q.id).state).toBe('cancelled');
    expect((await kit.call('POST', `${SELLER}/evidence-requests/${q.id}/answer`, seller(l.sellerId), { answer: 'Here', mediaIds: [] })).status).toBe(409);

    const again = await kit.call('POST', `${ADMIN}/evidence-requests/${q.id}/cancel`, staff(), { reason: 'x' });
    expect(again.status).toBe(409);
    expect((await kit.call('POST', `${ADMIN}/evidence-requests/${newId()}/cancel`, staff(), {})).status).toBe(404);
  });
});

describe('next step and subject history (G74)', () => {
  it('follows the report through assign, proof, recommendation, owner decision and resolve', async () => {
    const l = listing(kit);
    const r = await staffReport(kit, [{ type: 'offer', id: l.offerId }, { type: 'seller', id: l.sellerId }], { evidence: [] });
    const next = async () => (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body.nextStep;
    expect(await next()).toMatchObject({ key: 'assign' });

    const investigator = newId();
    expect((await kit.call('POST', `${ADMIN}/reports/${r.id}/assign`, staff(investigator), { staffId: investigator })).status).toBe(200);
    expect((await next()).key).toMatch(/gather_evidence|add_recommendation/);

    const q = (await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence-requests`, staff(), { to: { type: 'seller', id: l.sellerId, label: 'Gadget Grove' }, question: 'Invoices?', dueAt: due() })).body;
    expect(await next()).toMatchObject({ key: 'await_proof', label: 'Waiting for proof from the seller' });
    await kit.call('POST', `${ADMIN}/evidence-requests/${q.id}/cancel`, staff(), {});

    await routed(kit, r.id, { action: 'suspend_offer', targets: [{ type: 'offer', id: l.offerId, label: 'Offer' }], label: 'Suspend the offer' });
    expect(await next()).toMatchObject({ key: 'await_owner', label: 'Waiting for Catalog to decide', detail: 'Suspend the offer' });
  });

  it('lists other reports and enforcements about each subject, newest first', async () => {
    const l = listing(kit);
    const older = await staffReport(kit, [{ type: 'seller', id: l.sellerId }], { type: 'abuse' });
    const newer = await staffReport(kit, [{ type: 'seller', id: l.sellerId }, { type: 'offer', id: l.offerId }], { type: 'misleading_listing' });
    const current = await staffReport(kit, [{ type: 'seller', id: l.sellerId }, { type: 'offer', id: l.offerId }]);
    const history = (await kit.call('GET', `${ADMIN}/reports/${current.id}`, staff())).body.subjectHistory as any[];
    const ofSeller = history.find((h) => h.subject.type === 'seller');
    expect(ofSeller.subject).toMatchObject({ id: l.sellerId, slug: `store-${l.sellerId.slice(-5)}` });
    expect(ofSeller.totalReports).toBe(2);
    expect(ofSeller.reports.map((x: any) => x.id)).toEqual([newer.id, older.id]);
    expect(ofSeller.reports[0]).toMatchObject({ ref: newer.ref, type: 'misleading_listing', status: expect.any(String), outcome: null });
    expect(ofSeller.enforcementsInForce).toBe(0);
    const ofOffer = history.find((h) => h.subject.type === 'offer');
    expect(ofOffer.reports.map((x: any) => x.id)).toEqual([newer.id]);
    // other responses leave the history out
    expect((await kit.call('GET', `${ADMIN}/reports?subjectId=${l.sellerId}&subjectType=seller`, staff())).body.items[0].subjectHistory).toBeUndefined();
  });
});
