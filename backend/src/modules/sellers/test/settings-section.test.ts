/**
 * G76: the Seller performance targets section of the Admin Center settings page: targets in force and a
 * target saved for a later date.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as settings from '../../../spec/settings.js';
import { registerSellersSettingsSection, sellersSettingsSection } from '../service/settings-section.js';
import { ADMIN, boot, staff, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => kit?.close());

describe('settings section (G76)', () => {
  it('shows every metric target in force and a later change', async () => {
    const today = kit.svc.core.today();
    const later = new Date(Date.parse(`${today}T12:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10);
    const t = { metric: 'cancellation_rate', comparator: 'lte', threshold: 2, unit: 'percent', windowDays: 30, display: 'At most 2%', isExample: false, effectiveFrom: later };
    const ok = await kit.call('PUT', `${ADMIN}/performance-targets`, staff(), { targets: [t], reason: 'Tighter cancellations target' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const s = await sellersSettingsSection(kit.svc.performance, today);
    expect(s).toMatchObject({ key: 'seller_targets', ownerModule: 'sellers', ownedHere: false, link: { path: '/api/admin/sellers/performance-targets' } });
    expect(s.values.length).toBeGreaterThanOrEqual(7); // one per metric
    const cancel = s.values.find((v) => v.hint?.startsWith('At most 2% over 30 days from '));
    expect(cancel).toBeTruthy();
    expect(s.scheduled).toEqual([expect.objectContaining({ source: 'module', module: 'sellers', status: 'scheduled', effectiveAt: `${later}T00:00:00.000Z` })]);
    expect(s.scheduled[0]!.title).toMatch(/target changes from .* to At most 2%$/);

    const got: Parameters<settings.SettingsPublicApi['registerSection']>[0][] = [];
    await registerSellersSettingsSection({ registerSection: async (p) => void got.push(p) }, kit.svc.performance, () => today);
    expect(got.map((p) => [p.key, p.order])).toEqual([['seller_targets', 150]]);
  });
});
