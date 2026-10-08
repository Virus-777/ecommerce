import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as identity from '../../spec/identity.js';
import type { SettingsPublicApi, Closure, MarketSettings, AppConfig, PublicMarket, PublicSupport, MaintenanceNotice, ImpactItem, SettingsSection, UpcomingChange } from '../../spec/settings.js';
import type { SettingsRepository } from './ports.js';

export interface SettingsServiceDeps {
  repo: SettingsRepository;
  ctx: ModuleContext<'settings'>;
}

/**
 * Settings use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/settings.json.
 */
export class SettingsService implements SettingsPublicApi {
  readonly #deps: SettingsServiceDeps;

  constructor(deps: SettingsServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): SettingsServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Value in force at a time (default now), falling back to the declared default. Cached; invalidated by settings.setting.changed. */
  async get<T>(key: string, at?: string): Promise<T> {
    throw notImplemented('settings.get');
  }

  /** Country, region, currency, time zone, locale, business hours */
  async market(): Promise<MarketSettings> {
    throw notImplemented('settings.market');
  }

  /** Business-hour arithmetic in the market time zone for SLA deadlines */
  async businessCalendar(): Promise<{ isOpen(at: string): boolean, addBusinessMinutes(from: string, minutes: number): string, nextOpen(after: string): string }> {
    throw notImplemented('settings.businessCalendar');
  }

  /** Feature flag check */
  async isEnabled(flagKey: string, subject?: { accountId?: string, realm?: string }): Promise<boolean> {
    throw notImplemented('settings.isEnabled');
  }

  /** Called at boot by modules that own a section of the settings page (returns, finance, shipping, advertising) so the overview shows their current values, last change and scheduled changes with a link to their own edit endpoints */
  async registerSection(provider: { key: string, order: number, load: () => SettingsSection }): Promise<void> {
    throw notImplemented('settings.registerSection');
  }

  /** Owning modules explain what a change of their declared settings does to existing commitments (open orders, sellers, content) */
  async registerImpactEstimator(keyPrefix: string, estimate: (change: { key: string, from: unknown, to: unknown, effectiveAt: string, applyScope: string }) => ImpactItem[]): Promise<void> {
    throw notImplemented('settings.registerImpactEstimator');
  }

  /** Public market facts for any screen: support hours and open now, closures in the next 60 days, active maintenance notice, guest checkout and public feature flags (the web-facing subset of AppConfig) */
  async storeInfo(): Promise<{ market: PublicMarket, support: PublicSupport & { email?: string }, closures: Closure[], maintenance: MaintenanceNotice | null, guestCheckoutEnabled: boolean, features: { key: string, enabled: boolean }[], configVersion: string }> {
    throw notImplemented('settings.storeInfo');
  }

  /** Scheduled changes that affect sellers, soonest first (same as GET /api/seller/settings/upcoming-changes) */
  async upcomingChangesForSellers(principal: identity.Principal): Promise<UpcomingChange[]> {
    throw notImplemented('settings.upcomingChangesForSellers');
  }

  /* ---------------- events consumed */

  /** access.approval.decided: For settings.changes.apply requests: approved → scheduled (applied at once if effectiveAt has passed); rejected/expired → rejected; cancelled → cancelled */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('settings consumer of access.approval.decided');
  }

  /** access.approval.returned: Move the change back to draft with the reviewer's comment on its timeline */
  async onApprovalReturnedFromAccess(event: EventPayload<"access.approval.returned">): Promise<void> {
    void event;
    throw notImplemented('settings consumer of access.approval.returned');
  }

  /* ---------------- jobs */

  /** Job settings.sync-definitions (on boot): Upsert definitions and feature flags declared by enabled modules; mark those of disabled modules unavailable; seed market defaults on first boot */
  async syncDefinitions(): Promise<void> {
    throw notImplemented('job settings.sync-definitions');
  }

  /** Job settings.apply-due-changes (every minute): Apply scheduled changes whose effectiveAt has passed: close the previous versions, write new ones, publish settings.setting.changed per key, bump configVersion */
  async applyDueChanges(): Promise<void> {
    throw notImplemented('job settings.apply-due-changes');
  }

  /** Job settings.refresh-impact (daily): Recompute the impact preview of scheduled changes so counts on the page stay current */
  async refreshImpact(): Promise<void> {
    throw notImplemented('job settings.refresh-impact');
  }
}
