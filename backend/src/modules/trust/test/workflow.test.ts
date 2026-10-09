import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, customer, customerReport, listing, routed, seller, SELLER, staff, staffReport, STORE, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(() => kit.close());

describe('investigation workflow', () => {
  it('assign, escalate and illegal moves', async () => {
    const l = listing(kit);
    const id = await customerReport(kit, l.offerId);
    const early = await kit.call('POST', `${ADMIN}/reports/${id}/resolve`, staff(), { outcome: 'no_violation', summary: 'x', reporterOutcome: 'y' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ILLEGAL_TRANSITION');
    const investigator = newId();
    const due = new Date(Date.now() + 5 * 3_600_000).toISOString();
    const a = await kit.call('POST', `${ADMIN}/reports/${id}/assign`, staff(), { staffId: investigator, dueAt: due });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ status: 'under_review', assignee: { staffId: investigator, name: `Staff ${investigator.slice(-4)}`, role: 'Trust and Risk Manager' } });
    expect(a.body.deadline.dueAt).toBe(due);
    expect(kit.audits.at(-1)).toMatchObject({ action: 'trust.report.assign', module: 'trust', target: { type: 'trust_report', id } });
    const e = await kit.call('POST', `${ADMIN}/reports/${id}/escalate`, staff(), { reason: 'Brand owner threatens legal action' });
    expect(e.body.status).toBe('escalated');
    expect(kit.last('trust.report.escalated')).toEqual({ reportId: id, reason: 'Brand owner threatens legal action' });
    expect((await kit.call('POST', `${ADMIN}/reports/${id}/escalate`, staff(), { reason: 'again' })).status).toBe(409);
    expect((await kit.call('POST', `${ADMIN}/reports/${newId()}/assign`, staff(), { staffId: investigator })).status).toBe(404);
    expect((await kit.call('POST', `${ADMIN}/reports/${id}/assign`, staff(newId(), ['trust.reports.view']), { staffId: investigator })).status).toBe(403);
  });

  it('evidence moves the explainable score; an override is kept by the rescore job', async () => {
    const r = await staffReport(kit, [{ type: 'seller', id: newId(), label: 'Gadget Grove' }]);
    const base = r.riskScore;
    const ev = await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence`, staff(), { kind: 'check', result: 'fail', text: 'Serial numbers not in brand registry', mediaIds: [newId()] });
    expect(ev.status, JSON.stringify(ev.body)).toBe(201);
    expect(ev.body).toMatchObject({ kind: 'check', result: 'fail', source: 'staff', visibility: 'internal' });
    expect(ev.body.media).toHaveLength(1);
    const after = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body;
    expect(after.riskScore).toBe(base + 10);
    expect(after.riskFactors.find((f: any) => f.factor === 'failed_checks')).toMatchObject({ weight: 10 });
    const o = await kit.call('POST', `${ADMIN}/reports/${r.id}/risk-score`, staff(), { score: 92, reason: 'Brand owner confirmed in writing' });
    expect(o.body).toMatchObject({ riskScore: 92, riskLevel: 'high', riskOverride: { score: 92, reason: 'Brand owner confirmed in writing' } });
    await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence`, staff(), { kind: 'check', result: 'fail', text: 'Second batch also fails' });
    await kit.job('trust.rescore');
    const kept = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body;
    expect(kept.riskScore).toBe(92);
    expect(kept.riskFactors.find((f: any) => f.factor === 'failed_checks')).toMatchObject({ weight: 20 });
    expect((await kit.call('POST', `${ADMIN}/reports/${r.id}/risk-score`, staff(), { score: 101, reason: 'x' })).status).toBe(400);
  });

  it('proof requests: the seller answers its own, the job expires the rest and notes missing proof', async () => {
    const sellerId = newId();
    const r = await staffReport(kit, [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }]);
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const q = await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence-requests`, staff(), { to: { type: 'seller', id: sellerId, label: 'Gadget Grove' }, question: 'Send proof of supply for BRL-S2', dueAt: due });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body).toMatchObject({ state: 'open', to: { type: 'seller', id: sellerId } });
    expect(kit.last('trust.evidence.requested')).toEqual({ requestId: q.body.id, reportId: r.id, toType: 'seller', toId: sellerId, dueAt: due });
    const list = await kit.call('GET', `${SELLER}/evidence-requests?state=open`, seller(sellerId));
    expect(list.body.map((x: any) => x.id)).toEqual([q.body.id]);
    expect((await kit.call('GET', `${SELLER}/evidence-requests`, seller(newId()))).body).toEqual([]);
    expect((await kit.call('POST', `${SELLER}/evidence-requests/${q.body.id}/answer`, seller(newId()), { answer: 'x', mediaIds: [] })).status).toBe(404);
    const ans = await kit.call('POST', `${SELLER}/evidence-requests/${q.body.id}/answer`, seller(sellerId), { answer: 'Invoice from the distributor attached', mediaIds: [newId()] });
    expect(ans.status, JSON.stringify(ans.body)).toBe(200);
    expect(ans.body).toMatchObject({ state: 'answered', answer: 'Invoice from the distributor attached' });
    expect(ans.body.answerMedia).toHaveLength(1);
    expect(kit.last('trust.evidence.received')).toEqual({ requestId: q.body.id, reportId: r.id });
    expect((await kit.call('POST', `${SELLER}/evidence-requests/${q.body.id}/answer`, seller(sellerId), { answer: 'again', mediaIds: [] })).status).toBe(409);

    const q2 = await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence-requests`, staff(), { to: { type: 'seller', id: sellerId, label: 'Gadget Grove' }, question: 'Send the brand authorisation', dueAt: new Date(Date.now() + 3_600_000).toISOString() });
    const before = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body.riskScore;
    kit.clock.advance(2 * 3_600_000);
    await kit.job('trust.evidence-deadlines');
    const full = (await kit.call('GET', `${ADMIN}/reports/${r.id}`, staff())).body;
    expect(full.evidenceRequests.find((x: any) => x.id === q2.body.id).state).toBe('expired');
    expect(full.evidence.some((e: any) => e.source === 'automated' && e.text.startsWith('No proof received'))).toBe(true);
    expect(full.riskScore).toBe(before + 10);
    expect(full.status).toBe('open');
    const bad = await kit.call('POST', `${ADMIN}/reports/${r.id}/evidence-requests`, staff(), { to: { type: 'product', id: newId(), label: 'x' }, question: 'q', dueAt: new Date(Date.now() - 1000).toISOString() });
    expect(bad.status).toBe(400);
  });

  it('links, notes and the timeline', async () => {
    const r = await staffReport(kit, [{ type: 'seller', id: newId(), label: 'Gadget Grove' }]);
    const orderId = newId();
    const res = await kit.call('POST', `${ADMIN}/reports/${r.id}/links`, staff(), { subjects: [{ type: 'order', id: orderId, label: 'Order MK-1' }], caseRefs: ['CS-104933'] });
    expect(res.status).toBe(200);
    expect(res.body.subjects.map((s: any) => s.type)).toContain('order');
    expect(res.body.linkedCaseRefs).toEqual(['CS-104933']);
    const n = await kit.call('POST', `${ADMIN}/reports/${r.id}/notes`, staff(), { body: 'Called the brand owner' });
    expect(n.body.notes).toEqual([expect.objectContaining({ body: 'Called the brand owner' })]);
    expect(n.body.timeline.map((t: any) => t.label)).toEqual(expect.arrayContaining(['Opened by staff', '1 subject linked', 'Support case CS-104933 linked']));
    const filtered = await kit.call('GET', `${ADMIN}/reports?subjectType=order&subjectId=${orderId}`, staff());
    expect(filtered.body.items.map((x: any) => x.id)).toEqual([r.id]);
  });

  it('resolve waits for owner teams unless referred; dismiss and reopen', async () => {
    const productId = newId();
    const r = await staffReport(kit, [{ type: 'product', id: productId, label: 'BRL-S2' }]);
    await kit.call('POST', `${ADMIN}/reports/${r.id}/assign`, staff(), { staffId: newId() });
    await routed(kit, r.id, { action: 'suspend_product', ownerTeam: 'catalog', targets: [{ type: 'product', id: productId, label: 'BRL-S2' }] });
    const blocked = await kit.call('POST', `${ADMIN}/reports/${r.id}/resolve`, staff(), { outcome: 'action_taken', summary: 'Suspended', reporterOutcome: 'Done' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('RECOMMENDATIONS_OPEN');
    const referred = await kit.call('POST', `${ADMIN}/reports/${r.id}/resolve`, staff(), { outcome: 'referred', summary: 'Catalog owns the decision', reporterOutcome: 'Passed to the catalog team' });
    expect(referred.status).toBe(200);
    expect(referred.body.resolution).toMatchObject({ outcome: 'referred', summary: 'Catalog owns the decision' });
    const reopened = await kit.call('POST', `${ADMIN}/reports/${r.id}/reopen`, staff(), { reason: 'New photos from a buyer' });
    expect(reopened.body).toMatchObject({ status: 'under_review', resolution: null });
    const dismissed = await kit.call('POST', `${ADMIN}/reports/${r.id}/dismiss`, staff(), { reason: 'Photos were of another product', reporterOutcome: 'We found no violation' });
    expect(dismissed.body.status).toBe('dismissed');
    // a staff report has no one outside to tell
    expect(kit.last('trust.report.resolved')).toEqual({ reportId: r.id, ref: r.ref, outcome: 'dismissed', reporterOutcome: 'We found no violation', reporters: [] });
    expect((await kit.call('POST', `${ADMIN}/reports/${r.id}/dismiss`, staff(), { reason: 'x', reporterOutcome: 'y' })).status).toBe(409);
    expect(kit.audits.filter((a) => a.target.id === r.id).map((a) => a.action)).toEqual(expect.arrayContaining(['trust.report.resolve', 'trust.report.reopen', 'trust.report.dismiss']));
  });

  it('merges a duplicate: subjects, evidence and reporters move; the reporter follows the kept report', async () => {
    const l = listing(kit);
    const me = customer();
    const dup = await customerReport(kit, l.offerId, me);
    const kept = await customerReport(kit, l.offerId);
    const res = await kit.call('POST', `${ADMIN}/reports/${dup}/merge`, staff(), { intoReportId: kept, reason: 'Same listing' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'merged', resolution: { outcome: 'duplicate' } });
    const k = (await kit.call('GET', `${ADMIN}/reports/${kept}`, staff())).body;
    expect(k.reporterCount).toBe(2);
    expect(k.mergedReportIds).toEqual([dup]);
    expect(k.evidence.filter((e: any) => e.kind === 'statement')).toHaveLength(2);
    expect(k.riskFactors.find((f: any) => f.factor === 'reporters')).toMatchObject({ weight: 5 });
    await kit.call('POST', `${ADMIN}/reports/${kept}/assign`, staff(), { staffId: newId() });
    expect((await kit.call('GET', `${STORE}/reports/${dup}`, me)).body.statusLabel).toBe('under_review');
    expect((await kit.call('POST', `${ADMIN}/reports/${dup}/merge`, staff(), { intoReportId: kept, reason: 'x' })).status).toBe(409);
    expect((await kit.call('POST', `${ADMIN}/reports/${kept}/merge`, staff(), { intoReportId: kept, reason: 'x' })).status).toBe(400);
  });

  it('queue filters, sorting and the overview', async () => {
    const high = await staffReport(kit, [{ type: 'seller', id: newId() }]);
    await kit.call('POST', `${ADMIN}/reports/${high.id}/risk-score`, staff(), { score: 95, reason: 'Confirmed' });
    const list = await kit.call('GET', `${ADMIN}/reports?riskLevel=high&status=active&limit=5`, staff());
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ id: high.id, riskLevel: 'high', reporterLabel: expect.stringContaining('Staff') });
    expect(list.body.items.every((r: any) => r.riskScore >= 70)).toBe(true);
    const paged = await kit.call('GET', `${ADMIN}/reports?page=1&limit=2&sort=newest`, staff());
    expect(paged.body.items).toHaveLength(2);
    expect(paged.body.totalPages).toBeGreaterThan(1);
    const next = await kit.call('GET', `${ADMIN}/reports?limit=2&sort=newest`, staff());
    const second = await kit.call('GET', `${ADMIN}/reports?limit=2&sort=newest&cursor=${next.body.nextCursor}`, staff());
    expect(second.body.items[0].id).not.toBe(next.body.items[0].id);
    const q = await kit.call('GET', `${ADMIN}/reports?q=${high.ref}`, staff());
    expect(q.body.items.map((r: any) => r.id)).toEqual([high.id]);
    const o = await kit.call('GET', `${ADMIN}/overview`, staff());
    expect(o.status).toBe(200);
    expect(o.body.open).toBeGreaterThan(0);
    expect(o.body.highRisk).toBeGreaterThan(0);
    expect(o.body.byType.counterfeit).toBeGreaterThan(0);
    expect(o.body.typeNotes.counterfeit).toEqual(expect.any(String));
  });

  it('exports through reports; identities only with their own permission', async () => {
    const res = await kit.call('POST', `${ADMIN}/reports/exports`, staff(), { filters: { status: 'active' }, format: 'csv' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(kit.callsOf('reports.requestExport').at(-1)?.[0]).toMatchObject({ dataset: 'trust.admin.reports', filters: { status: 'active' }, format: 'csv' });
    expect(kit.audits.at(-1)).toMatchObject({ action: 'trust.reports.export' });
    const l = listing(kit);
    await customerReport(kit, l.offerId);
    const rows = await kit.svc.exportRows('trust.admin.reports', { q: 'Brightline' }, { kind: 'staff', accountId: newId() });
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0]).toHaveProperty('reporter');
    await expect(kit.svc.exportRows('other.dataset', {}, { kind: 'staff', accountId: newId() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
