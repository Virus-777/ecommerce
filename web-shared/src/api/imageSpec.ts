import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { endIfUnauthorized } from './client';
import { ApiError, toApiError } from './errors';
import { useApi } from './provider';
import type { Session } from './session';

// Product image spec: the aspect ratio every product image is cropped to, and the two sizes the backend keeps
// for it — `detail` (product page) and `thumbnail` (cards, lists, cart, orders). Staff edit it in the Admin
// Center (setting `media.productImage`); every app reads it from GET /api/<area>/media/image-specs.
// Backend contract: web-shared/docs/BACKEND-PRODUCT-IMAGES.md. Until the backend serves the endpoint, the apps
// use DEFAULT_PRODUCT_IMAGE_SETTING (1:1, 800 × 800, 320 × 320).

/** The editable setting (`media.productImage`). Heights follow from the ratio. */
export interface ProductImageSetting {
  /** "W:H", e.g. "1:1", "4:5". */
  aspectRatio: string;
  /** Product-page image width in px. */
  detailWidth: number;
  /** Thumbnail width in px. */
  thumbnailWidth: number;
  /** Encoder quality 50–95. */
  quality: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The resolved spec the apps work with. */
export interface ProductImageSpec extends ProductImageSetting {
  ratio: Size;
  detail: Size;
  thumbnail: Size;
  /** False while the backend doesn't serve the spec yet (the defaults are in use). */
  fromServer: boolean;
}

export const DEFAULT_PRODUCT_IMAGE_SETTING: ProductImageSetting = { aspectRatio: '1:1', detailWidth: 800, thumbnailWidth: 320, quality: 80 };

/** Limits the Admin Center enforces (the backend validates the same). */
export const PRODUCT_IMAGE_LIMITS = {
  ratioPart: { min: 1, max: 32 },
  /** Height ÷ width between 1:2 (wide) and 2:1 (tall). */
  ratio: { min: 0.5, max: 2 },
  detailWidth: { min: 480, max: 2048 },
  thumbnailWidth: { min: 120, max: 640 },
  quality: { min: 50, max: 95 },
} as const;

/** "4:5" → { width: 4, height: 5 }; null when it isn't two positive whole numbers. */
export function parseRatio(text: string): Size | null {
  const m = /^\s*(\d{1,2})\s*[:x×/]\s*(\d{1,2})\s*$/i.exec(text);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Problems with a setting, by field (empty when it is valid). */
export function validateProductImageSetting(s: ProductImageSetting): Partial<Record<keyof ProductImageSetting, string>> {
  const L = PRODUCT_IMAGE_LIMITS;
  const e: Partial<Record<keyof ProductImageSetting, string>> = {};
  const r = parseRatio(s.aspectRatio);
  if (!r) e.aspectRatio = 'Enter the ratio as width:height, for example 1:1 or 4:5.';
  else if (r.width > L.ratioPart.max || r.height > L.ratioPart.max) e.aspectRatio = `Use whole numbers up to ${L.ratioPart.max}.`;
  else if (r.height / r.width < L.ratio.min || r.height / r.width > L.ratio.max) e.aspectRatio = 'Use a ratio between 2:1 (wide) and 1:2 (tall).';
  if (!Number.isInteger(s.detailWidth) || s.detailWidth < L.detailWidth.min || s.detailWidth > L.detailWidth.max) e.detailWidth = `Enter ${L.detailWidth.min}–${L.detailWidth.max} px.`;
  if (!Number.isInteger(s.thumbnailWidth) || s.thumbnailWidth < L.thumbnailWidth.min || s.thumbnailWidth > L.thumbnailWidth.max) e.thumbnailWidth = `Enter ${L.thumbnailWidth.min}–${L.thumbnailWidth.max} px.`;
  else if (!e.detailWidth && s.thumbnailWidth >= s.detailWidth) e.thumbnailWidth = 'Make the thumbnail smaller than the product-page image.';
  if (!Number.isInteger(s.quality) || s.quality < L.quality.min || s.quality > L.quality.max) e.quality = `Enter ${L.quality.min}–${L.quality.max}.`;
  return e;
}

/** The setting with heights worked out from the ratio (rounded to whole pixels). */
export function resolveProductImageSpec(s: ProductImageSetting, fromServer = false): ProductImageSpec {
  const ratio = parseRatio(s.aspectRatio) ?? { width: 1, height: 1 };
  const h = (w: number) => Math.round((w * ratio.height) / ratio.width);
  return { ...s, ratio, detail: { width: s.detailWidth, height: h(s.detailWidth) }, thumbnail: { width: s.thumbnailWidth, height: h(s.thumbnailWidth) }, fromServer };
}

export const DEFAULT_PRODUCT_IMAGE_SPEC = resolveProductImageSpec(DEFAULT_PRODUCT_IMAGE_SETTING);

/** "800 × 1000" */
export const sizeText = (s: Size) => `${s.width} × ${s.height}`;

async function fetchSpec(session: Session): Promise<ProductImageSpec> {
  const get = (token: string) => fetch(`/api/${session.audience}/media/image-specs`, { headers: { Authorization: `Bearer ${token}`, 'X-Client': 'web' } });
  let res = await get(await session.token());
  if (res.status === 401) res = await get(await session.refresh());
  if (res.status === 401) endIfUnauthorized(session, 401, await res.clone().json().catch(() => undefined));
  // Not served yet (backend not updated): use the defaults.
  if (res.status === 404 || res.status === 405 || res.status === 501) return DEFAULT_PRODUCT_IMAGE_SPEC;
  if (!res.ok) throw await toApiError(res);
  const body = (await res.json()) as { productImage?: Partial<ProductImageSetting> };
  const s = { ...DEFAULT_PRODUCT_IMAGE_SETTING, ...(body.productImage ?? {}) };
  return resolveProductImageSpec(Object.keys(validateProductImageSetting(s)).length ? DEFAULT_PRODUCT_IMAGE_SETTING : s, true);
}

export const productImageSpecKey = (audience: string) => ['media', 'image-specs', audience] as const;

/** The product image spec for this app (defaults while loading or when the backend doesn't serve it). */
export function useProductImageSpec(): { spec: ProductImageSpec; loading: boolean; error: ApiError | null } {
  const { session } = useApi();
  const q = useQuery({ queryKey: productImageSpecKey(session.audience), queryFn: () => fetchSpec(session), staleTime: 10 * 60_000, retry: 1 });
  return { spec: q.data ?? DEFAULT_PRODUCT_IMAGE_SPEC, loading: q.isPending, error: q.error instanceof ApiError ? q.error : null };
}

/**
 * Sets `--product-ratio` on the page so product image frames (cards, gallery) follow the configured aspect ratio
 * (see app.css). Render once near the app root.
 */
export function ProductImageRatio() {
  const { spec } = useProductImageSpec();
  useEffect(() => {
    document.documentElement.style.setProperty('--product-ratio', `${spec.ratio.width} / ${spec.ratio.height}`);
  }, [spec.ratio.width, spec.ratio.height]);
  return null;
}

/** The URL of one rendition size of a product image, falling back to the asset's default URL. */
export function renditionUrl(media: { url?: string | null; renditions?: Array<{ size: string; url?: string | null }> | null; thumbUrl?: string | null; detailUrl?: string | null } | null | undefined, size: 'thumb' | 'detail'): string | undefined {
  if (!media) return undefined;
  const direct = size === 'thumb' ? media.thumbUrl : media.detailUrl;
  return direct ?? media.renditions?.find((r) => r.size === size)?.url ?? (size === 'thumb' ? media.renditions?.find((r) => r.size === 'small')?.url : undefined) ?? media.url ?? undefined;
}
