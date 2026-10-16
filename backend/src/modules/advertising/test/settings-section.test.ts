/**
 * G76: the Advertising rules section of the Admin Center settings page: rules in force, the opening ad
 * frequency and a rules version waiting for approval.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as settings from '../../../spec/settings.js';
import { advertisingSettingsSection, registerAdvertisingSettingsSection } from '../service/settings-section.js';
import { ADMIN, boot, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

describe('settings section (G76)', () => {
  it('shows the rules in force and a proposed version', async () => {
    const proposed = await k.call('PUT', `${ADMIN}/rules`, k.staff, { overlaysPerPageView: 2, reason: 'Allow a pop-up next to the banner' });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(202); // waits for the Business Owner

    const s = await advertisingSettingsSection(k.svc.core, k.svc.setup);
    expect(s).toMatchObject({ key: 'advertising_rules', ownerModule: 'advertising', ownedHere: false, link: { path: '/api/admin/advertising/rules' } });
    const byLabel = new Map(s.values.map((v) => [v.label, v]));
    expect(byLabel.get('Overlays per page view')).toMatchObject({ valueText: '1 at most', value: 1 });
    expect(byLabel.get('"Sponsored" or "Ad" label on every paid placement')).toMatchObject({ valueText: 'Always on' });
    expect(byLabel.get('Pages where ads never show')!.valueText).toMatch(/checkout/i);
    expect(byLabel.has('Opening ad frequency')).toBe(true);
    const next = s.scheduled.find((c) => c.title === 'Overlays per page view change from 1 to 2');
    expect(next).toMatchObject({ source: 'module', module: 'advertising', sellerVisible: false });
    expect(next!.status).toBe('pending_approval');

    const got: Parameters<settings.SettingsPublicApi['registerSection']>[0][] = [];
    await registerAdvertisingSettingsSection({ registerSection: async (p) => void got.push(p) }, k.svc.core, k.svc.setup);
    expect(got.map((p) => [p.key, p.order])).toEqual([['advertising_rules', 140]]);
  });
});
