// What every step shares: the API client, tokens, state, log, and helpers built on them.
import { createHash } from 'node:crypto';
import { poll } from './http.mjs';

export class Context {
  constructor({ api, tokens, state, log, opts }) {
    this.api = api;
    this.tokens = tokens;
    this.state = state;
    this.log = log;
    this.opts = opts;
  }

  /** Account ids of the two Business Owners (from the owners step) */
  owner(key) {
    const o = this.state.section('owners')[key];
    if (!o?.accountId) throw new Error(`owner ${key} unknown: run the owners step first`);
    return o;
  }

  /** Olivia: requests, authors, creates */
  get staff() {
    const o = this.owner('olivia');
    return this.tokens.staff(o.accountId, 'Olivia Owner');
  }

  /** Morgan: the second Business Owner, approves what Olivia asked for */
  get approver() {
    const o = this.owner('morgan');
    return this.tokens.staff(o.accountId, 'Morgan Hale');
  }

  get visitor() {
    return this.tokens.visitor('store');
  }

  customerToken(key) {
    const c = this.state.section('customers')[key];
    if (!c?.accountId) throw new Error(`customer ${key} unknown: run the customers step first`);
    return this.tokens.customer(c.accountId);
  }

  sellerToken(key) {
    const s = this.state.section('sellers')[key];
    if (!s?.sellerId || !s?.accountId) throw new Error(`seller ${key} not approved yet: run the sellers step first`);
    return this.tokens.seller(s.sellerId, s.accountId);
  }

  /** A real store visitor session (app-sessions with the dev app proof), as the website starts one */
  async storeVisitorSession() {
    const r = await this.api.req('POST', '/api/public/identity/app-sessions', { headers: { 'x-app-proof': 'dev' }, body: { audience: 'store', device: { kind: 'web', name: 'Marketly seed' } } });
    return r.body.accessToken;
  }

  /**
   * A verified member account through the dev Google sign-in (idToken "dev:<email>:<first>:<last>"). Signing in
   * again with the same email returns the same account. Waits until the customers module made the profile.
   */
  async externalAccount(email, first, last, marketingOptIn = false) {
    const v = await this.storeVisitorSession();
    const r = await this.api.post('/api/public/identity/external-sign-ins', v, { provider: 'google', idToken: `dev:${email}:${first}:${last}`, audience: 'store', device: { kind: 'web', name: 'Marketly seed' }, marketingOptIn });
    const accountId = r.account?.id;
    if (!accountId) throw new Error(`external sign-in for ${email} answered ${r.status}`);
    const token = this.tokens.customer(accountId);
    await poll(`the customer profile of ${email}`, async () => this.api.get('/api/store/customers/profile', token), { timeoutMs: 20_000, intervalMs: 500 });
    return accountId;
  }

  /**
   * The client's side of an upload: ticket → PUT the bytes → complete → wait until processed (media.process job).
   * Returns { id, url } (MediaRef fields). Reuses an earlier upload of the same bytes for the same owner key.
   */
  async upload(area, token, { purpose, fileName, contentType, body, alt }, cacheKey) {
    const media = this.state.section('media');
    const hash = createHash('sha256').update(body).digest('hex');
    const key = cacheKey ?? `${area}:${purpose}:${fileName}`;
    if (media[key]?.sha256 === hash && media[key]?.id) return media[key];
    const request = { purpose, fileName, contentType, sizeBytes: body.length, ...(alt ? { alt } : {}) };
    const ticket = await this.api.post(`/api/${area}/media/uploads`, token, area === 'admin' ? { upload: request, ownerKind: 'platform' } : request);
    const url = new URL(ticket.url);
    const local = new URL(this.api.base);
    // dev storage is the API's own content endpoint: send it to the base we were given
    const target = url.host === local.host ? ticket.url : `${this.api.base}${url.pathname}${url.search}`;
    await this.api.req(ticket.method ?? 'PUT', target, { token, raw: body, headers: { ...(ticket.headers ?? {}) }, contentType });
    await this.api.post(`/api/${area}/media/uploads/${ticket.uploadId}/complete`, token, undefined);
    const asset = await poll(
      `${fileName} to be processed (media.process job: is JOBS_ENABLED=true?)`,
      async () => {
        const r = await this.api.get(`/api/${area}/media/assets/${ticket.assetId}`, token);
        const a = r.asset ?? r;
        if (a.status === 'rejected') throw new Error(`${fileName} was rejected: ${JSON.stringify(a.checks ?? a).slice(0, 300)}`);
        return a.status === 'ready' ? r : null;
      },
      { timeoutMs: 90_000, intervalMs: 1500 },
    );
    const a = asset.asset ?? asset;
    const ref = { id: ticket.assetId, url: a.url ?? asset.url ?? a.renditions?.[0]?.url ?? null, width: a.width ?? null, height: a.height ?? null, sha256: hash };
    media[key] = ref;
    this.state.save();
    return ref;
  }

  /** MediaRef for content blocks: { id, url, alt, width, height } with a fresh URL from the admin API */
  async mediaRef(ref, alt) {
    let url = ref.url;
    if (!url) {
      const r = await this.api.get(`/api/admin/media/assets/${ref.id}`, this.staff);
      const a = r.asset ?? r;
      url = a.url ?? a.renditions?.find((x) => x.url)?.url ?? r.url;
    }
    return { id: ref.id, url, alt: alt ?? null, width: ref.width ?? null, height: ref.height ?? null };
  }
}
