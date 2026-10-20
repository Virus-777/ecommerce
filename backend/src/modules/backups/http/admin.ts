import type { FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/backups.js';
import type { BackupsService } from '../service.js';

/** The Content-Length the client declared, if any (an upload above the limit is refused before reading) */
const declared = (request: FastifyRequest) => {
  const h = request.headers['content-length'];
  return h !== undefined && /^\d+$/.test(h) ? Number(h) : undefined;
};

/**
 * Admin API: /api/admin/backups/…  (docs/api/modules/backups.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: BackupsService) =>
  routes(endpoints, 'admin', {
    getBackups: () => service.overview(),
    startBackup: ({ body, actor, requestId }) => service.startBackup(body, { actor, requestId }),
    createBackupDownloadLinks: ({ params, actor, requestId }) => service.downloadLinks(params.id, { actor, requestId }),
    createBackupUpload: ({ body, actor, requestId }) => service.createUpload(body, { actor, requestId }),
    uploadBackupDatabase: async ({ params, body, request, reply }) => {
      try {
        return await service.receiveUpload(params.id, 'database', body as Readable | undefined, declared(request));
      } catch (err) {
        reply.header('connection', 'close'); // the rest of a refused body isn't worth receiving
        throw err;
      }
    },
    uploadBackupFiles: async ({ params, body, request, reply }) => {
      try {
        return await service.receiveUpload(params.id, 'files', body as Readable | undefined, declared(request));
      } catch (err) {
        reply.header('connection', 'close');
        throw err;
      }
    },
    deleteBackupUpload: ({ params, actor, requestId }) => service.deleteUpload(params.id, { actor, requestId }),
    requestRestore: ({ body, actor, requestId, principal }) => service.requestRestore(body, { actor, requestId, principal }),
    cancelRestore: ({ params, actor, requestId }) => service.cancelRestore(params.id, { actor, requestId }),
    getBackupOperation: ({ params }) => service.operation(params.id),
  });
