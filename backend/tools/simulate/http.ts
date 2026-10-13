/**
 * The simulator's HTTP client: real requests with fetch to the server's port, sent the way the apps send them.
 *
 *   - Store, Seller Center and Admin Center on the web send their Origin and keep the refresh token in the app's
 *     cookie (refreshed with the cookie, Origin and X-Requested-With); the Android app sends X-Client and keeps
 *     the refresh token itself (sent in the body). Access tokens live 15 minutes, so a session refreshes itself
 *     shortly before its token runs out, like the apps do.
 *   - Endpoints marked idempotent in the spec get a new Idempotency-Key per user action.
 *   - Every answer is checked against the spec: the status the endpoint answers on success (or the status the
 *     caller expects) and, for JSON, the response schema. A mismatch is a failed step (runner.ts).
 */
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import type { EndpointDef } from '../../src/kernel/spec/define.js';
import { allSpecs } from '../../src/kernel/module-system/loader.js';
import { urlOf } from '../../src/kernel/http/register.js';
import { signWebhook } from '../../src/kernel/http/webhooks.js';
import * as common from '../../src/spec/common.js';
import type { Runner } from './runner.js';

export type AppName = 'store' | 'seller' | 'admin';

/** A signed-in person (or a visitor) in one app */
export interface Session {
  /** Who this is, for the report: "customer ana.lopez…", "staff Sam Ruiz" */
  label: string;
  app: AppName;
  client: 'web' | 'android';
  accessToken: string;
  /** ms since epoch */
  expiresAt: number;
  /** Android keeps the refresh token; the website has it in its cookie */
  refreshToken?: string;
  cookie?: string;
  accountId?: string;
  sellerId?: string;
}

/** Who sends a request: a session, an app before sign-in (bootstrap calls), or nobody (signed storage URLs) */
export type Who = Session | { app: AppName; client: 'web' | 'android'; label?: string; accessToken?: string } | null;

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  audience: AppName;
  sellerId?: string | null;
}

export interface CallOptions {
  /** Statuses that count as success (default: the spec's status for the endpoint) */
  expect?: number | number[];
  headers?: Record<string, string>;
  /** Raw bytes instead of JSON (the browser's PUT of a file to storage) */
  raw?: { bytes: Buffer; contentType: string };
  /** Step name for the report (default: the operation id) */
  step?: string;
}

export interface Res {
  status: number;
  body: any;
  headers: Headers;
}

/* ---------------------------------------------------------------- the spec, to know what each URL should answer */

interface Route {
  module: string;
  id: string;
  def: EndpointDef;
  re: RegExp;
  params: number;
}

const routes: Route[] = Object.values(allSpecs)
  .flatMap((spec) =>
    Object.entries(spec.endpoints).map(([id, def]) => {
      const template = urlOf(spec.name, def);
      const params = (template.match(/\{/g) ?? []).length;
      const re = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '[^/]+')}$`);
      return { module: spec.name, id, def, re, params };
    }),
  )
  // literal segments win over parameters: /offers/counts before /offers/{id}
  .sort((a, b) => a.params - b.params);

export function routeOf(method: string, url: string): Route | undefined {
  const path = url.split('?')[0]!;
  return routes.find((r) => r.def.method === method && r.re.test(path));
}

/** The response schema of an endpoint as the server builds it (register.ts): paged lists wrapped in Page<…> */
function responseSchema(def: EndpointDef): z.ZodType | null {
  if (!def.response) return null;
  const item = def.response();
  return def.paging ? common.page(item) : item;
}

/* ---------------------------------------------------------------- persisted GraphQL queries (the apps send ids, not text) */

const manifests: Record<AppName, Record<string, { id: string }>> = {
  store: JSON.parse(readFileSync(new URL('../../../docs/api/graphql/operations/store/manifest.json', import.meta.url), 'utf8')),
  seller: JSON.parse(readFileSync(new URL('../../../docs/api/graphql/operations/seller/manifest.json', import.meta.url), 'utf8')),
  admin: JSON.parse(readFileSync(new URL('../../../docs/api/graphql/operations/admin/manifest.json', import.meta.url), 'utf8')),
};

/* ---------------------------------------------------------------- the client */

const ANDROID = { 'x-client': 'android/1.4.2+142', 'user-agent': 'Marketly/1.4.2 (Android 14; Pixel 8)' };
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export class Client {
  /** Requests sent, by "METHOD module.operation" (for the report) */
  readonly calls = new Map<string, number>();
  /** Things worth knowing that are not failures (for the report) */
  readonly notes: string[] = [];
  /** Modules whose audited endpoints (spec `audited`) answered successfully: the checks look for their audit entries */
  readonly auditedModules = new Set<string>();

  constructor(
    readonly base: string,
    readonly origins: Record<AppName, string>,
    private readonly runner: Runner,
    /** Waits until event consumers have run (in-process: the apps would see the effect a moment later) */
    private readonly settle: () => Promise<void>,
  ) {}

  /** Headers an app sends with every request */
  appHeaders(app: AppName, client: 'web' | 'android'): Record<string, string> {
    return client === 'android' ? { ...ANDROID } : { origin: this.origins[app], 'user-agent': BROWSER_UA, 'x-client': 'web' };
  }

  /** One request without judging the answer */
  async send(session: Who, method: string, url: string, body?: unknown, o: Pick<CallOptions, 'headers' | 'raw'> = {}): Promise<Res> {
    if (session && 'expiresAt' in session) await this.fresh(session);
    const route = routeOf(method, url);
    const h: Record<string, string> = { ...(session ? this.appHeaders(session.app, session.client) : {}) };
    if (session?.accessToken) h.authorization = `Bearer ${session.accessToken}`;
    if (route?.def.idempotent) h['idempotency-key'] = crypto.randomUUID();
    let payload: Uint8Array | string | undefined;
    if (o.raw) {
      h['content-type'] = o.raw.contentType;
      payload = new Uint8Array(o.raw.bytes);
    } else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    Object.assign(h, o.headers);
    const res = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    const key = `${method} ${route ? `${route.module}.${route.id}` : url.split('?')[0]}`;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    if (method !== 'GET') await this.settle();
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /**
   * One request whose answer must be what the spec promises: the endpoint's success status (or `expect`) and a
   * body matching its response schema. Anything else is a failed step. Returns the body.
   */
  async call(session: Who, method: string, url: string, body?: unknown, o: CallOptions = {}): Promise<any> {
    const r = await this.request(session, method, url, body, o);
    return r.body;
  }

  /** Like call, with the status and headers */
  async request(session: Who, method: string, url: string, body?: unknown, o: CallOptions = {}): Promise<Res> {
    const route = routeOf(method, url);
    const step = o.step ?? (route ? `${route.module}.${route.id}` : `${method} ${url}`);
    const r = await this.send(session, method, url, body, o);
    const expected = o.expect === undefined ? [route?.def.status ?? 200] : Array.isArray(o.expect) ? o.expect : [o.expect];
    if (!expected.includes(r.status)) {
      this.runner.fail({ step, method, url, status: r.status, expected: expected.join('|'), body: r.body, message: `${session?.label ?? 'no session'}: unexpected status` });
    }
    // the body the spec describes, for success answers (the server validates too when RESPONSE_VALIDATION is on)
    if (route && r.status === route.def.status && r.status < 300) {
      const schema = responseSchema(route.def);
      if (schema) {
        const parsed = schema.safeParse(r.body);
        if (!parsed.success) this.runner.fail({ step, method, url, status: r.status, body: parsed.error.issues.slice(0, 3), message: 'response does not match the spec' });
      }
    }
    if (route?.def.audited && r.status < 300) this.auditedModules.add(route.module);
    this.runner.pass();
    return r;
  }

  /** A screen's persisted GraphQL query, as the apps send it (Apollo's format: the manifest id, no text) */
  async graphql(session: Session, operation: string, variables: Record<string, unknown> = {}): Promise<any> {
    const id = manifests[session.app][operation]?.id;
    if (!id) this.runner.fail({ step: `graphql ${operation}`, message: `no persisted query ${operation} for ${session.app}` });
    const url = `/graphql/${session.app}`;
    const r = await this.send(session, 'POST', url, { extensions: { persistedQuery: { version: 1, sha256Hash: id } }, variables });
    const errors = (r.body?.errors ?? []) as { message: string; extensions?: { code?: string } }[];
    // By design a field the caller may not read is null with a FORBIDDEN error while the rest of the screen answers
    // (HTTP 200, docs/api/graphql/README.md "Errors"): that is a passed step, noted for the report. Anything else
    // (a validation error, an internal error, no data at all) is a failed step.
    const forbiddenOnly = r.status === 200 && r.body?.data && errors.length > 0 && errors.every((e) => e.extensions?.code === 'FORBIDDEN');
    if (forbiddenOnly) this.notes.push(`${operation} as ${session.label}: fields hidden for missing permissions (${[...new Set(errors.map((e) => (e as { message: string }).message))].join('; ')})`);
    else if (r.status !== 200 || errors.length) {
      this.runner.fail({ step: `graphql ${operation}`, method: 'POST', url, status: r.status, body: { errors: errors.slice(0, 3), data: r.body?.data ? 'partial' : null }, message: `${session.label}: query answered with errors` });
    }
    this.runner.pass();
    return r.body.data;
  }

  /**
   * A provider's webhook (card processor, carrier): the body signed with the provider's secret the way
   * kernel/http/webhooks.ts verifies it (HMAC over "<timestamp>.<raw body>").
   */
  async webhook(url: string, body: unknown, secret: string, eventId: string): Promise<any> {
    const raw = JSON.stringify(body);
    const h = { 'content-type': 'application/json', 'x-event-id': eventId, 'user-agent': 'provider-webhooks/1.0', ...signWebhook(secret, raw) };
    const res = await fetch(this.base + url, { method: 'POST', headers: h, body: raw });
    const text = await res.text();
    const route = routeOf('POST', url);
    const key = `POST ${route ? `${route.module}.${route.id}` : url}`;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    await this.settle();
    const expected = route?.def.status ?? 200;
    if (res.status !== expected) this.runner.fail({ step: key, method: 'POST', url, status: res.status, expected: String(expected), body: text.slice(0, 300), message: 'webhook refused' });
    this.runner.pass();
    return text ? JSON.parse(text) : null;
  }

  /* ---------------------------------------------------------------- sessions */

  /** A session from the tokens identity issued (and, for the website, the refresh cookie it set) */
  session(label: string, app: AppName, client: 'web' | 'android', tokens: SessionTokens, headers?: Headers, accountId?: string): Session {
    const s: Session = { label, app, client, accessToken: tokens.accessToken, expiresAt: Date.parse(tokens.accessTokenExpiresAt), accountId, sellerId: tokens.sellerId ?? undefined };
    this.keep(s, tokens, headers);
    return s;
  }

  #cookieName = (app: AppName) => `__Secure-mk_refresh_${app}`;

  private keep(s: Session, tokens: SessionTokens, headers?: Headers) {
    s.accessToken = tokens.accessToken;
    s.expiresAt = Date.parse(tokens.accessTokenExpiresAt);
    if (s.client === 'android') {
      s.refreshToken = tokens.refreshToken;
      return;
    }
    // the website never reads the refresh token: the browser keeps the cookie the response set
    const set = headers?.getSetCookie?.() ?? [];
    const mine = set.find((c) => c.startsWith(`${this.#cookieName(s.app)}=`));
    if (mine) s.cookie = decodeURIComponent(mine.split(';')[0]!.split('=').slice(1).join('='));
  }

  /** Refreshes the access token a minute before it runs out, as the apps do */
  async fresh(s: Session): Promise<void> {
    if (s.expiresAt - Date.now() > 60_000) return;
    const url = '/api/public/identity/sessions/refresh';
    const web = s.client === 'web';
    if (web && !s.cookie) return;
    const headers: Record<string, string> = web
      ? { ...this.appHeaders(s.app, 'web'), cookie: `${this.#cookieName(s.app)}=${encodeURIComponent(s.cookie!)}`, 'x-requested-with': 'fetch', 'content-type': 'application/json' }
      : { ...ANDROID, 'content-type': 'application/json' };
    const res = await fetch(this.base + url, { method: 'POST', headers, body: JSON.stringify(web ? { audience: s.app } : { refreshToken: s.refreshToken }) });
    const text = await res.text();
    this.calls.set('POST identity.refreshSession', (this.calls.get('POST identity.refreshSession') ?? 0) + 1);
    if (res.status !== 200) this.runner.fail({ step: 'identity.refreshSession', method: 'POST', url, status: res.status, body: text.slice(0, 300), message: `${s.label}: refresh refused` });
    this.runner.pass();
    this.keep(s, JSON.parse(text) as SessionTokens, res.headers);
  }
}
