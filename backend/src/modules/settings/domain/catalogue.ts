/**
 * The catalogue of settable keys (pure, no I/O).
 *
 * Two sources:
 *   - settings-owned market-level keys (market.*, support.*, checkout.*, apps.*), declared here with
 *     their full rules (spec notes "Settings-owned keys and their defaults");
 *   - every enabled module's spec `settings` (`<module>.<key>`). They declare a default and a description,
 *     and usually type, bounds, choices, unit, approval, seller visibility, lead days and editability
 *     (docs/api/spec/FORMAT.md "Settings"); only what a setting leaves out is inferred (see inferDefinition).
 */
import type { ModuleSpecDef, SettingDecl } from '../../../kernel/spec/define.js';
import type { SettingDefinition } from '../../../spec/settings.js';

export type ValueType = SettingDefinition['valueType'];
export type ApprovalRule = SettingDefinition['approval'];
export type ApplyScope = SettingDefinition['applyScopes'][number];

/** A definition as the service uses it: the API shape plus a few internal rules. */
export interface Definition extends SettingDefinition {
  /** null is a valid value (optional texts such as the Android update message) */
  nullable: boolean;
  /** False when the declaring module is disabled: shown nowhere, not settable */
  available: boolean;
  /** Settings-owned market-level key (true) or a module's runtime setting (false) */
  builtIn: boolean;
}

export const APPROVAL_STRENGTH: Record<ApprovalRule, number> = { none: 0, second_reviewer: 1, business_owner: 2 };
export const APPROVER_LABELS: Record<ApprovalRule, string[]> = {
  none: [],
  second_reviewer: ['A second reviewer (another Platform Administrator)'],
  business_owner: ['Business Owner'],
};

/** Strictest rule among items: business_owner > second_reviewer > none */
export const strictest = (rules: ApprovalRule[]): ApprovalRule =>
  rules.reduce<ApprovalRule>((a, b) => (APPROVAL_STRENGTH[b] > APPROVAL_STRENGTH[a] ? b : a), 'none');

/* ------------------------------------------------------------------ settings-owned keys */

const CONTIGUOUS_STATES = [
  'AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

export interface SectionInfo {
  key: string;
  title: string;
  subtitle?: string;
  order: number;
}

/** Sections of the settings page that settings itself owns (edited through POST /changes). */
export const OWN_SECTIONS: SectionInfo[] = [
  { key: 'market', title: 'Market', subtitle: 'Country, service region, currency, time zone and language', order: 0 },
  { key: 'support_hours', title: 'Support hours and contacts', subtitle: 'Business hours, closures and contact details used for deadlines and the Help pages', order: 10 },
  { key: 'checkout', title: 'Checkout', subtitle: 'Guest checkout and account offers', order: 20 },
  { key: 'apps', title: 'Website and Android app', subtitle: 'App versions and maintenance notice', order: 30 },
];

/**
 * Sections other modules own (they call registerSection at boot). Listed so the page can show a
 * section as unavailable when its module is disabled, or as not yet reported.
 */
export const KNOWN_MODULE_SECTIONS: (SectionInfo & { module: string })[] = [
  { key: 'returns_baseline', module: 'returns', title: 'Returns baseline', order: 100 },
  { key: 'fees', module: 'finance', title: 'Commission and fees', order: 110 },
  { key: 'payouts_holds', module: 'finance', title: 'Payouts and holds', order: 120 },
  { key: 'shipping_defaults', module: 'shipping', title: 'Shipping defaults', order: 130 },
  { key: 'advertising_rules', module: 'advertising', title: 'Advertising rules', order: 140 },
  { key: 'seller_targets', module: 'sellers', title: 'Seller performance targets', order: 150 },
  { key: 'support_sla', module: 'support', title: 'Support targets', order: 160 },
];

type BuiltIn = Pick<Definition, 'key' | 'section' | 'label' | 'description' | 'valueType' | 'default'> &
  Partial<Pick<Definition, 'enumValues' | 'unit' | 'min' | 'max' | 'editable' | 'approval' | 'minLeadDays' | 'applyScopes' | 'sellerVisible' | 'public' | 'exampleValue' | 'nullable'>>;

export const BUILT_INS: BuiltIn[] = [
  // market (plan ch. 1: one market at launch)
  { key: 'market.country', section: 'market', label: 'Country', description: 'ISO 3166-1 alpha-2 country of the market.', valueType: 'string', default: 'US', approval: 'business_owner', minLeadDays: 30, exampleValue: true },
  {
    key: 'market.serviceRegion',
    section: 'market',
    label: 'Service region',
    description: 'Where the marketplace sells and delivers (state codes).',
    valueType: 'json',
    default: { code: 'US-48', label: 'United States, 48 contiguous states', includedRegions: CONTIGUOUS_STATES, note: 'Alaska, Hawaii and territories later' },
    approval: 'business_owner',
    minLeadDays: 30,
    sellerVisible: true,
    exampleValue: true,
  },
  { key: 'market.currency', section: 'market', label: 'Currency', description: 'ISO 4217 currency. Fixed for launch (one currency, plan ch. 1).', valueType: 'string', default: 'USD', editable: false, approval: 'business_owner', minLeadDays: 30 },
  { key: 'market.timeZone', section: 'market', label: 'Time zone', description: 'IANA time zone used for deadlines, reports and campaign schedules. Changing it after launch needs a migration plan.', valueType: 'string', default: 'America/Los_Angeles', approval: 'business_owner', minLeadDays: 30 },
  { key: 'market.locale', section: 'market', label: 'Language and formats', description: 'Locale for formatting dates, numbers and money.', valueType: 'string', default: 'en-US', approval: 'second_reviewer' },
  // support hours and contacts
  {
    key: 'support.businessHours',
    section: 'support_hours',
    label: 'Business hours',
    description: 'Open hours per weekday in the market time zone. Business-hour deadlines (support, sellers, returns) count only these hours.',
    valueType: 'weekly_hours',
    default: (['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const).map((weekday) => ({ weekday, opens: '08:00', closes: '20:00' })),
    exampleValue: true,
  },
  {
    key: 'support.closures',
    section: 'support_hours',
    label: 'Closures',
    description: 'Days support is closed or works reduced hours (holidays).',
    valueType: 'closures',
    default: [
      { date: '2026-11-26', label: 'Thanksgiving', kind: 'closed' },
      { date: '2026-12-25', label: 'Christmas Day', kind: 'closed' },
      { date: '2027-01-01', label: "New Year's Day", kind: 'closed' },
    ],
    exampleValue: true,
  },
  { key: 'support.phone', section: 'support_hours', label: 'Support phone', description: 'Phone number shown on the Help and contact pages.', valueType: 'string', default: '1-800-555-0136', exampleValue: true },
  { key: 'support.email', section: 'support_hours', label: 'Support email', description: 'Email address shown on the contact page (optional).', valueType: 'string', default: 'help@marketly.example', nullable: true, exampleValue: true },
  // checkout
  { key: 'checkout.guestCheckoutEnabled', section: 'checkout', label: 'Guest checkout', description: 'Customers can buy without an account.', valueType: 'bool', default: true, approval: 'business_owner', applyScopes: ['new_only'] },
  { key: 'checkout.offerAccountAfterGuestPurchase', section: 'checkout', label: 'Offer an account after a guest purchase', description: 'The confirmation page offers to create an account with the order email.', valueType: 'bool', default: true, applyScopes: ['new_only'] },
  // apps
  { key: 'apps.android.minVersionCode', section: 'apps', label: 'Minimum Android version code', description: 'Older apps must update before continuing.', valueType: 'int', default: 1, min: 1 },
  { key: 'apps.android.latestVersionCode', section: 'apps', label: 'Latest Android version code', description: 'Older apps are invited to update.', valueType: 'int', default: 1, min: 1 },
  { key: 'apps.android.latestVersionName', section: 'apps', label: 'Latest Android version name', description: 'Shown in the update prompt, e.g. 1.4.0.', valueType: 'string', default: '1.0.0' },
  { key: 'apps.android.updateUrl', section: 'apps', label: 'Android update link', description: 'Store page the update prompt opens.', valueType: 'string', default: 'https://play.google.com/store/apps/details?id=com.marketly.app', exampleValue: true },
  { key: 'apps.android.updateMessage', section: 'apps', label: 'Update message', description: 'Optional text in the update prompt.', valueType: 'text', default: null, nullable: true },
  {
    key: 'apps.maintenance',
    section: 'apps',
    label: 'Maintenance notice',
    description: 'Planned maintenance or a live incident note shown by the website, the app and the error pages. { active, kind: maintenance|incident, message, until }',
    valueType: 'json',
    default: { active: false, kind: null, message: null, until: null },
  },
];

/* ------------------------------------------------------------------ module-declared keys */

/** Modules whose runtime settings change what sellers sell, ship or earn: changes are announced to sellers. */
const SELLER_FACING_MODULES = new Set(['sellers', 'offers', 'orders', 'shipping', 'returns', 'finance', 'catalog', 'inventory', 'promotions', 'advertising', 'fulfillment-service']);
/** Modules whose runtime settings touch money, security or authority: a second reviewer approves changes. */
const SENSITIVE_MODULES = new Set(['access', 'identity', 'finance', 'payments', 'wallet', 'audit', 'trust']);

const isMoney = (v: unknown): v is { amount: number; currency: string } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { amount?: unknown }).amount === 'number' && typeof (v as { currency?: unknown }).currency === 'string' && Object.keys(v).length === 2;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function inferValueType(def: unknown): ValueType {
  if (typeof def === 'boolean') return 'bool';
  if (typeof def === 'number') return Number.isInteger(def) ? 'int' : 'number';
  if (typeof def === 'string') return TIME.test(def) ? 'time' : 'string';
  if (isMoney(def)) return 'money';
  return 'json';
}

/** "maxImagesPerProduct" → "Max images per product" */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .map((w) => (/^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()));
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function inferUnit(name: string): string | null {
  const n = name.toLowerCase();
  if (/businesshours$/.test(n)) return 'business hours';
  if (/businessdays$/.test(n)) return 'business days';
  if (/minutes$/.test(n)) return 'minutes';
  if (/seconds$/.test(n)) return 'seconds';
  if (/hours$/.test(n)) return 'hours';
  if (/days$/.test(n)) return 'days';
  if (/(percent|pct|rate)$/.test(n)) return '%';
  if (/mb$/.test(n)) return 'MB';
  return null;
}

export interface CatalogueOptions {
  /** Minimum notice for definitions that do not set one (settings.defaultMinLeadDays) */
  defaultMinLeadDays: number;
  /** Minimum notice for changes announced to sellers (settings.sellerVisibleMinLeadDays) */
  sellerVisibleMinLeadDays: number;
}

const leadDays = (explicit: number | undefined, sellerVisible: boolean, o: CatalogueOptions) =>
  Math.max(explicit ?? o.defaultMinLeadDays, sellerVisible ? o.sellerVisibleMinLeadDays : 0);

/** A module's spec setting as a definition: what the spec declares wins; only the rest is inferred. */
export function inferDefinition(module: string, name: string, declared: SettingDecl, available: boolean, o: CatalogueOptions): Definition {
  const valueType: ValueType = declared.type ?? inferValueType(declared.default);
  const numeric = valueType === 'int' || valueType === 'number' || valueType === 'duration';
  const sellerVisible = declared.sellerVisible ?? SELLER_FACING_MODULES.has(module);
  return {
    key: `${module}.${name}`,
    module,
    section: module,
    label: humanize(name),
    description: declared.desc,
    valueType,
    enumValues: valueType === 'enum' ? [...(declared.choices ?? [])] : [],
    unit: declared.unit ?? (numeric ? inferUnit(name) : null),
    default: declared.default,
    min: declared.min ?? (numeric ? 0 : null),
    max: declared.max ?? null,
    editable: declared.editable ?? true,
    approval: declared.approval ?? (SENSITIVE_MODULES.has(module) || valueType === 'money' ? 'second_reviewer' : 'none'),
    minLeadDays: leadDays(declared.minLeadDays, sellerVisible, o),
    applyScopes: ['new_only', 'open_commitments'],
    sellerVisible,
    public: false,
    exampleValue: false,
    editPermission: 'settings.changes.propose',
    nullable: declared.default === null,
    available,
    builtIn: false,
  };
}

/**
 * Every settable key: settings-owned keys plus every module spec's settings. Keys of disabled
 * modules are kept with available = false (get() still answers their default).
 */
export function buildCatalogue(specs: Readonly<Record<string, ModuleSpecDef>>, enabled: ReadonlySet<string>, o: CatalogueOptions): Map<string, Definition> {
  const out = new Map<string, Definition>();
  for (const spec of Object.values(specs)) {
    for (const [name, declared] of Object.entries(spec.settings)) {
      const d = inferDefinition(spec.name, name, declared, enabled.has(spec.name), o);
      out.set(d.key, d);
    }
  }
  for (const b of BUILT_INS) {
    const prefix = b.key.slice(0, b.key.indexOf('.'));
    const declaredBy = out.get(b.key); // e.g. checkout.guestCheckoutEnabled is also in the checkout spec
    const sellerVisible = b.sellerVisible ?? false;
    out.set(b.key, {
      key: b.key,
      module: declaredBy ? declaredBy.module : prefix === 'checkout' && specs.checkout ? 'checkout' : 'settings',
      section: b.section,
      label: b.label,
      description: b.description,
      valueType: b.valueType,
      enumValues: b.enumValues ?? [],
      unit: b.unit ?? null,
      default: declaredBy ? declaredBy.default : b.default,
      min: b.min ?? null,
      max: b.max ?? null,
      editable: b.editable ?? true,
      approval: b.approval ?? 'none',
      minLeadDays: leadDays(b.minLeadDays, sellerVisible, o),
      applyScopes: b.applyScopes ?? ['new_only', 'open_commitments'],
      sellerVisible,
      public: b.public ?? true,
      exampleValue: b.exampleValue ?? false,
      editPermission: 'settings.changes.propose',
      nullable: b.nullable ?? false,
      available: true,
      builtIn: true,
    });
  }
  return out;
}

/** The API shape of a definition (internal fields dropped). */
export function toApiDefinition(d: Definition): SettingDefinition {
  const { nullable: _n, available: _a, builtIn: _b, ...api } = d;
  return api;
}
