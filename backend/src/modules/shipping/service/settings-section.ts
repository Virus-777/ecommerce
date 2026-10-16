/**
 * The "Shipping defaults" section of the Admin Center settings page (G76): dispatch targets in force (and a
 * scheduled change of them), Official Store free delivery and the enabled carrier services. Edited through
 * this module's own endpoints (link /api/admin/shipping/dispatch-targets).
 */
import { format } from '../../../kernel/lib/money.js';
import type * as settings from '../../../spec/settings.js';
import type { Core } from './core.js';
import type { Setup } from './setup.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** 14:00 → 2:00 PM */
export function clockText(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const value = (label: string, valueText: string, raw: unknown = null, exampleValue = false): settings.SectionValue => ({ key: null, label, valueText, value: raw, valueType: null, hint: null, exampleValue });

export async function shippingSettingsSection(core: Core, setup: Setup): Promise<settings.SettingsSection> {
  const [targets, rules, carriers, current] = await Promise.all([setup.getTargets(), setup.listRules(), setup.listCarriers({ staff: true }), core.targets()]);
  const s = targets.sellerDefault;
  const o = targets.official;
  const officialFree = rules.find((r) => r.scope === 'official_store' && r.status === 'active');
  const services = carriers.filter((c) => c.status === 'active').flatMap((c) => c.services.filter((x) => x.enabled).map((x) => x.name));
  const values: settings.SectionValue[] = [
    value('Seller dispatch target', plural(s.dispatchWithinBusinessDays, 'business day'), s.dispatchWithinBusinessDays, true),
    value('Allowed seller handling time', `${s.allowedMinDays} to ${plural(s.allowedMaxDays, 'business day')}`, [s.allowedMinDays, s.allowedMaxDays]),
    value('Flag missing tracking after', `${plural(s.validTrackingWithinHours, 'hour')} after marked shipped`, s.validTrackingWithinHours, true),
    value('Seller on-time target', `${s.onTimeTargetPct}%`, s.onTimeTargetPct, true),
    value('Official Store order cutoff', `${clockText(o.cutoff)} market time`, o.cutoff, true),
    value('Free delivery threshold, Official Store', officialFree ? (officialFree.minOrderValue ? `${format(officialFree.minOrderValue)} and over` : 'Every order') : 'No free delivery rule', officialFree?.minOrderValue ?? null, true),
    value('Carrier services', services.length ? services.join(' · ') : 'None enabled', services),
  ];
  // a change saved with a later effective date waits in dispatch_targets until then
  const next = (await core.repo.find('dispatch_targets', { effective_from: { op: '>', value: core.now() } }, { orderBy: [['effective_from', 'asc']], limit: 1 }))[0];
  const scheduled: settings.ScheduledChange[] = next
    ? [
        {
          source: 'module',
          module: 'shipping',
          ref: next.id,
          title:
            next.seller_default.dispatchWithinBusinessDays !== s.dispatchWithinBusinessDays
              ? `Seller dispatch target changes from ${plural(s.dispatchWithinBusinessDays, 'business day')} to ${plural(next.seller_default.dispatchWithinBusinessDays, 'business day')}`
              : 'Dispatch targets change',
          effectiveAt: next.effective_from.toISOString(),
          appliesTo: 'Orders placed from then on; open orders keep their dispatch deadline',
          status: 'scheduled',
          approvedBy: null,
          sellerVisible: true,
        },
      ]
    : [];
  return {
    key: 'shipping_defaults',
    title: 'Shipping defaults',
    subtitle: 'Sellers can be faster, not slower, than these targets',
    ownerModule: 'shipping',
    ownedHere: false,
    values,
    // the built-in defaults (effective from 1970) have no change of record
    lastChange: current.effective_from.getTime() > 0 ? { by: current.set_by, approvedBy: null, at: current.effective_from.toISOString(), effectiveFrom: current.effective_from.toISOString() } : null,
    scheduled,
    link: { module: 'shipping', area: 'admin', path: '/api/admin/shipping/dispatch-targets', screen: 'admin/settings' },
    available: true,
  };
}

/** Registers the section with settings after boot (nothing without settings) */
export async function registerShippingSettingsSection(api: { registerSection: settings.SettingsPublicApi['registerSection'] } | undefined, core: Core, setup: Setup): Promise<void> {
  if (!api) return;
  await api.registerSection({ key: 'shipping_defaults', order: 130, load: () => shippingSettingsSection(core, setup) });
}
