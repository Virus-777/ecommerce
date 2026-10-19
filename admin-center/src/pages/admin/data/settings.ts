import type { components } from '@marketly/web-shared/api';
import type { IconName } from '@marketly/web-shared/ui';

// Settings (design: pages/admin/admin-settings.html and admin-settings--review-change.html), from the settings API:
// the overview (market, sections owned here or by other modules, scheduled changes), setting definitions and values,
// and the change process (draft with impact preview → submit: scheduled, or sent for approval).

type S = components['schemas'];
export type SettingsOverview = S['settings.SettingsOverview'];
export type SettingsSection = S['settings.SettingsSection'];
export type SettingDefinition = S['settings.SettingDefinition'];
export type SettingDetail = S['settings.SettingDetail'];
export type SettingChange = S['settings.SettingChange'];
export type ApplyScope = S['settings.ChangeInput']['applyScope'];

const SECTION_ICON: Record<string, IconName> = {
  market: 'globe',
  support_hours: 'clock',
  checkout: 'shopping-bag',
  apps: 'smartphone',
  returns_baseline: 'undo-2',
  fees: 'percent',
  payouts_holds: 'wallet',
  shipping_defaults: 'truck',
  advertising_rules: 'megaphone',
  seller_targets: 'store',
  support_sla: 'life-buoy',
  access: 'users',
  audit: 'history',
  finance: 'landmark',
  identity: 'shield',
  notifications: 'bell',
};
export const sectionIcon = (key: string): IconName => SECTION_ICON[key] ?? 'settings';

/** Admin screens that edit the sections other modules own, when the API sends no link. */
export const OWNER_SCREEN: Record<string, string> = {
  returns_baseline: 'admin/returns',
  fees: 'admin/finance',
  payouts_holds: 'admin/payouts',
  shipping_defaults: 'admin/shipping',
  advertising_rules: 'admin/ad-placements',
  seller_targets: 'admin/sellers',
  support_sla: 'admin/cases',
};

export const SCOPE_OPTIONS: Array<{ value: ApplyScope; label: string }> = [
  { value: 'new_only', label: 'New orders only (placed on or after the effective date)' },
  { value: 'open_commitments', label: 'New orders and open orders not yet delivered' },
];

const JSONISH = new Set(['json', 'weekly_hours', 'closures']);
export const isJsonish = (d: SettingDefinition) => JSONISH.has(d.valueType);

/** A setting value as the text in its form control. */
export function toField(d: SettingDefinition, v: unknown): string | boolean {
  if (d.valueType === 'bool') return Boolean(v);
  if (v == null) return '';
  if (d.valueType === 'money') {
    const m = v as { amount?: number };
    return m.amount == null ? '' : (m.amount / 100).toFixed(2);
  }
  if (isJsonish(d)) return JSON.stringify(v, null, 2);
  return String(v);
}

/** A form control's text as the value the API takes; throws a user-facing message when invalid. */
export function fromField(d: SettingDefinition, f: string | boolean, currency = 'USD'): unknown {
  if (d.valueType === 'bool') return Boolean(f);
  const s = String(f).trim();
  switch (d.valueType) {
    case 'int':
    case 'number':
    case 'duration': {
      if (!s) throw new Error(`Enter a number for ${d.label}.`);
      const n = Number(s.replace(/,/g, ''));
      if (!Number.isFinite(n) || (d.valueType !== 'number' && !Number.isInteger(n))) throw new Error(`Enter a whole number for ${d.label}.`);
      if (d.min != null && n < d.min) throw new Error(`${d.label} must be at least ${d.min}.`);
      if (d.max != null && n > d.max) throw new Error(`${d.label} must be at most ${d.max}.`);
      return n;
    }
    case 'money': {
      const n = Number(s.replace(/[,$]/g, ''));
      if (!s || !Number.isFinite(n) || n < 0) throw new Error(`Enter an amount in dollars for ${d.label}.`);
      return { amount: Math.round(n * 100), currency };
    }
    case 'json':
    case 'weekly_hours':
    case 'closures':
      try {
        return JSON.parse(s);
      } catch {
        throw new Error(`${d.label} must be valid JSON.`);
      }
    default:
      return s;
  }
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** YYYY-MM-DD in Pacific time, `days` from today. */
export const dayFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
