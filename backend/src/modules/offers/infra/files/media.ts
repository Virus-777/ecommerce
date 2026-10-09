import type { ModuleContext } from '../../../../kernel/module-system/index.js';
import type { BulkFileReader } from '../../ports.js';

/**
 * Reads an uploaded bulk CSV through media: the asset's owner and name from getAsset, the bytes from a
 * signed download link (media's public API has no byte reader). Without media nothing can be read.
 */
export function mediaBulkFileReader(ctx: ModuleContext<'offers'>): BulkFileReader {
  return {
    async read(fileId, principal) {
      const media = ctx.tryUse('media');
      if (!media) return null;
      const asset = await media.getAsset(fileId);
      if (!asset) return null;
      const link = await media.signedDownload(fileId, principal);
      const res = await fetch(link.url);
      if (!res.ok) throw new Error(`download failed with ${res.status}`);
      return { fileName: asset.fileName, text: await res.text(), owner: { kind: asset.owner.kind, id: asset.owner.id ?? null } };
    },
  };
}
