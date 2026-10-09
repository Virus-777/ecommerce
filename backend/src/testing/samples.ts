/**
 * The smallest valid value for a spec schema (Zod 4): required fields only, lower bounds for
 * numbers and lengths, the first enum value. Lets tests send requests that pass validation.
 */
import type { z } from 'zod';
import { newId } from '../kernel/lib/ids.js';

type Def = Record<string, any> & { type: string };
const defOf = (s: z.ZodType): Def => (s as any)._zod.def;
const checksOf = (d: Def): Record<string, any>[] => (d.checks ?? []).map((c: any) => c._zod.def);

const FORMATS: Record<string, () => string> = {
  uuid: newId,
  guid: newId,
  email: () => 'sample@example.com',
  url: () => 'https://example.com/sample',
  datetime: () => '2026-01-01T00:00:00Z',
  date: () => '2026-01-01',
  time: () => '12:00:00',
};

function sampleString(d: Def): string {
  const make = d.format && FORMATS[d.format];
  if (make) return make();
  let v = 'sample';
  for (const c of checksOf(d)) {
    if (c.check === 'min_length' && v.length < c.minimum) v = v.padEnd(c.minimum, 'x');
    if (c.check === 'max_length' && v.length > c.maximum) v = v.slice(0, c.maximum);
    if (c.check === 'length_equals') v = v.padEnd(c.length, 'x').slice(0, c.length);
  }
  return v;
}

function sampleNumber(d: Def): number {
  const checks = checksOf(d);
  const int = checks.some((c) => c.check === 'number_format' && /int/.test(c.format));
  const step = int ? 1 : 0.5;
  let v = 1;
  for (const c of checks) if (c.check === 'greater_than') v = c.inclusive ? c.value : c.value + step;
  for (const c of checks) if (c.check === 'less_than' && v > c.value) v = c.inclusive ? c.value : c.value - step;
  const m = checks.find((c) => c.check === 'multiple_of')?.value;
  return m ? Math.ceil(v / m) * m : v;
}

export interface SampleOptions {
  /** Smallest array length (query strings can't express an empty array) */
  minItems?: number;
}

export function sample(schema: z.ZodType, o: SampleOptions = {}, depth = 0): unknown {
  if (depth > 25) return undefined;
  const d = defOf(schema);
  const next = (s: z.ZodType) => sample(s, o, depth + 1);
  switch (d.type) {
    case 'string':
      return sampleString(d);
    case 'number':
      return sampleNumber(d);
    case 'bigint':
      return 1n;
    case 'boolean':
      return true;
    case 'enum':
      return Object.values(d.entries)[0];
    case 'literal':
      return d.values[0];
    case 'null':
      return null;
    case 'undefined':
    case 'void':
      return undefined;
    case 'any':
    case 'unknown':
      return {};
    case 'date':
      return new Date('2026-01-01T00:00:00Z');
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'nonoptional':
      return next(d.innerType);
    case 'lazy':
      return next(d.getter());
    case 'array': {
      const min = checksOf(d).find((c) => c.check === 'min_length' || c.check === 'length_equals');
      return Array.from({ length: Math.max(min?.minimum ?? min?.length ?? 0, o.minItems ?? 0) }, () => next(d.element));
    }
    case 'tuple':
      return d.items.map(next);
    case 'record':
      return {};
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(d.shape as Record<string, z.ZodType>)) {
        if (!['optional', 'default', 'prefault'].includes(defOf(s).type)) out[k] = next(s);
      }
      return out;
    }
    case 'union': {
      for (const o of d.options as z.ZodType[]) {
        const v = next(o);
        if (o.safeParse(v).success) return v;
      }
      return next(d.options[0]);
    }
    case 'intersection':
      return { ...(next(d.left) as object), ...(next(d.right) as object) };
    case 'pipe': {
      // preprocess: sample the target; codecs such as z.stringbool(): try the input, then string forms of the output
      if (defOf(d.in).type === 'transform') return next(d.out);
      const out = next(d.out);
      for (const v of [next(d.in), String(out)]) if (schema.safeParse(v).success) return v;
      return out;
    }
    default:
      return undefined;
  }
}

/** A sample and whether the schema accepts it (false: the test can't build valid input, so 400 is expected). */
export function validSample(schema: z.ZodType | undefined): { value: unknown; valid: boolean } {
  if (!schema) return { value: undefined, valid: true };
  const value = sample(schema);
  return { value, valid: schema.safeParse(value).success };
}

/** Path params as strings */
export function sampleParams(schema: z.ZodType | undefined): Record<string, string> {
  const v = (schema ? sample(schema) : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(v ?? {}).map(([k, x]) => [k, String(x)]));
}

/** A query string from a query schema sample (arrays repeat the key) */
export function sampleQuery(schema: z.ZodType | undefined): string {
  if (!schema) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries((sample(schema, { minItems: 1 }) ?? {}) as Record<string, unknown>)) {
    for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined && x !== null) q.append(k, typeof x === 'object' ? JSON.stringify(x) : String(x));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
