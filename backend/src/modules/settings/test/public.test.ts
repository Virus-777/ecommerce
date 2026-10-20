import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, callers } from '../../../testing/app.js';
import { draft, harness, inDays, inMinutes, staff, submit, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.clock.set(new Date());
  h.events.length = 0;
  h.audits.length = 0;
});

const visitor = () => auth(callers.visitor());
const appConfig = (query = '', headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url: `/api/public/settings/app-config${query}`, headers: { ...visitor(), ...headers } });

/** Applies one change at once (no approval, no notice) */
async function applyNow(key: string, value: unknown) {
  const c = (await draft(h, { items: [{ key, value }], effectiveAt: inMinutes(h, 0) })).json();
  const res = await submit(h, c.id);
  expect(res.json().status, res.body).toBe('applied');
}

describe('app-config', () => {
  it('answers the market, support, checkout, flags, android and maintenance in one response with an ETag', async () => {
    const res = await appConfig('?appVersionCode=1&platform=android');
    expect(res.statusCode, res.body).toBe(200);
    const cfg = res.json();
    expect(cfg).toMatchObject({
      market: {
        country: 'US',
        currency: 'USD',
        timeZone: 'America/Los_Angeles',
        locale: 'en-US',
        serviceRegionLabel: 'United States, 48 contiguous states',
        legalName: 'Marketly, Inc.',
        companyLine: 'Marketly, Inc. · Portland, OR',
      },
      support: { hoursLabel: 'Mon–Sat, 8 AM–8 PM PT', phone: expect.any(String), openNow: expect.any(Boolean), closedLabel: 'Closed Sundays and US holidays' },
      checkout: { guestCheckoutEnabled: true, offerAccountAfterGuestPurchase: true },
      features: { wishlist: false, paidSellerAds: false, externalSignIn: false },
      android: { minVersionCode: 1, latestVersionCode: 1, updateRequired: false, updateSuggested: false },
      maintenance: { active: false },
    });
    expect(res.headers.etag).toBe(`"${cfg.configVersion}"`);
    const cached = await appConfig('', { 'if-none-match': `"${cfg.configVersion}"` });
    expect(cached.statusCode).toBe(304);
  });

  it('changes configVersion with a value, asks old apps to update and shows a maintenance notice', async () => {
    const before = (await appConfig()).json().configVersion;
    await applyNow('apps.android.latestVersionCode', 12);
    await applyNow('apps.android.minVersionCode', 10);
    const cfg = (await appConfig('?appVersionCode=9')).json();
    expect(cfg.configVersion).not.toBe(before);
    expect(cfg.android).toMatchObject({ minVersionCode: 10, latestVersionCode: 12, updateRequired: true, updateSuggested: true });
    expect((await appConfig('?appVersionCode=11')).json().android).toMatchObject({ updateRequired: false, updateSuggested: true });

    // the minimum can never pass the latest version
    const bad = (await draft(h, { items: [{ key: 'apps.android.minVersionCode', value: 13 }], effectiveAt: inMinutes(h, 0) })).json();
    expect(bad.impact.blocking).toContain('The minimum Android version code cannot be above the latest one');

    const until = inDays(h, 1);
    await applyNow('apps.maintenance', { active: true, kind: 'incident', message: 'Card payments are slow', until });
    const m = (await appConfig()).json().maintenance;
    expect(m).toMatchObject({ active: true, kind: 'incident', message: 'Card payments are slow', until, updatedAt: expect.any(String) });
    const store = await h.api.storeInfo();
    expect(store.maintenance).toMatchObject({ kind: 'incident' });
    h.clock.advance(25 * 3600_000);
    expect((await h.api.storeInfo()).maintenance).toBeNull(); // past its until
  });
});

describe('feature flags', () => {
  it('lists flags and switches one, immediately, with an event and an audit entry', async () => {
    const list = (await h.app.inject({ method: 'GET', url: '/api/admin/settings/feature-flags', headers: staff() })).json() as any[];
    expect(list.find((f) => f.key === 'wishlist')).toMatchObject({ module: 'wishlist', enabled: false, plannedPhase: 3, public: true });

    const res = await h.app.inject({ method: 'PUT', url: '/api/admin/settings/feature-flags/externalSignIn', headers: staff(), payload: { enabled: true, reason: 'Google sign-in ready' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ key: 'externalSignIn', enabled: true, rollout: 'everyone', updatedBy: { kind: 'staff' }, updatedAt: expect.any(String) });
    await h.app.kernel.events.drain();
    expect(h.events).toEqual([{ name: 'settings.feature_flag.changed', payload: expect.objectContaining({ key: 'externalSignIn', enabled: true, rollout: 'everyone' }) }]);
    expect(h.audits[0]).toMatchObject({ action: 'settings.feature_flag.set', reason: 'Google sign-in ready', target: { type: 'feature_flag', id: 'externalSignIn' } });
    expect(await h.api.isEnabled('externalSignIn')).toBe(true);
    expect((await appConfig()).json().features.externalSignIn).toBe(true);
    expect((await h.api.storeInfo()).features).toEqual(expect.arrayContaining([{ key: 'externalSignIn', enabled: true }]));
  });

  it('a flag of a disabled module stays off; rollouts narrow who sees it', async () => {
    await h.app.inject({ method: 'PUT', url: '/api/admin/settings/feature-flags/wishlist', headers: staff(), payload: { enabled: true, reason: 'try' } });
    expect(await h.api.isEnabled('wishlist')).toBe(false); // wishlist is not running in this app

    const staffOnly = await h.app.inject({ method: 'PUT', url: '/api/admin/settings/feature-flags/bundleDeals', headers: staff(), payload: { enabled: true, rollout: 'staff_only', reason: 'internal test' } });
    expect(staffOnly.statusCode).toBe(200);
    expect(await h.api.isEnabled('bundleDeals')).toBe(false);
    expect(await h.api.isEnabled('bundleDeals', { realm: 'staff' })).toBe(true);

    const noPct = await h.app.inject({ method: 'PUT', url: '/api/admin/settings/feature-flags/bundleDeals', headers: staff(), payload: { enabled: true, rollout: 'percentage', reason: 'x' } });
    expect(noPct.json().error.code).toBe('VALIDATION_FAILED');
    await h.app.inject({ method: 'PUT', url: '/api/admin/settings/feature-flags/bundleDeals', headers: staff(), payload: { enabled: true, rollout: 'percentage', percentage: 50, reason: 'half' } });
    const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`);
    const on = (await Promise.all(ids.map((accountId) => h.api.isEnabled('bundleDeals', { accountId })))).filter(Boolean).length;
    expect(on).toBeGreaterThan(60);
    expect(on).toBeLessThan(140);
    expect(await h.api.isEnabled('bundleDeals', { accountId: ids[0] })).toBe(await h.api.isEnabled('bundleDeals', { accountId: ids[0] }));

    const unknown = await h.app.inject({ method: 'PUT', url: '/api/admin/settings/feature-flags/nope', headers: staff(), payload: { enabled: true, reason: 'x' } });
    expect(unknown.statusCode).toBe(404);
    expect(await h.api.isEnabled('nope')).toBe(false);
  });
});

describe('market and business calendar', () => {
  it('market() returns the market with labels', async () => {
    const m = await h.api.market();
    expect(m).toMatchObject({ country: 'US', currency: 'USD', timeZone: 'America/Los_Angeles', businessHoursLabel: 'Mon–Sat, 8:00 AM – 8:00 PM PT', serviceRegion: { code: 'US-48' } });
    expect(m.businessHours).toHaveLength(6);
    expect(m.support.closedLabel).toBe('Closed Sundays and US holidays');
    expect(m).toMatchObject({ legalName: 'Marketly, Inc.', companyLine: 'Marketly, Inc. · Portland, OR' });
  });

  it('GET /business-calendar gives open hours per day minus closures', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/admin/settings/business-calendar?from=2026-11-25&to=2026-11-29', headers: staff() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([
      { date: '2026-11-25', open: true, opensAt: '2026-11-25T16:00:00.000Z', closesAt: '2026-11-26T04:00:00.000Z', label: null },
      { date: '2026-11-26', open: false, opensAt: null, closesAt: null, label: 'Thanksgiving' },
      { date: '2026-11-27', open: true, opensAt: '2026-11-27T16:00:00.000Z', closesAt: '2026-11-28T04:00:00.000Z', label: null },
      { date: '2026-11-28', open: true, opensAt: '2026-11-28T16:00:00.000Z', closesAt: '2026-11-29T04:00:00.000Z', label: null },
      { date: '2026-11-29', open: false, opensAt: null, closesAt: null, label: null },
    ]);
    const tooLong = await h.app.inject({ method: 'GET', url: '/api/admin/settings/business-calendar?from=2026-01-01&to=2027-06-01', headers: staff() });
    expect(tooLong.statusCode).toBe(400);
  });

  it('businessCalendar() does business-hour arithmetic for deadlines', async () => {
    const cal = await h.api.businessCalendar();
    // PST (UTC-8): Wednesday Nov 25 is open 8 AM–8 PM, Thursday is Thanksgiving, Friday opens 8 AM
    expect(cal.isOpen('2026-11-26T02:00:00.000Z')).toBe(true); // Wed 18:00 PT
    expect(cal.isOpen('2026-11-26T05:00:00.000Z')).toBe(false); // Wed 21:00 PT
    expect(cal.isOpen('2026-11-26T20:00:00.000Z')).toBe(false); // Thanksgiving noon
    expect(cal.addBusinessMinutes('2026-11-26T03:00:00.000Z', 120)).toBe('2026-11-27T17:00:00.000Z'); // Wed 19:00 + 2h → Fri 09:00 PT
    expect(cal.nextOpen('2026-11-29T20:00:00.000Z')).toBe('2026-11-30T16:00:00.000Z'); // Sunday → Monday 8 AM PT
    expect(cal.nextOpen('2026-11-30T17:00:00.000Z')).toBe('2026-11-30T17:00:00.000Z'); // open now
  });

  it('businessCalendar() counts whole business days and tells business days apart', async () => {
    const cal = await h.api.businessCalendar();
    expect(cal.isBusinessDay('2026-11-25')).toBe(true);
    expect(cal.isBusinessDay('2026-11-26')).toBe(false); // Thanksgiving
    expect(cal.isBusinessDay('2026-11-29')).toBe(false); // Sunday
    expect(() => cal.isBusinessDay('nope')).toThrow();
    expect(cal.addBusinessDays('2026-11-25T18:00:00.000Z', 1)).toBe('2026-11-27T18:00:00.000Z'); // Wed 10:00 PT + 1 → Fri 10:00 (Thanksgiving skipped)
    expect(cal.addBusinessDays('2026-11-28T18:00:00.000Z', 1)).toBe('2026-11-30T18:00:00.000Z'); // Sat + 1 → Mon (Sunday closed)
    expect(cal.addBusinessDays('2026-11-25T18:00:00.000Z', 3)).toBe('2026-11-30T18:00:00.000Z'); // Wed + 3 → Fri, Sat, Mon
    expect(cal.addBusinessDays('2026-11-29T20:00:00.000Z', 1)).toBe('2026-12-01T20:00:00.000Z'); // from Sunday: counts from Monday → Tue 12:00 PT
    expect(cal.addBusinessDays('2026-11-26T05:00:00.000Z', 1)).toBe('2026-11-28T04:00:00.000Z'); // Wed 21:00 PT + 1 → Fri, which closes at 20:00
    expect(cal.addBusinessDays('2026-11-25T18:00:00.000Z', 0)).toBe('2026-11-25T18:00:00.000Z');
  });
});

describe('overview and sections', () => {
  it('assembles settings-owned sections, module sections and all scheduled changes', async () => {
    await h.api.registerSection({
      key: 'returns_baseline',
      order: 100,
      load: () => ({
        key: 'returns_baseline',
        title: 'Returns baseline',
        ownerModule: 'returns',
        ownedHere: false,
        values: [{ key: null, label: 'Return window', valueText: '30 days', exampleValue: true }],
        lastChange: null,
        scheduled: [
          {
            source: 'module',
            module: 'returns',
            ref: 'RP-0004',
            title: 'Electronics return window changes from 30 to 15 days',
            effectiveAt: inDays(h, 20),
            appliesTo: 'Orders placed before then keep 30 days',
            status: 'scheduled',
            sellerVisible: true,
          },
        ],
        link: { module: 'returns', area: 'admin', path: '/api/admin/returns/policies' },
        available: true,
      }),
    });
    const c = (await draft(h, { items: [{ key: 'support.maxAttachmentMb', value: 15 }], effectiveAt: inDays(h, 3) })).json();
    await submit(h, c.id);

    const res = await h.app.inject({ method: 'GET', url: '/api/admin/settings/overview', headers: staff() });
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json();
    expect(o.market.country).toBe('US');
    const keys = o.sections.map((s: any) => s.key);
    expect(keys.slice(0, 4)).toEqual(['market', 'support_hours', 'checkout', 'apps']);
    expect(keys).toEqual(expect.arrayContaining(['returns_baseline', 'fees', 'support', 'catalog']));
    const market = o.sections.find((s: any) => s.key === 'market');
    expect(market.values.find((v: any) => v.key === 'market.currency')).toMatchObject({ valueText: 'USD', hint: 'Read-only' });
    // the time zone too: the server configuration's, the one every module reads
    expect(market.values.find((v: any) => v.key === 'market.timeZone')).toMatchObject({ valueText: h.app.kernel.config.market.timeZone, hint: 'Read-only' });
    expect(o.market.timeZone).toBe(h.app.kernel.config.market.timeZone);
    const returns = o.sections.find((s: any) => s.key === 'returns_baseline');
    expect(returns).toMatchObject({ ownedHere: false, link: { path: '/api/admin/returns/policies' } });
    const support = o.sections.find((s: any) => s.key === 'support');
    expect(support.scheduled).toEqual([expect.objectContaining({ ref: c.ref, source: 'settings', status: 'scheduled' })]);
    expect(support.values.find((v: any) => v.key === 'support.maxAttachmentMb').hint).toMatch(/^Changes to 15 MB on/);
    expect(o.scheduled.map((s: any) => s.ref)).toEqual(expect.arrayContaining([c.ref, 'RP-0004']));

    const upcoming = await h.app.inject({ method: 'GET', url: '/api/seller/settings/upcoming-changes', headers: auth(callers.seller()) });
    expect(upcoming.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ ref: 'RP-0004', module: 'returns' })]));
    expect(upcoming.json().items.map((x: any) => x.ref)).not.toContain(c.ref); // support settings are not seller-visible
  });
});

describe('GraphQL', () => {
  it('storeInfo answers anyone', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/graphql/store',
      headers: visitor(),
      payload: { query: '{ storeInfo { market { country currency legalName companyLine } support { phone openNow hoursLabel } closures { date kind } guestCheckoutEnabled features { key enabled } configVersion } }' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.storeInfo).toMatchObject({ market: { country: 'US', currency: 'USD', legalName: expect.any(String), companyLine: expect.any(String) }, guestCheckoutEnabled: true, configVersion: expect.any(String) });
  });

  it('upcomingChanges answers sellers', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/graphql/seller', headers: auth(callers.seller()), payload: { query: '{ upcomingChanges { ref title effectiveAt postedAt } }' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().errors).toBeUndefined();
    expect(Array.isArray(res.json().data.upcomingChanges)).toBe(true);
  });
});

describe('get()', () => {
  it("reads any enabled module's declared setting by its full key, falling back to the default", async () => {
    expect(await h.api.get('catalog.maxImagesPerProduct')).toBe(12);
    expect(await h.api.get('market.legalName')).toBe('Marketly, Inc.');
    expect(await h.api.get('settings.appConfigCacheSeconds')).toEqual(expect.any(Number));
  });

  it('refuses unknown keys and keys of disabled modules with UNKNOWN_SETTING', async () => {
    await expect(h.api.get('nope.nothing')).rejects.toMatchObject({ code: 'UNKNOWN_SETTING' });
    await expect(h.api.get('catalog.noSuchSetting')).rejects.toMatchObject({ code: 'UNKNOWN_SETTING' });
    // wallet is not running in this app
    await expect(h.api.get('wallet.goodwillMaxPerCustomer30Days')).rejects.toMatchObject({ code: 'UNKNOWN_SETTING' });
  });
});
