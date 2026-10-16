import type { components } from '@marketly/web-shared/api';
import type { IconName, Tone } from '@marketly/web-shared/ui';

// Admin Categories and brands (design: pages/admin/admin-categories.html, --brands), fed by
// GET /api/admin/catalog/categories, /categories/{id}/attributes, /brands and sellers change requests.

export type ApiCategory = components['schemas']['catalog.Category'];
export type ApiAttribute = components['schemas']['catalog.Attribute'];
export type ImageRule = components['schemas']['catalog.ImageRule'];
export type BrandAdmin = components['schemas']['catalog.BrandAdmin'];
export type ChangeRequest = components['schemas']['sellers.ChangeRequest'];

export interface CategoryNode {
  id: string;
  name: string;
  /** Parent category id; null = top level. */
  parent: string | null;
  /** Active products with at least one eligible offer. */
  count: number;
  offers: number;
  slug: string;
  position: number;
  /** "Show in store menus and search filters". */
  visible: boolean;
  /** What the store shows when the category has no eligible inventory. */
  empty: 'hide' | 'soon';
  /** Created here and not yet saved. */
  isNew?: boolean;
}

export function flattenTree(tree: ApiCategory[], parent: string | null = null): CategoryNode[] {
  return tree.flatMap((c) => [
    { id: c.id, name: c.name, parent, count: c.productCount ?? 0, offers: c.offerCount ?? 0, slug: c.slug, position: c.position ?? 0, visible: c.visible, empty: c.comingSoon ? ('soon' as const) : ('hide' as const) },
    ...flattenTree((c.children ?? []) as ApiCategory[], c.id),
  ]);
}

export const ATTR_TYPES = ['Text', 'Number', 'List', 'List · variation', 'Yes / No'];

export interface CategoryAttribute {
  /** Row key in the editor (the saved id, or a local key for a new row). */
  id: string;
  /** The attribute's id once saved; null for a row added here (the server makes the id). */
  savedId: string | null;
  name: string;
  type: string;
  /** Options (lists) or unit (numbers). */
  values: string;
  options: string[];
  unit: string | null;
  required: boolean;
  filterable: boolean;
  /** Products in the category with a value. */
  filled: number;
  /** Required flag as saved (drift = unsaved change). */
  publishedRequired: boolean;
  /** Inherited from a parent category: not editable here. */
  inherited?: string;
}

export function attrType(a: ApiAttribute): string {
  if (a.kind === 'enum') return a.variantDefining ? 'List · variation' : 'List';
  return a.kind === 'number' ? 'Number' : a.kind === 'bool' ? 'Yes / No' : 'Text';
}

export type AttributeInput = components['schemas']['catalog.AttributeInput'];

/** Editor row -> AttributeInput: saved attributes keep their id; new ones go without (no categoryId: the route names it). */
export function toApiAttribute(a: CategoryAttribute): AttributeInput {
  const kind = a.type === 'Number' ? 'number' : a.type === 'Yes / No' ? 'bool' : a.type.startsWith('List') ? 'enum' : 'text';
  return { ...(a.savedId ? { id: a.savedId } : {}), name: a.name.trim(), kind, unit: a.unit, options: a.options, required: a.required, filterable: a.filterable, variantDefining: a.type === 'List · variation' };
}

export const ruleIcon = (r: ImageRule): IconName => {
  const c = (r.check ?? {}) as Record<string, unknown>;
  if ('minWidth' in c || 'minHeight' in c) return 'maximize';
  if ('minCount' in c) return 'images';
  if (/text|watermark|overlay/i.test(r.text)) return 'type';
  if (/background/i.test(r.text)) return 'square';
  return 'scan-eye';
};

/* ---------------- Brands ---------------- */

export type BrandStatusKey = BrandAdmin['status'];
export type SellingPolicy = BrandAdmin['sellingPolicy'];
export const BRAND_STATUS_LABEL: Record<BrandStatusKey, string> = { active: 'Active', under_review: 'Under review', blocked: 'Blocked' };
export const BRAND_STATUS_TONE: Record<BrandStatusKey, Tone> = { active: 'success', under_review: 'info', blocked: 'danger' };
export const WHO_CAN_SELL: Record<SellingPolicy, string> = { authorized_list: 'Authorized seller list', open: 'Open to all sellers', official_only: 'Official Store only' };

/** Brand row note under the name. */
export function brandNote(b: BrandAdmin): { text: string; warn: boolean } {
  if (b.flagNote) return { text: b.flagNote, warn: true };
  if (b.status === 'blocked') return { text: `Blocked${b.statusReason ? `: ${b.statusReason}` : ''}`, warn: false };
  if (b.status === 'under_review') return { text: b.requestedBy ? 'Requested by a seller with a product submission' : b.statusReason ?? 'Under review', warn: true };
  if (b.productCount === 0) return { text: 'No products yet', warn: false };
  return { text: b.pageLive ? 'Brand page live' : 'Brand page not live (no product in stock)', warn: false };
}

export const initialsOf = (name: string) => {
  const words = name.split(/\s+/).filter((w) => /^[A-Za-z0-9&]/.test(w));
  return (words.length > 1 ? words.slice(0, 2).map((w) => w[0]).join('') : name.slice(0, 2)).toUpperCase();
};
export const tintOf = (id: string) => String((id.split('').reduce((s, ch) => s + ch.charCodeAt(0), 0) % 6) + 1);

/** A change request as one line in "Brand claims waiting". */
export function claimLine(c: ChangeRequest): string {
  const p = (c.proposed ?? {}) as Record<string, unknown>;
  const what = c.kind === 'brand_request' ? `add brand "${String(p.name ?? p.brandName ?? '')}"` : `"${String(p.text ?? p.label ?? 'Brand claim')}" label`;
  return `${c.storeName} · ${what}`;
}
