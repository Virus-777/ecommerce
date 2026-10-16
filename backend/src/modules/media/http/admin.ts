import { routes } from '../../../kernel/http/index.js';
import { endpoints, type MediaOwner } from '../../../spec/media.js';
import { defaultStaffOwnerKind } from '../domain/rules.js';
import type { MediaService } from '../service.js';
import { uploadTarget } from './callers.js';
import { receiveContent } from './files.js';

/**
 * Admin API: /api/admin/media/…  (docs/api/modules/media.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: MediaService) =>
  routes(endpoints, 'admin', {
    /** POST /uploads: Start a staff upload (Official Store products, content, ad creatives, inspection photos, evidence) */
    createAdminUpload: async ({ body, principal, actor, requestId, request }) => {
      // content, ads and Official Store files belong to the platform; evidence to the staff member
      const kind = body.ownerKind ?? defaultStaffOwnerKind(body.upload.purpose);
      const owner: MediaOwner = kind === 'platform' ? { kind: 'platform', id: null } : { kind: 'staff', id: principal.accountId ?? null, label: principal.name ?? null };
      return service.createUpload({
        uploader: 'staff',
        owner,
        request: body.upload,
        createdBy: { kind: 'staff', id: principal.accountId ?? null },
        clientIp: request.ip,
        target: uploadTarget('admin', request),
        by: { actor, requestId },
      });
    },
    /** PUT /uploads/{id}/content: the file bytes for an upload ticket, streamed into storage (only the staff member who started it) */
    uploadAdminContent: async ({ params, body, principal, request, reply }) =>
      receiveContent(service, { id: params.id, body, request, reply }, { area: 'admin', startedBy: { kind: 'staff', id: principal.accountId ?? null } }),
    /** POST /uploads/{id}/complete: Confirm a staff upload (only the staff member who started it: the response carries the asset) */
    completeAdminUpload: async ({ params, principal, actor, requestId }) =>
      service.completeUpload(params.id, { startedBy: { kind: 'staff', id: principal.accountId ?? null }, by: { actor, requestId } }),
    /** GET /assets: All files with filters */
    listAssetsAdmin: async ({ query, page, can }) =>
      service.listAssets(
        {
          ownerKind: query.ownerKind,
          ownerId: query.ownerId,
          purpose: query.purpose,
          kind: query.kind,
          statuses: query.status ? [query.status] : undefined,
          inUse: query.inUse,
          failedChecks: query.failedChecks,
          q: query.q,
        },
        page,
        { signPrivate: await can('media.assets.view-private') },
      ),
    /** GET /assets/{id}: File detail with usages, checks and history */
    getAssetAdmin: async ({ params, can }) => service.assetDetail(params.id, { signPrivate: await can('media.assets.view-private'), area: 'admin' }),
    /** PATCH /assets/{id}: Edit alt text or title of a platform file */
    updateAssetAdmin: async ({ params, body, actor, requestId }) => service.updateAsset(params.id, body, { platformOnly: true, by: { actor, requestId } }),
    /** POST /assets/{id}/checks: Check an image against rules */
    checkImageAdmin: async ({ params, body }) => service.runImageCheck(params.id, body.rules, { rulesSource: body.rulesSource }),
    /** POST /assets/{id}/remove: Take a file down (policy, rights, privacy) with a reason */
    removeAsset: async ({ params, body, actor, requestId }) => service.removeAsset(params.id, body, { actor, requestId }),
    /** POST /assets/{id}/restore: Restore a removed file */
    restoreAsset: async ({ params, body, actor, requestId }) => service.restoreAsset(params.id, body.reason, { actor, requestId }),
    /** DELETE /assets/{id}: Delete an unused platform file */
    deleteAssetAdmin: async ({ params, actor, requestId }) => {
      await service.deleteAsset(params.id, { platformOnly: true, audited: true, by: { actor, requestId } });
    },
    /** GET /assets/{id}/download: Signed link to a private file (verification documents, evidence) */
    getAdminDownload: async ({ params, query, actor, requestId }) => service.staffDownload(params.id, query.reason, { actor, requestId }),
    /** GET /image-specs: The product image spec in force */
    getAdminImageSpecs: async () => service.imageSpecs(),
  });
