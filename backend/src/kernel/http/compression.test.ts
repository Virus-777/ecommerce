/**
 * Compressed answers (kernel/http/compression.ts): which answers are encoded, which are sent as they are, and
 * that the headers the apps read survive the encoding.
 */
import type { FastifyInstance } from 'fastify';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { AppError } from '../errors/index.js';
import { installCompression } from './compression.js';
import { registerFileRoutes } from './files.js';
import { createServer } from './server.js';

/** Repetitive like a real list answer, and well over the 1 KB threshold */
const BIG = JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ id: `item-${i}`, name: 'Wireless earbuds', price: { amount: 2999, currency: 'USD' } })) });
const SMALL = JSON.stringify({ count: 3 });
const STREAM = `${': ping\n'.repeat(300)}`;

/** A server built the way buildApp builds one: compression installed before the routes */
async function demoServer(env: Record<string, string> = {}): Promise<FastifyInstance> {
  const config = loadConfig({ NODE_ENV: 'test', ...env });
  const app = createServer(config);
  await installCompression(app, config);
  app.get('/api/store/demo/items', async (_req, reply) => reply.type('application/json').send(BIG));
  app.get('/api/store/demo/badge', async (_req, reply) => reply.type('application/json').send(SMALL));
  app.get('/api/store/demo/notices', async (_req, reply) => reply.type('text/event-stream').send(STREAM));
  app.get('/api/store/demo/expired', async () => {
    // long enough to be worth compressing, so the 401 goes through both the security hook and the encoder
    throw new AppError('UNAUTHORIZED', 'This token has expired', { reason: 'token_expired', hint: 'x'.repeat(1200) });
  });
  await app.ready();
  return app;
}

describe('compressed answers', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await demoServer();
  });
  afterAll(async () => {
    await app.close();
  });

  it('gzips a list answer for a client that asks for it, and says so', async () => {
    const res = await app.inject({ url: '/api/store/demo/items', headers: { 'accept-encoding': 'gzip' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(String(res.headers.vary)).toContain('accept-encoding');
    expect(gunzipSync(res.rawPayload).toString()).toBe(BIG);
    expect(res.rawPayload.length * 4).toBeLessThan(Buffer.byteLength(BIG));
  });

  it('takes brotli where a browser offers it', async () => {
    const res = await app.inject({ url: '/api/store/demo/items', headers: { 'accept-encoding': 'br, gzip, deflate' } });
    expect(res.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(res.rawPayload).toString()).toBe(BIG);
  });

  it('sends the plain answer to a client that asks for no encoding', async () => {
    for (const headers of [{}, { 'accept-encoding': 'identity' }, { 'accept-encoding': 'gzip', 'x-no-compression': '1' }]) {
      const res = await app.inject({ url: '/api/store/demo/items', headers });
      expect(res.headers['content-encoding'], JSON.stringify(headers)).toBeUndefined();
      expect(res.body).toBe(BIG);
    }
  });

  it('leaves a small answer and a live stream as they are', async () => {
    const badge = await app.inject({ url: '/api/store/demo/badge', headers: { 'accept-encoding': 'gzip' } });
    expect(badge.headers['content-encoding']).toBeUndefined();
    expect(badge.body).toBe(SMALL);
    // a compressor would hold back events the stream exists to deliver as they happen
    const notices = await app.inject({ url: '/api/store/demo/notices', headers: { 'accept-encoding': 'gzip' } });
    expect(notices.headers['content-encoding']).toBeUndefined();
    expect(notices.body).toBe(STREAM);
  });

  it('keeps the response headers an app reads on a compressed refusal', async () => {
    const res = await app.inject({ url: '/api/store/demo/expired', headers: { 'accept-encoding': 'gzip' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-encoding']).toBe('gzip');
    // the security hook reads the error before the encoder runs (its reason decides this header)
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(JSON.parse(gunzipSync(res.rawPayload).toString()).error.code).toBe('UNAUTHORIZED');
  });

  it('sends files as they are stored (Content-Length, ranges, already-compressed bytes)', async () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    const bare = createServer(config);
    await installCompression(bare, config);
    let compress: unknown = 'not registered';
    bare.addHook('onRoute', (route) => {
      if (route.url === '/files/*') compress = route.compress;
    });
    registerFileRoutes(bare, [{ module: 'demo', permanentBuckets: [], serve: async () => undefined }]);
    await bare.ready();
    expect(compress).toBe(false);
    await bare.close();
  });

  it('sends every answer as it is with COMPRESSION=false', async () => {
    const plain = await demoServer({ COMPRESSION: 'false' });
    const res = await plain.inject({ url: '/api/store/demo/items', headers: { 'accept-encoding': 'gzip, br' } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers.vary).toBeUndefined();
    expect(res.body).toBe(BIG);
    await plain.close();
  });
});
