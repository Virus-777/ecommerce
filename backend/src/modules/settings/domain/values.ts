/**
 * Value rules (pure): validation of a proposed value against its definition, and the human text
 * shown on the settings page, in change items and in history.
 */
import { z } from 'zod';
import type { Closure, DayHours, MaintenanceNotice, ServiceRegion } from '../../../spec/settings.js';
import type { Definition } from './catalogue.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOSE_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const dayHours = z
  .object({ weekday: z.enum(WEEKDAYS), opens: z.string().regex(TIME, 'HH:MM'), closes: z.string().regex(CLOSE_TIME, 'HH:MM') })
  .strict()
  .refine((h) => h.opens < h.closes, { message: 'closes must be after opens', path: ['closes'] });

const closure = z
  .object({
    date: z.iso.date(),
    label: z.string().trim().min(1).max(80),
    kind: z.enum(['closed', 'reduced_hours']),
    opens: z.string().regex(TIME, 'HH:MM').nullish(),
    closes: z.string().regex(CLOSE_TIME, 'HH:MM').nullish(),
  })
  .strict()
  .refine((c) => c.kind === 'closed' || (c.opens && c.closes && c.opens < c.closes), { message: 'reduced hours need opens before closes', path: ['opens'] });

const serviceRegion = z
  .object({
    code: z.string().trim().min(1).max(20),
    label: z.string().trim().min(1).max(120),
    includedRegions: z.array(z.string().regex(/^[A-Z]{2}$/, 'two-letter state code')).min(1),
    note: z.string().max(200).nullish(),
  })
  .strict();

const maintenance = z
  .object({
    active: z.boolean(),
    kind: z.enum(['maintenance', 'incident']).nullish(),
    message: z.string().max(500).nullish(),
    until: z.iso.datetime({ offset: true }).nullish(),
    updatedAt: z.iso.datetime({ offset: true }).nullish(),
  })
  .strict()
  .refine((m) => !m.active || (m.kind && m.message), { message: 'an active notice needs a kind and a message', path: ['message'] });

const money = z.object({ amount: z.number().int().min(0), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.includes('/') || tz === 'UTC';
  } catch {
    return false;
  }
};
const isLocale = (l: string) => {
  try {
    return Intl.getCanonicalLocales(l).length === 1;
  } catch {
    return false;
  }
};

/**
 * media.productImage (the product image spec): the same rules as the Admin Center (validateProductImageSetting in
 * web-shared) and media (domain/image-spec.ts). The ratio is W:H with whole numbers 1–32, height ÷ width 0.5–2.
 */
const RATIO = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/;
const ratioParts = (s: string) => {
  const m = RATIO.exec(s);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
};
const productImage = z
  .object({
    aspectRatio: z
      .string()
      .refine((s) => {
        const r = ratioParts(s);
        return !!r && r.w >= 1 && r.h >= 1 && r.w <= 32 && r.h <= 32;
      }, 'Enter the ratio as width:height with whole numbers 1–32, for example 1:1 or 4:5')
      .refine((s) => {
        const r = ratioParts(s);
        return !r || !r.w || (r.h / r.w >= 0.5 && r.h / r.w <= 2);
      }, 'Use a ratio between 2:1 (wide) and 1:2 (tall)'),
    detailWidth: z.number().int('Enter a whole number of pixels').min(480, 'At least 480 px').max(2048, 'At most 2048 px'),
    thumbnailWidth: z.number().int('Enter a whole number of pixels').min(120, 'At least 120 px').max(640, 'At most 640 px'),
    quality: z.number().int('Enter a whole number').min(50, 'At least 50').max(95, 'At most 95'),
  })
  .strict()
  .refine((v) => v.thumbnailWidth < v.detailWidth, { message: 'Make the thumbnail smaller than the product-page image', path: ['thumbnailWidth'] });

/** Extra checks for particular keys (settings-owned, and module keys whose shape a json type can't express) */
const KEY_RULES: Record<string, z.ZodType> = {
  'media.productImage': productImage,
  'market.country': z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code, e.g. US'),
  'market.currency': z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. USD'),
  'market.timeZone': z.string().refine(isTimeZone, 'an IANA time zone, e.g. America/Los_Angeles'),
  'market.locale': z.string().refine(isLocale, 'a locale, e.g. en-US'),
  'market.serviceRegion': serviceRegion,
  'support.email': z.email().nullable(),
  'market.helpEmail': z.email().nullable(),
  'market.sellersEmail': z.email().nullable(),
  'market.pressEmail': z.email().nullable(),
  'market.defaultDeliveryLocation': z.object({ postalCode: z.string().regex(/^\d{5}(-\d{4})?$/, 'a ZIP code, e.g. 97205'), label: z.string().trim().min(1, 'a label, e.g. Portland, OR 97205') }).strict(),
  'support.phone': z.string().regex(/^[0-9+()\-. ]{5,30}$/, 'a phone number'),
  'apps.android.updateUrl': z.url({ protocol: /^https?$/ }),
  'apps.android.latestVersionName': z.string().regex(/^\d+(\.\d+){0,3}([-+][\w.]+)?$/, 'a version name such as 1.4.0'),
  'apps.maintenance': maintenance,
};

export interface Issue {
  path: string;
  message: string;
}

const zodIssues = (path: string, err: z.ZodError): Issue[] =>
  err.issues.map((i) => ({ path: [path, ...i.path.map(String)].join('.'), message: i.message }));

/** Problems with a value for a definition ([] = valid). `path` prefixes issue paths (e.g. items.0.value). */
export function validateValue(def: Definition, value: unknown, path = 'value'): Issue[] {
  if (value === undefined) return [{ path, message: 'A value is required' }];
  if (value === null) return def.nullable ? [] : [{ path, message: 'A value is required' }];
  const bad = (message: string): Issue[] => [{ path, message }];
  const inRange = (n: number): Issue[] => {
    if (def.min != null && n < def.min) return bad(`Must be at least ${def.min}`);
    if (def.max != null && n > def.max) return bad(`Must be at most ${def.max}`);
    return [];
  };
  let issues: Issue[] = [];
  switch (def.valueType) {
    case 'bool':
      if (typeof value !== 'boolean') return bad('Must be true or false');
      break;
    case 'int':
    case 'duration':
      if (typeof value !== 'number' || !Number.isInteger(value)) return bad('Must be a whole number');
      issues = inRange(value);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return bad('Must be a number');
      issues = inRange(value);
      break;
    case 'string':
      if (typeof value !== 'string' || !value.trim()) return bad('Must be a non-empty text');
      if (value.length > 500) return bad('Must be 500 characters or fewer');
      break;
    case 'text':
      if (typeof value !== 'string') return bad('Must be a text');
      if (value.length > 5000) return bad('Must be 5000 characters or fewer');
      break;
    case 'time':
      if (typeof value !== 'string' || !TIME.test(value)) return bad('Must be a time as HH:MM');
      break;
    case 'enum':
      if (typeof value !== 'string' || !def.enumValues.includes(value)) return bad(`Must be one of ${def.enumValues.join(', ')}`);
      break;
    case 'money': {
      const r = money.safeParse(value);
      if (!r.success) return zodIssues(path, r.error);
      // min and max of a money setting are amounts in minor units
      if (def.min != null && r.data.amount < def.min) return bad(`Must be at least ${moneyText({ currency: r.data.currency, amount: def.min })}`);
      if (def.max != null && r.data.amount > def.max) return bad(`Must be at most ${moneyText({ currency: r.data.currency, amount: def.max })}`);
      break;
    }
    case 'weekly_hours': {
      const r = z.array(dayHours).max(21).safeParse(value);
      if (!r.success) return zodIssues(path, r.error);
      issues = overlaps(r.data).map((message) => ({ path, message }));
      break;
    }
    case 'closures': {
      const r = z.array(closure).max(366).safeParse(value);
      if (!r.success) return zodIssues(path, r.error);
      const dates = r.data.map((c) => c.date);
      const dup = dates.find((d, i) => dates.indexOf(d) !== i);
      if (dup) return bad(`${dup} is listed twice`);
      break;
    }
    case 'json': {
      // a module's json setting keeps the shape of its default (object, list, text or number)
      const shape = (v: unknown) => (Array.isArray(v) ? 'list' : v === null ? 'null' : typeof v);
      if (!def.builtIn && def.default !== null && shape(value) !== shape(def.default)) return bad(`Must be a ${shape(def.default)} like the default`);
      break;
    }
  }
  if (issues.length) return issues;
  const rule = KEY_RULES[def.key];
  if (rule) {
    const r = rule.safeParse(value);
    if (!r.success) return zodIssues(path, r.error);
  }
  return [];
}

function overlaps(hours: z.infer<typeof dayHours>[]): string[] {
  const out: string[] = [];
  for (const day of WEEKDAYS) {
    const list = hours.filter((h) => h.weekday === day).sort((a, b) => a.opens.localeCompare(b.opens));
    for (let i = 1; i < list.length; i++) if (list[i]!.opens < list[i - 1]!.closes) out.push(`Hours overlap on ${day}`);
  }
  return out;
}

/** Values compare by their JSON form */
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ------------------------------------------------------------------ text */

const DAY_LABEL: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const DAY_NAME: Record<string, string> = { mon: 'Mondays', tue: 'Tuesdays', wed: 'Wednesdays', thu: 'Thursdays', fri: 'Fridays', sat: 'Saturdays', sun: 'Sundays' };

/** "14:00" → "2:00 PM" */
export function timeText(hhmm: string, short = false): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  if (h === 24 && m === 0) return short ? '12 AM' : '12:00 AM';
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return short && m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** Short zone name, e.g. PT for America/Los_Angeles */
export function zoneAbbreviation(timeZone: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortGeneric' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** "Mon–Sat, 8:00 AM – 8:00 PM PT" (consecutive days with the same hours are grouped) */
export function hoursLabel(hours: DayHours[], timeZone: string, short = false): string {
  if (!hours.length) return 'Closed';
  const span = (d: DayHours[]) => d.map((h) => (short ? `${timeText(h.opens, true)}–${timeText(h.closes, true)}` : `${timeText(h.opens)} – ${timeText(h.closes)}`)).join(', ');
  const groups: { from: string; to: string; text: string }[] = [];
  for (const day of WEEKDAYS) {
    const list = hours.filter((h) => h.weekday === day).sort((a, b) => a.opens.localeCompare(b.opens));
    if (!list.length) continue;
    const text = span(list);
    const last = groups.at(-1);
    if (last && last.text === text && WEEKDAYS.indexOf(last.to as (typeof WEEKDAYS)[number]) === WEEKDAYS.indexOf(day) - 1) last.to = day;
    else groups.push({ from: day, to: day, text });
  }
  const tz = zoneAbbreviation(timeZone);
  return `${groups.map((g) => `${g.from === g.to ? DAY_LABEL[g.from] : `${DAY_LABEL[g.from]}–${DAY_LABEL[g.to]}`}, ${g.text}`).join('; ')} ${tz}`;
}

/** "Closed Sundays and US holidays" */
export function closedLabel(hours: DayHours[], closures: Closure[], country: string): string | null {
  const closedDays = WEEKDAYS.filter((d) => !hours.some((h) => h.weekday === d)).map((d) => DAY_NAME[d]!);
  const parts = [...closedDays];
  if (closures.length) parts.push(`${country} holidays`);
  if (!parts.length) return null;
  return `Closed ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`}`;
}

/** "Nov 1, 2026" in a time zone */
export function dateText(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(at));
}

const moneyText = (m: { amount: number; currency: string }) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency }).format(m.amount / 100);

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Human text of a value: On/Off, "$7.99", "15 minutes", "Mon–Sat, 8:00 AM – 8:00 PM PT"… */
export function valueText(def: Pick<Definition, 'valueType' | 'unit' | 'key'>, value: unknown, timeZone = 'America/Los_Angeles'): string {
  if (value === null || value === undefined) return 'Not set';
  switch (def.valueType) {
    case 'bool':
      return value ? 'On' : 'Off';
    case 'int':
    case 'number':
    case 'duration':
      return typeof value === 'number' ? `${value.toLocaleString('en-US')}${def.unit ? (def.unit === '%' ? '%' : ` ${def.unit}`) : ''}` : String(value);
    case 'money':
      return typeof value === 'object' && value && 'amount' in value ? moneyText(value as { amount: number; currency: string }) : JSON.stringify(value);
    case 'time':
      return typeof value === 'string' && TIME.test(value) ? timeText(value) : String(value);
    case 'weekly_hours':
      return Array.isArray(value) ? hoursLabel(value as DayHours[], timeZone) : String(value);
    case 'closures': {
      if (!Array.isArray(value)) return String(value);
      const list = value as Closure[];
      if (!list.length) return 'No closures';
      return clip(`${list.length} ${list.length === 1 ? 'day' : 'days'}: ${list.map((c) => c.label).join(', ')}`);
    }
    case 'string':
    case 'text':
    case 'enum':
      return clip(String(value));
    case 'json':
      if (def.key === 'market.serviceRegion') return (value as ServiceRegion).label ?? clip(JSON.stringify(value));
      if (def.key === 'apps.maintenance') {
        const m = value as MaintenanceNotice;
        return m.active ? clip(`${m.kind === 'incident' ? 'Incident' : 'Maintenance'}: ${m.message ?? ''}`) : 'Off';
      }
      return clip(JSON.stringify(value));
  }
}
