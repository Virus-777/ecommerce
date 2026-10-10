/**
 * Gap pass 4: pause and reject facts as columns (paused_by, paused_at, pause_cause, rejected_reason), the promoted
 * product on campaign_items (product_id instead of synthetic offer_product rows), frequency counters for the day and
 * the campaign total on frequency_state, TrackEvent.at optional, page types as plain strings, and migration 0004.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { m0004PauseItemsFrequency } from '../infra/postgres/migrations/0004_pause_items_frequency.js';
import { ADMIN, boot, campaignInput, liveCampaign, openingCreatives, serve, STORE, track, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

const DAY = 86_400_000;
const row = (id: string) => k.svc.core.repo.get('campaigns', id);
const exec = (sql: string) => k.app.kernel.database.exec(sql);

describe('frequency counters', () => {
  it('a perCampaign cap counts displays on frequency_state and survives the hourly expiry while the campaign runs', async () => {
    const c = await liveCampaign(k, { name: 'Twice per visitor', frequencyCap: { perCampaign: 2, label: '' }, endsAt: new Date(k.clock.now().getTime() + 90 * DAY).toISOString() });
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

describe('migration 0004', () => {
  it('fills the pause and reject columns from the log, product_id from offer_product rows and total_displays from ad_events', async () => {
    const c = await liveCampaign(k, { name: 'Migrated', frequencyCap: { perCampaign: 5, label: '' } });
    const d = await serve(k, { visitorId: 'v-mig', sessionId: 's-mig' });
    expect(d.overlay?.campaignId).toBe(c.id);
    await track(k, [{ impressionToken: d.overlay!.impressionToken, kind: 'display' }]);
    await k.call('POST', `${ADMIN}/campaigns/${c.id}/pause`, k.staff, { reason: 'Hold' });
    const rejectedRow = (await k.svc.core.repo.find('campaigns', { status: 'rejected' }))[0]!;
    const offerId = newId();
    const productId = newId();

    // the state before 0004: no columns; rejection text in paused_reason; a synthetic offer_product row
    await exec(`update advertising.campaigns set paused_reason = rejected_reason where id = '${rejectedRow.id}';
      alter table advertising.campaigns drop column paused_by, drop column paused_at, drop column pause_cause, drop column rejected_reason;
      alter table advertising.campaign_items drop constraint if exists campaign_items_kind_check;
      alter table advertising.campaign_items drop column product_id;
      insert into advertising.campaign_items (campaign_id, kind, target_id, label) values ('${c.id}', 'offer', '${offerId}', 'Lamp'), ('${c.id}', 'offer_product', '${productId}', '${offerId}');
      alter table advertising.frequency_state drop column display_day, drop column day_displays, drop column total_displays;`);
    await exec(m0004PauseItemsFrequency.sql);

    expect(await row(c.id)).toMatchObject({ status: 'paused', paused_by: expect.stringMatching(/^staff/), paused_at: expect.any(Date), pause_cause: null, paused_reason: 'Hold' });
    expect(await row(rejectedRow.id)).toMatchObject({ rejected_reason: rejectedRow.rejected_reason, paused_reason: null });
    const items = await k.svc.core.repo.find('campaign_items', { campaign_id: c.id });
    expect(items.find((i) => i.target_id === offerId)).toMatchObject({ kind: 'offer', product_id: productId });
    expect(items.some((i) => (i.kind as string) === 'offer_product')).toBe(false);
    const freq = await k.svc.core.repo.find('frequency_state', { campaign_id: c.id });
    expect(Math.max(...freq.map((f) => f.total_displays))).toBe(1);
    expect(freq.every((f) => f.display_day === null)).toBe(true);
  });
});
