/**
 * Download links for storage the API serves itself (memory and local disk): GET /files/{bucket}/{key}
 * on the API's public address, signed with media's file-link key (kernel/auth/file-links.ts). The auth
 * middleware verifies the signature before http/files.ts streams the bytes.
 *   - private files: short-lived links bound to the file, expiry, content type and disposition;
 *   - public files (renditions in the public bucket): permanent links, so stored URLs and <img src> keep working.
 */
import { signFileLink } from '../../../../kernel/auth/file-links.js';
import type { StorageProvider } from '../../ports.js';

export const DEFAULT_BUCKETS = { public: 'marketly-public', private: 'marketly-private' } as const;

export interface FileLinkOptions {
  /** secretFor(config, 'media.files') */
  secret: string;
  /** The API's public address, e.g. https://api.marketly.com (no trailing slash) */
  baseUrl: string;
  buckets: { public: string; private: string };
}

/** Content-Disposition for a download: inline or attachment, with a safe quoted file name */
export const dispositionOf = (fileName: string, inline?: boolean) => `${inline ? 'inline' : 'attachment'}; filename="${fileName.replace(/["\\\r\n]/g, '_')}"`;

export function fileLinks(o: FileLinkOptions): Pick<StorageProvider, 'presignDownload' | 'publicUrl' | 'objectUrl'> {
  const base = o.baseUrl.replace(/\/$/, '');
  return {
    async presignDownload({ bucket, key, expiresAt, fileName, contentType, inline }) {
      return base + signFileLink(o.secret, { bucket, key, expiresAt, contentType, disposition: dispositionOf(fileName, inline) });
    },
    publicUrl: (key) => base + signFileLink(o.secret, { bucket: o.buckets.public, key, expiresAt: null }),
    // unsigned: the middleware refuses it; views sign private files when they show them
    objectUrl: (bucket, key) => `${base}/files/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`,
  };
}
