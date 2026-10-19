/**
 * Gap pass 3: cancel a page schedule, homepage review (content.reviewRequired.section), seller_feature blocks
 * hidden for suspended, restricted or closed sellers, seller announcements from policy versions, deals limited
 * to one promotion and the content linked to a campaign.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, harness, inMs, MIN, newId, type Harness } from './helpers.js';

let h: Harness;

beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const page = (over: Record<string, unknown> = {}) => ({
  kind: 'campaign',
  title: `Page ${newId().slice(-8)}`,
  blocks: [{ id: 'intro', type: 'text', body: '<p>Hello</p>', products: [] }],
  ...over,
});

describe('cancelPageSchedule', () => {
  it('scheduled → draft, clearing the times; a page that is not scheduled cannot be cancelled', async () => {
    const p = (await h.admin('POST', '/pages', page())).json();
    const id = p.summary.id;
    const sched = await h.admin('POST', `/pages/${id}/schedule`, { publishAt: inMs(h, DAY), unpublishAt: inMs(h, 2 * DAY), timeZone: 'America/Los_Angeles' });
    expect(sched.json().summary.status).toBe('scheduled');
    const cancelled = await h.admin('POST', `/pages/${id}/cancel-schedule`, { reason: 'Campaign moved' });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().summary).toMatchObject({ status: 'draft', draftVersion: 1 });
    expect(cancelled.json().summary.schedule).toMatchObject({ publishAt: null, unpublishAt: null });
    expect(h.audits.at(-1)).toMatchObject({ action: 'content.page.cancel-schedule', reason: 'Campaign moved' });
    // the schedule job publishes nothing later
    h.clock.advance(DAY + MIN);
    await h.app.kernel.jobs.runNow('content.run-schedules');
    expect((await h.admin('GET', `/pages/${id}`)).json().summary.status).toBe('draft');
    expect((await h.admin('POST', `/pages/${id}/cancel-schedule`, {})).statusCode).toBe(409);
  });
});

describe('homepage review (content.reviewRequired.section)', () => {
  it('needs submission and approval by someone else before publishing; an edit after submission resets it', async () => {
    const editor = newId();
    const reviewer = newId();
    // review off: submit is refused and draftReview says not_required
    expect((await h.admin('POST', '/homepage/submit', {}, h.staff(editor))).statusCode).toBe(409);
    expect((await h.admin('GET', '/homepage')).json().draftReview.state).toBe('not_required');

    h.settingsValues['content.reviewRequired'] = { page: false, section: true, article: true };
    try {
      const added = await h.admin('POST', '/homepage/sections', { kind: 'promise_strip', heading: 'Why shop here', promiseItems: [{ icon: 'truck', title: 'Fast delivery', body: 'Most items arrive in 2–4 days' }, { icon: 'return', title: 'Easy returns', body: '30 days' }] }, h.staff(editor));
      expect(added.statusCode, added.body).toBe(201);
      expect((await h.admin('GET', '/homepage')).json().draftReview).toMatchObject({ state: 'not_submitted' });
      const early = await h.admin('POST', '/homepage/publish', { summary: 'Promise strip' }, h.staff(reviewer));
      expect(early.statusCode).toBe(409);
      expect(early.json().error).toMatchObject({ code: 'ILLEGAL_TRANSITION', details: { reason: 'review_required' } });
      // reviewing before submission is illegal
      expect((await h.admin('POST', '/homepage/review', { approve: true }, h.staff(reviewer))).statusCode).toBe(409);

      const submitted = await h.admin('POST', '/homepage/submit', { summary: 'Adds the promise strip' }, h.staff(editor));
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json().draftReview).toMatchObject({ state: 'in_review', submittedBy: { kind: 'staff', id: editor } });
      expect((await h.admin('POST', '/homepage/submit', {}, h.staff(editor))).statusCode).toBe(409);
      const own = await h.admin('POST', '/homepage/review', { approve: true }, h.staff(editor));
      expect(own.statusCode).toBe(409);
      expect(own.json().error.code).toBe('SAME_REVIEWER');
      const changes = await h.admin('POST', '/homepage/review', { approve: false, note: 'Shorter title' }, h.staff(reviewer));
      expect(changes.json().draftReview).toMatchObject({ state: 'changes_requested', note: 'Shorter title', reviewedBy: { id: reviewer } });

      await h.admin('POST', '/homepage/submit', {}, h.staff(editor));
      const approved = await h.admin('POST', '/homepage/review', { approve: true, note: 'Looks good' }, h.staff(reviewer));
      expect(approved.json().draftReview.state).toBe('approved');
      // an edit after approval sends the draft back
      const order = (await h.admin('GET', '/homepage')).json().sections.map((s: any) => s.id);
      await h.admin('PUT', '/homepage/order', { sectionIds: [...order].reverse() }, h.staff(editor));
      expect((await h.admin('GET', '/homepage')).json().draftReview.state).toBe('not_submitted');
      expect((await h.admin('POST', '/homepage/publish', { summary: 'x' }, h.staff(reviewer))).statusCode).toBe(409);

      await h.admin('POST', '/homepage/submit', {}, h.staff(editor));
      await h.admin('POST', '/homepage/review', { approve: true }, h.staff(reviewer));
      const published = await h.admin('POST', '/homepage/publish', { summary: 'Promise strip' }, h.staff(reviewer));
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json()).toMatchObject({ hasDraft: false });
      expect(h.audits.map((a) => a.action)).toEqual(expect.arrayContaining(['content.homepage.submit', 'content.homepage.approve', 'content.homepage.request-changes', 'content.homepage.publish']));
    } finally {
      delete h.settingsValues['content.reviewRequired'];
    }
  });
});

describe('seller_feature blocks', () => {
  it('are left out while the seller is suspended, restricted or closed, and shown again after reinstatement', async () => {
    const sellerId = newId();
    h.sellers.set(sellerId, { name: 'Casa Verde Home', status: 'approved' });
    const created = await h.admin('POST', '/pages', page({ title: 'Meet the makers', blocks: [{ id: 'intro', type: 'text', body: '<p>Makers</p>', products: [] }, { id: 'maker', type: 'seller_feature', heading: 'Casa Verde Home', sellerId, products: [] }] }));
    expect(created.statusCode, created.body).toBe(201);
    const p = created.json().summary;
    expect((await h.admin('POST', `/pages/${p.id}/publish`)).statusCode).toBe(200);
    const blocks = async () => (await h.store('GET', `/pages/${p.slug}`)).json().blocks.map((b: any) => b.id);
    expect(await blocks()).toEqual(['intro', 'maker']);
    for (const status of ['suspended', 'restricted', 'closed']) {
      h.sellers.get(sellerId)!.status = status;
      expect(await blocks()).toEqual(['intro']);
    }
    h.sellers.get(sellerId)!.status = 'approved';
    await h.app.kernel.events.publish('sellers', 'sellers.seller.reinstated', { sellerId, from: 'suspended', to: 'approved', liftedRestrictionId: null, endedSuspensionId: newId(), remainingRestrictionIds: [], by: { kind: 'staff', id: newId() } } as never);
    await h.app.kernel.events.drain();
    expect(await blocks()).toEqual(['intro', 'maker']);
  });

  it('flags pages naming a closed seller once per closure (inbox)', async () => {
    const sellerId = newId();
    h.sellers.set(sellerId, { name: 'Pixel & Port', status: 'approved' });
    const p = (await h.admin('POST', '/pages', page({ blocks: [{ id: 'maker', type: 'seller_feature', heading: 'Pixel & Port', sellerId, products: [] }] }))).json().summary;
    const payload = { sellerId, reasonCode: 'seller_request', closedBy: { kind: 'staff', id: newId() } };
    await h.service.onSellerClosedFromSellers(payload as never, 'evt-closed-1');
    await h.service.onSellerClosedFromSellers(payload as never, 'evt-closed-1');
    const logs = await (h.service as any).repo.logsOf('page', p.id, 'seller_closed');
    expect(logs).toHaveLength(1);
  });
});

describe('seller announcements', () => {
  it('lists scheduled or current seller-facing policy versions flagged for sellers, newest first', async () => {
    const owner = newId();
    h.decision = 'allowed';
    try {
      const policy = (await h.admin('POST', '/policies', { key: 'seller_rules', title: 'Seller terms', ownerStaffId: owner, audience: 'seller' })).json();
      expect(policy.id).toBeTruthy();
      const v = (await h.admin('POST', `/policies/${policy.id}/versions`, {}, h.staff(owner))).json();
      await h.admin('PATCH', `/policy-versions/${v.id}`, { body: '<p>Fees are shown before you list.</p>', changeSummary: null, notifySellers: true }, h.staff(owner));
      expect((await h.admin('POST', `/policy-versions/${v.id}/submit`, undefined, h.staff(owner))).statusCode).toBe(200);
      const approved = await h.admin('POST', `/policy-versions/${v.id}/approve`, { approve: true }, h.staff(owner));
      expect(approved.json().state).toBe('approved');
      const effectiveAt = inMs(h, 2 * DAY);
      expect((await h.admin('POST', `/policy-versions/${v.id}/schedule`, { effectiveAt }, h.staff(owner))).json().state).toBe('scheduled');

      const list = await h.service.sellerAnnouncements({ limit: 10 });
      expect(list[0]).toMatchObject({ policyVersionId: v.id, policyKey: 'seller_rules', version: '1.0', state: 'scheduled', url: `/policy-versions/${v.id}` });
      expect(await h.service.sellerAnnouncements({ limit: 10, since: inMs(h, 30 * DAY) })).toEqual([]);
    } finally {
      h.decision = 'approval_required';
    }
  });
});

describe('deals limited to one promotion', () => {
  it('a deals source with campaignId reads promotions.liveDeals for that campaign; contentForCampaign lists it', async () => {
    const campaignId = newId();
    h.campaigns.set(campaignId, { name: 'Flash Friday', startsAt: inMs(h, -DAY), endsAt: inMs(h, DAY), active: true, status: 'live' });
    const offerId = newId();
    const productId = newId();
    h.deals = [
      {
        campaignId,
        name: 'Flash Friday',
        state: 'live',
        secondsLeft: 3600,
        period: { startsAt: inMs(h, -DAY), endsAt: inMs(h, DAY), timeZone: 'America/Los_Angeles', display: '' },
        items: [{ id: newId(), offerId, productId, title: 'Desk lamp', image: null, sellerId: '00000000-0000-7000-8000-000000000001', sellerName: 'Marketly Official Store', dealPrice: { amount: 1999, currency: 'USD' }, regularPrice: { amount: 2999, currency: 'USD' }, percentOffBps: 3334, dealStock: 10, claimed: 4, claimedPct: 40, purchaseLimit: 2 }],
      },
    ];
    try {
      const created = await h.admin('POST', '/pages', page({ title: 'Flash deals', blocks: [{ id: 'deals', type: 'product_grid', productSource: { mode: 'rule', rule: { kind: 'deals', campaignId, description: 'Flash Friday deals' } }, products: [] }] }));
      expect(created.statusCode, created.body).toBe(201);
      const p = created.json().summary;
      await h.admin('POST', `/pages/${p.id}/publish`);
      const store = (await h.store('GET', `/pages/${p.slug}`)).json();
      expect(h.dealCalls.at(-1)).toMatchObject({ campaignId });
      expect(store.blocks[0].products[0]).toMatchObject({ productId, offerId, title: 'Desk lamp', price: { amount: 1999 }, wasPrice: { amount: 2999 }, officialStore: true, availableQty: 6 });

      const linked = (await h.admin('POST', '/pages', page({ title: 'Linked campaign page', linkedPromotionId: campaignId }))).json().summary;
      const other = (await h.admin('POST', '/pages', page({ title: 'Unrelated' }))).json().summary;
      const content = await h.service.contentForCampaign(campaignId);
      const ids = content.pages.map((x) => x.id);
      expect(ids).toEqual(expect.arrayContaining([p.id, linked.id]));
      expect(ids).not.toContain(other.id);
      expect(content.pages.find((x) => x.id === p.id)).toMatchObject({ slug: p.slug, url: p.url });
    } finally {
      h.deals = null;
    }
  });
});

describe('homepage restore while review is on', () => {
  it('publishes straight away only a layout that was live before; any other version is restored as a draft', async () => {
    h.settingsValues['content.reviewRequired'] = { page: false, section: true, article: true };
    try {
      const added = await h.admin('POST', '/homepage/sections', { kind: 'promise_strip', heading: 'Never reviewed', promiseItems: [{ icon: 'truck', title: 'Fast', body: 'Quick' }, { icon: 'return', title: 'Returns', body: '30 days' }] });
      expect(added.statusCode, added.body).toBe(201);
      const versions = (await h.admin('GET', '/homepage/versions')).json().items as { number: number; state: string; publishedAt?: string | null }[];
      const unreviewed = versions.find((v) => v.state === 'draft')!;
      const res = await h.admin('POST', `/homepage/versions/${unreviewed.number}/restore`, { reason: 'Skip the review', publish: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'ILLEGAL_TRANSITION', details: { reason: 'review_required' } });
      expect((await h.admin('POST', `/homepage/versions/${unreviewed.number}/restore`, { reason: 'Review it first', publish: false })).statusCode).toBe(200);
    } finally {
      delete h.settingsValues['content.reviewRequired'];
    }
  });
});
