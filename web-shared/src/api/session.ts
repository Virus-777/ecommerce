import { isTokenProblem, toApiError } from './errors';

export type Audience = 'store' | 'seller' | 'admin';
export type TokenKind = 'visitor' | 'customer' | 'seller' | 'staff';

/** Claims the apps read from the access token (display only: the server decides what a token may do). */
export interface TokenClaims {
  kind: TokenKind;
  sub?: string;
  sid: string;
  aud: Audience;
  exp: number;
  [k: string]: unknown;
}

/** identity.SessionTokens as returned by app-sessions, sign-in, refresh and verification. */
export interface SessionTokens {
  sessionId: string;
  audience: Audience;
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken?: string;
}

export type SessionStatus = 'idle' | 'starting' | 'ready' | 'error';

export interface SessionSnapshot {
  status: SessionStatus;
  /** Signed-in kind, or 'visitor' before sign-in; null until the session has started. */
  kind: TokenKind | null;
  claims: TokenClaims | null;
}

function decode(token: string): TokenClaims | null {
  try {
    const part = token.split('.')[1];
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as TokenClaims;
  } catch {
    return null;
  }
}

export interface SessionOptions {
  audience: Audience;
  /** API origin; '' = same origin (the dev servers proxy /api, /graphql and /files to the backend). */
  baseUrl?: string;
  /** App proof for starting a session: 'dev' in development, `turnstile:<token>` in production (docs/03 §2). */
  appProof?: () => Promise<string>;
}

const PUBLIC = '/api/public/identity';

/** A stable id for this browser's install, shared with the sign-in screens (device records, trusted devices). */
export function installationId(): string | undefined {
  try {
    const key = 'marketly.installationId';
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return undefined;
  }
}
const X_CLIENT = 'web';

/**
 * The access token of one app (store, Seller Center or Admin Center), kept in memory only.
 * The refresh token lives in the app's HttpOnly cookie (`__Secure-mk_refresh_<audience>`), so a reload
 * resumes the session by refreshing; with no session to resume it starts a visitor session.
 * Refreshes are single-flight: concurrent 401s share one refresh (docs/api/README.md, Sessions).
 */
export class Session {
  readonly audience: Audience;
  private readonly baseUrl: string;
  private readonly appProof: () => Promise<string>;
  private accessToken: string | null = null;
  private claims: TokenClaims | null = null;
  private status: SessionStatus = 'idle';
  private pending: Promise<string> | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = { status: 'idle', kind: null, claims: null };

  constructor(o: SessionOptions) {
    this.audience = o.audience;
    this.baseUrl = o.baseUrl ?? '';
    this.appProof = o.appProof ?? (async () => 'dev');
  }

  /** For useSyncExternalStore. */
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): SessionSnapshot => this.snapshot;

  private emit() {
    this.snapshot = { status: this.status, kind: this.claims?.kind ?? null, claims: this.claims };
    this.listeners.forEach((l) => l());
  }

  /** Takes tokens from sign-in, registration, verification or a refresh. */
  adopt(tokens: SessionTokens) {
    this.accessToken = tokens.accessToken;
    this.claims = decode(tokens.accessToken);
    this.status = 'ready';
    this.emit();
  }

  /** A valid access token: resumes, refreshes or starts the session as needed. */
  async token(): Promise<string> {
    if (this.accessToken && this.claims && this.claims.exp * 1000 - Date.now() > 30_000) return this.accessToken;
    return this.pending ?? (this.pending = this.resume().finally(() => (this.pending = null)));
  }

  /** Called by the API client after a 401 with a token_* reason. */
  async refresh(): Promise<string> {
    this.accessToken = null;
    return this.token();
  }

  private async resume(): Promise<string> {
    this.status = 'starting';
    this.emit();
    try {
      const refreshed = await this.post('/sessions/refresh', { audience: this.audience }, { 'X-Requested-With': 'fetch' });
      if (refreshed) {
        this.adopt(refreshed);
        return refreshed.accessToken;
      }
      const started = await this.post('/app-sessions', { audience: this.audience, device: { kind: 'web', installationId: installationId() } }, { 'X-App-Proof': await this.appProof() });
      if (!started) throw new Error('Could not start a session');
      this.adopt(started);
      return started.accessToken;
    } catch (e) {
      this.status = 'error';
      this.emit();
      throw e;
    }
  }

  /** POST to a cookie route; resolves null when the refresh token is missing or refused. */
  private async post(path: string, body: unknown, headers: Record<string, string>): Promise<SessionTokens | null> {
    const res = await fetch(`${this.baseUrl}${PUBLIC}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Client': X_CLIENT, ...headers },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as SessionTokens;
    const err = await toApiError(res);
    if (path === '/sessions/refresh' && (res.status === 401 || res.status === 423 || err.code === 'ACCOUNT_DISABLED')) return null;
    throw err;
  }

  /** Signs out of this app (clears its refresh cookie) and starts a fresh visitor session. */
  async signOut() {
    try {
      const token = this.accessToken;
      await fetch(`${this.baseUrl}${PUBLIC}/sessions/sign-out`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Client': X_CLIENT, 'X-Requested-With': 'fetch', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ audience: this.audience }),
      });
    } finally {
      this.accessToken = null;
      this.claims = null;
      this.status = 'idle';
      this.emit();
    }
  }
}

export { isTokenProblem };
