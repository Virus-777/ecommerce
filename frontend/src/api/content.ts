import { useQuery } from '@tanstack/react-query';
import { call, useApi } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import type { IconName } from '@marketly/web-shared/ui';

// Content links and site chrome shared by the store layout and the browse screens.

const POLICY_VIEW: Record<string, string> = { returns: '', shipping: 'shipping', privacy: 'privacy', purchase_terms: 'purchase-terms', seller_rules: 'seller-rules' };

/**
 * Store route for a content link URL from the API (banners, CTAs, navigation). The API writes policy
 * links as /policies/{key}; the store shows policies at /policies?view=<slug>. Campaign pages (/pages/{slug})
 * and collections (/collections/{slug}) open the store's page route /collection/{slug}. Other paths are store
 * routes already; absolute URLs are returned as they are.
 */
export function contentLinkTo(url: string): string {
  const m = /^\/policies\/([a-z_]+)\/?$/.exec(url);
  if (m) return href('info/policy', POLICY_VIEW[m[1]!] ?? m[1]!.replace(/_/g, '-'));
  const page = /^\/(?:pages|collections)\/([^/?#]+)\/?([?#].*)?$/.exec(url);
  if (page) return href('store/collection', '', { slug: decodeURIComponent(page[1]!) }) + (page[2] ?? '');
  return url;
}

export const isExternal = (url: string) => /^[a-z]+:/i.test(url);

/**
 * contentLinkTo for links staff edit (header and footer navigation, service strip), or null when the URL
 * is not one the store should open: only store paths, #anchors, http(s), mailto and tel. The backend
 * already refuses javascript:, data: and protocol-relative URLs on save (content domain/rules.ts); this
 * keeps a bad row from ever becoming a clickable link if one slips through.
 */
export function safeContentLinkTo(url: string | null | undefined): string | null {
  const u = (url ?? '').trim();
  if (!u) return null;
  if (u.startsWith('/') && !u.startsWith('//')) return contentLinkTo(u);
  if (u.startsWith('#') || /^(https?:\/\/|mailto:|tel:)/i.test(u)) return u;
  return null;
}

/** Icons the content module may name (promise items, page sections) that the icon set has. */
const CONTENT_ICONS = [
  'store', 'calendar-check', 'undo-2', 'life-buoy', 'shield-check', 'truck', 'badge-check', 'headset', 'lock', 'package-check', 'rotate-ccw',
  'tag', 'zap', 'gift', 'star', 'heart', 'clock', 'calendar', 'map-pin', 'warehouse', 'bed-double', 'lamp-desk', 'cooking-pot', 'coffee',
  'headphones', 'speaker', 'monitor', 'shirt', 'tent', 'sparkles', 'puzzle', 'paw-print', 'package', 'info', 'circle-check', 'ticket-percent',
  'megaphone', 'newspaper',
] as const satisfies readonly IconName[];

/** An icon name from API content, or the fallback when the icon set doesn't have it. */
export const contentIcon = (name: string | null | undefined, fallback: IconName = 'circle-check'): IconName =>
  (CONTENT_ICONS as readonly string[]).includes(name ?? '') ? (name as IconName) : fallback;

/** Header/footer links, service strip and contact details (rarely changes). */
export function useNavigation() {
  const { api } = useApi();
  return useQuery({
    queryKey: ['content', 'navigation'],
    queryFn: () => call(api.GET('/api/store/content/navigation')),
    staleTime: 10 * 60_000,
  });
}

/** The Official Store profile: name, logo, banner, introduction, policy links and feedback (G8). */
export function useOfficialStore() {
  const { api } = useApi();
  return useQuery({
    queryKey: ['content', 'official-store'],
    queryFn: () => call(api.GET('/api/store/content/official-store')),
    staleTime: 10 * 60_000,
  });
}
