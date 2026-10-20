import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { signFileLink, verifyFileLink } from '../auth/file-links.js';
import { parseRange, registerFileRoutes } from './files.js';

const SECRETS: Record<string, string> = { media: 'media-key', backups: 'backups-key' };
const OWNER: Record<string, string> = { pub: 'media', priv: 'media', backups: 'backups' };
const secretOf = (bucket: string) => (OWNER[bucket] ? SECRETS[OWNER[bucket]!] : undefined);
const link = (bucket: string, key: string, secret = secretOf(bucket)!) => signFileLink(secret, { bucket, key, expiresAt: new Date(Date.now() + 60_000) });

describe('files of several modules', () => {
  it('verifies a link with the key of the module that serves its bucket', () => {
    const now = new Date();
    const opts = { permanentBuckets: new Set(['pub']) };
    expect(verifyFileLink(secretOf, link('backups', 'a.archive.gz'), now, opts)).toMatchObject({ ok: true, link: { bucket: 'backups' } });
    // signed with another module's key, or for a bucket nobody serves: invalid
    expect(verifyFileLink(secretOf, link('backups', 'a.archive.gz', SECRETS.media), now, opts)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyFileLink(secretOf, signFileLink('x', { bucket: 'other', key: 'k', expiresAt: new Date(Date.now() + 60_000) }), now, opts)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('hands each verified file to the module that serves its bucket', async () => {
    const app = Fastify();
    // stands in for the auth chain: the verified link is on request.auth
    app.addHook('onRequest', async (request) => {
      const v = verifyFileLink(secretOf, request.url, new Date(), { permanentBuckets: new Set() });
      if (v.ok) (request as unknown as { auth: unknown }).auth = { via: 'file-link', principal: null, file: v.link };
    });
    registerFileRoutes(app, [
      { module: 'media', buckets: ['pub', 'priv'], permanentBuckets: ['pub'], serve: async (f, _q, reply) => reply.send({ by: 'media', key: f.key }) },
      { module: 'backups', buckets: ['backups'], permanentBuckets: [], serve: async (f, _q, reply) => reply.send({ by: 'backups', key: f.key }) },
    ]);
    expect((await app.inject({ method: 'GET', url: link('priv', 'doc.pdf') })).json()).toEqual({ by: 'media', key: 'doc.pdf' });
    expect((await app.inject({ method: 'GET', url: link('backups', 'a.archive.gz') })).json()).toEqual({ by: 'backups', key: 'a.archive.gz' });
    await app.close();
  });

  it('reads single byte ranges', () => {
    expect(parseRange('bytes=0-1', 10)).toEqual({ start: 0, end: 1 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=20-', 10)).toBe('unsatisfiable');
    expect(parseRange(undefined, 10)).toBeNull();
  });
});
