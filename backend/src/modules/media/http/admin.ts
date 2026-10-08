import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/media.js';
import type { MediaService } from '../service.js';

/**
 * Admin API: /api/admin/media/…  (docs/api/modules/media.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: MediaService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** POST /uploads: Start a staff upload (Official Store products, content, ad creatives, inspection photos, evidence) */
    createAdminUpload: notImplemented,
    /** POST /uploads/{id}/complete: Confirm a staff upload */
    completeAdminUpload: notImplemented,
    /** GET /assets: All files with filters */
    listAssetsAdmin: notImplemented,
    /** GET /assets/{id}: File detail with usages, checks and history */
    getAssetAdmin: notImplemented,
    /** PATCH /assets/{id}: Edit alt text or title of a platform file */
    updateAssetAdmin: notImplemented,
    /** POST /assets/{id}/checks: Check an image against rules */
    checkImageAdmin: notImplemented,
    /** POST /assets/{id}/remove: Take a file down (policy, rights, privacy) with a reason */
    removeAsset: notImplemented,
    /** POST /assets/{id}/restore: Restore a removed file */
    restoreAsset: notImplemented,
    /** DELETE /assets/{id}: Delete an unused platform file */
    deleteAssetAdmin: notImplemented,
    /** GET /assets/{id}/download: Signed link to a private file (verification documents, evidence) */
    getAdminDownload: notImplemented,
  });
};
