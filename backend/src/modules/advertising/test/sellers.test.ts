import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { ADMIN, boot, SELLER, SELLER_A, SELLER_B, track, USD, type Kit } from './helpers.js';

let k: Kit;
const sellerA = () => callers.seller({ sellerId: SELLER_A });
const sellerB = () => callers.seller({ sellerId: SELLER_B });

beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});
beforeEach(() => k.clock.set(new Date()));

const request = (offerIds: string[], over: Record<string, unknown> = {}) => {
  const now = k.clock.now().getTime();
  return {
    name: 'Duvet search boost',
    type: 'sponsored_product',
    offerIds,
    pages: ['search'],
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 14 * 86_400_000).toISOString(),
    dailyLimit: USD(100),
    totalLimit: USD(1000),
    billing: 'cpc',
    creativeIds: [],
    headline: 'Soft linen duvet covers',
    ...over,
  };
};

/** Seller creates and submits; Advertising and Content approve; it goes live */
async function liveRequest(offerIds: string[], over: Record<string, unknown> = {}) {
  const created = await k.call('POST', `${SELLER}/campaigns`, sellerA(), request(offerIds, over));
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const id = created.body.campaign.id;
  expect((await k.call('POST', `${SELLER}/campaigns/${id}/submit`, sellerA())).status).toBe(200);
  await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, callers.staff(), { role: 'advertising' });
  await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, callers.staff(), { role: 'content' });
  return id as string;
}

describe('paid seller ads are off until the global rules turn them on (Business Owner approval)', () => {
  it('refuses requests with PAID_ADS_DISABLED', async () => {
    const offer = k.offer();
    const res = await k.call('POST', `${SELLER}/campaigns`, sellerA(), request([offer.id]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAID_ADS_DISABLED');
  });

  it('a rules change is always an approval request and applies once approved', async () => {
    const before = await k.call('GET', `${ADMIN}/rules`, k.staff);
    expect(before.body).toMatchObject({ version: 1, paidSellerAdsEnabled: false, blockedPages: ['checkout', 'payment_result', 'order_tracking', 'returns'], attributionDays: 7 });
    let res = await k.call('PUT', `${ADMIN}/rules`, k.staff, { paidSellerAdsEnabled: true, extraBlockedPages: ['account'], reason: 'Pilot sponsored products' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ version: 2, paidSellerAdsEnabled: true, approval: { required: true } });
    expect(res.body.blockedPages).toEqual(expect.arrayContaining(['checkout', 'payment_result', 'order_tracking', 'returns', 'account']));
    const [requestId, req] = [...k.approvals.entries()].find(([, v]) => v.action === 'advertising.rules.change')!;
    expect(req.target).toMatchObject({ type: 'advertising_rules', id: '2' });
    // not in force yet
    res = await k.call('GET', `${ADMIN}/rules`, k.staff);
    expect(res.body).toMatchObject({ version: 1, paidSellerAdsEnabled: false, approval: { approvalRequestId: requestId } });
    await k.emit('access.approval.decided', { requestId, ref: 'AP-1', actionKey: 'advertising.rules.change', module: 'advertising', target: req.target, outcome: 'approved', decidedBy: { kind: 'staff', id: newId() }, approverIds: [], requestedById: newId() });
    res = await k.call('GET', `${ADMIN}/rules`, k.staff);
    expect(res.body).toMatchObject({ version: 2, paidSellerAdsEnabled: true });
    expect(await k.svc.isAdBlockedPage({ page: 'account' })).toBe(true);
    expect(k.audits.some((a) => a.action === 'advertising.rules.approve')).toBe(true);
    // unknown page types are refused
    res = await k.call('PUT', `${ADMIN}/rules`, k.staff, { extraBlockedPages: ['nowhere'], reason: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('seller sponsored campaigns', () => {
  it('lists own promotable offers and example pricing', async () => {
    k.offer({ title: 'Low stock lamp', stock: 2 });
    k.offer({ sellerId: SELLER_B, title: 'Not mine' });
    const res = await k.call('GET', `${SELLER}/promotable-offers`, sellerA());
    expect(res.status).toBe(200);
    expect(res.body.items.some((o: any) => o.title === 'Not mine')).toBe(false);
    expect(res.body.items.find((o: any) => o.title === 'Low stock lamp')).toMatchObject({ eligible: false, stockLabel: '2 in stock' });
    const pricing = await k.call('GET', `${SELLER}/pricing?type=sponsored_product`, sellerA());
    expect(pricing.body).toEqual([
      { billing: 'cpc', rate: USD(35), label: 'Per click, $0.35 (example rate)', isExample: true },
      { billing: 'fixed_daily', rate: USD(1500), label: 'Fixed daily fee, $15.00 (example rate)', isExample: true },
    ]);
  });

  it('promotes only own active offers with stock (OFFER_NOT_PROMOTABLE)', async () => {
    const theirs = k.offer({ sellerId: SELLER_B });
    let res = await k.call('POST', `${SELLER}/campaigns`, sellerA(), request([theirs.id]));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OFFER_NOT_PROMOTABLE');
    const low = k.offer({ stock: 3 });
    res = await k.call('POST', `${SELLER}/campaigns`, sellerA(), request([low.id]));
    expect(res.body.error.code).toBe('OFFER_NOT_PROMOTABLE');
    const paused = k.offer({ status: 'paused' });
    res = await k.call('POST', `${SELLER}/campaigns`, sellerA(), request([paused.id]));
    expect(res.body.error.code).toBe('OFFER_NOT_PROMOTABLE');
    res = await k.call('POST', `${SELLER}/campaigns`, sellerA(), request([k.offer().id], { headline: 'x'.repeat(41) }));
    expect(res.status).toBe(400);
  });

  it('creates, edits in review (back to the start), withdraws and submits; other sellers get 404', async () => {
    const offer = k.offer();
    const created = await k.call('POST', `${SELLER}/campaigns`, sellerA(), request([offer.id]));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      campaign: { status: 'draft', advertiser: { kind: 'seller', sellerId: SELLER_A, name: 'Casa Verde Home', paid: true }, placementKey: 'sponsored_product', allowedActions: ['edit', 'submit'] },
      promotes: 'Linen duvet cover',
      billingLabel: 'Per click, $0.35 (example rate)',
      dailyLimit: USD(100),
      totalLimit: USD(1000),
      spend: USD(0),
    });
    expect(created.body.creatives).toEqual([expect.objectContaining({ kind: 'text', headline: 'Soft linen duvet covers', advertiser: expect.objectContaining({ sellerId: SELLER_A }) })]);
    expect(created.body.previews.desktop).toMatchObject({ label: 'Sponsored', promotedOffer: { offerId: offer.id } });
    const id = created.body.campaign.id;
    for (const [m, url] of [
      ['GET', `${SELLER}/campaigns/${id}`],
      ['POST', `${SELLER}/campaigns/${id}/submit`],
      ['POST', `${SELLER}/campaigns/${id}/pause`],
    ] as const) {
      const r = await k.call(m, url, sellerB());
      expect(r.status, url).toBe(404);
    }
    let res = await k.call('POST', `${SELLER}/campaigns/${id}/submit`, sellerA());
    expect(res.body.campaign.status).toBe('in_review');
    res = await k.call('PATCH', `${SELLER}/campaigns/${id}`, sellerA(), request([offer.id], { name: 'Renamed', headline: null }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.campaign).toMatchObject({ status: 'draft', name: 'Renamed' });
    expect(res.body.creatives).toHaveLength(1);
    expect(k.of('advertising.campaign.status_changed').filter((p) => p.campaignId === id).map((p) => p.to)).toEqual(['in_review', 'draft']);
    await k.call('POST', `${SELLER}/campaigns/${id}/submit`, sellerA());
    res = await k.call('POST', `${SELLER}/campaigns/${id}/withdraw`, sellerA());
    expect(res.body.campaign.status).toBe('draft');
    const list = await k.call('GET', `${SELLER}/campaigns`, sellerA());
    expect(list.body.items.some((x: any) => x.campaign.id === id)).toBe(true);
    expect((await k.call('GET', `${SELLER}/campaigns`, sellerB())).body.items.some((x: any) => x.campaign.id === id)).toBe(false);
  });

  it('charges clicks within the daily limit, never above it, and stops delivery for the day', async () => {
    const offer = k.offer({ title: 'Washed linen sheets' });
    const id = await liveRequest([offer.id], { dailyLimit: USD(100) });
    expect((await k.call('GET', `${SELLER}/campaigns/${id}`, sellerA())).body.campaign.status).toBe('live');
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      const slots = await k.svc.sponsoredForResults({ page: { page: 'search' }, query: 'linen sheets', visitorId: `v-${i}`, sessionId: `s-${i}`, device: 'web', organicOfferIds: [offer.id] });
      expect(slots[0]?.impression.campaignId).toBe(id);
      tokens.push(slots[0]!.impression.impressionToken);
    }
    for (const t of tokens) expect((await track(k, [{ impressionToken: t, kind: 'click' }])).status).toBe(202);
    const view = await k.call('GET', `${SELLER}/campaigns/${id}`, sellerA());
    // $0.35 a click: two clicks fit under $1.00; the third is recorded but not charged
    expect(view.body.spend).toEqual(USD(70));
    expect(k.of('advertising.budget.reached')).toEqual([{ campaignId: id, sellerId: SELLER_A, limit: 'daily' }]);
    // delivery stops for the day: another $0.35 would pass the limit
    expect(await k.svc.sponsoredForResults({ page: { page: 'search' }, query: 'linen sheets', visitorId: 'v-9', sessionId: 's-9', device: 'web', organicOfferIds: [offer.id] })).toEqual([]);
    // the next market day it serves again
    k.clock.advance(86_400_000);
    expect((await k.svc.sponsoredForResults({ page: { page: 'search' }, query: 'linen sheets', visitorId: 'v-10', sessionId: 's-10', device: 'web', organicOfferIds: [offer.id] }))[0]?.impression.campaignId).toBe(id);
  });

  it('parallel clicks can never overspend the total limit; reaching it finishes the campaign', async () => {
    const offer = k.offer({ title: 'Wool throw blanket' });
    const id = await liveRequest([offer.id], { dailyLimit: USD(70), totalLimit: USD(70), name: 'Throw boost' });
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      const slots = await k.svc.sponsoredForResults({ page: { page: 'search' }, query: 'wool throw', visitorId: `p-${i}`, sessionId: `ps-${i}`, device: 'web', organicOfferIds: [] });
      tokens.push(slots.find((s) => s.impression.campaignId === id)!.impression.impressionToken);
    }
    const results = await Promise.all(tokens.map((t) => track(k, [{ impressionToken: t, kind: 'click' }])));
    expect(results.every((r) => r.status === 202)).toBe(true);
    const view = await k.call('GET', `${ADMIN}/campaigns/${id}`, k.staff);
    expect(view.body.budget).toMatchObject({ spent: USD(70), remaining: USD(0) });
    expect(view.body).toMatchObject({ status: 'finished', finishedReason: 'budget_reached' });
    expect(k.of('advertising.budget.reached').filter((p) => p.campaignId === id)).toEqual([{ campaignId: id, sellerId: SELLER_A, limit: 'total' }]);

    // charges accrue per day (separate from commission), post to finance, and can be credited
    await k.job('advertising.accrue-charges');
    let charges = await k.call('GET', `${SELLER}/charges?campaignId=${id}`, sellerA());
    expect(charges.status).toBe(200);
    expect(charges.body.items).toEqual([expect.objectContaining({ campaignId: id, campaignName: 'Throw boost', basis: 'clicks', units: 2, rate: USD(35), amount: USD(70), state: 'accrued' })]);
    expect((await k.call('GET', `${SELLER}/charges?campaignId=${id}`, sellerB())).body.items).toEqual([]);
    k.clock.advance(86_400_000);
    await k.job('advertising.post-charges');
    expect(k.adCharges.filter((c) => c.campaignId === id)).toEqual([expect.objectContaining({ sellerId: SELLER_A, amount: USD(70) })]);
    charges = await k.call('GET', `${ADMIN}/charges?sellerId=${SELLER_A}&state=posted`, k.staff);
    const posted = charges.body.items.find((c: any) => c.campaignId === id);
    expect(posted).toMatchObject({ state: 'posted', statementRef: 'ST-2610-0001' });
    expect(k.of('advertising.charge.posted').find((p) => p.chargeId === posted.id)).toMatchObject({ sellerId: SELLER_A, campaignId: id, amount: USD(70) });
    // posting again changes nothing
    await k.job('advertising.post-charges');
    expect(k.adCharges.filter((c) => c.campaignId === id)).toHaveLength(1);

    // above the caller's adjustment limit: approval first
    k.authority.set('advertising.charges.void', 'approval_required');
    let res = await k.call('POST', `${ADMIN}/charges/${posted.id}/void`, k.staff, { reason: 'Invalid traffic' }, { 'idempotency-key': newId() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPROVAL_REQUIRED');
    const [requestId, req] = [...k.approvals.entries()].find(([, v]) => v.action === 'advertising.charges.void')!;
    expect(req.amount).toEqual(USD(70));
    const decided = { requestId, ref: 'AP-2', actionKey: 'advertising.charges.void', module: 'advertising', target: req.target, outcome: 'approved', decidedBy: { kind: 'staff', id: newId() }, amount: USD(70), approverIds: [], requestedById: newId() };
    await k.emit('access.approval.decided', decided);
    await k.emit('access.approval.decided', decided); // delivered twice: credited once
    charges = await k.call('GET', `${ADMIN}/charges?campaignId=${id}`, k.staff);
    expect(charges.body.items[0]).toMatchObject({ state: 'credited', reason: 'Invalid traffic' });
    expect(k.of('advertising.charge.credited')).toEqual([{ chargeId: posted.id, sellerId: SELLER_A, amount: USD(70), reason: 'Invalid traffic' }]);
    // the seller ledger is credited against the posted entry
    const entryId = k.adCharges.find((c) => c.campaignId === id)!.entryId;
    expect(k.chargeCredits).toEqual([{ sellerId: SELLER_A, amount: USD(70), originalEntryId: entryId, reason: 'Invalid traffic', idempotencyKey: `advertising:charge-credit:${posted.id}` }]);
    k.authority.delete('advertising.charges.void');
    res = await k.call('POST', `${ADMIN}/charges/${posted.id}/void`, k.staff, { reason: 'again' }, { 'idempotency-key': newId() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect(k.audits.some((a) => a.action === 'advertising.charge.credit' && a.category === 'financial')).toBe(true);
  });

  it('the seller pauses and resumes; a pause by Marketly can only be lifted by staff', async () => {
    const offer = k.offer({ title: 'Oak serving board' });
    const id = await liveRequest([offer.id], { name: 'Board boost' });
    let res = await k.call('POST', `${SELLER}/campaigns/${id}/pause`, sellerA());
    expect(res.body.campaign).toMatchObject({ status: 'paused', allowedActions: ['resume'] });
    expect(res.body.campaign.statusNote).toMatch(/^Paused by you/);
    res = await k.call('POST', `${SELLER}/campaigns/${id}/resume`, sellerA());
    expect(res.body.campaign.status).toBe('live');
    await k.call('POST', `${ADMIN}/campaigns/${id}/pause`, k.staff, { reason: 'Claim under review' });
    res = await k.call('POST', `${SELLER}/campaigns/${id}/resume`, sellerA());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await k.call('GET', `${SELLER}/campaigns/${id}`, sellerA())).body.campaign.allowedActions).toEqual([]);
    // resuming checks the promoted offer is still available
    k.offers.get(offer.id)!.stock = 1;
    k.svc.core.forgetOffers();
    res = await k.call('POST', `${ADMIN}/campaigns/${id}/resume`, k.staff, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AD_UNAVAILABLE');
  });

  it('summarizes spend, clicks and attributed orders for the period', async () => {
    await k.job('advertising.stats-rollup');
    const res = await k.call('GET', `${SELLER}/summary`, sellerA());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attributionDays: 7, statementNote: expect.stringMatching(/separate from sales commission/) });
    expect(res.body.spend.amount).toBeGreaterThan(0);
    expect(res.body.clicks).toBeGreaterThan(0);
  });

  it('a restricted seller cannot create requests', async () => {
    k.restricted.set(SELLER_A, 'Advertising restricted while a review is open');
    const res = await k.call('POST', `${SELLER}/campaigns`, sellerA(), request([k.offer().id]));
    expect(res.status).toBe(403);
    k.restricted.delete(SELLER_A);
  });
});
