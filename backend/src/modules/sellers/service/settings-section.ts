/**
 * The "Seller performance targets" section of the Admin Center settings page (G76): the target of every
 * metric in force, category targets, and targets saved for a later date. Edited through this module's own
 * endpoint (link /api/admin/sellers/performance-targets).
 */
import type * as settings from '../../../spec/settings.js';
import type { PerformanceTarget } from '../../../spec/sellers.js';
import { METRIC_INFO } from '../domain/catalogue.js';
import type { PerformancePart } from './performance.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const labelOf = (t: PerformanceTarget) => METRIC_INFO[t.metric]?.label ?? t.metric;
const text = (t: PerformanceTarget) => `${t.display} over ${plural(t.windowDays, 'day')}`;

export async function sellersSettingsSection(performance: PerformancePart, today: string): Promise<settings.SettingsSection> {
  const all = await performance.listPerformanceTargets();
  const inForce = all.filter((t) => !t.categoryId && t.effectiveFrom <= today);
  const later = all.filter((t) => t.effectiveFrom > today);
  // listPerformanceTargets gives every category target; the one in force per metric and category is the latest started
  const byCategory = new Map<string, PerformanceTarget>();
  for (const t of all) if (t.categoryId && t.effectiveFrom <= today) byCategory.set(`${t.metric}:${t.categoryId}`, t);

  const values: settings.SectionValue[] = [
    ...inForce.map((t): settings.SectionValue => {
      const next = later.find((x) => x.metric === t.metric && !x.categoryId);
      return { key: null, label: labelOf(t), valueText: text(t), value: t.threshold, valueType: null, hint: next ? `${text(next)} from ${next.effectiveFrom}` : null, exampleValue: t.isExample };
    }),
    ...[...byCategory.values()].map((t): settings.SectionValue => ({ key: null, label: `${labelOf(t)} (category ${t.categoryId!.slice(0, 8)})`, valueText: text(t), value: t.threshold, valueType: null, hint: null, exampleValue: t.isExample })),
  ];
  const scheduled = later.map((t): settings.ScheduledChange => {
    const now = inForce.find((x) => x.metric === t.metric);
    return {
      source: 'module',
      module: 'sellers',
      ref: `${t.metric}@${t.effectiveFrom}${t.categoryId ? `:${t.categoryId}` : ''}`,
      title: now && !t.categoryId ? `${labelOf(t)} target changes from ${now.display} to ${t.display}` : `${labelOf(t)} target: ${t.display}`,
      // targets start at the beginning of their market day; midnight UTC of that date is close enough for ordering
      effectiveAt: `${t.effectiveFrom}T00:00:00.000Z`,
      appliesTo: 'Metrics computed from then on; metrics already computed are not re-graded',
      status: 'scheduled',
      approvedBy: null,
      sellerVisible: true,
    };
  });
  return {
    key: 'seller_targets',
    title: 'Seller performance targets',
    subtitle: 'Account health grades every seller against these targets',
    ownerModule: 'sellers',
    ownedHere: false,
    values,
    lastChange: null,
    scheduled,
    link: { module: 'sellers', area: 'admin', path: '/api/admin/sellers/performance-targets', screen: 'admin/settings' },
    available: true,
  };
}

/** Registers the section with settings after boot (nothing without settings) */
export async function registerSellersSettingsSection(api: { registerSection: settings.SettingsPublicApi['registerSection'] } | undefined, performance: PerformancePart, today: () => string): Promise<void> {
  if (!api) return;
  await api.registerSection({ key: 'seller_targets', order: 150, load: () => sellersSettingsSection(performance, today()) });
}
