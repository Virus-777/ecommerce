import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { boot, customersTable, PUBLIC, STORE, type Kit } from './helpers.js';

const tokens = new Map<string, { accountId: string; channel: 'email' | 'sms' | 'push' }>();

let kit: Kit;
beforeAll(async () => {
  kit = await boot({
    only: ['notifications'],
    apiStubs: {
      // notifications signs the token; the stub stands in for its verification
      notifications: {
        verifyUnsubscribeToken: async (t: string) => {
          const x = tokens.get(t);
          return x ? { audience: 'customer' as const, accountId: x.accountId, email: 'x@example.com', channel: x.channel, topicGroup: 'promotions' } : null;
        },
      },
    },
  });
});
afterAll(() => kit.app.close());

const visitorToken = () => kit.visitor();

describe('marketing preferences', () => {
  it('changes only the fields sent, logs each change and publishes once', async () => {
    const c = await kit.customer();
    const before = kit.of('customers.marketing_preferences.changed').length;
    const res = await kit.call('PUT', `${STORE}/marketing-preferences`, { token: c.token, body: { smsPromotions: true, recentSearches: false, source: 'app_settings' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ emailPromotions: false, smsPromotions: true, recentSearches: false, personalizedRecommendations: true, essentialAlwaysOn: true });
    expect(kit.of('customers.marketing_preferences.changed').slice(before)).toEqual([
      { customerId: c.customerId, emailPromotions: false, smsPromotions: true, pushPromotions: false, wishlistAlerts: false, personalizedRecommendations: true, recentSearches: false, source: 'app_settings' },
    ]);
    // nothing changes: no event
    await kit.call('PUT', `${STORE}/marketing-preferences`, { token: c.token, body: { smsPromotions: true } });
    expect(kit.of('customers.marketing_preferences.changed').length).toBe(before + 1);
    expect(await kit.service.getMarketingConsent(c.customerId)).toMatchObject({ smsPromotions: true, recentSearches: false });
    const log = await kit.service.core.deps.repo.consentLog(c.customerId);
    expect(log.filter((r: any) => r.source === 'app_settings').map((r: any) => [r.channel, r.granted]).sort()).toEqual([
      ['recent_searches', false],
      ['sms', true],
    ]);
  });

  it('one-click unsubscribe turns the channel off, logged as unsubscribe_link', async () => {
    const c = await kit.customer({ marketingOptIn: true });
    tokens.set('tok-email', { accountId: c.accountId, channel: 'email' });
    const res = await kit.call('POST', `${PUBLIC}/unsubscribe`, { token: callers.visitor(), body: { token: 'tok-email' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.emailPromotions).toBe(false);
    expect(kit.of('customers.marketing_preferences.changed').at(-1)).toMatchObject({ customerId: c.customerId, source: 'unsubscribe_link', emailPromotions: false });

    await kit.call('PUT', `${STORE}/marketing-preferences`, { token: c.token, body: { emailPromotions: true, pushPromotions: true } });
    const all = await kit.call('POST', `${PUBLIC}/unsubscribe`, { token: callers.visitor(), body: { token: 'tok-email', channel: 'all' } });
    expect(all.body).toMatchObject({ emailPromotions: false, pushPromotions: false, smsPromotions: false, wishlistAlerts: false });

    const bad = await kit.call('POST', `${PUBLIC}/unsubscribe`, { token: callers.visitor(), body: { token: 'forged' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('UNSUBSCRIBE_TOKEN_INVALID');
  });
});

describe('recently viewed', () => {
  it('records views for visitors, newest first, upserting one row per product', async () => {
    const v = visitorToken();
    const [p1, p2] = [newId(), newId()];
    for (const p of [p1, p2, p1]) {
      const r = await kit.call('POST', `${STORE}/recently-viewed`, { token: v.token, body: { productId: p } });
      expect(r.status).toBe(204);
      kit.clock.advance(1000);
    }
    const list = (await kit.call('GET', `${STORE}/recently-viewed`, { token: v.token })).body;
    expect(list.map((x: any) => x.productId)).toEqual([p1, p2]);
    expect(list[0]).toMatchObject({ available: true, price: null });
    expect(await kit.service.listRecentlyViewed({ guestSessionId: v.sid }, 1)).toEqual([p1]);

    expect((await kit.call('DELETE', `${STORE}/recently-viewed/${p1}`, { token: v.token })).status).toBe(204);
    expect((await kit.call('GET', `${STORE}/recently-viewed`, { token: v.token })).body.map((x: any) => x.productId)).toEqual([p2]);
    expect((await kit.call('DELETE', `${STORE}/recently-viewed`, { token: v.token })).status).toBe(204);
    expect((await kit.call('GET', `${STORE}/recently-viewed`, { token: v.token })).body).toEqual([]);
  });

  it('keeps recentlyViewedRetained per owner and honours the limit', async () => {
    const v = visitorToken();
    for (let i = 0; i < 52; i++) {
      await kit.call('POST', `${STORE}/recently-viewed`, { token: v.token, body: { productId: newId() } });
      kit.clock.advance(10);
    }
    expect(await kit.service.listRecentlyViewed({ guestSessionId: v.sid }, 500)).toHaveLength(50);
    // the two oldest are deleted, not merely hidden: a read is clamped to retained, so only the rows say so
    expect(await customersTable(kit.app, 'recently_viewed').count({ owner_kind: 'guest', owner_id: v.sid })).toBe(50);
    expect((await kit.call('GET', `${STORE}/recently-viewed`, { token: v.token })).body).toHaveLength(12);
    expect((await kit.call('GET', `${STORE}/recently-viewed?limit=3`, { token: v.token })).body).toHaveLength(3);
  });

  it('is not recorded for customers who turned personalised recommendations off', async () => {
    const c = await kit.customer();
    await kit.call('POST', `${STORE}/recently-viewed`, { token: c.token, body: { productId: newId() } });
    await kit.call('PUT', `${STORE}/marketing-preferences`, { token: c.token, body: { personalizedRecommendations: false } });
    await kit.call('POST', `${STORE}/recently-viewed`, { token: c.token, body: { productId: newId() } });
    expect((await kit.call('GET', `${STORE}/recently-viewed`, { token: c.token })).body).toHaveLength(1);
  });

  it('merges the guest list into the account when identity claims the session (newest view wins)', async () => {
    const c = await kit.customer();
    const v = visitorToken();
    const [shared, guestOnly, mine] = [newId(), newId(), newId()];
    await kit.call('POST', `${STORE}/recently-viewed`, { token: c.token, body: { productId: shared } });
    kit.clock.advance(1000);
    await kit.call('POST', `${STORE}/recently-viewed`, { token: c.token, body: { productId: mine } });
    kit.clock.advance(1000);
    await kit.call('POST', `${STORE}/recently-viewed`, { token: v.token, body: { productId: guestOnly } });
    kit.clock.advance(1000);
    await kit.call('POST', `${STORE}/recently-viewed`, { token: v.token, body: { productId: shared } });
    await kit.publish('identity', 'identity.guest_session.claimed', { guestSessionId: v.sid, accountId: c.accountId });
    expect(await kit.service.listRecentlyViewed({ customerId: c.customerId }, 10)).toEqual([shared, guestOnly, mine]);
    expect(await kit.service.listRecentlyViewed({ guestSessionId: v.sid }, 10)).toEqual([]);
  });

  it('repoints rows when catalog merges a duplicate product', async () => {
    const v = visitorToken();
    const w = visitorToken();
    const [kept, dup] = [newId(), newId()];
    await kit.call('POST', `${STORE}/recently-viewed`, { token: v.token, body: { productId: dup } });
    await kit.call('POST', `${STORE}/recently-viewed`, { token: w.token, body: { productId: kept } });
    kit.clock.advance(1000);
    await kit.call('POST', `${STORE}/recently-viewed`, { token: w.token, body: { productId: dup } });
    await kit.publish('catalog', 'catalog.product.merged', { keptProductId: kept, duplicateProductId: dup, reason: 'duplicate' });
    expect(await kit.service.listRecentlyViewed({ guestSessionId: v.sid }, 10)).toEqual([kept]);
    expect(await kit.service.listRecentlyViewed({ guestSessionId: w.sid }, 10)).toEqual([kept]);
  });

  it('the prune job deletes old views and guest views of expired sessions', async () => {
    const v = visitorToken();
    const c = await kit.customer();
    await kit.call('POST', `${STORE}/recently-viewed`, { token: v.token, body: { productId: newId() } });
    await kit.call('POST', `${STORE}/recently-viewed`, { token: c.token, body: { productId: newId() } });
    kit.clock.advance(31 * 86_400_000);
    await kit.app.kernel.jobs.runNow('customers.prune-recently-viewed');
    expect(await kit.service.listRecentlyViewed({ guestSessionId: v.sid }, 10)).toEqual([]);
    expect(await kit.service.listRecentlyViewed({ customerId: c.customerId }, 10)).toHaveLength(1);
    kit.clock.advance(60 * 86_400_000);
    await kit.app.kernel.jobs.runNow('customers.prune-recently-viewed');
    expect(await kit.service.listRecentlyViewed({ customerId: c.customerId }, 10)).toEqual([]);
  });
});
