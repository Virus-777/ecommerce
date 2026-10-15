/**
 * Pure content rules: rich-text sanitizing, safe links, slugs, schedule labels, reading time,
 * policy version numbers and the policy diff. No I/O.
 */

/* ------------------------------------------------------------------ rich text */

/** Tags the store renders from Content Manager text (headings, lists, tables, links). Everything else is dropped. */
const ALLOWED_TAGS = new Set(['p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'blockquote', 'code', 'pre', 'span', 'hr', 'small', 'sup', 'sub']);
const VOID_TAGS = new Set(['br', 'hr']);
/** Dropped together with everything inside them */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'textarea', 'select', 'form', 'frameset', 'frame', 'head', 'title', 'xmp', 'plaintext', 'noembed', 'applet']);

const escapeText = (s: string) => s.replace(/&(?!#?[a-zA-Z0-9]{1,10};)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Decodes the entities a browser would decode in an attribute, so `jav&#x61;script:` is seen for what it is */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&amp;/gi, '&');
}

/** Store paths, anchors, http(s), mailto and tel links. javascript:, data: and protocol-relative URLs are refused. */
export function isSafeUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  // browsers ignore control characters and whitespace inside the scheme
  const u = decodeEntities(url).replace(/[\u0000- \u007f-\u009f]/g, '');
  if (!u) return false;
  if (/^\/(?![/\\])/.test(u) || u.startsWith('#') || u.startsWith('?')) return true;
  return /^(https?:\/\/[^\s/]|mailto:|tel:)/i.test(u);
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function cleanAttributes(tag: string, raw: string): string {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  const seen = new Set<string>();
  while ((m = ATTR_RE.exec(raw))) {
    const name = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (seen.has(name)) continue;
    seen.add(name);
    if (tag === 'a' && name === 'href') {
      if (isSafeUrl(value)) out.push(`href="${escapeAttr(decodeEntities(value).trim())}"`);
    } else if (tag === 'a' && name === 'title') {
      out.push(`title="${escapeAttr(value)}"`);
    } else if (tag === 'a' && name === 'target' && value === '_blank') {
      out.push('target="_blank"', 'rel="noopener noreferrer"');
    } else if ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan') && /^\d{1,2}$/.test(value)) {
      out.push(`${name}="${value}"`);
    } else if (tag === 'th' && name === 'scope' && /^(row|col|rowgroup|colgroup)$/.test(value)) {
      out.push(`scope="${value}"`);
    }
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/**
 * Allow-list sanitizer for the rich text the store renders (help articles, policies, page blocks):
 * keeps headings, paragraphs, lists, tables and safe links; drops scripts, styles, frames, event
 * handlers, inline styles and unsafe URLs; balances the tags it keeps. Idempotent.
 */
export function sanitizeHtml(input: string | null | undefined): string {
  if (!input) return '';
  const src = String(input).replace(/\u0000/g, '');
  const out: string[] = [];
  const open: string[] = [];
  let dropping: { tag: string; depth: number } | null = null;
  const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const text = (s: string) => {
    if (!dropping && s) out.push(escapeText(s));
  };
  while ((m = TOKEN.exec(src))) {
    text(src.slice(last, m.index));
    last = TOKEN.lastIndex;
    const tagName = m[2]?.toLowerCase();
    if (!tagName) continue; // comment, doctype, CDATA, processing instruction
    const closing = m[1] === '/';
    if (dropping) {
      if (tagName === dropping.tag) dropping.depth += closing ? -1 : 1;
      if (dropping.depth === 0) dropping = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tagName)) {
      if (!closing && !/\/\s*$/.test(m[3] ?? '')) dropping = { tag: tagName, depth: 1 };
      continue;
    }
    if (!ALLOWED_TAGS.has(tagName)) continue; // the tag goes, its text stays
    if (VOID_TAGS.has(tagName)) {
      if (!closing) out.push(`<${tagName}>`);
      continue;
    }
    if (closing) {
      const at = open.lastIndexOf(tagName);
      if (at < 0) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    out.push(`<${tagName}${cleanAttributes(tagName, m[3] ?? '')}>`);
    open.push(tagName);
  }
  text(src.slice(last));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}

/** Strings inside table JSON are sanitized the same way; other values pass through */
export function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === 'string') return sanitizeHtml(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeJson(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeJson(v, depth + 1)]));
  return value;
}

/**
 * Tables of an article or policy as ContentTable[]: cells become plain text; entries that are not
 * { columns: string[], rows: string[][] } (stored before the type existed) are left out.
 */
export function contentTables(value: unknown): { caption: string | null; columns: string[]; rows: string[][]; note: string | null }[] {
  if (!Array.isArray(value)) return [];
  const cell = (c: unknown) => (typeof c === 'string' ? plainText(c) : typeof c === 'number' || typeof c === 'boolean' ? String(c) : '');
  const text = (t: unknown) => (typeof t === 'string' && plainText(t) ? plainText(t) : null);
  return value.flatMap((t) => {
    if (!t || typeof t !== 'object') return [];
    const { caption, columns, rows, note } = t as Record<string, unknown>;
    if (!Array.isArray(columns) || !Array.isArray(rows) || !rows.every(Array.isArray)) return [];
    return [{ caption: text(caption), columns: columns.map(cell), rows: (rows as unknown[][]).map((r) => r.map(cell)), note: text(note) }];
  });
}

/** Text without tags (search index, reading time, diffs) */
export function plainText(html: string | null | undefined): string {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** About 200 words a minute, at least 1 */
export function readMinutes(html: string | null | undefined): number {
  const words = plainText(html).split(' ').filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

/* ------------------------------------------------------------------ slugs */

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export const isValidSlug = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 120;

/* ------------------------------------------------------------------ schedules */

function fmt(at: Date, timeZone: string, withTime: boolean): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(at);
    return parts.replace(' at ', ', ');
  } catch {
    return at.toISOString();
  }
}

/** e.g. "Oct 9, 6:00 AM – Oct 31"; "Always on"; "Follows campaign" */
export function scheduleLabel(from: Date | null, to: Date | null, timeZone: string, opts: { followsCampaign?: boolean } = {}): string {
  if (from && to) return `${fmt(from, timeZone, true)} – ${fmt(to, timeZone, false)}`;
  if (from) return `From ${fmt(from, timeZone, true)}`;
  if (to) return `Until ${fmt(to, timeZone, false)}`;
  return opts.followsCampaign ? 'Follows campaign' : 'Always on';
}

export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Inside [from, to) at a moment */
export const inWindow = (at: Date, from: Date | string | null | undefined, to: Date | string | null | undefined) =>
  (!from || new Date(from).getTime() <= at.getTime()) && (!to || new Date(to).getTime() > at.getTime());

/* ------------------------------------------------------------------ policy versions */

const parseVersion = (v: string): [number, number] | null => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
};

/** The next minor number after the highest version, e.g. 3.0 → 3.1; 1.0 for a new policy */
export function nextMinorVersion(existing: readonly string[]): string {
  let best: [number, number] | null = null;
  for (const v of existing) {
    const p = parseVersion(v);
    if (p && (!best || p[0] > best[0] || (p[0] === best[0] && p[1] > best[1]))) best = p;
  }
  return best ? `${best[0]}.${best[1] + 1}` : '1.0';
}

export const isValidVersionLabel = (v: string) => /^\d{1,4}(?:\.\d{1,4}){0,2}$/.test(v.trim());

/**
 * Word diff of two texts with <ins>/<del> markup (text escaped). Large texts fall back to a
 * paragraph diff so the comparison stays bounded.
 */
export function diffHtml(before: string, after: string): string {
  const a = plainTextBlocks(before);
  const b = plainTextBlocks(after);
  const words = (s: string[]) => s.join('\n').split(/(\s+)/).filter((t) => t.length > 0);
  let x = words(a);
  let y = words(b);
  if (x.length * y.length > 4_000_000) {
    x = a;
    y = b;
  }
  const ops = lcsDiff(x, y);
  const out: string[] = [];
  for (const op of ops) {
    const t = escapeHtml(op.text).replace(/\n/g, '<br>');
    out.push(op.kind === 'same' ? t : op.kind === 'ins' ? `<ins>${t}</ins>` : `<del>${t}</del>`);
  }
  return out.join('');
}

function plainTextBlocks(html: string): string[] {
  return String(html ?? '')
    .split(/<\/(?:p|h\d|li|tr|blockquote|pre)>|<br\s*\/?>|\n{2,}/i)
    .map((p) => plainText(p))
    .filter(Boolean);
}

function lcsDiff(x: string[], y: string[]): { kind: 'same' | 'ins' | 'del'; text: string }[] {
  const n = x.length;
  const m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: { kind: 'same' | 'ins' | 'del'; text: string }[] = [];
  const push = (kind: 'same' | 'ins' | 'del', text: string) => {
    const lastOp = ops.at(-1);
    if (lastOp && lastOp.kind === kind) lastOp.text += text;
    else ops.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push('same', x[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push('del', x[i++]!);
    else push('ins', y[j++]!);
  }
  while (i < n) push('del', x[i++]!);
  while (j < m) push('ins', y[j++]!);
  return ops;
}

/* ------------------------------------------------------------------ homepage sections */

export const SECTION_KIND_LABEL: Record<string, string> = {
  campaign_banner: 'Campaign banner',
  category_shortcuts: 'Category shortcuts',
  deals: 'Flash deals',
  official_highlights: 'Official Store highlights',
  featured_products: 'Featured products',
  featured_sellers: 'Featured sellers',
  new_arrivals: 'New arrivals',
  popular_products: 'Popular products',
  brand_collections: 'Brand collections',
  recently_viewed: 'Recently viewed',
  collection_teaser: 'Collection',
  promise_strip: 'Our promise',
  ad_position: 'Ad position',
};

/** Kinds whose products come from a product source */
export const PRODUCT_KINDS = new Set(['featured_products', 'official_highlights', 'new_arrivals', 'popular_products', 'collection_teaser']);

/** Default rule for rule-based kinds when no source is set */
export const DEFAULT_RULES: Record<string, { kind: 'new_arrivals' | 'best_sellers' | 'official_store'; description: string; days?: number }> = {
  new_arrivals: { kind: 'new_arrivals', days: 30, description: 'Products first listed in the last 30 days, newest first.' },
  popular_products: { kind: 'best_sellers', days: 30, description: "Ranked by units sold in the last 30 days across all sellers. Sponsored placements don't affect rank." },
  official_highlights: { kind: 'official_store', description: 'Official Store products in stock, picked by the Content team.' },
};

export const RULE_DESCRIPTIONS: Record<string, string> = {
  new_arrivals: 'Products first listed in the last 30 days, newest first.',
  best_sellers: "Ranked by units sold in the last 30 days across all sellers. Sponsored placements don't affect rank.",
  top_sellers_in_category: "Top sellers in the category by units sold in the last 30 days. Sponsored placements don't affect rank.",
  official_store: 'Official Store products in stock.',
  deals: 'Products with a live deal price.',
};

export const DEFAULT_AD_POSITIONS: { key: string; name: string }[] = [
  { key: 'opening_fullscreen', name: 'Opening full-screen ad' },
  { key: 'home_banner', name: 'Sponsored brand banner' },
];

export const HOMEPAGE_ID = '0c0a7e7e-0000-4000-8000-000000000001';

/* ------------------------------------------------------------------ contact channels */

/** A contact channel as support describes it (support.ContactChannel) */
export interface SupportChannel {
  kind: string;
  label: string;
  expectedResponse: string;
  available: boolean;
  hours: string;
}

/** content.ContactChannel (kept local so the rules stay free of generated imports) */
export interface HelpContactChannel {
  kind: 'phone' | 'message' | 'email';
  label: string;
  hours: string;
  detail: string;
  action: { label: string; url: string; kind: 'help' | 'external' };
}

/**
 * The Help Center's contact channels: support's channels as support gives them (owner decision G31c), else phone
 * and a message. Live chat is never shown (decision G7), nor a kind content does not know.
 */
export function contactChannelsFrom(offered: readonly SupportChannel[] | null, o: { hours: string; phone: string; email: string | null; contactUrl: string }): HelpContactChannel[] {
  const write = { label: 'Write to us', url: o.contactUrl, kind: 'help' as const };
  const call = (label: string, hours: string): HelpContactChannel[] =>
    o.phone ? [{ kind: 'phone', label, hours, detail: o.phone, action: { label: o.phone, url: `tel:${o.phone.replace(/[^\d+]/g, '')}`, kind: 'external' } }] : [];
  if (!offered) return [...call('Call us', o.hours), { kind: 'message', label: 'Send a message', hours: 'Any time', detail: 'We reply within one business day', action: write }];
  return offered.flatMap((c): HelpContactChannel[] => {
    if (c.kind === 'phone') return call(c.label, c.hours);
    if (c.kind === 'email') return [{ kind: 'email', label: c.label, hours: c.hours, detail: c.expectedResponse, action: o.email ? { label: o.email, url: `mailto:${o.email}`, kind: 'external' } : write }];
    if (c.kind === 'messages') return [{ kind: 'message', label: c.label, hours: c.hours, detail: c.expectedResponse, action: write }];
    return [];
  });
}
