import { useQuery } from '@tanstack/react-query';
import { call, useApi } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import type { IconName } from '@marketly/web-shared/ui';

// Content links and site chrome shared by the store layout and the browse screens.

const POLICY_VIEW: Record<string, string> = { returns: '', shipping: 'shipping', privacy: 'privacy', purchase_terms: 'purchase-terms', seller_rules: 'seller-rules' };

/**
 * Store route for a content link URL from the API (banners, CTAs, navigation). The API writes policy
 * links as /policies/{key}; the store shows policies at /policies?view=<slug>. Other paths are store
 * routes already; absolute URLs are returned as they are.
 */
export function contentLinkTo(url: string): string {
  const m = /^\/policies\/([a-z_]+)\/?$/.exec(url);
  if (m) return href('info/policy', POLICY_VIEW[m[1]!] ?? m[1]!.replace(/_/g, '-'));
  return url;
}

export const isExternal = (url: string) => /^[a-z]+:/i.test(url);

/** Icons the content module may name (promise items, page sections) that the icon set has. */
const CONTENT_ICONS = [
  'store', 'calendar-check', 'undo-2', 'life-buoy', 'shield-check', 'truck', 'badge-check', 'headset', 'lock', 'package-check', 'rotate-ccw',
  'tag', 'zap', 'gift', 'star', 'heart', 'clock', 'calendar', 'map-pin', 'warehouse', 'bed-double', 'lamp-desk', 'cooking-pot', 'coffee',
  'headphones', 'speaker', 'monitor', 'shirt', 'tent', 'sparkles', 'puzzle', 'paw-print', 'package', 'info', 'circle-check', 'ticket-percent',
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
