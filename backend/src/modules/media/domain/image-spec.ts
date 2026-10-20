/**
 * The product image spec (pure): setting media.productImage, the sizes that follow from it, the checks a product
 * image must pass, and how a rendition is fitted. The Admin Center validates the setting with the same rules
 * (web-shared/src/api/imageSpec.ts, validateProductImageSetting); settings checks them when a change is proposed.
 */
import type { ImageIssue, ProductImageSpec } from '../../../spec/media.js';

/** The editable setting media.productImage */
export interface ProductImageSetting {
  /** "W:H", e.g. "1:1", "4:5" */
  aspectRatio: string;
  detailWidth: number;
  thumbnailWidth: number;
  quality: number;
}

export const DEFAULT_PRODUCT_IMAGE: ProductImageSetting = { aspectRatio: '1:1', detailWidth: 800, thumbnailWidth: 320, quality: 80 };

/** A product image's ratio may differ this much (|w/h − W/H| ÷ (W/H)) */
export const RATIO_TOLERANCE = 0.01;

/** What processing_spec on an asset records */
export interface ProcessingSpec extends ProductImageSetting {
  /** Version of the setting the renditions were built with (null: the default, or not known) */
  settingsVersion: number | null;
}

/** "4:5" → { width: 4, height: 5 }; null unless two whole numbers 1–32 */
export function parseSpecRatio(text: unknown): { width: number; height: number } | null {
  const m = typeof text === 'string' ? /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(text) : null;
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width >= 1 && height >= 1 && width <= 32 && height <= 32 ? { width, height } : null;
}

/** Problems with a proposed value, by field ([] = valid) */
export function productImageSettingIssues(value: unknown): { path: string; message: string }[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ path: '', message: 'Must be { aspectRatio, detailWidth, thumbnailWidth, quality }' }];
  const v = value as Record<string, unknown>;
  const issues: { path: string; message: string }[] = [];
  const whole = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  const ratio = parseSpecRatio(v.aspectRatio);
  if (!ratio) issues.push({ path: 'aspectRatio', message: 'Enter the ratio as width:height with whole numbers 1–32, for example 1:1 or 4:5' });
  else if (ratio.height / ratio.width < 0.5 || ratio.height / ratio.width > 2) issues.push({ path: 'aspectRatio', message: 'Use a ratio between 2:1 (wide) and 1:2 (tall)' });
  const detailOk = whole(v.detailWidth, 480, 2048);
  if (!detailOk) issues.push({ path: 'detailWidth', message: 'Enter a whole number of pixels, 480–2048' });
  if (!whole(v.thumbnailWidth, 120, 640)) issues.push({ path: 'thumbnailWidth', message: 'Enter a whole number of pixels, 120–640' });
  else if (detailOk && (v.thumbnailWidth as number) >= (v.detailWidth as number)) issues.push({ path: 'thumbnailWidth', message: 'Make the thumbnail smaller than the product-page image' });
  if (!whole(v.quality, 50, 95)) issues.push({ path: 'quality', message: 'Enter a whole number, 50–95' });
  const extra = Object.keys(v).filter((k) => !['aspectRatio', 'detailWidth', 'thumbnailWidth', 'quality'].includes(k));
  if (extra.length) issues.push({ path: extra[0]!, message: 'Unknown field' });
  return issues;
}

/** The setting as stored, or the default when it is unusable (a value that never passed validation) */
export function toSetting(value: unknown): ProductImageSetting {
  if (productImageSettingIssues(value).length) return DEFAULT_PRODUCT_IMAGE;
  const v = value as ProductImageSetting;
  return { aspectRatio: v.aspectRatio.replace(/\s+/g, ''), detailWidth: v.detailWidth, thumbnailWidth: v.thumbnailWidth, quality: v.quality };
}

/** The spec with the ratio and both sizes worked out: height = round(width × H ÷ W) */
export function resolveSpec(s: ProductImageSetting): ProductImageSpec {
  const ratio = parseSpecRatio(s.aspectRatio) ?? { width: 1, height: 1 };
  const h = (w: number) => Math.round((w * ratio.height) / ratio.width);
  return {
    aspectRatio: `${ratio.width}:${ratio.height}`,
    detailWidth: s.detailWidth,
    thumbnailWidth: s.thumbnailWidth,
    quality: s.quality,
    ratio,
    detail: { width: s.detailWidth, height: h(s.detailWidth) },
    thumbnail: { width: s.thumbnailWidth, height: h(s.thumbnailWidth) },
  };
}

/** Whether width × height has the spec's ratio (within RATIO_TOLERANCE) */
export function hasRatio(width: number, height: number, spec: ProductImageSpec): boolean {
  if (!width || !height) return false;
  const want = spec.ratio.width / spec.ratio.height;
  return Math.abs(width / height - want) / want <= RATIO_TOLERANCE;
}

export const recropMessage = (spec: ProductImageSpec) => `Crop the image to ${spec.aspectRatio}. The Seller Center crops it for you when you upload.`;
export const tooSmallMessage = (spec: ProductImageSpec) => `The image must be at least ${spec.detail.width} × ${spec.detail.height}.`;

/**
 * The spec checks of a product image: the ratio (wrong_aspect) and at least the detail size (too_small).
 * severity: blocking at upload and attach; warning for images flagged after a ratio change.
 */
export function productImageIssues(size: { width: number; height: number }, spec: ProductImageSpec): ImageIssue[] {
  const issues: ImageIssue[] = [];
  if (!hasRatio(size.width, size.height, spec)) issues.push({ code: 'wrong_aspect', severity: 'blocking', message: recropMessage(spec) });
  if (size.width < spec.detail.width || size.height < spec.detail.height) issues.push({ code: 'too_small', severity: 'blocking', message: tooSmallMessage(spec) });
  return issues;
}

/* ------------------------------------------------------------------ rendition sizes */

export type RenditionSize = 'thumb' | 'small' | 'medium' | 'large' | 'zoom' | 'detail';

/** One rendition to build: width, and height for a cover fit (null: keep the image's own ratio) */
export interface RenditionTarget {
  size: RenditionSize;
  width: number;
  height: number | null;
}

/**
 * The output size of a rendition of a W × H image, never larger than the image:
 *   - height null: the target width (at most W), height by the image's ratio;
 *   - cover: the largest centred crop with the target's ratio, scaled down to the target (kept at the crop's
 *     size when the crop is smaller than the target).
 */
export function fitSize(W: number, H: number, t: Pick<RenditionTarget, 'width' | 'height'>): { width: number; height: number; cover: boolean } {
  if (t.height == null) {
    const width = Math.min(t.width, W);
    return { width, height: Math.max(1, Math.round((H * width) / W)), cover: false };
  }
  const aspect = t.width / t.height;
  const crop = W / H > aspect ? { width: Math.round(H * aspect), height: H } : { width: W, height: Math.round(W / aspect) };
  if (crop.width >= t.width) return { width: t.width, height: t.height, cover: true };
  return { width: Math.max(1, crop.width), height: Math.max(1, crop.height), cover: true };
}

/** Product images: detail and thumb, cover-fit at the spec when the image has its ratio, else at the widths only */
export function productTargets(width: number, height: number, spec: ProductImageSpec): RenditionTarget[] {
  const cover = hasRatio(width, height, spec);
  return [
    { size: 'detail', width: spec.detail.width, height: cover ? spec.detail.height : null },
    { size: 'thumb', width: spec.thumbnail.width, height: cover ? spec.thumbnail.height : null },
  ];
}

/** Other images: one rendition per width of renditionWidths; sizes wider than the image are made once, at its width */
export function widthTargets(widths: Record<string, number>, imageWidth: number): RenditionTarget[] {
  const sizes = Object.entries(widths).sort((a, b) => a[1] - b[1]);
  const out: RenditionTarget[] = [];
  let capped = false;
  for (const [size, w] of sizes) {
    if (w > imageWidth) {
      if (capped || sizes.some(([, x]) => x === imageWidth)) break;
      capped = true;
    }
    out.push({ size: size as RenditionSize, width: Math.min(w, imageWidth), height: null });
  }
  return out;
}
