// HTTP client for the seed: JSON in/out, retries on network errors, 5xx and 429, Idempotency-Key on demand,
// typed errors with the API's error envelope, and polling helpers for asynchronous effects.
import { randomUUID } from 'node:crypto';
import { signWebhook } from './codes.mjs';

export class ApiError extends Error {
  constructor(method, path, status, body, requestId) {
    const code = body?.error?.code ?? `HTTP_${status}`;
    const msg = body?.error?.message ?? (typeof body === 'string' ? body.slice(0, 200) : '');
    const issues = body?.error?.details?.issues ? ` ${JSON.stringify(body.error.details.issues).slice(0, 600)}` : '';
    super(`${method} ${path} → ${status} ${code}: ${msg}${issues}${requestId ? ` (request ${requestId})` : ''}`);
    this.status = status;
    this.code = code;
    this.details = body?.error?.details;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Api {
  constructor(base, log) {
    this.base = base.replace(/\/$/, '');
    this.log = log;
    this.calls = 0;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ token?: string, body?: unknown, idem?: boolean | string, headers?: Record<string,string>, raw?: Buffer, contentType?: string, retries?: number, ok?: number[] }} o
   */
  async req(method, path, o = {}) {
    const headers = { 'x-client': 'web', ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.idem) headers['idempotency-key'] = typeof o.idem === 'string' ? o.idem : randomUUID();
    let payload;
    if (o.raw) {
      payload = o.raw;
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = o.contentType ?? 'application/octet-stream';
    } else if (o.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(o.body);
    }
    const url = path.startsWith('http') ? path : this.base + path;
    const retries = o.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      let res;
      const started = Date.now();
      try {
        this.calls++;
        res = await fetch(url, { method, headers, body: payload });
        if (process.env.SEED_DEBUG) console.log(`      ${method} ${path.split('?')[0]} → ${res.status} ${Date.now() - started} ms`);
      } catch (err) {
        if (attempt >= retries) throw new Error(`${method} ${path}: ${err.cause?.code ?? err.message} (is the backend running at ${this.base}?)`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (res.ok || o.ok?.includes(res.status)) return { status: res.status, body, headers: res.headers };
      const retryable = res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504 || (res.status === 409 && body?.error?.code === 'CONFLICT');
      if (retryable && attempt < retries) {
        const after = Number(res.headers.get('retry-after')) || attempt + 1;
        await sleep(Math.min(after, 10) * 1000);
        continue;
      }
      throw new ApiError(method, path, res.status, body, res.headers.get('x-request-id'));
    }
  }

  async get(path, token, o = {}) {
    return (await this.req('GET', path, { ...o, token })).body;
  }
  async post(path, token, body, o = {}) {
    return (await this.req('POST', path, { ...o, token, body: body ?? {} })).body;
  }
  async put(path, token, body, o = {}) {
    return (await this.req('PUT', path, { ...o, token, body })).body;
  }
  async patch(path, token, body, o = {}) {
    return (await this.req('PATCH', path, { ...o, token, body })).body;
  }
  async del(path, token, o = {}) {
    return (await this.req('DELETE', path, { ...o, token })).body;
  }

  /** A signed provider webhook (carrier events…) */
  async webhook(path, payload, eventId) {
    const raw = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json', ...signWebhook(raw), ...(eventId ? { 'x-event-id': eventId } : {}) };
    const started = Date.now();
    const res = await fetch(this.base + path, { method: 'POST', headers, body: raw });
    const text = await res.text();
    this.calls++;
    if (process.env.SEED_DEBUG) console.log(`      POST ${path} (${payload.code ?? ''}) → ${res.status} ${Date.now() - started} ms`);
    if (!res.ok) throw new ApiError('POST', path, res.status, (() => { try { return JSON.parse(text); } catch { return text; } })(), res.headers.get('x-request-id'));
    return text ? JSON.parse(text) : null;
  }

  /** Every item of a paged list (page=1..n) */
  async all(path, token, limit = 100) {
    const out = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 50; page++) {
      const r = await this.get(`${path}${sep}page=${page}&limit=${limit}`, token);
      const items = Array.isArray(r) ? r : (r?.items ?? []);
      out.push(...items);
      if (Array.isArray(r) || !r?.totalPages || page >= r.totalPages || items.length < limit) break;
    }
    return out;
  }
}

/** Polls `fn` until it returns a truthy value or the time runs out (returns the last value, or throws) */
export async function poll(what, fn, { timeoutMs = 30_000, intervalMs = 1000, quiet = false } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  let lastErr;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  if (quiet) return last;
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ''}`);
}

export { sleep };
