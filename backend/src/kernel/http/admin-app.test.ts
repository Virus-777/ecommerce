/**
 * The built Admin Center served by the API (ADMIN_APP_DIR): files, the single-page app's routes, caching, security
 * headers, path traversal, and the API paths it leaves to the auth middleware.
 */
import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { AppError } from '../errors/index.js';
import { ADMIN_APP_CSP, fileUnder } from './admin-app.js';
import { createServer } from './server.js';

const INDEX = '<!doctype html><title>Admin Center</title>';
const SCRIPT = 'console.log("admin")';

describe('Admin Center files', () => {
  // <tmp>/secret.txt next to <tmp>/admin: what a traversal would try to read
  const tmp = mkdtempSync(join(tmpdir(), 'marketly-admin-'));
  const dir = join(tmp, 'admin');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'index-B4x9.js'), SCRIPT);
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(tmp, 'secret.txt'), 'not for the web');

  let app: FastifyInstance;
  beforeAll(async () => {
    app = createServer(loadConfig({ NODE_ENV: 'test', ADMIN_APP_DIR: dir }));
    // stands in for the auth middleware (installed after createServer in buildApp): no token, no answer
    app.addHook('onRequest', async () => {
      throw new AppError('UNAUTHORIZED', 'A token is required', { reason: 'token_missing' });
    });
    app.get('/api/admin/ping', async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('serves index.html for the app and its routes, never cached, with the security headers', async () => {
    for (const url of ['/', '/index.html', '/orders/9f0c', '/staff?tab=invited']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toBe(INDEX);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toBe(ADMIN_APP_CSP);
    }
    expect(ADMIN_APP_CSP).toContain("default-src 'self'");
    expect(ADMIN_APP_CSP).toContain("frame-ancestors 'none'");
  });

  it('serves the hashed build files for a year, and other files revalidated', async () => {
    const js = await app.inject({ method: 'GET', url: '/assets/index-B4x9.js' });
    expect(js.statusCode).toBe(200);
    expect(js.body).toBe(SCRIPT);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('answers HEAD with the headers only', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/assets/index-B4x9.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(SCRIPT.length));
    expect(res.body).toBe('');
  });

  it('answers a missing build file with 404, not with the app page', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-OLD.js' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('Admin Center');
  });

  it('never serves a file outside the folder', async () => {
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/%00index.html', '/%E0%A4%A']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('not for the web');
    }
    expect(fileUnder(dir, '/../secret.txt')).toBeNull();
    expect(fileUnder(dir, '/assets/..%2f..%2fsecret.txt')).toBeNull();
    expect(fileUnder(dir, '/a%5c..%5c..%5csecret.txt')).toBeNull();
    expect(fileUnder(dir, '/assets/index-B4x9.js')).toBe(join(dir, 'assets', 'index-B4x9.js'));
  });

  it('leaves the API, other methods and the server paths to the auth middleware', async () => {
    for (const url of ['/api/admin/ping', '/api', '/graphql/admin', '/files/x', '/webhooks/x', '/health', '/docs']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
    expect((await app.inject({ method: 'POST', url: '/' })).statusCode).toBe(401);
  });

  it('refuses to start with a folder that has no index.html', () => {
    expect(() => createServer(loadConfig({ NODE_ENV: 'test', ADMIN_APP_DIR: tmp }))).toThrow(/has no index.html/);
  });
});
