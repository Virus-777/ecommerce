/**
 * Image processing with sharp (libvips), MEDIA_IMAGE_PROCESSOR=sharp (the default outside tests):
 *   - probe: the type from the file header (probe.ts), then a full decode: a file that doesn't decode (corrupt,
 *     truncated, a header-only test file) is unreadable (null) and processing rejects it. Sizes are auto-oriented.
 *   - strip: auto-orients and re-encodes in the same format, which drops EXIF, GPS, XMP and ICC metadata
 *   - renditions: resized (cover fit, centred, never enlarged) and encoded as WebP and JPEG at the quality given
 *   - measure: border whiteness and sharpness from small greyscale copies, and a 48-bit difference hash
 * HEIC: the prebuilt libvips has no HEVC decoder. HEIC files (allowed for evidence, never for product images) are
 * kept as uploaded, sized from the header, with no renditions. Videos and documents: as the development processor.
 */
import sharp from 'sharp';
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from '../../domain/rules.js';
import { fitSize } from '../../domain/image-spec.js';
import type { MediaProcessor, ProbeResult, RenditionOutput } from '../../ports.js';
import { createDevProcessor } from './dev.js';
import { probeBytes } from './probe.js';

/** Formats sharp decodes and writes back in the same format */
const DECODED = ['jpeg', 'png', 'webp'];
/** Quality of the stripped original (the source of every rendition) */
const ORIGINAL_QUALITY = 95;
const DEFAULT_QUALITY = 80;

const open = (body: Uint8Array) => sharp(body, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).rotate();

export function createSharpProcessor(): MediaProcessor {
  const dev = createDevProcessor();
  return {
    async probe(body, hint) {
      const sniffed = probeBytes(body, hint);
      if (!sniffed || sniffed.kind !== 'image' || !DECODED.includes(sniffed.format)) return sniffed;
      const { width, height } = sniffed;
      // outside the hard limits: the pipeline rejects it without decoding (decompression bombs)
      if (!width || !height || Math.max(width, height) > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) return sniffed;
      try {
        const meta = await sharp(body, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
        // decode every pixel: a broken or truncated file fails here, not later in a rendition
        await sharp(body, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).stats();
        const turned = (meta.orientation ?? 1) >= 5;
        const w = meta.width ?? width;
        const h = meta.height ?? height;
        return { ...sniffed, width: turned ? h : w, height: turned ? w : h, hasAlpha: Boolean(meta.hasAlpha) } satisfies ProbeResult;
      } catch {
        return null;
      }
    },

    async strip(body, format) {
      if (!DECODED.includes(format)) return dev.strip(body, format);
      const img = open(body);
      const out = format === 'png' ? img.png() : format === 'webp' ? img.webp({ quality: ORIGINAL_QUALITY }) : img.jpeg({ quality: ORIGINAL_QUALITY });
      return new Uint8Array(await out.toBuffer());
    },

    async renditions(body, probe, targets, opts) {
      const W = probe.width ?? 0;
      const H = probe.height ?? 0;
      if (!W || !H || !DECODED.includes(probe.format)) return [];
      const quality = opts?.quality ?? DEFAULT_QUALITY;
      const out: RenditionOutput[] = [];
      for (const t of targets) {
        const { width, height } = fitSize(W, H, t);
        const resized = open(body).resize({ width, height, fit: 'cover', position: 'centre', withoutEnlargement: true });
        // both encodings at once (libvips runs them on its own threads)
        const [webp, jpeg] = await Promise.all([
          resized.clone().webp({ quality }).toBuffer({ resolveWithObject: true }),
          // JPEG has no transparency: transparent areas become white
          resized.clone().flatten({ background: '#ffffff' }).jpeg({ quality, progressive: true }).toBuffer({ resolveWithObject: true }),
        ]);
        out.push({ size: t.size, width: webp.info.width, height: webp.info.height, format: 'webp', body: new Uint8Array(webp.data) });
        out.push({ size: t.size, width: jpeg.info.width, height: jpeg.info.height, format: 'jpeg', body: new Uint8Array(jpeg.data) });
      }
      return out;
    },

    async measure(body, probe, hint) {
      if (!DECODED.includes(probe.format)) return dev.measure(body, probe, hint);
      const width = probe.width ?? 0;
      const height = probe.height ?? 0;
      // three independent small copies of the image, made at once
      const [backgroundWhiteness, sharpnessScore, phash] = await Promise.all([borderWhiteness(body), sharpness(body), differenceHash(body)]);
      return {
        width,
        height,
        aspect: height ? Math.round((width / height) * 10_000) / 10_000 : 0,
        hasAlpha: Boolean(probe.hasAlpha),
        backgroundWhiteness,
        sharpness: sharpnessScore,
        watermarkLikely: null,
        textCoverage: null,
        phash,
      };
    },

    startTranscode: (input) => dev.startTranscode(input),
  };
}

/** Greyscale pixels of the image scaled to w × h (one byte each) */
async function grey(body: Uint8Array, w: number, h: number): Promise<Buffer> {
  return open(body).flatten({ background: '#ffffff' }).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer();
}

/** Share of near-white pixels (≥ 240) on the outer two-pixel border of a 64 × 64 copy */
async function borderWhiteness(body: Uint8Array): Promise<number> {
  const n = 64;
  const px = await grey(body, n, n);
  let white = 0;
  let total = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (x > 1 && x < n - 2 && y > 1 && y < n - 2) continue;
      total++;
      if (px[y * n + x]! >= 240) white++;
    }
  }
  return Math.round((white / total) * 1000) / 1000;
}

/** Variance of the Laplacian of a 256 px wide greyscale copy (low: blurry) */
async function sharpness(body: Uint8Array): Promise<number> {
  const meta = await open(body).metadata();
  const turned = (meta.orientation ?? 1) >= 5;
  const W = (turned ? meta.height : meta.width) ?? 1;
  const H = (turned ? meta.width : meta.height) ?? 1;
  const w = Math.min(256, W);
  const h = Math.max(3, Math.round((H * w) / W));
  const px = await grey(body, Math.max(3, w), h);
  const cols = Math.max(3, w);
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const i = y * cols + x;
      const lap = px[i - cols]! + px[i + cols]! + px[i - 1]! + px[i + 1]! - 4 * px[i]!;
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return Math.round((sumSq / count - mean * mean) * 10) / 10;
}

/** 48-bit difference hash: a 9 × 6 copy, each pixel compared with its right neighbour */
async function differenceHash(body: Uint8Array): Promise<number> {
  const px = await grey(body, 9, 6);
  let hash = 0;
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 8; x++) hash = hash * 2 + (px[y * 9 + x]! > px[y * 9 + x + 1]! ? 1 : 0);
  }
  return hash;
}
