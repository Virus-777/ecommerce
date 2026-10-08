import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/media.js';
import type { MediaService } from '../service.js';

/**
 * Seller API: /api/seller/media/…  (docs/api/modules/media.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: MediaService) => {
  void service;
  return routes(endpoints, 'seller', {
    /** POST /uploads: Start an upload (product images and video, store logo and banner, ad creatives, documents, inspection photos, case evidence, bulk files) */
    createSellerUpload: notImplemented,
    /** POST /uploads/{id}/complete: Confirm the upload; processing starts */
    completeSellerUpload: notImplemented,
    /** GET /assets: Seller media library */
    listSellerAssets: notImplemented,
    /** GET /assets/{id}: One file with where it is used and whether it can be deleted */
    getSellerAsset: notImplemented,
    /** PATCH /assets/{id}: Edit alt text or title */
    updateSellerAsset: notImplemented,
    /** DELETE /assets/{id}: Delete an unused file */
    deleteSellerAsset: notImplemented,
    /** POST /assets/{id}/checks: Check an image against category or placement rules before submitting */
    checkSellerImage: notImplemented,
    /** GET /assets/{id}/download: Signed link to one of the seller's private files */
    getSellerDownload: notImplemented,
  });
};
