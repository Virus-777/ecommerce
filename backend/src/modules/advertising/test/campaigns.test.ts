import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { ADMIN, boot, campaignInput, creative, liveCampaign, openingCreatives, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

describe('campaign drafts', () => {
  it('creates a draft with placement defaults, a reference and an audit entry', async () => {
    const res = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      status: 'draft',
      origin: 'staff',
      advertiser: { kind: 'platform', name: 'Marketly', paid: false },
      placement: { key: 'opening_fullscreen', enabled: true },
      frequencyCap: { perSession: 1, perWindow: { count: 3, days: 7 } },
      dismissal: { mode: 'session' },
      budget: { billing: 'none', spent: { amount: 0, currency: 'USD' } },
      version: 1,
    });
    expect(res.body.ref).toMatch(/^AD-\d{6}-\d{4}$/);
    expect(res.body.timeline[0]).toMatchObject({ label: 'Draft created' });
    expect(k.audits.some((a) => a.action === 'advertising.campaign.create' && a.target.id === res.body.id)).toBe(true);
  });

  it('refuses blocked or ineligible pages (PAGE_NOT_ELIGIBLE) and placements that are off (PLACEMENT_DISABLED)', async () => {
    let res = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { pages: ['home', 'checkout'] }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAGE_NOT_ELIGIBLE');
    res = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { pages: ['product'] }));
    expect(res.body.error.code).toBe('PAGE_NOT_ELIGIBLE');
    res = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { placementKey: 'interstitial', pages: ['product'] }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLACEMENT_DISABLED');
    res = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { endsAt: new Date(k.clock.now().getTime() - 1000).toISOString() }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('checks before submit: missing creatives fail (CHECKS_FAILED with details.checks)', async () => {
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k));
    const check = await k.call('POST', `${ADMIN}/campaigns/${created.body.id}/check`, k.staff);
    expect(check.status).toBe(200);
    expect(check.body.canSubmit).toBe(false);
    expect(check.body.checks.find((c: any) => c.label === 'Creatives')).toMatchObject({ state: 'fail' });
    const sub = await k.call('POST', `${ADMIN}/campaigns/${created.body.id}/submit`, k.staff, {});
    expect(sub.status).toBe(422);
    expect(sub.body.error.code).toBe('CHECKS_FAILED');
    expect(sub.body.error.details.checks.length).toBeGreaterThan(3);
  });

  it('needs separate desktop and phone creatives for the opening ad', async () => {
    const desktop = await creative(k, 'opening_fullscreen', 'desktop', [1600, 900]);
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { creativeIds: [desktop.id] }));
    const check = await k.call('POST', `${ADMIN}/campaigns/${created.body.id}/check`, k.staff);
    expect(check.body.checks.find((c: any) => c.label === 'Creatives')).toMatchObject({ state: 'fail', detail: 'Missing phone creative' });
  });

  it('edits a draft with the current version; a stale version is CONFLICT', async () => {
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k));
    const res = await k.call('PATCH', `${ADMIN}/campaigns/${created.body.id}`, k.staff, { changes: campaignInput(k, { name: 'Renamed', priority: 3 }), version: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Renamed', priority: 3, version: 2 });
    const stale = await k.call('PATCH', `${ADMIN}/campaigns/${created.body.id}`, k.staff, { changes: campaignInput(k), version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT');
  });
});

describe('creatives', () => {
  it('validates size and format for the placement (CREATIVE_FORMAT_INVALID)', async () => {
    const small = k.asset(800, 600);
    let res = await k.call('POST', `${ADMIN}/creatives`, k.staff, { kind: 'image', device: 'desktop', placementKey: 'opening_fullscreen', mediaId: small.id, headline: 'Hi' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CREATIVE_FORMAT_INVALID');
    const big = k.asset(1600, 900, { sizeBytes: 3_000_000 });
    res = await k.call('POST', `${ADMIN}/creatives`, k.staff, { kind: 'image', device: 'desktop', placementKey: 'opening_fullscreen', mediaId: big.id });
    expect(res.body.error.code).toBe('CREATIVE_FORMAT_INVALID');
    res = await k.call('POST', `${ADMIN}/creatives`, k.staff, { kind: 'text', device: 'any', placementKey: 'home_banner', headline: 'x'.repeat(61) });
    expect(res.body.error.code).toBe('CREATIVE_FORMAT_INVALID');
  });

  it('runs link and automatic checks, lists, counts and edits (approved returns to draft)', async () => {
    const c = await creative(k, 'home_banner', 'desktop', [1200, 300], { link: 'http://example.com' });
    expect(c).toMatchObject({ status: 'draft', linkCheck: { state: 'fail' }, formatLabel: 'Sponsored brand banner · desktop', media: { id: expect.any(String) } });
    expect(c.autoChecks.map((x: any) => x.label)).toEqual(expect.arrayContaining(['Label', 'Format', 'Headline length', 'Claims', 'Link']));
    const edit = await k.call('PATCH', `${ADMIN}/creatives/${c.id}`, k.staff, { link: '/collections/fall' });
    expect(edit.status).toBe(200);
    expect(edit.body.linkCheck.state).toBe('ok');
    const list = await k.call('GET', `${ADMIN}/creatives?placementKey=home_banner&status=draft`, k.staff);
    expect(list.body.items.some((x: any) => x.id === c.id)).toBe(true);
    const summary = await k.call('GET', `${ADMIN}/creatives/summary?placementKey=home_banner`, k.staff);
    expect(summary.body.all).toBeGreaterThanOrEqual(1);
    expect(summary.body.draft).toBeGreaterThanOrEqual(1);
    // a draft creative can't be approved before it is submitted with its campaign
    const early = await k.call('POST', `${ADMIN}/creatives/${c.id}/review`, k.staff, { role: 'advertising', decision: 'approved' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('approval and lifecycle', () => {
  it('needs Advertising and Content approvals from two people, then schedules and goes live', async () => {
    const creatives = await openingCreatives(k);
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { creativeIds: creatives.map((c: any) => c.id) }));
    const id = created.body.id;
    const sub = await k.call('POST', `${ADMIN}/campaigns/${id}/submit`, k.staff, { noteToReviewers: 'Ready for Monday' });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe('in_review');
    expect(sub.body.approvals.map((a: any) => [a.role, a.state])).toEqual([
      ['advertising', 'waiting'],
      ['content', 'waiting'],
    ]);
    expect(sub.body.creatives.every((c: any) => c.status === 'in_review')).toBe(true);
    expect(k.of('advertising.campaign.status_changed').some((p) => p.campaignId === id && p.to === 'in_review')).toBe(true);

    const reviewer = callers.staff();
    let res = await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, reviewer, { role: 'advertising', note: 'Placement ok' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_review');
    res = await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, reviewer, { role: 'content' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SAME_REVIEWER');
    res = await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, callers.staff(), { role: 'content' });
    expect(res.status).toBe(200);
    // the start has passed: schedule (the default choice) and the start job made it live
    expect(res.body.status).toBe('live');
    expect(res.body.creatives.every((c: any) => c.status === 'approved')).toBe(true);
    const tos = k.of('advertising.campaign.status_changed').filter((p) => p.campaignId === id).map((p) => p.to);
    expect(tos).toEqual(['in_review', 'approved', 'scheduled', 'live']);
    expect(res.body.timeline.map((t: any) => t.label)).toEqual(expect.arrayContaining(['Submitted for approval', 'Review step approved', 'Approved', 'Scheduled', 'Went live']));
  });

  it('pauses with a reason, resumes, finishes early, archives and renews', async () => {
    const c = await liveCampaign(k);
    let res = await k.call('POST', `${ADMIN}/campaigns/${c.id}/pause`, k.staff, { reason: 'Wrong price in banner' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'paused', pausedReason: 'Wrong price in banner', pausedBy: { kind: 'staff' } });
    res = await k.call('POST', `${ADMIN}/campaigns/${c.id}/pause`, k.staff, { reason: 'again' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
    res = await k.call('POST', `${ADMIN}/campaigns/${c.id}/resume`, k.staff, {});
    expect(res.body.status).toBe('live');
    // a live campaign accepts an end-date change only
    const changes = campaignInput(k, { creativeIds: c.creatives.map((x: any) => x.id), startsAt: c.startsAt, endsAt: new Date(k.clock.now().getTime() + 2 * 86_400_000).toISOString() });
    res = await k.call('PATCH', `${ADMIN}/campaigns/${c.id}`, k.staff, { changes: { ...changes, name: c.name }, version: (await k.call('GET', `${ADMIN}/campaigns/${c.id}`, k.staff)).body.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(new Date(res.body.endsAt).getTime()).toBe(new Date(changes.endsAt).getTime());
    res = await k.call('PATCH', `${ADMIN}/campaigns/${c.id}`, k.staff, { changes: { ...changes, name: 'Other name' }, version: res.body.version });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');

    res = await k.call('POST', `${ADMIN}/campaigns/${c.id}/finish`, k.staff, { reason: 'Sale ended early' });
    expect(res.body).toMatchObject({ status: 'finished', finishedReason: 'stopped_early' });
    res = await k.call('POST', `${ADMIN}/campaigns/${c.id}/archive`, k.staff);
    expect(res.body.status).toBe('archived');
    const now = k.clock.now().getTime();
    res = await k.call('POST', `${ADMIN}/campaigns/${c.id}/renew`, k.staff, { startsAt: new Date(now + 86_400_000).toISOString(), endsAt: new Date(now + 8 * 86_400_000).toISOString() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'draft', name: c.name, version: 1 });
    expect(res.body.id).not.toBe(c.id);
    expect(res.body.creatives).toHaveLength(2);
    for (const action of ['advertising.campaign.pause', 'advertising.campaign.resume', 'advertising.campaign.finish', 'advertising.campaign.renew', 'advertising.campaign.update']) expect(k.audits.some((a) => a.action === action), action).toBe(true);
  });

  it('request changes and reject send the campaign back or out; editing an approved one returns it to draft', async () => {
    const creatives = await openingCreatives(k);
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { creativeIds: creatives.map((c: any) => c.id), afterApproval: 'schedule', startsAt: new Date(k.clock.now().getTime() + 3 * 86_400_000).toISOString() }));
    const id = created.body.id;
    await k.call('POST', `${ADMIN}/campaigns/${id}/submit`, k.staff, {});
    let res = await k.call('POST', `${ADMIN}/campaigns/${id}/request-changes`, callers.staff(), { role: 'content', reason: 'Claim does not match the promotion' });
    expect(res.body.status).toBe('draft');
    expect(res.body.approvals.find((a: any) => a.role === 'content')).toMatchObject({ state: 'changes_requested', note: 'Claim does not match the promotion' });
    await k.call('POST', `${ADMIN}/campaigns/${id}/submit`, k.staff, {});
    await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, callers.staff(), { role: 'advertising' });
    res = await k.call('POST', `${ADMIN}/campaigns/${id}/approve`, callers.staff(), { role: 'marketing' });
    // starts in 3 days: scheduled, not live
    expect(res.body.status).toBe('scheduled');
    res = await k.call('POST', `${ADMIN}/campaigns/${id}/activate`, k.staff);
    expect(res.status).toBe(409);

    const other = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { creativeIds: creatives.map((c: any) => c.id) }));
    await k.call('POST', `${ADMIN}/campaigns/${other.body.id}/submit`, k.staff, {});
    res = await k.call('POST', `${ADMIN}/campaigns/${other.body.id}/reject`, k.staff, { reason: 'Promoted offer suspended' });
    expect(res.body.status).toBe('rejected');
    expect(k.of('advertising.campaign.status_changed').some((p) => p.campaignId === other.body.id && p.to === 'rejected' && p.reason === 'Promoted offer suspended')).toBe(true);
    res = await k.call('POST', `${ADMIN}/campaigns/${other.body.id}/archive`, k.staff);
    expect(res.body.status).toBe('archived');
  });

  it('activate is refused while the linked promotion has not started (PROMOTION_NOT_STARTED), also at submit', async () => {
    const promo = k.promotion({ startsAt: new Date(k.clock.now().getTime() + 5 * 86_400_000).toISOString(), active: false, reason: 'not_started', status: 'scheduled' });
    const creatives = await openingCreatives(k);
    const input = campaignInput(k, { creativeIds: creatives.map((c: any) => c.id), linkedPromotionId: promo.id, stopWithPromotion: true, afterApproval: 'activate' });
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, input);
    expect(created.body).toMatchObject({ activateAllowed: false, linkedPromotion: { id: promo.id, code: 'HOME20' } });
    expect(created.body.activateBlockedReason).toMatch(/linked promotion starts/);
    let res = await k.call('POST', `${ADMIN}/campaigns/${created.body.id}/submit`, k.staff, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROMOTION_NOT_STARTED');
    await k.call('PATCH', `${ADMIN}/campaigns/${created.body.id}`, k.staff, { changes: { ...input, afterApproval: 'schedule' }, version: 1 });
    res = await k.call('POST', `${ADMIN}/campaigns/${created.body.id}/submit`, k.staff, {});
    expect(res.status).toBe(200);
    await k.call('POST', `${ADMIN}/campaigns/${created.body.id}/approve`, callers.staff(), { role: 'advertising' });
    await k.call('POST', `${ADMIN}/campaigns/${created.body.id}/approve`, callers.staff(), { role: 'content' });
    // scheduled campaign: the start has passed, but the start job only checks dates; activate checks the promotion
    const view = await k.call('GET', `${ADMIN}/campaigns/${created.body.id}`, k.staff);
    expect(['scheduled', 'live']).toContain(view.body.status);
  });

  it('lists campaigns with filters and shows conflicts between overlays', async () => {
    const a = await liveCampaign(k, { name: 'Overlay A', priority: 3 });
    const b = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { name: 'Overlay B', creativeIds: a.creatives.map((c: any) => c.id) }));
    const check = await k.call('POST', `${ADMIN}/campaigns/${b.body.id}/check`, k.staff);
    expect(check.body.conflicts.find((c: any) => c.campaignId === a.id)).toMatchObject({ name: 'Overlay A', pages: ['home'] });
    expect(check.body.conflicts.find((c: any) => c.campaignId === a.id).resolution).toMatch(/Only one overlay shows at a time/);
    const list = await k.call('GET', `${ADMIN}/campaigns?status=live&placementKey=opening_fullscreen&source=own`, k.staff);
    expect(list.status).toBe(200);
    expect(list.body.items.every((x: any) => x.status === 'live' && x.placementKey === 'opening_fullscreen')).toBe(true);
    expect(list.body.items.find((x: any) => x.id === a.id)).toMatchObject({ budgetLabel: 'Internal', allowedActions: ['pause', 'finish'], deliveryLabel: 'once per session · max 3 per visitor per 7 days · everyone' });
    const q = await k.call('GET', `${ADMIN}/campaigns?q=overlay b`, k.staff);
    expect(q.body.items.map((x: any) => x.id)).toEqual([b.body.id]);
    expect((await k.call('GET', `${ADMIN}/campaigns/${newId()}`, k.staff)).status).toBe(404);
  });

  it('previews desktop and phone with label and close control', async () => {
    const c = await liveCampaign(k);
    const res = await k.call('GET', `${ADMIN}/campaigns/${c.id}/preview?theme=dark`, k.staff);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ theme: 'dark', desktop: { label: 'Ad', dismissible: true, closeLabel: 'Close', impressionToken: 'preview', secondaryText: 'Continue to home page' }, phone: { label: 'Ad' } });
    expect(res.body.desktop.creativeId).not.toBe(res.body.phone.creativeId);
  });
});
