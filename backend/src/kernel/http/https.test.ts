/**
 * HTTPS in the server itself (TLS_CERT_FILE, TLS_KEY_FILE) and the plain-HTTP port that only redirects to it.
 * The certificate in src/testing/fixtures/tls is a self-signed one for localhost and 127.0.0.1, made for these tests
 * only (openssl req -x509 … -days 36500); its private key is public, so nothing may ever trust it.
 */
import { request as httpGet } from 'node:http';
import { request as httpsGet } from 'node:https';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { redirectLocation, redirectOrigin, startRedirectServer } from './redirect.js';
import { createServer } from './server.js';

const FIXTURES = join(import.meta.dirname, '../../testing/fixtures/tls');
const CERT = join(FIXTURES, 'localhost.crt');
const KEY = join(FIXTURES, 'localhost.key');

/** GET over HTTPS, trusting only the test certificate */
function getHttps(port: number, path: string): Promise<{ status: number; body: string; protocol: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpsGet({ host: '127.0.0.1', servername: 'localhost', port, path, ca: readFileSync(CERT) }, (res) => {
      // the socket is released when the body ends: read the TLS version first
      const protocol = (res.socket as { getProtocol?: () => string }).getProtocol?.();
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body, protocol }));
    });
    req.on('error', reject);
    req.end();
  });
}

function getHttp(port: number, path: string, host = 'marketly.lan'): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTPS', () => {
  const config = loadConfig({ NODE_ENV: 'test', TLS_CERT_FILE: CERT, TLS_KEY_FILE: KEY, PORT: '0', API_URL: 'https://localhost:8443' });
  const app = createServer(config);
  app.get('/api/public/ping', async () => ({ ok: true }));
  let port = 0;

  beforeAll(async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(() => app.close());

  it('answers over TLS with the configured certificate', async () => {
    const res = await getHttps(port, '/api/public/ping');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(res.protocol).toMatch(/^TLSv1\.[23]$/);
  });

  it('refuses plain HTTP on the HTTPS port', async () => {
    await expect(getHttp(port, '/api/public/ping')).rejects.toThrow();
  });

  it('stops at startup with the file it cannot read', () => {
    const missing = loadConfig({ NODE_ENV: 'test', TLS_CERT_FILE: join(FIXTURES, 'nope.crt'), TLS_KEY_FILE: KEY });
    expect(() => createServer(missing)).toThrow(/Cannot read the HTTPS certificate \(TLS_CERT_FILE\)/);
  });
});

describe('HTTP → HTTPS redirect', () => {
  let server: Awaited<ReturnType<typeof startRedirectServer>>;
  let port = 0;

  beforeAll(async () => {
    server = await startRedirectServer({ apiUrl: 'https://marketly.lan', port: 443 }, 0, '127.0.0.1');
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('answers every request with 301 to the same path on the https address', async () => {
    expect(await getHttp(port, '/staff?tab=invited')).toEqual({ status: 301, location: 'https://marketly.lan/staff?tab=invited' });
    expect(await getHttp(port, '/api/admin/identity/staff')).toEqual({ status: 301, location: 'https://marketly.lan/api/admin/identity/staff' });
  });

  it('never sends a browser to a host the request names', async () => {
    expect(await getHttp(port, '/', 'evil.example')).toEqual({ status: 301, location: 'https://marketly.lan/' });
    expect(redirectLocation('https://marketly.lan', 'http://evil.example/x')).toBe('https://marketly.lan/');
    expect(redirectLocation('https://marketly.lan', '//evil.example/x')).toBe('https://marketly.lan/');
  });

  it('without an https API_URL, keeps the name the browser used on the HTTPS port', () => {
    expect(redirectOrigin({ apiUrl: 'http://localhost:4000', port: 8443 }, '192.168.1.10:8080')).toBe('https://192.168.1.10:8443');
    expect(redirectOrigin({ apiUrl: 'http://localhost:4000', port: 443 }, 'marketly.lan')).toBe('https://marketly.lan');
    expect(redirectOrigin({ apiUrl: 'http://localhost:4000', port: 443 }, 'bad host/x')).toBe('https://localhost');
  });
});
