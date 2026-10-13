/**
 * Development image and video processing: deterministic, no network, no native libraries.
 *   - probe: real type sniffing and dimensions from file headers (probe.ts)
 *   - strip: removes EXIF/GPS/text metadata from JPEG and PNG
 *   - renditions: recorded at the right sizes, but the bytes are the stripped original (no resizing)
 *   - measure: estimates from the file name, so tests can ask for a case: "lifestyle" or "nonwhite"
 *     → coloured background, "blurry" → low sharpness, "watermark" → watermark, "text" → text overlay;
 *     the perceptual hash is derived from the bytes (identical images share it)
 *   - startTranscode: returns a job id; the result is delivered to POST /webhooks/media/processing-results
 * libvips/sharp and a transcoding service replace it behind MediaProcessor.
 */
import { createHash } from 'node:crypto';
import type { MediaProcessor, RenditionOutput } from '../../ports.js';
import { probeBytes, stripJpeg, stripPng } from './probe.js';

export interface DevProcessor extends MediaProcessor {
  /** Transcodes started (tests deliver their results through the webhook) */
  readonly transcodes: { providerJobId: string; assetId: string }[];
}

export function createDevProcessor(): DevProcessor {
  const transcodes: { providerJobId: string; assetId: string }[] = [];
  return {
    transcodes,

    async probe(body, hint) {
      return probeBytes(body, hint);
    },

    async strip(body, format) {
      if (format === 'jpeg') return stripJpeg(body);
      if (format === 'png') return stripPng(body);
      return body;
    },

    async renditions(body, probe, widths) {
      const W = probe.width ?? 0;
      const H = probe.height ?? 0;
      if (!W || !H) return [];
      const sizes = Object.entries(widths).sort((a, b) => a[1] - b[1]);
      const out: RenditionOutput[] = [];
      let capped = false;
      for (const [size, w] of sizes) {
        // never upscale: sizes wider than the original are made once, at the original width
        if (w > W) {
          if (capped || sizes.some(([, x]) => x === W)) break;
          capped = true;
        }
        const width = Math.min(w, W);
        const height = Math.max(1, Math.round((H * width) / W));
        for (const format of ['webp', 'jpeg'] as const) out.push({ size: size as RenditionOutput['size'], width, height, format, body });
      }
      return out;
    },

    async measure(body, probe, { fileName }) {
      const name = fileName.toLowerCase();
      const width = probe.width ?? 0;
      const height = probe.height ?? 0;
      return {
        width,
        height,
        aspect: height ? Math.round((width / height) * 10_000) / 10_000 : 0,
        hasAlpha: Boolean(probe.hasAlpha),
        backgroundWhiteness: /lifestyle|nonwhite|background/.test(name) ? 0.35 : 0.96,
        sharpness: /blurry/.test(name) ? 25 : 180,
        watermarkLikely: /watermark/.test(name),
        textCoverage: /text/.test(name) ? 0.25 : 0.02,
        phash: createHash('sha256').update(body).digest().readUIntBE(0, 6),
      };
    },

    async startTranscode({ assetId }) {
      const providerJobId = `devtx_${assetId}`;
      transcodes.push({ providerJobId, assetId });
      return { providerJobId };
    },
  };
}
