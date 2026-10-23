/**
 * gzip on the way out (COMPRESSION, default on): the same answers, a fifth of the bytes.
 *
 * This API's JSON is long field names and repeated shapes, so it compresses about five times over: a 24-product
 * search answer 35 KB → 7 KB, the category tree 30 KB → 6 KB, 48 brands 8 KB → 2 KB. Nothing is asked of the
 * clients: the Android app's OkHttp sends `Accept-Encoding: gzip` on every request and decodes the answer itself,
 * browsers also offer brotli and zstd, and a client that offers nothing keeps getting the plain answer.
 *
 * Left alone:
 *   - answers under `config.compression.threshold` bytes: a `Content-Encoding` header and a compressor cost more
 *     than the handful of bytes they would save (the cart badge is 34 bytes);
 *   - what is already compressed — images, video, PDFs, archives (mime-db decides) — and `text/event-stream`,
 *     where a compressor would hold back the events the stream exists to deliver as they happen;
 *   - `206 Partial Content` and any answer carrying `Content-Range`: those offsets count unencoded bytes, and the
 *     signed file links serve ranges (http/files.ts);
 *   - a request with `X-No-Compression`, for measuring what an answer costs uncompressed.
 *
 * Compressed answers carry `Vary: Accept-Encoding` so that a cache in front of the server keeps the encodings
 * apart; `/api`, `/graphql` and `/webhooks` answers are `private, no-store` anyway (http/security.ts).
 *
 * Compression can give away a secret in an answer when another site can make the server repeat text of its
 * choosing next to it and watch the size (BREACH). It cannot here: every `/api` and `/graphql` answer needs a
 * token in a header, which another site's page cannot add to a request, and the refresh-cookie routes need an
 * allowed `Origin` and `X-Requested-With` as well (docs/03-auth-middleware.md §5).
 *
 * Only answers are compressed. Request bodies stay as they were (`globalDecompression: false`): the apps send
 * small bodies, and unpacking one the server did not ask for is a bomb waiting to go off.
 */
import compress from '@fastify/compress';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';

/**
 * Compresses the answers of the routes registered after it, so buildApp installs it before any of them (the
 * plugin hooks each route as it is registered; a route registered earlier would never see it). The hook it adds
 * is a route hook, which runs after the server's own (security.ts reads the text of a 401 before it is encoded).
 */
export async function installCompression(app: FastifyInstance, config: Config) {
  if (!config.compression) return;
  await app.register(compress, { threshold: config.compression.threshold, globalDecompression: false });
}
