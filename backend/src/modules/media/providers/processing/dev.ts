/**
 * Development image and video processing: deterministic, no network, no native libraries.
 *   - probe: real type sniffing and dimensions from file headers (probe.ts)
 *   - strip: removes EXIF/GPS/text metadata from JPEG and PNG
 *   - renditions: recorded at the sizes a real resize gives (fitSize), but the bytes are the stripped original
 *   - measure: estimates from the file name, so tests can ask for a case: "lifestyle" or "nonwhite"
 *     → coloured background, "blurry" → low sharpness, "watermark" → watermark, "text" → text overlay;
 *     the perceptual hash is derived from the bytes (identical images share it)
 *   - startTranscode: returns a job id; the result is delivered to POST /webhooks/media/processing-results
 * sharp.ts replaces it for images (MEDIA_IMAGE_PROCESSOR=sharp, the default outside tests).
 */
import { createHash } from 'node:crypto';
import { fitSize } from '../../domain/image-spec.js';
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

    async renditions(body, probe, targets) {
      const W = probe.width ?? 0;
      const H = probe.height ?? 0;
      if (!W || !H) return [];
      const out: RenditionOutput[] = [];
      for (const t of targets) {
        // the bytes stay the original's; the recorded size is the one a real resize would produce
        const { width, height } = fitSize(W, H, t);
        for (const format of ['webp', 'jpeg'] as const) out.push({ size: t.size, width, height, format, body });
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
