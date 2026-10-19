import type { IconName } from '@marketly/web-shared/ui';
import { isOwn, type Creative } from './ads';

// Helpers for pages/admin/AdAssets.tsx (design: pages/admin/admin-ad-assets.html): creatives from
// GET /api/admin/advertising/creatives grouped by the campaign that uses them.

export type LinkState = Creative['linkCheck']['state'] | 'none';

export const CHECK_STYLE: Record<LinkState, { cls: string; icon: IconName }> = {
  ok: { cls: 't-success-text', icon: 'circle-check' },
  warn: { cls: 't-warning-text', icon: 'triangle-alert' },
  fail: { cls: 't-danger-text', icon: 'circle-x' },
  info: { cls: 'muted', icon: 'info' },
  none: { cls: 'muted', icon: 'info' },
};

/** Review reasons (design copy) → API reasonCode. */
export const REASONS: Array<{ label: string; code: 'no_changes' | 'unsupported_claim' | 'broken_link' | 'product_unavailable' | 'label_missing' | 'image_quality' | 'policy' }> = [
  { label: 'No changes needed', code: 'no_changes' },
  { label: 'Unsupported claim', code: 'unsupported_claim' },
  { label: 'Broken or wrong link', code: 'broken_link' },
  { label: 'Promoted product unavailable', code: 'product_unavailable' },
  { label: 'Label missing or hidden', code: 'label_missing' },
  { label: 'Image quality or crop', code: 'image_quality' },
  { label: 'Ad policy', code: 'policy' },
];
export const reasonLabel = (code?: string | null) => REASONS.find((r) => r.code === code)?.label ?? code ?? '';

export const ROLE_LABEL: Record<string, string> = { advertising: 'Advertising', content: 'Content', marketing: 'Marketing' };

export interface CreativeGroup {
  /** Campaign id, or "unused:<advertiser>" for creatives no campaign uses yet. */
  id: string;
  campaignId: string | null;
  name: string;
  advertiser: string;
  source: 'own' | 'paid';
  usedIn: string;
  campaignStatus?: string;
  creatives: Creative[];
}

export function groupCreatives(items: Creative[]): CreativeGroup[] {
  const map = new Map<string, CreativeGroup>();
  for (const c of items) {
    const use = c.usedIn[0];
    const campaignId = c.campaignId ?? use?.campaignId ?? null;
    const id = campaignId ?? `unused:${c.advertiser.name}`;
    let g = map.get(id);
    if (!g) {
      g = {
        id,
        campaignId,
        name: use?.name ?? (campaignId ? 'Campaign' : `${c.advertiser.name}: new uploads`),
        advertiser: c.advertiser.name,
        source: isOwn(c.advertiser) ? 'own' : 'paid',
        usedIn: c.usedIn.length ? c.usedIn.map((u) => u.name).join(', ') : 'Not used',
        campaignStatus: use?.status,
        creatives: [],
      };
      map.set(id, g);
    }
    g.creatives.push(c);
  }
  return [...map.values()];
}

/** "1600 × 900 · 412 KB", "44 / 60 characters", "15 s video". */
export function sizeLine(c: Creative, headlineMax = 60): string {
  if (c.kind === 'text') return `${(c.headline ?? '').length} / ${headlineMax} characters`;
  const dims = c.width && c.height ? `${c.width} × ${c.height}` : '';
  const bytes = c.bytes ? (c.bytes >= 1048576 ? `${(c.bytes / 1048576).toFixed(1)} MB` : `${Math.round(c.bytes / 1024)} KB`) : '';
  const dur = c.durationSeconds ? `${c.durationSeconds} s` : '';
  return [dims, bytes, dur].filter(Boolean).join(' · ') || '—';
}

export const fileLabel = (c: Creative) => (c.kind === 'text' ? 'Ad text' : (c.fileName ?? c.media?.alt ?? 'Untitled file'));

/** Tile preview shape from the creative's proportions. */
export function previewShape(c: Creative): 'wide' | 'tall' | 'band' | undefined {
  if (!c.width || !c.height) return c.device === 'phone' ? 'tall' : 'wide';
  const r = c.width / c.height;
  return r >= 3 ? 'band' : r < 0.9 ? 'tall' : r > 1.2 ? 'wide' : undefined;
}
