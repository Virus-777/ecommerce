/**
 * Wave 3: finance's sections of the settings page (G76).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as settings from '../../../spec/settings.js';
import { feesSection, payoutsSection, registerFinanceSettingsSections, scheduleText } from '../service/settings-section.js';
import { boot, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

describe('settings sections (G76)', () => {
  it('reads payout schedules as text', () => {
    expect(scheduleText('weekly:FRI')).toBe('Weekly, Friday');
    expect(scheduleText('weekly:TUE,FRI')).toBe('Weekly, Tuesday and Friday');
    expect(scheduleText('daily')).toBe('Daily');
  });

  it('shows the fee rules in force, linked to the fee rules endpoint', async () => {
    await k.svc.core.ensureRules();
    const s = await feesSection(k.svc.fees, 'USD');
    expect(s).toMatchObject({ key: 'fees', ownerModule: 'finance', ownedHere: false, link: { path: '/api/admin/finance/fee-rules' }, scheduled: [] });
    const active = (await k.svc.fees.admin()).active;
    expect(s.values.find((v) => v.label === 'Default commission')).toMatchObject({ value: active.defaultRateBps });
    expect(s.values.find((v) => v.label === 'Default commission')!.valueText).toMatch(/fee · .* to the seller on a \$100\.00 sale$/);
    expect(s.values.filter((v) => v.label.startsWith('Commission: '))).toHaveLength(active.categoryRates.length);
  });

  it('shows the payout and hold settings by their setting keys (edited through settings)', async () => {
    const s = await payoutsSection(k.svc.core);
    expect(s).toMatchObject({ key: 'payouts_holds', ownedHere: true, link: null });
    const byKey = new Map(s.values.map((v) => [v.key, v]));
    expect(byKey.get('finance.payoutSchedule')).toMatchObject({ valueText: 'Weekly, Friday', value: 'weekly:FRI' });
    expect(byKey.get('finance.minimumPayout')).toMatchObject({ valueText: '$25.00' });
    expect(byKey.get('finance.availableAfterDeliveryDays')).toMatchObject({ valueText: '7 days after delivery', value: 7 });
    expect(s.values.every((v) => v.key?.startsWith('finance.'))).toBe(true);
  });

  it('registers both sections when settings runs', async () => {
    const got: Parameters<settings.SettingsPublicApi['registerSection']>[0][] = [];
    await registerFinanceSettingsSections({ registerSection: async (p) => void got.push(p) }, k.svc.core, k.svc.fees);
    expect(got.map((p) => [p.key, p.order])).toEqual([
      ['fees', 110],
      ['payouts_holds', 120],
    ]);
    await registerFinanceSettingsSections(undefined, k.svc.core, k.svc.fees);
  });
});
