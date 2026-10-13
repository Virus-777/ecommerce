/**
 * Text analysis of the MongoDB search engine (development and tests), the same as the OpenSearch analyzer. Words are runs of letters and digits, lower case and accent-folded;
 * English stop words are dropped and words are stemmed (Porter), so 'speakers' and 'speaker' match.
 *
 * A document stores its stems with the weight of the best field they occur in (search_documents.terms):
 * title and brand 1, category 0.4, attributes 0.2, description 0.1 (four weight classes).
 */
import type { DocTexts } from './ports.js';

/** English stop words (Lucene's set, which the OpenSearch mapping uses as well) */
const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with']);

/* ------------------------------------------------------------------ Porter stemmer (M. F. Porter, 1980) */

const step2: Record<string, string> = { ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous', ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log' };
const step3: Record<string, string> = { icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '' };
const c = '[^aeiou]';
const v = '[aeiouy]';
const C = `${c}[^aeiouy]*`;
const V = `${v}[aeiou]*`;
const mgr0 = new RegExp(`^(${C})?${V}${C}`);
const meq1 = new RegExp(`^(${C})?${V}${C}(${V})?$`);
const mgr1 = new RegExp(`^(${C})?${V}${C}${V}${C}`);
const sv = new RegExp(`^(${C})?${v}`);
const cvc = new RegExp(`^${C}${v}[^aeiouwxy]$`);

export function stem(word: string): string {
  if (word.length < 3 || !/^[a-z]+$/.test(word)) return word;
  let w = word;
  const firstY = w[0] === 'y';
  if (firstY) w = `Y${w.slice(1)}`;
  let m: RegExpExecArray | null;
  if ((m = /^(.+?)(ss|i)es$/.exec(w))) w = m[1]! + m[2]!;
  else if ((m = /^(.+?)([^s])s$/.exec(w))) w = m[1]! + m[2]!;
  if ((m = /^(.+?)eed$/.exec(w))) {
    if (mgr0.test(m[1]!)) w = w.slice(0, -1);
  } else if ((m = /^(.+?)(ed|ing)$/.exec(w))) {
    const base = m[1]!;
    if (sv.test(base)) {
      w = base;
      if (/(at|bl|iz)$/.test(w)) w += 'e';
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
      else if (cvc.test(w)) w += 'e';
    }
  }
  if ((m = /^(.+?)y$/.exec(w)) && sv.test(m[1]!)) w = `${m[1]}i`;
  if ((m = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/.exec(w)) && mgr0.test(m[1]!)) w = m[1]! + step2[m[2]!];
  if ((m = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/.exec(w)) && mgr0.test(m[1]!)) w = m[1]! + step3[m[2]!];
  if ((m = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/.exec(w))) {
    if (mgr1.test(m[1]!)) w = m[1]!;
  } else if ((m = /^(.+?)(s|t)(ion)$/.exec(w))) {
    const base = m[1]! + m[2]!;
    if (mgr1.test(base)) w = base;
  }
  if ((m = /^(.+?)e$/.exec(w))) {
    const base = m[1]!;
    if (mgr1.test(base) || (meq1.test(base) && !cvc.test(base))) w = base;
  }
  if (/ll$/.test(w) && mgr1.test(w)) w = w.slice(0, -1);
  if (firstY) w = `y${w.slice(1)}`;
  return w;
}

/** Lower-case, accent-folded words of letters and digits */
export const words = (text: string): string[] =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** The stems a text is searched by (plainto_tsquery): stop words dropped, each word stemmed, in order */
export const stems = (text: string): string[] => words(text).filter((w) => !STOP.has(w)).map(stem);

/** Search terms of a document: every stem with the weight of the best field it occurs in */
export function termsOf(t: DocTexts): { t: string; w: number }[] {
  const out = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const s of stems(text)) if ((out.get(s) ?? 0) < weight) out.set(s, weight);
  };
  add(t.title, 1);
  add(t.brand, 1);
  add(t.category, 0.4);
  add(t.attributes, 0.2);
  add(t.description, 0.1);
  return [...out].map(([term, w]) => ({ t: term, w }));
}

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
