/**
 * What PostgreSQL did for the audit history and MongoDB does not: the simple text search behind q, and the text form
 * of an IP address (inet). Pure functions.
 */

/**
 * The words of a text for the search behind q (PostgreSQL's to_tsvector('simple', …) / plainto_tsquery): lower-case
 * runs of letters and digits, each once. A hyphenated or dotted token (MK-261002-55410, returns.window) gives its
 * parts, so a query matches when every one of its words is in the entry.
 */
export function searchWords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
}

/**
 * An address in the text form PostgreSQL's host(inet) gives (the hash covers it, so it must not change): IPv4 as is;
 * IPv6 in lower-case hex with the longest run of two or more zero groups (the first one on a tie) written as ::, and
 * an IPv4-compatible (::a.b.c.d) or IPv4-mapped (::ffff:a.b.c.d) address with its last 32 bits as a dotted quad.
 * `ip` is a valid address (net.isIP).
 */
export function normalizeIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  const words = ipv6Words(ip);
  let best = { base: -1, len: 0 };
  let cur = { base: -1, len: 0 };
  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) {
      if (cur.base === -1) cur = { base: i, len: 1 };
      else cur.len++;
    } else if (cur.base !== -1) {
      if (best.base === -1 || cur.len > best.len) best = cur;
      cur = { base: -1, len: 0 };
    }
  }
  if (cur.base !== -1 && (best.base === -1 || cur.len > best.len)) best = cur;
  if (best.base !== -1 && best.len < 2) best = { base: -1, len: 0 };

  let out = '';
  for (let i = 0; i < 8; i++) {
    if (best.base !== -1 && i >= best.base && i < best.base + best.len) {
      if (i === best.base) out += ':';
      continue;
    }
    if (i !== 0) out += ':';
    if (i === 6 && best.base === 0 && (best.len === 6 || (best.len === 5 && words[5] === 0xffff))) {
      return `${out}${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`;
    }
    out += words[i]!.toString(16);
  }
  if (best.base !== -1 && best.base + best.len === 8) out += ':';
  return out;
}

/** The eight 16-bit groups of an IPv6 address (with :: and a trailing dotted quad expanded) */
function ipv6Words(ip: string): number[] {
  let text = ip.toLowerCase();
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const part = (s: string | undefined) => (s ? s.split(':').map((h) => parseInt(h, 16)) : []);
  const left = part(head);
  const right = part(tail);
  return tail === undefined ? left : [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}
