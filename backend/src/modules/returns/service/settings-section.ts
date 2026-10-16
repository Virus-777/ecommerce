/**
 * The "Returns baseline" section of the Admin Center settings page (G76): the baseline in force, the category
 * exceptions and who pays return shipping, with the scheduled baseline versions and exception changes.
 * Edited through this module's own endpoints (link); settings shows it read-only.
 */
import type * as settings from '../../../spec/settings.js';
import type { CategoryException, PolicyVersion, ShippingResponsibility } from '../../../spec/returns.js';
import { shortDate } from '../domain/rules.js';
import type { Policies } from './policies.js';

export const RETURNS_SECTION_KEY = 'returns_baseline';
const RETURNS_SECTION_ORDER = 100;

const REASON_LABELS: Record<ShippingResponsibility['reasonGroup'], string> = {
  damaged: 'Damaged',
  incorrect: 'Incorrect item',
  defective: 'Defective',
  not_as_described: 'Not as described',
  missing_parts: 'Missing parts',
  change_of_mind: 'Change of mind',
  lost_in_transit: 'Lost in transit',
};
const PAYER: Record<ShippingResponsibility['paidBy'], string> = { seller: 'Seller pays', customer: 'Customer pays', platform: 'Marketly pays' };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const windowText = (e: Pick<CategoryException, 'windowDays' | 'changeOfMindAllowed'>) => (e.changeOfMindAllowed && e.windowDays ? plural(e.windowDays, 'day') : 'Final sale');

function value(label: string, valueText: string, raw: unknown = null, exampleValue = false): settings.SectionValue {
  return { key: null, label, valueText, value: raw, valueType: null, hint: null, exampleValue };
}

/** Builds the section from the same read as GET /api/admin/returns/policies */
export async function returnsSettingsSection(policies: Policies, tz: string): Promise<settings.SettingsSection> {
  const admin = await policies.policyAdmin();
  const a = admin.active;
  const live = a.categoryExceptions;
  const active = live.filter((e) => e.status === 'active');

  const values: settings.SectionValue[] = [
    value('Standard return window', `${plural(a.windowDays, 'day')} after delivery`, a.windowDays, true),
    value('Refund timing target', `${plural(a.refundTargetBusinessDays, 'business day')} after inspection`, a.refundTargetBusinessDays, true),
    value('Seller response target', plural(a.sellerResponseBusinessDays, 'business day'), a.sellerResponseBusinessDays),
    value('Inspection target', plural(a.inspectionTargetBusinessDays, 'business day'), a.inspectionTargetBusinessDays),
    ...active.map((e) => {
      const next = live.find((x) => x.categoryId === e.categoryId && (x.status === 'scheduled' || x.status === 'pending_approval'));
      return {
        ...value(`Category exception: ${e.categoryName}`, `${windowText(e)} · ${e.condition}`, { windowDays: e.windowDays ?? null, condition: e.condition }, true),
        hint: next ? `${windowText(next)} from ${shortDate(next.effectiveFrom, tz)}` : null,
      };
    }),
    ...a.responsibilities.map((r) => value(`Return shipping: ${REASON_LABELS[r.reasonGroup]}`, PAYER[r.paidBy], r.paidBy)),
  ];

  const baselineChange = (p: PolicyVersion): settings.ScheduledChange | null =>
    p.effectiveFrom && (p.status === 'scheduled' || p.status === 'pending_approval')
      ? {
          source: 'module',
          module: 'returns',
          ref: `RP-${p.version}`,
          title: p.windowDays === a.windowDays ? `Return baseline ${p.version} applies` : `Standard return window changes from ${a.windowDays} to ${p.windowDays} days`,
          effectiveAt: p.effectiveFrom,
          appliesTo: p.impact ?? `Orders placed before ${shortDate(p.effectiveFrom, tz)} keep the terms accepted at purchase`,
          status: p.status,
          approvedBy: null,
          sellerVisible: true,
        }
      : null;
  const exceptionChange = (e: CategoryException): settings.ScheduledChange | null => {
    if (e.status !== 'scheduled' && e.status !== 'pending_approval') return null;
    const current = active.find((x) => x.categoryId === e.categoryId);
    return {
      source: 'module',
      module: 'returns',
      ref: e.id,
      title: current ? `${e.categoryName} return window changes from ${windowText(current)} to ${windowText(e)}` : `${e.categoryName}: ${windowText(e)} returns`,
      effectiveAt: e.effectiveFrom,
      appliesTo:
        e.applyScope === 'undelivered_orders'
          ? 'All orders not yet delivered'
          : current
            ? `Orders placed before ${shortDate(e.effectiveFrom, tz)} keep ${windowText(current)}`
            : `Orders placed from ${shortDate(e.effectiveFrom, tz)}`,
      status: e.status,
      approvedBy: null,
      sellerVisible: true,
    };
  };
  const scheduled = [...admin.upcoming.map(baselineChange), ...live.map(exceptionChange)]
    .filter((s): s is settings.ScheduledChange => !!s)
    .sort((x, y) => x.effectiveAt.localeCompare(y.effectiveAt));

  return {
    key: RETURNS_SECTION_KEY,
    title: 'Returns baseline',
    subtitle: 'Sellers can offer more generous terms, never less',
    ownerModule: 'returns',
    ownedHere: false,
    values,
    // the version in force: who proposed it and from when (the seeded 1.0 has no effective date of record)
    lastChange: a.effectiveFrom && a.createdBy ? { by: a.createdBy, approvedBy: null, at: a.createdAt, effectiveFrom: a.effectiveFrom } : null,
    scheduled,
    link: { module: 'returns', area: 'admin', path: '/api/admin/returns/policies', screen: 'admin/settings' },
    available: true,
  };
}

/** Registers the section with settings after boot (nothing without settings) */
export async function registerReturnsSettingsSection(api: { registerSection: settings.SettingsPublicApi['registerSection'] } | undefined, policies: Policies, tz: () => string): Promise<void> {
  if (!api) return;
  await api.registerSection({ key: RETURNS_SECTION_KEY, order: RETURNS_SECTION_ORDER, load: () => returnsSettingsSection(policies, tz()) });
}
