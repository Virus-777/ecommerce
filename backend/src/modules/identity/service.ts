import type { KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import type { Principal as KernelPrincipal } from '../../kernel/auth/index.js';
import { tokenSigner } from '../../kernel/auth/setup.js';
import { secretFor } from '../../kernel/lib/secrets.js';
import { signAccessToken, type AccessClaims, type TokenKind } from '../../kernel/auth/tokens.js';
import { AppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { zonedTimeToUtc } from '../../kernel/lib/clock.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as audit from '../../spec/audit.js';
import type * as common from '../../spec/common.js';
import type {
  AcceptInvitationRequest,
  AcceptInvitationResult,
  AccountAdmin,
  AccountListItem,
  AccountSummary,
  ChangePasswordRequest,
  CompleteResetRequest,
  Device,
  DeviceInfo,
  GuestSession,
  IdentityPublicApi,
  Invitation,
  InvitationView,
  LockRequest,
  OrderLinkRedemption,
  PasswordPolicy,
  PasswordResetStatus,
  Principal,
  ReauthRequest,
  ReauthToken,
  RecoveryCodes,
  RegistrationRequest,
  SecondFactorRequest,
  SecurityEvent,
  SecurityOverview,
  SecurityWarning,
  SellerContext,
  SessionTokens,
  SignInChallenge,
  SignInRequest,
  SignInResult,
  TwoStepSetup,
  TwoStepSetupRequest,
  TwoStepStatus,
  VerificationChallenge,
  VerifyCodeRequest,
  VerifyResult,
} from '../../spec/identity.js';
import {
  base32Encode,
  groupKey,
  hashPassword,
  IdentityKeys,
  needsRehash,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  randomToken,
  safeEqual,
  sixDigitCode,
  tokenHash,
  verifyPassword,
  verifyTotp,
} from './domain/crypto.js';
import { failuresInWindow, lockInForce, normalizeEmail, passwordPolicy, passwordProblems, registerFailure, type Realm } from './domain/policy.js';
import { accountStatusMachine, invitationMachine } from './domain/state-machines.js';
import { deviceLabel, isE164, maskEmail, maskPhone, type SecurityKind } from './domain/text.js';
import * as map from './mappers.js';
import type {
  AccountRow,
  Audience,
  ChallengeRow,
  DeviceRow,
  DeviceWithSessions,
  ExternalIdentityVerifier,
  GuestSessionRow,
  IdentityRepository,
  InvitationRow,
  SecurityEventRow,
  SellerAccessRow,
  SessionRow,
  TwoStepMethodRow,
} from './ports.js';

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
  cookie?: { token: string; maxAgeSeconds: number } | 'clear';
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


const KIND_OF: Record<Audience, Exclude<TokenKind, 'visitor'>> = { store: 'customer', seller: 'seller', admin: 'staff' };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BATCH = 500;
/** Revocations fetched again on every poll, for writes that committed after the previous poll started */
const REVOCATION_OVERLAP_MS = 10_000;
const UNVERIFIED_ACCOUNT_DAYS = 7;
const RECOVERY_CODES = 10;
/** The reauth step-up purposes the spec declares (ReauthRequest.purpose); the body schema already enforces them */
const REAUTH_PURPOSES: Record<ReauthRequest['purpose'], true> = {
  'account-closure': true,
  'email-change': true,
  'two-step-removal': true,
  'recovery-codes': true,
  'business-change': true,
  'payout-account': true,
  'seller-closure': true,
};
const isReauthPurpose = (v: unknown): v is ReauthRequest['purpose'] => typeof v === 'string' && Object.hasOwn(REAUTH_PURPOSES, v);

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
const truncSecond = (d: Date) => new Date(seconds(d) * 1000);
const audienceOk = (v: unknown): v is Audience => v === 'store' || v === 'seller' || v === 'admin';
const issue = (path: string, message: string) => ({ issues: [{ path, message }] });

/**
 * Identity use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to an endpoint, a publicApi function, a consumed event or a job in
 * docs/api/spec/modules/identity.json.
 */
export class IdentityService implements IdentityPublicApi {
  #signer?: { kid: string; key: KeyObject };
  #keys?: IdentityKeys;
  #dummyHash?: Promise<string>;

  constructor(protected readonly deps: IdentityServiceDeps) {}

  /* ================================================================ plumbing */

  private get repo() {
    return this.deps.repo;
  }
  private get ctx() {
    return this.deps.ctx;
  }
  private now() {
    return this.ctx.clock.now();
  }
  private get signer() {
    this.#signer ??= tokenSigner(this.ctx.config);
    return this.#signer;
  }
  private get keys() {
    this.#keys ??= new IdentityKeys(secretFor(this.ctx.config, 'identity.data'));
    return this.#keys;
  }

  /** Website pages the emailed links open (STORE_URL, SELLER_URL, ADMIN_URL); the one-time token travels in the fragment, never to a server. */
  private appUrl(app: Audience): string {
    return this.ctx.config.publicUrls[app];
  }

  /** Every setting this module reads, in force now (read before a transaction opens). */
  private async cfg() {
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
      staffTwoStepRequired,
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
      g('staffTwoStepRequired'),
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
      staffTwoStepRequired,
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

  private publish<N extends Parameters<ModuleContext<'identity'>['events']['publish']>[0]>(name: N, payload: EventPayload<N>, by?: { actor?: common.Actor; requestId?: string }) {
    this.ctx.events.publish(name, payload as never, { actor: by?.actor, requestId: by?.requestId });
  }

  /** Material staff actions also go to audit (optional dependency; security_events always has them). */
  private async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: { actor: common.Actor; requestId?: string; client?: ClientInfo }) {
    await this.ctx.tryUse('audit')?.record({ category: 'security', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null, ip: by.client?.ip ?? null });
  }

  private async securityEvent(
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

  private dummyHash() {
    this.#dummyHash ??= hashPassword('not-a-real-password-for-timing');
    return this.#dummyHash;
  }

  /** Same scrypt work whether or not the account (or its password) exists */
  private async checkPassword(account: AccountRow | undefined, password: string) {
    return verifyPassword(account?.password_hash ?? (await this.dummyHash()), password).then((ok) => ok && Boolean(account?.password_hash));
  }

  private codeHash(challengeId: string, code: string) {
    return this.keys.hmac('codes', `${challengeId}:${code.trim()}`);
  }
  private recoveryHash(accountId: string, code: string) {
    return this.keys.hmac('recovery-codes', `${accountId}:${normalizeRecoveryCode(code)}`);
  }

  private async methodsOf(accountId: string) {
    return this.repo.activeMethods([accountId]);
  }

  private async summaryOf(a: AccountRow, repo: IdentityRepository = this.repo): Promise<AccountSummary> {
    const methods = await repo.activeMethods([a.id]);
    return map.accountSummary(a, methods.length > 0, this.now());
  }

  /** The signed-in account behind a principal (404 when it isn't known here) */
  private async accountOf(principal: KernelPrincipal | null | undefined): Promise<AccountRow> {
    const id = principal?.accountId;
    const a = id && isUuid(id) ? await this.repo.getAccount(id) : undefined;
    if (!a) throw new AppError('NOT_FOUND', 'Account not found');
    return a;
  }

  private policyFor(realm: Realm, s: { memberMinPasswordLength: number; staffMinPasswordLength: number }): PasswordPolicy {
    return passwordPolicy(realm, s);
  }

  private assertStrong(password: string, realm: Realm, personal: (string | null | undefined)[], s: Awaited<ReturnType<IdentityService['cfg']>>) {
    const failed = passwordProblems(password, this.policyFor(realm, s), personal);
    if (failed.length) throw new AppError('WEAK_PASSWORD', 'Choose a stronger password', { failed });
  }

  private async assertNotReused(accountId: string, password: string, n: number) {
    const recent = await this.repo.recentPasswordHashes(accountId, n);
    for (const h of recent) if (await verifyPassword(h, password)) throw new AppError('PASSWORD_REUSED', 'Choose a password you have not used recently');
  }

  /** Sets a new password and keeps it in the history */
  private async storePassword(repo: IdentityRepository, accountId: string, hash: string, now: Date, patch: Partial<AccountRow> = {}) {
    await repo.addPasswordHistory({ id: newId(), account_id: accountId, password_hash: hash, created_at: now });
    return repo.updateAccount(accountId, { password_hash: hash, password_changed_at: now, ...patch });
  }

  /** Revokes sessions; account-wide revocations also refuse every token issued before now. */
  private async revoke(repo: IdentityRepository, sel: Parameters<IdentityRepository['revokeSessions']>[0], reason: string, now: Date, accountWide = false) {
    const ids = await repo.revokeSessions(sel, reason, now);
    if (accountWide) await repo.updateAccount(sel.accountId, { tokens_valid_after: truncSecond(now) });
    return ids;
  }

  /* ================================================================ tokens and sessions */

  private signAccess(claims: Omit<AccessClaims, 'iat' | 'exp' | 'jti' | 'iss'>, ttlMinutes: number) {
    const now = this.now();
    const token = signAccessToken(this.signer, claims, { issuer: this.ctx.config.auth.issuer, ttlSeconds: ttlMinutes * 60, now });
    return { token, expiresAt: new Date((seconds(now) + ttlMinutes * 60) * 1000) };
  }

  private sessionTokens(session: SessionRow, refreshToken: string, s: { accessTokenTtlMinutes: number }): SessionTokens {
    const access = this.signAccess(
      {
        aud: session.audience,
        kind: KIND_OF[session.audience],
        sub: session.account_id,
        sid: session.id,
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

  private visitorTokens(g: GuestSessionRow, refreshToken: string, s: { accessTokenTtlMinutes: number }): SessionTokens {
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
  private deliver<T extends { tokens?: SessionTokens | null }>(result: T, web: boolean, now: Date): WithCookie<T> {
    const t = result.tokens;
    if (!t || !web) return { result };
    const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(t.refreshTokenExpiresAt) - now.getTime()) / 1000));
    return { result: { ...result, tokens: { ...t, refreshToken: '' } }, cookie: { token: t.refreshToken, maxAgeSeconds } };
  }

  /** Finds or records the device a sign-in comes from */
  private async deviceFor(repo: IdentityRepository, accountId: string, info: DeviceInfo, client: ClientInfo, now: Date) {
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
  private async trustedDevice(repo: IdentityRepository, accountId: string, info: DeviceInfo, now: Date) {
    const iid = info.installationId?.trim();
    if (!iid) return false;
    const d = await repo.findDeviceByInstallation(accountId, iid);
    return Boolean(d?.two_step_trusted_until && d.two_step_trusted_until > now);
  }

  /** A visitor session ends when the person signs in or registers with it (docs/03 §8). */
  private async claimVisitorSession(repo: IdentityRepository, visitorSessionId: string | null | undefined, accountId: string, now: Date): Promise<string | null> {
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
  private async openSession(
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
    s: Awaited<ReturnType<IdentityService['cfg']>>,
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
  private async forcedResetToken(repo: IdentityRepository, account: AccountRow, client: ClientInfo, s: { passwordResetTtlMinutes: number }, now: Date) {
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
  private async completeSignIn(
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
    s: Awaited<ReturnType<IdentityService['cfg']>>,
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
    const tokens = this.sessionTokens(opened.session, opened.refreshToken, s);
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

  /* ================================================================ public: app sessions, registration, codes */

  /** POST /app-sessions: a visitor token (and refresh token) for the app named in audience */
  async startAppSession(input: { audience: Audience; device: DeviceInfo }): Promise<WithCookie<SessionTokens>> {
    const s = await this.cfg();
    const now = this.now();
    const refreshToken = randomToken('v.');
    const g: GuestSessionRow = {
      id: newId(),
      device_kind: input.device.kind,
      created_at: now,
      last_seen_at: now,
      expires_at: new Date(now.getTime() + s.visitorRefreshDays * DAY),
      claimed_by_account_id: null,
      claimed_at: null,
      audience: input.audience,
      refresh_token_hash: tokenHash(refreshToken),
      previous_token_hash: null,
      rotated_at: null,
    };
    await this.repo.insertGuestSession(g);
    const out = this.deliver({ tokens: this.visitorTokens(g, refreshToken, s) }, input.device.kind === 'web', now);
    return { result: out.result.tokens!, cookie: out.cookie };
  }

  private async newEmailCode(
    repo: IdentityRepository,
    o: { accountId: string | null; purpose: 'email_verification' | 'email_change'; email: string; payload?: Record<string, unknown> },
    s: Awaited<ReturnType<IdentityService['cfg']>>,
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

  private codeIssued(c: ChallengeRow, code: string, channel: 'email' | 'sms', to: string) {
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

  /** POST /registrations: always 202 with a challenge, whether or not the email has an account */
  async register(body: RegistrationRequest, caller: Caller): Promise<VerificationChallenge> {
    const s = await this.cfg();
    const now = this.now();
    const email = normalizeEmail(body.email);
    const firstName = body.firstName.trim();
    const lastName = body.lastName.trim();
    if (!firstName || !lastName) throw new AppError('VALIDATION_FAILED', 'Enter your first and last name', issue(firstName ? 'body.lastName' : 'body.firstName', 'required'));
    this.assertStrong(body.password, 'member', [email, firstName, lastName], s);
    const hash = await hashPassword(body.password);
    const visitorSessionId = caller.principal?.kind === 'visitor' && caller.principal.audience === 'store' ? caller.principal.sessionId : null;
    const displayName = `${firstName} ${lastName}`;

    const out = await this.repo.transaction(async (repo) => {
      const existing = await repo.findAccount('member', email, { forUpdate: true });
      if (existing && existing.status !== 'pending_verification') {
        // the email says "you already have an account"; this code will never verify
        const { row, code } = await this.newEmailCode(repo, { accountId: existing.id, purpose: 'email_verification', email: existing.email, payload: { existingAccount: true } }, s, now);
        return { row, code, registered: null };
      }
      let account: AccountRow;
      if (existing) {
        // a registration that was never confirmed: the newest attempt replaces it (the code proves the email)
        await repo.supersedeChallenges(existing.id, 'email_verification');
        account = await this.storePassword(repo, existing.id, hash, now, { display_name: displayName, email: body.email.trim(), accepted_terms_version: body.acceptedTermsVersion });
      } else {
        account = {
          id: newId(),
          realm: 'member',
          email: body.email.trim(),
          email_normalized: email,
          email_verified_at: null,
          display_name: displayName,
          status: accountStatusMachine.initial,
          password_hash: hash,
          password_changed_at: now,
          must_reset_password: false,
          failed_sign_ins: 0,
          failed_window_started_at: null,
          locked_until: null,
          lock_reason: null,
          locked_by: null,
          closed_at: null,
          accepted_terms_version: body.acceptedTermsVersion,
          created_at: now,
          last_sign_in_at: null,
          last_active_at: null,
          version: 1,
          tokens_valid_after: null,
        };
        await repo.insertAccount(account);
        await repo.addPasswordHistory({ id: newId(), account_id: account.id, password_hash: hash, created_at: now });
      }
      const { row, code } = await this.newEmailCode(
        repo,
        { accountId: account.id, purpose: 'email_verification', email: account.email, payload: { visitorSessionId, device: body.device, marketingOptIn: body.marketingOptIn } },
        s,
        now,
      );
      return { row, code, registered: account };
    });

    if (out.registered) {
      this.publish(
        'identity.user.registered',
        {
          accountId: out.registered.id,
          email: out.registered.email,
          firstName,
          lastName,
          marketingOptIn: body.marketingOptIn,
          acceptedTermsVersion: body.acceptedTermsVersion,
          guestSessionId: visitorSessionId,
          at: map.iso(now),
        },
        caller,
      );
    }
    this.codeIssued(out.row, out.code, 'email', out.row.target_email!);
    return map.verificationChallenge(out.row);
  }

  /** Loads a challenge for a code check: NOT_FOUND / CHALLENGE_LOCKED / CODE_EXPIRED as the spec says */
  private openChallenge(c: ChallengeRow | undefined, purposes: ChallengeRow['purpose'][], now: Date): ChallengeRow {
    if (!c || !purposes.includes(c.purpose)) throw new AppError('NOT_FOUND', 'Code request not found');
    if (c.status === 'locked') throw new AppError('CHALLENGE_LOCKED', 'Too many wrong codes; start again');
    if (c.status !== 'pending' || c.expires_at <= now) throw new AppError('CODE_EXPIRED', 'This code has expired; request a new one');
    return c;
  }

  /** A wrong code: counts it and returns the error to throw after the transaction */
  private async wrongCode(repo: IdentityRepository, c: ChallengeRow): Promise<AppError> {
    const attempts = c.attempts + 1;
    const locked = attempts >= c.max_attempts;
    await repo.updateChallenge(c.id, { attempts, ...(locked ? { status: 'locked' } : {}) });
    return locked
      ? new AppError('CHALLENGE_LOCKED', 'Too many wrong codes; start again', { attemptsLeft: 0 })
      : new AppError('CODE_INVALID', 'That code is not right', { attemptsLeft: c.max_attempts - attempts });
  }

  /** POST /verifications/{id}/confirm: registration, email change or phone code */
  async confirmVerification(id: string, body: VerifyCodeRequest, caller: Caller): Promise<WithCookie<VerifyResult>> {
    const s = await this.cfg();
    const now = this.now();
    let after = () => {};
    let web = false;
    const outcome = await this.repo.transaction(async (repo) => {
      const c = this.openChallenge(await repo.getChallenge(id, { forUpdate: true }), ['email_verification', 'email_change', 'phone_verification'], now);
      const payload = (c.payload ?? {}) as Record<string, unknown>;
      if (payload.existingAccount === true || !c.code_hash || !safeEqual(c.code_hash, this.codeHash(c.id, body.code))) return { error: await this.wrongCode(repo, c) };
      await repo.updateChallenge(c.id, { status: 'completed', completed_at: now });
      const account = c.account_id ? await repo.getAccount(c.account_id, { forUpdate: true }) : undefined;
      if (!account) throw new AppError('NOT_FOUND', 'Account not found');

      if (c.purpose === 'email_verification') {
        if (account.status !== 'pending_verification') return { error: new AppError('CODE_EXPIRED', 'This code is no longer valid') };
        const status = accountStatusMachine.next('pending_verification', 'verifyEmail');
        const verified = await repo.updateAccount(account.id, { status, email_verified_at: now });
        await this.securityEvent(repo, account.id, 'email_verified', 'completed', { client: caller.client });
        const device = (body.device ?? (payload.device as DeviceInfo | undefined) ?? { kind: 'web' }) as DeviceInfo;
        web = device.kind === 'web';
        const visitorSessionId = (payload.visitorSessionId as string | null | undefined) ?? (caller.principal?.kind === 'visitor' ? caller.principal.sessionId : null);
        const opened = await this.openSession(repo, verified, { audience: 'store', device, client: caller.client, keepSignedIn: body.keepSignedIn ?? false, twoStepVerified: false, visitorSessionId, method: 'code' }, s, now);
        const fresh = (await repo.getAccount(account.id))!;
        after = () => {
          this.publish('identity.user.verified', { accountId: account.id, channel: 'email', email: verified.email, phone: null, guestSessionId: opened.claimed ?? visitorSessionId ?? null, at: map.iso(now) }, caller);
          opened.after();
        };
        return { result: { verified: true, account: await this.summaryOf(fresh, repo), tokens: this.sessionTokens(opened.session, opened.refreshToken, s) } };
      }

      if (c.purpose === 'email_change') {
        const newEmail = c.target_email!;
        const taken = await repo.findAccount(account.realm, normalizeEmail(newEmail));
        if (taken && taken.id !== account.id) return { error: new AppError('EMAIL_IN_USE', 'Another account uses that email') };
        const oldEmail = account.email;
        const changed = await repo.updateAccount(account.id, { email: newEmail, email_normalized: normalizeEmail(newEmail), email_verified_at: now });
        await this.securityEvent(repo, account.id, 'email_changed', 'completed', { client: caller.client, detail: { from: maskEmail(oldEmail), to: maskEmail(newEmail) } });
        after = () => this.publish('identity.email.changed', { accountId: account.id, oldEmail, newEmail }, caller);
        return { result: { verified: true, account: await this.summaryOf(changed, repo), tokens: null } };
      }

      // phone_verification
      const phone = c.target_phone_encrypted ? this.keys.decrypt(c.target_phone_encrypted).toString('utf8') : null;
      after = () => this.publish('identity.user.verified', { accountId: account.id, channel: 'phone', email: account.email, phone, guestSessionId: null, at: map.iso(now) }, caller);
      return { result: { verified: true, account: await this.summaryOf(account, repo), tokens: null } };
    });
    if ('error' in outcome) throw outcome.error;
    after();
    return this.deliver(outcome.result, web, now);
  }

  /** POST /verifications/{id}/resend: a new code on the same challenge after the resend timer */
  async resendVerification(id: string): Promise<VerificationChallenge> {
    const s = await this.cfg();
    const now = this.now();
    const out = await this.repo.transaction(async (repo) => {
      const c = await repo.getChallenge(id, { forUpdate: true });
      if (!c || !['email_verification', 'email_change', 'phone_verification'].includes(c.purpose)) throw new AppError('NOT_FOUND', 'Code request not found');
      if (c.status !== 'pending') throw new AppError('CODE_EXPIRED', 'This request has ended; start again');
      if (c.resend_available_at && c.resend_available_at > now) throw new AppError('RESEND_TOO_SOON', 'Wait a moment before asking for a new code', { resendAvailableAt: map.iso(c.resend_available_at) });
      const code = sixDigitCode();
      const row = await repo.updateChallenge(c.id, {
        code_hash: this.codeHash(c.id, code),
        attempts: 0,
        expires_at: new Date(now.getTime() + s.verificationCodeTtlMinutes * MIN),
        resend_available_at: new Date(now.getTime() + s.codeResendSeconds * 1000),
      });
      return { row, code };
    });
    const { row, code } = out;
    if (row.purpose === 'phone_verification') {
      const phone = row.target_phone_encrypted ? this.keys.decrypt(row.target_phone_encrypted).toString('utf8') : '';
      this.codeIssued(row, code, 'sms', phone);
    } else this.codeIssued(row, code, 'email', row.target_email!);
    return map.verificationChallenge(row);
  }

  /* ================================================================ public: sign-in */

  /** Unknown emails get the same answers as real ones (lock included), from sign_in_attempts */
  private async unknownAccountFailure(email: string, s: Awaited<ReturnType<IdentityService['cfg']>>, now: Date): Promise<never> {
    // replay the attempts through the same counter a real account keeps: a window of lockoutMinutes,
    // a lock at maxFailedSignIns, attempts during a lock not counted, a fresh count after it ends
    const windowMs = s.lockoutMinutes * MIN;
    const fails = await this.repo.failedAttemptsSince(email, new Date(now.getTime() - 3 * windowMs));
    let counter: { failed_sign_ins: number; failed_window_started_at: Date | null } = { failed_sign_ins: 0, failed_window_started_at: null };
    let lockedUntil: Date | null = null;
    let attemptsLeft = s.maxFailedSignIns;
    for (const at of fails) {
      if (lockedUntil && at < lockedUntil) continue;
      if (lockedUntil) {
        lockedUntil = null;
        counter = { failed_sign_ins: 0, failed_window_started_at: null };
      }
      const f = registerFailure(counter, at, s);
      counter = f;
      attemptsLeft = f.attemptsLeft;
      if (f.lock) lockedUntil = new Date(at.getTime() + windowMs);
    }
    if (lockedUntil && lockedUntil > now) throw new AppError('ACCOUNT_LOCKED', 'Sign-in is paused for this account', { lockedUntil: map.iso(lockedUntil), cause: 'failed_sign_ins' });
    throw new AppError('INVALID_CREDENTIALS', "Email and password don't match", { attemptsLeft });
  }

  private lockedError(a: AccountRow) {
    return new AppError('ACCOUNT_LOCKED', 'Sign-in is paused for this account', { lockedUntil: map.isoOrNull(a.locked_until), cause: a.locked_by ? 'staff_action' : 'failed_sign_ins' });
  }

  /** A lock whose end has passed is lifted (lockExpires) before the account is used */
  private async liftExpiredLock(repo: IdentityRepository, a: AccountRow, now: Date): Promise<AccountRow> {
    if (a.status !== 'locked' || lockInForce(a, now)) return a;
    const status = accountStatusMachine.next('locked', 'lockExpires');
    const lifted = await repo.updateAccount(a.id, { status, locked_until: null, lock_reason: null, locked_by: null, failed_sign_ins: 0, failed_window_started_at: null });
    await this.securityEvent(repo, a.id, 'account_unlocked', 'completed', { detail: { cause: 'expired' } });
    return lifted;
  }

  /**
   * A wrong password or step-up answer, counted on the account's shared counter. Locks the account
   * for lockoutMinutes at the limit. Returns what to publish and how many attempts are left.
   */
  private async countFailure(
    repo: IdentityRepository,
    a: AccountRow,
    s: Awaited<ReturnType<IdentityService['cfg']>>,
    now: Date,
    o: { client?: ClientInfo; audience?: Audience | null; reason: 'password' | 'step_up' | 'second_factor' },
  ) {
    const f = registerFailure(a, now, s);
    const lock = f.lock && a.status === 'active';
    const lockedUntil = new Date(now.getTime() + s.lockoutMinutes * MIN);
    const status = lock ? accountStatusMachine.next('active', 'tooManyFailedSignIns') : a.status;
    const updated = await repo.updateAccount(a.id, {
      failed_sign_ins: f.failed_sign_ins,
      failed_window_started_at: f.failed_window_started_at,
      ...(lock ? { status, locked_until: lockedUntil, lock_reason: 'Too many wrong passwords', locked_by: null } : {}),
    });
    await this.securityEvent(repo, a.id, 'sign_in_failed', 'failed', { client: o.client, audience: o.audience, detail: { reason: o.reason, attemptsLeft: f.attemptsLeft } });
    if (lock) await this.securityEvent(repo, a.id, 'account_locked', 'blocked', { client: o.client, audience: o.audience, detail: { cause: 'failed_sign_ins', failures: f.failed_sign_ins, minutes: s.lockoutMinutes } });
    return {
      account: updated,
      attemptsLeft: f.attemptsLeft,
      locked: lock,
      lockedUntil,
      after: () => {
        if (lock) this.publish('identity.account.locked', { accountId: a.id, realm: a.realm, cause: 'failed_sign_ins', until: map.iso(lockedUntil), by: null, reason: null });
      },
    };
  }

  /** POST /sessions: email and password */
  async signIn(body: SignInRequest, caller: Caller): Promise<WithCookie<SignInResult>> {
    const s = await this.cfg();
    const now = this.now();
    const email = normalizeEmail(body.email);
    const realm: Realm = body.audience === 'admin' ? 'staff' : 'member';
    const found = await this.repo.findAccount(realm, email);
    const ok = await this.checkPassword(found?.status === 'invited' ? undefined : found, body.password);
    await this.repo.insertSignInAttempt({ email_normalized: email, ip: caller.client.ip ?? '0.0.0.0', succeeded: ok, at: now });
    if (!found || !found.password_hash || found.status === 'invited') return this.unknownAccountFailure(email, s, now);

    const visitorSessionId = caller.principal?.kind === 'visitor' ? caller.principal.sessionId : null;
    let after = () => {};
    const outcome = await this.repo.transaction(async (repo): Promise<{ error: AppError } | { result: SignInResult; web: boolean }> => {
      let a = (await repo.getAccount(found.id, { forUpdate: true }))!;
      a = await this.liftExpiredLock(repo, a, now);
      if (lockInForce(a, now)) {
        await this.securityEvent(repo, a.id, 'sign_in_blocked', 'blocked', { client: caller.client, audience: body.audience, detail: { cause: 'locked' } });
        return { error: this.lockedError(a) };
      }
      if (!ok) {
        const f = await this.countFailure(repo, a, s, now, { client: caller.client, audience: body.audience, reason: 'password' });
        after = f.after;
        return { error: f.locked ? this.lockedError(f.account) : new AppError('INVALID_CREDENTIALS', "Email and password don't match", { attemptsLeft: f.attemptsLeft }) };
      }
      if (a.status === 'disabled' || (a.status === 'closed' && (body.audience !== 'seller' || !(await repo.activeSellerAccess(a.id)).length))) {
        await this.securityEvent(repo, a.id, 'sign_in_blocked', 'blocked', { client: caller.client, audience: body.audience, detail: { cause: 'disabled' } });
        return { error: new AppError('ACCOUNT_DISABLED', 'This account is disabled') };
      }
      if (a.status === 'pending_verification') {
        await repo.supersedeChallenges(a.id, 'email_verification');
        const { row, code } = await this.newEmailCode(repo, { accountId: a.id, purpose: 'email_verification', email: a.email, payload: { visitorSessionId, device: body.device } }, s, now);
        after = () => this.codeIssued(row, code, 'email', a.email);
        return { error: new AppError('EMAIL_NOT_VERIFIED', 'Confirm your email first; we sent you a new code', { challenge: map.verificationChallenge(row) }) };
      }
      if (needsRehash(a.password_hash!)) a = await repo.updateAccount(a.id, { password_hash: await hashPassword(body.password) });
      const next = await this.afterFirstFactor(
        repo,
        a,
        { audience: body.audience, device: body.device, client: caller.client, keepSignedIn: body.keepSignedIn, sellerId: body.sellerId ?? null, visitorSessionId, callerSessionId: caller.principal?.sessionId ?? null, method: 'password' },
        s,
        now,
      );
      after = next.after;
      return { result: next.result, web: body.device.kind === 'web' };
    });
    after();
    if ('error' in outcome) throw outcome.error;
    return this.deliver(outcome.result, outcome.web, now);
  }

  /** After the password (or provider): a 2-step challenge when the account needs one, else the session */
  private async afterFirstFactor(
    repo: IdentityRepository,
    a: AccountRow,
    o: { audience: Audience; device: DeviceInfo; client: ClientInfo; keepSignedIn: boolean; sellerId: string | null; visitorSessionId: string | null; callerSessionId: string | null; method: 'password' | 'code' },
    s: Awaited<ReturnType<IdentityService['cfg']>>,
    now: Date,
  ): Promise<{ result: SignInResult; after: () => void }> {
    const methods = await repo.activeMethods([a.id]);
    const needsSecondFactor = methods.length > 0 && (a.realm === 'staff' || !(await this.trustedDevice(repo, a.id, o.device, now)));
    if (needsSecondFactor) {
      await repo.updateAccount(a.id, { failed_sign_ins: 0, failed_window_started_at: null });
      const challenge = await this.newSignInChallenge(
        repo,
        a,
        methods,
        { audience: o.audience, keepSignedIn: o.keepSignedIn, device: o.device, sellerId: o.sellerId, visitorSessionId: o.visitorSessionId, callerSessionId: o.callerSessionId },
        s,
        now,
      );
      return { result: { status: 'second_factor_required', account: null, tokens: null, challenge, sellerContexts: [], passwordResetToken: null }, after: () => {} };
    }
    // staff without a method (after a staff reset) sign in without twoStepAt: admin areas refuse
    // with STEP_UP_REQUIRED until they add a method through /api/store/identity/two-step/setups
    return this.completeSignIn(
      repo,
      a,
      { audience: o.audience, device: o.device, client: o.client, keepSignedIn: o.keepSignedIn, twoStepVerified: false, sellerId: o.sellerId, visitorSessionId: o.visitorSessionId, method: o.method },
      s,
      now,
    );
  }

  private async newSignInChallenge(
    repo: IdentityRepository,
    a: AccountRow,
    methods: TwoStepMethodRow[],
    payload: Record<string, unknown>,
    s: Awaited<ReturnType<IdentityService['cfg']>>,
    now: Date,
  ): Promise<SignInChallenge> {
    const recovery = (await repo.remainingRecoveryCodes([a.id])).get(a.id) ?? 0;
    const sms = methods.find((m) => m.method === 'sms');
    const row: ChallengeRow = {
      id: newId(),
      account_id: a.id,
      purpose: 'sign_in_second_factor',
      target_email: null,
      code_hash: null,
      payload: payload as never,
      attempts: 0,
      max_attempts: s.maxCodeAttempts,
      status: 'pending',
      expires_at: new Date(now.getTime() + s.verificationCodeTtlMinutes * MIN),
      resend_available_at: now,
      created_at: now,
      completed_at: null,
      target_phone_encrypted: null,
    };
    await repo.insertChallenge(row);
    return this.signInChallenge(row, methods, recovery, sms);
  }

  private signInChallenge(row: ChallengeRow, methods: TwoStepMethodRow[], recovery: number, sms?: TwoStepMethodRow): SignInChallenge {
    const kinds: SignInChallenge['methods'] = [];
    if (methods.some((m) => m.method === 'totp')) kinds.push('totp');
    if (sms) kinds.push('sms');
    if (recovery > 0) kinds.push('recovery_code');
    return { id: row.id, methods: kinds, smsPhoneMasked: sms?.phone_masked ?? null, expiresAt: map.iso(row.expires_at) };
  }

  /** A sign-in challenge of the caller's own sign-in (bound to the visitor session that started it) */
  private signInChallengeFor(c: ChallengeRow | undefined, caller: Caller, now: Date) {
    const payload = (c?.payload ?? {}) as Record<string, unknown>;
    if (c && payload.callerSessionId && payload.callerSessionId !== caller.principal?.sessionId) throw new AppError('NOT_FOUND', 'Sign-in request not found');
    return this.openChallenge(c, ['sign_in_second_factor'], now);
  }

  /** Checks a 2-step code (TOTP, SMS or recovery code) for an account; marks what it used. */
  private async checkSecondFactor(repo: IdentityRepository, a: AccountRow, method: 'totp' | 'sms' | 'recovery_code', code: string, now: Date, smsChallenge?: ChallengeRow): Promise<TwoStepMethodRow | 'recovery' | null> {
    if (method === 'recovery_code') return (await repo.useRecoveryCode(a.id, this.recoveryHash(a.id, code), now)) ? 'recovery' : null;
    const methods = await repo.activeMethods([a.id]);
    if (method === 'sms') {
      const m = methods.find((x) => x.method === 'sms');
      if (!m || !smsChallenge?.code_hash || !safeEqual(smsChallenge.code_hash, this.codeHash(smsChallenge.id, code))) return null;
      await repo.updateMethod(m.id, { last_used_at: now });
      return m;
    }
    for (const m of methods.filter((x) => x.method === 'totp')) {
      const step = m.secret_encrypted ? verifyTotp(this.keys.decrypt(m.secret_encrypted), code, now, m.last_used_step) : null;
      if (step !== null) {
        await repo.updateMethod(m.id, { last_used_at: now, last_used_step: step });
        return m;
      }
    }
    return null;
  }

  /** POST /sign-in-challenges/{id}/verify */
  async verifySecondFactor(id: string, body: SecondFactorRequest, caller: Caller): Promise<WithCookie<SignInResult>> {
    const s = await this.cfg();
    const now = this.now();
    let after = () => {};
    const outcome = await this.repo.transaction(async (repo): Promise<{ error: AppError } | { result: SignInResult; web: boolean }> => {
      const c = this.signInChallengeFor(await repo.getChallenge(id, { forUpdate: true }), caller, now);
      let a = c.account_id ? await repo.getAccount(c.account_id, { forUpdate: true }) : undefined;
      if (!a) throw new AppError('NOT_FOUND', 'Sign-in request not found');
      const used = await this.checkSecondFactor(repo, a, body.method, body.code, now, c);
      if (!used) {
        await this.securityEvent(repo, a.id, 'sign_in_failed', 'failed', { client: caller.client, detail: { reason: 'second_factor' } });
        return { error: await this.wrongCode(repo, c) };
      }
      await repo.updateChallenge(c.id, { status: 'completed', completed_at: now });
      a = await this.liftExpiredLock(repo, a, now);
      if (lockInForce(a, now)) return { error: this.lockedError(a) };
      if (a.status === 'disabled' || a.status === 'closed') return { error: new AppError('ACCOUNT_DISABLED', 'This account is disabled') };
      const p = (c.payload ?? {}) as Record<string, unknown>;
      const audience = audienceOk(p.audience) ? p.audience : 'store';
      const device = (p.device ?? { kind: 'web' }) as DeviceInfo;
      const done = await this.completeSignIn(
        repo,
        a,
        {
          audience,
          device,
          client: caller.client,
          keepSignedIn: p.keepSignedIn === true,
          twoStepVerified: true,
          sellerId: (p.sellerId as string | null) ?? null,
          visitorSessionId: (p.visitorSessionId as string | null) ?? null,
          method: 'two_step',
        },
        s,
        now,
      );
      // members may skip 2-step on this device for trustedDeviceDays (only devices with an installation id are recognised)
      if (body.rememberDevice && a.realm === 'member' && device.installationId && done.result.tokens) {
        const d = await repo.findDeviceByInstallation(a.id, device.installationId);
        if (d) await repo.updateDevice(d.id, { two_step_trusted_until: new Date(now.getTime() + s.trustedDeviceDays * DAY) });
      }
      after = done.after;
      return { result: done.result, web: device.kind === 'web' };
    });
    after();
    if ('error' in outcome) throw outcome.error;
    return this.deliver(outcome.result, outcome.web, now);
  }

  /** POST /sign-in-challenges/{id}/send-sms (phase 2) */
  async sendSignInSms(id: string, caller: Caller): Promise<SignInChallenge> {
    const s = await this.cfg();
    const now = this.now();
    const out = await this.repo.transaction(async (repo) => {
      const c = await repo.getChallenge(id, { forUpdate: true });
      const payload = (c?.payload ?? {}) as Record<string, unknown>;
      if (!c || c.purpose !== 'sign_in_second_factor' || (payload.callerSessionId && payload.callerSessionId !== caller.principal?.sessionId)) throw new AppError('NOT_FOUND', 'Sign-in request not found');
      if (c.status !== 'pending' || c.expires_at <= now) throw new AppError('CODE_EXPIRED', 'This sign-in has expired; sign in again');
      const methods = c.account_id ? await repo.activeMethods([c.account_id]) : [];
      const sms = methods.find((m) => m.method === 'sms');
      if (!sms?.phone_e164_encrypted) throw new AppError('METHOD_NOT_AVAILABLE', 'Text messages are not set up for this account');
      if (c.code_hash && c.resend_available_at && c.resend_available_at > now) throw new AppError('RESEND_TOO_SOON', 'Wait a moment before asking for a new code', { resendAvailableAt: map.iso(c.resend_available_at) });
      const code = sixDigitCode();
      const row = await repo.updateChallenge(c.id, { code_hash: this.codeHash(c.id, code), resend_available_at: new Date(now.getTime() + s.codeResendSeconds * 1000) });
      const recovery = (await repo.remainingRecoveryCodes([c.account_id!])).get(c.account_id!) ?? 0;
      return { row, code, phone: this.keys.decrypt(sms.phone_e164_encrypted).toString('utf8'), challenge: this.signInChallenge(row, methods, recovery, sms) };
    });
    this.codeIssued(out.row, out.code, 'sms', out.phone);
    return out.challenge;
  }

  /**
   * POST /external-sign-ins (phase 2): members only. An existing account is used only when the
   * provider vouches for the same email; otherwise a verified member account is created.
   */
  async externalSignIn(
    body: { provider: 'google' | 'apple'; idToken: string; audience: 'store' | 'seller'; device: DeviceInfo; marketingOptIn?: boolean | null },
    caller: Caller,
  ): Promise<WithCookie<SignInResult>> {
    const verifier = this.deps.externalIds;
    if (!verifier) throw new AppError('NOT_IMPLEMENTED', 'Sign-in with Google or Apple is not configured on this server', { reason: 'provider_not_configured', provider: body.provider });
    const ext = await verifier.verify(body.provider, body.idToken);
    if (!ext || !ext.emailVerified) throw new AppError('INVALID_CREDENTIALS', `${body.provider === 'google' ? 'Google' : 'Apple'} could not confirm your email; sign in with your password`);
    const s = await this.cfg();
    const now = this.now();
    const email = normalizeEmail(ext.email);
    const visitorSessionId = caller.principal?.kind === 'visitor' ? caller.principal.sessionId : null;
    let after = () => {};
    let registered: AccountRow | null = null;
    const outcome = await this.repo.transaction(async (repo): Promise<{ error: AppError } | { result: SignInResult }> => {
      let a = await repo.findAccount('member', email, { forUpdate: true });
      if (a) {
        a = await this.liftExpiredLock(repo, a, now);
        if (lockInForce(a, now)) return { error: this.lockedError(a) };
        if (a.status === 'disabled' || (a.status === 'closed' && (body.audience !== 'seller' || !(await repo.activeSellerAccess(a.id)).length))) return { error: new AppError('ACCOUNT_DISABLED', 'This account is disabled') };
        if (a.status === 'pending_verification') {
          // the provider proves the email; a password chosen by an unconfirmed registration is dropped
          a = await repo.updateAccount(a.id, { status: accountStatusMachine.next('pending_verification', 'verifyEmail'), email_verified_at: now, password_hash: null });
          await this.securityEvent(repo, a.id, 'email_verified', 'completed', { client: caller.client, detail: { via: body.provider } });
        }
      } else {
        const local = ext.email.split('@')[0]!;
        const firstName = ext.firstName?.trim() || local;
        const lastName = ext.lastName?.trim() || '';
        a = {
          id: newId(),
          realm: 'member',
          email: ext.email.trim(),
          email_normalized: email,
          email_verified_at: now,
          display_name: `${firstName} ${lastName}`.trim(),
          status: accountStatusMachine.next(accountStatusMachine.initial, 'verifyEmail'),
          password_hash: null,
          password_changed_at: null,
          must_reset_password: false,
          failed_sign_ins: 0,
          failed_window_started_at: null,
          locked_until: null,
          lock_reason: null,
          locked_by: null,
          closed_at: null,
          accepted_terms_version: null,
          created_at: now,
          last_sign_in_at: null,
          last_active_at: null,
          version: 1,
          tokens_valid_after: null,
        };
        await repo.insertAccount(a);
        registered = a;
      }
      const next = await this.afterFirstFactor(
        repo,
        a,
        // the request has no keep-me-signed-in choice: the app stays signed in, the website gets the short lifetime
        { audience: body.audience, device: body.device, client: caller.client, keepSignedIn: body.device.kind === 'android', sellerId: null, visitorSessionId, callerSessionId: caller.principal?.sessionId ?? null, method: 'code' },
        s,
        now,
      );
      after = next.after;
      return { result: next.result };
    });
    if (registered) {
      const r: AccountRow = registered;
      const [firstName, ...rest] = r.display_name.split(' ');
      this.publish('identity.user.registered', { accountId: r.id, email: r.email, firstName: firstName ?? '', lastName: rest.join(' '), marketingOptIn: body.marketingOptIn ?? false, acceptedTermsVersion: '', guestSessionId: visitorSessionId, at: map.iso(now) }, caller);
    }
    after();
    if ('error' in outcome) throw outcome.error;
    return this.deliver(outcome.result, body.device.kind === 'web', now);
  }

  /* ================================================================ public: refresh and sign-out */

  /**
   * Middleware check for refresh and sign-out (kernel/auth/authorities.ts). The previous token
   * still counts during the grace window (parallel refresh); outside it, reuse revokes the session.
   */
  async verifyRefreshToken(refreshToken: string): Promise<{ sessionId: string; accountId?: string; audience: string; kind: string } | null> {
    if (typeof refreshToken !== 'string' || refreshToken.length < 20 || refreshToken.length > 200) return null;
    // on every refresh and sign-out: read only the two settings this needs
    const [refreshReuseGraceSeconds, staffIdleMinutes] = await Promise.all([this.ctx.settings.get('refreshReuseGraceSeconds'), this.ctx.settings.get('staffIdleMinutes')]);
    const s = { refreshReuseGraceSeconds, staffIdleMinutes };
    const now = this.now();
    const hash = tokenHash(refreshToken);
    if (refreshToken.startsWith('v.')) {
      const g = await this.repo.findGuestSessionByRefreshHash(hash);
      if (!g || g.claimed_by_account_id || g.expires_at <= now) return null;
      if (g.refresh_token_hash !== hash) {
        if (!this.inGrace(g.rotated_at, s, now)) {
          await this.repo.updateGuestSession(g.id, { expires_at: now }); // reuse: the visitor session ends
          return null;
        }
      }
      return { sessionId: g.id, audience: g.audience, kind: 'visitor' };
    }
    const session = await this.repo.findSessionByRefreshHash(hash);
    if (!session || !this.sessionLive(session, s, now)) return null;
    if (session.refresh_token_hash !== hash && !this.inGrace(session.last_refreshed_at, s, now)) {
      await this.refreshReused(session, now);
      return null;
    }
    return { sessionId: session.id, accountId: session.account_id, audience: session.audience, kind: KIND_OF[session.audience] };
  }

  private inGrace(rotatedAt: Date | null, s: { refreshReuseGraceSeconds: number }, now: Date) {
    return Boolean(rotatedAt && now.getTime() - rotatedAt.getTime() <= s.refreshReuseGraceSeconds * 1000);
  }

  private sessionLive(x: SessionRow, s: { staffIdleMinutes: number }, now: Date) {
    return this.sessionState(x, s, now) === 'live';
  }

  /** Staff sessions go idle after staffIdleMinutes without a request (last_active_at, kept by touchStaffSession) */
  private sessionState(x: SessionRow, s: { staffIdleMinutes: number }, now: Date): 'live' | 'revoked' | 'expired' | 'idle' {
    if (x.revoked_at) return 'revoked';
    if (x.expires_at <= now || x.absolute_expires_at <= now) return 'expired';
    if (x.audience === 'admin' && now.getTime() - x.last_active_at.getTime() > s.staffIdleMinutes * MIN) return 'idle';
    return 'live';
  }

  /**
   * Middleware check on every admin request (kernel/auth/chain.ts, cached 5 s per server): the session is
   * live, and the request is activity that keeps it from going idle. The write happens at most once a
   * minute per session, so a busy staff member costs one indexed read per few seconds.
   */
  async touchStaffSession(sessionId: string): Promise<{ live: boolean; reason?: 'revoked' | 'expired' | 'idle' | 'unknown' }> {
    const session = await this.repo.getSession(sessionId);
    if (!session || session.audience !== 'admin') return { live: false, reason: 'unknown' };
    const now = this.now();
    const state = this.sessionState(session, { staffIdleMinutes: await this.ctx.settings.get('staffIdleMinutes') }, now);
    if (state !== 'live') return { live: false, reason: state };
    if (now.getTime() - session.last_active_at.getTime() >= MIN) await this.repo.updateSession(session.id, { last_active_at: now });
    return { live: true };
  }

  /** A rotated refresh token came back after the grace window: theft signal (docs/03 §5: no account lock) */
  private async refreshReused(session: SessionRow, now: Date) {
    await this.repo.transaction(async (repo) => {
      const ids = await repo.revokeSessions({ accountId: session.account_id, sessionIds: [session.id] }, 'refresh_token_reused', now);
      if (ids.length) await this.securityEvent(repo, session.account_id, 'refresh_token_reused', 'blocked', { audience: session.audience, device: await repo.getDevice(session.device_id) });
    });
  }

  /** POST /sessions/refresh: rotates the refresh token (same new pair within the grace window) */
  async refreshSession(refreshToken: string, via: 'cookie' | 'body', caller: Caller): Promise<WithCookie<SessionTokens>> {
    const s = await this.cfg();
    const now = this.now();
    const hash = tokenHash(refreshToken);
    const web = via === 'cookie';
    const wrap = (t: SessionTokens) => {
      const out = this.deliver({ tokens: t }, web, now);
      return { result: out.result.tokens!, cookie: out.cookie };
    };

    if (refreshToken.startsWith('v.')) {
      const out = await this.repo.transaction(async (repo) => {
        const g = await repo.findGuestSessionByRefreshHash(hash, { forUpdate: true });
        if (!g || g.claimed_by_account_id || g.expires_at <= now) return null;
        const current = g.refresh_token_hash === hash;
        if (!current && !this.inGrace(g.rotated_at, s, now)) return null;
        // the token that follows the presented one; for a parallel refresh in the grace window it is the current one
        const next = this.keys.nextRefreshToken(g.id, refreshToken);
        if (!current && tokenHash(next) !== g.refresh_token_hash) return null;
        const expires = new Date(now.getTime() + s.visitorRefreshDays * DAY);
        const patch = current
          ? { refresh_token_hash: tokenHash(next), previous_token_hash: hash, rotated_at: now, last_seen_at: now, expires_at: expires }
          : { last_seen_at: now };
        await repo.updateGuestSession(g.id, patch);
        return this.visitorTokens({ ...g, ...patch }, next, s);
      });
      if (!out) throw new AppError('REFRESH_TOKEN_INVALID', 'Sign in again');
      return wrap(out);
    }

    const out = await this.repo.transaction(async (repo): Promise<SessionTokens | AppError> => {
      const session = await repo.findSessionByRefreshHash(hash, { forUpdate: true });
      if (!session || !this.sessionLive(session, s, now)) return new AppError('REFRESH_TOKEN_INVALID', 'Sign in again');
      const current = session.refresh_token_hash === hash;
      const next = this.keys.nextRefreshToken(session.id, refreshToken);
      if (!current && (!this.inGrace(session.last_refreshed_at, s, now) || tokenHash(next) !== session.refresh_token_hash)) return new AppError('REFRESH_TOKEN_INVALID', 'Sign in again');
      let account = (await repo.getAccount(session.account_id, { forUpdate: true }))!;
      account = await this.liftExpiredLock(repo, account, now);
      // failed-sign-in locks only block new sign-ins; staff locks revoked the sessions already
      if (lockInForce(account, now) && account.locked_by) return new AppError('ACCOUNT_LOCKED', 'This account is locked', { lockedUntil: map.isoOrNull(account.locked_until), cause: 'staff_action' });
      if (account.status === 'disabled' || (account.status === 'closed' && session.audience !== 'seller')) return new AppError('ACCOUNT_DISABLED', 'This account is disabled');
      if (session.seller_id && session.audience === 'seller') {
        const access = await repo.getSellerAccess(account.id, session.seller_id);
        if (!access || access.revoked_at) return new AppError('REFRESH_TOKEN_INVALID', 'You no longer act for this seller; sign in again');
      }
      let row = session;
      if (current) {
        const patch = { refresh_token_hash: tokenHash(next), previous_token_hash: hash, last_refreshed_at: now, last_active_at: now };
        await repo.updateSession(session.id, patch);
        row = { ...session, ...patch };
        await repo.updateDevice(session.device_id, { last_active_at: now, last_ip: caller.client.ip });
        await repo.updateAccount(account.id, { last_active_at: now });
      }
      return this.sessionTokens(row, next, s);
    });
    if (out instanceof AppError) {
      // the middleware accepted the token a moment ago: it was revoked or rotated in between
      throw out;
    }
    return wrap(out);
  }

  /** POST /sessions/sign-out: ends the session the refresh token belongs to (idempotent) */
  async signOut(refreshToken: string, via: 'cookie' | 'body', caller: Caller): Promise<WithCookie<null>> {
    const now = this.now();
    const hash = tokenHash(refreshToken);
    if (refreshToken.startsWith('v.')) {
      const g = await this.repo.findGuestSessionByRefreshHash(hash);
      if (g && g.expires_at > now) await this.repo.updateGuestSession(g.id, { expires_at: now });
    } else {
      await this.repo.transaction(async (repo) => {
        const session = await repo.findSessionByRefreshHash(hash, { forUpdate: true });
        if (!session || session.revoked_at) return;
        const ids = await repo.revokeSessions({ accountId: session.account_id, sessionIds: [session.id] }, 'signOut', now);
        if (ids.length) await this.securityEvent(repo, session.account_id, 'signed_out', 'completed', { audience: session.audience, device: await repo.getDevice(session.device_id), client: caller.client });
      });
    }
    return { result: null, ...(via === 'cookie' ? { cookie: 'clear' as const } : {}) };
  }

  /* ================================================================ public: password reset, policy */

  private resetUrl(realm: Realm, token: string) {
    return `${this.appUrl(realm === 'staff' ? 'admin' : 'store')}/reset-password#token=${token}`;
  }

  /** Issues a reset link for an account (self-service or by staff) and publishes it */
  private async issueReset(repo: IdentityRepository, a: AccountRow, o: { client?: ClientInfo; forcedBy?: common.Actor | null; reason?: string | null }, s: { passwordResetTtlMinutes: number }, now: Date) {
    await repo.invalidateResets(a.id, now);
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + s.passwordResetTtlMinutes * MIN);
    await repo.insertReset({
      id: newId(),
      account_id: a.id,
      token_hash: tokenHash(token),
      forced_by: o.forcedBy ? (o.forcedBy.id ?? o.forcedBy.kind) : null,
      forced_reason: o.reason ?? null,
      expires_at: expiresAt,
      used_at: null,
      requested_ip: o.client?.ip ?? null,
      created_at: now,
    });
    await this.securityEvent(repo, a.id, 'password_reset_requested', 'completed', { client: o.client, actor: o.forcedBy ?? null, reason: o.reason ?? null, detail: { forced: Boolean(o.forcedBy) } });
    return () => this.publish('identity.password_reset.requested', { accountId: a.id, email: a.email, resetUrl: this.resetUrl(a.realm, token), expiresAt: map.iso(expiresAt), forcedBy: o.forcedBy ?? null });
  }

  /** POST /password-resets: always 202 with the masked email */
  async requestPasswordReset(email: string, caller: Caller): Promise<{ emailMasked: string; expiresInMinutes: number; resendAvailableAt: string }> {
    const s = await this.cfg();
    const now = this.now();
    const normalized = normalizeEmail(email);
    const accounts = (await this.repo.findAccountsByEmail(normalized)).filter((a) => ['active', 'locked', 'pending_verification'].includes(a.status) && a.password_hash);
    const afters: (() => void)[] = [];
    for (const a of accounts) {
      const last = await this.repo.latestReset(a.id);
      if (last && now.getTime() - last.created_at.getTime() < s.codeResendSeconds * 1000) continue; // resend timer: same answer, no new link
      afters.push(await this.repo.transaction((repo) => this.issueReset(repo, a, { client: caller.client }, s, now)));
    }
    for (const f of afters) f();
    return { emailMasked: maskEmail(email.trim()), expiresInMinutes: s.passwordResetTtlMinutes, resendAvailableAt: map.iso(new Date(now.getTime() + s.codeResendSeconds * 1000)) };
  }

  private async liveReset(repo: IdentityRepository, token: string, now: Date, forUpdate = false) {
    if (typeof token !== 'string' || token.length < 20) return undefined;
    const r = await repo.findResetByHash(tokenHash(token), { forUpdate });
    if (!r || r.used_at || r.expires_at <= now) return undefined;
    const a = await repo.getAccount(r.account_id, { forUpdate });
    if (!a || ['disabled', 'closed', 'invited'].includes(a.status)) return undefined;
    return { reset: r, account: a };
  }

  /** POST /password-resets/lookups */
  async getPasswordReset(token: string): Promise<PasswordResetStatus> {
    const s = await this.cfg();
    const found = await this.liveReset(this.repo, token, this.now());
    if (!found) return { valid: false, emailMasked: null, expiresAt: null, policy: this.policyFor('member', s), forced: false };
    return { valid: true, emailMasked: maskEmail(found.account.email), expiresAt: map.iso(found.reset.expires_at), policy: this.policyFor(found.account.realm, s), forced: found.reset.forced_by !== null };
  }

  /** POST /password-resets/complete */
  async completePasswordReset(body: CompleteResetRequest, caller: Caller): Promise<void> {
    const s = await this.cfg();
    const now = this.now();
    const peek = await this.liveReset(this.repo, body.token, now);
    if (!peek) throw new AppError('RESET_LINK_INVALID', 'This reset link was used, replaced or has expired');
    const [first, ...rest] = peek.account.display_name.split(' ');
    this.assertStrong(body.newPassword, peek.account.realm, [peek.account.email, first, rest.join(' ')], s);
    await this.assertNotReused(peek.account.id, body.newPassword, s.passwordHistoryCount);
    const hash = await hashPassword(body.newPassword);
    const out = await this.repo.transaction(async (repo) => {
      const found = await this.liveReset(repo, body.token, now, true);
      if (!found) throw new AppError('RESET_LINK_INVALID', 'This reset link was used, replaced or has expired');
      const { reset, account } = found;
      const forced = reset.forced_by !== null || account.must_reset_password;
      await repo.updateReset(reset.id, { used_at: now });
      await repo.invalidateResets(account.id, now);
      // clears automatic lockouts (failed sign-ins); a lock set by staff stays until staff unlock it
      const autoLocked = account.status === 'locked' && !account.locked_by;
      await this.storePassword(repo, account.id, hash, now, {
        must_reset_password: false,
        failed_sign_ins: 0,
        failed_window_started_at: null,
        ...(autoLocked ? { status: accountStatusMachine.next('locked', 'unlock'), locked_until: null, lock_reason: null } : {}),
      });
      const signOut = forced || body.signOutOtherDevices;
      if (signOut) await this.revoke(repo, { accountId: account.id }, 'passwordChanged', now, true);
      await this.securityEvent(repo, account.id, 'password_reset_completed', 'completed', { client: caller.client, detail: { forced, signedOutOthers: signOut } });
      return { account, forced, signOut };
    });
    this.publish('identity.password.changed', { accountId: out.account.id, realm: out.account.realm, via: out.forced ? 'forced_reset' : 'reset', otherSessionsRevoked: out.signOut, at: map.iso(now) }, caller);
  }

  /** GET /password-policy */
  async getPasswordPolicy(realm?: Realm | null): Promise<PasswordPolicy> {
    return this.policyFor(realm ?? 'member', await this.cfg());
  }

  /* ================================================================ public: invitations */

  private invitationUrl(i: Pick<InvitationRow, 'purpose'>, token: string) {
    return `${this.appUrl(i.purpose === 'staff' ? 'admin' : 'seller')}/invitation#token=${token}`;
  }

  private invitationCreated(i: InvitationRow, token: string, by?: { actor?: common.Actor; requestId?: string }) {
    this.publish(
      'identity.invitation.created',
      {
        invitationId: i.id,
        purpose: i.purpose,
        email: i.email,
        name: i.name,
        acceptUrl: this.invitationUrl(i, token),
        contextRef: i.context_ref,
        contextLabel: i.context_label,
        invitedBy: map.actorOfRow(i.invited_by_kind, i.invited_by_id) ?? { kind: 'system' },
        expiresAt: map.iso(i.expires_at),
      },
      by,
    );
  }

  private async liveInvitation(repo: IdentityRepository, token: string, now: Date, forUpdate = false) {
    const i = typeof token === 'string' && token.length >= 20 ? await repo.findInvitationByHash(tokenHash(token), { forUpdate }) : undefined;
    if (!i || i.status !== 'pending' || i.expires_at <= now) throw new AppError('INVITATION_INVALID', 'This invitation was accepted, cancelled or has expired');
    return i;
  }

  /** The account an invitation is for, if it has one already */
  private async invitedAccount(repo: IdentityRepository, i: InvitationRow, forUpdate = false) {
    if (i.account_id) return repo.getAccount(i.account_id, { forUpdate });
    return repo.findAccount(i.realm as Realm, normalizeEmail(i.email), { forUpdate });
  }

  /** POST /invitations/lookups */
  async getInvitation(token: string): Promise<InvitationView> {
    const s = await this.cfg();
    const now = this.now();
    const i = await this.liveInvitation(this.repo, token, now);
    const a = await this.invitedAccount(this.repo, i);
    return {
      purpose: i.purpose,
      emailMasked: maskEmail(i.email),
      name: i.name,
      contextLabel: i.context_label,
      existingAccount: i.purpose === 'seller_member' && Boolean(a?.password_hash) && a?.status !== 'invited',
      requiresTwoStepSetup: i.purpose === 'staff' && s.staffTwoStepRequired,
      policy: this.policyFor(i.realm as Realm, s),
      expiresAt: map.iso(i.expires_at),
    };
  }

  /** A pending 2-step (TOTP) set-up for an account */
  private async newTotpSetup(repo: IdentityRepository, a: AccountRow, payload: Record<string, unknown>, s: { verificationCodeTtlMinutes: number; maxCodeAttempts: number }, now: Date): Promise<TwoStepSetup> {
    await repo.supersedeChallenges(a.id, 'two_step_setup');
    const secret = newTotpSecret();
    const b32 = base32Encode(secret);
    const row: ChallengeRow = {
      id: newId(),
      account_id: a.id,
      purpose: 'two_step_setup',
      target_email: null,
      code_hash: null,
      payload: { ...payload, method: 'totp', secret: this.keys.encrypt(secret).toString('base64') } as never,
      attempts: 0,
      max_attempts: s.maxCodeAttempts,
      status: 'pending',
      expires_at: new Date(now.getTime() + Math.max(s.verificationCodeTtlMinutes, 15) * MIN),
      resend_available_at: null,
      created_at: now,
      completed_at: null,
      target_phone_encrypted: null,
    };
    await repo.insertChallenge(row);
    return { setupId: row.id, method: 'totp', otpauthUri: otpauthUri(b32, a.email), manualEntryKey: groupKey(b32), phoneMasked: null, expiresAt: map.iso(row.expires_at) };
  }

  /** POST /invitations/accept */
  async acceptInvitation(body: AcceptInvitationRequest, caller: Caller): Promise<WithCookie<AcceptInvitationResult>> {
    const s = await this.cfg();
    const now = this.now();
    const peek = await this.liveInvitation(this.repo, body.token, now);
    const peekAccount = await this.invitedAccount(this.repo, peek);
    const existingMember = peek.purpose === 'seller_member' && peekAccount && peekAccount.password_hash && peekAccount.status !== 'invited' ? peekAccount : undefined;
    const name = body.name?.trim() || peek.name;
    let hash: string | null = null;
    if (existingMember) {
      if (!body.currentPassword) throw new AppError('VALIDATION_FAILED', 'Enter your current password', issue('body.currentPassword', 'required for an existing account'));
    } else {
      if (!body.password) throw new AppError('VALIDATION_FAILED', 'Choose a password', issue('body.password', 'required'));
      const [first, ...rest] = name.split(' ');
      this.assertStrong(body.password, peek.realm as Realm, [peek.email, first, rest.join(' ')], s);
      hash = await hashPassword(body.password);
    }
    const passwordOk = existingMember ? await verifyPassword(existingMember.password_hash, body.currentPassword!) : true;
    let after = () => {};
    const web = body.device.kind === 'web';
    const outcome = await this.repo.transaction(async (repo): Promise<{ error: AppError } | { result: AcceptInvitationResult }> => {
      const i = await this.liveInvitation(repo, body.token, now, true);
      let a = await this.invitedAccount(repo, i, true);

      if (i.purpose === 'staff') {
        if (!a || a.status !== 'invited') throw new AppError('INVITATION_INVALID', 'This invitation is no longer valid');
        a = await this.storePassword(repo, a.id, hash!, now, { display_name: name });
        if (s.staffTwoStepRequired) {
          const setup = await this.newTotpSetup(repo, a, { invitationId: i.id }, s, now);
          return { result: { status: 'two_step_setup_required', account: await this.summaryOf(a, repo), tokens: null, twoStepSetup: setup } };
        }
        a = await repo.updateAccount(a.id, { status: accountStatusMachine.next('invited', 'acceptInvitation'), email_verified_at: now });
        await repo.updateInvitation(i.id, { status: invitationMachine.next('pending', 'accept'), accepted_at: now, account_id: a.id });
        const done = await this.completeSignIn(repo, a, { audience: 'admin', device: body.device, client: caller.client, keepSignedIn: false, twoStepVerified: false, method: 'invitation' }, s, now);
        after = () => {
          this.publish('identity.invitation.accepted', { invitationId: i.id, accountId: a!.id, purpose: i.purpose, contextRef: i.context_ref }, caller);
          done.after();
        };
        return { result: { status: 'signed_in', account: done.result.account!, tokens: done.result.tokens, twoStepSetup: null } };
      }

      // seller member: an existing member account confirms with its password; otherwise one is created
      if (existingMember) {
        if (!passwordOk) {
          const f = await this.countFailure(repo, a!, s, now, { client: caller.client, audience: 'seller', reason: 'password' });
          after = f.after;
          return { error: new AppError('INVALID_CREDENTIALS', "That password doesn't match this account", { attemptsLeft: f.attemptsLeft }) };
        }
        a = await this.liftExpiredLock(repo, a!, now);
        if (lockInForce(a, now)) return { error: this.lockedError(a) };
        if (a.status === 'disabled') return { error: new AppError('ACCOUNT_DISABLED', 'This account is disabled') };
        if (a.status === 'pending_verification') a = await repo.updateAccount(a.id, { status: accountStatusMachine.next('pending_verification', 'verifyEmail'), email_verified_at: now });
      } else if (a && a.status === 'pending_verification') {
        // an unconfirmed registration with this email: the invitation link proves the address
        a = await this.storePassword(repo, a.id, hash!, now, { display_name: name, status: accountStatusMachine.next('pending_verification', 'verifyEmail'), email_verified_at: now });
      } else if (!a) {
        a = {
          id: newId(),
          realm: 'member',
          email: i.email,
          email_normalized: normalizeEmail(i.email),
          email_verified_at: now,
          display_name: name,
          status: accountStatusMachine.next(accountStatusMachine.initial, 'verifyEmail'),
          password_hash: hash,
          password_changed_at: now,
          must_reset_password: false,
          failed_sign_ins: 0,
          failed_window_started_at: null,
          locked_until: null,
          lock_reason: null,
          locked_by: null,
          closed_at: null,
          accepted_terms_version: null,
          created_at: now,
          last_sign_in_at: null,
          last_active_at: null,
          version: 1,
          tokens_valid_after: null,
        };
        await repo.insertAccount(a);
        await repo.addPasswordHistory({ id: newId(), account_id: a.id, password_hash: hash!, created_at: now });
      } else {
        return { error: new AppError('INVITATION_INVALID', 'This invitation is no longer valid') };
      }
      const account = a;
      await repo.updateInvitation(i.id, { status: invitationMachine.next('pending', 'accept'), accepted_at: now, account_id: account.id });
      // seller access arrives when sellers consumes identity.invitation.accepted (grantSellerContext);
      // until then the session has no seller and the app picks it with POST /session/seller-context
      const access = i.context_ref ? await repo.getSellerAccess(account.id, i.context_ref) : undefined;
      const opened = await this.openSession(
        repo,
        account,
        { audience: 'seller', device: body.device, client: caller.client, keepSignedIn: false, twoStepVerified: false, seller: access && !access.revoked_at ? access : null, method: 'invitation' },
        s,
        now,
      );
      after = () => {
        this.publish('identity.invitation.accepted', { invitationId: i.id, accountId: account.id, purpose: i.purpose, contextRef: i.context_ref }, caller);
        opened.after();
      };
      const fresh = (await repo.getAccount(account.id))!;
      return { result: { status: 'signed_in', account: await this.summaryOf(fresh, repo), tokens: this.sessionTokens(opened.session, opened.refreshToken, s), twoStepSetup: null } };
    });
    after();
    if ('error' in outcome) throw outcome.error;
    return this.deliver(outcome.result, web, now);
  }

  /** New recovery codes for an account (replacing any earlier batch) */
  private async newRecoveryCodes(repo: IdentityRepository, accountId: string, now: Date): Promise<RecoveryCodes> {
    const batch = newId();
    const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    await repo.replaceRecoveryCodes(
      accountId,
      codes.map((c) => ({ id: newId(), account_id: accountId, code_hash: this.recoveryHash(accountId, c), batch_id: batch, used_at: null })),
    );
    return { codes, generatedAt: map.iso(now) };
  }

  /** Confirms a pending set-up with its first code; returns the new method, or the error to throw */
  private async confirmSetup(repo: IdentityRepository, c: ChallengeRow, a: AccountRow, code: string, now: Date): Promise<TwoStepMethodRow | AppError> {
    const p = (c.payload ?? {}) as Record<string, unknown>;
    let row: TwoStepMethodRow;
    if (p.method === 'sms') {
      if (!c.code_hash || !safeEqual(c.code_hash, this.codeHash(c.id, code))) return this.wrongCode(repo, c);
      row = { id: newId(), account_id: a.id, method: 'sms', secret_encrypted: null, phone_e164_encrypted: c.target_phone_encrypted, phone_masked: (p.phoneMasked as string) ?? null, confirmed_at: now, last_used_at: now, last_used_step: null, removed_at: null };
    } else {
      const sealed = Buffer.from(String(p.secret ?? ''), 'base64');
      const step = verifyTotp(this.keys.decrypt(sealed), code, now, null);
      if (step === null) return this.wrongCode(repo, c);
      row = { id: newId(), account_id: a.id, method: 'totp', secret_encrypted: sealed, phone_e164_encrypted: null, phone_masked: null, confirmed_at: now, last_used_at: now, last_used_step: step, removed_at: null };
    }
    // one method of each kind: a new authenticator replaces the old one
    for (const m of await repo.activeMethods([a.id])) if (m.method === row.method) await repo.updateMethod(m.id, { removed_at: now });
    await repo.insertMethod(row);
    await repo.updateChallenge(c.id, { status: 'completed', completed_at: now });
    return row;
  }

  /** POST /invitations/two-step: staff confirm the authenticator and get their first session */
  async confirmInvitationTwoStep(body: { token: string; setupId: string; code: string; device: DeviceInfo }, caller: Caller): Promise<WithCookie<{ tokens: SessionTokens; recoveryCodes: RecoveryCodes }>> {
    const s = await this.cfg();
    const now = this.now();
    let after = () => {};
    const outcome = await this.repo.transaction(async (repo): Promise<{ error: AppError } | { result: { tokens: SessionTokens; recoveryCodes: RecoveryCodes } }> => {
      const i = await this.liveInvitation(repo, body.token, now, true);
      if (i.purpose !== 'staff') throw new AppError('INVITATION_INVALID', 'This invitation does not need 2-step set-up');
      let a = await this.invitedAccount(repo, i, true);
      if (!a || a.status !== 'invited' || !a.password_hash) throw new AppError('INVITATION_INVALID', 'Accept the invitation and choose a password first');
      const c = isUuid(body.setupId) ? await repo.getChallenge(body.setupId, { forUpdate: true }) : undefined;
      if (!c || c.purpose !== 'two_step_setup' || c.account_id !== a.id) throw new AppError('CODE_EXPIRED', 'This set-up has expired; accept the invitation again');
      if (c.status !== 'pending' || c.expires_at <= now) throw new AppError('CODE_EXPIRED', 'This set-up has expired; accept the invitation again');
      const method = await this.confirmSetup(repo, c, a, body.code, now);
      if (method instanceof AppError) return { error: method.code === 'CHALLENGE_LOCKED' ? new AppError('CODE_EXPIRED', 'Too many wrong codes; accept the invitation again') : method };
      const recoveryCodes = await this.newRecoveryCodes(repo, a.id, now);
      a = await repo.updateAccount(a.id, { status: accountStatusMachine.next('invited', 'acceptInvitation'), email_verified_at: now });
      await repo.updateInvitation(i.id, { status: invitationMachine.next('pending', 'accept'), accepted_at: now, account_id: a.id });
      await this.securityEvent(repo, a.id, 'two_step_enabled', 'completed', { client: caller.client, detail: { method: 'totp' } });
      const opened = await this.openSession(repo, a, { audience: 'admin', device: body.device, client: caller.client, keepSignedIn: false, twoStepVerified: true, method: 'invitation' }, s, now);
      const self: common.Actor = { kind: 'staff', id: a.id };
      after = () => {
        this.publish('identity.two_step.changed', { accountId: a!.id, enabled: true, method: 'totp', by: self }, caller);
        this.publish('identity.invitation.accepted', { invitationId: i.id, accountId: a!.id, purpose: i.purpose, contextRef: i.context_ref }, caller);
        opened.after();
      };
      return { result: { tokens: this.sessionTokens(opened.session, opened.refreshToken, s), recoveryCodes } };
    });
    after();
    if ('error' in outcome) throw outcome.error;
    return this.deliver(outcome.result, body.device.kind === 'web', now);
  }

  /** Public API: invite a staff member (access assigns the roles) */
  async inviteStaff(input: { email: string; name: string; invitedBy: common.Actor }): Promise<Invitation> {
    const s = await this.cfg();
    const now = this.now();
    const email = normalizeEmail(input.email);
    const token = randomToken();
    const row = await this.repo.transaction(async (repo) => {
      let a = await repo.findAccount('staff', email, { forUpdate: true });
      if (a && a.status !== 'invited') throw new AppError('EMAIL_IN_USE', 'A staff account already uses that email');
      if (!a) {
        a = {
          id: newId(),
          realm: 'staff',
          email: input.email.trim(),
          email_normalized: email,
          email_verified_at: null,
          display_name: input.name.trim(),
          status: 'invited',
          password_hash: null,
          password_changed_at: null,
          must_reset_password: false,
          failed_sign_ins: 0,
          failed_window_started_at: null,
          locked_until: null,
          lock_reason: null,
          locked_by: null,
          closed_at: null,
          accepted_terms_version: null,
          created_at: now,
          last_sign_in_at: null,
          last_active_at: null,
          version: 1,
          tokens_valid_after: null,
        };
        await repo.insertAccount(a);
      }
      await repo.revokePendingInvitations({ email: a.email, purpose: 'staff', contextRef: null }, 'replaced', now);
      const i: InvitationRow = {
        id: newId(),
        realm: 'staff',
        purpose: 'staff',
        email: a.email,
        name: input.name.trim(),
        account_id: a.id,
        context_ref: null,
        context_label: null,
        token_hash: tokenHash(token),
        invited_by_kind: input.invitedBy.kind,
        invited_by_id: input.invitedBy.id ?? '',
        status: invitationMachine.initial,
        sent_at: now,
        expires_at: new Date(now.getTime() + s.invitationTtlDays * DAY),
        accepted_at: null,
        revoked_at: null,
        revoke_reason: null,
      };
      await repo.insertInvitation(i);
      return i;
    });
    this.invitationCreated(row, token, { actor: input.invitedBy });
    return map.invitation(row, now);
  }

  /** Public API: invite a person to act for a seller (reuses their member account) */
  async inviteSellerMember(input: { email: string; name: string; sellerId: string; sellerName: string; invitedBy: common.Actor }): Promise<Invitation> {
    const s = await this.cfg();
    const now = this.now();
    const token = randomToken();
    const email = normalizeEmail(input.email);
    const row = await this.repo.transaction(async (repo) => {
      const a = await repo.findAccount('member', email);
      await repo.revokePendingInvitations({ email: a?.email ?? input.email.trim(), purpose: 'seller_member', contextRef: input.sellerId }, 'replaced', now);
      const i: InvitationRow = {
        id: newId(),
        realm: 'member',
        purpose: 'seller_member',
        email: a?.email ?? input.email.trim(),
        name: input.name.trim(),
        account_id: a?.id ?? null,
        context_ref: input.sellerId,
        context_label: input.sellerName,
        token_hash: tokenHash(token),
        invited_by_kind: input.invitedBy.kind,
        invited_by_id: input.invitedBy.id ?? '',
        status: invitationMachine.initial,
        sent_at: now,
        expires_at: new Date(now.getTime() + s.invitationTtlDays * DAY),
        accepted_at: null,
        revoked_at: null,
        revoke_reason: null,
      };
      await repo.insertInvitation(i);
      return i;
    });
    this.invitationCreated(row, token, { actor: input.invitedBy });
    return map.invitation(row, now);
  }

  /* ================================================================ public: guest sessions and order links */

  private async guestSession(g: GuestSessionRow, repo: IdentityRepository = this.repo): Promise<GuestSession> {
    return { id: g.id, createdAt: map.iso(g.created_at), expiresAt: map.iso(g.expires_at), orderIds: await repo.liveGrantOrderIds(g.id, this.now()) };
  }

  private liveGuest(g: GuestSessionRow | undefined, now: Date) {
    return g && !g.claimed_by_account_id && g.expires_at > now ? g : undefined;
  }

  /** Public API: let a guest session open one order */
  async grantGuestOrderAccess(guestSessionId: string, orderId: string, email: string, via: 'checkout' | 'lookup' | 'link'): Promise<GuestSession> {
    const s = await this.cfg();
    const now = this.now();
    const g = isUuid(guestSessionId) ? this.liveGuest(await this.repo.getGuestSession(guestSessionId), now) : undefined;
    if (!g) throw new AppError('NOT_FOUND', 'Guest session not found');
    await this.repo.upsertGrant({ guest_session_id: g.id, order_id: orderId, email_normalized: normalizeEmail(email), via, granted_at: now, expires_at: new Date(now.getTime() + s.guestOrderAccessDays * DAY) });
    await this.repo.updateGuestSession(g.id, { last_seen_at: now });
    return this.guestSession(g);
  }

  /** Public API: whether a guest session may open an order */
  async hasGuestOrderAccess(guestSessionId: string, orderId: string): Promise<boolean> {
    if (!isUuid(guestSessionId) || !isUuid(orderId)) return false;
    const now = this.now();
    const g = this.liveGuest(await this.repo.getGuestSession(guestSessionId), now);
    return Boolean(g) && (await this.repo.hasLiveGrant(guestSessionId, orderId, now));
  }

  /** Public API: emailed order link (token in the fragment; redeemed in the body) */
  async issueOrderLink(orderId: string, email: string): Promise<{ url: string; expiresAt: string }> {
    const s = await this.cfg();
    const now = this.now();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + s.orderLinkTtlDays * DAY);
    await this.repo.insertOrderLink({ id: newId(), token_hash: tokenHash(token), order_id: orderId, email_normalized: normalizeEmail(email), expires_at: expiresAt, last_redeemed_at: null, redeem_count: 0 });
    return { url: `${this.appUrl('store')}/orders/open#token=${token}`, expiresAt: map.iso(expiresAt) };
  }

  /** POST /order-links/redeem: grants the caller's visitor session (or a new guest session) the order */
  async redeemOrderLink(token: string, caller: Caller): Promise<OrderLinkRedemption> {
    const s = await this.cfg();
    const now = this.now();
    return this.repo.transaction(async (repo) => {
      const link = typeof token === 'string' && token.length >= 20 ? await repo.findOrderLinkByHash(tokenHash(token), { forUpdate: true }) : undefined;
      if (!link || link.expires_at <= now) throw new AppError('ORDER_LINK_INVALID', 'This order link has expired; use Guest order lookup');
      const p = caller.principal;
      let g = p?.kind === 'visitor' && p.audience === 'store' && isUuid(p.sessionId) ? this.liveGuest(await repo.getGuestSession(p.sessionId, { forUpdate: true }), now) : undefined;
      if (!g) {
        g = {
          id: newId(),
          device_kind: 'web',
          created_at: now,
          last_seen_at: now,
          expires_at: new Date(now.getTime() + s.guestSessionTtlDays * DAY),
          claimed_by_account_id: null,
          claimed_at: null,
          audience: 'store',
          refresh_token_hash: tokenHash(randomToken('v.')),
          previous_token_hash: null,
          rotated_at: null,
        };
        await repo.insertGuestSession(g);
      }
      await repo.upsertGrant({ guest_session_id: g.id, order_id: link.order_id, email_normalized: link.email_normalized, via: 'link', granted_at: now, expires_at: new Date(now.getTime() + s.guestOrderAccessDays * DAY) });
      await repo.updateOrderLink(link.id, { last_redeemed_at: now, redeem_count: link.redeem_count + 1 });
      return { guestSession: await this.guestSession(g, repo), orderId: link.order_id, emailMasked: maskEmail(link.email_normalized) };
    });
  }

  /* ================================================================ store: account security */

  /** Batched security view of accounts (admin detail, customer 360, own security page) */
  private async securityOf(ids: string[], activityLimit: number, since?: Date) {
    const now = this.now();
    const [accounts, methods, recovery, devices, sellers, invitations, events, pendingEmails] = await Promise.all([
      this.repo.getAccounts(ids),
      this.repo.activeMethods(ids),
      this.repo.remainingRecoveryCodes(ids),
      this.repo.devicesOf(ids, now),
      this.repo.activeSellerAccessOf(ids),
      this.repo.latestInvitations(ids),
      this.repo.recentSecurityEvents(ids, activityLimit, since),
      this.repo.pendingEmailChanges(ids, now),
    ]);
    const out = new Map<string, { account: AccountRow; methods: TwoStepMethodRow[]; recovery: number; devices: DeviceWithSessions[]; sellers: SellerAccessRow[]; invitation?: InvitationRow; events: SecurityEventRow[]; pendingEmail?: string }>();
    for (const a of accounts) {
      out.set(a.id, {
        account: a,
        methods: methods.filter((m) => m.account_id === a.id),
        recovery: recovery.get(a.id) ?? 0,
        devices: devices.get(a.id) ?? [],
        sellers: sellers.get(a.id) ?? [],
        invitation: invitations.get(a.id),
        events: events.get(a.id) ?? [],
        pendingEmail: pendingEmails.get(a.id),
      });
    }
    return out;
  }

  private warnings(a: AccountRow, methods: TwoStepMethodRow[], recovery: number, events: SecurityEventRow[], now: Date): SecurityWarning[] {
    const w: SecurityWarning[] = [];
    if (!methods.length) w.push({ code: 'two_step_off', message: '2-step verification is off. Turn it on to protect your account.' });
    else if (recovery < 3) w.push({ code: 'recovery_codes_low', message: recovery ? `Only ${recovery} recovery codes left. Create new ones.` : 'No recovery codes left. Create new ones.' });
    if (a.password_changed_at && now.getTime() - a.password_changed_at.getTime() > 365 * DAY) w.push({ code: 'password_old', message: 'Your password is more than a year old.' });
    const newDevice = events.find((e) => e.kind === 'signed_in_new_device' && now.getTime() - e.at.getTime() < 7 * DAY);
    if (newDevice) w.push({ code: 'unrecognised_sign_in', message: `New sign-in from ${newDevice.device_label ?? 'a new device'}. If this wasn't you, sign out everywhere and change your password.` });
    return w;
  }

  /** GET /security */
  async getSecurity(principal: KernelPrincipal): Promise<SecurityOverview> {
    const s = await this.cfg();
    const a = await this.accountOf(principal);
    const now = this.now();
    const sec = (await this.securityOf([a.id], 10, new Date(now.getTime() - 30 * DAY))).get(a.id)!;
    return {
      account: map.accountSummary(a, sec.methods.length > 0, now),
      passwordChangedAt: map.isoOrNull(a.password_changed_at),
      email: { address: a.email, verifiedAt: map.isoOrNull(a.email_verified_at), pendingChangeTo: sec.pendingEmail ?? null },
      twoStep: map.twoStepStatus(a.realm, sec.methods, sec.recovery, s.staffTwoStepRequired),
      devices: sec.devices.map((d) => map.device(d, principal.sessionId)),
      recentActivity: sec.events.map(map.securityEvent),
      warnings: this.warnings(a, sec.methods, sec.recovery, sec.events, now),
    };
  }

  /**
   * Shared step-up check (re-auth, inline current password, approval codes): wrong answers count on
   * the sign-in failure counter and lock step-up (and sign-in) for lockoutMinutes at the limit.
   */
  private async stepUpCheck(accountId: string, proof: { password?: string | null; code?: string | null }, o: { client?: ClientInfo; audience?: Audience | null }): Promise<{ ok: true } | { ok: false; error: AppError }> {
    const s = await this.cfg();
    const now = this.now();
    const peek = await this.repo.getAccount(accountId);
    if (!peek) return { ok: false, error: new AppError('NOT_FOUND', 'Account not found') };
    const passwordOk = proof.password ? await verifyPassword(peek.password_hash, proof.password) : false;
    let after = () => {};
    const out = await this.repo.transaction(async (repo): Promise<{ ok: true } | { ok: false; error: AppError }> => {
      let a = (await repo.getAccount(accountId, { forUpdate: true }))!;
      a = await this.liftExpiredLock(repo, a, now);
      if (lockInForce(a, now)) return { ok: false, error: new AppError('RATE_LIMITED', 'Too many wrong answers; try again later', { lockedUntil: map.isoOrNull(a.locked_until) }) };
      const good = proof.password ? passwordOk : proof.code ? Boolean(await this.checkSecondFactor(repo, a, 'totp', proof.code, now)) : false;
      if (good) {
        if (a.failed_sign_ins) await repo.updateAccount(a.id, { failed_sign_ins: 0, failed_window_started_at: null });
        return { ok: true };
      }
      const f = await this.countFailure(repo, a, s, now, { client: o.client, audience: o.audience, reason: 'step_up' });
      after = f.after;
      if (f.locked) return { ok: false, error: new AppError('RATE_LIMITED', 'Too many wrong answers; try again later', { lockedUntil: map.iso(f.lockedUntil) }) };
      return {
        ok: false,
        error: proof.password
          ? new AppError('CURRENT_PASSWORD_WRONG', 'The current password is incorrect', { attemptsLeft: f.attemptsLeft })
          : new AppError('CODE_INVALID', 'That code is not right', { attemptsLeft: f.attemptsLeft }),
      };
    });
    after();
    return out;
  }

  private async requireStepUp(accountId: string, proof: { password?: string | null; code?: string | null }, o: { client?: ClientInfo; audience?: Audience | null }) {
    const r = await this.stepUpCheck(accountId, proof, o);
    if (!r.ok) throw r.error;
  }

  /** PUT /password */
  async changePassword(body: ChangePasswordRequest, caller: Caller): Promise<void> {
    const s = await this.cfg();
    const now = this.now();
    const a = await this.accountOf(caller.principal);
    await this.requireStepUp(a.id, { password: body.currentPassword }, { client: caller.client, audience: caller.principal?.audience });
    const [first, ...rest] = a.display_name.split(' ');
    this.assertStrong(body.newPassword, a.realm, [a.email, first, rest.join(' ')], s);
    await this.assertNotReused(a.id, body.newPassword, s.passwordHistoryCount);
    const hash = await hashPassword(body.newPassword);
    await this.repo.transaction(async (repo) => {
      await this.storePassword(repo, a.id, hash, now, { must_reset_password: false });
      if (body.signOutOtherDevices) await this.revoke(repo, { accountId: a.id, exceptSessionId: caller.principal?.sessionId }, 'passwordChanged', now);
      await this.securityEvent(repo, a.id, 'password_changed', 'completed', { client: caller.client, audience: caller.principal?.audience, detail: { signedOutOthers: body.signOutOtherDevices } });
    });
    this.publish('identity.password.changed', { accountId: a.id, realm: a.realm, via: 'change', otherSessionsRevoked: body.signOutOtherDevices, at: map.iso(now) }, caller);
  }

  /** POST /email-changes (re-auth step-up already verified by the middleware) */
  async requestEmailChange(newEmail: string, caller: Caller): Promise<VerificationChallenge> {
    const s = await this.cfg();
    const now = this.now();
    const a = await this.accountOf(caller.principal);
    const normalized = normalizeEmail(newEmail);
    if (normalized === a.email_normalized) throw new AppError('VALIDATION_FAILED', 'That is already your sign-in email', issue('body.newEmail', 'same as the current email'));
    const taken = await this.repo.findAccount(a.realm, normalized);
    if (taken) throw new AppError('EMAIL_IN_USE', 'Another account uses that email');
    const out = await this.repo.transaction(async (repo) => {
      await repo.supersedeChallenges(a.id, 'email_change'); // a new change supersedes the previous one
      return this.newEmailCode(repo, { accountId: a.id, purpose: 'email_change', email: newEmail.trim() }, s, now);
    });
    this.codeIssued(out.row, out.code, 'email', out.row.target_email!);
    return map.verificationChallenge(out.row);
  }

  private reauthPrefix(p: Pick<KernelPrincipal, 'sellerId'> | Pick<Principal, 'sellerId'>) {
    return `ra.${p.sellerId ?? '-'}.`;
  }

  /**
   * POST /reauth (store), POST /api/seller/identity/reauth and POST /api/admin/identity/reauth:
   * a single-use proof bound to the account, the session (and so the audience), the seller context
   * (none before a seller is chosen) and the step-up purpose of the endpoint that will consume it.
   */
  async reauthenticate(body: ReauthRequest, caller: Caller): Promise<ReauthToken> {
    const p = caller.principal;
    const a = await this.accountOf(p);
    const purpose = body.purpose;
    if (!isReauthPurpose(purpose)) throw new AppError('VALIDATION_FAILED', 'Say which action this confirmation is for', issue('body.purpose', 'a step-up purpose such as payout-account'));
    if (!body.password && !body.code) throw new AppError('VALIDATION_FAILED', 'Enter your password or a 2-step code', issue('body.password', 'password or code required'));
    const s = await this.cfg();
    await this.requireStepUp(a.id, { password: body.password ?? null, code: body.password ? null : body.code }, { client: caller.client, audience: p?.audience });
    const session = p?.sessionId && isUuid(p.sessionId) ? await this.repo.getSession(p.sessionId) : undefined;
    if (!session || session.account_id !== a.id || session.revoked_at) throw new AppError('NOT_FOUND', 'Session not found');
    const now = this.now();
    const token = randomToken(this.reauthPrefix(p!));
    const expiresAt = new Date(now.getTime() + s.reauthTokenMinutes * MIN);
    await this.repo.insertReauthToken({ token_hash: tokenHash(token), account_id: a.id, session_id: session.id, purpose, expires_at: expiresAt, used_at: null });
    if (p?.kind === 'seller') {
      await this.audit({ action: 'identity.reauth.seller', actionLabel: 'Confirmed identity for a sensitive Seller Center action', target: { type: 'account', id: a.id, label: a.display_name, sellerId: p.sellerId ?? null }, afterText: `For: ${purpose}`, visibleToSeller: Boolean(p.sellerId) }, caller);
    } else if (p?.kind === 'staff') {
      await this.audit({ action: 'identity.reauth.staff', actionLabel: 'Confirmed identity for a sensitive Admin Center action', target: { type: 'account', id: a.id, label: a.display_name }, afterText: `For: ${purpose}` }, caller);
    }
    return { reauthToken: token, expiresAt: map.iso(expiresAt) };
  }

  /** Public API (middleware): is this re-auth token valid for this principal and this purpose? Does not consume it. */
  async verifyReauthToken(principal: Principal, token: string, purpose: string): Promise<boolean> {
    if (typeof token !== 'string' || typeof purpose !== 'string' || !principal.accountId || !principal.sessionId) return false;
    if (!token.startsWith(this.reauthPrefix(principal))) return false;
    const r = await this.repo.getReauthToken(tokenHash(token));
    return Boolean(
      r && !r.used_at && r.purpose === purpose && r.expires_at > this.now() && r.account_id === principal.accountId && r.session_id === principal.sessionId,
    );
  }

  /** Public API (kernel, before the handler): claims the token for one request; false when another request already has */
  async consumeReauthToken(token: string): Promise<boolean> {
    if (typeof token !== 'string') return false;
    return this.repo.markReauthUsed(tokenHash(token), this.now());
  }

  /** Public API (kernel): the request that claimed the token failed, so it can be used again */
  async releaseReauthToken(token: string): Promise<void> {
    if (typeof token !== 'string') return;
    await this.repo.clearReauthUsed(tokenHash(token));
  }

  /** Public API: password or 2-step code check before a sensitive action */
  async verifyStepUp(accountId: string, proof: { password?: string; code?: string }): Promise<boolean> {
    if (!isUuid(accountId) || (!proof.password && !proof.code)) return false;
    const r = await this.stepUpCheck(accountId, proof, {});
    return r.ok;
  }

  /** POST /two-step/setups */
  async startTwoStepSetup(body: TwoStepSetupRequest, caller: Caller): Promise<TwoStepSetup> {
    const s = await this.cfg();
    const now = this.now();
    const a = await this.accountOf(caller.principal);
    if (body.method === 'sms') {
      if (this.ctx.config.launchPhase < 2) throw new AppError('METHOD_NOT_AVAILABLE', 'Text message codes are not available yet');
      if (!body.phone || !isE164(body.phone)) throw new AppError('VALIDATION_FAILED', 'Enter a mobile number in international format', issue('body.phone', 'E.164 number required for text messages'));
    }
    await this.requireStepUp(a.id, { password: body.currentPassword }, { client: caller.client, audience: caller.principal?.audience });
    if (body.method === 'totp') return this.repo.transaction((repo) => this.newTotpSetup(repo, a, { sessionId: caller.principal?.sessionId ?? null }, s, now));
    const phone = body.phone!;
    const out = await this.repo.transaction(async (repo) => {
      await repo.supersedeChallenges(a.id, 'two_step_setup');
      const id = newId();
      const code = sixDigitCode();
      const row: ChallengeRow = {
        id,
        account_id: a.id,
        purpose: 'two_step_setup',
        target_email: null,
        code_hash: this.codeHash(id, code),
        payload: { method: 'sms', phoneMasked: maskPhone(phone), sessionId: caller.principal?.sessionId ?? null } as never,
        attempts: 0,
        max_attempts: s.maxCodeAttempts,
        status: 'pending',
        expires_at: new Date(now.getTime() + s.verificationCodeTtlMinutes * MIN),
        resend_available_at: new Date(now.getTime() + s.codeResendSeconds * 1000),
        created_at: now,
        completed_at: null,
        target_phone_encrypted: this.keys.encrypt(Buffer.from(phone, 'utf8')),
      };
      await repo.insertChallenge(row);
      return { row, code };
    });
    this.codeIssued(out.row, out.code, 'sms', phone);
    return { setupId: out.row.id, method: 'sms', otpauthUri: null, manualEntryKey: null, phoneMasked: maskPhone(phone), expiresAt: map.iso(out.row.expires_at) };
  }

  /** POST /two-step/setups/{id}/confirm: returns recovery codes once */
  async confirmTwoStepSetup(id: string, code: string, caller: Caller): Promise<RecoveryCodes> {
    const now = this.now();
    const a = await this.accountOf(caller.principal);
    let method: TwoStepMethodRow | undefined;
    const outcome = await this.repo.transaction(async (repo): Promise<{ error: AppError } | { result: RecoveryCodes }> => {
      const c = await repo.getChallenge(id, { forUpdate: true });
      if (!c || c.purpose !== 'two_step_setup' || c.account_id !== a.id) throw new AppError('NOT_FOUND', 'Set-up not found');
      if (c.status !== 'pending' || c.expires_at <= now) throw new AppError('CODE_EXPIRED', 'This set-up has expired; start again');
      const m = await this.confirmSetup(repo, c, a, code, now);
      if (m instanceof AppError) return { error: m.code === 'CHALLENGE_LOCKED' ? new AppError('CODE_EXPIRED', 'Too many wrong codes; start again') : m };
      method = m;
      const codes = await this.newRecoveryCodes(repo, a.id, now);
      // this session has now passed 2-step: its next refresh carries twoStepAt (staff can then use Admin Center)
      const sid = caller.principal?.sessionId;
      if (sid && isUuid(sid)) {
        const session = await repo.getSession(sid);
        if (session && session.account_id === a.id) await repo.updateSession(sid, { two_step_verified_at: now });
      }
      await this.securityEvent(repo, a.id, 'two_step_enabled', 'completed', { client: caller.client, audience: caller.principal?.audience, detail: { method: m.method } });
      return { result: codes };
    });
    if ('error' in outcome) throw outcome.error;
    this.publish('identity.two_step.changed', { accountId: a.id, enabled: true, method: method!.method, by: caller.actor }, caller);
    return outcome.result;
  }

  private async twoStepStatusOf(a: AccountRow): Promise<TwoStepStatus> {
    const s = await this.cfg();
    const methods = await this.methodsOf(a.id);
    const recovery = (await this.repo.remainingRecoveryCodes([a.id])).get(a.id) ?? 0;
    return map.twoStepStatus(a.realm, methods, recovery, s.staffTwoStepRequired);
  }

  /** POST /two-step/methods/{id}/remove (re-auth verified by the middleware; a current 2-step code too) */
  async removeTwoStepMethod(id: string, code: string, caller: Caller): Promise<TwoStepStatus> {
    const s = await this.cfg();
    const now = this.now();
    const a = await this.accountOf(caller.principal);
    const methods = await this.methodsOf(a.id);
    const target = methods.find((m) => m.id === id);
    if (!target) throw new AppError('NOT_FOUND', '2-step method not found');
    if (a.realm === 'staff' && s.staffTwoStepRequired && methods.length <= 1) throw new AppError('TWO_STEP_REQUIRED', 'Staff accounts must keep at least one 2-step method');
    // the current authenticator code, or a recovery code (which also proves the second factor)
    const recoveryShaped = normalizeRecoveryCode(code).length === 10;
    const viaRecovery = recoveryShaped && (await this.repo.useRecoveryCode(a.id, this.recoveryHash(a.id, code), now));
    if (!viaRecovery) await this.requireStepUp(a.id, { code }, { client: caller.client, audience: caller.principal?.audience });
    const left = await this.repo.transaction(async (repo) => {
      await repo.updateMethod(target.id, { removed_at: now });
      const remaining = methods.filter((m) => m.id !== target.id);
      if (!remaining.length) {
        await repo.deleteRecoveryCodes(a.id);
        await repo.clearDeviceTrust(a.id);
      }
      await this.securityEvent(repo, a.id, 'two_step_disabled', 'completed', { client: caller.client, audience: caller.principal?.audience, detail: { method: target.method } });
      return remaining.length;
    });
    this.publish('identity.two_step.changed', { accountId: a.id, enabled: left > 0, method: target.method, by: caller.actor }, caller);
    return this.twoStepStatusOf(a);
  }

  /** POST /two-step/recovery-codes (re-auth verified by the middleware) */
  async regenerateRecoveryCodes(caller: Caller): Promise<RecoveryCodes> {
    const now = this.now();
    const a = await this.accountOf(caller.principal);
    if (!(await this.methodsOf(a.id)).length) throw new AppError('VALIDATION_FAILED', 'Turn on 2-step verification first', issue('twoStep', 'no 2-step method'));
    return this.repo.transaction(async (repo) => {
      const codes = await this.newRecoveryCodes(repo, a.id, now);
      await this.securityEvent(repo, a.id, 'recovery_codes_regenerated', 'completed', { client: caller.client, audience: caller.principal?.audience });
      return codes;
    });
  }

  /** GET /devices */
  async listDevices(principal: KernelPrincipal): Promise<Device[]> {
    const a = await this.accountOf(principal);
    const devices = (await this.repo.devicesOf([a.id], this.now())).get(a.id) ?? [];
    return devices.map((d) => map.device(d, principal.sessionId));
  }

  /** POST /devices/{id}/sign-out */
  async signOutDevice(deviceId: string, caller: Caller): Promise<void> {
    const now = this.now();
    const a = await this.accountOf(caller.principal);
    const d = await this.repo.getDevice(deviceId);
    if (!d || d.account_id !== a.id) throw new AppError('NOT_FOUND', 'Device not found');
    await this.repo.transaction(async (repo) => {
      const ids = await repo.revokeSessions({ accountId: a.id, deviceId: d.id }, 'revokeByUser', now);
      await repo.updateDevice(d.id, { two_step_trusted_until: null });
      await this.securityEvent(repo, a.id, 'signed_out', 'completed', { client: caller.client, device: d, detail: { device: d.label, sessions: ids.length } });
    });
  }

  /** POST /devices/sign-out-all */
  async signOutEverywhere(keepThisDevice: boolean, caller: Caller): Promise<{ sessionsRevoked: number }> {
    const now = this.now();
    const a = await this.accountOf(caller.principal);
    const n = await this.repo.transaction(async (repo) => {
      let except: string | null = null;
      if (keepThisDevice && caller.principal?.sessionId && isUuid(caller.principal.sessionId)) {
        const mine = await repo.getSession(caller.principal.sessionId);
        except = mine?.account_id === a.id ? mine.id : null;
      }
      const ids = await this.revoke(repo, { accountId: a.id, exceptSessionId: except }, 'revokeByUser', now, false);
      if (!except) await repo.clearDeviceTrust(a.id);
      await this.securityEvent(repo, a.id, 'signed_out_everywhere', 'completed', { client: caller.client, audience: caller.principal?.audience, detail: { sessions: ids.length, keptThisDevice: Boolean(except) } });
      return ids.length;
    });
    return { sessionsRevoked: n };
  }

  /** GET /security-activity */
  async listSecurityActivity(principal: KernelPrincipal, query: { days?: number | null; result?: string | null }, page: PageRequest): Promise<common.Page<SecurityEvent>> {
    const a = await this.accountOf(principal);
    const days = Math.min(Math.max(query.days ?? 30, 1), 365);
    const res = await this.repo.listSecurityEvents(a.id, { since: new Date(this.now().getTime() - days * DAY), result: query.result }, page);
    return { ...res, items: res.items.map(map.securityEvent) };
  }

  /* ================================================================ seller: context */

  /** GET /session/sellers */
  async listSellerContexts(principal: KernelPrincipal): Promise<SellerContext[]> {
    const id = principal.accountId;
    if (!id || !isUuid(id)) return [];
    return (await this.repo.activeSellerAccess(id)).map(map.sellerContext);
  }

  /** POST /session/seller-context: re-issues the session's tokens bound to the chosen seller */
  async switchSellerContext(sellerId: string, caller: Caller): Promise<WithCookie<SessionTokens>> {
    const s = await this.cfg();
    const now = this.now();
    const a = await this.accountOf(caller.principal);
    const sid = caller.principal?.sessionId;
    const out = await this.repo.transaction(async (repo) => {
      const session = sid && isUuid(sid) ? await repo.getSession(sid, { forUpdate: true }) : undefined;
      if (!session || session.account_id !== a.id || !this.sessionLive(session, s, now)) throw new AppError('NOT_FOUND', 'Session not found');
      const access = await repo.getSellerAccess(a.id, sellerId);
      if (!access || access.revoked_at) throw new AppError('NO_SELLER_ACCESS', 'You cannot act for that seller');
      // new refresh token; the old one simply stops working (it is not kept as "previous", so a
      // stale copy in another tab is refused (the middleware answers 401 UNAUTHORIZED token_invalid) instead of ending the session)
      const refreshToken = randomToken('s.');
      const patch = {
        seller_id: access.seller_id,
        seller_member_id: access.seller_member_id,
        refresh_token_hash: tokenHash(refreshToken),
        previous_token_hash: null,
        last_refreshed_at: now,
      };
      await repo.updateSession(session.id, patch);
      await repo.updateSellerAccess(a.id, access.seller_id, { last_used_at: now });
      const device = await repo.getDevice(session.device_id);
      await this.securityEvent(repo, a.id, 'seller_context_switched', 'completed', { audience: 'seller', device, client: caller.client, detail: { sellerName: access.seller_name } });
      return { tokens: this.sessionTokens({ ...session, ...patch }, refreshToken, s), web: device?.kind === 'web' };
    });
    const d = this.deliver({ tokens: out.tokens }, out.web, now);
    return { result: d.result.tokens!, cookie: d.cookie };
  }

  /* ================================================================ admin */

  /** Staff-realm records need identity.staff-accounts.manage as well (permissionWhen on the target's realm) */
  private async assertRealmAccess(a: AccountRow, can: (p: string) => Promise<boolean>) {
    if (a.realm === 'staff' && !(await can('identity.staff-accounts.manage'))) throw new AppError('FORBIDDEN', 'Staff accounts need identity.staff-accounts.manage', { permission: 'identity.staff-accounts.manage' });
  }

  private async targetAccount(id: string, can: (p: string) => Promise<boolean>) {
    const a = isUuid(id) ? await this.repo.getAccount(id) : undefined;
    if (!a) throw new AppError('NOT_FOUND', 'Account not found');
    await this.assertRealmAccess(a, can);
    return a;
  }

  private notSelf(a: AccountRow, caller: Caller) {
    if (caller.principal?.accountId === a.id) throw new AppError('SELF_ACTION_NOT_ALLOWED', 'You cannot do this to your own account');
  }

  /** GET /accounts */
  async listAccounts(query: { realm: Realm; q?: string | null; status?: string | null; twoStepEnabled?: boolean | null }, page: PageRequest, can: (p: string) => Promise<boolean>): Promise<common.Page<AccountListItem>> {
    if (query.realm === 'staff' && !(await can('identity.staff-accounts.manage'))) throw new AppError('FORBIDDEN', 'Staff accounts need identity.staff-accounts.manage', { permission: 'identity.staff-accounts.manage' });
    const res = await this.repo.listAccounts(query, page);
    const ids = res.items.map((a) => a.id);
    const [methods, sellers] = await Promise.all([this.repo.activeMethods(ids), this.repo.sellerCounts(ids)]);
    const now = this.now();
    return {
      ...res,
      items: res.items.map((a) => ({
        account: map.accountSummary(a, methods.some((m) => m.account_id === a.id), now),
        lockedUntil: map.isoOrNull(lockInForce(a, now) ? a.locked_until : null),
        mustResetPassword: a.must_reset_password,
        sellerCount: sellers.get(a.id) ?? 0,
        createdAt: map.iso(a.created_at),
        lastSignInAt: map.isoOrNull(a.last_sign_in_at),
      })),
    };
  }

  private async accountAdmins(ids: string[], activityLimit = 20): Promise<Map<string, AccountAdmin>> {
    const s = await this.cfg();
    const now = this.now();
    const out = new Map<string, AccountAdmin>();
    for (const [id, x] of await this.securityOf(ids, activityLimit)) {
      const a = x.account;
      const locked = lockInForce(a, now);
      out.set(id, {
        account: map.accountSummary(a, x.methods.length > 0, now),
        lockedUntil: map.isoOrNull(locked ? a.locked_until : null),
        lockReason: locked ? a.lock_reason : null,
        mustResetPassword: a.must_reset_password,
        failedSignInsInWindow: failuresInWindow(a, now, s.lockoutMinutes),
        createdAt: map.iso(a.created_at),
        lastSignInAt: map.isoOrNull(a.last_sign_in_at),
        passwordChangedAt: map.isoOrNull(a.password_changed_at),
        twoStep: map.twoStepStatus(a.realm, x.methods, x.recovery, s.staffTwoStepRequired),
        devices: x.devices.map((d) => map.device(d)),
        sellerContexts: x.sellers.map(map.sellerContext),
        invitation: x.invitation ? map.invitation(x.invitation, now) : null,
        recentActivity: x.events.map(map.securityEvent),
      });
    }
    return out;
  }

  private async accountAdmin(id: string) {
    return (await this.accountAdmins([id])).get(id)!;
  }

  /** GET /accounts/{id} */
  async getAccountAdmin(id: string, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const a = await this.targetAccount(id, can);
    return this.accountAdmin(a.id);
  }

  /** POST /accounts/{id}/lock: revokes every session */
  async lockAccount(id: string, body: LockRequest, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const now = this.now();
    const a = await this.targetAccount(id, can);
    this.notSelf(a, caller);
    const until = body.until ? new Date(body.until) : null;
    if (until && until <= now) throw new AppError('VALIDATION_FAILED', 'The lock must end in the future', issue('body.until', 'must be in the future'));
    const before = await this.accountAdmin(a.id);
    await this.repo.transaction(async (repo) => {
      let cur = (await repo.getAccount(a.id, { forUpdate: true }))!;
      cur = await this.liftExpiredLock(repo, cur, now);
      // an automatic lock in force can be turned into a staff lock; otherwise only active accounts lock
      const status = cur.status === 'locked' && !cur.locked_by ? 'locked' : accountStatusMachine.next(cur.status as never, 'lock');
      await repo.updateAccount(cur.id, { status, locked_until: until, lock_reason: body.reason, locked_by: caller.actor.id ?? 'staff' });
      await this.revoke(repo, { accountId: cur.id }, 'revokeByStaff', now, true);
      await this.securityEvent(repo, cur.id, 'account_locked', 'completed', { actor: caller.actor, reason: body.reason, client: caller.client, detail: { cause: 'staff_action', until: map.isoOrNull(until) } });
    });
    this.publish('identity.account.locked', { accountId: a.id, realm: a.realm, cause: 'staff_action', until: map.isoOrNull(until), by: caller.actor, reason: body.reason }, caller);
    const after = await this.accountAdmin(a.id);
    await this.audit({ action: 'identity.account.lock', actionLabel: 'Locked account', target: this.auditTarget(a), reason: body.reason, before: before.account, after: after.account, afterText: until ? `Locked until ${map.iso(until)}` : 'Locked until unlocked by staff' }, caller);
    return after;
  }

  private auditTarget(a: AccountRow): audit.AuditTarget {
    return { type: a.realm === 'staff' ? 'staff' : 'account', id: a.id, label: `${a.display_name} (${a.email})`, screen: a.realm === 'staff' ? 'admin/staff' : 'admin/customers' };
  }

  /** POST /accounts/{id}/unlock */
  async unlockAccount(id: string, reason: string, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const a = await this.targetAccount(id, can);
    const before = await this.accountAdmin(a.id);
    await this.repo.transaction(async (repo) => {
      const cur = (await repo.getAccount(a.id, { forUpdate: true }))!;
      const status = accountStatusMachine.next(cur.status as never, 'unlock');
      await repo.updateAccount(cur.id, { status, locked_until: null, lock_reason: null, locked_by: null, failed_sign_ins: 0, failed_window_started_at: null });
      await this.securityEvent(repo, cur.id, 'account_unlocked', 'completed', { actor: caller.actor, reason, client: caller.client });
    });
    this.publish('identity.account.unlocked', { accountId: a.id, by: caller.actor }, caller);
    const after = await this.accountAdmin(a.id);
    await this.audit({ action: 'identity.account.unlock', actionLabel: 'Unlocked account', target: this.auditTarget(a), reason, before: before.account, after: after.account }, caller);
    return after;
  }

  /** POST /accounts/{id}/force-password-reset: revokes every session; sign-in asks for a new password */
  async forcePasswordReset(id: string, body: { reason: string; sendLink: boolean }, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const s = await this.cfg();
    const now = this.now();
    const a = await this.targetAccount(id, can);
    this.notSelf(a, caller);
    let after = () => {};
    await this.repo.transaction(async (repo) => {
      const cur = await repo.updateAccount(a.id, { must_reset_password: true });
      await this.revoke(repo, { accountId: a.id }, 'revokeByStaff', now, true);
      await this.securityEvent(repo, a.id, 'forced_password_reset', 'completed', { actor: caller.actor, reason: body.reason, client: caller.client });
      if (body.sendLink && cur.password_hash) after = await this.issueReset(repo, cur, { forcedBy: caller.actor, reason: body.reason, client: caller.client }, s, now);
    });
    after();
    const result = await this.accountAdmin(a.id);
    await this.audit({ action: 'identity.account.force-password-reset', actionLabel: 'Required a new password', target: this.auditTarget(a), reason: body.reason, afterText: body.sendLink ? 'Reset link emailed; all sessions signed out' : 'All sessions signed out' }, caller);
    return result;
  }

  /** POST /accounts/{id}/reset-two-step: removes 2-step methods after an identity check */
  async resetTwoStep(id: string, body: { reason: string; identityCheck: string }, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const now = this.now();
    const a = await this.targetAccount(id, can);
    this.notSelf(a, caller);
    await this.repo.transaction(async (repo) => {
      await repo.removeAllMethods(a.id, now);
      await repo.deleteRecoveryCodes(a.id);
      await repo.clearDeviceTrust(a.id);
      await repo.supersedeChallenges(a.id, 'two_step_setup');
      await this.securityEvent(repo, a.id, 'two_step_disabled', 'completed', { actor: caller.actor, reason: body.reason, client: caller.client, detail: { byStaff: true, identityCheck: body.identityCheck } });
    });
    this.publish('identity.two_step.changed', { accountId: a.id, enabled: false, method: null, by: caller.actor }, caller);
    const result = await this.accountAdmin(a.id);
    await this.audit({ action: 'identity.account.reset-two-step', actionLabel: 'Reset 2-step verification', target: this.auditTarget(a), reason: body.reason, afterText: `Identity check: ${body.identityCheck}` }, caller);
    return result;
  }

  /** POST /accounts/{id}/sign-out-all */
  async signOutAccount(id: string, reason: string, caller: Caller, can: (p: string) => Promise<boolean>): Promise<{ sessionsRevoked: number }> {
    const now = this.now();
    const a = await this.targetAccount(id, can);
    const n = await this.repo.transaction(async (repo) => {
      const ids = await this.revoke(repo, { accountId: a.id }, 'revokeByStaff', now, true);
      await this.securityEvent(repo, a.id, 'signed_out_everywhere', 'completed', { actor: caller.actor, reason, client: caller.client, detail: { sessions: ids.length } });
      return ids.length;
    });
    await this.audit({ action: 'identity.account.sign-out-all', actionLabel: 'Signed account out everywhere', target: this.auditTarget(a), reason, afterText: `${n} sessions signed out` }, caller);
    return { sessionsRevoked: n };
  }

  private staffOnly(a: AccountRow, what: string) {
    if (a.realm !== 'staff') throw new AppError('VALIDATION_FAILED', `Only staff accounts can be ${what} here`, issue('params.id', 'not a staff account'));
  }

  /** POST /accounts/{id}/disable (staff accounts) */
  async disableAccount(id: string, reason: string, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const now = this.now();
    const a = await this.targetAccount(id, can);
    this.staffOnly(a, 'disabled');
    this.notSelf(a, caller);
    const before = await this.accountAdmin(a.id);
    await this.repo.transaction(async (repo) => {
      const cur = (await repo.getAccount(a.id, { forUpdate: true }))!;
      const status = accountStatusMachine.next(cur.status as never, 'disable');
      await repo.updateAccount(cur.id, { status });
      await this.revoke(repo, { accountId: cur.id }, 'revokeByStaff', now, true);
      await this.securityEvent(repo, cur.id, 'account_disabled', 'completed', { actor: caller.actor, reason, client: caller.client });
    });
    this.publish('identity.account.disabled', { accountId: a.id, realm: a.realm, reason, by: caller.actor }, caller);
    const after = await this.accountAdmin(a.id);
    await this.audit({ action: 'identity.account.disable', actionLabel: 'Disabled staff account', target: this.auditTarget(a), reason, before: before.account, after: after.account }, caller);
    return after;
  }

  /** POST /accounts/{id}/enable (staff accounts; roles are not restored) */
  async enableAccount(id: string, reason: string, caller: Caller, can: (p: string) => Promise<boolean>): Promise<AccountAdmin> {
    const a = await this.targetAccount(id, can);
    this.staffOnly(a, 'enabled');
    const before = await this.accountAdmin(a.id);
    await this.repo.transaction(async (repo) => {
      const cur = (await repo.getAccount(a.id, { forUpdate: true }))!;
      const status = accountStatusMachine.next(cur.status as never, 'enable');
      await repo.updateAccount(cur.id, { status, failed_sign_ins: 0, failed_window_started_at: null });
      await this.securityEvent(repo, cur.id, 'account_enabled', 'completed', { actor: caller.actor, reason, client: caller.client });
    });
    this.publish('identity.account.enabled', { accountId: a.id, by: caller.actor }, caller);
    const after = await this.accountAdmin(a.id);
    await this.audit({ action: 'identity.account.enable', actionLabel: 'Enabled staff account', target: this.auditTarget(a), reason, before: before.account, after: after.account }, caller);
    return after;
  }

  /** GET /accounts/{id}/security-activity */
  async listAccountActivity(id: string, query: { kind?: string | null; result?: string | null; from?: string | null; to?: string | null }, page: PageRequest, can: (p: string) => Promise<boolean>): Promise<common.Page<SecurityEvent>> {
    const a = await this.targetAccount(id, can);
    const tz = this.ctx.config.market.timeZone;
    const since = query.from ? zonedTimeToUtc(query.from, '00:00', tz) : undefined;
    let until: Date | undefined;
    if (query.to) {
      const next = new Date(`${query.to}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      until = zonedTimeToUtc(next.toISOString().slice(0, 10), '00:00', tz);
    }
    const res = await this.repo.listSecurityEvents(a.id, { since, until, kind: query.kind, result: query.result }, page);
    return { ...res, items: res.items.map(map.securityEvent) };
  }

  /** GET /invitations (staff invitations) */
  async listInvitations(status: string | null | undefined, page: PageRequest): Promise<common.Page<Invitation>> {
    const now = this.now();
    const res = await this.repo.listInvitations({ purpose: 'staff', status }, page);
    return { ...res, items: res.items.map((i) => map.invitation(i, now)) };
  }

  private async staffInvitation(id: string) {
    const i = isUuid(id) ? await this.repo.getInvitation(id) : undefined;
    if (!i || i.purpose !== 'staff') throw new AppError('NOT_FOUND', 'Invitation not found');
    return i;
  }

  /** POST /invitations/{id}/resend: a new 7-day link; the old one stops working */
  async resendInvitation(id: string, caller: Caller): Promise<Invitation> {
    const s = await this.cfg();
    const now = this.now();
    await this.staffInvitation(id);
    const token = randomToken();
    const row = await this.repo.transaction(async (repo) => {
      const i = (await repo.getInvitation(id, { forUpdate: true }))!;
      const from = i.status === 'pending' && i.expires_at <= now ? 'expired' : i.status;
      const status = invitationMachine.next(from as never, 'resend');
      const a = i.account_id ? await repo.getAccount(i.account_id) : undefined;
      if (a && a.status !== 'invited') throw new AppError('ILLEGAL_TRANSITION', 'This person already has an active staff account', { from: a.status, event: 'resend' });
      return repo.updateInvitation(i.id, { status, token_hash: tokenHash(token), sent_at: now, expires_at: new Date(now.getTime() + s.invitationTtlDays * DAY) });
    });
    this.invitationCreated(row, token, caller);
    await this.audit({ action: 'identity.invitation.resend', actionLabel: 'Resent staff invitation', target: { type: 'staff_invitation', id: row.id, label: `${row.name} (${row.email})`, screen: 'admin/staff' } }, caller);
    return map.invitation(row, now);
  }

  /** POST /invitations/{id}/revoke: the invited account closes */
  async revokeStaffInvitation(id: string, reason: string, caller: Caller): Promise<Invitation> {
    await this.staffInvitation(id);
    return this.revokeInvitationCore(id, { reason, by: caller.actor, requestId: caller.requestId, client: caller.client });
  }

  /**
   * Public API: cancel a pending invitation (sellers passes its sellerId as contextRef). Another context's
   * invitation is NOT_FOUND; an already revoked one comes back unchanged; accepted or expired ones are
   * ILLEGAL_TRANSITION.
   */
  async revokeInvitation(invitationId: string, input: { reason: string; by: common.Actor; contextRef?: string }): Promise<Invitation> {
    return this.revokeInvitationCore(invitationId, { reason: input.reason, by: input.by, contextRef: input.contextRef });
  }

  private async revokeInvitationCore(id: string, o: { reason: string; by: common.Actor; contextRef?: string; requestId?: string; client?: ClientInfo }): Promise<Invitation> {
    const now = this.now();
    const result = await this.repo.transaction(async (repo) => {
      const i = isUuid(id) ? await repo.getInvitation(id, { forUpdate: true }) : undefined;
      if (!i || (o.contextRef !== undefined && i.context_ref !== o.contextRef)) throw new AppError('NOT_FOUND', 'Invitation not found');
      if (i.status === 'revoked') return { row: i, changed: false };
      // a pending link past its end is expired even before the hourly job marks it
      const from = i.status === 'pending' && i.expires_at <= now ? 'expired' : i.status;
      const status = invitationMachine.next(from as never, 'revoke');
      const updated = await repo.updateInvitation(i.id, { status, revoked_at: now, revoke_reason: o.reason });
      const a = i.account_id ? await repo.getAccount(i.account_id, { forUpdate: true }) : undefined;
      if (a && a.status === 'invited') await repo.updateAccount(a.id, { status: accountStatusMachine.next('invited', 'revokeInvitation'), closed_at: now });
      return { row: updated, changed: true };
    });
    const row = result.row;
    if (result.changed) {
      const by = { actor: o.by, requestId: o.requestId, client: o.client };
      this.publish('identity.invitation.revoked', { invitationId: row.id, purpose: row.purpose, contextRef: row.context_ref }, by);
      // seller member invitations are audited by sellers (the action the seller took)
      if (row.purpose === 'staff') {
        await this.audit({ action: 'identity.invitation.revoke', actionLabel: 'Cancelled staff invitation', target: { type: 'staff_invitation', id: row.id, label: `${row.name} (${row.email})`, screen: 'admin/staff' }, reason: o.reason }, by);
      }
    }
    return map.invitation(row, now);
  }

  /* ================================================================ public API (in-process) */

  async getAccount(accountId: string): Promise<AccountSummary | null> {
    if (!isUuid(accountId)) return null;
    const a = await this.repo.getAccount(accountId);
    return a ? this.summaryOf(a) : null;
  }

  async getAccounts(accountIds: string[]): Promise<AccountSummary[]> {
    const ids = [...new Set(accountIds.filter(isUuid))];
    const [rows, methods] = await Promise.all([this.repo.getAccounts(ids), this.repo.activeMethods(ids)]);
    const now = this.now();
    const byId = new Map(rows.map((a) => [a.id, map.accountSummary(a, methods.some((m) => m.account_id === a.id), now)]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  async findAccountByEmail(email: string, realm: 'member' | 'staff'): Promise<AccountSummary | null> {
    const a = await this.repo.findAccount(realm, normalizeEmail(email));
    return a ? this.summaryOf(a) : null;
  }

  /** Allow an account to sign in to Seller Center for this seller (called again to refresh the label) */
  async grantSellerContext(input: { accountId: string; sellerId: string; memberId: string; sellerName: string; roleLabel: string; isOwner: boolean }): Promise<void> {
    const now = this.now();
    await this.repo.transaction(async (repo) => {
      const a = isUuid(input.accountId) ? await repo.getAccount(input.accountId) : undefined;
      if (!a || a.realm !== 'member') throw new AppError('NOT_FOUND', 'Member account not found');
      const prior = await repo.getSellerAccess(a.id, input.sellerId);
      const fresh = !prior || prior.revoked_at !== null;
      await repo.upsertSellerAccess({
        account_id: a.id,
        seller_id: input.sellerId,
        seller_member_id: input.memberId,
        seller_name: input.sellerName,
        role_label: input.roleLabel,
        is_owner: input.isOwner,
        granted_at: fresh ? now : prior!.granted_at,
        revoked_at: null,
        last_used_at: prior?.last_used_at ?? null,
      });
      // a new membership (re-invited member): sessions bound to the old one end
      if (prior && prior.seller_member_id !== input.memberId) await repo.revokeSessions({ accountId: a.id, sellerId: input.sellerId }, 'membership_changed', now);
      if (fresh) await this.securityEvent(repo, a.id, 'seller_access_granted', 'completed', { audience: 'seller', actor: { kind: 'system' }, detail: { sellerName: input.sellerName, role: input.roleLabel } });
    });
  }

  /** Remove seller access and revoke sessions bound to that seller */
  async revokeSellerContext(accountId: string, sellerId: string, reason: string): Promise<void> {
    const now = this.now();
    await this.repo.transaction(async (repo) => {
      const access = isUuid(accountId) ? await repo.getSellerAccess(accountId, sellerId) : undefined;
      if (!access || access.revoked_at) return;
      await repo.updateSellerAccess(accountId, sellerId, { revoked_at: now });
      const ids = await repo.revokeSessions({ accountId, sellerId }, 'seller_access_revoked', now);
      await this.securityEvent(repo, accountId, 'seller_access_revoked', 'completed', { audience: 'seller', actor: { kind: 'system' }, reason, detail: { sellerName: access.seller_name, sessions: ids.length } });
    });
  }

  /** Sign an account out everywhere (or in one area) */
  async revokeSessions(accountId: string, reason: string, audience?: 'store' | 'seller' | 'admin'): Promise<number> {
    if (!isUuid(accountId)) return 0;
    const now = this.now();
    return this.repo.transaction(async (repo) => {
      if (!(await repo.getAccount(accountId))) return 0;
      const ids = await this.revoke(repo, { accountId, audience }, reason, now, !audience);
      await this.securityEvent(repo, accountId, audience ? 'session_revoked' : 'signed_out_everywhere', 'completed', { audience: audience ?? null, actor: { kind: 'system' }, reason, detail: { sessions: ids.length } });
      return ids.length;
    });
  }

  /** Close the member credential after customers completes a closure (idempotent) */
  async closeAccount(accountId: string, reason: string): Promise<void> {
    const now = this.now();
    const closed = await this.repo.transaction(async (repo) => {
      const a = isUuid(accountId) ? await repo.getAccount(accountId, { forUpdate: true }) : undefined;
      if (!a || a.realm !== 'member') throw new AppError('NOT_FOUND', 'Member account not found');
      if (a.status === 'closed') return false;
      const status = accountStatusMachine.next(a.status as never, 'close');
      await repo.updateAccount(a.id, { status, closed_at: now, locked_until: null, lock_reason: null, locked_by: null });
      // every session ends; Seller Center sign-in stays possible while seller access remains
      await this.revoke(repo, { accountId: a.id }, 'account_closed', now, true);
      await repo.clearDeviceTrust(a.id);
      await this.securityEvent(repo, a.id, 'signed_out_everywhere', 'completed', { actor: { kind: 'system' }, reason, detail: { closed: true } });
      return true;
    });
    if (closed) this.publish('identity.account.closed', { accountId, at: map.iso(now) });
  }

  /** Staff-initiated reset link from another module's screen */
  async sendPasswordReset(accountId: string, input: { reason: string; by: common.Actor; revokeSessions: boolean }): Promise<void> {
    const s = await this.cfg();
    const now = this.now();
    const after = await this.repo.transaction(async (repo) => {
      const a = isUuid(accountId) ? await repo.getAccount(accountId, { forUpdate: true }) : undefined;
      if (!a) throw new AppError('NOT_FOUND', 'Account not found');
      if (!a.password_hash || ['disabled', 'closed', 'invited'].includes(a.status)) throw new AppError('ILLEGAL_TRANSITION', 'This account cannot reset its password', { from: a.status, event: 'reset' });
      if (input.revokeSessions) await this.revoke(repo, { accountId: a.id }, 'revokeByStaff', now, true);
      return this.issueReset(repo, a, { forcedBy: input.by, reason: input.reason }, s, now);
    });
    after();
  }

  /** Text a code to a new mobile number (identity.user.verified with channel phone when confirmed) */
  async startPhoneVerification(accountId: string, phone: string): Promise<VerificationChallenge> {
    const s = await this.cfg();
    const now = this.now();
    if (this.ctx.config.launchPhase < 2) throw new AppError('METHOD_NOT_AVAILABLE', 'Text message codes are not available yet');
    if (!isE164(phone)) throw new AppError('VALIDATION_FAILED', 'Enter a mobile number in international format', issue('phone', 'E.164 number required'));
    const out = await this.repo.transaction(async (repo) => {
      const a = isUuid(accountId) ? await repo.getAccount(accountId) : undefined;
      if (!a) throw new AppError('NOT_FOUND', 'Account not found');
      await repo.supersedeChallenges(a.id, 'phone_verification');
      const id = newId();
      const code = sixDigitCode();
      const row: ChallengeRow = {
        id,
        account_id: a.id,
        purpose: 'phone_verification',
        target_email: null,
        code_hash: this.codeHash(id, code),
        payload: { phoneMasked: maskPhone(phone) } as never,
        attempts: 0,
        max_attempts: s.maxCodeAttempts,
        status: 'pending',
        expires_at: new Date(now.getTime() + s.verificationCodeTtlMinutes * MIN),
        resend_available_at: new Date(now.getTime() + s.codeResendSeconds * 1000),
        created_at: now,
        completed_at: null,
        target_phone_encrypted: this.keys.encrypt(Buffer.from(phone, 'utf8')),
      };
      await repo.insertChallenge(row);
      return { row, code };
    });
    this.codeIssued(out.row, out.code, 'sms', phone);
    return map.verificationChallenge(out.row);
  }

  /** Batched staff view for the customer 360 (GraphQL Customer.security) */
  async accountSecurityOf(accountIds: string[], opts?: { activityLimit?: number }): Promise<Map<string, unknown>> {
    const s = await this.cfg();
    const now = this.now();
    const limit = Math.min(Math.max(opts?.activityLimit ?? 50, 1), 50);
    const ids = [...new Set(accountIds.filter(isUuid))];
    const out = new Map<string, unknown>();
    for (const [id, x] of await this.securityOf(ids, limit)) {
      const a = x.account;
      const locked = lockInForce(a, now);
      const events = x.events.map(map.securityEvent);
      const summary = !a.password_hash ? 'No password yet (invitation pending)' : x.methods.length ? `Password + ${x.methods.some((m) => m.method === 'totp') ? 'two-step code' : 'text message code'}` : 'Password only';
      const value: AccountSecurity = {
        accountId: a.id,
        status: map.effectiveStatus(a, now).toUpperCase(),
        email: a.email,
        emailVerified: a.email_verified_at !== null,
        emailVerifiedAt: map.isoOrNull(a.email_verified_at),
        pendingEmailChange: x.pendingEmail ?? null,
        signInSummary: summary,
        createdAt: map.iso(a.created_at),
        lastSignInAt: map.isoOrNull(a.last_sign_in_at),
        lastActiveAt: map.isoOrNull(a.last_active_at),
        passwordChangedAt: map.isoOrNull(a.password_changed_at),
        mustResetPassword: a.must_reset_password,
        lockedUntil: map.isoOrNull(locked ? a.locked_until : null),
        lockReason: locked ? a.lock_reason : null,
        failedSignInsInWindow: failuresInWindow(a, now, s.lockoutMinutes),
        twoStep: (() => {
          const t = map.twoStepStatus(a.realm, x.methods, x.recovery, s.staffTwoStepRequired);
          return { enabled: t.enabled, required: t.required, methods: t.methods.map((m) => ({ id: m.id, method: m.method.toUpperCase(), label: m.label, addedAt: m.addedAt, lastUsedAt: m.lastUsedAt ?? null })), recoveryCodesRemaining: t.recoveryCodesRemaining };
        })(),
        devices: x.devices.map((d) => ({ id: d.id, kind: d.kind, label: d.label, location: d.last_location, audiences: d.audiences, firstSeenAt: map.iso(d.first_seen_at), lastActiveAt: map.iso(d.last_active_at), twoStepTrustedUntil: map.isoOrNull(d.two_step_trusted_until) })),
        warnings: this.warnings(a, x.methods, x.recovery, x.events, now),
        recentActivity: (args) => events.slice(0, Math.min(Math.max(args?.limit ?? 10, 0), 50)).map((e) => ({ ...e, result: e.result.toUpperCase() })),
      };
      out.set(id, value);
    }
    return out;
  }

  /**
   * Revoked sessions and account-wide revocations since a cursor. Without a cursor: the last
   * access-token lifetime. Polled by every server every few seconds.
   */
  async revocationsSince(cursor?: string): Promise<{ sessions: { sessionId: string; at: string }[]; accounts: { accountId: string; validAfter: string }[]; cursor: string }> {
    const now = this.now();
    let since: Date;
    const parsed = cursor ? Date.parse(cursor) : NaN;
    if (Number.isFinite(parsed)) since = new Date(parsed - REVOCATION_OVERLAP_MS);
    else since = new Date(now.getTime() - ((await this.ctx.settings.get('accessTokenTtlMinutes')) + 1) * MIN);
    const [sessions, guests, accounts] = await Promise.all([this.repo.revokedSessionsSince(since), this.repo.claimedGuestSessionsSince(since), this.repo.accountRevocationsSince(since)]);
    return {
      sessions: [...sessions, ...guests].map((x) => ({ sessionId: x.id, at: map.iso(x.at) })),
      accounts: accounts.map((x) => ({ accountId: x.id, validAfter: map.iso(x.at) })),
      cursor: map.iso(now),
    };
  }

  /* ================================================================ events consumed */

  /** customers.account.closed: backstop for closeAccount (idempotent; unknown accounts are ignored) */
  async onAccountClosedFromCustomers(event: EventPayload<'customers.account.closed'>): Promise<void> {
    try {
      await this.closeAccount(event.userId, 'Customer account closed');
    } catch (err) {
      if (err instanceof AppError && (err.code === 'NOT_FOUND' || err.code === 'ILLEGAL_TRANSITION')) {
        this.ctx.log.warn({ userId: event.userId, code: err.code }, 'identity: customers.account.closed for an account that cannot be closed here; ignored');
        return;
      }
      throw err;
    }
  }

  /* ================================================================ jobs */

  /** identity.purge-expired (hourly) */
  async purgeExpired(): Promise<void> {
    const now = this.now();
    const drain = async (step: () => Promise<number>) => {
      for (let i = 0; i < 100 && (await step()) >= BATCH; i++);
    };
    await drain(() => this.repo.deleteExpiredChallenges(now, BATCH));
    await drain(() => this.repo.deleteExpiredResets(now, BATCH));
    await drain(() => this.repo.deleteExpiredReauthTokens(now, BATCH));
    await drain(() => this.repo.deleteExpiredOrderLinks(now, BATCH));
    await drain(() => this.repo.deleteExpiredGrants(now, BATCH));
    await drain(() => this.repo.deleteExpiredGuestSessions(now, BATCH));
    await drain(() => this.repo.transaction((repo) => repo.deleteUnverifiedAccounts(new Date(now.getTime() - UNVERIFIED_ACCOUNT_DAYS * DAY), 100)).then((n) => (n >= 100 ? BATCH : n)));
  }

  /** identity.expire-invitations (hourly) */
  async expireInvitations(): Promise<void> {
    const now = this.now();
    for (let i = 0; i < 100 && (await this.repo.expirePendingInvitations(now, BATCH)) >= BATCH; i++);
  }

  /** identity.expire-sessions (every 15 min) */
  async expireSessions(): Promise<void> {
    const staffIdle = await this.ctx.settings.get('staffIdleMinutes');
    const now = this.now();
    const idleBefore = new Date(now.getTime() - staffIdle * MIN);
    for (let i = 0; i < 100 && (await this.repo.expireSessions(now, idleBefore, BATCH)) >= BATCH; i++);
    const before = new Date(now.getTime() - 90 * DAY);
    for (let i = 0; i < 100 && (await this.repo.pruneRevokedSessions(before, BATCH)) >= BATCH; i++);
  }

  /** identity.prune-security-events (daily) */
  async pruneSecurityEvents(): Promise<void> {
    const days = await this.ctx.settings.get('securityEventRetentionDays');
    const now = this.now();
    const eventsBefore = new Date(now.getTime() - days * DAY);
    const attemptsBefore = new Date(now.getTime() - 30 * DAY);
    for (let i = 0; i < 100 && (await this.repo.deleteSecurityEventsBefore(eventsBefore, BATCH)) >= BATCH; i++);
    for (let i = 0; i < 100 && (await this.repo.deleteSignInAttemptsBefore(attemptsBefore, BATCH)) >= BATCH; i++);
  }
}

/** Client details from a request (IP for activity and limits; User-Agent for device labels) */
export function clientInfo(request: { ip?: string; headers: Record<string, unknown> }): ClientInfo {
  const ip = request.ip && isIP(request.ip) ? request.ip : null;
  const ua = request.headers['user-agent'];
  return { ip, userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null };
}
