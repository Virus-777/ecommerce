import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type { BulkFileReader } from '../ports.js';

/** Bulk price files are small CSVs; anything bigger is refused by media */
const MAX_BULK_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Reads an uploaded bulk CSV through media: the asset's owner from getAsset, the bytes from media.readFile
 * (in-process, no signed URL). Without media nothing can be read.
 */
export function mediaBulkFileReader(ctx: ModuleContext<'offers'>): BulkFileReader {
  return {
    async read(fileId) {
      const media = ctx.tryUse('media');
      if (!media) return null;
      const asset = await media.getAsset(fileId);
      if (!asset) return null;
      const file = await media.readFile(fileId, undefined, { maxBytes: MAX_BULK_FILE_BYTES });
      return { fileName: file.fileName || asset.fileName, text: new TextDecoder('utf-8').decode(file.body), owner: { kind: asset.owner.kind, id: asset.owner.id ?? null } };
    },
  };
}
