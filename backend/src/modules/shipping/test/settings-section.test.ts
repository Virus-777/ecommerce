/**
 * G76: the Shipping defaults section of the Admin Center settings page: dispatch targets in force with a
 * scheduled change, Official Store cutoff, free delivery and the enabled carrier services.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as settings from '../../../spec/settings.js';
import { clockText, registerShippingSettingsSection, shippingSettingsSection } from '../service/settings-section.js';
import { harness, tokens, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.app.close();
});

describe('settings section (G76)', () => {
  it('reads times on a 12-hour clock', () => {
    expect([clockText('14:00'), clockText('00:30'), clockText('12:05'), clockText('09:00')]).toEqual(['2:00 PM', '12:30 AM', '12:05 PM', '9:00 AM']);
  });

  it('shows the targets in force and a change saved for a later date', async () => {
    const staff = tokens.staff();
    const t = (await h.call('GET', '/api/admin/shipping/dispatch-targets', staff)).body;
    const later = new Date(h.clock.now().getTime() + 10 * 86_400_000).toISOString();
    const put = await h.call('PUT', '/api/admin/shipping/dispatch-targets', staff, {
      official: t.official,
      sellerDefault: { dispatchWithinBusinessDays: 1, validTrackingWithinHours: t.sellerDefault.validTrackingWithinHours, onTimeTargetPct: t.sellerDefault.onTimeTargetPct },
      effectiveFrom: later,
      reason: 'Faster dispatch for the holidays',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const s = await shippingSettingsSection(h.service.core, h.service.setup);
    expect(s).toMatchObject({ key: 'shipping_defaults', ownerModule: 'shipping', ownedHere: false, link: { path: '/api/admin/shipping/dispatch-targets' } });
    const byLabel = new Map(s.values.map((v) => [v.label, v]));
    expect(byLabel.get('Seller dispatch target')).toMatchObject({ valueText: `${t.sellerDefault.dispatchWithinBusinessDays} business days`, value: t.sellerDefault.dispatchWithinBusinessDays });
    expect(byLabel.get('Official Store order cutoff')).toMatchObject({ valueText: '2:00 PM market time', value: '14:00' });
    expect(byLabel.get('Carrier services')!.valueText).toContain('UPS Ground');
    expect(byLabel.has('Free delivery threshold, Official Store')).toBe(true);
    expect(s.scheduled).toEqual([expect.objectContaining({ source: 'module', module: 'shipping', status: 'scheduled', effectiveAt: later, title: `Seller dispatch target changes from ${t.sellerDefault.dispatchWithinBusinessDays} business days to 1 business day` })]);

    const got: Parameters<settings.SettingsPublicApi['registerSection']>[0][] = [];
    await registerShippingSettingsSection({ registerSection: async (p) => void got.push(p) }, h.service.core, h.service.setup);
    expect(got.map((p) => [p.key, p.order])).toEqual([['shipping_defaults', 130]]);
  });
});
