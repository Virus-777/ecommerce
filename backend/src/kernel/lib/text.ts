/**
 * Small text helpers shared by every module (one copy instead of one per repository).
 */

/** Escapes the characters that mean something in a regular expression, so `s` matches itself literally */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A URL slug: accents dropped, "&" read as "and", anything else not a letter or digit becomes one hyphen, at most
 * `max` characters and never ending in a hyphen. Text with no letters or digits gives `fallback`.
 */
export function slugify(text: string, o: { max?: number; fallback?: string } = {}): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, o.max ?? 80)
    .replace(/-+$/g, '');
  return slug || (o.fallback ?? '');
}

const HTML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text made safe to put in HTML, inside elements and quoted attributes alike */
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML[c]!);

/** The strings of a stored JSON array (anything else in it is left out); not an array → [] */
export const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
