import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/media.js';
import type { MediaService } from '../service.js';

/**
 * Store API: /api/store/media/…  (docs/api/modules/media.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: MediaService) => {
  void service;
  return routes(endpoints, 'store', {
    /** POST /uploads: Start an upload (return photos, case evidence, review photos, message attachments, seller application documents) */
    createStoreUpload: notImplemented,
    /** POST /uploads/{id}/complete: Confirm the bytes are uploaded; processing starts */
    completeStoreUpload: notImplemented,
    /** GET /assets/{id}: My upload (poll until ready) */
    getStoreAsset: notImplemented,
    /** PATCH /assets/{id}: Describe my photo (alt text) */
    updateStoreAsset: notImplemented,
    /** DELETE /assets/{id}: Remove my upload before submitting */
    deleteStoreAsset: notImplemented,
    /** GET /assets/{id}/download: Signed link to one of my private files */
    getStoreDownload: notImplemented,
  });
};
