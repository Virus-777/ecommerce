/**
 * The built Admin Center (ADMIN_APP_DIR: index.html + assets/ from `npm run build` in admin-center), served on the
 * API's own HTTPS address so one server is the whole staff system and the app calls the API on the same origin.
 *
 * Every GET or HEAD outside /api, /graphql, /files, /webhooks, /health and /docs is answered from that folder: the
 * file when it exists, else index.html (the app's own routes, e.g. /orders/123, are pages of the single-page app).
 * A missing file under /assets/ is a 404 instead: hashed file names change with each build, and HTML in place of a
 * script would only hide the mistake.
 *
 * These are static web files, not API endpoints: they carry no token (rule "every endpoint needs a token",
 * docs/03-auth-middleware.md, covers /api and /graphql, which still check one). This hook answers before the auth
 * middleware runs, and everything it does not answer goes on to the middleware as before.
 */
import { createReadStream, existsSync, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config/index.js';

/** Paths of the API and the server itself: never answered from the Admin Center folder */
const NOT_APP = /^\/(api|graphql|files|webhooks|health|docs)(\/|$)/;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * For a Vite app on its own origin: scripts, styles, fonts and API calls from this server only; inline styles (React
 * style attributes); images also as data: and blob: URLs (previews of files being uploaded); never inside a frame.
 */
export const ADMIN_APP_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * The file under root a URL path names, or null when the path is not a plain path inside root (.., encoded
 * slashes or backslashes, NUL): such a request gets 404, never a file from elsewhere on the disk.
 */
export function fileUnder(root: string, urlPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed %-encoding
  }
  if (path.includes('\0') || path.includes('\\')) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) return null;
  const file = resolve(root, ...parts);
  // belt and braces: whatever the path said, the file must be inside the folder
  return file === root || file.startsWith(root + sep) ? file : null;
}

async function fileStats(file: string): Promise<Stats | null> {
  try {
    const s = await stat(file);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

export function installAdminApp(app: FastifyInstance, config: Config) {
  if (!config.adminAppDir) return;
  const root = resolve(config.adminAppDir);
  const indexFile = join(root, 'index.html');
  // a wrong folder is a configuration mistake: stop at startup rather than answer every page with an error
  if (!existsSync(indexFile)) throw new Error(`ADMIN_APP_DIR ${root} has no index.html: point it at the built Admin Center (admin-center/dist)`);

  const send = (request: { method: string }, reply: FastifyReply, file: string, stats: Stats, cache: string) => {
    reply
      .header('content-type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
      .header('content-length', String(stats.size))
      .header('cache-control', cache)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('content-security-policy', ADMIN_APP_CSP)
      .header('x-frame-options', 'DENY');
    if (config.env === 'production' && config.tls) reply.header('strict-transport-security', 'max-age=31536000');
    // HEAD: the same headers, no body
    return reply.code(200).send(request.method === 'HEAD' ? undefined : createReadStream(file));
  };

  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return;
    const urlPath = request.url.split('?')[0]!;
    if (NOT_APP.test(urlPath)) return; // the API and its middleware

    const file = fileUnder(root, urlPath);
    if (!file) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    const stats = file === root ? null : await fileStats(file);
    if (stats) {
      // hashed build files never change under their name; anything else is checked again on each visit
      const cache = urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : file === indexFile ? 'no-store' : 'no-cache';
      return send(request, reply, file, stats, cache);
    }
    if (urlPath.startsWith('/assets/')) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    // a page of the app (/, /orders/123, …): index.html, never cached so a new release is picked up at once
    const index = await fileStats(indexFile);
    if (!index) return reply.code(404).type('text/plain; charset=utf-8').send('The Admin Center is not installed');
    return send(request, reply, indexFile, index, 'no-store');
  });
}
