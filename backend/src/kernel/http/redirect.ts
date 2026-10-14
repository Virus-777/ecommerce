/**
 * HTTP_REDIRECT_PORT (e.g. 80): a plain-HTTP listener whose only answer is 301 to the same path on the https
 * address, so staff who type http://marketly.lan land on the HTTPS site. It serves no content and reads no body,
 * so it needs no token (like the health port, it is not part of the API).
 */
import { createServer, type Server } from 'node:http';
import type { Config } from '../config/index.js';

/**
 * The https origin to send browsers to: API_URL when it is an https address (production always sets it), else this
 * server's name from the Host header on the HTTPS port (development tries).
 */
export function redirectOrigin(config: Pick<Config, 'apiUrl' | 'port'>, hostHeader: string | undefined): string {
  if (config.apiUrl.startsWith('https://')) return new URL(config.apiUrl).origin;
  // the Host header without its port; anything unusual falls back to localhost
  const name = /^(\[[0-9a-f:.]+\]|[\w.-]+)(:\d+)?$/i.exec(hostHeader ?? '')?.[1] ?? 'localhost';
  return `https://${name}${config.port === 443 ? '' : `:${config.port}`}`;
}

/** The Location for a request URL: only its path and query are kept (never a host the request names) */
export function redirectLocation(origin: string, url: string | undefined): string {
  const path = url && url.startsWith('/') && !url.startsWith('//') ? url : '/';
  return origin + path;
}

export function startRedirectServer(config: Pick<Config, 'apiUrl' | 'port'>, port: number, host: string): Promise<Server> {
  const server = createServer((req, res) => {
    const location = redirectLocation(redirectOrigin(config, req.headers.host), req.url);
    res.writeHead(301, { location, 'content-length': '0', 'cache-control': 'no-store' }).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
