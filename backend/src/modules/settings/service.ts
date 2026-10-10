import { createHash } from 'node:crypto';
import { SYSTEM_ACTOR } from '../../kernel/auth/index.js';
import { AppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { newId, isUuid } from '../../kernel/lib/ids.js';
import { dateInZone } from '../../kernel/lib/clock.js';
import { pageOf, type Page, type PageRequest } from '../../kernel/lib/pagination.js';
import { allSpecs } from '../../kernel/module-system/loader.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as audit from '../../spec/audit.js';
import type { Actor, ApprovalInfo, TimelineEvent } from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type {
  AppConfig,
  BusinessDay,
  ChangeInput,
  ChangeItem,
  Closure,
  DayHours,
  FeatureFlag,
  ImpactItem,
  ImpactPreview,
  LastChange,
  MaintenanceNotice,
  MarketSettings,
  PublicMarket,
  PublicSupport,
  ScheduledChange,
  ServiceRegion,
  SettingChange,
  SettingDefinition,
  SettingDetail,
  SettingsOverview,
  SettingsPublicApi,
  SettingsSection,
  SettingVersion,
  UpcomingChange,
} from '../../spec/settings.js';
import { addDays, createCalendar } from './domain/calendar.js';
import { APPROVER_LABELS, buildCatalogue, KNOWN_MODULE_SECTIONS, OWN_SECTIONS, strictest, toApiDefinition, type Definition } from './domain/catalogue.js';
import { evaluateFlag, FLAG_CATALOGUE, type FlagState } from './domain/flags.js';
import { settingChangeMachine } from './domain/state-machines.js';
import { closedLabel, dateText, hoursLabel, sameValue, validateValue, valueText, type Issue } from './domain/values.js';
import { SEED_ACTOR } from './infra/postgres/repository.js';
import type { ChangeMeta, ChangeRecord, DefinitionRecord, FlagRecord, SettingsRepository, ValueRecord } from './ports.js';

export interface SettingsServiceDeps {
  repo: SettingsRepository;
  ctx: ModuleContext<'settings'>;
  /** Modules running in this process (their settings and flags are available) */
  enabledModules: readonly string[];
}

/** Who acts in a use case */
export interface By {
  actor: Actor;
  requestId?: string;
}
export interface StaffBy extends By {
  principal: identity.Principal;
  can?: (permission: string) => Promise<boolean>;
}

const DAY_MS = 86_400_000;
/** Values and flags are re-read in the background after this long (other server instances may have written) */
const SNAPSHOT_TTL_MS = 30_000;
/** Second reviewer (another Platform Administrator or the Business Owner) */
const APPROVAL_ACTION = 'settings.changes.apply';
/** Any item whose rule is business_owner: the Business Owner only, so a Platform Administrator can never approve it */
const OWNER_APPROVAL_ACTION = 'settings.changes.apply-owner';
const APPROVAL_ACTIONS: readonly string[] = [APPROVAL_ACTION, OWNER_APPROVAL_ACTION];
const APPROVAL_TARGET = 'setting_change';
/** Settings whose change moves what existing orders get */
const ORDER_MODULES = new Set(['checkout', 'orders', 'returns', 'shipping', 'finance', 'payments', 'offers', 'promotions', 'wallet']);
const MARKET_KEYS = [
  'market.country',
  'market.serviceRegion',
  'market.currency',
  'market.timeZone',
  'market.locale',
  'market.legalName',
  'market.companyLine',
  'support.businessHours',
  'support.closures',
  'support.phone',
  'support.email',
] as const;

interface Snapshot {
  loadedAt: number;
  /** Version in force (or last written) per key */
  values: Map<string, ValueRecord>;
  /** Scheduled changes not yet applied: their values count from effectiveAt on */
  scheduled: { key: string; value: unknown; effectiveAt: Date }[];
  flags: Map<string, FlagRecord>;
}

interface SectionProvider {
  key: string;
  order: number;
  load: () => SettingsSection | Promise<SettingsSection>;
}

type Estimator = (change: { key: string; from: unknown; to: unknown; effectiveAt: string; applyScope: string }) => ImpactItem[] | Promise<ImpactItem[]>;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Settings use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/settings.json.
 */
export class SettingsService implements SettingsPublicApi {
  readonly #enabled: ReadonlySet<string>;
  readonly #sections = new Map<string, SectionProvider>();
  readonly #estimators: { prefix: string; estimate: Estimator }[] = [];
  #snap: Snapshot | null = null;
  #loading: Promise<Snapshot> | null = null;
  #generation = 0;
  #catalogue: { k: string; map: Map<string, Definition> } | null = null;

  constructor(protected readonly deps: SettingsServiceDeps) {
    this.#enabled = new Set(deps.enabledModules);
  }

  private get ctx() {
    return this.deps.ctx;
  }
  private get repo() {
    return this.deps.repo;
  }
  private now() {
    return this.ctx.clock.now();
  }

  /* ================================================================ cache */

  /** Loads values and flags before the first request, so module reads never wait on the database. */
  async warmUp(): Promise<void> {
    try {
      await this.#reload();
    } catch (err) {
      this.ctx.log.warn({ err }, 'settings: could not preload values (the first read loads them)');
    }
  }

  async #snapshot(): Promise<Snapshot> {
    const snap = this.#snap;
    if (snap) {
      if (this.now().getTime() - snap.loadedAt > SNAPSHOT_TTL_MS && !this.#loading) {
        this.#reload().catch((err) => this.ctx.log.error({ err }, 'settings: background reload failed'));
      }
      return snap;
    }
    return this.#reload();
  }

  #reload(): Promise<Snapshot> {
    if (this.#loading) return this.#loading;
    const generation = this.#generation;
    const load = (async () => {
      const [values, open, flags] = await Promise.all([this.repo.openValues(), this.repo.openChanges(), this.repo.listFlags()]);
      const byKey = new Map<string, ValueRecord>();
      for (const v of values) {
        const prev = byKey.get(v.key);
        if (!prev || v.version > prev.version) byKey.set(v.key, v);
      }
      const snap: Snapshot = {
        loadedAt: this.now().getTime(),
        values: byKey,
        scheduled: open.filter((c) => c.status === 'scheduled').flatMap((c) => c.items.map((i) => ({ key: i.key, value: i.to, effectiveAt: c.effectiveAt }))),
        flags: new Map(flags.map((f) => [f.key, f])),
      };
      if (generation === this.#generation) this.#snap = snap;
      return snap;
    })().finally(() => {
      if (this.#loading === load) this.#loading = null;
    });
    this.#loading = load;
    return load;
  }

  /** After a write of this process: drop the cache and read it again (outside any transaction). */
  async #invalidate(): Promise<void> {
    this.#generation++;
    this.#snap = null;
    this.#loading = null;
    await this.#reload().catch((err) => this.ctx.log.error({ err }, 'settings: reload after write failed'));
  }

  /** Value of a key at a time from stored versions and scheduled changes; undefined when none exists (the default applies). */
  async #resolve(key: string, at?: string | Date): Promise<{ value: unknown } | undefined> {
    const now = this.now();
    const t = at ? new Date(at) : now;
    if (Number.isNaN(t.getTime())) throw new AppError('VALIDATION_FAILED', 'Invalid time', { issues: [{ path: 'at', message: 'not a date-time' }] });
    if (t.getTime() < now.getTime() - 1000) {
      const v = await this.repo.valueAt(key, t);
      return v ? { value: v.value } : undefined;
    }
    const snap = await this.#snapshot();
    const current = snap.values.get(key);
    const base = current && current.effectiveFrom <= t ? current : undefined;
    let pick: { value: unknown; from: number } | undefined = base ? { value: base.value, from: base.effectiveFrom.getTime() } : undefined;
    for (const s of snap.scheduled) {
      if (s.key !== key || s.effectiveAt > t) continue;
      const from = s.effectiveAt.getTime();
      if (!pick || from >= pick.from) pick = { value: s.value, from };
    }
    return pick ? { value: pick.value } : undefined;
  }

  /** This module's own runtime settings (the kernel's ctx.settings never asks the settings module itself) */
  async #own<K extends 'appConfigCacheSeconds' | 'defaultMinLeadDays' | 'sellerVisibleMinLeadDays'>(name: K): Promise<number> {
    const r = await this.#resolve(`settings.${name}`);
    const v = r?.value ?? this.ctx.spec.settings[name].default;
    return typeof v === 'number' ? v : Number(this.ctx.spec.settings[name].default);
  }

  async #defs(): Promise<Map<string, Definition>> {
    const o = { defaultMinLeadDays: await this.#own('defaultMinLeadDays'), sellerVisibleMinLeadDays: await this.#own('sellerVisibleMinLeadDays') };
    const k = `${o.defaultMinLeadDays}/${o.sellerVisibleMinLeadDays}`;
    if (this.#catalogue?.k !== k) this.#catalogue = { k, map: buildCatalogue(allSpecs, this.#enabled, o) };
    return this.#catalogue.map;
  }

  async #timeZone(): Promise<string> {
    const tz = await this.#valueOf<string>('market.timeZone');
    return typeof tz === 'string' && tz ? tz : this.ctx.config.market.timeZone;
  }

  /* ================================================================ public API (in-process) */

  /**
   * Value in force at a time (default now), falling back to the declared default. Cached; invalidated by
   * settings.setting.changed. key is the full '<module>.<name>' of any enabled module's declared setting (or a
   * settings-owned key): any module may read another's (read-only). Unknown keys and disabled modules' keys
   * throw UNKNOWN_SETTING.
   */
  async get<T>(key: string, at?: string): Promise<T> {
    const def = typeof key === 'string' ? (await this.#defs()).get(key) : undefined;
    if (!def || !def.available) throw this.ctx.error('UNKNOWN_SETTING', `There is no setting ${String(key)}`, { key });
    return this.#valueOf<T>(key, at);
  }

  /** Value in force or the declared default, without the enabled-module check (this module's own screens and drafts) */
  async #valueOf<T>(key: string, at?: string): Promise<T> {
    const r = await this.#resolve(key, at);
    if (r) return r.value as T;
    const def = (await this.#defs()).get(key);
    return (def ? def.default : null) as T;
  }

  /** Country, region, currency, time zone, locale, business hours */
  async market(): Promise<MarketSettings> {
    const v = Object.fromEntries(await Promise.all(MARKET_KEYS.map(async (k) => [k, await this.#valueOf(k)] as const))) as Record<(typeof MARKET_KEYS)[number], unknown>;
    const timeZone = (v['market.timeZone'] as string) || this.ctx.config.market.timeZone;
    const hours = (v['support.businessHours'] as DayHours[] | null) ?? [];
    const closures = (v['support.closures'] as Closure[] | null) ?? [];
    const country = (v['market.country'] as string) ?? 'US';
    const shortHours = hoursLabel(hours, timeZone, true);
    return {
      country,
      serviceRegion: v['market.serviceRegion'] as ServiceRegion,
      currency: (v['market.currency'] as string) ?? this.ctx.config.market.currency,
      timeZone,
      locale: (v['market.locale'] as string) ?? 'en-US',
      legalName: (v['market.legalName'] as string) ?? '',
      companyLine: (v['market.companyLine'] as string) ?? '',
      businessHours: hours,
      businessHoursLabel: hoursLabel(hours, timeZone),
      closures,
      support: {
        phone: (v['support.phone'] as string) ?? '',
        email: (v['support.email'] as string | null) ?? null,
        phoneHoursLabel: shortHours,
        chatHoursLabel: shortHours,
        closedLabel: closedLabel(hours, closures, country),
      },
    };
  }

  /** Business-hour arithmetic in the market time zone for SLA deadlines */
  async businessCalendar(): Promise<{
    isOpen(at: string): boolean;
    isBusinessDay(day: string): boolean;
    addBusinessMinutes(from: string, minutes: number): string;
    addBusinessDays(from: string, days: number): string;
    nextOpen(after: string): string;
  }> {
    const m = await this.market();
    const cal = createCalendar(m.businessHours, m.closures, m.timeZone);
    const date = (s: string, name: string) => {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw new AppError('VALIDATION_FAILED', `Invalid ${name}`, { issues: [{ path: name, message: 'not a date-time' }] });
      return d;
    };
    return {
      isOpen: (at) => cal.isOpen(date(at, 'at')),
      isBusinessDay: (day) => {
        if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError('VALIDATION_FAILED', 'Invalid day', { issues: [{ path: 'day', message: 'not a date (YYYY-MM-DD)' }] });
        return cal.isBusinessDay(day);
      },
      addBusinessMinutes: (from, minutes) => (cal.addBusinessMinutes(date(from, 'from'), minutes) ?? date(from, 'from')).toISOString(),
      addBusinessDays: (from, days) => (cal.addBusinessDays(date(from, 'from'), days) ?? date(from, 'from')).toISOString(),
      nextOpen: (after) => (cal.nextOpen(date(after, 'after')) ?? date(after, 'after')).toISOString(),
    };
  }

  /** Feature flag check */
  async isEnabled(flagKey: string, subject?: { accountId?: string; realm?: string }): Promise<boolean> {
    const flag = (await this.#flags()).find((f) => f.key === flagKey);
    if (!flag) return false;
    return evaluateFlag(flag.key, flag as FlagState, this.#enabled.has(flag.module), subject);
  }

  /** Called at boot by modules that own a section of the settings page (returns, finance, shipping, advertising) so the overview shows their current values, last change and scheduled changes with a link to their own edit endpoints */
  async registerSection(provider: { key: string; order: number; load: () => SettingsSection }): Promise<void> {
    if (!provider?.key || typeof provider.load !== 'function') throw new AppError('VALIDATION_FAILED', 'A section needs a key and a load function');
    this.#sections.set(provider.key, provider);
  }

  /** Owning modules explain what a change of their declared settings does to existing commitments (open orders, sellers, content) */
  async registerImpactEstimator(keyPrefix: string, estimate: (change: { key: string; from: unknown; to: unknown; effectiveAt: string; applyScope: string }) => ImpactItem[]): Promise<void> {
    if (!keyPrefix || typeof estimate !== 'function') throw new AppError('VALIDATION_FAILED', 'An estimator needs a key prefix and a function');
    this.#estimators.push({ prefix: keyPrefix, estimate });
  }

  /** Public market facts for any screen: support hours and open now, closures in the next 60 days, active maintenance notice, guest checkout and public feature flags (the web-facing subset of AppConfig) */
  async storeInfo(): Promise<{ market: PublicMarket; support: PublicSupport & { email?: string }; closures: Closure[]; maintenance: MaintenanceNotice | null; guestCheckoutEnabled: boolean; features: { key: string; enabled: boolean }[]; configVersion: string }> {
    const s = await this.#publicState();
    return {
      market: s.market,
      support: { ...s.support, ...(s.email ? { email: s.email } : {}) },
      closures: s.upcomingClosures,
      maintenance: s.maintenance.active ? s.maintenance : null,
      guestCheckoutEnabled: s.checkout.guestCheckoutEnabled,
      features: Object.entries(s.features).map(([key, enabled]) => ({ key, enabled })),
      configVersion: s.configVersion,
    };
  }

  /** Scheduled changes that affect sellers, soonest first (same as GET /api/seller/settings/upcoming-changes) */
  async upcomingChangesForSellers(_principal: identity.Principal): Promise<UpcomingChange[]> {
    const [defs, open, tz] = await Promise.all([this.#defs(), this.repo.openChanges(), this.#timeZone()]);
    const now = this.now();
    const out: UpcomingChange[] = [];
    for (const c of open) {
      if (c.status !== 'scheduled' || !this.#sellerVisible(c, defs)) continue;
      out.push({
        ref: c.ref,
        module: this.#moduleOf(c, defs),
        title: this.#title(c.items),
        description: c.items.map((i) => `${i.label}: ${i.fromText} → ${i.toText}`).join(' · '),
        effectiveAt: c.effectiveAt.toISOString(),
        appliesTo: this.#appliesTo(c, tz),
        helpLink: null,
        postedAt: (c.announcedAt ?? c.submittedAt ?? c.createdAt).toISOString(),
      });
    }
    for (const section of await this.#moduleSections()) {
      for (const s of section.scheduled) {
        if (s.source !== 'module' || s.status !== 'scheduled' || !s.sellerVisible || new Date(s.effectiveAt) < now) continue;
        out.push({
          ref: s.ref,
          module: s.module,
          title: s.title,
          description: null,
          effectiveAt: s.effectiveAt,
          appliesTo: s.appliesTo,
          helpLink: null,
          // sections report no announcement time: the last change of the section stands in for it
          postedAt: section.lastChange?.at ?? now.toISOString(),
        });
      }
    }
    return out.sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.ref.localeCompare(b.ref));
  }

  /* ================================================================ public endpoint */

  /** GET /api/public/settings/app-config */
  async appConfig(query: { appVersionCode?: number; platform?: 'web' | 'android' }): Promise<{ config: AppConfig; maxAgeSeconds: number }> {
    const [s, maxAgeSeconds] = await Promise.all([this.#publicState(), this.#own('appConfigCacheSeconds')]);
    const code = query.appVersionCode;
    return {
      maxAgeSeconds,
      config: {
        configVersion: s.configVersion,
        generatedAt: this.now().toISOString(),
        market: s.market,
        support: s.support,
        checkout: s.checkout,
        features: s.features,
        android: {
          ...s.android,
          updateRequired: code != null && code < s.android.minVersionCode,
          updateSuggested: code != null && code < s.android.latestVersionCode,
        },
        maintenance: s.maintenance,
      },
    };
  }

  async #publicState() {
    const now = this.now();
    const [m, defs, flags] = await Promise.all([this.market(), this.#defs(), this.#flags()]);
    const keys = [...defs.values()].filter((d) => d.public && d.available).map((d) => d.key).sort();
    const raw = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await this.#valueOf(k)] as const)));
    const cal = createCalendar(m.businessHours, m.closures, m.timeZone);
    const openNow = cal.isOpen(now);
    const next = openNow ? null : cal.nextOpen(now);
    const today = dateInZone(now, m.timeZone);
    const until = addDays(today, 60);
    const maintenanceValue = (raw['apps.maintenance'] ?? { active: false }) as MaintenanceNotice;
    const expired = maintenanceValue.until ? new Date(maintenanceValue.until) <= now : false;
    const maintenance: MaintenanceNotice = {
      active: Boolean(maintenanceValue.active) && !expired,
      kind: maintenanceValue.kind ?? null,
      message: maintenanceValue.message ?? null,
      until: maintenanceValue.until ?? null,
      updatedAt: maintenanceValue.updatedAt ?? null,
    };
    const publicFlags = flags.filter((f) => f.public);
    const features = Object.fromEntries(publicFlags.map((f) => [f.key, evaluateFlag(f.key, f as FlagState, this.#enabled.has(f.module))]));
    const configVersion = createHash('sha256')
      .update(JSON.stringify({ raw, flags: publicFlags.map((f) => [f.key, f.enabled, f.rollout, f.percentage, this.#enabled.has(f.module)]) }))
      .digest('hex')
      .slice(0, 16);
    const market: PublicMarket = { country: m.country, currency: m.currency, timeZone: m.timeZone, locale: m.locale, serviceRegionLabel: m.serviceRegion?.label ?? m.country, legalName: m.legalName, companyLine: m.companyLine };
    const support: PublicSupport = {
      hoursLabel: m.support.phoneHoursLabel,
      openNow,
      nextOpenAt: iso(next),
      phone: m.support.phone,
      chatHoursLabel: m.support.chatHoursLabel,
      closedLabel: m.support.closedLabel ?? null,
    };
    return {
      market,
      support,
      email: m.support.email ?? null,
      upcomingClosures: m.closures.filter((c) => c.date >= today && c.date <= until).sort((a, b) => a.date.localeCompare(b.date)),
      maintenance,
      checkout: { guestCheckoutEnabled: Boolean(raw['checkout.guestCheckoutEnabled']), offerAccountAfterGuestPurchase: Boolean(raw['checkout.offerAccountAfterGuestPurchase']) },
      features,
      android: {
        minVersionCode: Number(raw['apps.android.minVersionCode'] ?? 1),
        latestVersionCode: Number(raw['apps.android.latestVersionCode'] ?? 1),
        latestVersionName: String(raw['apps.android.latestVersionName'] ?? ''),
        updateUrl: String(raw['apps.android.updateUrl'] ?? ''),
        updateMessage: (raw['apps.android.updateMessage'] as string | null) ?? null,
      },
      configVersion,
    };
  }

  /* ================================================================ admin reads */

  async overview(): Promise<SettingsOverview> {
    const [market, defs, open, tz] = await Promise.all([this.market(), this.#defs(), this.repo.openChanges(), this.#timeZone()]);
    const available = [...defs.values()].filter((d) => d.available);
    const sections: (SettingsSection & { order: number })[] = [];

    // settings-owned sections, then one section per module that declares runtime settings
    const own = new Map(OWN_SECTIONS.map((s) => [s.key, { ...s, ownerModule: 'settings' }]));
    const moduleSectionKeys = [...new Set(available.filter((d) => !own.has(d.section)).map((d) => d.section))].sort();
    moduleSectionKeys.forEach((key, i) => own.set(key, { key, title: allSpecs[key]?.title ?? key, subtitle: `Runtime settings of ${allSpecs[key]?.title ?? key}`, order: 1000 + i, ownerModule: key }));
    for (const info of own.values()) {
      const inSection = available.filter((d) => d.section === info.key).sort((a, b) => a.key.localeCompare(b.key));
      const keys = inSection.map((d) => d.key);
      const scheduled = open.filter((c) => c.items.some((i) => keys.includes(i.key)));
      const last = await this.repo.lastChangeAmong(keys);
      const values = await Promise.all(
        inSection.map(async (d) => {
          const next = scheduled.find((c) => c.status === 'scheduled' && c.items.some((i) => i.key === d.key));
          const item = next?.items.find((i) => i.key === d.key);
          return {
            key: d.key,
            label: d.label,
            valueText: valueText(d, await this.#valueOf(d.key), tz),
            hint: item && next ? `Changes to ${item.toText} on ${dateText(next.effectiveAt, tz)}` : d.editable ? null : 'Read-only',
            exampleValue: d.exampleValue,
          };
        }),
      );
      sections.push({
        key: info.key,
        title: info.title,
        subtitle: info.subtitle ?? null,
        ownerModule: info.ownerModule,
        ownedHere: true,
        values,
        lastChange: last ? this.#lastChange(last) : null,
        scheduled: scheduled.map((c) => this.#scheduledChange(c, defs, tz)),
        link: null,
        available: true,
        order: info.order,
      });
    }

    // sections owned by other modules
    const reported = await this.#moduleSections();
    for (const s of reported) sections.push({ ...s, order: this.#sections.get(s.key)?.order ?? 500 });
    for (const k of KNOWN_MODULE_SECTIONS) {
      if (reported.some((s) => s.key === k.key)) continue;
      sections.push({
        key: k.key,
        title: k.title,
        subtitle: this.#enabled.has(k.module) ? 'Not reported by its module yet' : 'Module not enabled',
        ownerModule: k.module,
        ownedHere: false,
        values: [],
        lastChange: null,
        scheduled: [],
        link: null,
        available: this.#enabled.has(k.module),
        order: k.order,
      });
    }
    sections.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

    const scheduled = [...open.map((c) => this.#scheduledChange(c, defs, tz)), ...reported.flatMap((s) => s.scheduled.filter((x) => x.source === 'module'))].sort((a, b) =>
      a.effectiveAt.localeCompare(b.effectiveAt),
    );
    return { market, sections: sections.map(({ order: _o, ...s }) => s), scheduled };
  }

  /** Sections registered by other modules, loaded now (a failing provider is shown as unavailable) */
  async #moduleSections(): Promise<SettingsSection[]> {
    const providers = [...this.#sections.values()].sort((a, b) => a.order - b.order);
    return Promise.all(
      providers.map(async (p) => {
        try {
          const s = await p.load();
          return { ...s, key: s.key ?? p.key, ownedHere: false, scheduled: s.scheduled ?? [], values: s.values ?? [] };
        } catch (err) {
          this.ctx.log.warn({ err, section: p.key }, 'settings: section provider failed');
          return { key: p.key, title: p.key, subtitle: 'Could not load this section', ownerModule: 'unknown', ownedHere: false, values: [], lastChange: null, scheduled: [], link: null, available: false };
        }
      }),
    );
  }

  async listDefinitions(filter: { module?: string; section?: string }): Promise<SettingDefinition[]> {
    const defs = [...(await this.#defs()).values()].filter((d) => d.available && (!filter.module || d.module === filter.module) && (!filter.section || d.section === filter.section));
    return defs.sort((a, b) => a.section.localeCompare(b.section) || a.key.localeCompare(b.key)).map(toApiDefinition);
  }

  async #definition(key: string): Promise<Definition> {
    const def = (await this.#defs()).get(key);
    if (!def || !def.available) throw new AppError('NOT_FOUND', 'No enabled module declares this setting', { key });
    return def;
  }

  async getSetting(key: string): Promise<SettingDetail> {
    const def = await this.#definition(key);
    const [tz, open, recentRows] = await Promise.all([this.#timeZone(), this.repo.openChanges(), this.repo.recentValues(key, 10)]);
    const inForce = await this.repo.valueAt(key, this.now());
    const current = inForce ? this.#version(def, inForce, tz) : this.#defaultVersion(def, tz);
    const scheduled = open
      .filter((c) => c.status === 'scheduled' && c.items.some((i) => i.key === key))
      .map((c, i) => {
        const item = c.items.find((x) => x.key === key)!;
        return {
          key,
          version: current.version + 1 + i,
          value: item.to,
          valueText: item.toText,
          effectiveFrom: c.effectiveAt.toISOString(),
          effectiveTo: null,
          applyScope: c.applyScope,
          changeId: c.id,
          changedBy: c.meta.createdBy,
          approvedBy: c.meta.approvedBy,
          reason: c.reason,
        } satisfies SettingVersion;
      });
    const recent = recentRows.length ? recentRows.map((r) => this.#version(def, r, tz)) : [current];
    return { definition: toApiDefinition(def), current, scheduled, recent };
  }

  async settingHistory(key: string, page: PageRequest): Promise<Page<SettingVersion>> {
    const def = await this.#definition(key);
    const tz = await this.#timeZone();
    const p = await this.repo.pageValues(key, page);
    if (!p.items.length && (p.total ?? 0) === 0 && (page.mode === 'page' ? page.page === 1 : !page.cursor)) return pageOf([this.#defaultVersion(def, tz)], page);
    return { ...p, items: p.items.map((r) => this.#version(def, r, tz)) };
  }

  async businessDays(from: string, to: string): Promise<BusinessDay[]> {
    if (to < from) throw new AppError('VALIDATION_FAILED', 'The end date is before the start date', { issues: [{ path: 'to', message: 'must be on or after from' }] });
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
    if (days > 366) throw new AppError('VALIDATION_FAILED', 'Ask for at most 366 days at a time', { issues: [{ path: 'to', message: 'range longer than 366 days' }] });
    const m = await this.market();
    const cal = createCalendar(m.businessHours, m.closures, m.timeZone);
    return Array.from({ length: days }, (_, i) => cal.day(addDays(from, i)));
  }

  async listChanges(filter: { status?: SettingChange['status']; key?: string; section?: string }, page: PageRequest): Promise<Page<SettingChange>> {
    let keys: string[] | undefined;
    if (filter.section) keys = [...(await this.#defs()).values()].filter((d) => d.section === filter.section).map((d) => d.key);
    const p = await this.repo.listChanges({ status: filter.status ?? 'scheduled', key: filter.key, keys }, page);
    return { ...p, items: p.items.map((c) => this.#toApi(c)) };
  }

  async getChange(id: string): Promise<SettingChange> {
    return this.#toApi(await this.#change(id));
  }

  async #change(id: string): Promise<ChangeRecord> {
    const c = isUuid(id) ? await this.repo.getChange(id) : null;
    if (!c) throw new AppError('NOT_FOUND', 'Setting change not found');
    return c;
  }

  /* ================================================================ change process */

  /** POST /changes: validate each value against its definition and return the draft with its impact preview */
  async createChange(input: ChangeInput, by: StaffBy): Promise<SettingChange> {
    const { items, effectiveAt } = await this.#checkInput(input, by);
    const now = this.now();
    const id = newId(now.getTime());
    const preview = await this.#preview({ id, items, effectiveAt, applyScope: input.applyScope }, { submitted: false });
    const record: ChangeRecord = {
      id,
      ref: await this.ctx.refs.next('SC', { digits: 3 }),
      status: settingChangeMachine.initial,
      items,
      effectiveAt,
      applyScope: input.applyScope,
      reason: input.reason.trim(),
      meta: { preview, timeline: [{ at: now.toISOString(), label: 'Draft created', actor: by.actor }], createdBy: by.actor, approvedBy: null, scheduledAt: null, approvalNote: null },
      createdByKind: by.actor.kind,
      createdById: by.actor.id ?? 'unknown',
      createdAt: now,
      submittedAt: null,
      approvalRequestId: null,
      appliedAt: null,
      cancelReason: null,
      version: 1,
      announcedAt: null,
    };
    await this.repo.insertChange(record);
    return this.#toApi(record);
  }

  /** PATCH /changes/{id}: only drafts are edited; applied changes are never edited (a correction is a new change) */
  async updateChange(id: string, input: ChangeInput, by: StaffBy): Promise<SettingChange> {
    const existing = await this.#change(id);
    this.#assertDraft(existing);
    const { items, effectiveAt } = await this.#checkInput(input, by);
    const preview = await this.#preview({ id, items, effectiveAt, applyScope: input.applyScope }, { submitted: false });
    const updated = await this.repo.transaction(async (tx) => {
      const c = await tx.getChange(id, { forUpdate: true });
      if (!c) throw new AppError('NOT_FOUND', 'Setting change not found');
      this.#assertDraft(c);
      return tx.updateChange(id, {
        items,
        effectiveAt,
        applyScope: input.applyScope,
        reason: input.reason.trim(),
        meta: { ...c.meta, preview, timeline: [...c.meta.timeline, { at: this.now().toISOString(), label: 'Draft edited', actor: by.actor }] },
      });
    });
    return this.#toApi(updated);
  }

  /** POST /changes/{id}/preview: recalculate (and keep) the impact preview */
  async previewChange(id: string): Promise<ImpactPreview> {
    const c = await this.#change(id);
    const submitted = c.status !== 'draft';
    const items = submitted ? c.items : await this.#refreshFrom(c.items);
    const preview = await this.#preview({ id, items, effectiveAt: c.effectiveAt, applyScope: c.applyScope }, { submitted });
    if (c.status === 'draft' || c.status === 'pending_approval' || c.status === 'scheduled') {
      await this.repo.updateChange(id, { ...(submitted ? {} : { items }), meta: { ...c.meta, preview } });
    }
    return preview;
  }

  /** POST /changes/{id}/submit: schedule, or send for approval through access */
  async submitChange(id: string, by: StaffBy): Promise<SettingChange> {
    const c = await this.#change(id);
    if (c.status !== 'draft') settingChangeMachine.next(c.status, 'submit'); // throws ILLEGAL_TRANSITION
    const now = this.now();
    const defs = await this.#defs();
    const items = await this.#refreshFrom(c.items);
    const lead = this.#leadProblem(items, c.effectiveAt, defs, now);
    if (lead) throw new AppError('LEAD_TIME_TOO_SHORT', lead.message, { earliest: lead.earliest.toISOString(), key: lead.key });
    const conflicts = await this.repo.keyConflicts(items.map((i) => i.key), id);
    if (conflicts.length) throw new AppError('CHANGE_CONFLICT', `${conflicts[0]!.ref} already changes this setting. Cancel it or combine them.`, { changeRef: conflicts[0]!.ref, key: conflicts[0]!.key });
    const preview = await this.#preview({ id, items, effectiveAt: c.effectiveAt, applyScope: c.applyScope }, { submitted: false });
    if (preview.blocking.length) throw new AppError('IMPACT_BLOCKING', 'The impact preview has blocking items', { blocking: preview.blocking });

    // approval: the strictest rule among the items, decided through access
    const rule = preview.approvalRule;
    let approvalNote: string | null = rule === 'none' ? 'No approval needed for these settings' : null;
    let needsApproval = false;
    const action = rule === 'business_owner' ? OWNER_APPROVAL_ACTION : APPROVAL_ACTION;
    if (rule !== 'none') {
      const check = await this.ctx.use('access').check(by.principal, action);
      if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot apply setting changes');
      approvalNote = check.reason || null;
      // the Business Owner's own change needs no further approval; a second reviewer is always someone else
      needsApproval = !(rule === 'business_owner' && check.decision === 'allowed');
    }
    const title = this.#title(items);
    const tz = await this.#timeZone();

    if (needsApproval) {
      const access = this.ctx.use('access');
      const request = await access.requestApproval({
        action,
        target: { type: APPROVAL_TARGET, id, ref: c.ref, label: title, screen: 'admin/settings' },
        summary: title,
        details: { approvalRule: rule, effectiveAt: c.effectiveAt.toISOString(), applyScope: c.applyScope, items: items.map(({ key, label, from, to, fromText, toText }) => ({ key, label, from, to, fromText, toText })) },
        reason: c.reason,
        requestedBy: by.principal,
        dueAt: c.effectiveAt > now ? c.effectiveAt.toISOString() : null,
      });
      let after: ChangeRecord;
      try {
        after = await this.repo.transaction(async (tx) => {
          const locked = await this.#lockDraft(tx, id);
          if (!(await tx.claimKeys(id, items.map((i) => i.key)))) throw await this.#conflictError(tx, items, id);
          return tx.updateChange(id, {
            status: settingChangeMachine.next(locked.status, 'submit'),
            items,
            submittedAt: now,
            approvalRequestId: request.id,
            meta: {
              ...locked.meta,
              preview,
              approvalNote,
              timeline: [...locked.meta.timeline, { at: now.toISOString(), label: `Sent for approval (${APPROVER_LABELS[rule].join(', ')})`, detail: request.ref ?? null, actor: by.actor }],
            },
          });
        });
      } catch (err) {
        await access.cancelApproval(request.id, by.actor, 'The setting change could not be submitted').catch((e) => this.ctx.log.warn({ err: e }, 'settings: could not withdraw approval request'));
        throw err;
      }
      this.ctx.events.publish(
        'settings.change.submitted',
        { changeId: id, ref: c.ref, keys: items.map((i) => i.key), effectiveAt: c.effectiveAt.toISOString(), approvalRequestId: request.id },
        { actor: by.actor, requestId: by.requestId },
      );
      await this.#audit({ action: 'settings.change.submit', actionLabel: 'Sent setting change for approval', target: this.#auditTarget(after), after: this.#toApi(after), reason: c.reason, approvalRequestId: request.id }, by);
      return this.#toApi(after);
    }

    const sellerVisible = this.#sellerVisible({ items }, defs);
    const scheduled = await this.repo.transaction(async (tx) => {
      const locked = await this.#lockDraft(tx, id);
      if (!(await tx.claimKeys(id, items.map((i) => i.key)))) throw await this.#conflictError(tx, items, id);
      return tx.updateChange(id, {
        status: settingChangeMachine.next(locked.status, 'submitNoApproval'),
        items,
        submittedAt: now,
        announcedAt: sellerVisible ? now : null,
        meta: {
          ...locked.meta,
          preview,
          approvalNote,
          scheduledAt: now.toISOString(),
          timeline: [...locked.meta.timeline, { at: now.toISOString(), label: `Scheduled for ${dateText(c.effectiveAt, tz)}`, detail: approvalNote, actor: by.actor }],
        },
      });
    });
    await this.#invalidate();
    this.#publishScheduled(scheduled, defs, tz, by);
    await this.#audit({ action: 'settings.change.submit', actionLabel: 'Scheduled setting change', target: this.#auditTarget(scheduled), after: this.#toApi(scheduled), reason: c.reason, approvalNote }, by);
    if (scheduled.effectiveAt <= this.now()) return this.#toApi((await this.#apply(id)) ?? scheduled);
    return this.#toApi(scheduled);
  }

  /** POST /changes/{id}/cancel: cancel a draft, pending or scheduled change */
  async cancelChange(id: string, reason: string, by: StaffBy): Promise<SettingChange> {
    const c = await this.#change(id);
    settingChangeMachine.next(c.status, 'cancel'); // ILLEGAL_TRANSITION for applied, rejected, cancelled
    if (c.status === 'pending_approval' && c.approvalRequestId) await this.ctx.use('access').cancelApproval(c.approvalRequestId, by.actor, reason);
    const now = this.now();
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.getChange(id, { forUpdate: true });
      if (!locked) throw new AppError('NOT_FOUND', 'Setting change not found');
      const status = settingChangeMachine.next(locked.status, 'cancel');
      await tx.releaseKeys(id);
      return tx.updateChange(id, {
        status,
        cancelReason: reason,
        meta: { ...locked.meta, timeline: [...locked.meta.timeline, { at: now.toISOString(), label: 'Cancelled', detail: reason, actor: by.actor }] },
      });
    });
    if (c.status === 'scheduled') await this.#invalidate();
    this.ctx.events.publish('settings.change.cancelled', { changeId: id, ref: c.ref, keys: c.items.map((i) => i.key), outcome: 'cancelled', reason }, { actor: by.actor, requestId: by.requestId });
    await this.#audit({ action: 'settings.change.cancel', actionLabel: 'Cancelled setting change', target: this.#auditTarget(after), before: this.#toApi(c), after: this.#toApi(after), reason, approvalRequestId: c.approvalRequestId }, by);
    return this.#toApi(after);
  }

  /** Validates a ChangeInput against the definitions and returns the change items */
  async #checkInput(input: ChangeInput, by: StaffBy): Promise<{ items: ChangeItem[]; effectiveAt: Date }> {
    const defs = await this.#defs();
    const issues: Issue[] = [];
    const effectiveAt = new Date(input.effectiveAt);
    if (Number.isNaN(effectiveAt.getTime())) issues.push({ path: 'effectiveAt', message: 'Must be a date-time' });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Say why the setting changes' });
    if (!input.items?.length) issues.push({ path: 'items', message: 'Change at least one setting' });
    const seen = new Set<string>();
    const tz = await this.#timeZone();
    const items: ChangeItem[] = [];
    for (const [i, item] of (input.items ?? []).entries()) {
      const def = defs.get(item.key);
      if (!def || !def.available) throw new AppError('UNKNOWN_SETTING', `No enabled module declares ${item.key}`, { key: item.key });
      if (!def.editable) throw new AppError('SETTING_NOT_EDITABLE', `${def.label} is read-only`, { key: def.key });
      if (def.editPermission !== 'settings.changes.propose' && by.can && !(await by.can(def.editPermission))) {
        throw new AppError('FORBIDDEN', `Changing ${def.label} needs ${def.editPermission}`, { permission: def.editPermission });
      }
      if (seen.has(item.key)) issues.push({ path: `items.${i}.key`, message: 'This setting is listed twice' });
      seen.add(item.key);
      issues.push(...validateValue(def, item.value, `items.${i}.value`));
      if (!def.applyScopes.includes(input.applyScope)) issues.push({ path: 'applyScope', message: `${def.label} can only apply to ${def.applyScopes.join(' or ')}` });
      const from = await this.#valueOf(def.key);
      if (sameValue(from, item.value)) issues.push({ path: `items.${i}.value`, message: `${def.label} already has this value` });
      items.push({ key: def.key, label: def.label, section: def.section, from, to: item.value, fromText: valueText(def, from, tz), toText: valueText(def, item.value, tz) });
    }
    if (issues.length) throw new AppError('VALIDATION_FAILED', issues[0]!.message, { issues });
    return { items, effectiveAt };
  }

  /** Items with their `from` read again (the value in force may have changed since the draft) */
  async #refreshFrom(items: ChangeItem[]): Promise<ChangeItem[]> {
    const defs = await this.#defs();
    const tz = await this.#timeZone();
    return Promise.all(
      items.map(async (i) => {
        const def = defs.get(i.key);
        const from = await this.#valueOf(i.key);
        return { ...i, from, fromText: def ? valueText(def, from, tz) : i.fromText };
      }),
    );
  }

  #leadProblem(items: ChangeItem[], effectiveAt: Date, defs: Map<string, Definition>, now: Date): { key: string; earliest: Date; message: string } | null {
    let worst: { key: string; days: number } | null = null;
    for (const i of items) {
      const d = defs.get(i.key);
      if (d && d.minLeadDays > 0 && (!worst || d.minLeadDays > worst.days)) worst = { key: d.key, days: d.minLeadDays };
    }
    if (!worst) return null;
    const earliest = new Date(now.getTime() + worst.days * DAY_MS);
    if (effectiveAt.getTime() >= earliest.getTime() - 60_000) return null;
    const label = defs.get(worst.key)!.label;
    return { key: worst.key, earliest, message: `${label} needs ${worst.days} days' notice: the effective date can be ${earliest.toISOString().slice(0, 10)} at the earliest` };
  }

  async #preview(c: { id: string; items: ChangeItem[]; effectiveAt: Date; applyScope: ChangeRecord['applyScope'] }, opts: { submitted: boolean }): Promise<ImpactPreview> {
    const now = this.now();
    const defs = await this.#defs();
    const tz = await this.#timeZone();
    const blocking: string[] = [];
    const items: ImpactItem[] = [];
    const itemDefs: Definition[] = [];
    for (const i of c.items) {
      const def = defs.get(i.key);
      if (!def || !def.available) {
        blocking.push(`${i.key} is no longer declared by an enabled module`);
        continue;
      }
      itemDefs.push(def);
      if (!def.editable) blocking.push(`${def.label} is read-only`);
      for (const issue of validateValue(def, i.to)) blocking.push(`${def.label}: ${issue.message}`);
      if (!def.applyScopes.includes(c.applyScope)) blocking.push(`${def.label} can only apply to ${def.applyScopes.join(' or ')}`);
    }
    if (!opts.submitted) {
      const lead = this.#leadProblem(c.items, c.effectiveAt, defs, now);
      if (lead) blocking.push(lead.message);
      for (const k of await this.repo.keyConflicts(c.items.map((i) => i.key), c.id)) blocking.push(`${k.ref} already changes ${defs.get(k.key)?.label ?? k.key}. Cancel it or combine them.`);
    }
    // the app's minimum version can never pass the latest one
    const to = (key: string) => c.items.find((i) => i.key === key)?.to;
    if (c.items.some((i) => i.key === 'apps.android.minVersionCode' || i.key === 'apps.android.latestVersionCode')) {
      const min = Number(to('apps.android.minVersionCode') ?? (await this.#valueOf('apps.android.minVersionCode')));
      const latest = Number(to('apps.android.latestVersionCode') ?? (await this.#valueOf('apps.android.latestVersionCode')));
      if (min > latest) blocking.push('The minimum Android version code cannot be above the latest one');
    }

    // what the owning modules say about existing commitments
    for (const i of c.items) {
      for (const e of this.#estimators.filter((x) => i.key.startsWith(x.prefix))) {
        try {
          const out = await e.estimate({ key: i.key, from: i.from, to: i.to, effectiveAt: c.effectiveAt.toISOString(), applyScope: c.applyScope });
          for (const item of out ?? []) {
            items.push(item);
            if (item.severity === 'blocking') blocking.push(item.message);
          }
        } catch (err) {
          this.ctx.log.warn({ err, key: i.key }, 'settings: impact estimator failed');
          items.push({ module: i.key.split('.')[0]!, kind: 'other', count: null, message: `The impact of ${i.label} could not be estimated`, severity: 'warning', owner: null, screen: null });
        }
      }
    }
    const when = dateText(c.effectiveAt, tz);
    if (itemDefs.some((d) => ORDER_MODULES.has(d.module))) {
      items.push(
        c.applyScope === 'new_only'
          ? { module: 'settings', kind: 'orders', count: null, message: `Orders placed before ${when} keep their current terms`, severity: 'info', owner: null, screen: null }
          : { module: 'settings', kind: 'orders', count: null, message: `Orders not yet delivered also switch to the new value on ${when}`, severity: 'warning', owner: null, screen: null },
      );
    }
    if (itemDefs.some((d) => d.sellerVisible)) {
      items.push({ module: 'settings', kind: 'sellers', count: null, message: 'Sellers are told when the change is scheduled and see it under Announcements', severity: 'info', owner: null, screen: 'seller/dashboard' });
    }
    if (itemDefs.some((d) => d.public)) {
      items.push({ module: 'settings', kind: 'customers', count: null, message: `The website and the Android app show the new value from ${when}`, severity: 'info', owner: null, screen: null });
    }
    if (itemDefs.some((d) => d.key === 'market.timeZone' || d.key === 'market.currency')) {
      items.push({ module: 'settings', kind: 'other', count: null, message: 'Deadlines, reports and campaign schedules follow the market settings: this change needs a migration plan', severity: 'warning', owner: 'Business Owner', screen: null });
    }
    const rule = strictest(itemDefs.map((d) => d.approval));
    return { computedAt: now.toISOString(), items, blocking: [...new Set(blocking)], needsApproval: rule !== 'none', approvalRule: rule, approvers: APPROVER_LABELS[rule] };
  }

  #assertDraft(c: ChangeRecord) {
    if (c.status !== 'draft') throw new AppError('ILLEGAL_TRANSITION', `Only a draft can be edited; this change is ${c.status.replace('_', ' ')}`, { from: c.status, event: 'edit' });
  }

  async #lockDraft(tx: SettingsRepository, id: string): Promise<ChangeRecord> {
    const c = await tx.getChange(id, { forUpdate: true });
    if (!c) throw new AppError('NOT_FOUND', 'Setting change not found');
    if (c.status !== 'draft') settingChangeMachine.next(c.status, 'submit');
    return c;
  }

  async #conflictError(tx: SettingsRepository, items: ChangeItem[], id: string): Promise<AppError> {
    const k = (await tx.keyConflicts(items.map((i) => i.key), id))[0];
    return new AppError('CHANGE_CONFLICT', `${k?.ref ?? 'Another change'} already changes this setting. Cancel it or combine them.`, { changeRef: k?.ref ?? null, key: k?.key ?? null });
  }

  #publishScheduled(c: ChangeRecord, defs: Map<string, Definition>, _tz: string, by: By) {
    this.ctx.events.publish(
      'settings.change.scheduled',
      {
        changeId: c.id,
        ref: c.ref,
        keys: c.items.map((i) => i.key),
        effectiveAt: c.effectiveAt.toISOString(),
        applyScope: c.applyScope,
        sellerVisible: this.#sellerVisible(c, defs),
        summary: this.#title(c.items),
      },
      { actor: by.actor, requestId: by.requestId },
    );
  }

  /**
   * Applies a scheduled change whose time has come: closes the previous version of each key, writes
   * the new one, publishes settings.setting.changed per key. Returns null when there is nothing to do.
   */
  async #apply(id: string): Promise<ChangeRecord | null> {
    const defs = await this.#defs();
    const pre = await this.repo.getChange(id);
    if (!pre || pre.status !== 'scheduled') return null;
    // values reference their definition: make sure the rows exist (the boot sync may not have run)
    await this.repo.upsertDefinitions(pre.items.map((i) => defs.get(i.key)).filter((d): d is Definition => !!d).map(toRecord), this.now());
    const result = await this.repo.transaction(async (tx) => {
      const c = await tx.getChange(id, { forUpdate: true });
      const now = this.now();
      if (!c || c.status !== 'scheduled' || c.effectiveAt > now) return null;
      const scheduledAt = c.meta.scheduledAt ? new Date(c.meta.scheduledAt) : c.effectiveAt;
      const effectiveFrom = new Date(Math.min(now.getTime(), Math.max(c.effectiveAt.getTime(), scheduledAt.getTime())));
      const changed: EventPayload<'settings.setting.changed'>[] = [];
      for (const item of c.items) {
        const def = defs.get(item.key);
        const prev = await tx.openValue(item.key, { forUpdate: true });
        if (prev) await tx.closeValue(prev.id, effectiveFrom);
        const version = (await tx.latestVersion(item.key)) + 1;
        const value = item.key === 'apps.maintenance' && item.to && typeof item.to === 'object' ? { ...(item.to as object), updatedAt: effectiveFrom.toISOString() } : item.to;
        await tx.insertValue({
          id: newId(now.getTime()),
          key: item.key,
          version,
          value,
          effectiveFrom,
          effectiveTo: null,
          applyScope: c.applyScope,
          changeId: c.id,
          changedBy: { kind: c.createdByKind, id: c.createdById },
          approvedById: c.meta.approvedBy?.id ?? null,
          reason: c.reason,
          createdAt: now,
        });
        changed.push({
          key: item.key,
          module: def?.module ?? item.key.split('.')[0]!,
          version,
          from: prev ? prev.value : (def?.default ?? null),
          to: value,
          effectiveFrom: effectiveFrom.toISOString(),
          applyScope: c.applyScope,
          changeId: c.id,
        });
      }
      await tx.releaseKeys(c.id);
      const after = await tx.updateChange(c.id, {
        status: settingChangeMachine.next(c.status, 'apply'),
        appliedAt: now,
        meta: { ...c.meta, timeline: [...c.meta.timeline, { at: now.toISOString(), label: 'Applied', detail: `In force from ${effectiveFrom.toISOString()}`, actor: SYSTEM_ACTOR }] },
      });
      return { before: c, after, changed };
    });
    if (!result) return null;
    await this.#invalidate();
    for (const p of result.changed) this.ctx.events.publish('settings.setting.changed', p, { actor: SYSTEM_ACTOR });
    await this.#audit(
      {
        action: 'settings.change.apply',
        actionLabel: 'Setting change took effect',
        target: this.#auditTarget(result.after),
        before: Object.fromEntries(result.changed.map((x) => [x.key, x.from])),
        after: Object.fromEntries(result.changed.map((x) => [x.key, x.to])),
        reason: result.after.reason,
        approvalRequestId: result.after.approvalRequestId,
      },
      { actor: SYSTEM_ACTOR },
    );
    return result.after;
  }

  /* ================================================================ feature flags */

  /** Catalogue flags with their stored state (a flag never switched is off for everyone) */
  async #flags(): Promise<FlagRecord[]> {
    const rows = (await this.#snapshot()).flags;
    const out: FlagRecord[] = FLAG_CATALOGUE.map((d) => {
      const row = rows.get(d.key);
      return {
        key: d.key,
        module: d.module,
        label: d.label,
        description: d.description,
        public: d.public,
        plannedPhase: d.plannedPhase,
        enabled: row?.enabled ?? false,
        rollout: row?.rollout ?? 'everyone',
        percentage: row?.percentage ?? null,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
    return out;
  }

  async listFeatureFlags(): Promise<FeatureFlag[]> {
    return (await this.#flags()).map((f) => this.#toApiFlag(f));
  }

  async setFeatureFlag(key: string, body: { enabled: boolean; rollout?: FlagRecord['rollout'] | null; percentage?: number | null; reason: string }, by: By): Promise<FeatureFlag> {
    const before = (await this.#flags()).find((f) => f.key === key);
    if (!before) throw new AppError('NOT_FOUND', 'Feature flag not found', { key });
    const rollout = body.rollout ?? before.rollout;
    const issues: Issue[] = [];
    if (!body.reason?.trim()) issues.push({ path: 'reason', message: 'Say why the flag changes' });
    if (rollout === 'percentage' && (body.percentage == null || body.percentage < 0 || body.percentage > 100)) issues.push({ path: 'percentage', message: 'A percentage rollout needs a percentage from 0 to 100' });
    if (rollout !== 'percentage' && body.percentage != null) issues.push({ path: 'percentage', message: 'Only a percentage rollout takes a percentage' });
    if (issues.length) throw new AppError('VALIDATION_FAILED', issues[0]!.message, { issues });
    const now = this.now();
    const saved = await this.repo.upsertFlag({
      ...before,
      enabled: body.enabled,
      rollout,
      percentage: rollout === 'percentage' ? body.percentage! : null,
      updatedBy: JSON.stringify(by.actor),
      updatedAt: now,
    });
    await this.#invalidate();
    this.ctx.events.publish('settings.feature_flag.changed', { key, enabled: saved.enabled, rollout: saved.rollout, by: by.actor }, { actor: by.actor, requestId: by.requestId });
    const after = this.#toApiFlag({ ...before, ...saved, module: before.module, label: before.label, description: before.description, public: before.public, plannedPhase: before.plannedPhase });
    await this.#audit(
      {
        action: 'settings.feature_flag.set',
        actionLabel: body.enabled ? 'Turned a feature flag on' : 'Turned a feature flag off',
        target: { type: 'feature_flag', id: key, ref: key, label: before.label, screen: 'admin/settings' },
        before: this.#toApiFlag(before),
        after,
        beforeText: before.enabled ? `On (${before.rollout})` : 'Off',
        afterText: saved.enabled ? `On (${saved.rollout}${saved.rollout === 'percentage' ? ` ${saved.percentage}%` : ''})` : 'Off',
        reason: body.reason,
      },
      by,
    );
    return after;
  }

  #toApiFlag(f: FlagRecord): FeatureFlag {
    let updatedBy: Actor | null = null;
    if (f.updatedBy) {
      try {
        updatedBy = JSON.parse(f.updatedBy) as Actor;
      } catch {
        updatedBy = { kind: 'staff', id: f.updatedBy };
      }
    }
    return {
      key: f.key,
      module: f.module,
      label: f.label,
      description: f.description,
      enabled: f.enabled,
      rollout: f.rollout,
      percentage: f.percentage,
      public: f.public,
      plannedPhase: f.plannedPhase,
      updatedBy,
      updatedAt: iso(f.updatedAt),
    };
  }

  /* ================================================================ events consumed */

  /** access.approval.decided: For settings.changes.apply requests: approved → scheduled (applied at once if effectiveAt has passed); rejected/expired → rejected; cancelled → cancelled */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>): Promise<void> {
    if (!APPROVAL_ACTIONS.includes(event.actionKey)) return;
    const found = await this.#changeForApproval(event.requestId, event.target);
    if (!found || found.status !== 'pending_approval' || found.approvalRequestId !== event.requestId) {
      if (!found) this.ctx.log.info({ requestId: event.requestId }, 'settings: approval decided for an unknown change, ignored');
      return;
    }
    const now = this.now();
    const defs = await this.#defs();
    const tz = await this.#timeZone();
    const by: By = { actor: event.decidedBy ?? SYSTEM_ACTOR };
    if (event.outcome === 'approved') {
      const sellerVisible = this.#sellerVisible(found, defs);
      const after = await this.repo.transaction(async (tx) => {
        const c = await tx.getChange(found.id, { forUpdate: true });
        if (!c || c.status !== 'pending_approval') return null;
        return tx.updateChange(c.id, {
          status: settingChangeMachine.next(c.status, 'approve'),
          announcedAt: sellerVisible ? now : null,
          meta: {
            ...c.meta,
            approvedBy: event.decidedBy ?? null,
            scheduledAt: now.toISOString(),
            timeline: [...c.meta.timeline, { at: now.toISOString(), label: `Approved, scheduled for ${dateText(c.effectiveAt, tz)}`, detail: event.reason ?? null, actor: event.decidedBy ?? null }],
          },
        });
      });
      if (!after) return;
      await this.#invalidate();
      this.#publishScheduled(after, defs, tz, by);
      if (after.effectiveAt <= this.now()) await this.#apply(after.id);
      return;
    }
    const outcome = event.outcome === 'cancelled' ? 'cancelled' : 'rejected';
    const after = await this.repo.transaction(async (tx) => {
      const c = await tx.getChange(found.id, { forUpdate: true });
      if (!c || c.status !== 'pending_approval') return null;
      await tx.releaseKeys(c.id);
      const label = event.outcome === 'expired' ? 'Approval expired' : event.outcome === 'cancelled' ? 'Approval request cancelled' : 'Rejected';
      return tx.updateChange(c.id, {
        status: settingChangeMachine.next(c.status, outcome === 'cancelled' ? 'cancel' : 'reject'),
        cancelReason: event.reason ?? (event.outcome === 'expired' ? 'The approval request expired' : null),
        meta: { ...c.meta, timeline: [...c.meta.timeline, { at: now.toISOString(), label, detail: event.reason ?? null, actor: event.decidedBy ?? null }] },
      });
    });
    if (!after) return;
    this.ctx.events.publish(
      'settings.change.cancelled',
      { changeId: after.id, ref: after.ref, keys: after.items.map((i) => i.key), outcome, reason: event.reason ?? (event.outcome === 'expired' ? 'The approval request expired' : null) },
      { actor: by.actor },
    );
  }

  /** access.approval.returned: Move the change back to draft with the reviewer's comment on its timeline */
  async onApprovalReturnedFromAccess(event: EventPayload<'access.approval.returned'>): Promise<void> {
    if (!APPROVAL_ACTIONS.includes(event.actionKey)) return;
    const found = await this.#changeForApproval(event.requestId, event.target);
    if (!found || found.status !== 'pending_approval' || found.approvalRequestId !== event.requestId) return;
    const now = this.now();
    await this.repo.transaction(async (tx) => {
      const c = await tx.getChange(found.id, { forUpdate: true });
      if (!c || c.status !== 'pending_approval') return;
      await tx.releaseKeys(c.id);
      await tx.updateChange(c.id, {
        status: settingChangeMachine.next(c.status, 'return'),
        approvalRequestId: null,
        submittedAt: null,
        meta: { ...c.meta, timeline: [...c.meta.timeline, { at: now.toISOString(), label: 'Returned for changes', detail: event.comment, actor: event.by }] },
      });
    });
  }

  async #changeForApproval(requestId: string, target: { type: string; id: string }): Promise<ChangeRecord | null> {
    if (target?.type === APPROVAL_TARGET && isUuid(target.id)) {
      const c = await this.repo.getChange(target.id);
      if (c) return c;
    }
    return this.repo.getChangeByApprovalRequest(requestId);
  }

  /* ================================================================ jobs */

  /** Job settings.sync-definitions (on boot): Upsert definitions and feature flags declared by enabled modules; mark those of disabled modules unavailable; seed market defaults on first boot */
  async syncDefinitions(): Promise<void> {
    const now = this.now();
    const defs = [...(await this.#defs()).values()];
    const available = defs.filter((d) => d.available);
    await this.repo.upsertDefinitions(available.map(toRecord), now);
    const marked = await this.repo.markUnavailableExcept(available.map((d) => d.key), now);
    await this.repo.syncFlags(FLAG_CATALOGUE.map((f) => ({ key: f.key, module: f.module, label: f.label, description: f.description, public: f.public, plannedPhase: f.plannedPhase })));
    let seeded = 0;
    await this.repo.transaction(async (tx) => {
      for (const d of available.filter((x) => x.builtIn)) {
        if ((await tx.latestVersion(d.key)) > 0) continue;
        await tx.insertValue({
          id: newId(now.getTime()),
          key: d.key,
          version: 1,
          value: d.default,
          effectiveFrom: now,
          effectiveTo: null,
          applyScope: 'new_only',
          changeId: null,
          changedBy: { ...SEED_ACTOR },
          approvedById: null,
          reason: 'Market default at first boot',
          createdAt: now,
        });
        seeded++;
      }
    });
    await this.#invalidate();
    this.ctx.log.info({ definitions: available.length, unavailable: marked, seeded }, 'settings: definitions synced');
  }

  /** Job settings.apply-due-changes (every minute): Apply scheduled changes whose effectiveAt has passed: close the previous versions, write new ones, publish settings.setting.changed per key, bump configVersion */
  async applyDueChanges(): Promise<void> {
    for (let batch = 0; batch < 20; batch++) {
      const due = await this.repo.dueChanges(this.now(), 50);
      for (const c of due) {
        try {
          await this.#apply(c.id);
        } catch (err) {
          this.ctx.log.error({ err, change: c.ref }, 'settings: could not apply a due change');
        }
      }
      if (due.length < 50) break;
    }
  }

  /** Job settings.refresh-impact (daily): Recompute the impact preview of scheduled changes so counts on the page stay current */
  async refreshImpact(): Promise<void> {
    for (const c of await this.repo.openChanges()) {
      try {
        const preview = await this.#preview({ id: c.id, items: c.items, effectiveAt: c.effectiveAt, applyScope: c.applyScope }, { submitted: true });
        await this.repo.transaction(async (tx) => {
          const locked = await tx.getChange(c.id, { forUpdate: true });
          if (!locked || (locked.status !== 'scheduled' && locked.status !== 'pending_approval')) return;
          await tx.updateChange(c.id, { meta: { ...locked.meta, preview } });
        });
      } catch (err) {
        this.ctx.log.warn({ err, change: c.ref }, 'settings: could not refresh an impact preview');
      }
    }
  }

  /* ================================================================ mapping */

  #toApi(c: ChangeRecord): SettingChange {
    let approval: ApprovalInfo | null = null;
    if (c.approvalRequestId) approval = { required: true, reason: c.meta.approvalNote, approvalRequestId: c.approvalRequestId, approvers: c.meta.preview.approvers };
    else if (c.submittedAt) approval = { required: false, reason: c.meta.approvalNote ?? 'No approval needed', approvalRequestId: null, approvers: [] };
    return {
      id: c.id,
      ref: c.ref,
      status: c.status,
      items: c.items,
      effectiveAt: c.effectiveAt.toISOString(),
      applyScope: c.applyScope,
      reason: c.reason,
      impact: c.meta.preview,
      createdBy: c.meta.createdBy,
      createdAt: c.createdAt.toISOString(),
      submittedAt: iso(c.submittedAt),
      approval,
      appliedAt: iso(c.appliedAt),
      cancelReason: c.cancelReason,
      timeline: c.meta.timeline as TimelineEvent[],
    };
  }

  #version(def: Definition, r: ValueRecord, tz: string): SettingVersion {
    return {
      key: r.key,
      version: r.version,
      value: r.value,
      valueText: valueText(def, r.value, tz),
      effectiveFrom: r.effectiveFrom.toISOString(),
      effectiveTo: iso(r.effectiveTo),
      applyScope: r.applyScope,
      changeId: r.changeId,
      changedBy: this.#actorOf(r.changedBy),
      approvedBy: r.approvedById ? { kind: 'staff', id: r.approvedById } : null,
      reason: r.reason,
    };
  }

  /** Version 0: the declared default, before any version was written */
  #defaultVersion(def: Definition, tz: string): SettingVersion {
    return {
      key: def.key,
      version: 0,
      value: def.default,
      valueText: valueText(def, def.default, tz),
      effectiveFrom: new Date(0).toISOString(),
      effectiveTo: null,
      applyScope: 'new_only',
      changeId: null,
      changedBy: { kind: 'system', name: 'Declared default' },
      approvedBy: null,
      reason: null,
    };
  }

  #actorOf(by: { kind: string; id: string }): Actor {
    const kinds = ['customer', 'visitor', 'seller', 'staff', 'provider', 'anonymous', 'system'];
    if (by.id === SEED_ACTOR.id) return { kind: 'system', name: 'Market defaults' };
    return { kind: (kinds.includes(by.kind) ? by.kind : 'system') as Actor['kind'], id: by.id };
  }

  #lastChange(v: ValueRecord): LastChange {
    return { by: this.#actorOf(v.changedBy), approvedBy: v.approvedById ? { kind: 'staff', id: v.approvedById } : null, at: v.createdAt.toISOString(), effectiveFrom: v.effectiveFrom.toISOString() };
  }

  #scheduledChange(c: ChangeRecord, defs: Map<string, Definition>, tz: string): ScheduledChange {
    return {
      source: 'settings',
      module: this.#moduleOf(c, defs),
      ref: c.ref,
      title: this.#title(c.items),
      effectiveAt: c.effectiveAt.toISOString(),
      appliesTo: this.#appliesTo(c, tz),
      status: c.status === 'pending_approval' ? 'pending_approval' : 'scheduled',
      approvedBy: c.meta.approvedBy,
      sellerVisible: this.#sellerVisible(c, defs),
    };
  }

  #title(items: ChangeItem[]): string {
    if (items.length === 1) {
      const i = items[0]!;
      return `${i.label} changes from ${i.fromText} to ${i.toText}`;
    }
    return `${items.length} settings change: ${items.map((i) => i.label).join(', ')}`;
  }

  #appliesTo(c: Pick<ChangeRecord, 'applyScope' | 'effectiveAt'>, tz: string): string {
    const when = dateText(c.effectiveAt, tz);
    return c.applyScope === 'new_only' ? `Orders placed on or after ${when}; earlier orders keep their terms` : `From ${when}, also orders not yet delivered`;
  }

  #moduleOf(c: Pick<ChangeRecord, 'items'>, defs: Map<string, Definition>): string {
    const modules = [...new Set(c.items.map((i) => defs.get(i.key)?.module ?? i.key.split('.')[0]!))];
    return modules.length === 1 ? modules[0]! : 'settings';
  }

  #sellerVisible(c: Pick<ChangeRecord, 'items'>, defs: Map<string, Definition>): boolean {
    return c.items.some((i) => defs.get(i.key)?.sellerVisible);
  }

  #auditTarget(c: ChangeRecord): audit.AuditTarget {
    return { type: 'setting_change', id: c.id, ref: c.ref, label: this.#title(c.items), screen: 'admin/settings' };
  }

  async #audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By): Promise<void> {
    await this.ctx.tryUse('audit')?.record({ category: 'settings', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
  }
}

/** A catalogue definition as a settings.definitions row */
function toRecord(d: Definition): DefinitionRecord {
  return {
    key: d.key,
    module: d.module,
    section: d.section,
    label: d.label,
    description: d.description,
    valueType: d.valueType,
    schema: { enumValues: d.enumValues, min: d.min ?? null, max: d.max ?? null, unit: d.unit ?? null, nullable: d.nullable },
    default: d.default,
    editable: d.editable,
    approval: d.approval,
    minLeadDays: d.minLeadDays,
    applyScopes: d.applyScopes,
    sellerVisible: d.sellerVisible,
    public: d.public,
    exampleValue: d.exampleValue,
    editPermission: d.editPermission,
  };
}

export type { ChangeMeta };
