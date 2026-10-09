import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/media.js';
import type { MediaService } from '../service.js';
import { sellerCaller, uploadTarget } from './callers.js';

/**
 * Seller API: /api/seller/media/…  (docs/api/modules/media.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Sellers reach only their seller's files; another seller's file is 404.
 */
export const sellerRoutes = (service: MediaService) =>
  routes(endpoints, 'seller', {
    /** POST /uploads: Start an upload (product images and video, store logo and banner, ad creatives, documents, inspection photos, case evidence, bulk files) */
    createSellerUpload: async ({ body, sellerId, principal, actor, requestId, request }) => {
      const c = sellerCaller(sellerId, principal);
      return service.createUpload({ uploader: c.uploader, owner: c.owner, request: body, createdBy: c.createdBy, clientIp: request.ip, target: uploadTarget('seller', request), by: { actor, requestId } });
    },
    /** PUT /uploads/{id}/content: Development storage only: the file bytes for an upload ticket */
    uploadSellerContent: async ({ params, body, sellerId, principal }) =>
      service.receiveUploadContent(params.id, body, { area: 'seller', owner: sellerCaller(sellerId, principal).filter }),
    /** POST /uploads/{id}/complete: Confirm the upload; processing starts */
    completeSellerUpload: async ({ params, sellerId, principal, actor, requestId }) =>
      service.completeUpload(params.id, { owner: sellerCaller(sellerId, principal).filter, by: { actor, requestId } }),
    /** GET /assets: Seller media library */
    listSellerAssets: async ({ query, page, sellerId, principal }) =>
      service.listAssets(
        {
          owner: sellerCaller(sellerId, principal).filter,
          purpose: query.purpose,
          kind: query.kind,
          statuses: query.status ? [query.status] : ['processing', 'ready', 'rejected', 'removed'],
          inUse: query.inUse,
          q: query.q,
        },
        page,
        { signPrivate: true },
      ),
    /** GET /assets/{id}: One file with where it is used and whether it can be deleted */
    getSellerAsset: async ({ params, sellerId, principal }) => service.assetDetail(params.id, { owner: sellerCaller(sellerId, principal).filter, signPrivate: true, area: 'seller' }),
    /** PATCH /assets/{id}: Edit alt text or title */
    updateSellerAsset: async ({ params, body, sellerId, principal, actor, requestId }) =>
      service.updateAsset(params.id, body, { owner: sellerCaller(sellerId, principal).filter, by: { actor, requestId } }),
    /** DELETE /assets/{id}: Delete an unused file */
    deleteSellerAsset: async ({ params, sellerId, principal, actor, requestId }) => {
      await service.deleteAsset(params.id, { owner: sellerCaller(sellerId, principal).filter, by: { actor, requestId } });
    },
    /** POST /assets/{id}/checks: Check an image against category or placement rules before submitting */
    checkSellerImage: async ({ params, body, sellerId, principal }) =>
      service.runImageCheck(params.id, body.rules, { owner: sellerCaller(sellerId, principal).filter, rulesSource: body.rulesSource }),
    /** GET /assets/{id}/download: Signed link to one of the seller's private files */
    getSellerDownload: async ({ params, sellerId, principal }) => service.ownDownload(params.id, sellerCaller(sellerId, principal).filter),
  });
