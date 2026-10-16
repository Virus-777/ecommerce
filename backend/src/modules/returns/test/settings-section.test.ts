/**
 * G76: the Returns baseline section of the Admin Center settings page: the baseline in force, active category
 * exceptions with their next change, who pays return shipping, and the scheduled exception changes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type * as settings from '../../../spec/settings.js';
import { registerReturnsSettingsSection, returnsSettingsSection } from '../service/settings-section.js';
import { harness, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});
beforeEach(() => {
  h.authority.decision = 'allowed';
});

const day = 86_400_000;

describe('settings section (G76)', () => {
  it('shows the baseline, the exceptions and the scheduled change, linked to the policies endpoint', async () => {
    const categoryId = newId();
    const exception = (windowDays: number, from: Date) => ({
      categoryId,
      windowDays,
      changeOfMindAllowed: true,
      condition: 'Opened items accepted with all accessories',
      faultReturnsWindowDays: 30,
      shownOn: ['product_page', 'checkout'],
      effectiveFrom: from.toISOString(),
      reason: 'Manufacturer terms',
    });
    const now = h.clock.now().getTime();
    const first = await h.call('POST', '/api/admin/returns/category-exceptions', tokens.staff(), exception(45, new Date(now - 60_000)));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const later = await h.call('POST', '/api/admin/returns/category-exceptions', tokens.staff(), exception(60, new Date(now + 20 * day)));
    expect(later.status, JSON.stringify(later.body)).toBe(201);

    const s = await returnsSettingsSection(h.service.policies, h.service.core.tz);
    expect(s).toMatchObject({ key: 'returns_baseline', ownerModule: 'returns', ownedHere: false, available: true, link: { path: '/api/admin/returns/policies' } });
    const byLabel = new Map(s.values.map((v) => [v.label, v]));
    expect(byLabel.get('Standard return window')).toMatchObject({ valueText: '30 days after delivery', value: 30, key: null });
    expect(byLabel.get('Return shipping: Change of mind')).toMatchObject({ valueText: 'Customer pays' });
    const row = s.values.find((v) => v.label.startsWith('Category exception:'));
    expect(row).toMatchObject({ valueText: '45 days · Opened items accepted with all accessories' });
    expect(row!.hint).toMatch(/^60 days from /);
    expect(s.scheduled).toEqual([expect.objectContaining({ source: 'module', module: 'returns', ref: later.body.id, status: 'scheduled', sellerVisible: true })]);
    expect(s.scheduled[0]!.title).toMatch(/return window changes from 45 days to 60 days$/);

    const registered: Parameters<settings.SettingsPublicApi['registerSection']>[0][] = [];
    await registerReturnsSettingsSection({ registerSection: async (p) => void registered.push(p) }, h.service.policies, () => h.service.core.tz);
    expect(registered[0]).toMatchObject({ key: 'returns_baseline', order: 100 });
    expect((await registered[0]!.load()).values.length).toBe(s.values.length);
    await registerReturnsSettingsSection(undefined, h.service.policies, () => 'America/Los_Angeles'); // without settings: nothing
  });
});
