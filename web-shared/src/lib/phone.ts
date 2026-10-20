// Phone number input mask: the market's phone format (app-config market.phoneFormat, set in Admin Center ›
// Settings › Market). `#` is one digit; any other character is shown once a digit follows it, so "5035" →
// "(503) 5" and "5035550142" → "(503) 555-0142". An international number ("+44 …" when the pattern has no "+") or
// one longer than the pattern stays as typed. The Android app applies the same rules (core/ui/PhoneMask.kt).

export const DEFAULT_PHONE_FORMAT = '(###) ###-####';

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** The digits of `t` that fill the pattern's slots: a typed copy of its prefix ("+1 ") doesn't count. */
function slotDigits(t: string, pattern: string): string {
  const prefix = pattern.slice(0, Math.max(0, pattern.indexOf('#')));
  if (!prefix.trim()) return digitsOf(t);
  if (t.startsWith(prefix)) return digitsOf(t.slice(prefix.length));
  if (t.startsWith(prefix.trimEnd())) return digitsOf(t.slice(prefix.trimEnd().length));
  return digitsOf(t);
}

/** `input` formatted with `pattern` (see the rules above). */
export function formatPhone(input: string, pattern: string): string {
  const slots = [...pattern].filter((c) => c === '#').length;
  if (slots === 0) return input;
  const t = input.trimStart();
  if (t.startsWith('+') && !pattern.startsWith('+')) return input;
  const d = slotDigits(t, pattern);
  if (!d) return '';
  if (d.length > slots) return input;
  let out = '';
  let i = 0;
  for (const c of pattern) {
    if (i === d.length) break;
    out += c === '#' ? d[i++] : c;
  }
  return out;
}

/** Digits that fill an example number: the fictional US number 201-555-0123, then more digits for longer patterns. */
const EXAMPLE_DIGITS = '2015550123456789';

/** An example number in `pattern`, for placeholders: "(###) ###-####" → "(201) 555-0123". */
export function phoneExample(pattern: string): string {
  let i = 0;
  return pattern.replace(/#/g, () => EXAMPLE_DIGITS[i++ % EXAMPLE_DIGITS.length]!);
}

/**
 * One edit of a masked field: `prev` was in the field, the browser now has `next` with the caret at `caret`.
 * Backspace over a literal (")", "-") removes the digit before it too (the literal alone would come straight back);
 * the caret stays after the same digit.
 */
export function phoneEdit(prev: string, next: string, caret: number, pattern: string): { value: string; caret: number } {
  let text = next;
  let at = Math.min(caret, next.length);
  if (next.length === prev.length - 1 && digitsOf(next) === digitsOf(prev)) {
    let removed = 0;
    while (removed < next.length && next[removed] === prev[removed]) removed++;
    let j = Math.min(removed, text.length) - 1;
    while (j >= 0 && !/\d/.test(text[j]!)) j--;
    if (j >= 0) {
      text = text.slice(0, j) + text.slice(j + 1);
      at = j;
    }
  }
  const value = formatPhone(text, pattern);
  if (value === text) return { value, caret: at };
  // after the k-th typed digit, i.e. after the pattern's k-th '#'
  const k = slotDigits(text.slice(0, at).trimStart(), pattern).length;
  const slots = [...pattern].flatMap((c, i) => (c === '#' ? [i] : []));
  const pos = k === 0 ? slots[0]! : slots[Math.min(k, slots.length) - 1]! + 1;
  return { value, caret: Math.min(pos, value.length) };
}
