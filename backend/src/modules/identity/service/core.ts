/**
 * Shared plumbing of the identity use cases: settings, signing keys, events, audit and security activity, password
 * checks and storage, access and refresh tokens, devices, opening a session and the email / SMS codes. The use
 * cases live in the feature classes (service/*.ts).
 */
import type { KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import type { Principal as KernelPrincipal } from '../../../kernel/auth/index.js';
import { tokenSigner } from '../../../kernel/auth/setup.js';
import { secretFor } from '../../../kernel/lib/secrets.js';
import { signAccessToken, type AccessClaims, type TokenKind } from '../../../kernel/auth/tokens.js';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type {
  AccountSummary,
  DeviceInfo,
  PasswordPolicy,
  ReauthRequest,
  SecurityEvent,
  SecurityWarning,
  SessionTokens,
  SignInResult,
} from '../../../spec/identity.js';
import {
  hashPassword,
  IdentityKeys,
  normalizePassCode,
  normalizeRecoveryCode,
  randomToken,
  sixDigitCode,
  tokenHash,
  verifyPassword,
} from '../domain/crypto.js';
import { passwordPolicy, passwordProblems, type Realm } from '../domain/policy.js';
import { deviceLabel, type SecurityKind } from '../domain/text.js';
import * as map from '../mappers.js';
import type {
  AccountRow,
  Audience,
  ChallengeRow,
  DeviceRow,
  ExternalIdentityVerifier,
  GuestSessionRow,
  SecurityEventRow,
  SellerAccessRow,
  SessionRow,
} from '../ports.js';
import type { IdentityRepository } from '../repository.js';

export interface IdentityServiceDeps {
  repo: IdentityRepository;
  ctx: ModuleContext<'identity'>;
  /** Google / Apple ID-token verification (phase 2); absent = not configured */
  externalIds?: ExternalIdentityVerifier;
}

/** Where a request came from (for devices, security activity and sign-in attempts) */
export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

/** Who is asking, as the HTTP layer knows it */
export interface Caller {
  principal: KernelPrincipal | null;
  actor: common.Actor;
  requestId?: string;
  client: ClientInfo;
}

/** A result plus what to do with the website's refresh cookie (the http layer sets it) */
export interface WithCookie<T> {
  result: T;
  /** set: the cookie of the session's app (`audience`); clear: the cookie the request used */
  cookie?: { audience: Audience; token: string; maxAgeSeconds: number } | 'clear';
}

/** Account security for the staff customer 360 (GraphQL AccountSecurity) */
export interface AccountSecurity {
  accountId: string;
  status: string;
  email: string;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  pendingEmailChange: string | null;
  signInSummary: string;
  createdAt: string;
  lastSignInAt: string | null;
  lastActiveAt: string | null;
  passwordChangedAt: string | null;
  mustResetPassword: boolean;
  lockedUntil: string | null;
  lockReason: string | null;
  failedSignInsInWindow: number;
  twoStep: { enabled: boolean; required: boolean; methods: { id: string; method: string; label: string; addedAt: string; lastUsedAt: string | null }[]; recoveryCodesRemaining: number };
  devices: { id: string; kind: string; label: string; location: string | null; audiences: string[]; firstSeenAt: string; lastActiveAt: string; twoStepTrustedUntil: string | null }[];
  warnings: SecurityWarning[];
  /** GraphQL field with a `limit` argument (the default resolver calls it) */
  recentActivity: (args?: { limit?: number }) => (Omit<SecurityEvent, 'result'> & { result: string })[];
}

export const KIND_OF: Record<Audience, Exclude<TokenKind, 'visitor'>> = { store: 'customer', seller: 'seller', admin: 'staff' };
export const MIN = 60_000;
const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const BATCH = 500;
/** Revocations fetched again on every poll, for writes that committed after the previous poll started */
export const REVOCATION_OVERLAP_MS = 10_000;
export const UNVERIFIED_ACCOUNT_DAYS = 7;
export const RECOVERY_CODES = 10;
/** The reauth step-up purposes the spec declares (ReauthRequest.purpose); the body schema already enforces them */
const REAUTH_PURPOSES: Record<ReauthRequest['purpose'], true> = {
  'account-closure': true,
  'email-change': true,
  'two-step-removal': true,
  'recovery-codes': true,
  'business-change': true,
  'payout-account': true,
  'seller-closure': true,
  // staff confirm these with their password (they have no 2-step)
  'role-grant': true,
  'staff-account': true,
  'payout-destination': true,
  approval: true,
};
export const isReauthPurpose = (v: unknown): v is ReauthRequest['purpose'] => typeof v === 'string' && Object.hasOwn(REAUTH_PURPOSES, v);

export const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
const truncSecond = (d: Date) => new Date(seconds(d) * 1000);
/** The name carried in access tokens: trimmed and capped, so every token stays small */
const TOKEN_NAME_MAX = 80;
export const tokenName = (displayName: string | null | undefined) => [...(displayName ?? '').trim()].slice(0, TOKEN_NAME_MAX).join('');
export const audienceOk = (v: unknown): v is Audience => v === 'store' || v === 'seller' || v === 'admin';
export const issue = (path: string, message: string) => ({ issues: [{ path, message }] });

/** Client details from a request (IP for activity and limits; User-Agent for device labels) */
export function clientInfo(request: { ip?: string; headers: Record<string, unknown> }): ClientInfo {
  const ip = request.ip && isIP(request.ip) ? request.ip : null;
  const ua = request.headers['user-agent'];
  return { ip, userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null };
}

export class Core {
  #signer?: { kid: string; key: KeyObject };
  #keys?: IdentityKeys;
  #dummyHash?: Promise<string>;

  constructor(readonly deps: IdentityServiceDeps) {}

  get repo() {
    return this.deps.repo;
  }

  get ctx() {
    return this.deps.ctx;
  }

  now() {
    return this.ctx.clock.now();
  }

  get signer() {
    this.#signer ??= tokenSigner(this.ctx.config);
    return this.#signer;
  }

  get keys() {
    this.#keys ??= new IdentityKeys(secretFor(this.ctx.config, 'identity.data'));
    return this.#keys;
  }

  /** Website pages the emailed links open (STORE_URL, SELLER_URL, ADMIN_URL); the one-time token travels in the fragment, never to a server. */
  appUrl(app: Audience): string {
    return this.ctx.config.publicUrls[app];
  }

  /** Every setting this module reads, in force now (read before a transaction opens). */
  async cfg() {
    const g = this.ctx.settings.get;
    const [
      accessTokenTtlMinutes,
      refreshTtlHours,
      keepSignedInDays,
      staffSessionMaxHours,
      maxFailedSignIns,
      lockoutMinutes,
      verificationCodeTtlMinutes,
      codeResendSeconds,
      maxCodeAttempts,
      passwordResetTtlMinutes,
      memberMinPasswordLength,
      staffMinPasswordLength,
      passwordHistoryCount,
      trustedDeviceDays,
      invitationTtlDays,
      guestSessionTtlDays,
      maxDevicesPerAccount,
      securityEventRetentionDays,
      reauthTokenMinutes,
      guestOrderAccessDays,
      orderLinkTtlDays,
      staffIdleMinutes,
      maxStaffSessions,
      refreshReuseGraceSeconds,
      visitorRefreshDays,
    ] = await Promise.all([
      g('accessTokenTtlMinutes'),
      g('refreshTtlHours'),
      g('keepSignedInDays'),
      g('staffSessionMaxHours'),
      g('maxFailedSignIns'),
      g('lockoutMinutes'),
      g('verificationCodeTtlMinutes'),
      g('codeResendSeconds'),
      g('maxCodeAttempts'),
      g('passwordResetTtlMinutes'),
      g('memberMinPasswordLength'),
      g('staffMinPasswordLength'),
      g('passwordHistoryCount'),
      g('trustedDeviceDays'),
      g('invitationTtlDays'),
      g('guestSessionTtlDays'),
      g('maxDevicesPerAccount'),
      g('securityEventRetentionDays'),
      g('reauthTokenMinutes'),
      g('guestOrderAccessDays'),
      g('orderLinkTtlDays'),
      g('staffIdleMinutes'),
      g('maxStaffSessions'),
      g('refreshReuseGraceSeconds'),
      g('visitorRefreshDays'),
    ]);
    return {
      accessTokenTtlMinutes,
      refreshTtlHours,
      keepSignedInDays,
      staffSessionMaxHours,
      maxFailedSignIns,
      lockoutMinutes,
      verificationCodeTtlMinutes,
      codeResendSeconds,
      maxCodeAttempts,
      passwordResetTtlMinutes,
      memberMinPasswordLength,
      staffMinPasswordLength,
      passwordHistoryCount,
      trustedDeviceDays,
      invitationTtlDays,
      guestSessionTtlDays,
      maxDevicesPerAccount,
      securityEventRetentionDays,
      reauthTokenMinutes,
      guestOrderAccessDays,
      orderLinkTtlDays,
      staffIdleMinutes,
      maxStaffSessions,
      refreshReuseGraceSeconds,
      visitorRefreshDays,
    };
  }

  publish<N extends Parameters<ModuleContext<'identity'>['events']['publish']>[0]>(name: N, payload: EventPayload<N>, by?: { actor?: common.Actor; requestId?: string }) {
    this.ctx.events.publish(name, payload as never, { actor: by?.actor, requestId: by?.requestId });
  }

  /** Material staff actions also go to audit (optional dependency; security_events always has them). */
  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: { actor: common.Actor; requestId?: string; client?: ClientInfo }) {
    await this.ctx.tryUse('audit')?.record({ category: 'security', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null, ip: by.client?.ip ?? null });
  }

  async securityEvent(
    repo: IdentityRepository,
    accountId: string,
    kind: SecurityKind,
    result: 'completed' | 'failed' | 'blocked',
    o: { audience?: Audience | null; device?: Pick<DeviceRow, 'id' | 'label'> | null; client?: ClientInfo; actor?: common.Actor | null; reason?: string | null; detail?: Record<string, unknown> } = {},
  ) {
    const row: SecurityEventRow = {
      id: newId(),
      account_id: accountId,
      kind,
      result,
      audience: o.audience ?? null,
      device_id: o.device?.id ?? null,
      device_label: o.device?.label ?? (o.client ? deviceLabel({ kind: 'web' }, o.client.userAgent) : null),
      ip: o.client?.ip ?? null,
      location: null,
      actor_kind: o.actor?.kind ?? null,
      actor_id: o.actor?.id ?? null,
      reason: o.reason ?? null,
      detail: (o.detail ?? {}) as never,
      at: this.now(),
    };
    await repo.insertSecurityEvent(row);
  }

  dummyHash() {
    this.#dummyHash ??= hashPassword('not-a-real-password-for-timing');
    return this.#dummyHash;
  }

  /** Same scrypt work whether or not the account (or its password) exists */
  async checkPassword(account: AccountRow | undefined, password: string) {
    return verifyPassword(account?.password_hash ?? (await this.dummyHash()), password).then((ok) => ok && Boolean(account?.password_hash));
  }

  codeHash(challengeId: string, code: string) {
    return this.keys.hmac('codes', `${challengeId}:${code.trim()}`);
  }

  recoveryHash(accountId: string, code: string) {
    return this.keys.hmac('recovery-codes', `${accountId}:${normalizeRecoveryCode(code)}`);
  }

  /** A staff invitation's pass code, keyed with the server's secret and bound to the invitation */
  passCodeHash(invitationId: string, code: string) {
    return this.keys.hmac('invitation-pass-codes', `${invitationId}:${normalizePassCode(code)}`);
  }

  async methodsOf(accountId: string) {
    return this.repo.activeMethods([accountId]);
  }

  async summaryOf(a: AccountRow, repo: IdentityRepository = this.repo): Promise<AccountSummary> {
    const methods = await repo.activeMethods([a.id]);
    return map.accountSummary(a, methods.length > 0, this.now());
  }

  /** The signed-in account behind a principal (404 when it isn't known here) */
  async accountOf(principal: KernelPrincipal | null | undefined): Promise<AccountRow> {
    const id = principal?.accountId;
    const a = id && isUuid(id) ? await this.repo.getAccount(id) : undefined;
    if (!a) throw new AppError('NOT_FOUND', 'Account not found');
    return a;
  }

  policyFor(realm: Realm, s: { memberMinPasswordLength: number; staffMinPasswordLength: number }): PasswordPolicy {
    return passwordPolicy(realm, s);
  }

  assertStrong(password: string, realm: Realm, personal: (string | null | undefined)[], s: Awaited<ReturnType<Core['cfg']>>) {
    const failed = passwordProblems(password, this.policyFor(realm, s), personal);
    if (failed.length) throw new AppError('WEAK_PASSWORD', 'Choose a stronger password', { failed });
  }

  async assertNotReused(accountId: string, password: string, n: number) {
    const recent = await this.repo.recentPasswordHashes(accountId, n);
    for (const h of recent) if (await verifyPassword(h, password)) throw new AppError('PASSWORD_REUSED', 'Choose a password you have not used recently');
  }

  /** Sets a new password and keeps it in the history */
  async storePassword(repo: IdentityRepository, accountId: string, hash: string, now: Date, patch: Partial<AccountRow> = {}) {
    await repo.addPasswordHistory({ id: newId(), account_id: accountId, password_hash: hash, created_at: now });
    return repo.updateAccount(accountId, { password_hash: hash, password_changed_at: now, ...patch });
  }

  /** Revokes sessions; account-wide revocations also refuse every token issued before now. */
  async revoke(repo: IdentityRepository, sel: Parameters<IdentityRepository['revokeSessions']>[0], reason: string, now: Date, accountWide = false) {
    const ids = await repo.revokeSessions(sel, reason, now);
    if (accountWide) await repo.updateAccount(sel.accountId, { tokens_valid_after: truncSecond(now) });
    return ids;
  }

  signAccess(claims: Omit<AccessClaims, 'iat' | 'exp' | 'jti' | 'iss'>, ttlMinutes: number) {
    const now = this.now();
    const token = signAccessToken(this.signer, claims, { issuer: this.ctx.config.auth.issuer, ttlSeconds: ttlMinutes * 60, now });
    return { token, expiresAt: new Date((seconds(now) + ttlMinutes * 60) * 1000) };
  }

  /** `account` gives the name recorded with what the person does (actors); a name change shows after the next refresh. */
  sessionTokens(session: SessionRow, account: Pick<AccountRow, 'display_name'>, refreshToken: string, s: { accessTokenTtlMinutes: number }): SessionTokens {
    const name = tokenName(account.display_name);
    const access = this.signAccess(
      {
        aud: session.audience,
        kind: KIND_OF[session.audience],
        sub: session.account_id,
        sid: session.id,
        ...(name ? { name } : {}),
        ...(session.seller_id ? { sellerId: session.seller_id } : {}),
        ...(session.seller_member_id ? { memberId: session.seller_member_id } : {}),
        authAt: seconds(session.created_at),
        ...(session.two_step_verified_at ? { twoStepAt: seconds(session.two_step_verified_at) } : {}),
      },
      s.accessTokenTtlMinutes,
    );
    return {
      sessionId: session.id,
      audience: session.audience,
      accessToken: access.token,
      accessTokenExpiresAt: map.iso(access.expiresAt),
      refreshToken,
      refreshTokenExpiresAt: map.iso(session.expires_at < session.absolute_expires_at ? session.expires_at : session.absolute_expires_at),
      sellerId: session.seller_id,
    };
  }

  visitorTokens(g: GuestSessionRow, refreshToken: string, s: { accessTokenTtlMinutes: number }): SessionTokens {
    const access = this.signAccess({ aud: g.audience, kind: 'visitor', sid: g.id }, s.accessTokenTtlMinutes);
    return {
      sessionId: g.id,
      audience: g.audience,
      accessToken: access.token,
      accessTokenExpiresAt: map.iso(access.expiresAt),
      refreshToken,
      refreshTokenExpiresAt: map.iso(g.expires_at),
      sellerId: null,
    };
  }

  /** Website clients keep the refresh token in the HttpOnly cookie, never in the body (docs/03 §5). */
  deliver<T extends { tokens?: SessionTokens | null }>(result: T, web: boolean, now: Date): WithCookie<T> {
    const t = result.tokens;
    if (!t || !web) return { result };
    const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(t.refreshTokenExpiresAt) - now.getTime()) / 1000));
    return { result: { ...result, tokens: { ...t, refreshToken: '' } }, cookie: { audience: t.audience, token: t.refreshToken, maxAgeSeconds } };
  }

  /** Finds or records the device a sign-in comes from */
  async deviceFor(repo: IdentityRepository, accountId: string, info: DeviceInfo, client: ClientInfo, now: Date) {
    const label = deviceLabel(info, client.userAgent);
    const installationId = info.installationId?.trim() || null;
    const existing = installationId
      ? await repo.findDeviceByInstallation(accountId, installationId)
      : info.kind === 'web'
        ? await repo.findWebDevice(accountId, client.userAgent)
        : undefined;
    if (existing) {
      const patch = { label, user_agent: client.userAgent, app_version: info.appVersion ?? null, last_ip: client.ip, last_active_at: now };
      await repo.updateDevice(existing.id, patch);
      return { device: { ...existing, ...patch }, isNew: false, first: false, matchedByInstallation: Boolean(installationId) };
    }
    const first = (await repo.countDevices(accountId)) === 0;
    const device: DeviceRow = {
      id: newId(),
      account_id: accountId,
      kind: info.kind,
      label,
      installation_id: installationId,
      user_agent: client.userAgent,
      app_version: info.appVersion ?? null,
      last_ip: client.ip,
      last_location: null,
      two_step_trusted_until: null,
      first_seen_at: now,
      last_active_at: now,
    };
    await repo.insertDevice(device);
    return { device, isNew: true, first, matchedByInstallation: Boolean(installationId) };
  }

  /** Whether this member device may skip 2-step (only a device recognised by its installation id) */
  async trustedDevice(repo: IdentityRepository, accountId: string, info: DeviceInfo, now: Date) {
    const iid = info.installationId?.trim();
    if (!iid) return false;
    const d = await repo.findDeviceByInstallation(accountId, iid);
    return Boolean(d?.two_step_trusted_until && d.two_step_trusted_until > now);
  }

  /** A visitor session ends when the person signs in or registers with it (docs/03 §8). */
  async claimVisitorSession(repo: IdentityRepository, visitorSessionId: string | null | undefined, accountId: string, now: Date): Promise<string | null> {
    if (!visitorSessionId || !isUuid(visitorSessionId)) return null;
    const g = await repo.getGuestSession(visitorSessionId, { forUpdate: true });
    if (!g || g.claimed_by_account_id || g.expires_at <= now) return null;
    await repo.updateGuestSession(g.id, { claimed_by_account_id: accountId, claimed_at: now, expires_at: now });
    return g.audience === 'store' ? g.id : null;
  }

  /**
   * Opens a session for an account: device, session row, limits (devices, staff sessions),
   * visitor session claim, security activity. Runs inside the caller's transaction.
   */
  async openSession(
    repo: IdentityRepository,
    account: AccountRow,
    o: {
      audience: Audience;
      device: DeviceInfo;
      client: ClientInfo;
      keepSignedIn: boolean;
      twoStepVerified: boolean;
      seller?: SellerAccessRow | null;
      visitorSessionId?: string | null;
      method?: 'password' | 'two_step' | 'code' | 'invitation';
    },
    s: Awaited<ReturnType<Core['cfg']>>,
    now: Date,
  ) {
    const { device, isNew, first } = await this.deviceFor(repo, account.id, o.device, o.client, now);
    const staff = account.realm === 'staff';
    const refreshMs = staff ? Math.min(s.refreshTtlHours, s.staffSessionMaxHours) * HOUR : o.keepSignedIn ? s.keepSignedInDays * DAY : s.refreshTtlHours * HOUR;
    const expires = new Date(now.getTime() + refreshMs);
    const refreshToken = randomToken('s.');
    const session: SessionRow = {
      id: newId(),
      account_id: account.id,
      device_id: device.id,
      audience: o.audience,
      seller_id: o.seller?.seller_id ?? null,
      seller_member_id: o.seller?.seller_member_id ?? null,
      refresh_token_hash: tokenHash(refreshToken),
      previous_token_hash: null,
      keep_signed_in: !staff && o.keepSignedIn,
      two_step_verified_at: o.twoStepVerified ? now : null,
      created_at: now,
      last_refreshed_at: now,
      last_active_at: now,
      expires_at: expires,
      absolute_expires_at: staff ? new Date(now.getTime() + s.staffSessionMaxHours * HOUR) : expires,
      revoked_at: null,
      revoke_reason: null,
    };
    await repo.insertSession(session);
    if (o.seller) await repo.updateSellerAccess(account.id, o.seller.seller_id, { last_used_at: now });

    // limits: oldest sessions are signed out beyond the device cap (and the staff cap)
    const liveAll = await repo.liveSessions(account.id, now);
    const over = liveAll.filter((x) => x.id !== session.id).slice(0, Math.max(0, liveAll.length - s.maxDevicesPerAccount));
    let overStaff: SessionRow[] = [];
    if (o.audience === 'admin') {
      const admin = liveAll.filter((x) => x.audience === 'admin' && x.id !== session.id && !over.includes(x));
      overStaff = admin.slice(0, Math.max(0, admin.length + 1 - s.maxStaffSessions));
    }
    const doomed = [...over, ...overStaff].map((x) => x.id);
    if (doomed.length) await repo.revokeSessions({ accountId: account.id, sessionIds: doomed }, 'session_limit', now);

    const patch: Partial<AccountRow> = { last_sign_in_at: now, last_active_at: now, failed_sign_ins: 0, failed_window_started_at: null };
    await repo.updateAccount(account.id, patch);
    const claimed = await this.claimVisitorSession(repo, o.visitorSessionId, account.id, now);
    await this.securityEvent(repo, account.id, isNew && !first ? 'signed_in_new_device' : 'signed_in', 'completed', {
      audience: o.audience,
      device,
      client: o.client,
      detail: { method: o.method ?? 'password', ...(o.seller ? { sellerName: o.seller.seller_name } : {}) },
    });
    return {
      session,
      refreshToken,
      device,
      claimed,
      after: () => {
        if (isNew && !first) this.publish('identity.session.new_device', { accountId: account.id, realm: account.realm, deviceLabel: device.label, location: null, at: map.iso(now) });
        if (claimed) this.publish('identity.guest_session.claimed', { guestSessionId: claimed, accountId: account.id });
      },
    };
  }

  /** Forced reset: a reset link handed to the person signing in (continue at the set-new-password step) */
  async forcedResetToken(repo: IdentityRepository, account: AccountRow, client: ClientInfo, s: { passwordResetTtlMinutes: number }, now: Date) {
    const prior = await repo.latestReset(account.id);
    await repo.invalidateResets(account.id, now);
    const token = randomToken();
    await repo.insertReset({
      id: newId(),
      account_id: account.id,
      token_hash: tokenHash(token),
      forced_by: prior?.forced_by ?? 'staff',
      forced_reason: prior?.forced_reason ?? null,
      expires_at: new Date(now.getTime() + s.passwordResetTtlMinutes * MIN),
      used_at: null,
      requested_ip: client.ip,
      created_at: now,
    });
    return token;
  }

  /**
   * The last step of every sign-in (password, 2-step, invitation): forced reset, seller context,
   * then the session. Runs inside a transaction; `after` publishes once it committed.
   */
  async completeSignIn(
    repo: IdentityRepository,
    account: AccountRow,
    o: {
      audience: Audience;
      device: DeviceInfo;
      client: ClientInfo;
      keepSignedIn: boolean;
      twoStepVerified: boolean;
      sellerId?: string | null;
      visitorSessionId?: string | null;
      method: 'password' | 'two_step' | 'code' | 'invitation';
    },
    s: Awaited<ReturnType<Core['cfg']>>,
    now: Date,
  ): Promise<{ result: SignInResult; after: () => void }> {
    const summary = await this.summaryOf(account, repo);
    if (account.must_reset_password) {
      const token = await this.forcedResetToken(repo, account, o.client, s, now);
      return { result: { status: 'password_reset_required', account: summary, sellerContexts: [], passwordResetToken: token, tokens: null, challenge: null }, after: () => {} };
    }
    let seller: SellerAccessRow | null = null;
    let contexts: SellerAccessRow[] = [];
    if (o.audience === 'seller') {
      contexts = await repo.activeSellerAccess(account.id);
      if (!contexts.length) throw new AppError('NO_SELLER_ACCESS', 'This account does not act for any seller yet');
      seller = contexts.length === 1 ? contexts[0]! : (contexts.find((c) => c.seller_id === o.sellerId) ?? null);
    }
    const opened = await this.openSession(repo, account, { ...o, seller }, s, now);
    const tokens = this.sessionTokens(opened.session, account, opened.refreshToken, s);
    return {
      result: {
        status: o.audience === 'seller' && !seller ? 'seller_context_required' : 'signed_in',
        tokens,
        account: { ...summary, lastActiveAt: map.iso(now) },
        challenge: null,
        sellerContexts: contexts.map(map.sellerContext),
        passwordResetToken: null,
      },
      after: opened.after,
    };
  }

  async newEmailCode(
    repo: IdentityRepository,
    o: { accountId: string | null; purpose: 'email_verification' | 'email_change'; email: string; payload?: Record<string, unknown> },
    s: Awaited<ReturnType<Core['cfg']>>,
    now: Date,
  ) {
    const id = newId();
    const code = sixDigitCode();
    const row: ChallengeRow = {
      id,
      account_id: o.accountId,
      purpose: o.purpose,
      target_email: o.email,
      code_hash: this.codeHash(id, code),
      payload: (o.payload ?? {}) as never,
      attempts: 0,
      max_attempts: s.maxCodeAttempts,
      status: 'pending',
      expires_at: new Date(now.getTime() + s.verificationCodeTtlMinutes * MIN),
      resend_available_at: new Date(now.getTime() + s.codeResendSeconds * 1000),
      created_at: now,
      completed_at: null,
      target_phone_encrypted: null,
    };
    await repo.insertChallenge(row);
    return { row, code };
  }

  codeIssued(c: ChallengeRow, code: string, channel: 'email' | 'sms', to: string) {
    const payload = (c.payload ?? {}) as Record<string, unknown>;
    this.publish('identity.verification.code_issued', {
      challengeId: c.id,
      accountId: c.account_id,
      purpose: c.purpose === 'two_step_setup' ? 'phone_verification' : (c.purpose as 'email_verification' | 'email_change' | 'phone_verification' | 'sign_in_second_factor'),
      channel,
      to,
      code,
      existingAccount: payload.existingAccount === true,
      expiresAt: map.iso(c.expires_at),
    });
  }

  /** Loads a challenge for a code check: NOT_FOUND / CHALLENGE_LOCKED / CODE_EXPIRED as the spec says */
  openChallenge(c: ChallengeRow | undefined, purposes: ChallengeRow['purpose'][], now: Date): ChallengeRow {
    if (!c || !purposes.includes(c.purpose)) throw new AppError('NOT_FOUND', 'Code request not found');
    if (c.status === 'locked') throw new AppError('CHALLENGE_LOCKED', 'Too many wrong codes; start again');
    if (c.status !== 'pending' || c.expires_at <= now) throw new AppError('CODE_EXPIRED', 'This code has expired; request a new one');
    return c;
  }

  /** A wrong code: counts it and returns the error to throw after the transaction */
  async wrongCode(repo: IdentityRepository, c: ChallengeRow): Promise<AppError> {
    const attempts = c.attempts + 1;
    const locked = attempts >= c.max_attempts;
    await repo.updateChallenge(c.id, { attempts, ...(locked ? { status: 'locked' } : {}) });
    return locked
      ? new AppError('CHALLENGE_LOCKED', 'Too many wrong codes; start again', { attemptsLeft: 0 })
      : new AppError('CODE_INVALID', 'That code is not right', { attemptsLeft: c.max_attempts - attempts });
  }
}
