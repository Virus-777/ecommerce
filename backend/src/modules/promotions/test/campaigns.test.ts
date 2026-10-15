import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callers } from '../../../testing/app.js';
import { ADMIN, boot, campaignInput, HOME, liveCampaign, OFFICIAL_SELLER, SELLER_A, USD, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(() => k?.close());

describe('platform campaigns', () => {
  it('runs draft → Finance → approved → scheduled → live → paused → live → ended with events, audit and history', async () => {
    k.offer({ categoryId: HOME });
    const input = campaignInput(k.clock, { code: 'fallhome20', funding: { owner: 'platform', costCenter: 'MKT-01' } });
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, input);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', code: 'FALLHOME20', ref: expect.stringMatching(/^PRM-\d{6}-\d{4}$/), locked: false, autoApply: false });
    const id = created.body.id;
    expect(k.audits.at(-1)).toMatchObject({ action: 'promotions.campaign.create', target: { id } });

    const submitted = await k.call('POST', `${ADMIN}/campaigns/${id}/submit`, k.staff, { note: 'Ready' });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'in_review', locked: true, fundingReview: { state: 'waiting', platformMaximum: USD(1_000_000) } });
    expect(k.of('promotions.campaign.submitted').at(-1)).toMatchObject({ campaignId: id, fundingOwner: 'platform' });

    const locked = await k.call('PATCH', `${ADMIN}/campaigns/${id}`, k.staff, { name: 'x', version: submitted.body.version });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('CAMPAIGN_LOCKED');

    const confirmed = await k.call('POST', `${ADMIN}/campaigns/${id}/confirm-funding`, k.finance, { comment: 'OK' });
    expect(confirmed.body).toMatchObject({ status: 'approved', fundingReview: { state: 'confirmed', comment: 'OK' } });
    expect(k.of('promotions.campaign.funding_confirmed').at(-1)).toMatchObject({ campaignId: id, platformMaximum: USD(1_000_000), sellersMaximum: USD(0) });

    const scheduled = await k.call('POST', `${ADMIN}/campaigns/${id}/schedule`, k.staff, {});
    expect(scheduled.body.status).toBe('live'); // the start time has already come
    expect(k.of('promotions.campaign.scheduled').at(-1)).toMatchObject({ campaignId: id });
    expect(k.of('promotions.campaign.started').at(-1)).toMatchObject({ campaignId: id, kind: 'percent_coupon' });

    expect((await k.call('POST', `${ADMIN}/campaigns/${id}/pause`, k.staff, { reason: 'Pricing check' })).body.status).toBe('paused');
    expect(k.of('promotions.campaign.paused').at(-1)).toEqual({ campaignId: id, reason: 'Pricing check' });
    expect((await k.call('POST', `${ADMIN}/campaigns/${id}/resume`, k.staff, {})).body.status).toBe('live');
    expect(k.of('promotions.campaign.resumed').at(-1)).toEqual({ campaignId: id });

    const cancel = await k.call('POST', `${ADMIN}/campaigns/${id}/cancel`, k.staff, { reason: 'no' });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe('ILLEGAL_TRANSITION');

    const ended = await k.call('POST', `${ADMIN}/campaigns/${id}/end`, k.staff, { reason: 'Stock issue' });
    expect(ended.body).toMatchObject({ status: 'ended', endedReason: 'ended_early' });
    expect(k.of('promotions.campaign.ended').at(-1)).toEqual({ campaignId: id, reason: 'ended_early' });

    const history = await k.call('GET', `${ADMIN}/campaigns/${id}/history?limit=50`, k.staff);
    expect(history.body.items.map((h: any) => h.action)).toEqual(expect.arrayContaining(['created', 'submitted', 'funding.confirmed', 'schedule', 'started', 'pause', 'resume', 'ended']));
    // the code is free again once the campaign ended
    const again = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { code: 'FALLHOME20' }));
    expect(again.status).toBe(201);
  });

  it('refuses a code used by another open campaign, stale versions and invalid input', async () => {
    const a = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { code: 'TAKEN10' }));
    expect(a.status).toBe(201);
    const b = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { code: 'taken10' }));
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('CODE_TAKEN');
    const stale = await k.call('PATCH', `${ADMIN}/campaigns/${a.body.id}`, k.staff, { name: 'New', version: a.body.version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT');
    const bad = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { discount: { kind: 'percent_coupon', percentOffBps: 0 }, endsAt: new Date(0).toISOString() }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues.map((i: any) => i.path)).toEqual(expect.arrayContaining(['discount.percentOffBps', 'endsAt']));
    const missing = await k.call('GET', `${ADMIN}/campaigns/${crypto.randomUUID()}`, k.staff);
    expect(missing.status).toBe(404);
  });

  it('reopens an approved campaign to draft on a material edit but not on a cosmetic one', async () => {
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { startsAt: new Date(k.clock.now().getTime() + 86_400_000).toISOString() }));
    const id = c.body.id;
    await k.call('POST', `${ADMIN}/campaigns/${id}/submit`, k.staff, {});
    const approved = await k.call('POST', `${ADMIN}/campaigns/${id}/confirm-funding`, k.finance, {});
    const cosmetic = await k.call('PATCH', `${ADMIN}/campaigns/${id}`, k.staff, { name: 'Fall Home Week 2', version: approved.body.version });
    expect(cosmetic.body).toMatchObject({ status: 'approved', name: 'Fall Home Week 2' });
    const material = await k.call('PATCH', `${ADMIN}/campaigns/${id}`, k.staff, { discount: { kind: 'percent_coupon', percentOffBps: 2500 }, version: cosmetic.body.version });
    expect(material.body).toMatchObject({ status: 'draft', discount: { percentOffBps: 2500 } });
    // platform drafts can't skip Finance
    const skip = await k.call('POST', `${ADMIN}/campaigns/${id}/schedule`, k.staff, {});
    expect(skip.status).toBe(409);
  });

  it('validates on submit: seller-funded parts need seller consent', async () => {
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { funding: { owner: 'shared', platformShareBps: 5000 } }));
    const r = await k.call('POST', `${ADMIN}/campaigns/${c.body.id}/submit`, k.staff, {});
    expect(r.status).toBe(400);
    expect(r.body.error.details.issues.map((i: any) => i.path)).toContain('participation.inviteSellers');
  });

  it('raises an approval request above the confirming member’s limit and finishes on access.approval.decided', async () => {
    k.authority.set('promotions.budgets.approve', 'approval_required');
    try {
      const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { limits: { budget: USD(5_000_000) } }));
      const id = c.body.id;
      await k.call('POST', `${ADMIN}/campaigns/${id}/submit`, k.staff, {});
      const pending = await k.call('POST', `${ADMIN}/campaigns/${id}/confirm-funding`, k.finance, { comment: 'Big one' });
      expect(pending.status).toBe(200);
      expect(pending.body).toMatchObject({ status: 'in_review', fundingReview: { approval: { required: true } } });
      const [requestId, req] = [...k.approvals.entries()].at(-1)!;
      expect(req).toMatchObject({ action: 'promotions.budgets.approve', amount: USD(5_000_000), target: { id } });
      const again = await k.call('POST', `${ADMIN}/campaigns/${id}/confirm-funding`, k.finance, {});
      expect(again.body.error.code).toBe('APPROVAL_REQUIRED');
      await k.emit('access.approval.decided', { requestId, ref: 'AP-1', actionKey: 'promotions.budgets.approve', module: 'promotions', target: { type: 'promotion_campaign', id }, outcome: 'approved', decidedBy: { kind: 'staff', id: crypto.randomUUID() }, approverIds: [], requestedById: crypto.randomUUID() });
      expect((await k.call('GET', `${ADMIN}/campaigns/${id}`, k.staff)).body.status).toBe('approved');
      expect(k.of('promotions.campaign.funding_confirmed').at(-1)).toMatchObject({ campaignId: id });
      // a second campaign is rejected by the approver → changes requested
      const d = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock));
      await k.call('POST', `${ADMIN}/campaigns/${d.body.id}/submit`, k.staff, {});
      await k.call('POST', `${ADMIN}/campaigns/${d.body.id}/confirm-funding`, k.finance, {});
      const [rid] = [...k.approvals.entries()].at(-1)!;
      await k.emit('access.approval.decided', { requestId: rid, ref: 'AP-2', actionKey: 'promotions.budgets.approve', module: 'promotions', target: { type: 'promotion_campaign', id: d.body.id }, outcome: 'rejected', reason: 'Too much', approverIds: [], requestedById: crypto.randomUUID() });
      expect((await k.call('GET', `${ADMIN}/campaigns/${d.body.id}`, k.staff)).body).toMatchObject({ status: 'changes_requested', fundingReview: { state: 'changes_requested', comment: 'Too much' } });
      expect(k.of('promotions.campaign.changes_requested').at(-1)).toEqual({ campaignId: d.body.id, reason: 'Too much' });
    } finally {
      k.authority.delete('promotions.budgets.approve');
    }
  });

  it('lets Finance send a campaign back, and Marketing withdraw it', async () => {
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock));
    await k.call('POST', `${ADMIN}/campaigns/${c.body.id}/submit`, k.staff, {});
    const back = await k.call('POST', `${ADMIN}/campaigns/${c.body.id}/request-changes`, k.staff, { reason: 'Add a cost center' });
    expect(back.body.status).toBe('changes_requested');
    await k.call('POST', `${ADMIN}/campaigns/${c.body.id}/submit`, k.staff, {});
    expect((await k.call('POST', `${ADMIN}/campaigns/${c.body.id}/withdraw`, k.staff)).body.status).toBe('draft');
    expect((await k.call('POST', `${ADMIN}/campaigns/${c.body.id}/cancel`, k.staff, { reason: 'Not this year' })).body.status).toBe('cancelled');
    expect(k.of('promotions.campaign.cancelled').at(-1)).toEqual({ campaignId: c.body.id, reason: 'Not this year' });
  });

  it('resolves the eligible offer set with exclusions and shows a price preview', async () => {
    const inHome = k.offer({ categoryId: HOME, price: USD(5000) });
    const excluded = k.offer({ categoryId: HOME });
    k.offer({ ownerType: 'official', sellerId: null, categoryId: HOME });
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { discount: { kind: 'markdown', percentOffBps: 2000 }, scope: { mode: 'categories', include: [{ kind: 'category', id: HOME, label: 'Home' }], exclude: [{ kind: 'offer', id: excluded.id, label: 'Clearance item' }] } }));
    expect(c.body.eligible.offers).toBeGreaterThanOrEqual(2);
    expect(c.body.eligible.officialStore).toBe(true);
    expect(c.body.eligible.excludedOffers).toBeGreaterThanOrEqual(1);
    const list = await k.call('GET', `${ADMIN}/campaigns/${c.body.id}/eligible-offers?eligible=false`, k.staff);
    expect(list.body.items.find((o: any) => o.offerId === excluded.id)).toMatchObject({ eligible: false, ineligibleReasons: ['Excluded: Clearance item'] });
    const preview = await k.call('POST', `${ADMIN}/campaigns/${c.body.id}/price-preview`, k.staff, { offerId: inHome.id });
    expect(preview.body.productCard).toMatchObject({ price: USD(4000), wasPrice: USD(5000), sellerName: 'Casa Verde Home' });
  });

  it('generates unique codes, lists and deactivates them', async () => {
    const c = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock));
    const gen = await k.call('POST', `${ADMIN}/campaigns/${c.body.id}/codes`, k.staff, { count: 25, prefix: 'SUP', maxRedemptionsEach: 1 });
    expect(gen.status).toBe(201);
    expect(gen.body.created).toBe(25);
    expect(gen.body.sample[0].code).toMatch(/^SUP-[A-Z2-9]{8}$/);
    const list = await k.call('GET', `${ADMIN}/campaigns/${c.body.id}/codes?limit=10`, k.staff);
    expect(list.body.items).toHaveLength(10);
    const off = await k.call('POST', `${ADMIN}/codes/${gen.body.sample[0].id}/deactivate`, k.staff, { reason: 'Leaked' });
    expect(off.body.active).toBe(false);
    expect(k.audits.at(-1)).toMatchObject({ action: 'promotions.code.deactivate', reason: 'Leaked' });
    expect((await k.call('GET', `${ADMIN}/campaigns/${c.body.id}`, k.staff)).body.codeCount).toBe(25);
  });

  it('lists campaigns with filters and shows the dashboard', async () => {
    const list = await k.call('GET', `${ADMIN}/campaigns?ownerKind=platform&status=draft,ended`, k.staff);
    expect(list.status).toBe(200);
    expect(list.body.items.every((c: any) => c.ownerKind === 'platform' && ['draft', 'ended'].includes(c.status))).toBe(true);
    expect(list.body.items[0].fundingLabel).toBeTruthy();
    const dash = await k.call('GET', `${ADMIN}/dashboard`, k.staff);
    expect(dash.status).toBe(200);
    expect(dash.body.tabs.map((t: any) => t.key)).toEqual(['live', 'scheduled', 'in_review', 'draft', 'ended', 'seller']);
    expect(dash.body.dailyCost).toHaveLength(30);
    const viewer = await k.call('GET', `${ADMIN}/dashboard`, callers.staff(['promotions.campaigns.view']));
    expect(viewer.status).toBe(403);
  });

  it('ends campaigns at their end time and starts scheduled ones (jobs)', async () => {
    const soon = await liveCampaign(k, campaignInput(k.clock, { startsAt: new Date(k.clock.now().getTime() + 3_600_000).toISOString(), endsAt: new Date(k.clock.now().getTime() + 7_200_000).toISOString() }));
    expect(soon.status).toBe('scheduled');
    k.clock.advance(3_700_000);
    await k.app.kernel.jobs.runNow('promotions.start-due');
    const mid = { body: await k.svc.campaigns.view(soon.id) };
    expect(mid.body.status, JSON.stringify(mid.body)).toBe('live');
    k.clock.advance(3_700_000);
    await k.app.kernel.jobs.runNow('promotions.end-due');
    await k.app.kernel.events.drain();
    expect(await k.svc.campaigns.view(soon.id)).toMatchObject({ status: 'ended', endedReason: 'period_over' });
    expect(k.of('promotions.campaign.ended').at(-1)).toEqual({ campaignId: soon.id, reason: 'period_over' });
    k.clock.set(new Date());
  });

  it('exports campaign results rows for reports', async () => {
    const rows = await k.svc.exportRows('promotions.admin.campaigns', {}, { kind: 'staff', accountId: crypto.randomUUID() });
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0]).toHaveProperty('discountCost');
    await expect(k.svc.exportRows('promotions.admin.other', {}, { kind: 'staff' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    void SELLER_A;
    void OFFICIAL_SELLER;
  });
});
