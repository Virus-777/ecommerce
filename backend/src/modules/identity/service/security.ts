/**
 * Account security: the signed-in person's security page (password, email change, 2-step methods and recovery
 * codes, devices, activity), step-up and re-authentication tokens, and the staff view of an account's security.
 */
import type { Principal as KernelPrincipal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type {
  ChangePasswordRequest,
  Device,
  Principal,
  ReauthRequest,
  ReauthToken,
  RecoveryCodes,
  SecurityEvent,
  SecurityOverview,
  SecurityWarning,
  TwoStepSetup,
  TwoStepSetupRequest,
  TwoStepStatus,
  VerificationChallenge,
} from '../../../spec/identity.js';
import {
  base32Encode,
  groupKey,
  hashPassword,
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
} from '../domain/crypto.js';
import { failuresInWindow, lockInForce, normalizeEmail } from '../domain/policy.js';
import { isE164, maskPhone } from '../domain/text.js';
import * as map from '../mappers.js';
import type {
  AccountRow,
  Audience,
  ChallengeRow,
  DeviceWithSessions,
  InvitationRow,
  SecurityEventRow,
  SellerAccessRow,
  TwoStepMethodRow,
} from '../ports.js';
import type { IdentityRepository } from '../repository.js';
import { type Core, type ClientInfo, type Caller, type AccountSecurity, MIN, DAY, RECOVERY_CODES, isReauthPurpose, issue } from './core.js';
import type { Authentication } from './authentication.js';

export class Security {
  constructor(
    readonly core: Core,
    readonly authentication: Authentication,
  ) {}

  /** A pending 2-step (TOTP) set-up for an account */
  async newTotpSetup(repo: IdentityRepository, a: AccountRow, payload: Record<string, unknown>, s: { verificationCodeTtlMinutes: number; maxCodeAttempts: number }, now: Date): Promise<TwoStepSetup> {
    await repo.supersedeChallenges(a.id, 'two_step_setup');
    const secret = newTotpSecret();
    const b32 = base32Encode(secret);
    const row: ChallengeRow = {
      id: newId(),
      account_id: a.id,
      purpose: 'two_step_setup',
      target_email: null,
      code_hash: null,
      payload: { ...payload, method: 'totp', secret: this.core.keys.encrypt(secret).toString('base64') } as never,
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

  /** New recovery codes for an account (replacing any earlier batch) */
  async newRecoveryCodes(repo: IdentityRepository, accountId: string, now: Date): Promise<RecoveryCodes> {
    const batch = newId();
    const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    await repo.replaceRecoveryCodes(
      accountId,
      codes.map((c) => ({ id: newId(), account_id: accountId, code_hash: this.core.recoveryHash(accountId, c), batch_id: batch, used_at: null })),
    );
    return { codes, generatedAt: map.iso(now) };
  }

  /** Confirms a pending set-up with its first code; returns the new method, or the error to throw */
  async confirmSetup(repo: IdentityRepository, c: ChallengeRow, a: AccountRow, code: string, now: Date): Promise<TwoStepMethodRow | AppError> {
    const p = (c.payload ?? {}) as Record<string, unknown>;
    let row: TwoStepMethodRow;
    if (p.method === 'sms') {
      if (!c.code_hash || !safeEqual(c.code_hash, this.core.codeHash(c.id, code))) return this.core.wrongCode(repo, c);
      row = { id: newId(), account_id: a.id, method: 'sms', secret_encrypted: null, phone_e164_encrypted: c.target_phone_encrypted, phone_masked: (p.phoneMasked as string) ?? null, confirmed_at: now, last_used_at: now, last_used_step: null, removed_at: null };
    } else {
      const sealed = Buffer.from(String(p.secret ?? ''), 'base64');
      const step = verifyTotp(this.core.keys.decrypt(sealed), code, now, null);
      if (step === null) return this.core.wrongCode(repo, c);
      row = { id: newId(), account_id: a.id, method: 'totp', secret_encrypted: sealed, phone_e164_encrypted: null, phone_masked: null, confirmed_at: now, last_used_at: now, last_used_step: step, removed_at: null };
    }
    // one method of each kind: a new authenticator replaces the old one
    for (const m of await repo.activeMethods([a.id])) if (m.method === row.method) await repo.updateMethod(m.id, { removed_at: now });
    await repo.insertMethod(row);
    await repo.updateChallenge(c.id, { status: 'completed', completed_at: now });
    return row;
  }

  /** Batched security view of accounts (admin detail, customer 360, own security page) */
  async securityOf(ids: string[], activityLimit: number, since?: Date) {
    const now = this.core.now();
    const [accounts, methods, recovery, devices, sellers, invitations, events, pendingEmails] = await Promise.all([
      this.core.repo.getAccounts(ids),
      this.core.repo.activeMethods(ids),
      this.core.repo.remainingRecoveryCodes(ids),
      this.core.repo.devicesOf(ids, now),
      this.core.repo.activeSellerAccessOf(ids),
      this.core.repo.latestInvitations(ids),
      this.core.repo.recentSecurityEvents(ids, activityLimit, since),
      this.core.repo.pendingEmailChanges(ids, now),
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
    const s = await this.core.cfg();
    const a = await this.core.accountOf(principal);
    const now = this.core.now();
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
    const s = await this.core.cfg();
    const now = this.core.now();
    const peek = await this.core.repo.getAccount(accountId);
    if (!peek) return { ok: false, error: new AppError('NOT_FOUND', 'Account not found') };
    const passwordOk = proof.password ? await verifyPassword(peek.password_hash, proof.password) : false;
    let after = () => {};
    const out = await this.core.repo.transaction(async (repo): Promise<{ ok: true } | { ok: false; error: AppError }> => {
      let a = (await repo.getAccount(accountId, { forUpdate: true }))!;
      a = await this.authentication.liftExpiredLock(repo, a, now);
      if (lockInForce(a, now)) return { ok: false, error: new AppError('RATE_LIMITED', 'Too many wrong answers; try again later', { lockedUntil: map.isoOrNull(a.locked_until) }) };
      const good = proof.password ? passwordOk : proof.code ? Boolean(await this.authentication.checkSecondFactor(repo, a, 'totp', proof.code, now)) : false;
      if (good) {
        if (a.failed_sign_ins) await repo.updateAccount(a.id, { failed_sign_ins: 0, failed_window_started_at: null });
        return { ok: true };
      }
      const f = await this.authentication.countFailure(repo, a, s, now, { client: o.client, audience: o.audience, reason: 'step_up' });
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
    const s = await this.core.cfg();
    const now = this.core.now();
    const a = await this.core.accountOf(caller.principal);
    await this.requireStepUp(a.id, { password: body.currentPassword }, { client: caller.client, audience: caller.principal?.audience });
    const [first, ...rest] = a.display_name.split(' ');
    this.core.assertStrong(body.newPassword, a.realm, [a.email, first, rest.join(' ')], s);
    await this.core.assertNotReused(a.id, body.newPassword, s.passwordHistoryCount);
    const hash = await hashPassword(body.newPassword);
    await this.core.repo.transaction(async (repo) => {
      await this.core.storePassword(repo, a.id, hash, now, { must_reset_password: false });
      if (body.signOutOtherDevices) await this.core.revoke(repo, { accountId: a.id, exceptSessionId: caller.principal?.sessionId }, 'passwordChanged', now);
      await this.core.securityEvent(repo, a.id, 'password_changed', 'completed', { client: caller.client, audience: caller.principal?.audience, detail: { signedOutOthers: body.signOutOtherDevices } });
    });
    this.core.publish('identity.password.changed', { accountId: a.id, realm: a.realm, via: 'change', otherSessionsRevoked: body.signOutOtherDevices, at: map.iso(now) }, caller);
  }

  /** POST /email-changes (re-auth step-up already verified by the middleware) */
  async requestEmailChange(newEmail: string, caller: Caller): Promise<VerificationChallenge> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const a = await this.core.accountOf(caller.principal);
    const normalized = normalizeEmail(newEmail);
    if (normalized === a.email_normalized) throw new AppError('VALIDATION_FAILED', 'That is already your sign-in email', issue('body.newEmail', 'same as the current email'));
    const taken = await this.core.repo.findAccount(a.realm, normalized);
    if (taken) throw new AppError('EMAIL_IN_USE', 'Another account uses that email');
    const out = await this.core.repo.transaction(async (repo) => {
      await repo.supersedeChallenges(a.id, 'email_change'); // a new change supersedes the previous one
      return this.core.newEmailCode(repo, { accountId: a.id, purpose: 'email_change', email: newEmail.trim() }, s, now);
    });
    this.core.codeIssued(out.row, out.code, 'email', out.row.target_email!);
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
    const a = await this.core.accountOf(p);
    const purpose = body.purpose;
    if (!isReauthPurpose(purpose)) throw new AppError('VALIDATION_FAILED', 'Say which action this confirmation is for', issue('body.purpose', 'a step-up purpose such as payout-account'));
    if (!body.password && !body.code) throw new AppError('VALIDATION_FAILED', 'Enter your password or a 2-step code', issue('body.password', 'password or code required'));
    const s = await this.core.cfg();
    await this.requireStepUp(a.id, { password: body.password ?? null, code: body.password ? null : body.code }, { client: caller.client, audience: p?.audience });
    const session = p?.sessionId && isUuid(p.sessionId) ? await this.core.repo.getSession(p.sessionId) : undefined;
    if (!session || session.account_id !== a.id || session.revoked_at) throw new AppError('NOT_FOUND', 'Session not found');
    const now = this.core.now();
    const token = randomToken(this.reauthPrefix(p!));
    const expiresAt = new Date(now.getTime() + s.reauthTokenMinutes * MIN);
    await this.core.repo.insertReauthToken({ token_hash: tokenHash(token), account_id: a.id, session_id: session.id, purpose, expires_at: expiresAt, used_at: null });
    if (p?.kind === 'seller') {
      await this.core.audit({ action: 'identity.reauth.seller', actionLabel: 'Confirmed identity for a sensitive Seller Center action', target: { type: 'account', id: a.id, label: a.display_name, sellerId: p.sellerId ?? null }, afterText: `For: ${purpose}`, visibleToSeller: Boolean(p.sellerId) }, caller);
    } else if (p?.kind === 'staff') {
      await this.core.audit({ action: 'identity.reauth.staff', actionLabel: 'Confirmed identity for a sensitive Admin Center action', target: { type: 'account', id: a.id, label: a.display_name }, afterText: `For: ${purpose}` }, caller);
    }
    return { reauthToken: token, expiresAt: map.iso(expiresAt) };
  }

  /** Public API (middleware): is this re-auth token valid for this principal and this purpose? Does not consume it. */
  async verifyReauthToken(principal: Principal, token: string, purpose: string): Promise<boolean> {
    if (typeof token !== 'string' || typeof purpose !== 'string' || !principal.accountId || !principal.sessionId) return false;
    if (!token.startsWith(this.reauthPrefix(principal))) return false;
    const r = await this.core.repo.getReauthToken(tokenHash(token));
    return Boolean(
      r && !r.used_at && r.purpose === purpose && r.expires_at > this.core.now() && r.account_id === principal.accountId && r.session_id === principal.sessionId,
    );
  }

  /** Public API (kernel, before the handler): claims the token for one request; false when another request already has */
  async consumeReauthToken(token: string): Promise<boolean> {
    if (typeof token !== 'string') return false;
    return this.core.repo.markReauthUsed(tokenHash(token), this.core.now());
  }

  /** Public API (kernel): the request that claimed the token failed, so it can be used again */
  async releaseReauthToken(token: string): Promise<void> {
    if (typeof token !== 'string') return;
    await this.core.repo.clearReauthUsed(tokenHash(token));
  }

  /** Public API: password or 2-step code check before a sensitive action */
  async verifyStepUp(accountId: string, proof: { password?: string; code?: string }): Promise<boolean> {
    if (!isUuid(accountId) || (!proof.password && !proof.code)) return false;
    const r = await this.stepUpCheck(accountId, proof, {});
    return r.ok;
  }

  /** POST /two-step/setups */
  async startTwoStepSetup(body: TwoStepSetupRequest, caller: Caller): Promise<TwoStepSetup> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const a = await this.core.accountOf(caller.principal);
    if (body.method === 'sms') {
      if (this.core.ctx.config.launchPhase < 2) throw new AppError('METHOD_NOT_AVAILABLE', 'Text message codes are not available yet');
      if (!body.phone || !isE164(body.phone)) throw new AppError('VALIDATION_FAILED', 'Enter a mobile number in international format', issue('body.phone', 'E.164 number required for text messages'));
    }
    await this.requireStepUp(a.id, { password: body.currentPassword }, { client: caller.client, audience: caller.principal?.audience });
    if (body.method === 'totp') return this.core.repo.transaction((repo) => this.newTotpSetup(repo, a, { sessionId: caller.principal?.sessionId ?? null }, s, now));
    const phone = body.phone!;
    const out = await this.core.repo.transaction(async (repo) => {
      await repo.supersedeChallenges(a.id, 'two_step_setup');
      const id = newId();
      const code = sixDigitCode();
      const row: ChallengeRow = {
        id,
        account_id: a.id,
        purpose: 'two_step_setup',
        target_email: null,
        code_hash: this.core.codeHash(id, code),
        payload: { method: 'sms', phoneMasked: maskPhone(phone), sessionId: caller.principal?.sessionId ?? null } as never,
        attempts: 0,
        max_attempts: s.maxCodeAttempts,
        status: 'pending',
        expires_at: new Date(now.getTime() + s.verificationCodeTtlMinutes * MIN),
        resend_available_at: new Date(now.getTime() + s.codeResendSeconds * 1000),
        created_at: now,
        completed_at: null,
        target_phone_encrypted: this.core.keys.encrypt(Buffer.from(phone, 'utf8')),
      };
      await repo.insertChallenge(row);
      return { row, code };
    });
    this.core.codeIssued(out.row, out.code, 'sms', phone);
    return { setupId: out.row.id, method: 'sms', otpauthUri: null, manualEntryKey: null, phoneMasked: maskPhone(phone), expiresAt: map.iso(out.row.expires_at) };
  }

  /** POST /two-step/setups/{id}/confirm: returns recovery codes once */
  async confirmTwoStepSetup(id: string, code: string, caller: Caller): Promise<RecoveryCodes> {
    const now = this.core.now();
    const a = await this.core.accountOf(caller.principal);
    let method: TwoStepMethodRow | undefined;
    const outcome = await this.core.repo.transaction(async (repo): Promise<{ error: AppError } | { result: RecoveryCodes }> => {
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
      await this.core.securityEvent(repo, a.id, 'two_step_enabled', 'completed', { client: caller.client, audience: caller.principal?.audience, detail: { method: m.method } });
      return { result: codes };
    });
    if ('error' in outcome) throw outcome.error;
    this.core.publish('identity.two_step.changed', { accountId: a.id, enabled: true, method: method!.method, by: caller.actor }, caller);
    return outcome.result;
  }

  private async twoStepStatusOf(a: AccountRow): Promise<TwoStepStatus> {
    const s = await this.core.cfg();
    const methods = await this.core.methodsOf(a.id);
    const recovery = (await this.core.repo.remainingRecoveryCodes([a.id])).get(a.id) ?? 0;
    return map.twoStepStatus(a.realm, methods, recovery, s.staffTwoStepRequired);
  }

  /** POST /two-step/methods/{id}/remove (re-auth verified by the middleware; a current 2-step code too) */
  async removeTwoStepMethod(id: string, code: string, caller: Caller): Promise<TwoStepStatus> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const a = await this.core.accountOf(caller.principal);
    const methods = await this.core.methodsOf(a.id);
    const target = methods.find((m) => m.id === id);
    if (!target) throw new AppError('NOT_FOUND', '2-step method not found');
    if (a.realm === 'staff' && s.staffTwoStepRequired && methods.length <= 1) throw new AppError('TWO_STEP_REQUIRED', 'Staff accounts must keep at least one 2-step method');
    // the current authenticator code, or a recovery code (which also proves the second factor)
    const recoveryShaped = normalizeRecoveryCode(code).length === 10;
    const viaRecovery = recoveryShaped && (await this.core.repo.useRecoveryCode(a.id, this.core.recoveryHash(a.id, code), now));
    if (!viaRecovery) await this.requireStepUp(a.id, { code }, { client: caller.client, audience: caller.principal?.audience });
    const left = await this.core.repo.transaction(async (repo) => {
      await repo.updateMethod(target.id, { removed_at: now });
      const remaining = methods.filter((m) => m.id !== target.id);
      if (!remaining.length) {
        await repo.deleteRecoveryCodes(a.id);
        await repo.clearDeviceTrust(a.id);
      }
      await this.core.securityEvent(repo, a.id, 'two_step_disabled', 'completed', { client: caller.client, audience: caller.principal?.audience, detail: { method: target.method } });
      return remaining.length;
    });
    this.core.publish('identity.two_step.changed', { accountId: a.id, enabled: left > 0, method: target.method, by: caller.actor }, caller);
    return this.twoStepStatusOf(a);
  }

  /** POST /two-step/recovery-codes (re-auth verified by the middleware) */
  async regenerateRecoveryCodes(caller: Caller): Promise<RecoveryCodes> {
    const now = this.core.now();
    const a = await this.core.accountOf(caller.principal);
    if (!(await this.core.methodsOf(a.id)).length) throw new AppError('VALIDATION_FAILED', 'Turn on 2-step verification first', issue('twoStep', 'no 2-step method'));
    return this.core.repo.transaction(async (repo) => {
      const codes = await this.newRecoveryCodes(repo, a.id, now);
      await this.core.securityEvent(repo, a.id, 'recovery_codes_regenerated', 'completed', { client: caller.client, audience: caller.principal?.audience });
      return codes;
    });
  }

  /** GET /devices */
  async listDevices(principal: KernelPrincipal): Promise<Device[]> {
    const a = await this.core.accountOf(principal);
    const devices = (await this.core.repo.devicesOf([a.id], this.core.now())).get(a.id) ?? [];
    return devices.map((d) => map.device(d, principal.sessionId));
  }

  /** POST /devices/{id}/sign-out */
  async signOutDevice(deviceId: string, caller: Caller): Promise<void> {
    const now = this.core.now();
    const a = await this.core.accountOf(caller.principal);
    const d = await this.core.repo.getDevice(deviceId);
    if (!d || d.account_id !== a.id) throw new AppError('NOT_FOUND', 'Device not found');
    await this.core.repo.transaction(async (repo) => {
      const ids = await repo.revokeSessions({ accountId: a.id, deviceId: d.id }, 'revokeByUser', now);
      await repo.updateDevice(d.id, { two_step_trusted_until: null });
      await this.core.securityEvent(repo, a.id, 'signed_out', 'completed', { client: caller.client, device: d, detail: { device: d.label, sessions: ids.length } });
    });
  }

  /** POST /devices/sign-out-all */
  async signOutEverywhere(keepThisDevice: boolean, caller: Caller): Promise<{ sessionsRevoked: number }> {
    const now = this.core.now();
    const a = await this.core.accountOf(caller.principal);
    const n = await this.core.repo.transaction(async (repo) => {
      let except: string | null = null;
      if (keepThisDevice && caller.principal?.sessionId && isUuid(caller.principal.sessionId)) {
        const mine = await repo.getSession(caller.principal.sessionId);
        except = mine?.account_id === a.id ? mine.id : null;
      }
      const ids = await this.core.revoke(repo, { accountId: a.id, exceptSessionId: except }, 'revokeByUser', now, false);
      if (!except) await repo.clearDeviceTrust(a.id);
      await this.core.securityEvent(repo, a.id, 'signed_out_everywhere', 'completed', { client: caller.client, audience: caller.principal?.audience, detail: { sessions: ids.length, keptThisDevice: Boolean(except) } });
      return ids.length;
    });
    return { sessionsRevoked: n };
  }

  /** GET /security-activity */
  async listSecurityActivity(principal: KernelPrincipal, query: { days?: number | null; result?: string | null }, page: PageRequest): Promise<common.Page<SecurityEvent>> {
    const a = await this.core.accountOf(principal);
    const days = Math.min(Math.max(query.days ?? 30, 1), 365);
    const res = await this.core.repo.listSecurityEvents(a.id, { since: new Date(this.core.now().getTime() - days * DAY), result: query.result }, page);
    return { ...res, items: res.items.map(map.securityEvent) };
  }

  /** Batched staff view for the customer 360 (GraphQL Customer.security) */
  async accountSecurityOf(accountIds: string[], opts?: { activityLimit?: number }): Promise<Map<string, unknown>> {
    const s = await this.core.cfg();
    const now = this.core.now();
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
}
