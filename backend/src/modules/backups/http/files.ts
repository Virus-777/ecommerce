/**
 * GET and HEAD /files/backups/<name>: a backup download. The auth middleware has verified the signed link (made by
 * createBackupDownloadLinks: 15 minutes, attachment) before this runs; only the database and uploaded-files files
 * of a backup can be named (the settings and keys file never). Single byte ranges let a large download resume.
 */
import type { FileRoute } from '../../../kernel/http/files.js';
import { parseRange } from '../../../kernel/http/files.js';
import { AppError } from '../../../kernel/errors/index.js';
import { BACKUPS_BUCKET, type BackupsService } from '../service.js';

export function backupFiles(service: BackupsService): FileRoute {
  return {
    buckets: [BACKUPS_BUCKET],
    permanentBuckets: [],
    async serve(file, request, reply) {
      const whole = await service.openDownload(file.key);
      if (!whole) throw new AppError('NOT_FOUND', 'This backup is no longer on the server');
      const size = whole.sizeBytes;
      const header = request.headers.range;
      const range = parseRange(typeof header === 'string' ? header : undefined, size);
      reply.header('content-type', file.contentType ?? 'application/gzip');
      if (file.disposition) reply.header('content-disposition', file.disposition);
      reply.header('accept-ranges', 'bytes');
      reply.header('cache-control', 'private, no-store');
      reply.header('last-modified', whole.modifiedAt.toUTCString());
      if (range === 'unsatisfiable') {
        whole.stream.destroy();
        return reply.code(416).header('content-range', `bytes */${size}`).send();
      }
      if (request.method === 'HEAD') {
        whole.stream.destroy();
        return reply.header('content-length', String(size)).send();
      }
      if (!range) return reply.header('content-length', String(size)).send(whole.stream);
      whole.stream.destroy();
      const part = await service.openDownload(file.key, range);
      if (!part) throw new AppError('NOT_FOUND', 'This backup is no longer on the server');
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
        .header('content-length', String(range.end - range.start + 1))
        .send(part.stream);
    },
  };
}
