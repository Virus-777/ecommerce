/**
 * GET and HEAD /files/{bucket}/{key}: files modules keep on the server (media's local-disk and memory storage,
 * backups' backup files), opened by signed links. Each module serves its own buckets. The auth middleware verifies the link before any module code runs
 * (auth kind `file-link`, kernel/auth/file-links.ts; docs/03-auth-middleware.md §0), so this route is
 * never anonymous; the module's serve() streams the file the verified link names.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FileLink } from '../auth/file-links.js';
import { AppError } from '../errors/index.js';

export interface FileRoute {
  /** The buckets this route serves (each bucket belongs to one module); none: every bucket (a single file route) */
  buckets?: readonly string[];
  /** Buckets whose links may be permanent (public renditions embedded in pages); other links must expire */
  permanentBuckets: readonly string[];
  /** Streams the file: status, headers (type, length, ranges, caching) and body */
  serve(file: FileLink, request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

/** A module's file route; links are signed with secretFor(config, '<module>.files') */
export interface ModuleFileRoute extends FileRoute {
  module: string;
}

export function registerFileRoute(app: FastifyInstance, route: ModuleFileRoute) {
  registerFileRoutes(app, [route]);
}

/** One /files/* route for every module that serves files: the verified link's bucket picks the module */
export function registerFileRoutes(app: FastifyInstance, routes: readonly ModuleFileRoute[]) {
  if (!routes.length) return;
  const routeOf = (bucket: string) => routes.find((r) => r.buckets?.includes(bucket)) ?? routes.find((r) => !r.buckets);
  app.route({
    method: ['GET', 'HEAD'],
    url: '/files/*',
    exposeHeadRoute: false,
    config: { auth: 'file-link' },
    schema: { hide: true },
    async handler(request, reply) {
      const file = request.auth?.via === 'file-link' ? request.auth.file : undefined;
      if (!file) throw new AppError('UNAUTHORIZED', 'This file needs a signed link', { reason: 'link_missing' }); // the middleware already refused it
      const route = routeOf(file.bucket);
      if (!route) throw new AppError('NOT_FOUND', 'File not found');
      return route.serve(file, request, reply);
    },
  });
}

export type ByteRange = { start: number; end: number };

/** One byte range of a file of `size` bytes; null = serve it whole (no header, malformed, several ranges) */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    if (start >= size) return 'unsatisfiable';
    end = m[2] === '' ? size - 1 : Number(m[2]);
    if (end < start) return null; // invalid: ignored
    end = Math.min(end, size - 1);
  }
  if (start >= size || size === 0) return 'unsatisfiable';
  return { start, end };
}
