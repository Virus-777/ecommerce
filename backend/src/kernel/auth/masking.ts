/**
 * Sensitive response fields (spec type fields with `permission` and `mask`), masked centrally for staff
 * and sellers who lack the permission. Handlers never decide; the paths are generated from the spec.
 */
type Sensitive = readonly { readonly path: readonly string[]; readonly permission: string; readonly mask: string }[];

export function maskValue(value: unknown, mask: string): unknown {
  if (value == null || mask === 'hide') return null;
  const s = String(value);
  if (mask === 'email') {
    const [user = '', domain = ''] = s.split('@');
    return `${user.slice(0, 1)}***@${domain}`;
  }
  if (mask === 'phone') return `***${s.slice(-2)}`;
  if (mask === 'name') return `${s.slice(0, 1)}.`;
  return null;
}

function applyAt(node: unknown, path: readonly string[], fn: (v: unknown) => unknown): unknown {
  if (node == null || typeof node !== 'object') return node;
  const [head, ...rest] = path;
  if (head === undefined) return node;
  if (head === '*') {
    if (Array.isArray(node)) return node.map((v) => (rest.length ? applyAt(v, rest, fn) : fn(v)));
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, rest.length ? applyAt(v, rest, fn) : fn(v)]));
  }
  if (!(head in node)) return node;
  const obj = node as Record<string, unknown>;
  return { ...obj, [head]: rest.length ? applyAt(obj[head], rest, fn) : fn(obj[head]) };
}

/** Returns the result with every field the caller may not see masked (the original is untouched). */
export async function maskResponse<T>(result: T, sensitive: Sensitive | undefined, can: (permission: string) => Promise<boolean>): Promise<T> {
  if (!sensitive?.length || result == null) return result;
  let out: unknown = result;
  for (const s of sensitive) {
    if (await can(s.permission)) continue;
    out = applyAt(out, s.path, (v) => maskValue(v, s.mask));
  }
  return out as T;
}
