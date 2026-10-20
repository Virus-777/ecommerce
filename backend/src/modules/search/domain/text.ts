/** Pure text rules: query normalization, tokens, synonym expansion, GTIN checks and attribute keys. */

/** Lower case, punctuation to spaces (hyphens and apostrophes inside words kept), single spaces */
export function normalizeQuery(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/(^|\s)[-']+|[-']+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const tokens = (normalized: string): string[] => (normalized ? normalized.split(' ').filter(Boolean) : []);

/** Text for trigram matching: normalized title and brand */
export const titleNorm = (title: string, brand?: string | null) => normalizeQuery([brand, title].filter(Boolean).join(' '));

/** Filterable attribute key of a catalog attribute or variant option name: 'Battery life' → battery_life */
export function attrKey(name: string): string {
  return normalizeQuery(name).replace(/['-]/g, '').replace(/\s+/g, '_');
}

/* ------------------------------------------------------------------ synonyms */

export interface SynonymSet {
  id: string;
  terms: string[];
  kind: 'equivalent' | 'one_way';
  from: string | null;
}

/** Normalizes the terms of a synonym set: trimmed, lower case, unique, non-empty */
export const synonymTerms = (terms: string[]) => [...new Set(terms.map((t) => normalizeQuery(t)).filter(Boolean))];

export interface Expansion {
  /** Groups of alternatives, all of which must match (one alternative per group) */
  groups: string[][];
  /** Synonym terms that were added */
  used: string[];
  /** Ids of the synonym sets that applied */
  setIds: string[];
}

/**
 * Expands a normalized query with active synonym sets. Each word (or a multi-word phrase that a set
 * names) becomes a group of alternatives: equivalent sets expand every member to all others; one_way
 * sets expand `from` to `terms` only.
 */
export function expandQuery(normalized: string, sets: SynonymSet[]): Expansion {
  const words = tokens(normalized);
  const groups: string[][] = [];
  const used = new Set<string>();
  const setIds = new Set<string>();
  const alternativesOf = (phrase: string): { alts: string[]; ids: string[] } => {
    const alts = new Set<string>();
    const ids: string[] = [];
    for (const s of sets) {
      if (s.kind === 'equivalent' && s.terms.includes(phrase)) {
        for (const t of s.terms) if (t !== phrase) alts.add(t);
        ids.push(s.id);
      } else if (s.kind === 'one_way' && s.from === phrase) {
        for (const t of s.terms) if (t !== phrase) alts.add(t);
        ids.push(s.id);
      }
    }
    return { alts: [...alts], ids };
  };
  let i = 0;
  while (i < words.length) {
    // longest phrase first (up to 3 words), so 'in-ear headphones' or 'smart watch' expand as one
    let matched = false;
    for (let len = Math.min(3, words.length - i); len >= 2; len--) {
      const phrase = words.slice(i, i + len).join(' ');
      const { alts, ids } = alternativesOf(phrase);
      if (alts.length) {
        groups.push([phrase, ...alts]);
        alts.forEach((a) => used.add(a));
        ids.forEach((id) => setIds.add(id));
        i += len;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const w = words[i]!;
    const { alts, ids } = alternativesOf(w);
    groups.push([w, ...alts]);
    alts.forEach((a) => used.add(a));
    ids.forEach((id) => setIds.add(id));
    i++;
  }
  return { groups, used: [...used], setIds: [...setIds] };
}

/* ------------------------------------------------------------------ GTIN */

/** Valid GTIN-8/12/13/14 check digit (mod 10, weights 3/1 from the right) */
export function gtinCheckDigitOk(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((a, d, i) => a + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Normalized GTIN: digits only, check digit verified, padded to GTIN-14 (UPC-A 12 and EAN-13 compare
 * equal to their GTIN-14 form). Null when the code is not a valid GTIN.
 */
export function normalizeGtin(code: string | null | undefined): string | null {
  if (!code) return null;
  const digits = code.replace(/[\s-]/g, '');
  if (!gtinCheckDigitOk(digits)) return null;
  return digits.padStart(14, '0');
}

/** Whether free text is a full GTIN (a scanned or typed barcode) */
export const queryGtin = (q: string | null | undefined) => (q && /^[\d\s-]{8,18}$/.test(q.trim()) ? normalizeGtin(q.trim()) : null);

/* ------------------------------------------------------------------ misc */

/** '3 colors' style plural of an option name */
export function plural(n: number, noun: string): string {
  const w = noun.toLowerCase();
  if (n === 1) return `1 ${w}`;
  if (/(s|x|ch|sh)$/.test(w)) return `${n} ${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${n} ${w.slice(0, -1)}ies`;
  return `${n} ${w}s`;
}

/** $50, $49.99 */
export function formatMoney(amount: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const whole = amount % 100 === 0;
  return `${symbol}${(amount / 100).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}
