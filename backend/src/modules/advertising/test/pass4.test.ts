/**
 * Gap pass 4: pause and reject facts as columns (paused_by, paused_at, pause_cause, rejected_reason), the promoted
 * product on campaign_items (product_id instead of synthetic offer_product rows), frequency counters for the day and
 * the campaign total on frequency_state, TrackEvent.at optional and page types as plain strings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { ADMIN, boot, campaignInput, liveCampaign, openingCreatives, serve, STORE, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

const DAY = 86_400_000;
const row = (id: string) => k.svc.core.repo.get('campaigns', id);

describe('frequency counters', () => {
  it('a perCampaign cap counts displays on frequency_state and survives the hourly expiry while the campaign runs', async () => {
    const c = await liveCampaign(k, { name: 'Twice per visitor', frequencyCap: { perCampaign: 2 }, endsAt: new Date(k.clock.now().getTime() + 90 * DAY).toISOString() });
    for (const s of ['s-1', 's-2']) {
      const d = await serve(k, { visitorId: 'v-total', sessionId: s });
      expect(d.overlay?.campaignId).toBe(c.id);
      // TrackEvent.at is optional (the server keeps its own time)
      const res = await k.call('POST', `${STORE}/events`, callers.visitor(), { events: [{ impressionToken: d.overlay!.impressionToken, kind: 'display' }] });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
    }
    const rows = await k.svc.core.repo.find('frequency_state', { campaign_id: c.id });
    expect(rows.map((r) => r.total_displays)).toEqual(rows.map(() => 2));
    expect(rows.every((r) => r.display_day && r.day_displays === 2)).toBe(true);
    expect((await serve(k, { visitorId: 'v-total', sessionId: 's-3' })).overlay?.campaignId).not.toBe(c.id);

    // a month later the stale-row sweep keeps the counters of a running campaign with a total cap
    k.clock.advance(35 * DAY);
    try {
      await k.job('advertising.expire-frequency-state');
    } finally {
      k.clock.advance(-35 * DAY);
    }
    expect(await k.svc.core.repo.find('frequency_state', { campaign_id: c.id })).toHaveLength(rows.length);
    expect((await serve(k, { visitorId: 'v-total', sessionId: 's-4' })).overlay?.campaignId).not.toBe(c.id);
    await k.call('POST', `${ADMIN}/campaigns/${c.id}/finish`, k.staff, { reason: 'Test done' });
  });
});

describe('frequency counters under concurrency', () => {
  it('parallel displays and dismissals of one visitor and campaign are all counted (atomic updates, first row included)', async () => {
    const campaignId = newId();
    const now = k.clock.now();
    const day = { day: k.svc.core.today(now), start: k.svc.core.dayStart(k.svc.core.today(now)) };
    await Promise.all(Array.from({ length: 12 }, () => k.svc.core.repo.recordDisplay(['v-par', 'v-par-2'], campaignId, 's-par', now, 7, day)));
    const rows = await k.svc.core.repo.find('frequency_state', { campaign_id: campaignId });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ total_displays: 12, day_displays: 12, session_displays: 12, window_displays: 12, display_day: day.day });

    const until = new Date(now.getTime() + DAY);
    await Promise.all([k.svc.core.repo.recordDismissal(['v-par'], campaignId, 's-other', until, now), k.svc.core.repo.recordDismissal(['v-par'], campaignId, 's-other', new Date(now.getTime() + 2 * DAY), now)]);
    const [after] = await k.svc.core.repo.find('frequency_state', { campaign_id: campaignId, visitor_key: 'v-par' });
    expect(after).toMatchObject({ session_id: 's-other', session_displays: 0, total_displays: 12, suppressed_until: new Date(now.getTime() + 2 * DAY) });
  });
});

describe('pause and reject columns', () => {
  it('keeps who paused, when and the automatic cause; resume clears them', async () => {
    const c = await liveCampaign(k, { name: 'Pause facts' });
    const paused = await k.call('POST', `${ADMIN}/campaigns/${c.id}/pause`, k.staff, { reason: 'Copy check' });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body).toMatchObject({ status: 'paused', pausedReason: 'Copy check', pausedBy: { kind: 'staff' }, pauseCause: null });
    expect(await row(c.id)).toMatchObject({ paused_by: expect.stringMatching(/^staff/), paused_at: expect.any(Date), pause_cause: null });
    await k.call('POST', `${ADMIN}/campaigns/${c.id}/resume`, k.staff, {});
    expect(await row(c.id)).toMatchObject({ status: 'live', paused_by: null, paused_at: null, pause_cause: null, paused_reason: null });

    // automatic pause with a cause; the matching resume reads pause_cause
    await k.svc.ops.autoPause([(await row(c.id))!], 'promotion', 'Linked promotion paused');
    const auto = (await k.call('GET', `${ADMIN}/campaigns/${c.id}`, k.staff)).body;
    expect(auto).toMatchObject({ status: 'paused', pauseCause: 'promotion', pausedBy: { kind: 'system' } });
    expect(await k.svc.ops.autoResume([(await row(c.id))!], ['stock'])).toBe(0);
    expect(await k.svc.ops.autoResume([(await row(c.id))!], ['promotion'])).toBe(1);
    expect((await row(c.id))!.status).toBe('live');
    await k.call('POST', `${ADMIN}/campaigns/${c.id}/finish`, k.staff, { reason: 'Test done' });
  });

  it('keeps the rejection reason in rejected_reason (AdCampaign.rejectedReason)', async () => {
    const creatives = await openingCreatives(k);
    const created = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k, { name: 'To reject', creativeIds: creatives.map((c: any) => c.id) }));
    const id = created.body.id as string;
    await k.call('POST', `${ADMIN}/campaigns/${id}/submit`, k.staff, {});
    const res = await k.call('POST', `${ADMIN}/campaigns/${id}/reject`, k.staff, { reason: 'Claims not backed by the promotion' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', rejectedReason: 'Claims not backed by the promotion', pausedReason: null });
    expect(await row(id)).toMatchObject({ rejected_reason: 'Claims not backed by the promotion', paused_reason: null });
  });
});

describe('page types are plain strings', () => {
  it('adPositionsFor, isAdBlockedPage and sponsoredForResults take the page type itself', async () => {
    expect(await k.svc.isAdBlockedPage('checkout')).toBe(true);
    expect(await k.svc.isAdBlockedPage('home')).toBe(false);
    expect(await k.svc.adPositionsFor('checkout')).toEqual([]);
    expect(await k.svc.sponsoredForResults({ page: 'checkout', visitorId: 'v', sessionId: 's', device: 'web', organicOfferIds: [], personalizationAllowed: false })).toEqual([]);
  });
});
