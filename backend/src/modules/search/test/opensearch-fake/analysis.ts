/**
 * Text analysis for the OpenSearch fake: the analyzers the products index declares (mapping.ts), interpreted
 * from the index settings. Tokenizers: standard (approximated: runs of letters and digits, apostrophes and
 * dots inside words kept) and whitespace. Filters: lowercase, asciifolding, stop (_english_), stemmer english
 * (Porter, as Lucene's PorterStemFilter) and possessive_english.
 */

export interface Token {
  term: string;
  position: number;
}

/** Lucene's English stop words (EnglishAnalyzer.ENGLISH_STOP_WORDS_SET, the _english_ set) */
export const ENGLISH_STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with']);

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

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

export function porter(word: string): string {
  if (word.length < 3 || !/^[a-z]+$/.test(word)) return word;
  let w = word;
  const firstY = w[0] === 'y';
  if (firstY) w = `Y${w.slice(1)}`;
  let m: RegExpExecArray | null;
  // step 1a
  if ((m = /^(.+?)(ss|i)es$/.exec(w))) w = m[1]! + m[2]!;
  else if ((m = /^(.+?)([^s])s$/.exec(w))) w = m[1]! + m[2]!;
  // step 1b
  if ((m = /^(.+?)eed$/.exec(w))) {
    if (mgr0.test(m[1]!)) w = w.slice(0, -1);
  } else if ((m = /^(.+?)(ed|ing)$/.exec(w))) {
    const stem = m[1]!;
    if (sv.test(stem)) {
      w = stem;
      if (/(at|bl|iz)$/.test(w)) w += 'e';
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
      else if (cvc.test(w)) w += 'e';
    }
  }
  // step 1c
  if ((m = /^(.+?)y$/.exec(w)) && sv.test(m[1]!)) w = `${m[1]}i`;
  // step 2
  if ((m = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/.exec(w)) && mgr0.test(m[1]!)) w = m[1]! + step2[m[2]!];
  // step 3
  if ((m = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/.exec(w)) && mgr0.test(m[1]!)) w = m[1]! + step3[m[2]!];
  // step 4
  if ((m = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/.exec(w))) {
    if (mgr1.test(m[1]!)) w = m[1]!;
  } else if ((m = /^(.+?)(s|t)(ion)$/.exec(w))) {
    const stem = m[1]! + m[2]!;
    if (mgr1.test(stem)) w = stem;
  }
  // step 5
  if ((m = /^(.+?)e$/.exec(w))) {
    const stem = m[1]!;
    if (mgr1.test(stem) || (meq1.test(stem) && !cvc.test(stem))) w = stem;
  }
  if (/ll$/.test(w) && mgr1.test(w)) w = w.slice(0, -1);
  if (firstY) w = `y${w.slice(1)}`;
  return w;
}

/* ------------------------------------------------------------------ analyzers from index settings */

type Filter = (tokens: Token[]) => Token[];

function tokenizer(name: string): (text: string) => Token[] {
  if (name === 'whitespace') return (text) => text.split(/\s+/).filter(Boolean).map((term, position) => ({ term, position }));
  // standard (UAX#29, approximated)
  return (text) => [...text.matchAll(/[\p{L}\p{N}]+(?:['’.][\p{L}\p{N}]+)*/gu)].map((m, position) => ({ term: m[0], position }));
}

function tokenFilter(name: string, defs: Record<string, any>): Filter {
  const def = defs[name] ?? { type: name };
  const type = def.type ?? name;
  if (type === 'lowercase') return (t) => t.map((x) => ({ ...x, term: x.term.toLowerCase() }));
  if (type === 'asciifolding') return (t) => t.map((x) => ({ ...x, term: fold(x.term) }));
  if (type === 'stop') return (t) => t.filter((x) => !ENGLISH_STOP.has(x.term.toLowerCase()));
  if (type === 'stemmer' && def.language === 'possessive_english') return (t) => t.map((x) => ({ ...x, term: x.term.replace(/['’]s$/i, '') }));
  if (type === 'stemmer' || type === 'porter_stem') return (t) => t.map((x) => ({ ...x, term: porter(x.term) }));
  throw new Error(`OpenSearch fake: token filter '${name}' is not supported`);
}

export interface Analysis {
  analyze(analyzer: string, text: string): Token[];
  normalize(normalizer: string | undefined, value: string): string;
}

export function analysisOf(settings: any): Analysis {
  const a = settings?.analysis ?? settings?.index?.analysis ?? {};
  const analyzers: Record<string, any> = a.analyzer ?? {};
  const filters: Record<string, any> = a.filter ?? {};
  const normalizers: Record<string, any> = a.normalizer ?? {};
  const cache = new Map<string, (text: string) => Token[]>();
  const build = (name: string) => {
    if (name === 'standard') return (text: string) => tokenizer('standard')(text).map((x) => ({ ...x, term: x.term.toLowerCase() }));
    if (name === 'whitespace') return tokenizer('whitespace');
    const def = analyzers[name];
    if (!def) throw new Error(`OpenSearch fake: analyzer '${name}' is not defined`);
    const tok = tokenizer(def.tokenizer ?? 'standard');
    const chain = (def.filter ?? []).map((f: string) => tokenFilter(f, filters));
    return (text: string) => chain.reduce((t: Token[], f: Filter) => f(t), tok(text));
  };
  return {
    analyze(analyzer, text) {
      let fn = cache.get(analyzer);
      if (!fn) cache.set(analyzer, (fn = build(analyzer)));
      return fn(text);
    },
    normalize(normalizer, value) {
      if (!normalizer) return value;
      const def = normalizers[normalizer];
      let out = value;
      for (const f of def?.filter ?? []) {
        if (f === 'lowercase') out = out.toLowerCase();
        else if (f === 'asciifolding') out = fold(out);
      }
      return out;
    },
  };
}

/** Optimal string alignment distance (Levenshtein with transpositions), as Lucene's fuzzy queries count edits */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** fuzziness AUTO: 0 edits up to 2 characters, 1 up to 5, else 2 */
export const autoEdits = (term: string, fuzziness: unknown): number => {
  if (fuzziness === undefined || fuzziness === null) return 0;
  if (typeof fuzziness === 'number') return fuzziness;
  if (String(fuzziness).toUpperCase().startsWith('AUTO')) return term.length <= 2 ? 0 : term.length <= 5 ? 1 : 2;
  return Number(fuzziness) || 0;
};
