import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callers } from '../../../testing/app.js';
import { ADMIN, boot, campaignInput, HOME, SELLER, SELLER_A, SELLER_B, USD, type Kit } from './helpers.js';

let k: Kit;
let sellerA: string;
let sellerB: string;
beforeAll(async () => {
  k = await boot();
  sellerA = callers.seller({ sellerId: SELLER_A });
  sellerB = callers.seller({ sellerId: SELLER_B });
});
afterAll(() => k?.close());

const discountInput = (offerIds: string[], over: Record<string, unknown> = {}) => ({
  name: 'Fall audio sale',
  kind: 'markdown',
  discount: { kind: 'markdown', percentOffBps: 1000 },
  offerIds,
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  combinesWithPlatformCoupons: true,
  showOnDeals: true,
  ...over,
});

describe('seller discounts', () => {
  it('creates, schedules (live at once), pauses, resumes and ends an own discount', async () => {
    const o = k.offer({ sellerId: SELLER_A, price: USD(10000) });
    const created = await k.call('POST', `${SELLER}/discounts`, sellerA, discountInput([o.id]));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ campaign: { status: 'draft', ownerKind: 'seller', sellerId: SELLER_A, fundingOwner: 'seller', fundingLabel: 'Seller funded' }, discountLabel: '10% off', usedOrders: 0 });
    expect(created.body.offers[0]).toMatchObject({ offerId: o.id, regularPrice: USD(10000), campaignPrice: USD(9000), earnings: { sellerFunds: USD(1000), feeBasis: USD(9000), isExample: true } });
    const id = created.body.campaign.id;
    const scheduled = await k.call('POST', `${SELLER}/discounts/${id}/schedule`, sellerA);
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.campaign.status).toBe('live');
    expect(k.of('promotions.campaign.scheduled').at(-1)).toMatchObject({ campaignId: id, sellerId: SELLER_A });

    const prices = await k.svc.priceOffers([o.id], {});
    expect(prices[0]).toMatchObject({ regularPrice: USD(10000), price: USD(9000), campaignId: id });
    expect(prices[0]!.badges).toContainEqual({ label: '−10%', kind: 'deal' });

    const edit = await k.call('PATCH', `${SELLER}/discounts/${id}`, sellerA, discountInput([o.id], { name: 'x' }));
    expect(edit.status).toBe(409);
    expect((await k.call('POST', `${SELLER}/discounts/${id}/pause`, sellerA)).body.campaign.status).toBe('paused');
    expect((await k.svc.priceOffers([o.id], {}))[0]!.price).toEqual(USD(10000));
    expect((await k.call('POST', `${SELLER}/discounts/${id}/resume`, sellerA)).body.campaign.status).toBe('live');
    const ended = await k.call('POST', `${SELLER}/discounts/${id}/end`, sellerA, { reason: 'Done' });
    expect(ended.body.campaign.status).toBe('ended');
    expect(k.of('promotions.campaign.ended').at(-1)).toEqual({ campaignId: id, reason: 'ended_early' });
  });

  it("keeps sellers to their own offers and discounts (others' ids are not found)", async () => {
    const theirs = k.offer({ sellerId: SELLER_B });
    const r = await k.call('POST', `${SELLER}/discounts`, sellerA, discountInput([theirs.id]));
    expect(r.status).toBe(404);
    const own = await k.call('POST', `${SELLER}/discounts`, sellerB, discountInput([theirs.id]));
    expect(own.status).toBe(201);
    expect((await k.call('GET', `${SELLER}/discounts/${own.body.campaign.id}`, sellerA)).status).toBe(404);
    expect((await k.call('POST', `${SELLER}/discounts/${own.body.campaign.id}/schedule`, sellerA)).status).toBe(404);
    const mine = await k.call('GET', `${SELLER}/discounts`, sellerA);
    expect(mine.body.items.every((d: any) => d.campaign.sellerId === SELLER_A)).toBe(true);
    const preview = await k.call('POST', `${SELLER}/discounts/preview`, sellerA, { offerId: theirs.id, discount: { kind: 'markdown', percentOffBps: 1000 } });
    expect(preview.status).toBe(404);
  });

  it('cancels a draft on end, refuses inactive offers and blocked sellers on schedule', async () => {
    const o = k.offer({ sellerId: SELLER_A });
    const d = await k.call('POST', `${SELLER}/discounts`, sellerA, discountInput([o.id], { kind: 'percent_coupon', discount: { kind: 'percent_coupon', percentOffBps: 1500 }, code: 'CASA15' }));
    expect(d.body.campaign.code).toBe('CASA15');
    k.blockedSellers.set(SELLER_A, 'Promotions are restricted');
    const blocked = await k.call('POST', `${SELLER}/discounts/${d.body.campaign.id}/schedule`, sellerA);
    expect(blocked.status).toBe(400);
    k.blockedSellers.delete(SELLER_A);
    k.offers.get(o.id)!.status = 'removed';
    const inactive = await k.call('POST', `${SELLER}/discounts/${d.body.campaign.id}/schedule`, sellerA);
    expect(inactive.status).toBe(422);
    expect(inactive.body.error).toMatchObject({ code: 'OFFER_NOT_ELIGIBLE', details: { offers: [{ offerId: o.id }] } });
    const cancelled = await k.call('POST', `${SELLER}/discounts/${d.body.campaign.id}/end`, sellerA, {});
    expect(cancelled.body.campaign.status).toBe('cancelled');
    expect(k.of('promotions.campaign.cancelled').at(-1)).toMatchObject({ campaignId: d.body.campaign.id });
  });

  it('previews customer price and earnings: seller-funded parts lower the fee basis', async () => {
    const o = k.offer({ sellerId: SELLER_A, price: USD(10000) });
    const r = await k.call('POST', `${SELLER}/discounts/preview`, sellerA, { offerId: o.id, discount: { kind: 'fixed_coupon', amountOff: USD(500) } });
    expect(r.body).toMatchObject({ customerPrice: USD(9500), regularPrice: USD(10000), earnings: { feeBasis: USD(9500), fee: USD(950), sellerEarns: USD(8550), regularSellerEarns: USD(9000) } });
  });
});

describe('platform campaign participation', () => {
  it('invites, needs explicit consent with eligible offers only, records the consent and includes the offers', async () => {
    const good = k.offer({ sellerId: SELLER_A, categoryId: HOME, stock: 50, price: USD(10000) });
    const low = k.offer({ sellerId: SELLER_A, categoryId: HOME, stock: 3 });
    const startsAt = new Date(k.clock.now().getTime() + 2 * 86_400_000).toISOString();
    const input = campaignInput(k.clock, {
      startsAt,
      discount: { kind: 'markdown', percentOffBps: 2000 },
      funding: { owner: 'shared', platformShareBps: 5000 },
      participation: { inviteSellers: true, rules: ['At least 20 units in stock'], minStock: 20 },
    });
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, input);
    const id = c.body.id;
    const inv = await k.call('POST', `${ADMIN}/campaigns/${id}/invitations`, k.staff, { respondBy: new Date(k.clock.now().getTime() + 86_400_000).toISOString() });
    expect(inv.status).toBe(201);
    const mine = inv.body.find((p: any) => p.sellerId === SELLER_A);
    expect(mine).toMatchObject({ state: 'invited', sellerShareBps: 5000, platformShareBps: 5000, sellerName: 'Casa Verde Home' });
    expect(mine.offers.find((x: any) => x.offerId === low.id)).toMatchObject({ eligible: false, ineligibleReasons: ['Needs at least 20 units in stock (you have 3)'] });
    expect(k.of('promotions.participation.invited').at(-1)).toMatchObject({ campaignId: id, sellerIds: expect.arrayContaining([SELLER_A]) });

    const invitation = await k.call('GET', `${SELLER}/invitations/${mine.id}`, sellerA);
    expect(invitation.body.campaign.funding).toMatchObject({ discountBps: 2000, sellerFundsBps: 5000, platformFundsBps: 5000 });
    expect(invitation.body.leavePolicy).toMatch(/^You can leave before/);
    expect((await k.call('GET', `${SELLER}/invitations/${mine.id}`, sellerB)).status).toBe(404);

    const noConsent = await k.call('POST', `${SELLER}/invitations/${mine.id}/accept`, sellerA, { offerIds: [good.id], consent: false, consentTextVersion: '2026-10' });
    expect(noConsent.body.error.code).toBe('CONSENT_REQUIRED');
    const ineligible = await k.call('POST', `${SELLER}/invitations/${mine.id}/accept`, sellerA, { offerIds: [low.id], consent: true, consentTextVersion: '2026-10' });
    expect(ineligible.body.error).toMatchObject({ code: 'OFFER_NOT_ELIGIBLE', details: { offers: [{ offerId: low.id }] } });
    const ok = await k.call('POST', `${SELLER}/invitations/${mine.id}/accept`, sellerA, { offerIds: [good.id], consent: true, consentTextVersion: '2026-10' });
    expect(ok.status).toBe(200);
    expect(ok.body.participation).toMatchObject({ state: 'accepted', offerCount: 1, consentedBy: { kind: 'seller' } });
    expect(ok.body.participation.consentText).toContain('My store funds 50% of each discount');
    expect(k.of('promotions.participation.decided').at(-1)).toMatchObject({ participationId: mine.id, state: 'accepted' });
    expect(k.audits.at(-1)).toMatchObject({ action: 'promotions.participation.accept', visibleToSeller: true });

    // Finance confirmation sees the consent; once live the consented offer is priced and the other is not
    await k.call('POST', `${ADMIN}/campaigns/${id}/submit`, k.staff, {});
    await k.call('POST', `${ADMIN}/campaigns/${id}/confirm-funding`, k.finance, {});
    await k.call('POST', `${ADMIN}/campaigns/${id}/schedule`, k.staff, {});
    const prices = await k.svc.priceOffers([good.id, low.id], { at: new Date(Date.parse(startsAt) + 60_000).toISOString() });
    expect(prices.find((p) => p.offerId === good.id)).toMatchObject({ price: USD(8000), campaignId: id });
    expect(prices.find((p) => p.offerId === low.id)!.price).toEqual(USD(10000));

    // leaving before the start is immediate
    const left = await k.call('POST', `${SELLER}/invitations/${mine.id}/withdraw`, sellerA, { reason: 'Stock' });
    expect(left.body.participation.state).toBe('withdrawn');
  });

  it('turns leaving after the start into a request Marketing decides, and lets staff remove offers', async () => {
    const o1 = k.offer({ sellerId: SELLER_B, categoryId: HOME });
    const o2 = k.offer({ sellerId: SELLER_B, categoryId: HOME });
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { discount: { kind: 'markdown', percentOffBps: 1000 }, participation: { inviteSellers: true, rules: [] } }));
    const id = c.body.id;
    const inv = await k.call('POST', `${ADMIN}/campaigns/${id}/invitations`, k.staff, { sellerIds: [SELLER_B], respondBy: new Date(k.clock.now().getTime() + 86_400_000).toISOString() });
    const pid = inv.body[0].id;
    await k.call('POST', `${SELLER}/invitations/${pid}/accept`, sellerB, { offerIds: [o1.id, o2.id], consent: true, consentTextVersion: 'v1' });
    const removed = await k.call('POST', `${ADMIN}/participations/${pid}/remove`, k.staff, { offerIds: [o2.id], reason: 'Price raised' });
    expect(removed.body).toMatchObject({ state: 'accepted', offerCount: 1 });
    for (const step of ['submit', 'confirm-funding', 'schedule']) expect((await k.call('POST', `${ADMIN}/campaigns/${id}/${step}`, step === 'confirm-funding' ? k.finance : k.staff, {})).status).toBe(200);
    const req = await k.call('POST', `${SELLER}/invitations/${pid}/withdraw`, sellerB, { reason: 'Out of stock soon' });
    expect(req.body.participation.state).toBe('withdrawal_requested');
    const kept = await k.call('POST', `${ADMIN}/participations/${pid}/decide-withdrawal`, k.staff, { approve: false, reason: 'Campaign promise' });
    expect(kept.body.state).toBe('accepted');
    await k.call('POST', `${SELLER}/invitations/${pid}/withdraw`, sellerB, { reason: 'Again' });
    const approved = await k.call('POST', `${ADMIN}/participations/${pid}/decide-withdrawal`, k.staff, { approve: true, reason: 'OK' });
    expect(approved.body.state).toBe('withdrawn');
    const again = await k.call('POST', `${ADMIN}/participations/${pid}/decide-withdrawal`, k.staff, { approve: true, reason: 'OK' });
    expect(again.status).toBe(409);
    const decline = await k.call('POST', `${SELLER}/invitations/${pid}/decline`, sellerB, {});
    expect(decline.body.error.code).toBe('ILLEGAL_TRANSITION');
    const list = await k.call('GET', `${SELLER}/invitations?state=withdrawn`, sellerB);
    expect(list.body.items.map((i: any) => i.participation.id)).toContain(pid);
  });

  it('closes invitations after the deadline (job) and refuses late answers', async () => {
    k.offer({ sellerId: SELLER_A, categoryId: HOME });
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { discount: { kind: 'markdown', percentOffBps: 1000 }, participation: { inviteSellers: true, rules: [] } }));
    const inv = await k.call('POST', `${ADMIN}/campaigns/${c.body.id}/invitations`, k.staff, { sellerIds: [SELLER_A], respondBy: new Date(k.clock.now().getTime() + 3_600_000).toISOString() });
    const pid = inv.body[0].id;
    k.clock.advance(2 * 3_600_000);
    const late = await k.svc.participation.accept(SELLER_A, pid, { offerIds: [], consent: true, consentTextVersion: 'v' }, { actor: { kind: 'seller', id: SELLER_A } }).catch((e) => e);
    expect(late.code).toBe('INVITATION_CLOSED');
    await k.app.kernel.jobs.runNow('promotions.invitation-deadlines');
    expect((await k.svc.participation.getInvitation(SELLER_A, pid)).participation.state).toBe('expired');
    k.clock.set(new Date());
  });
});
