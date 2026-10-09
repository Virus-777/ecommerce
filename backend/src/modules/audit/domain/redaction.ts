/**
 * Secrets are never stored (spec notes): keys listed in the redactKeys setting are masked in the
 * before/after JSON at record time. Pure functions.
 */

export const REDACTED = '[redacted]';

/** Keys whose values are account or card numbers keep their last 4 digits ("payout account numbers appear only as last 4 digits") */
const NUMBER_KEYS = /(account|card|iban|routing)/i;

/** Text columns and JSON strings cannot hold NUL in PostgreSQL. */
export const cleanText = (s: string): string => (s.includes('\u0000') ? s.replace(/\u0000/g, '') : s);

export const cleanOptionalText = (s: string | null | undefined): string | null => (s == null ? null : cleanText(s));

function maskValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (NUMBER_KEYS.test(key) && (typeof value === 'string' || typeof value === 'number')) {
    const digits = String(value).replace(/\D/g, '');
    return digits.length >= 4 ? `••••${digits.slice(-4)}` : REDACTED;
  }
  return REDACTED;
}

/**
 * Plain JSON copy of `value` with every property whose name contains one of `keys`
 * (case-insensitive, so "newPassword", "accessToken" and "clientSecret" are covered) masked.
 * Dates become ISO strings, undefined properties disappear, NUL characters are dropped.
 */
export function redact(value: unknown, keys: readonly string[]): unknown {
  if (value === undefined || value === null) return null;
  const plain = JSON.parse(JSON.stringify(value)) as unknown;
  const needles = keys.map((k) => k.toLowerCase()).filter(Boolean);
  const sensitive = (k: string) => {
    const lower = k.toLowerCase();
    return needles.some((n) => lower.includes(n));
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return cleanText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[cleanText(k)] = sensitive(k) ? maskValue(k, x) : walk(x);
      return out;
    }
    return v;
  };
  return walk(plain);
}
