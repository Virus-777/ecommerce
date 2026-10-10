/**
 * GET and HEAD /files/{bucket}/{key}: files a module keeps on the server (media's local-disk and memory
 * storage), opened by signed links. The auth middleware verifies the link before any module code runs
 * (auth kind `file-link`, kernel/auth/file-links.ts; docs/03-auth-middleware.md §0), so this route is
 * never anonymous; the module's serve() streams the file the verified link names.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FileLink } from '../auth/file-links.js';
import { AppError } from '../errors/index.js';

export interface FileRoute {
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
  app.route({
    method: ['GET', 'HEAD'],
    url: '/files/*',
    exposeHeadRoute: false,
    config: { auth: 'file-link' },
    schema: { hide: true },
    async handler(request, reply) {
      const file = request.auth?.via === 'file-link' ? request.auth.file : undefined;
      if (!file) throw new AppError('UNAUTHORIZED', 'This file needs a signed link', { reason: 'link_missing' }); // the middleware already refused it
      return route.serve(file, request, reply);
    },
  });
}
