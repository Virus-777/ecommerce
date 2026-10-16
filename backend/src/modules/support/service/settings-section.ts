/**
 * The "Support targets" section of the Admin Center settings page (G76): support's reply, decision and appeal
 * targets (runtime settings: settings adds their scheduled changes and last change) and the targets of every
 * active case category (edited through this module's own endpoint, link /api/admin/support/categories).
 */
import type * as settings from '../../../spec/settings.js';
import type { Core } from './core.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Support's runtime settings shown here: [setting name, label, unit word, fallback] */
const TARGETS: [string, string, string, number][] = [
  ['firstResponseBusinessHours', 'First reply target', 'business hour', 4],
  ['sellerReplyBusinessDays', 'Seller reply target before Marketly steps in', 'business day', 2],
  ['disputeDecisionBusinessDays', 'Decision target from escalation', 'business day', 5],
  ['appealWindowDays', 'Appeal window after a decision', 'day', 14],
  ['appealReplyBusinessDays', 'Appeal review target', 'business day', 3],
  ['reopenWindowDays', 'Reopen a resolved case within', 'day', 30],
  ['autoCloseAfterDays', 'Resolved cases close after', 'day', 7],
];

export async function supportSettingsSection(core: Core): Promise<settings.SettingsSection> {
  const numbers = await Promise.all(TARGETS.map(([name, , , fallback]) => core.setting(name as Parameters<Core['setting']>[0], fallback)));
  const categories = [...(await core.categories()).values()].map((c) => core.categoryView(c)).filter((c) => c.active);
  const values: settings.SectionValue[] = [
    ...TARGETS.map(([name, label, unit], i): settings.SectionValue => ({ key: `support.${name}`, label, valueText: plural(numbers[i]!, unit), value: numbers[i]!, valueType: null, hint: null, exampleValue: true })),
    ...categories
      .sort((a, b) => a.audience.localeCompare(b.audience) || a.label.localeCompare(b.label))
      .map((c): settings.SectionValue => ({
        key: null,
        label: `${c.audience === 'seller' ? 'Seller case' : 'Customer case'}: ${c.label}`,
        valueText: `First reply ${plural(c.firstResponseBusinessHours, 'business hour')} · resolve in ${plural(c.resolutionBusinessDays, 'business day')}`,
        value: { firstResponseBusinessHours: c.firstResponseBusinessHours, nextResponseBusinessHours: c.nextResponseBusinessHours, resolutionBusinessDays: c.resolutionBusinessDays },
        valueType: null,
        hint: null,
        exampleValue: true,
      })),
  ];
  return {
    key: 'support_sla',
    title: 'Support targets',
    subtitle: 'Reply and resolution targets count business hours only',
    ownerModule: 'support',
    // category targets are edited through the support categories endpoint (the runtime settings through POST /changes)
    ownedHere: false,
    values,
    lastChange: null,
    scheduled: [],
    link: { module: 'support', area: 'admin', path: '/api/admin/support/categories', screen: 'admin/settings' },
    available: true,
  };
}

/** Registers the section with settings after boot (nothing without settings) */
export async function registerSupportSettingsSection(api: { registerSection: settings.SettingsPublicApi['registerSection'] } | undefined, core: Core): Promise<void> {
  if (!api) return;
  await api.registerSection({ key: 'support_sla', order: 160, load: () => supportSettingsSection(core) });
}
