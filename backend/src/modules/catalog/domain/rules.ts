/**
 * Pure catalog rules (no I/O): slugs, what blocks a submission, the content score, identifier
 * formats, claim and restricted-item scanning, image standards, review deadlines and variant labels.
 */
import type { ImageRules } from '../../../spec/media.js';
import type { Attribute, ImageRule } from '../../../spec/catalog.js';

/* ------------------------------------------------------------------ text */

/** Lower-case, accents and punctuation removed, single spaces: for name and title comparisons */
export const normalize = (s: string | null | undefined) =>
  (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Model numbers compare without spaces, dashes and case: HA-ANC700 = ha anc700 */
export const normalizeModel = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const words = (s: string) => new Set(normalize(s).split(' ').filter((w) => w.length > 2));

/** Jaccard similarity of the words of two titles (0–1) */
export function titleSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** "Midnight black / 128 GB" */
export const variantLabel = (options: Record<string, string>) => Object.values(options).filter(Boolean).join(' / ') || 'Standard';

export const sameOptions = (a: Record<string, string>, b: Record<string, string>) => {
  const norm = (o: Record<string, string>) =>
    JSON.stringify(
      Object.entries(o)
        .map(([k, v]) => [normalize(k), normalize(v)])
        .sort(([x], [y]) => (x! < y! ? -1 : 1)),
    );
  return norm(a) === norm(b);
};

/* ------------------------------------------------------------------ identifiers */

/** GTIN-8, UPC-A (12), EAN-13 or GTIN-14 with a valid check digit */
export function gtinValid(gtin: string): boolean {
  if (!/^\d+$/.test(gtin) || ![8, 12, 13, 14].includes(gtin.length)) return false;
  const digits = gtin.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/* ------------------------------------------------------------------ completeness */

export interface ContentInput {
  title: string;
  brandId: string | null;
  requestedBrand: unknown | null;
  categoryId: string | null;
  description: string;
  keyFeatures: string[];
  specs: Record<string, string>;
  imageCount: number;
  modelNumber: string | null;
  mpn: string | null;
  noGtin: boolean;
  variants: { options: Record<string, string>; gtin: string | null }[];
}

export interface Completeness {
  /** Human labels of what blocks submission */
  missing: string[];
  issues: { path: string; message: string }[];
  /** 0–100 */
  score: number;
}

/** A spec value or a variant option for an attribute (variant-defining attributes live on variants) */
export function attributeFilled(attr: Pick<Attribute, 'name' | 'variantDefining'>, specs: Record<string, string>, variants: { options: Record<string, string> }[]): boolean {
  const key = normalize(attr.name);
  const hasSpec = Object.entries(specs).some(([k, v]) => normalize(k) === key && v != null && String(v).trim() !== '');
  if (hasSpec) return true;
  if (!attr.variantDefining || !variants.length) return false;
  return variants.every((v) => Object.entries(v.options).some(([k, val]) => normalize(k) === key && String(val).trim() !== ''));
}

/**
 * What blocks submission (title, brand, category, description of minDescription characters, one image,
 * one variant, a GTIN on every variant unless noGtin, required category attributes) and the content score:
 * basics 10, required attributes 25, images against the category standard 20, description 20,
 * identifiers 15, key features 10.
 */
export function completeness(p: ContentInput, opts: { requiredAttributes: Pick<Attribute, 'name' | 'variantDefining'>[]; minDescription: number; minImages: number }): Completeness {
  const missing: string[] = [];
  const issues: { path: string; message: string }[] = [];
  const add = (path: string, label: string, message: string) => {
    missing.push(label);
    issues.push({ path, message });
  };
  if (!p.title.trim()) add('title', 'Title', 'Add a title');
  if (!p.brandId && !p.requestedBrand) add('brandId', 'Brand', 'Choose a brand or request one');
  if (!p.categoryId) add('categoryId', 'Category', 'Choose a category');
  const descLength = p.description.trim().length;
  if (descLength < opts.minDescription) add('description', `Description of at least ${opts.minDescription} characters`, `The description needs at least ${opts.minDescription} characters (${descLength} now)`);
  if (p.imageCount < 1) add('imageIds', 'At least one image', 'Add at least one image');
  if (!p.variants.length) add('variants', 'At least one variant', 'Add at least one variant');
  if (!p.noGtin && p.variants.some((v) => !v.gtin)) add('variants.gtin', 'GTIN on every variant', 'Add a GTIN to every variant, or confirm the product has no GTIN');
  let filled = 0;
  for (const attr of opts.requiredAttributes) {
    if (attributeFilled(attr, p.specs, p.variants)) filled++;
    else add(`specs.${attr.name}`, attr.name, `${attr.name} is required in this category`);
  }

  const basics = [p.title.trim(), p.brandId || p.requestedBrand, p.categoryId, p.variants.length].filter(Boolean).length / 4;
  const attrs = opts.requiredAttributes.length ? filled / opts.requiredAttributes.length : p.categoryId ? 1 : 0;
  const images = Math.min(p.imageCount / Math.max(opts.minImages, 1), 1);
  const desc = Math.min(descLength / Math.max(opts.minDescription, 1), 1);
  const gtins = p.variants.length && (p.noGtin || p.variants.every((v) => v.gtin)) ? 1 : 0;
  const identifiers = (p.modelNumber || p.mpn ? 1 / 3 : 0) + (gtins * 2) / 3;
  const features = Math.min(p.keyFeatures.filter((f) => f.trim()).length / 3, 1);
  const score = Math.round(basics * 10 + attrs * 25 + images * 20 + desc * 20 + identifiers * 15 + features * 10);
  return { missing, issues, score: Math.max(0, Math.min(100, score)) };
}

/* ------------------------------------------------------------------ automated checks: text */

export interface ClaimHit {
  field: string;
  text: string;
  kind: 'medical' | 'safety' | 'superlative';
}

const CLAIMS: { kind: ClaimHit['kind']; re: RegExp }[] = [
  { kind: 'medical', re: /\b(fda[- ]approved|clinically proven|cures?|heals?|treats? (?:cancer|diabetes|anxiety|depression|covid|disease)|prevents? (?:cancer|disease|infection|covid)|medical[- ]grade cure|anti[- ]?viral protection)\b/i },
  { kind: 'safety', re: /\b(100% safe|completely safe|totally safe|non[- ]toxic guaranteed|fire ?proof|bullet ?proof|child[- ]proof guaranteed|zero risk)\b/i },
  { kind: 'superlative', re: /(#1\b|\bnumber one\b|\bbest in the world\b|\bworld'?s best\b|\bbest ever\b|\bguaranteed results\b|\bunbeatable\b)/i },
];

/** Medical, safety and superlative claims in title, key features and description */
export function findClaims(fields: Record<string, string | string[]>): ClaimHit[] {
  const hits: ClaimHit[] = [];
  for (const [field, value] of Object.entries(fields)) {
    for (const text of Array.isArray(value) ? value : [value]) {
      for (const c of CLAIMS) {
        const m = c.re.exec(text ?? '');
        if (m) hits.push({ field, text: m[0], kind: c.kind });
      }
    }
  }
  return hits;
}

const RESTRICTED = /\b(firearms?|guns?|ammunition|ammo|explosives?|tobacco|cigarettes?|vapes?|e-?cigarettes?|nicotine|alcohol|liquor|prescription|rx only|pesticides?|knives?|switchblades?|pepper spray|tasers?|cannabis|cbd|thc|lithium battery pack|hoverboards?)\b/i;

/** Restricted keywords in title and description (restricted_item check) */
export function findRestricted(fields: Record<string, string | string[]>): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  for (const [field, value] of Object.entries(fields)) {
    for (const text of Array.isArray(value) ? value : [value]) {
      const m = RESTRICTED.exec(text ?? '');
      if (m) out.push({ field, text: m[0] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ image standards */

type CheckParams = Partial<ImageRules> & { minCount?: number };

/** Machine-checkable parameters of the blocking rules merged into one media.checkImage rule set */
export function imageRulesOf(rules: ImageRule[], severity: 'blocking' | 'warning' = 'blocking'): { rules: ImageRules; minCount: number; minWidth: number } | null {
  const checks = rules.filter((r) => r.severity === severity && r.check && typeof r.check === 'object').map((r) => r.check as CheckParams);
  if (!checks.length) return null;
  const out: ImageRules = { aspectRatios: [], formats: [] };
  let minCount = 1;
  const max = (a: number | null | undefined, b: number | null | undefined) => (a == null ? (b ?? null) : b == null ? a : Math.max(a, b));
  const min = (a: number | null | undefined, b: number | null | undefined) => (a == null ? (b ?? null) : b == null ? a : Math.min(a, b));
  for (const c of checks) {
    out.minWidth = max(out.minWidth, c.minWidth);
    out.minHeight = max(out.minHeight, c.minHeight);
    out.minShortSide = max(out.minShortSide, c.minShortSide);
    out.maxBytes = min(out.maxBytes, c.maxBytes);
    if (Array.isArray(c.aspectRatios)) out.aspectRatios = [...new Set([...out.aspectRatios, ...c.aspectRatios.map(String)])];
    if (Array.isArray(c.formats)) out.formats = [...new Set([...out.formats, ...c.formats.map(String)])];
    if (c.aspectTolerance != null) out.aspectTolerance = c.aspectTolerance;
    if (c.background) out.background = c.background;
    if (c.allowWatermark != null) out.allowWatermark = c.allowWatermark;
    if (c.allowTextOverlay != null) out.allowTextOverlay = c.allowTextOverlay;
    if (typeof c.minCount === 'number' && c.minCount > minCount) minCount = c.minCount;
  }
  return { rules: out, minCount, minWidth: out.minWidth ?? 0 };
}

/* ------------------------------------------------------------------ review deadlines */

/** Business days after an instant (Saturday and Sunday skipped), same time of day */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

/** Internal review target (orders the queue) and the date shown to the submitter */
/** The expected review date shown to the submitter is one business day after the internal target (setting reviewTargetBusinessDays) */
export const EXPECTED_REVIEW_MARGIN_BUSINESS_DAYS = 1;
/** Positive whole numbers for weight and packaged dimensions (grams, centimetres) */
export const PARCEL_FIELDS = ['weightGrams', 'lengthCm', 'widthCm', 'heightCm'] as const;
export const PARCEL_COLUMNS = { weightGrams: 'weight_grams', lengthCm: 'length_cm', widthCm: 'width_cm', heightCm: 'height_cm' } as const;
export const MAX_PARCEL_VALUE = { weightGrams: 1_000_000, lengthCm: 1_000, widthCm: 1_000, heightCm: 1_000 } as const;
const DUE_SOON_MS = 4 * 3_600_000;

export function deadlineState(dueAt: Date, now: Date): 'on_time' | 'due_soon' | 'overdue' {
  if (now.getTime() > dueAt.getTime()) return 'overdue';
  if (dueAt.getTime() - now.getTime() <= DUE_SOON_MS) return 'due_soon';
  return 'on_time';
}

/* ------------------------------------------------------------------ matching */

export type MatchQuality = 'exact' | 'same_model_different_bundle' | 'different_model' | 'title_only';

/**
 * How a catalog product matches what the seller searched: the same model (exact, or with other box
 * contents when the model carries a bundle suffix such as HA-ANC700-TB), a close but different model,
 * or a title-only hit.
 */
export function matchQuality(query: string, product: { modelNumber: string | null }): { quality: MatchQuality; matchedOn: 'model' | 'title' } {
  const q = normalizeModel(query);
  const m = normalizeModel(product.modelNumber);
  if (!m || !q) return { quality: 'title_only', matchedOn: 'title' };
  if (q === m) return { quality: 'exact', matchedOn: 'model' };
  if (q.startsWith(m) || m.startsWith(q)) return { quality: 'same_model_different_bundle', matchedOn: 'model' };
  const tokens = query.split(/\s+/).map(normalizeModel).filter((t) => t.length >= 3);
  if (tokens.includes(m)) return { quality: 'exact', matchedOn: 'model' };
  if (tokens.some((t) => t.startsWith(m) || m.startsWith(t))) return { quality: 'same_model_different_bundle', matchedOn: 'model' };
  const prefix = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  if (tokens.some((t) => /\d/.test(t) && prefix(t, m) >= Math.min(4, m.length - 1))) return { quality: 'different_model', matchedOn: 'model' };
  return { quality: 'title_only', matchedOn: 'title' };
}

/* ------------------------------------------------------------------ corrections */

/** Fields a seller may suggest a correction to; specs.<Attribute> too */
export const CORRECTABLE_FIELDS = ['title', 'description', 'keyFeatures', 'includedItems', 'modelNumber', 'manufacturerPartNumber', 'brand', 'category', 'images', 'variants', 'video'] as const;
/** Accepted corrections to these change what the product is: the product goes back to review (reopen) */
export const IDENTITY_FIELDS = ['modelNumber', 'manufacturerPartNumber', 'brand', 'category', 'variants'];

export const isCorrectableField = (field: string) => (CORRECTABLE_FIELDS as readonly string[]).includes(field) || /^specs\.[^.].*$/.test(field);

/** Lists (key features, in-the-box) are proposed one item per line */
export const linesOf = (text: string) =>
  text
    .split(/\r?\n|;/)
    .map((l) => l.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean);
