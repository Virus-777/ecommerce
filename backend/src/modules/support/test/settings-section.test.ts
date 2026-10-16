/**
 * G76: the Support targets section of the Admin Center settings page, end to end with the real settings,
 * returns and finance modules: the overview no longer says "Not reported by its module yet" for them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { supportSettingsSection } from '../service/settings-section.js';
import { harness, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

describe('settings section (G76)', () => {
  it('shows support targets by their setting keys and the category targets', async () => {
    const s = await supportSettingsSection(h.service.core);
    expect(s).toMatchObject({ key: 'support_sla', ownerModule: 'support', ownedHere: false, link: { path: '/api/admin/support/categories' } });
    expect(s.values.find((v) => v.key === 'support.firstResponseBusinessHours')).toMatchObject({ valueText: '4 business hours', value: 4 });
    expect(s.values.some((v) => v.key === null && /^Customer case: /.test(v.label) && /^First reply \d+ business hours? · resolve in /.test(v.valueText))).toBe(true);
  });

  it('is on the settings overview with the returns and finance sections', async () => {
    const res = await h.call('GET', '/api/admin/settings/overview', tokens.staff());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byKey = new Map((res.body.sections as any[]).map((s) => [s.key, s]));
    for (const key of ['support_sla', 'returns_baseline', 'fees', 'payouts_holds']) {
      expect(byKey.get(key)?.subtitle, key).not.toBe('Not reported by its module yet');
      expect(byKey.get(key)?.values.length, key).toBeGreaterThan(0);
    }
    // runtime-setting values get their type from settings; the payout section is edited through POST /changes
    expect(byKey.get('support_sla').values.find((v: any) => v.key === 'support.firstResponseBusinessHours')).toMatchObject({ valueType: expect.any(String) });
    expect(byKey.get('payouts_holds')).toMatchObject({ ownedHere: true });
    expect(byKey.get('returns_baseline')).toMatchObject({ ownedHere: false, link: { path: '/api/admin/returns/policies' } });
  });
});
