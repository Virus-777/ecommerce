/**
 * The "Advertising rules" section of the Admin Center settings page (G76): the global rules in force, the
 * opening ad frequency, and a rules version waiting for approval or its effective date. Edited through this
 * module's own endpoints (link /api/admin/advertising/rules; the opening ad frequency through its placement).
 */
import type * as settings from '../../../spec/settings.js';
import type { GlobalRules } from '../../../spec/advertising.js';
import { pagesLabel } from '../domain/rules.js';
import type { Core } from './core.js';
import type { SetupPart } from './setup.js';

const value = (label: string, valueText: string, raw: unknown = null): settings.SectionValue => ({ key: null, label, valueText, value: raw, valueType: null, hint: null, exampleValue: false });
const onOff = (b: boolean) => (b ? 'On' : 'Off');

export async function advertisingSettingsSection(core: Core, setup: SetupPart): Promise<settings.SettingsSection> {
  const [rules, placements] = await Promise.all([setup.getRules(), setup.listPlacements()]);
  const opening = placements.find((p) => p.key === 'opening_fullscreen');
  const values: settings.SectionValue[] = [
    value('Opening ad frequency', opening ? (opening.enabled ? (opening.frequencyCap?.label ?? 'No cap') : 'Opening ad off') : 'Not set up', opening?.frequencyCap ?? null),
    value('Overlays per page view', `${rules.overlaysPerPageView} at most`, rules.overlaysPerPageView),
    value('Pages where ads never show', pagesLabel(rules.blockedPages), rules.blockedPages),
    value('"Sponsored" or "Ad" label on every paid placement', 'Always on', rules.labelRequired),
    value('Dismissing an ad stops it for the rest of the session', onOff(rules.dismissStopsForSession), rules.dismissStopsForSession),
    value('Paid seller advertising', rules.paidSellerAdsEnabled ? 'On' : 'Off (later phase)', rules.paidSellerAdsEnabled),
    value('Attribution window', `${rules.attributionDays} days after a click`, rules.attributionDays),
  ];
  // versions above the one in force: waiting for the Business Owner (pending) or approved for a later date
  const later = await core.repo.find('global_rules', { version: { op: '>', value: rules.version } }, { orderBy: [['version', 'asc']], limit: 10 });
  const scheduled = later
    .map((row) => ({ row, state: ((row.rules ?? {}) as { state?: string }).state }))
    .filter((x) => x.state === 'pending' || x.state === 'approved')
    .map(({ row, state }): settings.ScheduledChange => {
      const next: GlobalRules = core.rulesOf(row);
      return {
        source: 'module',
        module: 'advertising',
        ref: `Rules v${next.version}`,
        title: next.overlaysPerPageView !== rules.overlaysPerPageView ? `Overlays per page view change from ${rules.overlaysPerPageView} to ${next.overlaysPerPageView}` : `Advertising rules v${next.version} apply`,
        effectiveAt: next.effectiveAt,
        appliesTo: 'Ads served from then on',
        status: state === 'pending' ? 'pending_approval' : 'scheduled',
        approvedBy: null,
        sellerVisible: false,
      };
    });
  return {
    key: 'advertising_rules',
    title: 'Advertising rules',
    subtitle: 'Launch formats: opening full-screen ad, banners, optional pop-ups',
    ownerModule: 'advertising',
    ownedHere: false,
    values,
    // the built-in rules (version 1 from 1970) have no change of record
    lastChange: rules.updatedBy && new Date(rules.effectiveAt).getTime() > 0 ? { by: rules.updatedBy, approvedBy: null, at: rules.effectiveAt, effectiveFrom: rules.effectiveAt } : null,
    scheduled,
    link: { module: 'advertising', area: 'admin', path: '/api/admin/advertising/rules', screen: 'admin/settings' },
    available: true,
  };
}

/** Registers the section with settings after boot (nothing without settings) */
export async function registerAdvertisingSettingsSection(api: { registerSection: settings.SettingsPublicApi['registerSection'] } | undefined, core: Core, setup: SetupPart): Promise<void> {
  if (!api) return;
  await api.registerSection({ key: 'advertising_rules', order: 140, load: () => advertisingSettingsSection(core, setup) });
}
