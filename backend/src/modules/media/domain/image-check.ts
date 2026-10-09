/**
 * Image standard checks (pure): evaluates measurements against the caller's rules (catalog category,
 * ad placement) plus the platform baseline, in plain language for the seller.
 */
import type { ImageIssue, ImageMeasurements, ImageRules } from '../../../spec/media.js';

export interface BaselineRules {
  minShortSide?: number;
  formats?: string[];
}

export interface CheckSubject {
  format: string;
  sizeBytes: number;
  measured: ImageMeasurements;
}

/** Below this sharpness (variance of Laplacian) an image looks blurry */
export const BLURRY_BELOW = 60;
/** Share of near-white border pixels for a white / light background */
export const WHITE_BACKGROUND = 0.9;
export const LIGHT_BACKGROUND = 0.6;
/** Text covering more than this share of the image counts as a text overlay */
export const TEXT_OVERLAY_ABOVE = 0.1;
const DEFAULT_ASPECT_TOLERANCE = 0.02;

const px = (n: number) => `${n.toLocaleString('en-US')} px`;
const FORMAT_NAMES: Record<string, string> = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', heic: 'HEIC', gif: 'GIF', avif: 'AVIF' };
const formatName = (f: string) => FORMAT_NAMES[f] ?? f.toUpperCase();
const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;

export function parseRatio(r: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/i.exec(r);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    return w > 0 && h > 0 ? w / h : null;
  }
  const n = Number(r);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "4:3" for common ratios, else "1.33:1" */
function describeAspect(aspect: number): string {
  const common = ['1:1', '4:5', '5:4', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '2:1', '1:2', '21:9'];
  for (const c of common) if (Math.abs(parseRatio(c)! - aspect) / aspect < 0.01) return c;
  return `${aspect.toFixed(2)}:1`;
}

/**
 * The caller's explicit size rules replace the baseline minimum (an ad banner may be 90 px tall);
 * the baseline formats always apply.
 */
export function evaluateImage(subject: CheckSubject, rules: ImageRules, baseline: BaselineRules): ImageIssue[] {
  const issues: ImageIssue[] = [];
  const { width, height } = subject.measured;
  const short = Math.min(width, height);
  const blocking = (code: ImageIssue['code'], message: string) => issues.push({ code, severity: 'blocking', message });
  const warning = (code: ImageIssue['code'], message: string) => issues.push({ code, severity: 'warning', message });

  /* size */
  const hasOwnSize = rules.minWidth != null || rules.minHeight != null || rules.minShortSide != null;
  if (rules.minWidth != null && width < rules.minWidth) blocking('too_small', `Image is ${px(width)} wide; this needs at least ${px(rules.minWidth)}.`);
  if (rules.minHeight != null && height < rules.minHeight) blocking('too_small', `Image is ${px(height)} tall; this needs at least ${px(rules.minHeight)}.`);
  const minShort = rules.minShortSide ?? (hasOwnSize ? undefined : baseline.minShortSide);
  if (minShort != null && short < minShort) blocking('too_small', `The shorter side is ${px(short)}; it needs to be at least ${px(minShort)}.`);

  /* aspect ratio */
  const ratios = rules.aspectRatios.map((r) => [r, parseRatio(r)] as const).filter((r): r is readonly [string, number] => r[1] !== null);
  if (ratios.length) {
    const tolerance = rules.aspectTolerance ?? DEFAULT_ASPECT_TOLERANCE;
    const aspect = subject.measured.aspect;
    if (!ratios.some(([, r]) => Math.abs(aspect - r) / r <= tolerance)) {
      blocking('wrong_aspect', `Image is ${describeAspect(aspect)}; allowed: ${ratios.map(([s]) => s.trim()).join(', ')}.`);
    }
  }

  /* format and file size */
  const formats = new Set([...(baseline.formats ?? [])].map((f) => f.toLowerCase()));
  const callerFormats = rules.formats.map((f) => f.toLowerCase());
  const both = callerFormats.filter((f) => !formats.size || formats.has(f));
  const allowed = callerFormats.length ? (both.length ? both : callerFormats) : [...formats];
  if (allowed.length && !allowed.includes(subject.format)) {
    blocking('format_not_allowed', `${formatName(subject.format)} isn't accepted here; use ${allowed.map(formatName).join(', ')}.`);
  }
  if (rules.maxBytes != null && subject.sizeBytes > rules.maxBytes) {
    blocking('too_large', `The file is ${mb(subject.sizeBytes)}; the limit here is ${mb(rules.maxBytes)}.`);
  }

  /* background, watermark, text */
  const white = subject.measured.backgroundWhiteness;
  if (rules.background === 'white' && white != null && white < WHITE_BACKGROUND) {
    blocking('background_not_white', 'The background needs to be pure white.');
  } else if (rules.background === 'light' && white != null && white < LIGHT_BACKGROUND) {
    blocking('background_not_white', 'The background needs to be white or light.');
  }
  if (rules.allowWatermark === false && subject.measured.watermarkLikely) blocking('watermark', 'The image seems to have a watermark or logo overlay; remove it.');
  const text = subject.measured.textCoverage;
  if (rules.allowTextOverlay === false && text != null && text > TEXT_OVERLAY_ABOVE) blocking('text_overlay', 'The image has text over it; use a clean photo.');

  /* platform-wide warnings */
  const sharp = subject.measured.sharpness;
  if (sharp != null && sharp < BLURRY_BELOW) warning('blurry', 'The image looks blurry; a sharper photo sells better.');
  if (subject.measured.duplicateOf) warning('duplicate', 'You already uploaded this image.');
  return issues;
}

export const passed = (issues: readonly ImageIssue[]) => !issues.some((i) => i.severity === 'blocking');
