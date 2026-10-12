/**
 * Configuration guards: development tokens (and their default secrets) stay on this machine
 * (docs/03-auth-middleware.md §16), production refuses them altogether.
 */
import { describe, expect, it } from 'vitest';
import { isLocalMongo, isLoopbackHost, loadConfig } from './index.js';

describe('development tokens guard', () => {
  it('serves development tokens on loopback by default, in development and tests', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const c = loadConfig({ NODE_ENV });
      expect(c.devTokens).toBe(true);
      expect(c.host).toBe('127.0.0.1');
    }
    expect(loadConfig({ NODE_ENV: 'development', HOST: 'localhost', MONGODB_URI: 'mongodb://localhost:27017/marketly?replicaSet=rs0' }).devTokens).toBe(true);
    expect(loadConfig({ NODE_ENV: 'development', HOST: '::1', MONGODB_URI: 'mongodb://u:p@127.0.0.1:27018/db' }).devTokens).toBe(true);
  });

  it('refuses development tokens on a non-loopback host or a non-local database', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', HOST: '0.0.0.0' })).toThrow(/loopback HOST/);
    expect(() => loadConfig({ NODE_ENV: 'development', HOST: '192.168.1.20' })).toThrow(/loopback HOST/);
    expect(() => loadConfig({ NODE_ENV: 'test' }, { host: '0.0.0.0' })).toThrow(/loopback HOST/);
    expect(() => loadConfig({ NODE_ENV: 'development', MONGODB_URI: 'mongodb://u:p@db.internal:27017/marketly' })).toThrow(/local MongoDB/);
  });

  it('serves beyond this machine only without development tokens, and with a real APP_SECRET', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', HOST: '0.0.0.0', DEV_TOKENS: 'false' })).toThrow(/APP_SECRET/);
    const c = loadConfig({ NODE_ENV: 'development', HOST: '0.0.0.0', DEV_TOKENS: 'false', APP_SECRET: 'x'.repeat(40) });
    expect(c.devTokens).toBe(false);
    expect(c.host).toBe('0.0.0.0');
  });

  it('listens on every interface in production by default and never takes development tokens there', () => {
    const prod = {
      NODE_ENV: 'production',
      APP_SECRET: 'x'.repeat(40),
      STORE_URL: 'https://marketly.example',
      SELLER_URL: 'https://seller.marketly.example',
      ADMIN_URL: 'https://admin.marketly.example',
      API_URL: 'https://api.marketly.example',
      AUTH_JWKS: '{"keys":[]}',
      MONGODB_URI: 'mongodb://u:p@db.internal:27017/marketly?replicaSet=rs0',
    };
    const c = loadConfig(prod);
    expect(c.host).toBe('0.0.0.0');
    expect(c.devTokens).toBe(false);
    expect(() => loadConfig(prod, { devTokens: true })).toThrow(/production/);
    expect(c.docsEnabled).toBe(false);
    expect(() => loadConfig({ ...prod, DOCS_ENABLED: 'true' })).toThrow(/DOCS_ENABLED/);
  });

  it('knows loopback hosts and local MongoDB servers', () => {
    expect(['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]'].every(isLoopbackHost)).toBe(true);
    expect(['0.0.0.0', '10.0.0.5', 'api.marketly.example', '::'].some(isLoopbackHost)).toBe(false);
    expect(isLocalMongo(undefined)).toBe(true);
    expect(isLocalMongo('mongodb://u@[::1]:27017/db')).toBe(true);
    expect(isLocalMongo('mongodb://%2Ftmp%2Fmongodb-27017.sock/marketly')).toBe(true);
    expect(isLocalMongo('mongodb://u@db.internal/marketly')).toBe(false);
    expect(isLocalMongo('mongodb+srv://u@cluster.example/marketly')).toBe(false);
    expect(isLocalMongo('not a url')).toBe(false);
  });
});
