import { useQuery } from '@tanstack/react-query';
import { call, useApi, type components } from '@marketly/web-shared/api';
import type { IconName } from '@marketly/web-shared/ui';

// Catalog reads shared by the store browse screens: the category tree (Categories, Category,
// Home shortcuts, Official Store shortcuts, NotFound) and brands. See web-shared/docs/API.md.

export type Category = components['schemas']['catalog.Category'];
export type MediaRef = components['schemas']['MediaRef'];


/** Visible category tree (not paged; counts refresh every 10 minutes). */
export function useCategoryTree() {
  const { api } = useApi();
  return useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => call(api.GET('/api/store/catalog/categories')),
    staleTime: 5 * 60_000,
  });
}

/** Depth-first list of every category in the tree. */
export function flattenTree(tree: Category[] | undefined): Category[] {
  const out: Category[] = [];
  const walk = (list: Category[]) =>
    list.forEach((c) => {
      out.push(c);
      walk(c.children ?? []);
    });
  walk(tree ?? []);
  return out;
}

/** Finds a category by id or slug anywhere in the tree. */
export function findCategory(tree: Category[] | undefined, key: { id?: string | null; slug?: string | null }): Category | undefined {
  return flattenTree(tree).find((c) => (key.id ? c.id === key.id : c.slug === key.slug));
}

/**
 * Placeholder art for a category tile when the API has no image (`Category.image` is optional):
 * the design's icon and tint per category slug, with a neutral default for new categories.
 */
const ART: Record<string, { icon: IconName; tint: string }> = {
  electronics: { icon: 'headphones', tint: '2' },
  headphones: { icon: 'headphones', tint: '2' },
  speakers: { icon: 'speaker', tint: '2' },
  'smart-home': { icon: 'house', tint: '2' },
  cameras: { icon: 'camera', tint: '2' },
  wearables: { icon: 'watch', tint: '2' },
  computers: { icon: 'monitor', tint: '6' },
  monitors: { icon: 'monitor', tint: '6' },
  storage: { icon: 'hard-drive', tint: '6' },
  keyboards: { icon: 'keyboard', tint: '6' },
  laptops: { icon: 'laptop', tint: '6' },
  accessories: { icon: 'usb', tint: '6' },
  'home-and-kitchen': { icon: 'cooking-pot', tint: '3' },
  cookware: { icon: 'cooking-pot', tint: '3' },
  bedding: { icon: 'bed-double', tint: '3' },
  lighting: { icon: 'lamp-desk', tint: '3' },
  'coffee-and-tea': { icon: 'coffee', tint: '3' },
  cleaning: { icon: 'bot', tint: '3' },
  fashion: { icon: 'shirt', tint: '4' },
  knitwear: { icon: 'shirt', tint: '4' },
  shoes: { icon: 'footprints', tint: '4' },
  bags: { icon: 'shopping-bag', tint: '4' },
  outerwear: { icon: 'shirt', tint: '4' },
  'accessories-2': { icon: 'watch', tint: '4' },
  'sports-and-outdoors': { icon: 'tent', tint: '1' },
  hiking: { icon: 'backpack', tint: '1' },
  running: { icon: 'footprints', tint: '1' },
  yoga: { icon: 'activity', tint: '1' },
  cycling: { icon: 'gauge', tint: '1' },
  camping: { icon: 'tent', tint: '1' },
  beauty: { icon: 'sparkles', tint: '5' },
  skincare: { icon: 'droplet', tint: '5' },
  hair: { icon: 'scissors', tint: '5' },
  fragrance: { icon: 'flower-2', tint: '5' },
  bath: { icon: 'sparkles', tint: '5' },
  'toys-and-games': { icon: 'puzzle', tint: '3' },
  puzzles: { icon: 'puzzle', tint: '3' },
  'board-games': { icon: 'layout-grid', tint: '3' },
  'building-sets': { icon: 'boxes', tint: '3' },
  'pet-supplies': { icon: 'paw-print', tint: '2' },
  dog: { icon: 'paw-print', tint: '2' },
  cat: { icon: 'paw-print', tint: '2' },
  'small-pets': { icon: 'paw-print', tint: '2' },
  'garden-and-outdoor': { icon: 'flower-2', tint: '1' },
  automotive: { icon: 'car', tint: '6' },
};
export const categoryArt = (slug: string | null | undefined, parentSlug?: string | null): { icon: IconName; tint: string } =>
  ART[slug ?? ''] ?? { icon: ART[parentSlug ?? '']?.icon ?? 'package', tint: ART[parentSlug ?? '']?.tint ?? '1' };

/** A brand by slug (brand page header). */
export function useBrand(slug: string) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['catalog', 'brand', slug],
    queryFn: () => call(api.GET('/api/store/catalog/brands/{slug}', { params: { path: { slug } } })),
  });
}

/** Two-letter initials for a logo tile without a logo image. */
export const initialsOf = (name: string) =>
  name
    .replace(/&/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .slice(0, 2)
    .join('');

/** Stable placeholder tint (1–6) for a name, so a brand or store keeps its colour across pages. */
export const tintOf = (name: string) => String((Array.from(name).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 6) + 1);
