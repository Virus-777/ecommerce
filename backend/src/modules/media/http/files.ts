/**
 * Bytes over HTTP when storage is served by the API (local disk, memory):
 *   - PUT /api/{area}/media/uploads/{id}/content streams an upload into storage (receiveContent);
 *   - GET and HEAD /files/{bucket}/{key} stream a file out (fileServer). The auth middleware has already
 *     verified the signed link (kernel/auth/file-links.ts) and hands over the file it names; this serves
 *     it with its content type, ETag and Last-Modified, single byte ranges (Range, If-Range), conditional
 *     requests (If-None-Match, If-Modified-Since) and cache headers that follow the link.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { FileLink } from '../../../kernel/auth/file-links.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { parseRange, type FileRoute } from '../../../kernel/http/files.js';
import type { Clock } from '../../../kernel/lib/clock.js';
import { InvalidObjectKeyError, type OpenedObject, type OwnerFilter, type StorageProvider } from '../ports.js';
import type { MediaService, UploadArea } from '../service.js';

/** Browsers and proxies keep public files (renditions) this long; a takedown reaches cached copies within it */
export const PUBLIC_MAX_AGE_SECONDS = 3600;
/** Private inline files (images shown in a page) may be cached until their link expires, at most this long */
const PRIVATE_MAX_AGE_SECONDS = 3600;

/** PUT /uploads/{id}/content: the request body is a stream; a declared Content-Length above the ticket is refused before reading */
export async function receiveContent(
  service: MediaService,
  input: { id: string; body: Readable | undefined; request: FastifyRequest; reply: FastifyReply },
  opts: { area: UploadArea; owner?: OwnerFilter; startedBy?: { kind: string; id: string | null } },
): Promise<void> {
  const header = input.request.headers['content-length'];
  const declaredBytes = header !== undefined && /^\d+$/.test(header) ? Number(header) : undefined;
  try {
    await service.receiveUploadContent(input.id, input.body, { ...opts, declaredBytes });
  } catch (err) {
    // the rest of a refused body isn't worth receiving: close the connection after the answer
    if (isAppError(err) && err.code === 'FILE_TOO_LARGE') input.reply.header('connection', 'close');
    throw err;
  }
}

/** GET /files/{bucket}/{key} for media's storage (registered with ctx.http.files when storage is served by the API) */
export function fileServer(service: MediaService, clock: Clock): FileRoute {
  return {
    buckets: [service.providers.storage.buckets.public, service.providers.storage.buckets.private],
    permanentBuckets: [service.providers.storage.buckets.public],
    serve: (file, request, reply) => serveFile(service.providers.storage, file, request, reply, clock.now()),
  };
}

const matchesEtag = (header: string, etag: string) => header.split(',').some((t) => ['*', etag, `W/${etag}`].includes(t.trim()));

function cacheControl(file: FileLink, now: Date) {
  if (!file.expiresAt) return `public, max-age=${PUBLIC_MAX_AGE_SECONDS}`;
  if (file.disposition?.startsWith('attachment')) return 'private, no-store';
  const left = Math.floor((file.expiresAt.getTime() - now.getTime()) / 1000);
  return `private, max-age=${Math.max(0, Math.min(left, PRIVATE_MAX_AGE_SECONDS))}`;
}

export async function serveFile(storage: StorageProvider, file: FileLink, request: FastifyRequest, reply: FastifyReply, now: Date) {
  let object: OpenedObject | null = null;
  try {
    object = await storage.open(file.bucket, file.key);
  } catch (err) {
    if (!(err instanceof InvalidObjectKeyError)) throw err; // a key storage would never write: nothing to serve
  }
  if (!object) throw new AppError('NOT_FOUND', 'File not found');
  const o = object;
  const etag = `"${o.etag}"`;
  const lastModified = new Date(Math.floor(o.lastModified.getTime() / 1000) * 1000);
  const h = request.headers;
  // conditions first (a cached copy is still good), then the range
  const notModified = typeof h['if-none-match'] === 'string' ? matchesEtag(h['if-none-match'], etag) : typeof h['if-modified-since'] === 'string' && Date.parse(h['if-modified-since']) >= lastModified.getTime();
  // If-Range: the range only applies to the version the client already has part of
  const ifRange = h['if-range'];
  const rangeApplies = typeof ifRange !== 'string' || ifRange.trim() === etag || Date.parse(ifRange) >= lastModified.getTime();
  const range = notModified || !rangeApplies ? null : parseRange(typeof h.range === 'string' ? h.range : undefined, o.sizeBytes);
  if (range === 'unsatisfiable') {
    await o.close();
    reply.header('content-range', `bytes */${o.sizeBytes}`);
    throw new AppError('RANGE_NOT_SATISFIABLE', 'The requested range is outside the file', { sizeBytes: o.sizeBytes }, 416);
  }

  reply
    .header('etag', etag)
    .header('last-modified', lastModified.toUTCString())
    .header('cache-control', cacheControl(file, now))
    .header('accept-ranges', 'bytes')
    // a stored file never runs as a page of ours, whatever its type
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    .header('cross-origin-resource-policy', 'cross-origin')
    .header('access-control-expose-headers', 'content-length, content-range, accept-ranges, etag, content-disposition');
  if (notModified) {
    await o.close();
    return reply.code(304).send();
  }
  reply.header('content-type', file.contentType ?? o.contentType ?? 'application/octet-stream');
  if (file.disposition) reply.header('content-disposition', file.disposition);
  const length = range ? range.end - range.start + 1 : o.sizeBytes;
  reply.code(range ? 206 : 200).header('content-length', String(length));
  if (range) reply.header('content-range', `bytes ${range.start}-${range.end}/${o.sizeBytes}`);
  if (request.method === 'HEAD' || length === 0) {
    await o.close();
    return reply.send();
  }
  return reply.send(o.stream(range ?? undefined));
}
