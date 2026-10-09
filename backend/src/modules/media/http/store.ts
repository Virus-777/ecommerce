import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/media.js';
import type { MediaService } from '../service.js';
import { storeCaller, uploadTarget } from './callers.js';

/**
 * Store API: /api/store/media/…  (docs/api/modules/media.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Customers reach their own uploads, guests the uploads of their guest session.
 */
export const storeRoutes = (service: MediaService) =>
  routes(endpoints, 'store', {
    /** POST /uploads: Start an upload (return photos, case evidence, review photos, message attachments, seller application documents) */
    createStoreUpload: async ({ body, scope, principal, actor, requestId, request }) => {
      const c = storeCaller(scope, principal);
      return service.createUpload({ uploader: c.uploader, owner: c.owner, request: body, createdBy: c.createdBy, clientIp: request.ip, target: uploadTarget('store', request), by: { actor, requestId } });
    },
    /** PUT /uploads/{id}/content: Development storage only: the file bytes for an upload ticket */
    uploadStoreContent: async ({ params, body, scope, principal }) =>
      service.receiveUploadContent(params.id, body, { area: 'store', owner: storeCaller(scope, principal).filter }),
    /** POST /uploads/{id}/complete: Confirm the bytes are uploaded; processing starts */
    completeStoreUpload: async ({ params, scope, principal, actor, requestId }) =>
      service.completeUpload(params.id, { owner: storeCaller(scope, principal).filter, by: { actor, requestId } }),
    /** GET /assets/{id}: My upload (poll until ready) */
    getStoreAsset: async ({ params, scope, principal }) => service.assetFor(params.id, { owner: storeCaller(scope, principal).filter, signPrivate: true }),
    /** PATCH /assets/{id}: Describe my photo (alt text) */
    updateStoreAsset: async ({ params, body, scope, principal, actor, requestId }) =>
      service.updateAsset(params.id, body, { owner: storeCaller(scope, principal).filter, by: { actor, requestId } }),
    /** DELETE /assets/{id}: Remove my upload before submitting */
    deleteStoreAsset: async ({ params, scope, principal, actor, requestId }) => {
      await service.deleteAsset(params.id, { owner: storeCaller(scope, principal).filter, by: { actor, requestId } });
    },
    /** GET /assets/{id}/download: Signed link to one of my private files */
    getStoreDownload: async ({ params, scope, principal }) => service.ownDownload(params.id, storeCaller(scope, principal).filter),
  });
