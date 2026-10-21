/**
 * Pure departments rules: rich-text sanitizing (a copy of content's allow-list, since modules don't import each
 * other's files), reading time, slugs, reply author names and ranking order. No I/O.
 */
import { slugify } from '../../../kernel/lib/text.js';

/* ------------------------------------------------------------------ rich text */

/** Tags the app renders from staff text (headings, lists, tables, links). Everything else is dropped. */
const ALLOWED_TAGS = new Set(['p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'blockquote', 'code', 'pre', 'span', 'hr', 'small', 'sup', 'sub']);
const VOID_TAGS = new Set(['br', 'hr']);
/** Dropped together with everything inside them */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'textarea', 'select', 'form', 'frameset', 'frame', 'head', 'title', 'xmp', 'plaintext', 'noembed', 'applet']);

const escapeText = (s: string) => s.replace(/&(?!#?[a-zA-Z0-9]{1,10};)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
 * Allow-list sanitizer for blog post bodies: keeps headings, paragraphs, lists, tables and safe links; drops scripts,
 * styles, frames, event handlers, inline styles and unsafe URLs; balances the tags it keeps. Idempotent.
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

/** The words of rich text, tags dropped and entities decoded */
export function plainText(html: string | null | undefined): string {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** About 220 words a minute, at least 1 */
export function readMinutes(html: string | null | undefined): number {
  const words = plainText(html).split(' ').filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

/* ------------------------------------------------------------------ slugs and names */

export const SLUG_MAX = 80;
export const isValidSlug = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= SLUG_MAX;
/** The slug a record gets: the one given (normalized), else one made from its name or title */
export const slugOf = (given: string | null | undefined, from: string) => slugify(given?.trim() || from, { max: SLUG_MAX });

/** How a reply is signed: first name and last initial ("Mina Park" → "Mina P."); Customer when unknown */
export function replyAuthorName(displayName: string | null | undefined): string {
  const parts = String(displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  const [first, ...rest] = parts;
  const last = rest.at(-1);
  return last ? `${first} ${last[0]!.toUpperCase()}.` : first!;
}

/* ------------------------------------------------------------------ limits */

export const LIMITS = {
  postTitle: 120,
  postSummary: 240,
  replyText: 1000,
  reportNote: 500,
  tagline: 120,
  inquiryMessage: 2000,
  phonePicks: 100,
  companyPhotos: 12,
  rankingRows: 100,
  name: 80,
} as const;

/* ------------------------------------------------------------------ play center */

export const PERIODS = ['today', 'week', 'all_time'] as const;
export type Period = (typeof PERIODS)[number];

/** Ranking rows best first: by score (high first), ties keep the order staff gave; ranks 1, 2, 3… */
export function rankRows(rows: readonly { name: string; score: number; change?: number | null }[]) {
  return rows
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r, k) => ({ rank: k + 1, name: r.name, score: r.score, change: r.change ?? null }));
}

/** Genres of a list of games, in first-seen order */
export const genresOf = (games: readonly { genre: string }[]) => [...new Set(games.map((g) => g.genre))];
