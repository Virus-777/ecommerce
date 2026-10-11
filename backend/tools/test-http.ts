#!/usr/bin/env tsx
/**
 * Calls every spec endpoint over real HTTP and checks the authorization contract
 * (docs/03-auth-middleware.md) end to end: TCP, headers, JSON, the full middleware chain.
 *
 *   npm run test:http                         boot all modules (every launch phase) on a free port and test it
 *   npm run test:http -- --only catalog,orders
 *   npm run test:http -- --url http://localhost:4000   test a running dev server (DEV_TOKENS on, RATE_LIMITS=false;
 *                                             tokens are signed with DEV_SIGNING_KEY_FILE; refresh and webhook
 *                                             success cases are skipped there)
 *
 * Per endpoint, with input generated from the spec so validation passes:
 *   no token                → 401 (bootstrap: APP_PROOF_INVALID)
 *   invalid token / proof   → 401 (expired JWT, wrong refresh token, bad signature, bad app proof)
 *   another app's token     → 403 WRONG_AUDIENCE
 *   wrong kind of caller    → 401 (visitor on customer/account endpoints, seller without a seller account)
 *   missing permission      → 403 FORBIDDEN or OWNER_ONLY
 *   missing step-up proof   → 403 STEP_UP_REQUIRED
 *   the right token         → passes the middleware and validation and reaches the handler
 * Plus: unknown URLs, CORS preflight, GraphQL per area, /docs, and the internal health port.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import type { z } from 'zod';
import { buildApp } from '../src/app.js';
import type { WebhookVerifier } from '../src/kernel/auth/chain.js';
import { devClaims, type DevClaims, type DevKind, type DevOptions } from '../src/kernel/auth/dev.js';
import { devSigner, newDevJwk, signAccessToken, type Audience } from '../src/kernel/auth/tokens.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { startHealthServer } from '../src/kernel/http/health.js';
import { urlOf } from '../src/kernel/http/register.js';
import { hmacWebhookVerifier, signWebhook } from '../src/kernel/http/webhooks.js';
import { allSpecs, withDependencies } from '../src/kernel/module-system/loader.js';
import type { Area, AuthKind, EndpointDef } from '../src/kernel/spec/define.js';
import { sampleParams, sampleQuery, validSample } from '../src/testing/samples.js';

const { values } = parseArgs({ options: { url: { type: 'string' }, only: { type: 'string' }, concurrency: { type: 'string', default: '8' } } });
const only = values.only?.split(',').map((s) => s.trim());
const external = values.url?.replace(/\/$/, '');

/* ---------------------------------------------------------------- server and credentials */

const REFRESH = 'http-test-refresh-token';
const WEBHOOK_SECRET = 'dev-webhook-secret';
const ORIGIN = 'http://localhost:3000';
const SELLER_ORIGIN = 'http://localhost:3001';
// modules whose endpoints are tested; the server also runs their dependencies
const modules = only ?? Object.keys(allSpecs);
const booted = only ? withDependencies(only) : modules;

let base: string;
let healthBase: string | undefined;
let stop = async () => {};
let signer: ReturnType<typeof devSigner>;
let issuer: string;

if (external) {
  const config = loadConfig();
  signer = devSigner({ file: config.devSigning.file });
  issuer = config.auth.issuer;
  base = external;
} else {
  const jwk = newDevJwk();
  signer = devSigner({ jwk });
  issuer = 'marketly-identity';
  // modules that don't verify their webhooks yet get the standard HMAC verifier
  const verifiers: Record<string, WebhookVerifier> = Object.fromEntries(booted.map((m) => [m, hmacWebhookVerifier(loadConfig({ NODE_ENV: 'test' }), m)]));
  const t0 = Date.now();
  const app = await buildApp({
    env: { NODE_ENV: 'test' },
    modules: booted,
    config: { launchPhase: 4, rateLimits: false, devTokens: true, devSigning: { file: '', jwk }, migrateOnStart: true, responseValidation: true, cors: { store: [ORIGIN], seller: [SELLER_ORIGIN], admin: [] } },
    authorities: (a) => ({ ...a, verifyRefreshToken: async (t) => (t === REFRESH ? { sessionId: 'http-test-session', accountId: null, audience: 'store', kind: 'customer' } : a.verifyRefreshToken(t)) }),
    webhookVerifiers: verifiers,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const health = await startHealthServer(() => app.kernel.health(), 0, '127.0.0.1');
  healthBase = `http://127.0.0.1:${(health.address() as AddressInfo).port}`;
  stop = async () => {
    health.close();
    await app.close();
  };
  console.log(`Booted ${app.kernel.modules.length} modules on ${base} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const sign = (claims: DevClaims, ttlSeconds = 900, now?: Date) => signAccessToken(signer, claims, { issuer, ttlSeconds, now });
const tok = (kind: DevKind, o: DevOptions = {}, over: Partial<DevClaims> = {}) => sign({ ...devClaims(kind, o), ...over });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const BEARER = new Set<AuthKind>(['visitor', 'shopper', 'customer', 'account', 'seller', 'staff']);
const AUDIENCE: Partial<Record<Area, Audience>> = { store: 'store', seller: 'seller', admin: 'admin' };
const ownerOnly = new Set(Object.values(allSpecs).flatMap((s) => s.permissions.filter((p) => p.ownerOnly).map((p) => p.key)));

/** The right token for an endpoint: the caller kind it names, for the app that owns the area. */
function rightToken(d: EndpointDef): Record<string, string> {
  const audience = AUDIENCE[d.area] ?? 'store';
  switch (d.auth) {
    case 'visitor':
      return bearer(tok('visitor', { audience }));
    case 'account':
      return bearer(audience === 'seller' ? tok('seller') : audience === 'admin' ? tok('staff') : tok('customer'));
    case 'shopper':
    case 'customer':
      return bearer(tok('customer'));
    case 'seller':
      return bearer(tok('seller'));
    case 'staff':
      return bearer(tok('staff'));
    case 'refresh':
      return { cookie: `__Secure-mk_refresh=${REFRESH}`, origin: ORIGIN, 'x-requested-with': 'fetch' }; // the website's cookie, from an app page
    case 'provider':
      return { 'x-event-id': crypto.randomUUID() }; // signed per request in send()
    case 'bootstrap':
      return { 'x-app-proof': 'dev' };
  }
}

/* ---------------------------------------------------------------- HTTP */

interface Res {
  status: number;
  headers: Headers;
  body: any;
}

async function send(method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  const h: Record<string, string> = { ...headers };
  const raw = body === undefined ? undefined : JSON.stringify(body);
  if (raw !== undefined) h['content-type'] = 'application/json';
  // webhooks: sign the exact body, unless the case sends its own (forged) signature
  if (url.startsWith('/webhooks/') && 'x-event-id' in h && !('x-signature' in h)) Object.assign(h, signWebhook(WEBHOOK_SECRET, raw ?? ''));
  const res = await fetch(base + url, { method, headers: h, body: raw, redirect: 'manual' });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, headers: res.headers, body: parsed };
}

const code = (r: Res) => r.body?.error?.code as string | undefined;
const brief = (r: Res) => `${r.status} ${code(r) ?? ''} ${r.body?.error?.message ?? (typeof r.body === 'string' ? r.body.slice(0, 80) : '')}`.trim();

/* ---------------------------------------------------------------- cases */

interface Outcome {
  operation: string;
  check: string;
  ok: boolean;
  skipped?: string;
  detail?: string;
}
const results: Outcome[] = [];
const record = (operation: string, check: string, failure: string | null | undefined, skipped?: string) =>
  results.push({ operation, check, ok: !failure, skipped, detail: failure ?? undefined });

/** Headers every API response carries, whatever its status */
function headerProblems(r: Res, url: string): string | null {
  if (/^\/(api|graphql|webhooks)\//.test(url) && r.headers.get('cache-control') !== 'private, no-store') return `cache-control is ${r.headers.get('cache-control')}`;
  if (r.status === 401 && code(r) === 'UNAUTHORIZED' && !r.headers.get('www-authenticate')) return '401 without WWW-Authenticate';
  return null;
}

const expectStatus = (r: Res, status: number, codes: string[]) =>
  r.status === status && (!codes.length || codes.includes(code(r) ?? '')) ? null : `expected ${status} ${codes.join('|')}, got ${brief(r)}`;

async function testEndpoint(module: string, id: string, d: EndpointDef) {
  const op = `${module}.${id}`;
  const params = sampleParams(d.params?.());
  const path = urlOf(module, d).replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? 'x'));
  const url = path + sampleQuery(d.query?.() as z.ZodType | undefined);
  const body = validSample(d.body?.());
  const isObject = body.value !== null && typeof body.value === 'object' && !Array.isArray(body.value);
  const payload = (over: Record<string, unknown> = {}) => (d.body ? (isObject ? { ...(body.value as object), ...over } : body.value) : undefined);
  const extra: Record<string, string> = {};
  if (d.idempotent) extra['idempotency-key'] = crypto.randomUUID();
  if (d.stepUp?.kind === 'code') extra['x-step-up-code'] = '000000';
  const proof = d.stepUp?.kind === 'reauth' ? { reauthToken: `dev-reauth.${d.stepUp.purpose}` } : {};
  const call = async (check: string, headers: Record<string, string>, b: unknown, expect: (r: Res) => string | null) => {
    const r = await send(d.method, url, headers, b);
    record(op, check, expect(r) ?? headerProblems(r, url));
    return r;
  };
  // an external server may run a lower launch phase: the gate answers before caller checks
  const later = (r: Res) => r.status === 501 && r.body?.error?.details?.reason === 'later_phase';
  const unauthorized = d.auth === 'bootstrap' ? ['APP_PROOF_INVALID'] : ['UNAUTHORIZED'];

  // a running server may have the module switched off (src/modules.config.ts): nothing to test there
  if (external) {
    const probe = await send(d.method, url, { ...extra, ...rightToken(d) }, payload(proof));
    if (probe.status === 404 && /^No route/.test(probe.body?.error?.message ?? '')) return record(op, 'module off', null, 'module not enabled on this server');
  }

  // 1. no token at all
  const withoutRefreshField = d.auth === 'refresh' && body.value && typeof body.value === 'object' ? Object.fromEntries(Object.entries(body.value).filter(([k]) => k !== 'refreshToken')) : payload();
  await call('no token', extra, withoutRefreshField, (r) => expectStatus(r, 401, unauthorized));

  // 2. an invalid token of the right kind
  const invalid: Record<AuthKind, Record<string, string>> = {
    visitor: bearer(sign(devClaims('visitor'), 60, new Date(Date.now() - 3_600_000))),
    shopper: bearer(sign(devClaims('customer'), 60, new Date(Date.now() - 3_600_000))),
    customer: bearer(sign(devClaims('customer'), 60, new Date(Date.now() - 3_600_000))),
    account: bearer(signAccessToken(devSigner({ jwk: newDevJwk() }), devClaims('customer'), { issuer })),
    seller: bearer(`${tok('seller').slice(0, -8)}AAAAAAAA`),
    staff: bearer(sign(devClaims('staff'), 60, new Date(Date.now() - 3_600_000))),
    refresh: { cookie: '__Secure-mk_refresh=not-a-refresh-token', origin: ORIGIN, 'x-requested-with': 'fetch' },
    provider: { 'x-signature': 'sha256=forged', 'x-timestamp': String(Math.floor(Date.now() / 1000)) },
    bootstrap: { 'x-app-proof': 'forged' },
  };
  await call('invalid token', { ...extra, ...invalid[d.auth] }, payload(), (r) => expectStatus(r, 401, unauthorized));

  // 3. a valid token from another app
  if (BEARER.has(d.auth) && d.auth !== 'account' && AUDIENCE[d.area]) {
    const other = d.area === 'store' ? tok('staff') : tok('customer');
    const r = await send(d.method, url, { ...extra, ...bearer(other) }, payload(proof));
    if (later(r)) record(op, 'other app token', null, 'later launch phase');
    else record(op, 'other app token', expectStatus(r, 403, ['WRONG_AUDIENCE']) ?? headerProblems(r, url));
  }

  // 4. the wrong kind of caller for this app
  const wrongCaller =
    d.auth === 'customer' || (d.auth === 'account' && d.area !== 'seller' && d.area !== 'admin')
      ? bearer(tok('visitor', { audience: AUDIENCE[d.area] ?? 'store' }))
      : d.auth === 'seller' && d.sellerContext !== 'optional'
        ? bearer(tok('seller', {}, { sellerId: undefined }))
        : undefined;
  if (wrongCaller) {
    const r = await send(d.method, url, { ...extra, ...wrongCaller }, payload(proof));
    if (later(r)) record(op, 'wrong caller', null, 'later launch phase');
    else record(op, 'wrong caller', expectStatus(r, 401, ['UNAUTHORIZED']) ?? headerProblems(r, url));
  }

  // 5. signed in, without the permission
  if (d.permission && (d.auth === 'staff' || d.auth === 'seller')) {
    const t = d.auth === 'staff' ? tok('staff', { permissions: [] }) : tok('seller', { permissions: [] });
    const expected = d.auth === 'seller' && ownerOnly.has(d.permission) ? ['OWNER_ONLY'] : ['FORBIDDEN'];
    const r = await send(d.method, url, { ...extra, ...bearer(t) }, payload(proof));
    if (later(r)) record(op, 'no permission', null, 'later launch phase');
    else record(op, 'no permission', expectStatus(r, 403, expected) ?? (expected[0] === 'FORBIDDEN' && r.body?.error?.details?.permission !== d.permission ? `names ${r.body?.error?.details?.permission}` : null) ?? headerProblems(r, url));
  }

  // 6. the right token, without the step-up proof
  if (d.stepUp) {
    const headers = { ...extra, ...rightToken(d), ...(d.stepUp.kind === 'code' ? { 'x-step-up-code': '999999' } : {}) };
    const r = await send(d.method, url, headers, payload(d.stepUp.kind === 'reauth' ? { reauthToken: 'not-a-reauth-token' } : {}));
    if (later(r)) record(op, 'no step-up', null, 'later launch phase');
    else record(op, 'no step-up', expectStatus(r, 403, ['STEP_UP_REQUIRED']) ?? headerProblems(r, url));
  }

  // 7. the right token: the request reaches the handler
  if (external && (d.auth === 'refresh' || d.auth === 'provider')) {
    record(op, 'right token', null, 'needs the test verifiers (local run only)');
    return;
  }
  const r = await send(d.method, url, { ...extra, ...rightToken(d) }, payload(proof));
  if (later(r)) return record(op, 'right token', null, 'later launch phase');
  // the middleware's refusals; a handler may still refuse for business reasons on made-up data (403 without these, 400 with its own message)
  const endpointPermissions = new Set([d.permission, ...(d.permissionWhen ?? []).map((w) => w.permission)]);
  const byMiddleware =
    (r.status === 401 && code(r) === 'UNAUTHORIZED') ||
    r.status === 429 ||
    (r.status === 403 && (['WRONG_AUDIENCE', 'OWNER_ONLY', 'NO_SELLER_ACCESS', 'STEP_UP_REQUIRED'].includes(code(r) ?? '') || (code(r) === 'FORBIDDEN' && endpointPermissions.has(r.body?.error?.details?.permission))));
  const refused = (() => {
    if (byMiddleware) return `refused by the middleware: ${brief(r)}`;
    if (r.status === 400 && body.valid && r.body?.error?.message === 'Some fields are missing or invalid') return `valid input refused: ${brief(r)} ${JSON.stringify(r.body?.error?.details?.issues?.[0] ?? '')}`;
    if (r.status === 404 && /^No route/.test(r.body?.error?.message ?? '')) return `not routed: ${brief(r)}`;
    if (r.status >= 500 && r.status !== 501 && r.status !== 503) return `server error: ${brief(r)}`;
    return null;
  })();
  record(op, 'right token', refused ?? headerProblems(r, url));
  results.at(-1)!.detail ??= `→ ${brief(r)}`;
}

/* ---------------------------------------------------------------- whole-server checks */

async function testServer() {
  const op = 'server';
  let r = await send('GET', '/api/store/nowhere');
  record(op, 'unknown URL without a token → 401', expectStatus(r, 401, ['UNAUTHORIZED']) ?? (r.headers.get('www-authenticate') === 'Bearer' ? null : 'no WWW-Authenticate'));
  r = await send('GET', '/api/store/nowhere', bearer(tok('visitor')));
  record(op, 'unknown URL with a token → 404', expectStatus(r, 404, ['NOT_FOUND']));
  r = await send('GET', '/favicon.ico');
  record(op, 'any other URL without a token → 401', expectStatus(r, 401, []));
  r = await send('GET', '/health');
  record(op, 'no public /health', expectStatus(r, 401, []));
  r = await send('GET', '/docs/json');
  // DOCS_ENABLED is off outside development, so /docs needs a token like any other URL
  if (!external) record(op, '/docs off outside development', expectStatus(r, 401, []));
  r = await send('GET', '/api/store/catalog/categories', { ...bearer(tok('visitor')), authorization: 'Basic dXNlcjpwYXNz' });
  record(op, 'non-Bearer Authorization → 401', expectStatus(r, 401, ['UNAUTHORIZED']));

  r = await send('OPTIONS', '/api/store/catalog/categories', { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' });
  record(op, 'CORS preflight answered without a token', r.status === 204 ? (external || r.headers.get('access-control-allow-origin') === ORIGIN ? null : 'origin not allowed') : brief(r));
  r = await send('OPTIONS', '/api/store/catalog/categories', { origin: 'https://evil.example', 'access-control-request-method': 'GET' });
  record(op, 'CORS refuses unknown origins', r.headers.get('access-control-allow-origin') ? 'allowed an unknown origin' : null);
  r = await send('GET', '/api/store/catalog/categories', { origin: ORIGIN });
  const exposed = (r.headers.get('access-control-expose-headers') ?? '').toLowerCase();
  record(op, 'CORS exposes WWW-Authenticate, X-Request-Id, Idempotent-Replayed, Retry-After', ['www-authenticate', 'x-request-id', 'idempotent-replayed', 'retry-after'].every((h) => exposed.includes(h)) ? null : `exposes "${exposed}"`);

  if (booted.includes('identity')) {
    // the website signs in across origins: every response that sets the refresh cookie allows credentials
    const credentialed: [string, string][] = [
      ['/api/public/identity/sessions', ORIGIN],
      ['/api/public/identity/app-sessions', ORIGIN],
      ['/api/public/identity/sign-in-challenges/x/verify', ORIGIN],
      ['/api/public/identity/sessions/refresh', ORIGIN],
      ['/api/seller/identity/session/seller-context', SELLER_ORIGIN],
    ];
    for (const [url, origin] of credentialed) {
      r = await send('OPTIONS', url, { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, x-requested-with' });
      const ok = r.headers.get('access-control-allow-origin') === origin && r.headers.get('access-control-allow-credentials') === 'true' && /x-requested-with/.test(r.headers.get('access-control-allow-headers') ?? '');
      record(op, `credentialed CORS on ${url}`, external || ok ? null : `allow-origin ${r.headers.get('access-control-allow-origin')}, credentials ${r.headers.get('access-control-allow-credentials')}`);
    }
    r = await send('OPTIONS', '/api/public/identity/password-policy', { origin: ORIGIN, 'access-control-request-method': 'GET' });
    record(op, 'no credentials where no cookie is set', r.headers.get('access-control-allow-credentials') ? 'credentials allowed' : null);
    // account endpoints live under /api/store/identity but serve every app
    r = await send('OPTIONS', '/api/store/identity/security', { origin: SELLER_ORIGIN, 'access-control-request-method': 'GET' });
    record(op, 'account endpoints allow Seller Center', external || r.headers.get('access-control-allow-origin') === SELLER_ORIGIN ? null : 'seller origin refused');
    r = await send('OPTIONS', '/api/store/catalog/categories', { origin: SELLER_ORIGIN, 'access-control-request-method': 'GET' });
    record(op, 'other store endpoints refuse Seller Center', r.headers.get('access-control-allow-origin') ? 'seller origin allowed' : null);
    // the website's cookie works only from an app page
    r = await send('POST', '/api/public/identity/sessions/refresh', { cookie: `__Secure-mk_refresh=${REFRESH}` }, {});
    record(op, 'cookie refresh without Origin → 403', expectStatus(r, 403, ['FORBIDDEN']));
    r = await send('POST', '/api/public/identity/sessions/refresh', { cookie: `__Secure-mk_refresh=${REFRESH}`, origin: ORIGIN }, {});
    record(op, 'cookie refresh without X-Requested-With → 403', expectStatus(r, 403, ['FORBIDDEN']));
  }

  const ping = { query: '{ ping }' };
  const gql: [string, Record<string, string> | undefined, number][] = [
    ['/graphql/store', undefined, 401],
    ['/graphql/store', bearer(tok('visitor')), 200],
    ['/graphql/store', bearer(tok('customer')), 200],
    ['/graphql/seller', bearer(tok('customer')), 403],
    ['/graphql/seller', bearer(tok('seller')), 200],
    ['/graphql/admin', undefined, 401],
    ['/graphql/admin', bearer(tok('seller')), 403],
    ['/graphql/admin', bearer(tok('staff')), 200],
  ];
  for (const [url, h, status] of gql) {
    r = await send('POST', url, h, ping);
    const who = h ? JSON.parse(Buffer.from(h.authorization!.split('.')[1]!, 'base64url').toString()).kind : 'no token';
    record(op, `GraphQL ${url} as ${who} → ${status}`, r.status === status && (status !== 200 || r.body?.data?.ping === 'pong') ? null : brief(r));
  }

  if (healthBase) {
    const h = await fetch(`${healthBase}/health`);
    const j = (await h.json()) as { status?: string };
    record(op, 'health on the internal port', h.status === 200 && j.status === 'ok' ? null : `${h.status} ${JSON.stringify(j)}`);
  }
}

/* ---------------------------------------------------------------- run */

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<unknown>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const t = items[i++]!;
      await fn(t).catch((err) => record(String((t as any)[0]) + '.' + String((t as any)[1]), 'request', `threw: ${err}`));
    }
  }));
}

const t0 = Date.now();
let failed = true;
try {
  await testServer();
  const endpoints = modules.flatMap((m) => Object.entries(allSpecs[m]!.endpoints).map(([id, d]) => [m, id, d] as const));
  await pool(endpoints, Number(values.concurrency), ([m, id, d]) => testEndpoint(m, id, d));

  const checks = [...new Set(results.map((r) => r.check))];
  const rows = checks.map((check) => {
    const rs = results.filter((r) => r.check === check);
    return { check, passed: rs.filter((r) => r.ok && !r.skipped).length, skipped: rs.filter((r) => r.skipped).length, failed: rs.filter((r) => !r.ok).length };
  });
  const endpointRows = rows.filter((r) => !results.find((x) => x.check === r.check && x.operation === 'server'));
  const serverRows = results.filter((r) => r.operation === 'server');
  console.log(`\n${endpoints.length} endpoints in ${modules.length} modules, ${results.length} HTTP checks against ${base} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  console.table(Object.fromEntries(endpointRows.map((r) => [r.check, { passed: r.passed, failed: r.failed, skipped: r.skipped }])));
  console.log('Server:');
  for (const r of serverRows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.check}${r.ok ? '' : `: ${r.detail}`}`);

  // what the right token got back (most handlers are not built yet: 501)
  const reached = results.filter((r) => r.check === 'right token' && r.ok && !r.skipped);
  const answers = new Map<string, number>();
  for (const r of reached) {
    const k = r.detail?.replace(/^→ /, '').split(' ').slice(0, 2).join(' ') ?? '?';
    answers.set(k, (answers.get(k) ?? 0) + 1);
  }
  console.log('\nWith the right token, handlers answered:', Object.fromEntries([...answers].sort((a, b) => b[1] - a[1])));

  const failures = results.filter((r) => !r.ok);
  mkdirSync('.data', { recursive: true });
  writeFileSync('.data/test-http-report.json', JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
  if (failures.length) {
    console.log(`\n✗ ${failures.length} failed (full report: .data/test-http-report.json):`);
    for (const f of failures.slice(0, 60)) console.log(`  ${f.operation} · ${f.check}: ${f.detail}`);
    if (failures.length > 60) console.log(`  … and ${failures.length - 60} more`);
  } else {
    console.log(`\n✓ all ${results.length - results.filter((r) => r.skipped).length} checks passed (report: .data/test-http-report.json)`);
  }
  failed = failures.length > 0;
} finally {
  await stop();
}
process.exit(failed ? 1 : 0);
