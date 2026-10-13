/**
 * An in-memory OpenSearch for tests: answers the REST requests the search module's OpenSearch engine sends
 * (through the real client: see connection.ts), with indices, mappings, aliases and documents in memory.
 *
 * Faithful: the query DSL the engine uses (bool, term(s), range, exists, ids, prefix, wildcard, match,
 * multi_match best_fields/cross_fields/phrase/phrase_prefix, match_phrase, nested with inner_hits and
 * score_mode, function_score with script_score, constant_score), aggregations (filter, filters, terms, nested,
 * reverse_nested, min, max, sum, cardinality), sorts (fields, _score, nested sorts with mode and filter, missing),
 * from/size, _source filtering, the term suggester, _bulk (index, update with scripts, delete, require_alias,
 * retry-visible per-item errors), _msearch, _count, _mget, _doc, aliases (atomic _aliases), _cat/indices.
 * Analysis follows the index settings (analysis.ts); scoring is BM25 (k1 1.2, b 0.75) over one shard.
 *
 * Not faithful (see docs/02-backend-architecture.md §9): Painless is not run — scripts are matched by their
 * source to their JavaScript twins in providers/opensearch/scripts.ts (an unknown script is an error); writes are
 * visible at once (no refresh interval); one shard, so scores and cardinality are exact; the standard tokenizer
 * is approximated; fuzzy scoring and the term suggester's ranking are simplified; no cluster behaviour
 * (replicas, timeouts, partial shard failures) beyond the faults a test injects.
 */
import { SCRIPT_TWINS, type DocValues } from '../../providers/opensearch/scripts.js';
import { analysisOf, autoEdits, editDistance, type Analysis, type Token } from './analysis.js';

type Json = any;
interface Doc {
  id: string;
  source: Json;
}
interface Index {
  name: string;
  settings: Json;
  mappings: Json;
  docs: Map<string, Doc>;
  analysis: Analysis;
}
export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}
export interface FakeResponse {
  status: number;
  body: unknown;
}

const err = (status: number, type: string, reason: string): FakeResponse => ({ status, body: { error: { type, reason, root_cause: [{ type, reason }] }, status } });

interface FieldInfo {
  type: string;
  analyzer?: string;
  normalizer?: string;
  /** where the value lives in _source (multi-fields read their parent) */
  source: string;
  scalingFactor?: number;
}

/** What a query sees: the root document, or one nested object inside it */
interface Ctx {
  index: Index;
  root: Doc;
  nested?: { path: string; obj: Json; offset: number };
  /** inner hits collected while matching the root document */
  inner?: Map<string, Json>;
  stats: Stats;
}

interface Result {
  match: boolean;
  score: number;
}
const NO: Result = { match: false, score: 0 };

/* ------------------------------------------------------------------ values */

function valuesAt(obj: Json, path: string[]): unknown[] {
  if (obj === undefined || obj === null) return [];
  if (Array.isArray(obj)) return obj.flatMap((o) => valuesAt(o, path));
  if (!path.length) return [obj];
  return valuesAt(obj[path[0]!], path.slice(1));
}

function fieldInfo(index: Index, field: string): FieldInfo | undefined {
  const parts = field.split('.');
  let props = index.mappings?.properties ?? {};
  let def: Json;
  const source: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (props[p]) {
      def = props[p];
      source.push(p);
      props = def.properties ?? {};
      continue;
    }
    if (def?.fields?.[p] && i === parts.length - 1) return { ...def.fields[p], source: source.join('.') };
    return undefined;
  }
  if (!def) return undefined;
  return { type: def.type ?? 'object', analyzer: def.analyzer, normalizer: def.normalizer, source: source.join('.'), scalingFactor: def.scaling_factor };
}

/** Raw _source values of a field in the context (nested fields read the nested object) */
function rawValues(ctx: Ctx, field: string): unknown[] {
  const info = fieldInfo(ctx.index, field);
  const src = info?.source ?? field;
  if (ctx.nested && src.startsWith(`${ctx.nested.path}.`)) return valuesAt(ctx.nested.obj, src.slice(ctx.nested.path.length + 1).split('.')).filter((v) => v !== null);
  return valuesAt(ctx.root.source, src.split('.')).filter((v) => v !== null);
}

/** Values as doc values: keywords normalized, numbers as numbers, dates as epoch millis, booleans */
function docValues(ctx: Ctx, field: string): (number | string | boolean)[] {
  const info = fieldInfo(ctx.index, field);
  const raw = rawValues(ctx, field);
  if (!info) return raw as never;
  switch (info.type) {
    case 'keyword':
      return raw.map((v) => ctx.index.analysis.normalize(info.normalizer, String(v)));
    case 'long':
    case 'integer':
    case 'double':
    case 'float':
      return raw.map(Number);
    case 'scaled_float':
      return raw.map((v) => Math.round(Number(v) * (info.scalingFactor ?? 1)) / (info.scalingFactor ?? 1));
    case 'date':
      return raw.map((v) => Date.parse(String(v)));
    case 'boolean':
      return raw.map((v) => v === true || v === 'true');
    default:
      return raw as never;
  }
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A query value as the field compares it */
function queryValue(ctx: Ctx, field: string, v: unknown): number | string | boolean {
  const info = fieldInfo(ctx.index, field);
  if (!info) return v as never;
  if (info.type === 'keyword') return ctx.index.analysis.normalize(info.normalizer, String(v));
  if (info.type === 'date') return Date.parse(String(v));
  if (info.type === 'boolean') return v === true || v === 'true';
  if (['long', 'integer', 'double', 'float', 'scaled_float'].includes(info.type)) return Number(v);
  return String(v);
}

/* ------------------------------------------------------------------ text statistics (BM25) */

class Stats {
  private fields = new Map<string, { n: number; avg: number; df: Map<string, number> }>();
  constructor(private readonly index: Index) {}

  tokens(ctx: Ctx, field: string): Token[] {
    const info = fieldInfo(this.index, field);
    const values = rawValues(ctx, field);
    const out: Token[] = [];
    let base = 0;
    for (const v of values) {
      const toks = info?.type === 'text' ? this.index.analysis.analyze(info.analyzer ?? 'standard', String(v)) : [{ term: this.index.analysis.normalize(info?.normalizer, String(v)), position: 0 }];
      for (const t of toks) out.push({ term: t.term, position: base + t.position });
      base += (toks.at(-1)?.position ?? 0) + 100;
    }
    return out;
  }

  of(field: string) {
    let s = this.fields.get(field);
    if (!s) {
      let n = 0;
      let total = 0;
      const df = new Map<string, number>();
      for (const doc of this.index.docs.values()) {
        const toks = this.tokens({ index: this.index, root: doc, stats: this }, field);
        if (!toks.length) continue;
        n++;
        total += toks.length;
        for (const t of new Set(toks.map((x) => x.term))) df.set(t, (df.get(t) ?? 0) + 1);
      }
      s = { n, avg: n ? total / n : 0, df };
      this.fields.set(field, s);
    }
    return s;
  }

  bm25(field: string, term: string, tf: number, dl: number): number {
    const s = this.of(field);
    const df = s.df.get(term) ?? 0;
    const idf = Math.log(1 + (s.n - df + 0.5) / (df + 0.5));
    const k1 = 1.2;
    const b = 0.75;
    return (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * dl) / (s.avg || 1)));
  }
}

/* ------------------------------------------------------------------ queries */

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function fieldAndBoost(f: string): { field: string; boost: number } {
  const [field, boost] = f.split('^');
  return { field: field!, boost: boost ? Number(boost) : 1 };
}

function minimumShouldMatch(msm: unknown, n: number, dflt: number): number {
  if (msm === undefined || msm === null) return dflt;
  if (typeof msm === 'number') return msm < 0 ? Math.max(0, n + msm) : msm;
  const s = String(msm);
  if (s.endsWith('%')) {
    const pct = Number(s.slice(0, -1));
    return pct < 0 ? n - Math.floor((n * -pct) / 100) : Math.floor((n * pct) / 100);
  }
  return Number(s);
}

/** Scores of query terms against one field: per term the best matching token's BM25 (fuzzy and prefix allowed) */
function termScores(ctx: Ctx, field: string, terms: Token[], o: { edits?: (t: string) => number; prefixLast?: boolean; prefixAll?: boolean }): (number | null)[] {
  const toks = ctx.stats.tokens(ctx, field);
  const dl = toks.length;
  return terms.map((t, i) => {
    const prefix = o.prefixAll || (o.prefixLast && i === terms.length - 1);
    const edits = o.edits?.(t.term) ?? 0;
    let best: number | null = null;
    const counts = new Map<string, number>();
    for (const x of toks) counts.set(x.term, (counts.get(x.term) ?? 0) + 1);
    for (const [term, tf] of counts) {
      let factor = 0;
      if (term === t.term) factor = 1;
      else if (prefix && term.startsWith(t.term)) factor = 1;
      else if (edits > 0) {
        const d = editDistance(term, t.term, edits);
        if (d <= edits) factor = 1 - d / Math.max(term.length, t.term.length);
      }
      if (!factor) continue;
      const s = ctx.stats.bm25(field, term, tf, dl) * factor;
      if (best === null || s > best) best = s;
    }
    return best;
  });
}

/** Phrase (optionally with the last term as a prefix) in one field */
function phraseScore(ctx: Ctx, field: string, terms: Token[], prefixLast: boolean): number | null {
  if (!terms.length) return null;
  const toks = ctx.stats.tokens(ctx, field);
  const first = terms[0]!.position;
  const rel = terms.map((t) => ({ term: t.term, offset: t.position - first }));
  let hits = 0;
  for (const start of toks) {
    const ok = rel.every((r, i) => {
      const at = toks.find((x) => x.position === start.position + r.offset);
      if (!at) return false;
      return prefixLast && i === rel.length - 1 ? at.term.startsWith(r.term) : at.term === r.term;
    });
    if (ok) hits++;
  }
  if (!hits) return null;
  return terms.reduce((s, t) => s + ctx.stats.bm25(field, t.term, hits, toks.length), 0);
}

function analyzeFor(ctx: Ctx, field: string, text: string): Token[] {
  const info = fieldInfo(ctx.index, field);
  if (info?.type === 'text') return ctx.index.analysis.analyze(info.analyzer ?? 'standard', text);
  return [{ term: ctx.index.analysis.normalize(info?.normalizer, text), position: 0 }];
}

function matchField(ctx: Ctx, field: string, text: string, o: { operator?: string; msm?: unknown; fuzziness?: unknown; prefixLength?: number; prefixLast?: boolean }): Result {
  const terms = analyzeFor(ctx, field, text);
  if (!terms.length) return NO;
  const scores = termScores(ctx, field, terms, {
    edits: (t) => (o.fuzziness === undefined ? 0 : autoEdits(t, o.fuzziness)),
    prefixLast: o.prefixLast,
  });
  const matched = scores.filter((s) => s !== null) as number[];
  const need = (o.operator ?? 'or').toLowerCase() === 'and' ? terms.length : Math.max(1, minimumShouldMatch(o.msm, terms.length, 1));
  if (matched.length < need) return NO;
  return { match: true, score: matched.reduce((a, b) => a + b, 0) };
}

function evalQuery(q: Json, ctx: Ctx): Result {
  const [type, body] = Object.entries(q ?? { match_all: {} })[0] as [string, Json];
  const boost = (r: Result, b = body?.boost) => (r.match && b !== undefined ? { match: true, score: r.score * b } : r);
  switch (type) {
    case 'match_all':
      return { match: true, score: body?.boost ?? 1 };
    case 'match_none':
      return NO;
    case 'bool': {
      const must = asArray(body.must).map((x) => evalQuery(x, ctx));
      const filter = asArray(body.filter).map((x) => evalQuery(x, ctx));
      const should = asArray(body.should).map((x) => evalQuery(x, ctx));
      const mustNot = asArray(body.must_not).map((x) => evalQuery(x, ctx));
      if (must.some((r) => !r.match) || filter.some((r) => !r.match) || mustNot.some((r) => r.match)) return NO;
      const need = minimumShouldMatch(body.minimum_should_match, should.length, must.length || filter.length ? 0 : should.length ? 1 : 0);
      const matchedShould = should.filter((r) => r.match);
      if (matchedShould.length < need) return NO;
      return boost({ match: true, score: [...must, ...matchedShould].reduce((s, r) => s + r.score, 0) });
    }
    case 'constant_score': {
      const r = evalQuery(body.filter, ctx);
      return r.match ? { match: true, score: body.boost ?? 1 } : NO;
    }
    case 'term': {
      const [field, spec] = Object.entries(body).filter(([k]) => k !== 'boost')[0]!;
      const value = spec !== null && typeof spec === 'object' ? (spec as Json).value : spec;
      const want = queryValue(ctx, field, value);
      return docValues(ctx, field).some((v) => v === want) ? { match: true, score: (spec as Json)?.boost ?? 1 } : NO;
    }
    case 'terms': {
      const [field, list] = Object.entries(body).filter(([k]) => k !== 'boost')[0]! as [string, unknown[]];
      const want = new Set(list.map((v) => queryValue(ctx, field, v)));
      return docValues(ctx, field).some((v) => want.has(v)) ? { match: true, score: 1 } : NO;
    }
    case 'ids':
      return (body.values as string[]).includes(ctx.root.id) ? { match: true, score: 1 } : NO;
    case 'exists':
      return rawValues(ctx, body.field).length ? { match: true, score: 1 } : NO;
    case 'range': {
      const [field, r] = Object.entries(body)[0]! as [string, Json];
      const ok = docValues(ctx, field).some((v) => {
        for (const [op, raw] of Object.entries(r)) {
          if (!['gt', 'gte', 'lt', 'lte'].includes(op)) continue;
          const c = compareValues(v, queryValue(ctx, field, raw));
          if ((op === 'gt' && !(c > 0)) || (op === 'gte' && !(c >= 0)) || (op === 'lt' && !(c < 0)) || (op === 'lte' && !(c <= 0))) return false;
        }
        return true;
      });
      return ok ? { match: true, score: 1 } : NO;
    }
    case 'prefix': {
      const [field, spec] = Object.entries(body)[0]! as [string, Json];
      const value = String(typeof spec === 'object' ? spec.value : spec);
      const info = fieldInfo(ctx.index, field);
      const values = info?.type === 'text' ? ctx.stats.tokens(ctx, field).map((t) => t.term) : docValues(ctx, field).map(String);
      const want = info?.type === 'keyword' ? ctx.index.analysis.normalize(info.normalizer, value) : value;
      return values.some((v) => v.startsWith(want)) ? { match: true, score: spec?.boost ?? 1 } : NO;
    }
    case 'wildcard': {
      const [field, spec] = Object.entries(body)[0]! as [string, Json];
      const info = fieldInfo(ctx.index, field);
      const pattern = info?.type === 'keyword' ? ctx.index.analysis.normalize(info.normalizer, String(spec.value)) : String(spec.value);
      let re = '';
      for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i]!;
        if (ch === '\\' && i + 1 < pattern.length) re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        else if (ch === '*') re += '.*';
        else if (ch === '?') re += '.';
        else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      const rx = new RegExp(`^${re}$`, spec.case_insensitive ? 'is' : 's');
      return docValues(ctx, field).some((v) => rx.test(String(v))) ? { match: true, score: spec.boost ?? 1 } : NO;
    }
    case 'match': {
      const [field, spec] = Object.entries(body)[0]! as [string, Json];
      const s = typeof spec === 'object' ? spec : { query: spec };
      return boost(matchField(ctx, field, String(s.query), { operator: s.operator, msm: s.minimum_should_match, fuzziness: s.fuzziness }), s.boost);
    }
    case 'match_bool_prefix': {
      const [field, spec] = Object.entries(body)[0]! as [string, Json];
      return matchField(ctx, field, String(spec.query), { operator: spec.operator, msm: spec.minimum_should_match, fuzziness: spec.fuzziness, prefixLast: true });
    }
    case 'match_phrase':
    case 'match_phrase_prefix': {
      const [field, spec] = Object.entries(body)[0]! as [string, Json];
      const text = typeof spec === 'object' ? spec.query : spec;
      const s = phraseScore(ctx, field, analyzeFor(ctx, field, String(text)), type === 'match_phrase_prefix');
      return s === null ? NO : { match: true, score: s };
    }
    case 'multi_match': {
      const fields = (body.fields as string[]).map(fieldAndBoost);
      const kind = body.type ?? 'best_fields';
      if (kind === 'phrase' || kind === 'phrase_prefix') {
        let best: number | null = null;
        for (const f of fields) {
          const s = phraseScore(ctx, f.field, analyzeFor(ctx, f.field, String(body.query)), kind === 'phrase_prefix');
          if (s !== null && (best === null || s * f.boost > best)) best = s * f.boost;
        }
        return best === null ? NO : { match: true, score: best };
      }
      if (kind === 'cross_fields') {
        // every term (operator and) in at least one of the fields; a term scores its best field
        const terms = analyzeFor(ctx, fields[0]!.field, String(body.query));
        if (!terms.length) return NO;
        const per = terms.map((t) => {
          let best: number | null = null;
          for (const f of fields) {
            const [s] = termScores(ctx, f.field, [t], {});
            if (s !== null && s !== undefined && (best === null || s * f.boost > best)) best = s * f.boost;
          }
          return best;
        });
        const matched = per.filter((s) => s !== null) as number[];
        const need = (body.operator ?? 'or').toLowerCase() === 'and' ? terms.length : Math.max(1, minimumShouldMatch(body.minimum_should_match, terms.length, 1));
        return matched.length < need ? NO : { match: true, score: matched.reduce((a, b) => a + b, 0) };
      }
      let best: Result = NO;
      for (const f of fields) {
        const r = matchField(ctx, f.field, String(body.query), { operator: body.operator, msm: body.minimum_should_match, fuzziness: body.fuzziness, prefixLast: kind === 'bool_prefix' });
        if (r.match && r.score * f.boost > best.score) best = { match: true, score: r.score * f.boost };
      }
      return best;
    }
    case 'nested': {
      const objs = valuesAt(ctx.root.source, body.path.split('.'));
      const matched: { obj: Json; offset: number; score: number }[] = [];
      objs.forEach((obj, offset) => {
        const r = evalQuery(body.query, { ...ctx, nested: { path: body.path, obj, offset } });
        if (r.match) matched.push({ obj, offset, score: r.score });
      });
      if (!matched.length) return NO;
      if (body.inner_hits && ctx.inner) ctx.inner.set(body.inner_hits.name ?? body.path, innerHits(ctx, body.path, body.inner_hits, matched));
      const scores = matched.map((m) => m.score);
      const mode = body.score_mode ?? 'avg';
      const score = mode === 'max' ? Math.max(...scores) : mode === 'min' ? Math.min(...scores) : mode === 'sum' ? scores.reduce((a, b) => a + b, 0) : mode === 'none' ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
      return { match: true, score };
    }
    case 'function_score': {
      const r = evalQuery(body.query ?? { match_all: {} }, ctx);
      if (!r.match) return NO;
      const fns: Json[] = body.functions ?? (body.script_score ? [{ script_score: body.script_score }] : body.weight !== undefined ? [{ weight: body.weight }] : []);
      if (!fns.length) return r;
      const values = fns.map((f) => {
        if (f.filter && !evalQuery(f.filter, ctx).match) return null;
        let v = 1;
        if (f.script_score) v = runScore(f.script_score.script, ctx, r.score);
        if (f.weight !== undefined) v *= f.weight;
        return v;
      });
      const applied = values.filter((v) => v !== null) as number[];
      const fnScore = !applied.length ? 1 : (body.score_mode ?? 'multiply') === 'sum' ? applied.reduce((a, b) => a + b, 0) : (body.score_mode ?? 'multiply') === 'max' ? Math.max(...applied) : applied.reduce((a, b) => a * b, 1);
      const mode = body.boost_mode ?? 'multiply';
      const score = mode === 'replace' ? fnScore : mode === 'sum' ? r.score + fnScore : mode === 'max' ? Math.max(r.score, fnScore) : r.score * fnScore;
      if (score < 0) throw new FakeError(400, 'illegal_argument_exception', 'function score query returned an invalid score: negative');
      // Lucene scores are 32-bit floats
      return { match: true, score: Math.fround(score) };
    }
    default:
      throw new FakeError(400, 'parsing_exception', `OpenSearch fake: query [${type}] is not supported`);
  }
}

class FakeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    reason: string,
  ) {
    super(reason);
  }
}

function runScore(script: Json, ctx: Ctx, score: number): number {
  const twin = SCRIPT_TWINS[script.source];
  if (!twin?.score) throw new FakeError(400, 'script_exception', `OpenSearch fake: no JavaScript twin for script ${JSON.stringify(String(script.source).slice(0, 60))}`);
  const doc: DocValues = (field) => docValues(ctx, field);
  return twin.score(script.params ?? {}, doc, score);
}

function innerHits(ctx: Ctx, path: string, spec: Json, matched: { obj: Json; offset: number; score: number }[]): Json {
  const sorted = [...matched];
  if (spec.sort) {
    const keys = asArray(spec.sort).map(sortKey);
    sorted.sort((a, b) => {
      for (const k of keys) {
        const va = docValues({ ...ctx, nested: { path, obj: a.obj, offset: a.offset } }, k.field)[0];
        const vb = docValues({ ...ctx, nested: { path, obj: b.obj, offset: b.offset } }, k.field)[0];
        const c = compareMissing(va, vb, k.order);
        if (c) return c;
      }
      return a.offset - b.offset;
    });
  } else sorted.sort((a, b) => b.score - a.score || a.offset - b.offset);
  const from = spec.from ?? 0;
  const size = spec.size ?? 3;
  return {
    hits: {
      total: { value: matched.length, relation: 'eq' },
      max_score: Math.max(...matched.map((m) => m.score)),
      hits: sorted.slice(from, from + size).map((m) => ({ _index: ctx.index.name, _id: ctx.root.id, _nested: { field: path, offset: m.offset }, _score: spec.sort ? null : m.score, _source: structuredClone(m.obj) })),
    },
  };
}

/* ------------------------------------------------------------------ sorts */

interface SortKey {
  field: string;
  order: 'asc' | 'desc';
  mode?: string;
  missing?: unknown;
  nested?: { path: string; filter?: Json };
}

function sortKey(s: Json): SortKey {
  if (typeof s === 'string') return { field: s, order: s === '_score' ? 'desc' : 'asc' };
  const [field, spec] = Object.entries(s)[0]! as [string, Json];
  if (typeof spec === 'string') return { field, order: spec as 'asc' | 'desc' };
  return { field, order: spec.order ?? (field === '_score' ? 'desc' : 'asc'), mode: spec.mode, missing: spec.missing, nested: spec.nested };
}

/** Missing values sort last (asc and desc) */
function compareMissing(a: unknown, b: unknown, order: 'asc' | 'desc'): number {
  const ma = a === undefined || a === null;
  const mb = b === undefined || b === null;
  if (ma || mb) return ma && mb ? 0 : ma ? 1 : -1;
  const c = compareValues(a, b);
  return order === 'asc' ? c : -c;
}

function sortValue(ctx: Ctx, k: SortKey, score: number): unknown {
  if (k.field === '_score') return score;
  if (k.field === '_id') return ctx.root.id;
  let values: unknown[];
  if (k.nested) {
    const objs = valuesAt(ctx.root.source, k.nested.path.split('.'));
    values = objs.flatMap((obj, offset) => {
      const n: Ctx = { ...ctx, nested: { path: k.nested!.path, obj, offset } };
      return !k.nested!.filter || evalQuery(k.nested!.filter, n).match ? docValues(n, k.field) : [];
    });
  } else values = docValues(ctx, k.field);
  if (!values.length) return k.missing === '_first' ? -Infinity : null;
  const mode = k.mode ?? (k.order === 'asc' ? 'min' : 'max');
  const nums = values.every((v) => typeof v === 'number');
  if (mode === 'min') return values.reduce((a, b) => (compareValues(a, b) <= 0 ? a : b));
  if (mode === 'max') return values.reduce((a, b) => (compareValues(a, b) >= 0 ? a : b));
  if (nums && mode === 'sum') return (values as number[]).reduce((a, b) => a + b, 0);
  if (nums && mode === 'avg') return (values as number[]).reduce((a, b) => a + b, 0) / values.length;
  return values[0];
}

/** A sort value as OpenSearch returns it (booleans as 0/1) */
const sortOut = (v: unknown) => (typeof v === 'boolean' ? Number(v) : v === -Infinity ? null : v);

/* ------------------------------------------------------------------ aggregations */

interface Item {
  root: Doc;
  nested?: { path: string; obj: Json; offset: number };
}

function aggregate(index: Index, stats: Stats, aggs: Json, items: Item[]): Json {
  const out: Json = {};
  for (const [name, spec] of Object.entries(aggs ?? {}) as [string, Json][]) {
    const sub = spec.aggs ?? spec.aggregations;
    const ctxOf = (it: Item): Ctx => ({ index, root: it.root, nested: it.nested, stats });
    const [type, body] = Object.entries(spec).find(([k]) => k !== 'aggs' && k !== 'aggregations')! as [string, Json];
    switch (type) {
      case 'filter': {
        const kept = items.filter((it) => evalQuery(body, ctxOf(it)).match);
        out[name] = { doc_count: kept.length, ...(sub ? aggregate(index, stats, sub, kept) : {}) };
        break;
      }
      case 'filters': {
        const buckets: Json = {};
        for (const [key, q] of Object.entries(body.filters as Json)) {
          const kept = items.filter((it) => evalQuery(q, ctxOf(it)).match);
          buckets[key] = { doc_count: kept.length, ...(sub ? aggregate(index, stats, sub, kept) : {}) };
        }
        out[name] = { buckets };
        break;
      }
      case 'nested': {
        const kept: Item[] = items.flatMap((it) => valuesAt(it.root.source, body.path.split('.')).map((obj, offset) => ({ root: it.root, nested: { path: body.path, obj, offset } })));
        out[name] = { doc_count: kept.length, ...(sub ? aggregate(index, stats, sub, kept) : {}) };
        break;
      }
      case 'reverse_nested': {
        const seen = new Map<string, Item>();
        for (const it of items) seen.set(it.root.id, { root: it.root });
        const kept = [...seen.values()];
        out[name] = { doc_count: kept.length, ...(sub ? aggregate(index, stats, sub, kept) : {}) };
        break;
      }
      case 'terms': {
        const groups = new Map<string, { key: unknown; items: Item[] }>();
        for (const it of items) {
          for (const v of new Set(docValues(ctxOf(it), body.field))) {
            const k = JSON.stringify(v);
            const g = groups.get(k) ?? { key: v, items: [] };
            g.items.push(it);
            groups.set(k, g);
          }
        }
        const include = body.include ? new Set(asArray(body.include).map(String)) : null;
        const orders = asArray(body.order ?? [{ _count: 'desc' }, { _key: 'asc' }]).flatMap((o: Json) => Object.entries(o)) as [string, string][];
        if (!orders.some(([k]) => k === '_key')) orders.push(['_key', 'asc']);
        const list = [...groups.values()]
          .filter((g) => !include || include.has(String(g.key)))
          .sort((a, b) => {
            for (const [k, dir] of orders) {
              const c = k === '_count' ? a.items.length - b.items.length : compareValues(a.key, b.key);
              if (c) return dir === 'asc' ? c : -c;
            }
            return 0;
          });
        const size = body.size ?? 10;
        const shown = list.slice(0, size);
        out[name] = {
          doc_count_error_upper_bound: 0,
          sum_other_doc_count: list.slice(size).reduce((n, g) => n + g.items.length, 0),
          buckets: shown.map((g) => ({ key: typeof g.key === 'boolean' ? Number(g.key) : g.key, ...(typeof g.key === 'boolean' ? { key_as_string: String(g.key) } : {}), doc_count: g.items.length, ...(sub ? aggregate(index, stats, sub, g.items) : {}) })),
        };
        break;
      }
      case 'min':
      case 'max':
      case 'sum': {
        const values = items.flatMap((it) => docValues(ctxOf(it), body.field)).map(Number);
        out[name] = { value: type === 'sum' ? values.reduce((a, b) => a + b, 0) : values.length ? (type === 'min' ? Math.min(...values) : Math.max(...values)) : null };
        break;
      }
      case 'cardinality': {
        out[name] = { value: new Set(items.flatMap((it) => docValues(ctxOf(it), body.field)).map((v) => JSON.stringify(v))).size };
        break;
      }
      default:
        throw new FakeError(400, 'parsing_exception', `OpenSearch fake: aggregation [${type}] is not supported`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the server */

export class FakeOpenSearch {
  readonly indices = new Map<string, Index>();
  readonly aliases = new Map<string, Set<string>>();
  /** Every request, in order (tests assert on them) */
  readonly requests: FakeRequest[] = [];
  private faults: { when: (r: FakeRequest) => boolean; response: FakeResponse; times: number }[] = [];
  private itemFaults: { when: (action: string, id: string, index: string) => boolean; status: number; type: string; times: number }[] = [];

  /** The next `times` requests matching `when` are answered with `response` */
  fail(when: (r: FakeRequest) => boolean, response: FakeResponse, times = 1) {
    this.faults.push({ when, response, times });
  }
  /** Bulk items matching `when` fail with this status and error type (`times` items) */
  failItems(when: (action: string, id: string, index: string) => boolean, status: number, type: string, times = 1) {
    this.itemFaults.push({ when, status, type, times });
  }

  /** Documents of an index or alias by id */
  docs(target: string): Map<string, Json> {
    const out = new Map<string, Json>();
    for (const name of this.resolve(target) ?? []) for (const d of this.indices.get(name)!.docs.values()) out.set(d.id, d.source);
    return out;
  }

  handle(method: string, rawPath: string, query: Record<string, string>, rawBody: string | undefined): FakeResponse {
    const path = rawPath.split('?')[0]!.replace(/\/+$/, '') || '/';
    const ndjson = path.endsWith('/_bulk') || path.endsWith('/_msearch');
    let body: unknown;
    try {
      body = rawBody ? (ndjson ? rawBody.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : JSON.parse(rawBody)) : undefined;
    } catch {
      return err(400, 'parse_exception', 'request body is not JSON');
    }
    const req: FakeRequest = { method: method.toUpperCase(), path, query, body };
    this.requests.push(req);
    const fault = this.faults.find((f) => f.times > 0 && f.when(req));
    if (fault) {
      fault.times--;
      return fault.response;
    }
    try {
      return this.route(req);
    } catch (e) {
      if (e instanceof FakeError) return err(e.status, e.type, e.message);
      throw e;
    }
  }

  private route(r: FakeRequest): FakeResponse {
    const seg = r.path.split('/').filter(Boolean).map(decodeURIComponent);
    const m = r.method;
    if (!seg.length) return { status: 200, body: { name: 'fake', cluster_name: 'fake', version: { distribution: 'opensearch', number: '2.17.0' }, tagline: 'The OpenSearch Project: https://opensearch.org/' } };
    if (seg[0] === '_cluster' && seg[1] === 'health') return { status: 200, body: { cluster_name: 'fake', status: 'green', number_of_nodes: 1 } };
    if (seg[0] === '_alias' && m === 'GET') return this.getAlias(seg[1]!);
    if (seg[0] === '_aliases' && m === 'POST') return this.updateAliases(r.body as Json);
    if (seg[0] === '_cat' && seg[1] === 'indices') return this.catIndices(seg[2]);
    if (seg[0] === '_bulk') return this.bulk(r.body as Json[], r.query, undefined);
    if (seg[0] === '_msearch') return this.msearch(r.body as Json[]);
    if (seg[0] === '_mget') return this.mget(undefined, r.body as Json);
    const [target, op, id] = seg as [string, string | undefined, string | undefined];
    if (!op) {
      if (m === 'PUT') return this.createIndex(target, (r.body ?? {}) as Json);
      if (m === 'DELETE') return this.deleteIndex(target);
      if (m === 'HEAD' || m === 'GET') return this.resolve(target) ? { status: 200, body: Object.fromEntries((this.resolve(target) ?? []).map((n) => [n, { settings: this.indices.get(n)!.settings, mappings: this.indices.get(n)!.mappings }])) } : err(404, 'index_not_found_exception', `no such index [${target}]`);
    }
    if (op === '_mapping') return this.withIndices(target, (names) => ({ status: 200, body: Object.fromEntries(names.map((n) => [n, { mappings: this.indices.get(n)!.mappings }])) }));
    if (op === '_refresh') return this.withIndices(target, () => ({ status: 200, body: { _shards: { total: 1, successful: 1, failed: 0 } } }));
    if (op === '_search') return this.withIndices(target, (names) => ({ status: 200, body: this.search(names, (r.body ?? {}) as Json) }));
    if (op === '_count') return this.withIndices(target, (names) => ({ status: 200, body: { count: this.search(names, { ...((r.body ?? {}) as Json), size: 0, track_total_hits: true }).hits.total.value } }));
    if (op === '_mget') return this.mget(target, r.body as Json);
    if (op === '_bulk') return this.bulk(r.body as Json[], r.query, target);
    if (op === '_doc' && id && m === 'GET') return this.getDoc(target, id);
    return err(400, 'illegal_argument_exception', `OpenSearch fake: ${m} ${r.path} is not supported`);
  }

  /* ---------------------------------------------------------------- indices and aliases */

  private resolve(target: string): string[] | null {
    if (this.indices.has(target)) return [target];
    const a = this.aliases.get(target);
    if (a?.size) return [...a];
    if (target.includes('*') || target.includes(',')) {
      const parts = target.split(',');
      const names = [...this.indices.keys()].filter((n) => parts.some((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(n)));
      return names.length ? names : null;
    }
    return null;
  }

  private withIndices(target: string, fn: (names: string[]) => FakeResponse): FakeResponse {
    const names = this.resolve(target);
    return names ? fn(names) : err(404, 'index_not_found_exception', `no such index [${target}]`);
  }

  private createIndex(name: string, body: Json): FakeResponse {
    if (this.indices.has(name) || this.aliases.has(name)) return err(400, 'resource_already_exists_exception', `index [${name}] already exists`);
    this.indices.set(name, { name, settings: body.settings ?? {}, mappings: body.mappings ?? {}, docs: new Map(), analysis: analysisOf(body.settings ?? {}) });
    for (const alias of Object.keys(body.aliases ?? {})) this.addAlias(alias, name);
    return { status: 200, body: { acknowledged: true, shards_acknowledged: true, index: name } };
  }

  private deleteIndex(target: string): FakeResponse {
    const names = target.split(',').flatMap((t) => this.resolve(t) ?? []);
    if (!names.length) return err(404, 'index_not_found_exception', `no such index [${target}]`);
    for (const n of names) {
      this.indices.delete(n);
      for (const [alias, set] of this.aliases) {
        set.delete(n);
        if (!set.size) this.aliases.delete(alias);
      }
    }
    return { status: 200, body: { acknowledged: true } };
  }

  private addAlias(alias: string, index: string) {
    const set = this.aliases.get(alias) ?? new Set<string>();
    set.add(index);
    this.aliases.set(alias, set);
  }

  private getAlias(name: string): FakeResponse {
    const set = this.aliases.get(name);
    if (!set?.size) return { status: 404, body: { error: `alias [${name}] missing`, status: 404 } };
    return { status: 200, body: Object.fromEntries([...set].map((i) => [i, { aliases: { [name]: {} } }])) };
  }

  /** All actions or none */
  private updateAliases(body: Json): FakeResponse {
    const next = new Map([...this.aliases].map(([k, v]) => [k, new Set(v)]));
    for (const action of body?.actions ?? []) {
      const [type, a] = Object.entries(action)[0]! as [string, Json];
      if (!this.indices.has(a.index)) return err(404, 'index_not_found_exception', `no such index [${a.index}]`);
      if (type === 'add') next.set(a.alias, new Set([...(next.get(a.alias) ?? []), a.index]));
      else if (type === 'remove') {
        const set = next.get(a.alias);
        if (!set?.has(a.index)) {
          if (a.must_exist === false) continue;
          return err(404, 'aliases_not_found_exception', `aliases [${a.alias}] missing`);
        }
        set.delete(a.index);
        if (!set.size) next.delete(a.alias);
      } else return err(400, 'illegal_argument_exception', `alias action [${type}] is not supported`);
    }
    this.aliases.clear();
    for (const [k, v] of next) this.aliases.set(k, v);
    return { status: 200, body: { acknowledged: true } };
  }

  private catIndices(pattern = '*'): FakeResponse {
    const names = this.resolve(pattern) ?? [];
    return { status: 200, body: names.filter((n) => this.indices.has(n)).map((index) => ({ index })) };
  }

  /* ---------------------------------------------------------------- documents */

  /** The index a write goes to; require_alias refuses concrete index names */
  private writeIndex(target: string, requireAlias: boolean): Index | FakeError {
    const alias = this.aliases.get(target);
    if (requireAlias && !alias) return new FakeError(404, 'index_not_found_exception', `no such index [${target}] and [require_alias] request flag is [true] and [${target}] is not an alias`);
    const names = alias ? [...alias] : this.indices.has(target) ? [target] : [];
    if (!names.length) return new FakeError(404, 'index_not_found_exception', `no such index [${target}]`);
    if (names.length > 1) return new FakeError(400, 'illegal_argument_exception', `no write index is defined for alias [${target}]`);
    return this.indices.get(names[0]!)!;
  }

  private bulk(lines: Json[], query: Record<string, string>, pathIndex: string | undefined): FakeResponse {
    const requireAlias = query.require_alias === 'true';
    const items: Json[] = [];
    for (let i = 0; i < (lines ?? []).length; i++) {
      const [action, meta] = Object.entries(lines[i]!)[0]! as [string, Json];
      const body = action === 'delete' ? undefined : lines[++i];
      const target = meta._index ?? pathIndex;
      const id = String(meta._id);
      const result = (status: number, extra: Json) => items.push({ [action]: { _index: target, _id: id, status, ...extra } });
      const fault = this.itemFaults.find((f) => f.times > 0 && f.when(action, id, target));
      if (fault) {
        fault.times--;
        result(fault.status, { error: { type: fault.type, reason: 'injected' } });
        continue;
      }
      const index = this.writeIndex(target, requireAlias || meta.require_alias === true);
      if (index instanceof FakeError) {
        result(index.status, { error: { type: index.type, reason: index.message } });
        continue;
      }
      const existing = index.docs.get(id);
      if (action === 'index' || action === 'create') {
        if (action === 'create' && existing) {
          result(409, { error: { type: 'version_conflict_engine_exception', reason: 'document already exists' } });
          continue;
        }
        index.docs.set(id, { id, source: structuredClone(body) });
        result(existing ? 200 : 201, { _index: index.name, result: existing ? 'updated' : 'created' });
      } else if (action === 'delete') {
        if (!existing) {
          result(404, { _index: index.name, result: 'not_found' });
          continue;
        }
        index.docs.delete(id);
        result(200, { _index: index.name, result: 'deleted' });
      } else if (action === 'update') {
        try {
          const out = this.update(index, id, existing, body);
          result(out === 'created' ? 201 : 200, { _index: index.name, result: out });
        } catch (e) {
          if (!(e instanceof FakeError)) throw e;
          result(e.status, { error: { type: e.type, reason: e.message } });
        }
      } else result(400, { error: { type: 'illegal_argument_exception', reason: `action [${action}]` } });
    }
    return { status: 200, body: { took: 1, errors: items.some((x) => Object.values(x)[0] && (Object.values(x)[0] as Json).status >= 300), items } };
  }

  private update(index: Index, id: string, existing: Doc | undefined, body: Json): 'created' | 'updated' | 'noop' {
    if (body.script) {
      const twin = SCRIPT_TWINS[body.script.source];
      if (!twin?.update) throw new FakeError(400, 'script_exception', 'OpenSearch fake: no JavaScript twin for this update script');
      if (!existing && !body.scripted_upsert) {
        if (!body.upsert) throw new FakeError(404, 'document_missing_exception', `[${id}]: document missing`);
        index.docs.set(id, { id, source: structuredClone(body.upsert) });
        return 'created';
      }
      const ctx = { _source: structuredClone(existing?.source ?? body.upsert ?? {}), op: existing ? 'index' : 'create' };
      twin.update(body.script.params ?? {}, ctx);
      if (ctx.op === 'none' || ctx.op === 'noop') return 'noop';
      if (ctx.op === 'delete') {
        index.docs.delete(id);
        return 'updated';
      }
      index.docs.set(id, { id, source: ctx._source });
      return existing ? 'updated' : 'created';
    }
    if (!existing) {
      if (body.doc_as_upsert) {
        index.docs.set(id, { id, source: structuredClone(body.doc) });
        return 'created';
      }
      if (body.upsert) {
        index.docs.set(id, { id, source: structuredClone(body.upsert) });
        return 'created';
      }
      throw new FakeError(404, 'document_missing_exception', `[${id}]: document missing`);
    }
    index.docs.set(id, { id, source: { ...existing.source, ...structuredClone(body.doc) } });
    return 'updated';
  }

  private getDoc(target: string, id: string): FakeResponse {
    const names = this.resolve(target);
    if (!names) return err(404, 'index_not_found_exception', `no such index [${target}]`);
    for (const n of names) {
      const d = this.indices.get(n)!.docs.get(id);
      if (d) return { status: 200, body: { _index: n, _id: id, found: true, _source: structuredClone(d.source) } };
    }
    return { status: 404, body: { _index: names[0], _id: id, found: false } };
  }

  private mget(target: string | undefined, body: Json): FakeResponse {
    const wanted: { _index?: string; _id: string }[] = body.docs ?? (body.ids ?? []).map((id: string) => ({ _id: id }));
    return {
      status: 200,
      body: {
        docs: wanted.map((w) => {
          const r = this.getDoc(w._index ?? target!, w._id);
          return r.status === 200 ? r.body : { _index: w._index ?? target, _id: w._id, found: false };
        }),
      },
    };
  }

  /* ---------------------------------------------------------------- search */

  private msearch(lines: Json[]): FakeResponse {
    const responses: Json[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const header = lines[i]!;
      const names = this.resolve(header.index);
      if (!names) {
        responses.push({ error: { type: 'index_not_found_exception', reason: `no such index [${header.index}]` }, status: 404 });
        continue;
      }
      try {
        responses.push({ ...this.search(names, lines[i + 1]!), status: 200 });
      } catch (e) {
        if (!(e instanceof FakeError)) throw e;
        responses.push({ error: { type: e.type, reason: e.message }, status: e.status });
      }
    }
    return { status: 200, body: { took: 1, responses } };
  }

  private search(names: string[], body: Json): Json {
    const hits: { index: Index; doc: Doc; score: number; inner: Map<string, Json>; sort?: unknown[] }[] = [];
    const statsOf = new Map<string, Stats>();
    for (const name of names) {
      const index = this.indices.get(name)!;
      const stats = new Stats(index);
      statsOf.set(name, stats);
      for (const doc of index.docs.values()) {
        const inner = new Map<string, Json>();
        const r = evalQuery(body.query ?? { match_all: {} }, { index, root: doc, inner, stats });
        if (r.match) hits.push({ index, doc, score: Math.fround(r.score), inner });
      }
    }
    const sortSpec = body.sort ? asArray(body.sort).map(sortKey) : null;
    if (sortSpec) {
      for (const h of hits) h.sort = sortSpec.map((k) => sortValue({ index: h.index, root: h.doc, stats: statsOf.get(h.index.name)! }, k, h.score));
      hits.sort((a, b) => {
        for (let i = 0; i < sortSpec.length; i++) {
          const c = compareMissing(a.sort![i], b.sort![i], sortSpec[i]!.order);
          if (c) return c;
        }
        return 0;
      });
    } else hits.sort((a, b) => b.score - a.score);
    const from = body.from ?? 0;
    const size = body.size ?? 10;
    const scored = !sortSpec || body.track_scores || sortSpec.some((k) => k.field === '_score');
    const page = hits.slice(from, from + size).map((h) => ({
      _index: h.index.name,
      _id: h.doc.id,
      _score: scored ? h.score : null,
      ...(body._source === false ? {} : { _source: filterSource(h.doc.source, body._source) }),
      ...(h.sort ? { sort: h.sort.map(sortOut) } : {}),
      ...(h.inner.size ? { inner_hits: Object.fromEntries(h.inner) } : {}),
    }));
    const out: Json = {
      took: 1,
      timed_out: false,
      _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
      hits: { ...(body.track_total_hits === false ? {} : { total: { value: hits.length, relation: 'eq' } }), max_score: scored && hits.length ? Math.max(...hits.map((h) => h.score)) : null, hits: page },
    };
    const aggs = body.aggs ?? body.aggregations;
    if (aggs) {
      const index = this.indices.get(names[0]!)!;
      out.aggregations = aggregate(index, statsOf.get(index.name)!, aggs, hits.map((h) => ({ root: h.doc })));
    }
    if (body.suggest) out.suggest = this.suggest(this.indices.get(names[0]!)!, statsOf.get(names[0]!)!, body.suggest);
    return out;
  }

  private suggest(index: Index, stats: Stats, spec: Json): Json {
    const out: Json = {};
    for (const [name, s] of Object.entries(spec) as [string, Json][]) {
      if (!s.term) throw new FakeError(400, 'parsing_exception', 'OpenSearch fake: only term suggesters are supported');
      const t = s.term;
      const field = t.field;
      const dict = stats.of(field).df;
      const terms = index.analysis.analyze(fieldInfo(index, field)?.analyzer ?? 'standard', String(s.text));
      out[name] = terms.map((tok) => {
        const options = [...dict.entries()]
          .filter(([w]) => w !== tok.term && w.length >= (t.min_word_length ?? 4) && w.slice(0, t.prefix_length ?? 1) === tok.term.slice(0, t.prefix_length ?? 1))
          .map(([w, freq]) => ({ text: w, freq, d: editDistance(w, tok.term, t.max_edits ?? 2) }))
          .filter((o) => o.d <= (t.max_edits ?? 2))
          .map((o) => ({ text: o.text, score: 1 - o.d / Math.max(o.text.length, tok.term.length), freq: o.freq }))
          .sort((a, b) => b.score - a.score || b.freq - a.freq || (a.text < b.text ? -1 : 1))
          .slice(0, t.size ?? 5);
        return { text: tok.term, offset: 0, length: tok.term.length, options };
      });
    }
    return out;
  }
}

function filterSource(source: Json, spec: Json): Json {
  if (spec === undefined || spec === true) return structuredClone(source);
  const includes: string[] | null = Array.isArray(spec) ? spec : typeof spec === 'string' ? [spec] : (spec.includes ?? null);
  const excludes: string[] = Array.isArray(spec) || typeof spec === 'string' ? [] : (spec.excludes ?? []);
  const out: Json = {};
  for (const [k, v] of Object.entries(source)) {
    if (includes && !includes.includes(k)) continue;
    if (excludes.includes(k)) continue;
    out[k] = structuredClone(v);
  }
  return out;
}
