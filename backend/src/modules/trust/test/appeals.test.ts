import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, customer, listing, routed, seller, SELLER, staff, staffReport, STORE, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(() => kit.close());

/** An accepted enforcement; returns the people involved */
async function enforced(action: string, team: string, targets: { type: string; id: string; label: string }[], ownerPerm: string, params: Record<string, unknown> = {}) {
  const r = await staffReport(kit, targets);
  const rec = await routed(kit, r.id, { action, ownerTeam: team, targets, params });
  const owner = newId();
  const ok = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, staff(owner, ['trust.recommendations.decide', ownerPerm]), { accept: true, reason: 'Confirmed violation' });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return { report: r, enforcement: ok.body.enforcement, owner, trustStaff: rec.trustStaff as string };
}

describe('appeals on trust enforcement', () => {
  it('a seller appeals an offer suspension; reviewers who decided are refused; overturn reverses it', async () => {
    const l = listing(kit);
    const e = await enforced('suspend_offer', 'catalog', [{ type: 'offer', id: l.offerId, label: 'Offer' }], 'offers.offers.remove');
    // pending until offers confirms
    kit.offers.get(l.offerId)!.status = 'removed';
    await kit.emit('offers', 'offers.offer.status_changed', { offerId: l.offerId, productId: l.productId, variantId: newId(), sellerId: l.sellerId, ownerType: 'seller', from: 'active', to: 'removed', reasonCode: 'enforcement', reason: 'Confirmed violation' });

    expect((await kit.call('POST', `${SELLER}/appeals`, seller(newId()), { enforcementId: e.enforcement.id, argument: 'x' })).status).toBe(404);
    expect((await kit.call('POST', `${SELLER}/appeals`, seller(l.sellerId), { enforcementId: e.enforcement.id, argument: '' })).status).toBe(400);
    const res = await kit.call('POST', `${SELLER}/appeals`, seller(l.sellerId), { enforcementId: e.enforcement.id, argument: 'Invoices from the authorised distributor attached', evidenceIds: [newId()] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ source: 'trust', state: 'open', appellant: { kind: 'seller', id: l.sellerId }, appellantName: 'Gadget Grove', enforcementId: e.enforcement.id, originalDecider: { staffId: e.owner }, decideBy: { state: 'on_time' } });
    expect(res.body.evidence).toHaveLength(1);
    expect(res.body.ref).toMatch(/^TA-\d{6}-\d{4}$/);
    expect(kit.last('trust.appeal.submitted')).toEqual({ appealId: res.body.id, enforcementId: e.enforcement.id, decideBy: res.body.decideBy.dueAt });
    const dup = await kit.call('POST', `${SELLER}/appeals`, seller(l.sellerId), { enforcementId: e.enforcement.id, argument: 'again' });
    expect(dup.body.error.code).toBe('APPEAL_ALREADY_OPEN');
    expect((await kit.call('GET', `${SELLER}/appeals`, seller(l.sellerId))).body.map((a: any) => a.id)).toEqual([res.body.id]);

    // separate duties for the reviewer
    for (const conflicted of [e.owner, e.trustStaff]) {
      const r = await kit.call('POST', `${ADMIN}/appeals/${res.body.id}/assign`, staff(), { reviewerId: conflicted });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('SAME_REVIEWER_NOT_ALLOWED');
    }
    expect((await kit.call('POST', `${ADMIN}/appeals/${res.body.id}/decide`, staff(), { outcome: 'overturn', explanation: 'x' })).status).toBe(409);
    const reviewer = newId();
    const a = await kit.call('POST', `${ADMIN}/appeals/${res.body.id}/assign`, staff(), { reviewerId: reviewer });
    expect(a.body).toMatchObject({ state: 'under_review', reviewer: { staffId: reviewer } });
    expect((await kit.call('POST', `${ADMIN}/appeals/${res.body.id}/decide`, staff(e.owner), { outcome: 'uphold', explanation: 'x' })).body.error.code).toBe('SAME_REVIEWER_NOT_ALLOWED');
    const d = await kit.call('POST', `${ADMIN}/appeals/${res.body.id}/decide`, staff(reviewer), { outcome: 'overturn', explanation: 'The invoices are genuine' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toMatchObject({ state: 'overturned', decision: { outcome: 'overturned', explanation: 'The invoices are genuine', decidedBy: { kind: 'staff', id: reviewer } } });
    expect(kit.last('trust.appeal.decided')).toEqual({ appealId: res.body.id, enforcementId: e.enforcement.id, outcome: 'overturned' });
    expect(kit.last('trust.enforcement.reversed')).toMatchObject({ enforcementId: e.enforcement.id, action: 'suspend_offer', reason: expect.stringContaining('overturned') });
    const list = (await kit.call('GET', `${ADMIN}/enforcements?targetType=offer&targetId=${l.offerId}`, staff())).body.items;
    expect(list[0].executionState).toBe('reversed');
    expect(kit.audits.at(-1)).toMatchObject({ action: 'trust.appeal.decide' });
    expect((await kit.call('GET', `${ADMIN}/appeals?state=overturned`, staff())).body.items.map((x: any) => x.id)).toContain(res.body.id);
  });

  it('seller account actions are appealed in sellers; informing customers cannot be appealed; deadlines close', async () => {
    const sellerId = newId();
    kit.sellers.set(sellerId, { storeName: 'Gadget Grove' });
    const restrict = await enforced('restrict_seller', 'sellers', [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }], 'sellers.accounts.restrict');
    const inSellers = await kit.call('POST', `${SELLER}/appeals`, seller(sellerId), { enforcementId: restrict.enforcement.id, argument: 'x' });
    expect(inSellers.body.error.code).toBe('APPEAL_IN_SELLERS');
    const mine = await kit.call('GET', `${SELLER}/enforcements`, seller(sellerId));
    expect(mine.body[0]).toMatchObject({ title: 'Selling restricted', appealRoute: expect.stringContaining('Account health') });

    const buyer = newId();
    const inform = await enforced('inform_customers', 'support', [{ type: 'customer', id: buyer, label: 'Buyer' }], 'support.cases.handle');
    const me = customer(buyer);
    const na = await kit.call('POST', `${STORE}/appeals`, me, { enforcementId: inform.enforcement.id, argument: 'x' });
    expect(na.body.error.code).toBe('NOT_APPEALABLE');

    const mute = await enforced('restrict_customer_account', 'customers', [{ type: 'customer', id: buyer, label: 'Buyer' }], 'customers.accounts.act');
    kit.clock.advance(15 * 86_400_000);
    const late = await kit.call('POST', `${STORE}/appeals`, me, { enforcementId: mute.enforcement.id, argument: 'Too late?' });
    expect(late.body.error.code).toBe('APPEAL_WINDOW_CLOSED');
  });

  it('the appeal-deadlines job raises work items near decideBy', async () => {
    const buyer = newId();
    const e = await enforced('restrict_customer_messaging', 'customers', [{ type: 'customer', id: buyer, label: 'Buyer' }], 'customers.accounts.act');
    const res = await kit.call('POST', `${STORE}/appeals`, customer(buyer), { enforcementId: e.enforcement.id, argument: 'I was answering a scam' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    kit.clock.advance(6.5 * 86_400_000);
    await kit.job('trust.appeal-deadlines');
    expect(kit.work.at(-1)).toMatchObject({ queueKey: 'trust.reports', kind: 'trust_appeal_due', dedupeKey: `trust_appeal:${res.body.id}:due` });
    kit.clock.advance(86_400_000);
    await kit.job('trust.appeal-deadlines');
    expect(kit.work.at(-1)).toMatchObject({ kind: 'trust_appeal_overdue' });
    const o = await kit.call('GET', `${ADMIN}/overview`, staff());
    expect(o.body.appealsWaiting).toBeGreaterThan(0);
    expect(o.body.nextAppealDecideBy).toEqual(expect.any(String));
  });

  it('mirrors seller appeals of restrictions that came from a trust report, read-only', async () => {
    const sellerId = newId();
    kit.sellers.set(sellerId, { storeName: 'Northwind Audio' });
    const e = await enforced('restrict_seller', 'sellers', [{ type: 'seller', id: sellerId, label: 'Northwind Audio' }], 'sellers.accounts.restrict');
    const appealId = newId();
    const event = { appealId, sellerId, subject: 'restriction', subjectId: newId(), level: 1, decideBy: new Date(Date.now() + 5 * 86_400_000).toISOString(), trustReportId: e.report.id };
    await kit.emit('sellers', 'sellers.appeal.submitted', event);
    await kit.emit('sellers', 'sellers.appeal.submitted', event);
    await kit.emit('sellers', 'sellers.appeal.submitted', { ...event, appealId: newId(), trustReportId: null });
    const list = (await kit.call('GET', `${ADMIN}/appeals?source=sellers`, staff())).body.items.filter((a: any) => a.externalAppealId === appealId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: 'sellers', state: 'open', reportId: e.report.id, enforcementId: e.enforcement.id, appellantName: 'Northwind Audio' });
    expect((await kit.call('POST', `${ADMIN}/appeals/${list[0].id}/assign`, staff(), { reviewerId: newId() })).body.error.code).toBe('APPEAL_IN_SELLERS');
    expect((await kit.call('POST', `${ADMIN}/appeals/${list[0].id}/decide`, staff(), { outcome: 'uphold', explanation: 'x' })).body.error.code).toBe('APPEAL_IN_SELLERS');
    await kit.emit('sellers', 'sellers.appeal.decided', { appealId, sellerId, outcome: 'partly_overturned', subject: 'restriction', subjectId: event.subjectId, trustReportId: e.report.id });
    const after = (await kit.call('GET', `${ADMIN}/appeals?source=sellers`, staff())).body.items.find((a: any) => a.externalAppealId === appealId);
    expect(after.state).toBe('partly_overturned');
  });
});
