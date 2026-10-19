import { isTokenProblem, toApiError } from './errors';

export type Audience = 'store' | 'seller' | 'admin';
export type TokenKind = 'visitor' | 'customer' | 'seller' | 'staff';

/** Claims the apps read from the access token (display only: the server decides what a token may do). */
export interface TokenClaims {
  kind: TokenKind;
  sub?: string;
  sid: string;
  aud: Audience;
  /** Issued at and expiry, in seconds on the server's clock. */
  iat?: number;
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
  /**
   * Why a signed-in session ended without the person signing out, kept until they sign in again:
   * 'session_idle' (the Admin Center's staffIdleMinutes passed without a request), 'refresh_refused' (the session
   * was revoked, or the account locked or disabled), or another 401 reason. Null otherwise.
   */
  ended: string | null;
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
  private ended: string | null = null;
  /**
   * The server's clock minus this PC's clock, in ms, measured when a token is adopted (from its iat). The offline
   * LAN may have no time server: judging expiry by a PC clock running minutes fast would refresh before every call.
   */
  private skew = 0;
  private pending: Promise<string> | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = { status: 'idle', kind: null, claims: null, ended: null };

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
    this.snapshot = { status: this.status, kind: this.claims?.kind ?? null, claims: this.claims, ended: this.ended };
    this.listeners.forEach((l) => l());
  }

  /** Takes tokens from sign-in, registration, verification or a refresh. */
  adopt(tokens: SessionTokens) {
    this.accessToken = tokens.accessToken;
    this.claims = decode(tokens.accessToken);
    // The token was issued a moment ago (sign-in or refresh), so its iat is the server's "now".
    this.skew = typeof this.claims?.iat === 'number' ? this.claims.iat * 1000 - Date.now() : 0;
    // Signing in clears the "you were signed out" reason; the visitor session that follows an ending keeps it.
    if (this.claims?.kind !== 'visitor') this.ended = null;
    this.status = 'ready';
    this.emit();
  }

  /** The server's time now, as best this PC knows it. */
  private serverNow() {
    return Date.now() + this.skew;
  }

  /** A valid access token: resumes, refreshes or starts the session as needed. */
  async token(): Promise<string> {
    if (this.accessToken && this.claims && this.claims.exp * 1000 - this.serverNow() > 30_000) return this.accessToken;
    return this.pending ?? (this.pending = this.resume().finally(() => (this.pending = null)));
  }

  /** Called by the API client after a 401 with a token_* reason. */
  async refresh(): Promise<string> {
    this.accessToken = null;
    return this.token();
  }

  /**
   * Called by the API client when a request still answers 401 with a reason refreshing can't fix (session_idle,
   * sign_in_required…). Only the Admin Center ends the session on it: every request there needs the staff session,
   * so a refused one means the session is over (identity's staffIdleMinutes passed, or it was revoked). The store and
   * Seller Center keep their behaviour: a 401 there can be ordinary (seller_context_required, a page that needs sign-in).
   */
  unauthorized(reason: string) {
    if (this.audience !== 'admin' || this.claims?.kind !== 'staff') return;
    this.end(reason || 'unauthorized');
  }

  /** Forgets the signed-in session (the app shows its sign-in) and starts a visitor session in the background. */
  private end(reason: string) {
    this.accessToken = null;
    this.claims = null;
    this.ended = reason;
    this.status = 'idle';
    this.emit();
    void this.token().catch(() => {
      /* status is 'error': the app shows its start error */
    });
  }

  private async resume(): Promise<string> {
    // A signed-in session (not a visitor) whose refresh is refused has ended: the sign-in screen says so.
    const wasSignedIn = !!this.claims && this.claims.kind !== 'visitor';
    this.status = 'starting';
    this.emit();
    try {
      const refreshed = await this.post('/sessions/refresh', { audience: this.audience }, { 'X-Requested-With': 'fetch' });
      if (refreshed) {
        this.adopt(refreshed);
        return refreshed.accessToken;
      }
      if (wasSignedIn) {
        this.claims = null;
        this.ended = 'refresh_refused';
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
    // A refused refresh means "not signed in", not a broken app: no or expired cookie (401), account locked (423) or
    // disabled, or the server's Origin check (403 FORBIDDEN, reason origin_not_allowed: the app was opened by a host
    // name the server doesn't expect). The caller then starts a visitor session and the app shows its sign-in.
    if (path === '/sessions/refresh' && (res.status === 401 || res.status === 403 || res.status === 423 || err.code === 'ACCOUNT_DISABLED')) return null;
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
      this.ended = null;
      this.status = 'idle';
      this.emit();
    }
  }
}

export { isTokenProblem };
