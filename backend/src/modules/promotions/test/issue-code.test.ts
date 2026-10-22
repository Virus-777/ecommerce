/**
 * issueCode (Daily rewards redemptions, 2026-10-22): one customer's own single-use code of a coupon campaign that is
 * scheduled or running, the same code for the same key, shown in that customer's coupons and usable only by them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { ADMIN, boot, campaignInput, HOME, liveCampaign, STORE, USD, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(() => k?.close());

describe('issueCode', () => {
  it('gives the customer a unique single-use code, the same one for the same key, in their coupons only', async () => {
    const camp = await liveCampaign(k, campaignInput(k.clock, { name: 'Daily rewards: $5 off', description: '$5 off orders over $50', discount: { kind: 'fixed_coupon', amountOff: USD(500), minSpend: USD(5000) }, scope: { mode: 'sitewide', include: [], exclude: [] } }));
    const customerId = newId();
    const key = newId();
    const issued = await k.svc.issueCode(camp.id, customerId, key);
    expect(issued).toMatchObject({ campaignId: camp.id, title: '$5 off orders over $50', endsAt: camp.period.endsAt });
    expect(issued.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(await k.svc.issueCode(camp.id, customerId, key)).toEqual(issued);

    const other = await k.svc.issueCode(camp.id, customerId, newId());
    expect(other.code).not.toBe(issued.code);

    const codes = await k.call('GET', `${ADMIN}/campaigns/${camp.id}/codes`, k.staff);
    const row = codes.body.items.find((c: any) => c.id === issued.codeId);
    expect(row).toMatchObject({ code: issued.code, kind: 'unique', maxRedemptions: 1, redemptions: 0, assignedCustomerId: customerId, active: true });

    const mine = await k.svc.couponsForCustomer(customerId);
    expect(mine.available.find((c) => c.campaignId === camp.id)).toMatchObject({ code: expect.any(String), state: 'available' });
    expect((await k.svc.couponsForCustomer(newId())).available.find((c) => c.campaignId === camp.id)).toBeUndefined();

    // only that customer can use it
    const mineCheck = await k.call('POST', `${STORE}/codes/check`, callers.customer({ accountId: customerId }), { code: issued.code });
    expect(mineCheck.body.valid).toBe(true);
    const theirs = await k.call('POST', `${STORE}/codes/check`, callers.customer({ accountId: newId() }), { code: issued.code });
    expect(theirs.body.valid).toBe(false);
  });

  it('works for scheduled coupon campaigns and refuses others with CAMPAIGN_NOT_ACTIVE', async () => {
    const start = new Date(k.clock.now().getTime() + 86_400_000).toISOString();
    const scheduled = await liveCampaign(k, campaignInput(k.clock, { name: 'Later', startsAt: start, scope: { mode: 'categories', include: [{ kind: 'category', id: HOME, label: 'Home' }], exclude: [] } }));
    expect(scheduled.status).toBe('scheduled');
    expect((await k.svc.issueCode(scheduled.id, newId(), newId())).campaignId).toBe(scheduled.id);

    const draft = await k.call('POST', `${ADMIN}/campaigns`, k.staff, campaignInput(k.clock, { name: 'Draft coupon' }));
    await expect(k.svc.issueCode(draft.body.id, newId(), newId())).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_ACTIVE', status: 409 });
    k.offer();
    const markdown = await liveCampaign(k, campaignInput(k.clock, { name: 'Markdown', discount: { kind: 'markdown', percentOffBps: 1000 } }));
    await expect(k.svc.issueCode(markdown.id, newId(), newId())).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_ACTIVE' });
    await expect(k.svc.issueCode(newId(), newId(), newId())).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_ACTIVE' });

    const ended = await liveCampaign(k, campaignInput(k.clock, { name: 'Ending' }));
    expect((await k.call('POST', `${ADMIN}/campaigns/${ended.id}/end`, k.staff, { reason: 'Done' })).status).toBe(200);
    await expect(k.svc.issueCode(ended.id, newId(), newId())).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_ACTIVE' });
  });
});
