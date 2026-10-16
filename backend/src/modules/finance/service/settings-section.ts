/**
 * Finance's two sections of the Admin Center settings page (G76):
 *   - "Commission and fees" (fees): the fee rule set in force and the scheduled versions, edited through
 *     /api/admin/finance/fee-rules (link);
 *   - "Payouts and holds" (payouts_holds): finance's payout and hold runtime settings, edited through the settings
 *     change process (ownedHere; settings adds their types, scheduled changes and last change).
 */
import type * as settings from '../../../spec/settings.js';
import type { FeeRuleSet } from '../../../spec/finance.js';
import type * as common from '../../../spec/common.js';
import { bpsOf, fmt, pct } from '../domain/rules.js';
import type { Core } from './core.js';
import type { FeesPart } from './fees.js';

const DAYS: Record<string, string> = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** weekly:FRI → Weekly, Friday; weekly:TUE,FRI → Weekly, Tuesday and Friday; daily → Daily */
export function scheduleText(v: unknown): string {
  const s = String(v ?? '');
  const [cadence = '', days = ''] = s.split(':');
  const names = days.split(',').filter(Boolean).map((d) => DAYS[d.toUpperCase()] ?? d);
  const head = cadence ? cadence.charAt(0).toUpperCase() + cadence.slice(1) : s;
  if (!names.length) return head;
  return `${head}, ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
}

const value = (label: string, valueText: string, raw: unknown = null, key: string | null = null, exampleValue = false): settings.SectionValue => ({ key, label, valueText, value: raw, valueType: null, hint: null, exampleValue });

export async function feesSection(fees: FeesPart, currency: string): Promise<settings.SettingsSection> {
  const admin = await fees.admin();
  const a = admin.active;
  const onHundred = (bps: number) => {
    const fee = bpsOf(10_000, bps);
    return `${fmt(fee, currency)} fee · ${fmt(10_000 - fee, currency)} to the seller on a ${fmt(10_000, currency)} sale`;
  };
  const values: settings.SectionValue[] = [
    value('Commission basis', `Item price ${a.basis === 'after_seller_discounts' ? 'after seller-funded discounts' : 'before discounts'}, ${a.includeShipping ? 'including' : 'excluding'} shipping`, a.basis),
    value('Platform-funded discounts', a.platformDiscountsReduceFee ? 'Reduce the seller fee' : 'Do not reduce the seller fee', a.platformDiscountsReduceFee),
    value('Default commission', `${pct(a.defaultRateBps)} · ${onHundred(a.defaultRateBps)}`, a.defaultRateBps, null, true),
    ...a.categoryRates.map((r) => value(`Commission: ${r.categoryName}`, `${pct(r.rateBps)} · ${onHundred(r.rateBps)}`, r.rateBps, null, true)),
  ];
  const scheduled = admin.upcoming
    .filter((r): r is FeeRuleSet & { effectiveFrom: string; status: 'scheduled' | 'pending_approval' } => !!r.effectiveFrom && (r.status === 'scheduled' || r.status === 'pending_approval'))
    .map(
      (r): settings.ScheduledChange => ({
        source: 'module',
        module: 'finance',
        ref: `FEES-${r.version}`,
        title: r.defaultRateBps === a.defaultRateBps ? `Fee rules ${r.version} apply` : `Default commission changes from ${pct(a.defaultRateBps)} to ${pct(r.defaultRateBps)}`,
        effectiveAt: r.effectiveFrom,
        appliesTo: 'Orders placed from then on; earlier orders keep the fees in force when they were placed',
        status: r.status,
        approvedBy: null,
        sellerVisible: true,
      }),
    );
  return {
    key: 'fees',
    title: 'Commission and fees',
    subtitle: 'Commission rules by category',
    ownerModule: 'finance',
    ownedHere: false,
    values,
    lastChange: a.effectiveFrom ? { by: a.createdBy, approvedBy: null, at: a.createdAt, effectiveFrom: a.effectiveFrom } : null,
    scheduled,
    link: { module: 'finance', area: 'admin', path: '/api/admin/finance/fee-rules', screen: 'admin/settings' },
    available: true,
  };
}

export async function payoutsSection(core: Core): Promise<settings.SettingsSection> {
  const [schedule, release, available, minimum, newHold, newPeriod, pause, owed] = await Promise.all(
    (['payoutSchedule', 'payoutReleaseTime', 'availableAfterDeliveryDays', 'minimumPayout', 'newSellerHoldDays', 'newSellerPeriodDays', 'destinationChangePauseHours', 'negativeBalanceOwedAfterDays'] as const).map((k) => core.setting(k) as Promise<unknown>),
  );
  const money = (v: unknown) => fmt(Number((v as common.Money | null)?.amount ?? 0), (v as common.Money | null)?.currency ?? core.currency());
  const values: settings.SectionValue[] = [
    value('Payout schedule', scheduleText(schedule), schedule, 'finance.payoutSchedule', true),
    value('Payout release time', `${String(release)} market time`, release, 'finance.payoutReleaseTime'),
    value('Earnings become available', `${plural(Number(available), 'day')} after delivery`, available, 'finance.availableAfterDeliveryDays', true),
    value('Minimum payout', money(minimum), minimum, 'finance.minimumPayout', true),
    value('New seller hold', `${plural(Number(newHold), 'day')}, first ${plural(Number(newPeriod), 'day')} of selling`, newHold, 'finance.newSellerHoldDays', true),
    value('New seller period', plural(Number(newPeriod), 'day'), newPeriod, 'finance.newSellerPeriodDays'),
    value('Pause after a payout destination change', plural(Number(pause), 'hour'), pause, 'finance.destinationChangePauseHours'),
    value('Negative balance becomes an amount owed after', plural(Number(owed), 'day'), owed, 'finance.negativeBalanceOwedAfterDays'),
  ];
  return {
    key: 'payouts_holds',
    title: 'Payouts and holds',
    subtitle: 'Earnings move from Pending to Available, then to a payout',
    ownerModule: 'finance',
    ownedHere: true,
    values,
    lastChange: null,
    scheduled: [],
    link: null,
    available: true,
  };
}

/** Registers both sections with settings after boot (nothing without settings) */
export async function registerFinanceSettingsSections(api: { registerSection: settings.SettingsPublicApi['registerSection'] } | undefined, core: Core, fees: FeesPart): Promise<void> {
  if (!api) return;
  await api.registerSection({ key: 'fees', order: 110, load: () => feesSection(fees, core.currency()) });
  await api.registerSection({ key: 'payouts_holds', order: 120, load: () => payoutsSection(core) });
}
