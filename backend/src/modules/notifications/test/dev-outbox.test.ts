/**
 * Development outbox (R1): GET/DELETE /api/dev/notifications/outbox list what the development providers sent, with the
 * template variables (`data`) and every link; served only while DEV_TOKENS is on, never without a token,
 * and hidden from OpenAPI.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, buildTestApp, callers, TEST_JWK } from '../../../testing/app.js';
import { linksIn } from '../providers/dev-outbox.js';
import { as, bootWorld, devOutbox, publish, type World } from './harness.js';

let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  ({ app, world } = await bootWorld());
});
afterAll(async () => {
  await app?.close();
});

const outbox = async (query = '', headers: Record<string, string> = auth(callers.visitor())) => app.inject({ method: 'GET', url: `/api/dev/notifications/outbox${query}`, headers });
const addr = (name: string) => `${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;

function codeIssued(to: string, code: string) {
  return { challengeId: crypto.randomUUID(), accountId: null, purpose: 'email_verification', channel: 'email', to, code, expiresAt: new Date(Date.now() + 600_000).toISOString(), existingAccount: false };
}

describe('GET /api/dev/notifications/outbox', () => {
  it('lists a verification email with its code in data, newest first, for any valid token', async () => {
    const to = addr('ana');
    await publish(app, 'identity.verification.code_issued', codeIssued(to, '482913'));
    await publish(app, 'identity.verification.code_issued', codeIssued(to, '771204'));

    const res = await outbox(`?to=${encodeURIComponent(to.toUpperCase())}&channel=email`);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as any[];
    expect(items.map((i) => i.data.code.value)).toEqual(['771204', '482913']);
    expect(items[0]).toMatchObject({ channel: 'email', to, topic: 'customer.account.verification_code' });
    expect(items[0].text).toContain('771204');
    expect(items[0].providerMessageId).toMatch(/^dev-email-/);

    // a customer or seller token works as well as a visitor's
    const customer = world.customer();
    expect((await outbox(`?to=${encodeURIComponent(to)}&limit=1`, as.customer(customer))).json().items).toHaveLength(1);
  });

  it('gives every link of a password reset email, and the reset URL in data', async () => {
    const c = world.customer();
    const resetUrl = 'http://127.0.0.1:3000/reset-password#token=abc123';
    await publish(app, 'identity.password_reset.requested', { accountId: c.accountId, email: c.email, resetUrl, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const [mail] = (await outbox(`?to=${encodeURIComponent(c.email)}`)).json().items as any[];
    expect(mail.data.reset).toEqual({ url: resetUrl });
    expect(mail.links).toContain(resetUrl);
  });

  it('filters by time and checks the query', async () => {
    const to = addr('since');
    await publish(app, 'identity.verification.code_issued', codeIssued(to, '111111'));
    const later = new Date(Date.now() + 60_000).toISOString();
    expect((await outbox(`?to=${encodeURIComponent(to)}&since=${encodeURIComponent(later)}`)).json().items).toEqual([]);

    expect((await outbox('?limit=0')).statusCode).toBe(400);
    expect((await outbox('?limit=201')).statusCode).toBe(400);
    expect((await outbox('?channel=fax')).statusCode).toBe(400);
    expect((await outbox('?since=yesterday')).statusCode).toBe(400);
  });

  it('answers every web app cross-origin', async () => {
    expect(app.corsRoutes.ruleFor('/api/dev/notifications/outbox?to=x')).toEqual({ anyApp: true });
  });

  it('needs a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/dev/notifications/outbox' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/dev/notifications/outbox' })).statusCode).toBe(401);
  });

  it('DELETE clears it', async () => {
    await publish(app, 'identity.verification.code_issued', codeIssued(addr('clear'), '222222'));
    const res = await app.inject({ method: 'DELETE', url: '/api/dev/notifications/outbox', headers: auth(callers.visitor()) });
    expect(res.statusCode).toBe(204);
    expect(devOutbox.email).toHaveLength(0);
    expect((await outbox()).json().items).toEqual([]);
  });

  it('is not in the OpenAPI document', async () => {
    const doc = app.swagger() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).filter((p) => p.startsWith('/api/dev'))).toEqual([]);
  });
});

describe('without DEV_TOKENS', () => {
  it('the outbox routes are not registered', async () => {
    const jwk = { ...TEST_JWK, kid: 'test-signing' };
    const prod: FastifyInstance = await buildTestApp({
      modules: ['identity', 'notifications', 'access', 'customers', 'sellers', 'audit', 'media'],
      env: { NODE_ENV: 'test', AUTH_SIGNING_JWK: JSON.stringify(jwk), APP_SECRET: 'test-app-secret-0123456789abcdef0123456789' },
      config: { devTokens: false, rateLimits: false },
    });
    try {
      expect(prod.hasRoute({ method: 'GET', url: '/api/dev/notifications/outbox' })).toBe(false);
      expect(prod.hasRoute({ method: 'DELETE', url: '/api/dev/notifications/outbox' })).toBe(false);
    } finally {
      await prod.close();
    }
    expect(app.hasRoute({ method: 'GET', url: '/api/dev/notifications/outbox' })).toBe(true);
  });
});

describe('linksIn', () => {
  it('finds each URL once, decoding &amp; and dropping trailing punctuation', () => {
    expect(linksIn('Open https://a.example/x?y=1. Or https://a.example/x?y=1', '<a href="https://b.example/p?a=1&amp;b=2">go</a>')).toEqual([
      'https://a.example/x?y=1',
      'https://b.example/p?a=1&b=2',
    ]);
  });
});
